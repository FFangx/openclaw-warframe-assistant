function normalizeId(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeText(value) {
  return String(value || '').normalize('NFKC').trim();
}

function weeklyIdentityError(request) {
  const channel = normalizeId(request?.channel);
  const target = normalizeId(request?.target);
  const actorId = normalizeId(request?.actorId);
  if (request?.personalAllowed !== true || request?.isGroup === true || /^qqbot:group:/u.test(target)) {
    return '周常数据只允许用户本人在 QQ 私聊中查询或修改。';
  }
  if ((channel && channel !== 'qqbot') || !/^qqbot:c2c:/u.test(target) || !actorId) {
    return '当前会话缺少可信的用户 QQ 私聊身份，不能查询或修改周常。';
  }
  return '';
}

/**
 * Shared weekly checklist use case. Ingress adapters resolve trusted identity
 * and presentation; the deterministic weekly module remains the sole owner of
 * checklist parsing, state transitions, snapshot reconciliation and rendering.
 */
export async function executeWeeklyUseCase(request, ports) {
  const identityError = weeklyIdentityError(request);
  if (identityError) {
    return {
      ok: false,
      commandId: 'weekly',
      result: { ok: false, handled: true, kind: 'weekly-denied', error: 'untrusted_identity', text: identityError },
    };
  }

  const normalized = {
    commandId: 'weekly',
    text: normalizeText(request.text),
    channel: 'qqbot',
    target: normalizeId(request.target),
    actorId: normalizeId(request.actorId),
    actorDisplayName: normalizeText(request.actorDisplayName) || normalizeId(request.actorId),
    personalAllowed: true,
    isGroup: false,
    source: normalizeText(request.source),
    cardDir: request.cardDir,
    statePath: request.statePath,
  };

  let result;
  try {
    result = await ports.manage(normalized);
  } catch (error) {
    ports.log?.('error', 'weekly manage failed', error);
    result = { ok: false, handled: true, kind: 'weekly-failed', error: 'manage_failed', text: '周常暂时无法查询或更新，请稍后重试。' };
  }
  if (!result || (result.ok === false && !normalizeText(result.text))) {
    result = { ok: false, handled: true, kind: 'weekly-failed', error: 'manage_failed', text: '周常暂时无法查询或更新，请稍后重试。' };
  }

  return {
    ok: result.ok !== false,
    commandId: 'weekly',
    result,
  };
}
