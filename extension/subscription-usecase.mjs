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
    return '订阅只允许从 QQ 会话发起。';
  }
  if (!target || !actorId) return '当前会话缺少可信 QQ 身份，不能修改订阅。';
  return '';
}

/**
 * Execute one complete persistent-subscription command after an ingress
 * adapter has resolved the trusted QQ identity. Entry adapters may present
 * the result differently, but ledger mutation and monitor synchronization
 * must always use this sequence.
 */
export async function executeSubscriptionUseCase(request, ports) {
  const identityError = qqIdentityError(request);
  if (identityError) {
    return {
      ok: false,
      commandId: 'subscription',
      result: { ok: false, kind: 'subscription', error: 'untrusted_identity', text: identityError },
      warnings: [],
    };
  }

  const normalized = {
    commandId: 'subscription',
    text: normalizeText(request.text),
    channel: 'qqbot',
    target: normalizeId(request.target),
    actorId: normalizeId(request.actorId),
    actorDisplayName: normalizeText(request.actorDisplayName) || normalizeId(request.actorId),
    personalAllowed: request.personalAllowed === true,
    isGroup: request.isGroup === true,
    source: normalizeText(request.source),
  };

  let result;
  try {
    result = await ports.manage(normalized);
  } catch (error) {
    ports.log?.('error', 'subscription manage failed', error);
    result = { ok: false, kind: 'subscription', error: 'manage_failed', text: '订阅暂时无法更新，请稍后重试。' };
  }
  if (!result || result.handled === false || (result.ok === false && !normalizeText(result.text))) {
    result = { ok: false, kind: 'subscription', error: 'manage_failed', text: '订阅暂时无法更新，请稍后重试。' };
  }

  const warnings = [];
  if (result.ok !== false) {
    try {
      await ports.syncMonitors(normalized.target, {
        world: String(result.cronAction || ''),
        drops: String(result.dropsCronAction || ''),
      });
    } catch (error) {
      ports.log?.('error', 'subscription monitor sync failed', error);
      warnings.push('订阅命令已处理，但后台监测任务同步失败；请稍后重试或联系管理员。');
    }
  }

  if (warnings.length) {
    const warning = warnings.join('\n');
    result = {
      ...result,
      degraded: true,
      warning,
      text: [normalizeText(result.text) || '订阅设置已更新。', `⚠️ ${warning}`].join('\n'),
    };
  }

  return {
    ok: result.ok !== false,
    commandId: 'subscription',
    result,
    warnings,
  };
}
