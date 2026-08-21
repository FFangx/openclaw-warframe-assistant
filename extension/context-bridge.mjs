const DEFAULT_TTL_MS = 15 * 60 * 1000;

function cleanText(value, max = 120) {
  return String(value || '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, max);
}

function sanitizeAction(action) {
  const command = cleanText(action?.command, 80);
  if (!command) return null;
  return { command, label: cleanText(action?.label || command, 40) };
}

function sanitizeEnvelope(value) {
  if (!value || value.ok === false) return null;
  const entities = (Array.isArray(value.entities) ? value.entities : []).slice(0, 3).map((entity) => ({
    type: cleanText(entity?.type, 32),
    displayName: cleanText(entity?.displayName, 80),
    canonicalName: cleanText(entity?.canonicalName, 100),
  })).filter((entity) => entity.displayName || entity.canonicalName);
  if (!entities.length) return null;
  return {
    kind: cleanText(value.kind, 32),
    query: cleanText(value.query, 100),
    scope: value.scope === 'personal' ? 'personal' : 'public',
    summary: cleanText(value.summary, 240),
    entities,
    nextActions: (Array.isArray(value.nextActions) ? value.nextActions : []).map(sanitizeAction).filter(Boolean).slice(0, 2),
    fetchedAt: cleanText(value.fetchedAt, 40),
  };
}

export function createContextBridge({ ttlMs = DEFAULT_TTL_MS, maxTurns = 4, maxEntries = 3, now = () => Date.now() } = {}) {
  const memory = new Map();
  const read = (key) => {
    const entry = memory.get(key);
    if (!entry || entry.expiresAt <= now() || entry.turns >= maxTurns) {
      memory.delete(key);
      return null;
    }
    return entry;
  };
  return {
    remember(key, value) {
      if (!key) return false;
      const envelope = sanitizeEnvelope(value);
      if (!envelope) return false;
      const previous = read(key)?.items || [];
      const identity = envelope.entities[0]?.canonicalName || envelope.entities[0]?.displayName;
      const items = [envelope, ...previous.filter((item) => (item.entities[0]?.canonicalName || item.entities[0]?.displayName) !== identity)].slice(0, maxEntries);
      memory.set(key, { items, turns: 0, expiresAt: now() + ttlMs });
      return true;
    },
    consumePrompt(key) {
      const entry = read(key);
      if (!entry) return '';
      entry.turns += 1;
      const payload = entry.items.map((item) => ({
        kind: item.kind, query: item.query, summary: item.summary,
        entities: item.entities, nextActions: item.nextActions, fetchedAt: item.fetchedAt,
      }));
      return `[Warframe 短命令上下文] ${JSON.stringify(payload)}\n仅用于解析“这个甲、这些遗物、刚才那个”等指代。价格、库存、商店和世界状态必须重新调用 warframe_assistant 查询；不要复述或重发上一张卡。`;
    },
    peek(key) { return read(key)?.items || []; },
    clear(key) { memory.delete(key); },
  };
}

