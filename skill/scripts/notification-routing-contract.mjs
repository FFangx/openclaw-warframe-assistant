// 生产通知路由合同（R5 第五片）：四类主动通知经共享 Outbox 的单一机器可读真源。
//
// operations.md「订阅调度」记录的投递路由事实——四类主动通知家族（掉落 / 世界状态订阅 /
// 周常周报 / 愿望单）共用 R3 共享 Outbox、各自的业务键前缀、monitor / dry-run 例外、
// 周报主图无损运输——在本模块以结构化数据固化；生成方（drops.mjs / subscriptions.mjs /
// wishlist.mjs）从这里取前缀、共享文件名与运输模式，测试按本合同的分类/校验函数核对
// 真实投递路径。缺失、重复、未知或错路由的合同（或与合同不符的生产路径）都会失败。
//
// 本模块是只读契约层：零网络、零凭据、零文件写入，挂在 notification-outbox.mjs 之上
// （Outbox 核心保持家族无关，只持久化 part.transport 模式）。文档化事实之外的细节
// （TTL 语义、账本事务顺序、去重集合）仍由各家族自己的测试锁定，不进本合同。

import { PART_TRANSPORT } from './notification-outbox.mjs';

// 四类主动通知 + legacy 迁移键共用的 Outbox 状态文件名（与各家族状态同目录）。
export const OUTBOX_FILE_NAME = 'warframe-delivery-outbox.json';

// 文档化家族集合：四类主动通知（proactive）+ 旧欠账兼容迁移键（migration，不属于主动家族）。
// validateRoutingRegistry 依此判定「缺失」（少一项）与「未知」（多一项）。
const DOCUMENTED_FAMILIES = Object.freeze([
  Object.freeze({ key: 'drops', kind: 'proactive' }),
  Object.freeze({ key: 'worldstate', kind: 'proactive' }),
  Object.freeze({ key: 'weekly', kind: 'proactive' }),
  Object.freeze({ key: 'wishlist', kind: 'proactive' }),
  Object.freeze({ key: 'legacy', kind: 'migration' }),
]);
const DOCUMENTED_BY_KEY = Object.freeze(Object.fromEntries(DOCUMENTED_FAMILIES.map((entry) => [entry.key, entry])));

/**
 * 路由注册表：familyKey → 契约条目。
 * - prefix：该家族业务键前缀（业务键 = prefix + sha256(targetKey) + ':' + payload）
 * - businessKey.payload：'digest'（事件集合 SHA-256，固定 64 位 hex）或 'event'（如掉落 syncedAt）
 * - media.primary / media.rest：首个媒体 part / 其余媒体 part 的投递模式
 * - entryPoints：生产入口点 → 是否经 Outbox（文档化例外：monitor/announce、dry-run、monitor/calibrate/gateway_start）
 * - redactOnTerminal：终态是否立即擦除 part.value（愿望单敏感 payload 专用）
 */
export const ROUTING_FAMILIES = Object.freeze({
  drops: Object.freeze({
    key: 'drops',
    kind: 'proactive',
    label: '订阅 掉落',
    prefix: 'drops:',
    businessKey: Object.freeze({ targetKey: 'sha256', payload: 'event' }),
    outboxFileName: OUTBOX_FILE_NAME,
    media: Object.freeze({ primary: PART_TRANSPORT.MEDIA, rest: PART_TRANSPORT.MEDIA }),
    redactOnTerminal: false,
    entryPoints: Object.freeze([
      Object.freeze({ command: 'monitor', usesOutbox: true }),
      // 例外：--dry-run 只输出预览，不落 Outbox、不调 QQ outbound
      Object.freeze({ command: 'monitor --dry-run', usesOutbox: false, outbound: false }),
    ]),
  }),
  worldstate: Object.freeze({
    key: 'worldstate',
    kind: 'proactive',
    label: '世界状态订阅 deliver',
    prefix: 'worldstate:',
    businessKey: Object.freeze({ targetKey: 'sha256', payload: 'digest' }),
    outboxFileName: OUTBOX_FILE_NAME,
    media: Object.freeze({ primary: PART_TRANSPORT.MEDIA, rest: PART_TRANSPORT.MEDIA }),
    redactOnTerminal: false,
    entryPoints: Object.freeze([
      // 例外：monitor（announce）不经过 Outbox，输出保持原样
      Object.freeze({ command: 'monitor', usesOutbox: false }),
      Object.freeze({ command: 'deliver', usesOutbox: true }),
    ]),
  }),
  weekly: Object.freeze({
    key: 'weekly',
    kind: 'proactive',
    label: '订阅 周常（周报）',
    prefix: 'weekly:',
    businessKey: Object.freeze({ targetKey: 'sha256', payload: 'digest' }),
    outboxFileName: OUTBOX_FILE_NAME,
    // 文档化运输例外：主周报单张完整原始 PNG 以 lossless 走 QQ /files + srv_send_msg=true 一步直传，
    // 好货卡普通 media；渲染失败退纯文字（无媒体 part 时运输规则不适用）。
    media: Object.freeze({ primary: PART_TRANSPORT.LOSSLESS, rest: PART_TRANSPORT.MEDIA }),
    redactOnTerminal: false,
    entryPoints: Object.freeze([
      // 例外：monitor（announce）不经过 Outbox，输出保持原样
      Object.freeze({ command: 'monitor', usesOutbox: false }),
      Object.freeze({ command: 'deliver', usesOutbox: true }),
    ]),
  }),
  wishlist: Object.freeze({
    key: 'wishlist',
    kind: 'proactive',
    label: '愿望单命中（deliver / Gateway 实时）',
    prefix: 'wishlist:',
    businessKey: Object.freeze({ targetKey: 'sha256', payload: 'digest' }),
    outboxFileName: OUTBOX_FILE_NAME,
    media: Object.freeze({ primary: PART_TRANSPORT.MEDIA, rest: PART_TRANSPORT.MEDIA }),
    redactOnTerminal: true,
    entryPoints: Object.freeze([
      // 例外：monitor/calibrate/gateway_start 输出与旧行为保持原样，不经 Outbox
      Object.freeze({ command: 'monitor', usesOutbox: false }),
      Object.freeze({ command: 'calibrate', usesOutbox: false }),
      Object.freeze({ command: 'gateway_start', usesOutbox: false }),
      Object.freeze({ command: 'deliver', usesOutbox: true }),
      // 例外：deliver --dry-run 只输出预览，绝不调用 QQ outbound
      Object.freeze({ command: 'deliver --dry-run', usesOutbox: false, outbound: false }),
    ]),
  }),
  legacy: Object.freeze({
    key: 'legacy',
    kind: 'migration',
    label: '旧欠账兼容迁移键',
    prefix: 'legacy:',
    businessKey: Object.freeze({ targetKey: 'sha256', payload: 'event' }),
    outboxFileName: OUTBOX_FILE_NAME,
    media: Object.freeze({ primary: PART_TRANSPORT.MEDIA, rest: PART_TRANSPORT.MEDIA }),
    redactOnTerminal: false,
    entryPoints: Object.freeze([]),
  }),
});

/** 四类主动通知家族的 key（按文档顺序，不含 legacy 迁移键） */
export function proactiveFamilyKeys() {
  return DOCUMENTED_FAMILIES.filter((entry) => entry.kind === 'proactive').map((entry) => entry.key);
}

const PREFIX_RE = /^[a-z0-9-]+:$/u;
const TARGET_KEY_RE = /^[0-9a-f]{64}$/u;
const DIGEST_RE = /^[0-9a-f]{64}$/u;
const KEY_SEGMENTS_RE = /^([a-z0-9-]+):([0-9a-f]{64}):(.+)$/u;
const MEDIA_TRANSPORTS = new Set([PART_TRANSPORT.MEDIA, PART_TRANSPORT.LOSSLESS]);

function normalizeTransport(value) {
  return String(value || '').trim().toLowerCase() === 'lossless' ? 'lossless' : 'media';
}

/**
 * 业务键 → 家族分类（只读，不抛错）：`{ known, familyKey, valid, targetKey, payload, reason }`。
 * - known=false：前缀不在路由注册表（unknown_prefix）或键结构非法（malformed）
 * - valid=false：前缀已知但 payload 不符该家族形状（bad_payload，如 weekly 键带非 digest 载荷）
 */
export function classifyBusinessKey(value) {
  const key = String(value || '');
  const match = KEY_SEGMENTS_RE.exec(key);
  if (!match) return { known: false, familyKey: null, valid: false, targetKey: null, payload: null, reason: 'malformed' };
  const [, name, targetKey, payload] = match;
  const family = ROUTING_FAMILIES[name];
  if (!family) return { known: false, familyKey: null, valid: false, targetKey: null, payload: null, reason: 'unknown_prefix' };
  const payloadOk = family.businessKey.payload === 'digest' ? DIGEST_RE.test(payload) : payload.length > 0;
  if (!payloadOk) return { known: true, familyKey: family.key, valid: false, targetKey, payload, reason: 'bad_payload' };
  return { known: true, familyKey: family.key, valid: true, targetKey, payload, reason: null };
}

/** 断言业务键属于指定家族（未知前缀、形状非法、或路由到别的家族都抛错）。 */
export function assertFamilyOfBusinessKey(value, expectedFamilyKey) {
  const family = ROUTING_FAMILIES[expectedFamilyKey];
  if (!family) throw new Error(`路由合同里没有家族: ${expectedFamilyKey}`);
  const classified = classifyBusinessKey(value);
  if (!classified.known) throw new Error(`业务键 ${value} 不在路由合同内（${classified.reason}）`);
  if (!classified.valid) throw new Error(`业务键 ${value} 违反 ${expectedFamilyKey} 合同形状（${classified.reason}）`);
  if (classified.familyKey !== expectedFamilyKey) {
    throw new Error(`业务键 ${value} 按合同路由到 ${classified.familyKey}，而非 ${expectedFamilyKey}`);
  }
  return true;
}

/**
 * 媒体 part 运输规则检查：首个媒体 part 用 media.primary，其余用 media.rest；
 * 媒体 part 缺失（纯文字降级）不算违例；未知 transport 原样标记。
 * 返回违例数组（空 = 合规）。
 */
export function mediaTransportViolations(mediaRule, parts) {
  const issues = [];
  const list = Array.isArray(parts) ? parts : [];
  let mediaIndex = 0;
  list.forEach((part, partIndex) => {
    const kind = String(part?.kind || '');
    const rawTransport = part?.transport == null || String(part?.transport ?? '') === '' ? null : String(part.transport).trim().toLowerCase();
    if (rawTransport != null && !MEDIA_TRANSPORTS.has(rawTransport)) {
      issues.push({ code: 'unknown_transport', partIndex, actual: rawTransport });
      return;
    }
    if (kind !== 'media' || !String(part?.value || '')) return;
    const expected = mediaIndex === 0 ? mediaRule.primary : mediaRule.rest;
    mediaIndex += 1;
    const actual = normalizeTransport(part?.transport);
    if (actual !== expected) issues.push({ code: 'part_transport', partIndex, expected, actual });
  });
  return issues;
}

/** 断言（可选）媒体 part 符合指定家族的运输合同。 */
export function assertFamilyMediaTransport(familyKey, parts) {
  const family = ROUTING_FAMILIES[familyKey];
  if (!family) throw new Error(`路由合同里没有家族: ${familyKey}`);
  const issues = mediaTransportViolations(family.media, parts);
  if (issues.length) {
    throw new Error(`家族 ${familyKey} 媒体运输违例: ${issues.map((issue) => (
      issue.code === 'part_transport'
        ? `part[${issue.partIndex}] 期望 ${issue.expected}，实际 ${issue.actual}`
        : `part[${issue.partIndex}] 未知运输模式 ${issue.actual}`
    )).join('；')}`);
  }
  return true;
}

/**
 * 校验路由注册表（默认校验真实注册表；测试可注入被破坏的注册表）：
 * 文档化家族缺失/未知、前缀重复、形状非法、周报非无损、愿望单未擦除、
 * 入口点重复或 outbound 与 usesOutbox 矛盾、前缀实际路由到别的家族——全部抛错。
 * 通过时返回 { families, proactive }。
 */
export function validateRoutingRegistry(registry = ROUTING_FAMILIES) {
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) throw new Error('路由合同注册表必须是对象');
  const keys = Object.keys(registry);
  const documentedKeys = DOCUMENTED_FAMILIES.map((entry) => entry.key);
  const missing = documentedKeys.filter((key) => !(key in registry));
  if (missing.length) throw new Error(`路由合同缺失文档化家族: ${missing.join(', ')}`);
  const unknown = keys.filter((key) => !(key in DOCUMENTED_BY_KEY));
  if (unknown.length) throw new Error(`路由合同含未知家族: ${unknown.join(', ')}`);

  const prefixOwner = new Map();
  for (const key of documentedKeys) {
    const family = registry[key];
    if (!family || typeof family !== 'object') throw new Error(`家族 ${key} 缺少契约条目`);
    const documented = DOCUMENTED_BY_KEY[key];
    if (family.key !== key) throw new Error(`家族 ${key} 的 key 字段不一致: ${family.key}`);
    if (family.kind !== documented.kind) throw new Error(`家族 ${key} 的 kind 与文档不符: ${family.kind}`);
    if (typeof family.prefix !== 'string' || !PREFIX_RE.test(family.prefix)) throw new Error(`家族 ${key} 前缀非法: ${family.prefix}`);
    if (prefixOwner.has(family.prefix)) {
      throw new Error(`路由合同前缀重复: ${family.prefix} 同时属于 ${prefixOwner.get(family.prefix)} 与 ${key}`);
    }
    prefixOwner.set(family.prefix, key);
    if (family.outboxFileName !== OUTBOX_FILE_NAME) throw new Error(`家族 ${key} 未指向共享 Outbox 文件 ${OUTBOX_FILE_NAME}`);
    if (family.businessKey?.targetKey !== 'sha256') throw new Error(`家族 ${key} 的 targetKey 段必须是 sha256`);
    if (!['event', 'digest'].includes(family.businessKey?.payload)) throw new Error(`家族 ${key} 的 payload 形状未知: ${family.businessKey?.payload}`);
    const media = family.media || {};
    if (!MEDIA_TRANSPORTS.has(media.primary) || !MEDIA_TRANSPORTS.has(media.rest)) throw new Error(`家族 ${key} 的媒体运输模式无效`);
    if (key === 'weekly' && media.primary !== PART_TRANSPORT.LOSSLESS) throw new Error('周常主周报主图必须 lossless 运输（原始像素不压缩）');
    if (key !== 'weekly' && media.primary !== PART_TRANSPORT.MEDIA) throw new Error(`家族 ${key} 的媒体主图必须是普通 media 运输`);
    if (typeof family.redactOnTerminal !== 'boolean') throw new Error(`家族 ${key} 缺少 redactOnTerminal`);
    if (key === 'wishlist' && family.redactOnTerminal !== true) throw new Error('愿望单命中通知必须 redactOnTerminal（终态擦除敏感 payload）');
    if (key !== 'wishlist' && family.redactOnTerminal !== false) throw new Error(`家族 ${key} 不得 redactOnTerminal（只有愿望单擦除）`);
    if (!Array.isArray(family.entryPoints)) throw new Error(`家族 ${key} 缺少 entryPoints`);
    const commands = new Set();
    for (const point of family.entryPoints) {
      if (!point || typeof point.command !== 'string' || !point.command.trim()) throw new Error(`家族 ${key} 有匿名入口点`);
      if (commands.has(point.command)) throw new Error(`家族 ${key} 重复入口点: ${point.command}`);
      commands.add(point.command);
      if (typeof point.usesOutbox !== 'boolean') throw new Error(`家族 ${key} 入口点 ${point.command} 缺少 usesOutbox`);
      if (point.outbound === false && point.usesOutbox) throw new Error(`家族 ${key} 入口点 ${point.command} 禁止 outbound 却声明经 Outbox`);
    }
    if (family.kind === 'proactive' && family.entryPoints.length === 0) throw new Error(`家族 ${key} 必须有入口点`);
    // 行为一致性：前缀按注册表归属分类，必须落在本家族自己名下（防误注册/错路由）。
    const probe = `${family.prefix}${'0'.repeat(64)}:${family.businessKey.payload === 'digest' ? '0'.repeat(64) : 'probe'}`;
    const classified = classifyBusinessKey(probe);
    if (!classified.known || classified.familyKey !== key) {
      throw new Error(`家族 ${key} 的前缀 ${family.prefix} 实际路由到 ${classified.familyKey || '未知'}`);
    }
  }
  return { families: keys, proactive: proactiveFamilyKeys() };
}

/**
 * 对 Outbox 记录条目做路由审计（纯函数，零 IO）：逐条分类业务键，并核对
 * redactOnTerminal 与媒体运输规则。返回 [{ id, businessKey, familyKey, known, valid, violations }]。
 * 可用它检查任意 warframe-delivery-outbox.json 的 entries（unknown/misrouted/违例条目被逐条标记）。
 */
export function analyzeOutboxEntries(entries) {
  const results = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const businessKey = String(entry?.businessKey || '');
    const classified = classifyBusinessKey(businessKey);
    const violations = [];
    if (!classified.known) violations.push(classified.reason);
    else if (!classified.valid) violations.push(classified.reason);
    const family = classified.known ? ROUTING_FAMILIES[classified.familyKey] : null;
    if (family) {
      const entryRedact = entry?.redactOnTerminal === true;
      if (entryRedact !== family.redactOnTerminal) violations.push('redact_mismatch');
      for (const issue of mediaTransportViolations(family.media, entry?.parts)) violations.push(issue);
    }
    results.push({
      id: entry?.id ?? null,
      businessKey,
      familyKey: classified.familyKey,
      known: classified.known,
      valid: classified.valid,
      violations,
    });
  }
  return results;
}
