#!/usr/bin/env node

// R15 第二片：AlecaFrame lastData → 版本化、白名单的 AccountSnapshot v1。
//
// 只做三件事，全部是纯函数（不联网、不落盘、不读凭据、不碰 deltas.dat）：
//   1. 兼容旧/新两种 AlecaFrame 信封形状，抽出库存对象；
//   2. 按顶层白名单投影：未消费的原始顶层字段（令牌、账号标识、未来新增字段）
//      不进入适配后的快照，原始 envelope 整体不外传；
//   3. 为每个保留字段挂上可证明的元数据：来源、asOf/同步时间及依据、
//      周期归属与依据、边界时间、可信度与新鲜度。
//
// 另提供 diffAccountSnapshots：库存数量变化 + 今天真正被消费的周常标量/记录字段
// 的统一 delta。它是纯函数，事件数量有上限，事件里只有白名单投影，没有原始快照。
//
// 边界说明：白名单只作用于顶层。根因是库存条目内部字段（ItemType/ItemCount/
// UpgradeFingerprint/PendingRewards 等）正被现有消费方直接读取，二次投影会改变
// 用户可见输出；条目级投影留给后续 R15/R16 切片，不在本片扩大。

import { createHash } from 'node:crypto';

export const ACCOUNT_SNAPSHOT_SCHEMA_VERSION = 1;
export const ACCOUNT_SNAPSHOT_SOURCE = 'alecaframe.lastData';
export const MAX_DELTA_EVENTS = 512;

export const MISSING_INVENTORY_MESSAGE = '账号快照中没有库存数据，请先启动 AlecaFrame 和游戏完成一次加载。';

export const ENVELOPE_SHAPES = Object.freeze({
  LEGACY_INVENTORY_JSON: 'legacy-inventory-json',
  DIRECT_INVENTORY: 'direct-inventory',
  NONE: 'none',
});

// 顶层白名单（顺序=适配后 inventory 的键顺序，也是 delta 的处理顺序）。
// 每一项都必须有真实消费方；新增字段前先确认它确实会被业务读取。
export const ACCOUNT_SNAPSHOT_ALLOWLIST = Object.freeze([
  // 库存数量组：掉落计数（drops.countInventory）、库存估值、库存查询、紫卡
  'MiscItems', 'Recipes', 'Consumables', 'FusionTreasures', 'FlavourItems', 'SpecialItems', 'DataKnives',
  'RawUpgrades',
  // 装备/已装升级：父成品持有判定、奸商已拥有索引、周报战甲收集、紫卡（Upgrades）
  'Upgrades', 'LongGuns', 'Pistols', 'Melee', 'Suits', 'Sentinels', 'SentinelWeapons',
  'SpaceGuns', 'SpaceMelee', 'SpaceSuits', 'OperatorAmps', 'OperatorSuits',
  'CrewShipWeapons', 'DrifterMelee', 'Horses', 'Motorcycles', 'KubrowPets',
  // 账号标量（我的账号）
  'PlayerLevel', 'TradesRemaining', 'RegularCredits', 'FusionPoints',
  'PremiumCredits', 'PremiumCreditsFree', 'ActiveAvatarImageType',
  // 集团/日声望（赏金声望列）
  'Affiliations', 'DailyAffiliationCetus', 'DailyAffiliationSolaris', 'DailyAffiliationEntrati',
  'DailyAffiliationZariman', 'DailyAffiliationCavia', 'DailyAffiliationHex',
  // 周常事实（账号周常证据面板 + 周报自动核销）
  'EndlessXP', 'DescentRewards', 'EntratiVaultCountLastPeriod', 'EntratiVaultCountResetDate',
  'LastLiteSortieReward', 'ChallengeProgress', 'CalendarProgress',
  'EntratiLabConquestUnlocked', 'EntratiLabConquestCacheScoreMission',
  'EchoesHexConquestUnlocked', 'EchoesHexConquestCacheScoreMission', 'EchoesHexConquestBonusTokensGiven',
  // 商店已购标记（vendor-shop 的 oid 三档判定）
  'RecentVendorPurchases',
  // 同步标记：asOf 推导依据本身要保留，否则无法审计快照时间来源
  'LastInventorySync',
]);

const ALLOWLIST_SET = new Set(ACCOUNT_SNAPSHOT_ALLOWLIST);

// —— 周期归属：只写源数据自己能证明的结论，“游戏里是周常”不等于快照证明了周界 ——
//   declared-expiry  条目自带 Expiry
//   declared-reset   字段本身是重置时间戳
//   sibling-reset    同快照的 EntratiVaultCountResetDate 是它唯一可证明的周界
//   week-index       记录自带 WeekCount 周序号
//   declared-season  快照声明 SeasonType/Iteration
//   worldstate-join  周属性只能靠公开世界状态 join 才知道（快照未声明）
//   not-declared     无任何周期证据
// cycle 与 cycleBasis 相互独立：cycle 是能证明的周期种类（weekly/seasonal/none），
// cycleBasis 是证据形式。因此 'none' + 'declared-expiry' 表示“有声明边界，但周期长度未证明”。
const CONQUEST_FIELDS = [
  'EntratiLabConquestUnlocked', 'EntratiLabConquestCacheScoreMission',
  'EchoesHexConquestUnlocked', 'EchoesHexConquestCacheScoreMission', 'EchoesHexConquestBonusTokensGiven',
];

const DEFAULT_CYCLE_SPEC = Object.freeze({ cycle: 'none', cycleBasis: 'not-declared', boundary: null });

const CYCLE_SPECS = new Map([
  ['EndlessXP', { cycle: 'weekly', cycleBasis: 'declared-expiry', boundary: 'max-expiry' }],
  ['DescentRewards', { cycle: 'weekly', cycleBasis: 'declared-expiry', boundary: 'max-expiry' }],
  ['EntratiVaultCountResetDate', { cycle: 'weekly', cycleBasis: 'declared-reset', boundary: 'value' }],
  ['EntratiVaultCountLastPeriod', { cycle: 'weekly', cycleBasis: 'sibling-reset', boundary: 'sibling-reset' }],
  ...CONQUEST_FIELDS.map((field) => [field, { cycle: 'weekly', cycleBasis: 'sibling-reset', boundary: 'sibling-reset' }]),
  ['Affiliations', { cycle: 'weekly', cycleBasis: 'week-index', boundary: null }],
  ['LastLiteSortieReward', { cycle: 'weekly', cycleBasis: 'worldstate-join', boundary: null }],
  ['ChallengeProgress', { cycle: 'weekly', cycleBasis: 'worldstate-join', boundary: null }],
  ['CalendarProgress', { cycle: 'seasonal', cycleBasis: 'declared-season', boundary: null }],
  // 奸商/商店购买记录自带 Expiry，但快照没证明轮换周期长度，因此不标 weekly。
  ['RecentVendorPurchases', { cycle: 'none', cycleBasis: 'declared-expiry', boundary: 'vendor-purchase-expiry' }],
]);

// 数量 delta 覆盖的组：与 drops.countInventory 的计数口径一致（Upgrades 每条计 1）。
const QUANTITY_GROUPS = Object.freeze(['MiscItems', 'Recipes', 'Consumables', 'FusionTreasures', 'RawUpgrades', 'Upgrades']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isoOf(value) {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

// 与 alecaframe.mjs 既有 bsonDate 同口径；只接受源数据真的给了时间的情况。
function bsonDateIso(value) {
  if (isPlainObject(value) && value.$date != null) return bsonDateIso(value.$date);
  if (isPlainObject(value) && value.$numberLong != null) return bsonDateIso(value.$numberLong);
  const ms = Number(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function numberOf(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function maxNumberOf(list, key) {
  const values = (Array.isArray(list) ? list : []).map((entry) => numberOf(entry?.[key]));
  return Math.max(0, ...values);
}

function stringOrNull(value) {
  return (typeof value === 'string' || typeof value === 'number') && String(value) ? String(value) : null;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort(compareKeys).map((key) => [key, canonicalJson(value[key])]));
  }
  if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  return String(value);
}

// 列表投影成 {count, digest}：事件里不放原始数组，仍可比较“是否变化”。
// 这些字段的消费语义是集合而非顺序；逐项规范化并排序，既避免对象被压成
// 同一个 "[object Object]"，也避免同内容仅换序时产生伪变化。
function listProjection(values) {
  const normalized = (Array.isArray(values) ? values : [])
    .map((value) => JSON.stringify(canonicalJson(value)))
    .sort(compareKeys);
  return {
    count: normalized.length,
    digest: createHash('sha256').update(JSON.stringify(normalized)).digest('hex'),
  };
}

// 旧版包 InventoryJson/InventoryJSON 信封；新版（2026-08 起）顶层直接是库存对象。
export function extractSnapshotInventory(envelope) {
  const source = isPlainObject(envelope) ? envelope : {};
  const inventoryText = source.InventoryJson || source.InventoryJSON;
  if (inventoryText) {
    return {
      shape: ENVELOPE_SHAPES.LEGACY_INVENTORY_JSON,
      inventory: typeof inventoryText === 'string' ? JSON.parse(inventoryText) : inventoryText,
    };
  }
  if (source.MiscItems || source.RawUpgrades) return { shape: ENVELOPE_SHAPES.DIRECT_INVENTORY, inventory: source };
  return { shape: ENVELOPE_SHAPES.NONE, inventory: null };
}

// asOf 依据：优先 LastInventorySync 的 oid 前 8 位（源数据声明），否则文件 mtime
// （只能证明“文件何时落盘”，可信度更低），两者都没有才 unavailable。
function readSyncMarker(inventory, fileMtime) {
  const fallback = { asOf: fileMtime, basis: fileMtime ? 'file-mtime' : 'unavailable', note: 'missing-sync-oid' };
  const oid = inventory?.LastInventorySync?.$oid ?? inventory?.LastInventorySync?.oid;
  if (oid == null || oid === '') return fallback;
  if (!/^[0-9a-f]{24}$/iu.test(String(oid))) return { ...fallback, note: 'malformed-sync-oid' };
  const seconds = Number.parseInt(String(oid).slice(0, 8), 16);
  // 全零 oid 与既有实现一致：视为无有效时间，回退文件时间。
  if (!(seconds > 0)) return { ...fallback, note: 'zero-sync-oid' };
  return { asOf: new Date(seconds * 1000).toISOString(), basis: 'source-sync-oid', note: null };
}

function confidenceOf(asOfBasis) {
  if (asOfBasis === 'source-sync-oid') return 'declared';
  if (asOfBasis === 'file-mtime') return 'derived';
  return 'unavailable';
}

function freshnessOf(boundaryAt, now) {
  if (!boundaryAt) return 'unknown';
  const boundaryMs = Date.parse(boundaryAt);
  const nowMs = Number(now);
  if (!Number.isFinite(boundaryMs) || !Number.isFinite(nowMs)) return 'unknown';
  return boundaryMs > nowMs ? 'within-declared-cycle' : 'past-declared-cycle';
}

function boundaryOf(spec, raw, siblingReset) {
  if (!spec?.boundary) return null;
  if (spec.boundary === 'value') return bsonDateIso(raw);
  if (spec.boundary === 'sibling-reset') return siblingReset;
  if (spec.boundary === 'max-expiry') return maxExpiryOf(Array.isArray(raw) ? raw : []);
  if (spec.boundary === 'vendor-purchase-expiry') {
    const purchases = (Array.isArray(raw) ? raw : [])
      .flatMap((vendor) => (Array.isArray(vendor?.PurchaseHistory) ? vendor.PurchaseHistory : []));
    return maxExpiryOf(purchases);
  }
  return null;
}

function maxExpiryOf(entries) {
  const times = entries
    .map((entry) => Date.parse(String(bsonDateIso(entry?.Expiry) || '')))
    .filter((ms) => Number.isFinite(ms));
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

// 顶层白名单投影。非对象库存原样透传（数组/标量没有顶层字段可泄露，也保持旧行为）。
function projectInventory(inventory) {
  if (!isPlainObject(inventory)) return { inventory, coverage: null };
  const projected = {};
  const retained = [];
  for (const field of ACCOUNT_SNAPSHOT_ALLOWLIST) {
    if (!Object.prototype.hasOwnProperty.call(inventory, field)) continue;
    projected[field] = inventory[field];
    retained.push(field);
  }
  const rawFields = Object.keys(inventory);
  return {
    inventory: projected,
    coverage: {
      inventoryTopLevelFields: rawFields.length,
      retainedTopLevelFields: retained.length,
      omittedTopLevelFields: rawFields.filter((field) => !ALLOWLIST_SET.has(field)).length,
    },
  };
}

function buildFieldMetadata(inventory, { asOf, asOfBasis, now, siblingReset }) {
  const confidence = confidenceOf(asOfBasis);
  const fields = {};
  if (!isPlainObject(inventory)) return fields;
  for (const field of ACCOUNT_SNAPSHOT_ALLOWLIST) {
    if (!Object.prototype.hasOwnProperty.call(inventory, field)) continue;
    const spec = CYCLE_SPECS.get(field) || DEFAULT_CYCLE_SPEC;
    const boundaryAt = boundaryOf(spec, inventory[field], siblingReset);
    fields[field] = {
      source: ACCOUNT_SNAPSHOT_SOURCE,
      asOf,
      asOfBasis,
      confidence,
      cycle: spec.cycle,
      cycleBasis: spec.cycleBasis,
      boundaryAt,
      freshness: freshnessOf(boundaryAt, now),
    };
  }
  return fields;
}

/**
 * 把 AlecaFrame lastData 信封适配成版本化 AccountSnapshot v1。
 * @param {unknown} envelope JSON.parse 后的 lastData 信封（旧版或新版）
 * @param {{ now?: number, fileMtime?: string|Date|null, fileMtimeMs?: number|null, alecaDir?: string|null,
 *           missingInventoryMessage?: string }} [options]
 */
export function adaptAccountSnapshot(envelope, options = {}) {
  const { shape, inventory: extracted } = extractSnapshotInventory(envelope);
  if (!extracted) throw new Error(options.missingInventoryMessage || MISSING_INVENTORY_MESSAGE);
  const fileMtime = isoOf(options.fileMtime);
  const sync = readSyncMarker(extracted, fileMtime);
  const { inventory, coverage } = projectInventory(extracted);
  const siblingReset = bsonDateIso(extracted?.EntratiVaultCountResetDate);
  const fields = buildFieldMetadata(inventory, {
    asOf: sync.asOf,
    asOfBasis: sync.basis,
    now: options.now ?? Date.now(),
    siblingReset,
  });
  return {
    schemaVersion: ACCOUNT_SNAPSHOT_SCHEMA_VERSION,
    source: ACCOUNT_SNAPSHOT_SOURCE,
    envelopeShape: shape,
    asOf: sync.asOf,
    asOfBasis: sync.basis,
    asOfNote: sync.note,
    confidence: confidenceOf(sync.basis),
    // 兼容既有消费方：syncedAt 语义不变（源同步时间，缺失时文件 mtime）。
    syncedAt: sync.asOf,
    fileMtime,
    fileMtimeMs: Number.isFinite(Number(options.fileMtimeMs)) ? Number(options.fileMtimeMs) : null,
    alecaDir: options.alecaDir ?? null,
    inventory,
    coverage,
    fieldCount: Object.keys(fields).length,
    fields,
  };
}

function assertAccountSnapshot(value, label) {
  if (!isPlainObject(value)) throw new Error(`${label} is not an account snapshot`);
  if (value.schemaVersion !== ACCOUNT_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(`${label} has unsupported schemaVersion: ${String(value.schemaVersion)}`);
  }
  if (value.source !== ACCOUNT_SNAPSHOT_SOURCE) {
    throw new Error(`${label} has unsupported source: ${String(value.source)}`);
  }
  return value;
}

function compareKeys(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function projectionEquals(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function changedMetrics(before, after) {
  if (!isPlainObject(before) || !isPlainObject(after)) return [];
  return Object.keys(before).filter((key) => !projectionEquals(before[key], after[key]));
}

function quantityTotals(inventory, group) {
  const totals = new Map();
  for (const item of Array.isArray(inventory?.[group]) ? inventory[group] : []) {
    const key = item?.ItemType;
    if (!key) continue;
    const amount = group === 'Upgrades' ? 1 : (item?.ItemCount != null ? Number(item.ItemCount) || 0 : 1);
    totals.set(key, (totals.get(key) || 0) + amount);
  }
  return totals;
}

function quantityEvents(fromInventory, toInventory, field, boundary, out) {
  const before = quantityTotals(fromInventory, field);
  const after = quantityTotals(toInventory, field);
  for (const entity of [...new Set([...before.keys(), ...after.keys()])].sort(compareKeys)) {
    const fromCount = before.get(entity) ?? 0;
    const toCount = after.get(entity) ?? 0;
    if (fromCount === toCount) continue;
    const change = before.has(entity) ? (after.has(entity) ? 'changed' : 'removed') : 'added';
    out.push({
      id: `inventory-quantity:${field}:${entity}`,
      kind: 'inventory-quantity',
      field,
      entity,
      change,
      from: fromCount,
      to: toCount,
      delta: toCount - fromCount,
      changedMetrics: [],
      source: ACCOUNT_SNAPSHOT_SOURCE,
      asOf: boundary.asOf,
      fromAsOf: boundary.fromAsOf,
      cycle: 'none',
    });
  }
}

// —— 周常投影：只取现有消费方真正读的字段 ——

function projectSortieReward(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const first = list[0];
  return { count: list.length, sortieId: stringOrNull(first?.SortieId?.$oid ?? first?.SortieId) };
}

function projectConquestScore(raw) {
  return Math.max(0, numberOf(raw));
}

function projectIsoDate(raw) {
  return bsonDateIso(raw);
}

const WEEKLY_SCALAR_DELTAS = Object.freeze([
  { field: 'EntratiLabConquestCacheScoreMission', project: projectConquestScore },
  { field: 'EntratiLabConquestUnlocked', project: projectConquestScore },
  { field: 'EchoesHexConquestCacheScoreMission', project: projectConquestScore },
  { field: 'EchoesHexConquestUnlocked', project: projectConquestScore },
  { field: 'EntratiVaultCountLastPeriod', project: projectConquestScore },
  { field: 'EntratiVaultCountResetDate', project: projectIsoDate },
  { field: 'LastLiteSortieReward', project: projectSortieReward },
  { field: 'EchoesHexConquestBonusTokensGiven', project: (raw) => listProjection(raw) },
]);

function mapByKey(list, keyOf, project) {
  const map = new Map();
  for (const item of Array.isArray(list) ? list : []) {
    const key = keyOf(item);
    if (key == null || key === '') continue;
    map.set(String(key), project(item));
  }
  return map;
}

function projectEndlessXp(item) {
  return {
    expiry: bsonDateIso(item?.Expiry),
    earned: numberOf(item?.Earn),
    goal: maxNumberOf(item?.PendingRewards, 'RequiredTotalXp'),
  };
}

function projectDescentReward(item) {
  return {
    expiry: bsonDateIso(item?.Expiry),
    claimed: numberOf(item?.FloorClaimed),
    goal: maxNumberOf(item?.PendingRewards, 'FloorCheckpoint'),
  };
}

function projectChallengeProgress(item) {
  return { progress: numberOf(item?.Progress) };
}

function projectCalendarProgress(raw) {
  const season = raw?.SeasonProgress;
  return {
    seasonType: stringOrNull(season?.SeasonType),
    lastCompletedDayIdx: numberOrNull(season?.LastCompletedDayIdx),
    activatedChallenges: listProjection(season?.ActivatedChallenges),
    iteration: numberOrNull(raw?.Iteration),
    upgrades: listProjection(raw?.YearProgress?.Upgrades),
  };
}

function weeklyMissionEntries(inventory) {
  const entries = new Map();
  for (const affiliation of Array.isArray(inventory?.Affiliations) ? inventory.Affiliations : []) {
    const tag = stringOrNull(affiliation?.Tag);
    if (!tag) continue;
    for (const mission of Array.isArray(affiliation?.WeeklyMissions) ? affiliation.WeeklyMissions : []) {
      const weekCount = numberOrNull(mission?.WeekCount);
      if (weekCount == null) continue;
      entries.set(`${tag}#${weekCount}`, { completed: mission?.CompletedMission === true });
    }
  }
  return entries;
}

// 记录型字段：实体身份稳定（Category/Name/Tag#WeekCount），事件只带投影后的标量。
const WEEKLY_RECORD_DELTAS = Object.freeze([
  {
    field: 'EndlessXP',
    entries: (inventory) => mapByKey(inventory?.EndlessXP, (item) => item?.Category, projectEndlessXp),
  },
  {
    field: 'DescentRewards',
    entries: (inventory) => mapByKey(inventory?.DescentRewards, (item) => item?.Category, projectDescentReward),
  },
  {
    field: 'ChallengeProgress',
    entries: (inventory) => mapByKey(inventory?.ChallengeProgress, (item) => item?.Name, projectChallengeProgress),
  },
  {
    field: 'Affiliations.WeeklyMissions',
    entries: (inventory) => weeklyMissionEntries(inventory),
  },
  {
    field: 'CalendarProgress',
    entries: (inventory) => new Map([['season', projectCalendarProgress(inventory?.CalendarProgress)]]),
  },
]);

function weeklyRecordEvents(fromInventory, toInventory, spec, boundary, out) {
  const before = spec.entries(fromInventory);
  const after = spec.entries(toInventory);
  const cycle = (CYCLE_SPECS.get(spec.field) || CYCLE_SPECS.get(spec.field.split('.')[0]) || DEFAULT_CYCLE_SPEC).cycle;
  for (const entity of [...new Set([...before.keys(), ...after.keys()])].sort(compareKeys)) {
    const wasPresent = before.has(entity);
    const isPresent = after.has(entity);
    const fromValue = before.get(entity) ?? null;
    const toValue = after.get(entity) ?? null;
    const change = wasPresent ? (isPresent ? 'changed' : 'removed') : 'added';
    const metrics = change === 'changed' ? changedMetrics(fromValue, toValue) : [];
    if (change === 'changed' && !metrics.length) continue;
    out.push({
      id: `weekly-record:${spec.field}:${entity}`,
      kind: 'weekly-record',
      field: spec.field,
      entity,
      change,
      from: fromValue,
      to: toValue,
      delta: null,
      changedMetrics: metrics,
      source: ACCOUNT_SNAPSHOT_SOURCE,
      asOf: boundary.asOf,
      fromAsOf: boundary.fromAsOf,
      cycle,
    });
  }
}

/**
 * 纯函数：比较两个已适配的 AccountSnapshot v1，产出稳定身份/顺序的 delta 事件。
 * previous 为 null 时只建立基线，不产生事件（避免首轮把整仓库存当“新增”）。
 * @param {object|null} previous
 * @param {object} next
 * @param {{ limit?: number }} [options]
 */
export function diffAccountSnapshots(previous, next, options = {}) {
  const to = assertAccountSnapshot(next, 'next');
  const from = previous == null ? null : assertAccountSnapshot(previous, 'previous');
  const limit = Number.isInteger(options.limit) && options.limit >= 0 ? options.limit : MAX_DELTA_EVENTS;
  const events = [];
  if (from) {
    const boundary = { asOf: to.asOf ?? null, fromAsOf: from.asOf ?? null };
    for (const group of QUANTITY_GROUPS) quantityEvents(from.inventory, to.inventory, group, boundary, events);
    for (const spec of WEEKLY_SCALAR_DELTAS) {
      const cycle = (CYCLE_SPECS.get(spec.field) || DEFAULT_CYCLE_SPEC).cycle;
      const before = spec.project(from.inventory?.[spec.field]);
      const after = spec.project(to.inventory?.[spec.field]);
      if (projectionEquals(before, after)) continue;
      events.push({
        id: `weekly-scalar:${spec.field}`,
        kind: 'weekly-scalar',
        field: spec.field,
        entity: null,
        change: 'changed',
        from: before,
        to: after,
        delta: null,
        changedMetrics: [],
        source: ACCOUNT_SNAPSHOT_SOURCE,
        asOf: boundary.asOf,
        fromAsOf: boundary.fromAsOf,
        cycle,
      });
    }
    for (const spec of WEEKLY_RECORD_DELTAS) weeklyRecordEvents(from.inventory, to.inventory, spec, boundary, events);
  }
  return {
    schemaVersion: ACCOUNT_SNAPSHOT_SCHEMA_VERSION,
    source: ACCOUNT_SNAPSHOT_SOURCE,
    baseline: from === null,
    sameAsOf: Boolean(from && from.asOf === to.asOf),
    from: from ? { schemaVersion: from.schemaVersion, source: from.source, asOf: from.asOf ?? null, asOfBasis: from.asOfBasis } : null,
    to: { schemaVersion: to.schemaVersion, source: to.source, asOf: to.asOf ?? null, asOfBasis: to.asOfBasis },
    totalEvents: events.length,
    truncated: events.length > limit,
    events: events.length > limit ? events.slice(0, limit) : events,
  };
}
