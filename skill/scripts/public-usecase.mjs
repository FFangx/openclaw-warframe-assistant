import { createRequire } from 'node:module';

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
  };
  try {
    let result;
    if (arbitration) result = await ports.queryArbitration(command);
    else if (intel) result = command.intelType === 'trader' && command.personalAllowed
      ? await ports.runPersonalTrader(command)
      : await ports.queryIntel(command);
    else result = await ports.runShortcut(command);
    if (!result || (result.ok === false && !normalizeText(result.text))) {
      result = { handled: true, ok: false, kind: 'public-failed', text: 'Warframe 查询暂时失败，请稍后重试。' };
    }
    return { ok: result.ok !== false && result.handled !== false, commandId: matched.commandId, result: { ...result, commandId: matched.commandId } };
  } catch (error) {
    ports.log?.('error', 'public command execution failed', error);
    return { ok: false, commandId: matched.commandId, result: { handled: true, ok: false, kind: 'public-failed', commandId: matched.commandId, text: 'Warframe 查询暂时失败，请稍后重试。' } };
  }
}
