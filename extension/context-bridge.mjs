import { classifyFreshness } from './evidence.mjs';

const DEFAULT_TTL_MS = 15 * 60 * 1000;

// R18 片：桥接上下文载荷（[Warframe 短命令上下文] 后的 JSON）的确定性体积上限。
// 超限时按固定顺序裁剪字段，保证 JSON 始终有效且实体指代锚点优先保留。
export const CONSUMED_PAYLOAD_MAX_BYTES = 2048;

const STALE_DOWNGRADE_SENTENCE = '其中标记为 stale 的条目仅为指代解析保留；其实时事实已过期，不得作为当前状态证据。';

function byteLength(text) {
  return new TextEncoder().encode(String(text)).length;
}

function cleanText(value, max = 120) {
  return String(value || '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, max);
}

function sanitizeAction(action) {
  const command = cleanText(action?.command, 80);
  if (!command) return null;
  return { command, label: cleanText(action?.label || command, 40) };
}

// 白名单清洗：只有下列字段能进入桥接上下文；原始身份、target/sender、
// token/key、raw snapshot、完整工具结果等一律不是白名单键，直接丢弃。
function sanitizeEnvelope(value) {
  if (!value || value.ok === false) return null;
  const entities = (Array.isArray(value.entities) ? value.entities : []).slice(0, 3).map((entity) => ({
    type: cleanText(entity?.type, 32),
    displayName: cleanText(entity?.displayName, 80),
    canonicalName: cleanText(entity?.canonicalName, 100),
  })).filter((entity) => entity.displayName || entity.canonicalName);
  if (!entities.length) return null;
  const expiry = cleanText(value.expiry, 40);
  return {
    kind: cleanText(value.kind, 32),
    query: cleanText(value.query, 100),
    scope: value.scope === 'personal' ? 'personal' : 'public',
    summary: cleanText(value.summary, 240),
    entities,
    nextActions: (Array.isArray(value.nextActions) ? value.nextActions : []).map(sanitizeAction).filter(Boolean).slice(0, 2),
    fetchedAt: cleanText(value.fetchedAt, 40),
    ...(expiry ? { expiry } : {}),
  };
}

// 条目 → 载荷：已过期（按 evidence 新鲜度语义）的实时事实不再携带 summary，
// 只保留指代解析所需实体与 stale 标记（明确降级，不伪装成当前证据）。
function renderItem(item, now) {
  const stale = classifyFreshness(item.expiry, item.fetchedAt, now) === 'expired';
  const payload = {
    kind: item.kind,
    query: item.query,
    entities: item.entities,
    nextActions: item.nextActions,
    fetchedAt: item.fetchedAt,
  };
  if (stale) payload.stale = true;
  else payload.summary = item.summary;
  return { stale, payload };
}

// 确定性裁剪（每步全量作用，固定顺序）：
// 1. nextActions → 2. summary（仅新鲜条目携带）→ 3. 每条目只留首个实体 →
// 4. 多余条目 → 5. 条目实体只剩 canonicalName。
function shrinkPayload(payload) {
  if (payload.some((item) => (item.nextActions || []).length > 0)) {
    return payload.map((item) => {
      const next = { ...item };
      delete next.nextActions;
      return next;
    });
  }
  if (payload.some((item) => item.summary != null)) {
    return payload.map((item) => {
      const next = { ...item };
      delete next.summary;
      return next;
    });
  }
  if (payload.some((item) => (item.entities || []).length > 1)) {
    return payload.map((item) => ({ ...item, entities: (item.entities || []).slice(0, 1) }));
  }
  if (payload.length > 1) return payload.slice(0, payload.length - 1);
  const first = payload[0];
  if (first?.entities?.length && first.entities.some((entity) => Object.keys(entity).length > 1)) {
    return [{
      ...first,
      entities: first.entities.map((entity) => (entity.canonicalName
        ? { canonicalName: entity.canonicalName }
        : { displayName: entity.displayName })),
    }];
  }
  return payload;
}

function boundedPayload(items, now) {
  const rendered = items.map((item) => renderItem(item, now));
  let payload = rendered.map((item) => item.payload);
  let serialized = JSON.stringify(payload);
  while (byteLength(serialized) > CONSUMED_PAYLOAD_MAX_BYTES) {
    const next = shrinkPayload(payload);
    if (next === payload) break;
    payload = next;
    serialized = JSON.stringify(payload);
  }
  return {
    payload,
    bytes: byteLength(serialized),
    anyStale: rendered.some((item) => item.stale),
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
      const { payload, anyStale } = boundedPayload(entry.items, now());
      const downgrade = anyStale ? ` ${STALE_DOWNGRADE_SENTENCE}` : '';
      return `[Warframe 短命令上下文] ${JSON.stringify(payload)}\n仅用于解析“这个甲、这些遗物、刚才那个”等指代。价格、库存、商店和世界状态必须重新调用 warframe_assistant 查询；不要复述或重发上一张卡。${downgrade}`;
    },
    peek(key) { return read(key)?.items || []; },
    clear(key) { memory.delete(key); },
  };
}
