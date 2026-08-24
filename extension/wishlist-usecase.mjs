const IMMEDIATE_ACTIONS = new Set(['create', 'createMany', 'reprice', 'resume']);

function normalizeId(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeText(value) {
  return String(value || '').normalize('NFKC').trim();
}

function qqIdentityError(request) {
  const channel = normalizeId(request?.channel);
  const target = normalizeId(request?.target);
  const actorId = normalizeId(request?.actorId);
  if ((channel && channel !== 'qqbot') || !/^qqbot:(?:c2c|group):/u.test(target)) {
    return '愿望单只允许从 QQ 会话发起。';
  }
  if (!target || !actorId) return '当前会话缺少可信 QQ 身份，不能修改愿望单。';
  return '';
}

export function wishlistNeedsImmediateInspection(result) {
  return result?.ok !== false && IMMEDIATE_ACTIONS.has(String(result?.command || ''));
}

/**
 * Execute one complete wishlist command after an ingress adapter has resolved
 * the trusted QQ identity. Ports keep OpenClaw/QQ APIs outside this testable
 * business sequence; entry-specific presentation must not change its order.
 */
export async function executeWishlistUseCase(request, ports) {
  const identityError = qqIdentityError(request);
  if (identityError) {
    return {
      ok: false,
      commandId: 'wishlist',
      result: { ok: false, kind: 'wishlist', error: 'untrusted_identity', text: identityError },
      warnings: [],
      delivery: { accepted: false, mediaDelivered: false },
      currentMarket: null,
    };
  }

  const normalized = {
    commandId: 'wishlist',
    text: normalizeText(request.text),
    channel: 'qqbot',
    target: normalizeId(request.target),
    actorId: normalizeId(request.actorId),
    actorDisplayName: normalizeText(request.actorDisplayName) || normalizeId(request.actorId),
    isGroup: request.isGroup === true,
    source: normalizeText(request.source),
    cardDir: request.cardDir,
  };
  const warnings = [];
  let result;
  try {
    result = await ports.manage(normalized);
  } catch (error) {
    ports.log?.('error', 'wishlist manage failed', error);
    result = { ok: false, kind: 'wishlist', error: 'manage_failed', text: '愿望单暂时无法更新，请稍后重试。' };
  }
  if (!result || (result.ok === false && !normalizeText(result.text))) {
    result = { ok: false, kind: 'wishlist', error: 'manage_failed', text: '愿望单暂时无法更新，请稍后重试。' };
  }

  if (result?.ok !== false) {
    const cronAction = String(result?.cronAction || '');
    if (cronAction === 'ensure' || cronAction === 'remove') {
      try {
        await ports.syncCron(normalized.target, cronAction);
      } catch (error) {
        ports.log?.('error', 'wishlist cron sync failed', error);
        warnings.push('愿望已保存，但低频校准任务同步失败；实时监控仍会在网关恢复后继续。');
      }
    }

    try {
      await ports.refreshGateway(normalized.target);
    } catch (error) {
      ports.log?.('warn', 'wishlist gateway refresh failed', error);
      warnings.push('愿望已保存，但实时监控索引暂未刷新；网关恢复或低频校准后会继续监控。');
    }
  }

  if (warnings.length) result = { ...result, warning: warnings.join('\n') };

  let delivery = { accepted: false, mediaDelivered: false };
  try {
    delivery = { ...delivery, ...(await ports.enqueuePrimary(result, normalized)) };
  } catch (error) {
    ports.log?.('error', 'wishlist primary delivery failed', error);
    return {
      ok: false, commandId: 'wishlist', result, warnings,
      delivery: { accepted: false, mediaDelivered: false, error: 'primary_delivery_failed' },
      currentMarket: null,
    };
  }

  let currentMarket = null;
  if (delivery.accepted && wishlistNeedsImmediateInspection(result)) {
    try {
      const inspected = await ports.inspectCurrent(normalized.target, result, normalized);
      const followups = Array.isArray(inspected?.deliveries) ? inspected.deliveries : [];
      const { deliveries: _deliveries, ...summary } = inspected || {};
      currentMarket = summary;
      if (followups.length) await ports.enqueueFollowups(followups, normalized);
    } catch (error) {
      ports.log?.('warn', 'wishlist immediate inspection failed', error);
      currentMarket = { ok: false, hitCount: 0, marketCards: 0, retry: 'scheduled_calibration' };
    }
    result = { ...result, currentMarket };
  }

  return {
    ok: result?.ok !== false && delivery.accepted,
    commandId: 'wishlist',
    action: String(result?.command || ''),
    result,
    warnings,
    delivery,
    currentMarket,
  };
}
