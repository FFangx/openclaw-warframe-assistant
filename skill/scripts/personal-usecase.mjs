import { createRequire } from 'node:module';
import { userError } from './user-error-contract.mjs';

const { matchCommandText } = createRequire(import.meta.url)('./command-registry.cjs');

function normalizeId(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeText(value) {
  return String(value || '').normalize('NFKC').trim();
}

function personalIdentityError(request) {
  const channel = normalizeId(request?.channel);
  const target = normalizeId(request?.target);
  const actorId = normalizeId(request?.actorId);
  if (request?.personalAllowed !== true || request?.isGroup === true || /^qqbot:group:/u.test(target)) {
    return '个人账号数据只允许用户本人在 QQ 私聊中查询。';
  }
  if (channel !== 'qqbot' || !actorId || target !== `qqbot:c2c:${actorId}`) {
    return '当前会话缺少匹配的用户 QQ 私聊身份，不能查询个人账号数据。';
  }
  return '';
}

/**
 * Shared read-only personal account use case. Ingress adapters provide trusted
 * QQ identity and delivery; AlecaFrame remains the sole owner of snapshot
 * parsing, account decisions and card rendering.
 */
export async function executePersonalUseCase(request, ports) {
  const text = normalizeText(request?.text);
  const matched = matchCommandText(text, 'user-account');
  if (!matched) {
    return {
      ok: false,
      commandId: null,
      result: {
        ok: false, handled: false, kind: 'personal-unparsed', error: 'unsupported_command', text: '',
        userError: userError({
          code: 'unsupported_input', category: 'personal-input', retryable: false,
          nextSteps: ['帮助 账号', '帮助 遗物'],
        }),
      },
    };
  }

  const identityError = personalIdentityError(request);
  if (identityError) {
    return {
      ok: false,
      commandId: matched.commandId,
      result: {
        ok: false, handled: true, kind: 'personal-denied', commandId: matched.commandId, error: 'untrusted_identity', text: identityError,
        userError: userError({
          code: 'permission_denied', category: 'personal-identity', retryable: false, nextSteps: ['帮助'],
        }),
      },
    };
  }

  const normalized = {
    commandId: matched.commandId,
    text: matched.text,
    channel: 'qqbot',
    target: normalizeId(request.target),
    actorId: normalizeId(request.actorId),
    actorDisplayName: normalizeText(request.actorDisplayName) || normalizeId(request.actorId),
    personalAllowed: true,
    isGroup: false,
    source: normalizeText(request.source),
    cardDir: request.cardDir,
  };

  let result;
  try {
    result = await ports.execute(normalized);
  } catch (error) {
    ports.log?.('error', 'personal account execution failed', error);
    result = {
      ok: false, handled: true, kind: 'personal-failed', error: 'execute_failed',
      text: '个人账号查询暂时失败，请稍后重试。',
      userError: userError({
        code: 'internal_error', category: 'personal-execute', retryable: true,
        nextSteps: ['帮助 账号'],
      }),
    };
  }
  if (!result || (result.ok === false && !normalizeText(result.text))) {
    result = {
      ok: false, handled: true, kind: 'personal-failed', error: 'execute_failed',
      text: '个人账号查询暂时失败，请稍后重试。',
      userError: userError({
        code: 'internal_error', category: 'personal-execute', retryable: true,
        nextSteps: ['帮助 账号'],
      }),
    };
  }

  const decorated = { ...result, commandId: matched.commandId };
  return {
    ok: decorated.ok !== false && decorated.handled !== false,
    commandId: matched.commandId,
    result: decorated,
  };
}
