import { createRequire } from 'node:module';
import { userError } from './user-error-contract.mjs';
import { buildCommandRequest } from './command-request.mjs';

const { matchCommandText, matchArbitrationCommand, matchIntelCommand } = createRequire(import.meta.url)('./command-registry.cjs');

const normalizeId = (value) => String(value || '').trim().toLowerCase();
const normalizeText = (value) => String(value || '').normalize('NFKC').trim();

function trustedPersonalContext(request) {
  const actorId = normalizeId(request?.actorId);
  return request?.personalAllowed === true
    && request?.isGroup !== true
    && normalizeId(request?.channel) === 'qqbot'
    && actorId
    && normalizeId(request?.target) === `qqbot:c2c:${actorId}`;
}

export async function executePublicUseCase(request, ports) {
  const text = normalizeText(request?.text);
  const arbitration = matchArbitrationCommand(text);
  const intel = matchIntelCommand(text);
  const shortcut = matchCommandText(text, 'shortcut-parser');
  const matched = arbitration || intel || shortcut;
  if (!matched) return { ok: false, commandId: null, result: { handled: false, ok: false, kind: 'public-unparsed', text: '' } };

  const command = {
    commandId: matched.commandId,
    text: matched.text,
    intelType: intel?.entry?.intelType || null,
    personalAllowed: Boolean(trustedPersonalContext(request)),
    cardDir: request.cardDir,
    statePath: request.statePath,
    source: normalizeText(request.source),
    // R17 第一片：代表链「裂缝 九重天」trace 上下文透传给执行端口（脚本运行环境变量）。
    trace: request.trace || null,
  };
  try {
    // R12 第一纵向切片：注册表匹配后立即建立一次性结构化请求。
    // 未切片命令返回 null，继续沿用既有文本协议。
    command.request = await buildCommandRequest({ matched, source: command.source });
    let result;
    if (arbitration) result = await ports.queryArbitration(command);
    else if (intel) result = command.intelType === 'trader' && command.personalAllowed
      ? await ports.runPersonalTrader(command)
      : await ports.queryIntel(command);
    else result = await ports.runShortcut(command);
    if (!result || (result.ok === false && !normalizeText(result.text))) {
      result = {
        handled: true, ok: false, kind: 'public-failed',
        text: 'Warframe 查询暂时失败，请稍后重试。',
        userError: userError({
          code: 'internal_error', category: 'public-execute', retryable: true, nextSteps: ['帮助'],
        }),
      };
    }
    return { ok: result.ok !== false && result.handled !== false, commandId: matched.commandId, result: { ...result, commandId: matched.commandId } };
  } catch (error) {
    ports.log?.('error', 'public command execution failed', error);
    return {
      ok: false,
      commandId: matched.commandId,
      result: {
        handled: true, ok: false, kind: 'public-failed', commandId: matched.commandId,
        text: 'Warframe 查询暂时失败，请稍后重试。',
        userError: userError({
          code: 'internal_error', category: 'public-execute', retryable: true, nextSteps: ['帮助'],
        }),
      },
    };
  }
}
