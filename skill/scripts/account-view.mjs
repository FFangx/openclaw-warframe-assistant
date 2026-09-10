#!/usr/bin/env node

// R15 第四片：AccountSnapshot v1 → 语义化账号视图（AccountView v1）。
//
// 本文件是业务模块唯一允许出现的账号读取面：AlecaFrame 的原始顶层字段名、库存组名
// 与条目/嵌套键名只允许存在于 account-snapshot.mjs（信封 + 白名单 + 投影）与本文件
// （字段 → 语义映射 + 选择器）。业务模块（alecaframe/drops/rivens/rotation-calendar/
// bounties/vendor-shop/trader-shopping/subscriptions/weekly/shortcuts）只消费这里导出的
// 语义命名空间与作用域常量，不再书写任何原始字段名。
//
// 设计要点：
//   1. 语义命名空间：account / inventory / equipment / rivens / standing / weekly /
//      vendorPurchases。业务按「我要什么」调用，不按「字段叫什么」读取。
//   2. 作用域常量：库存集合用 INVENTORY_COLLECTIONS 的语义 id 表达；「掉落监测」
//      「已拥有判定」「估值口径」等业务口径用 INVENTORY_SCOPES 表达，集合组合只在这里定义。
//   3. 兼容旧输入：buildAccountView 接受三种输入——真实 AccountSnapshot v1、
//      旧式 { inventory, syncedAt } 包装、以及测试/旧调用方直接传的合成库存对象。
//      这样既有公开纯函数（countInventory / vendorPurchases / evaluateAutoCheck …）
//      的签名与测试夹具都不需要改。
//   4. 纯函数：不联网、不落盘、不读凭据、不碰 deltas.dat，也不写入任何用户状态。
//   5. 只重建容器：视图里的行、列表、Map 都是新对象，不与输入快照共享引用。

import { ACCOUNT_SNAPSHOT_SCHEMA_VERSION, ACCOUNT_SNAPSHOT_SOURCE } from './account-snapshot.mjs';

export const ACCOUNT_VIEW_SCHEMA_VERSION = 1;
export const ACCOUNT_VIEW_SOURCE = 'account-view';

// —— 版本化语义命名空间清单（合同测试据此锁定形状，新增必须显式登记） ——

export const ACCOUNT_VIEW_NAMESPACES = Object.freeze([
  'account', 'inventory', 'equipment', 'rivens', 'standing', 'weekly', 'vendorPurchases',
]);

// 版本化选择器清单：业务只允许读这些语义出口，新增必须显式登记（合同测试逐项核对可调用）。
export const ACCOUNT_VIEW_SELECTORS = Object.freeze([
  'inventory.rows', 'inventory.itemTypes', 'inventory.has', 'inventory.quantityTotals',
  'inventory.quantityOf', 'inventory.amountOf', 'inventory.collectionKnown',
  'equipment.known', 'equipment.itemTypes', 'equipment.has',
  'rivens.installed', 'rivens.veiled',
  'standing.affiliations', 'standing.affiliation', 'standing.dailyRemaining', 'standing.weeklyMission',
  'weekly.circuit', 'weekly.descent', 'weekly.netracell', 'weekly.challengeProgress',
  'weekly.archonRewards', 'weekly.calendar', 'weekly.research',
  'vendorPurchases.of', 'vendorPurchases.vendors',
]);

// —— 语义物品集合：id → AlecaFrame 原始库存组名（原始组名只在本表出现一次） ——
//
// 顺序 = 既有 ACCOUNT_GROUPS 顺序 + 末尾 Upgrades，保证「全部持有」行序与旧行为一致。

const COLLECTION_SOURCES = Object.freeze([
  ['resources', 'MiscItems'],
  ['blueprints', 'Recipes'],
  ['consumables', 'Consumables'],
  ['raw-upgrades', 'RawUpgrades'],
  ['fusion-treasures', 'FusionTreasures'],
  ['decorations', 'FlavourItems'],
  ['special-items', 'SpecialItems'],
  ['data-knives', 'DataKnives'],
  ['primary-weapons', 'LongGuns'],
  ['secondary-weapons', 'Pistols'],
  ['melee-weapons', 'Melee'],
  ['warframes', 'Suits'],
  ['sentinels', 'Sentinels'],
  ['sentinel-weapons', 'SentinelWeapons'],
  ['arch-guns', 'SpaceGuns'],
  ['arch-melee', 'SpaceMelee'],
  ['archwings', 'SpaceSuits'],
  ['operator-amps', 'OperatorAmps'],
  ['operator-suits', 'OperatorSuits'],
  ['railjack-weapons', 'CrewShipWeapons'],
  ['drifter-melee', 'DrifterMelee'],
  ['horses', 'Horses'],
  ['motorcycles', 'Motorcycles'],
  ['companions', 'KubrowPets'],
  ['installed-upgrades', 'Upgrades'],
]);

export const INVENTORY_COLLECTIONS = Object.freeze(Object.fromEntries(
  COLLECTION_SOURCES.map(([id]) => [id.replace(/-/gu, '_').toUpperCase(), id]),
));

const COLLECTION_SOURCE_BY_ID = new Map(COLLECTION_SOURCES);
const ALL_COLLECTIONS = Object.freeze(COLLECTION_SOURCES.map(([id]) => id));

const EQUIPMENT_COLLECTION_IDS = Object.freeze([
  'primary-weapons', 'secondary-weapons', 'melee-weapons', 'warframes', 'sentinels',
  'sentinel-weapons', 'arch-guns', 'arch-melee', 'archwings', 'operator-amps',
  'operator-suits', 'railjack-weapons', 'drifter-melee', 'horses', 'motorcycles', 'companions',
]);

// 掉落监测计数口径：与 drops.countInventory 既有语义一致（数量类 + 已装升级每条计 1）。
const DROP_MONITOR_COLLECTION_IDS = Object.freeze([
  'resources', 'blueprints', 'consumables', 'fusion-treasures', 'raw-upgrades', 'installed-upgrades',
]);

// 已拥有判定口径：与 trader-shopping.buildOwnedIndex 既有语义一致（奸商货单可交易品的持有范围）。
const OWNERSHIP_COLLECTION_IDS = Object.freeze([
  'raw-upgrades', 'installed-upgrades', 'resources', 'blueprints', 'consumables', 'decorations',
  'primary-weapons', 'secondary-weapons', 'melee-weapons', 'sentinels', 'sentinel-weapons',
  'arch-guns', 'arch-melee', 'archwings', 'operator-amps',
]);

// 库存估值口径：与 alecaframe.assembleInventoryValuation 既有语义一致。
const VALUATION_COLLECTION_IDS = Object.freeze([
  'resources', 'blueprints', 'consumables', 'raw-upgrades', 'installed-upgrades',
]);

// 语义作用域：业务只传这些常量，集合组合的原始知识留在这里。
export const INVENTORY_SCOPES = Object.freeze({
  ALL: 'all',
  EQUIPMENT: 'equipment',
  DROP_MONITOR: 'drop-monitor',
  OWNERSHIP: 'ownership',
  VALUATION: 'valuation',
  RESOURCES: INVENTORY_COLLECTIONS.RESOURCES,
  WARFRAMES: INVENTORY_COLLECTIONS.WARFRAMES,
  UPGRADES: INVENTORY_COLLECTIONS.INSTALLED_UPGRADES,
  RAW_UPGRADES: INVENTORY_COLLECTIONS.RAW_UPGRADES,
});

const SCOPE_COLLECTIONS = new Map([
  [INVENTORY_SCOPES.ALL, ALL_COLLECTIONS],
  [INVENTORY_SCOPES.EQUIPMENT, EQUIPMENT_COLLECTION_IDS],
  [INVENTORY_SCOPES.DROP_MONITOR, DROP_MONITOR_COLLECTION_IDS],
  [INVENTORY_SCOPES.OWNERSHIP, OWNERSHIP_COLLECTION_IDS],
  [INVENTORY_SCOPES.VALUATION, VALUATION_COLLECTION_IDS],
  ...ALL_COLLECTIONS.map((id) => [id, Object.freeze([id])]),
]);

// 已装升级在快照里每条固定代表 1 件（与 collectOwned / countInventory 同口径）。
const UPGRADE_COLLECTION_ID = INVENTORY_COLLECTIONS.INSTALLED_UPGRADES;
// 紫卡来源顺序＝未装升级在前、已装升级在后（与旧装配顺序一致，卡片行序不变）。
const RIVEN_SOURCE_COLLECTION_IDS = Object.freeze([INVENTORY_COLLECTIONS.RAW_UPGRADES, INVENTORY_COLLECTIONS.INSTALLED_UPGRADES]);

// 供合同测试核对「语义集合 ↔ 原始组名」映射完整性的只读视图。
export const ACCOUNT_VIEW_COLLECTION_SOURCES = Object.freeze(Object.fromEntries(COLLECTION_SOURCES));

// 同步标记：asOf 推导依据本身（account-snapshot 读它，视图只透传导出的时间）。
const SYNC_MARKER_SOURCE = 'LastInventorySync';

// —— 语义标量 / 周常 / 集团 / 购买记录 的字段映射（原始字段名只在这里出现） ——

const ITEM_ENTRY_SOURCES = Object.freeze({
  itemType: 'ItemType',
  itemCount: 'ItemCount',
  fingerprint: 'UpgradeFingerprint',
});

const ACCOUNT_SCALAR_SOURCES = Object.freeze({
  masteryRank: 'PlayerLevel',
  tradesRemaining: 'TradesRemaining',
  credits: 'RegularCredits',
  endo: 'FusionPoints',
  platinumPurchased: 'PremiumCredits',
  platinumFree: 'PremiumCreditsFree',
});

const GLYPH_SOURCE = 'ActiveAvatarImageType';
const DUCAT_SOURCE_ITEM = '/Lotus/Types/Items/MiscItems/PrimeBucks';

const WEEKLY_SOURCES = Object.freeze({
  circuit: 'EndlessXP',
  descent: 'DescentRewards',
  netracellCount: 'EntratiVaultCountLastPeriod',
  netracellResetAt: 'EntratiVaultCountResetDate',
  challenges: 'ChallengeProgress',
  calendar: 'CalendarProgress',
  archonRewards: 'LastLiteSortieReward',
});

const CIRCUIT_ENTRY_SOURCES = Object.freeze({
  category: 'Category',
  expiry: 'Expiry',
  earned: 'Earn',
  claimed: 'Claim',
  choices: 'Choices',
  pendingRewards: 'PendingRewards',
  requiredTotalXp: 'RequiredTotalXp',
  rewards: 'Rewards',
  storeItem: 'StoreItem',
  itemCount: 'ItemCount',
});

const DESCENT_ENTRY_SOURCES = Object.freeze({
  category: 'Category',
  expiry: 'Expiry',
  claimed: 'FloorClaimed',
  pendingRewards: 'PendingRewards',
  floorCheckpoint: 'FloorCheckpoint',
});

const CHALLENGE_ENTRY_SOURCES = Object.freeze({ name: 'Name', progress: 'Progress' });

const CALENDAR_SOURCES = Object.freeze({
  iteration: 'Iteration',
  seasonProgress: 'SeasonProgress',
  yearProgress: 'YearProgress',
  seasonType: 'SeasonType',
  lastCompletedDayIdx: 'LastCompletedDayIdx',
  activatedChallenges: 'ActivatedChallenges',
  yearUpgrades: 'Upgrades',
});

const ARCHON_ENTRY_SOURCES = Object.freeze({ sortieId: 'SortieId' });

const AFFILIATION_SOURCES = Object.freeze({
  list: 'Affiliations',
  tag: 'Tag',
  standing: 'Standing',
  title: 'Title',
  weeklyMissions: 'WeeklyMissions',
  missionWeekCount: 'WeekCount',
  missionCompleted: 'CompletedMission',
});

const VENDOR_PURCHASE_SOURCES = Object.freeze({
  list: 'RecentVendorPurchases',
  vendorType: 'VendorType',
  history: 'PurchaseHistory',
  expiry: 'Expiry',
  itemId: 'ItemId',
  numPurchased: 'NumPurchased',
});

const RIVEN_FINGERPRINT_SOURCES = Object.freeze({
  weaponKey: 'compat',
  polarity: 'pol',
  rerolls: 'rerolls',
  masteryRequirement: 'lvlReq',
  rank: 'lvl',
  buffs: 'buffs',
  curses: 'curses',
  challenge: 'challenge',
  attributeTag: 'Tag',
  attributeValue: 'Value',
  challengeProgress: 'Progress',
  challengeRequired: 'Required',
});

// 紫卡 Mod 路径标记（游戏数据，不是 AlecaFrame 私有名；仍然是「账号语义」的一部分）。
const RIVEN_ITEM_PATH_MARKER = '/Randomized/';

// 语义轨道 id → 快照里的轨道码 / 科研前缀（含持久化样本沿用的 kind 值，保持旧状态可读）。
export const CIRCUIT_TRACKS = Object.freeze({ NORMAL: 'circuit-normal', STEEL: 'circuit-steel' });
export const DESCENT_TRACKS = Object.freeze({ NORMAL: 'descendia-normal', STEEL: 'descendia-steel' });
export const RESEARCH_TRACKS = Object.freeze({ DEEP: 'deep-archimedea', TEMPORAL: 'temporal-archimedea' });

const CIRCUIT_TRACK_CODES = Object.freeze({ [CIRCUIT_TRACKS.NORMAL]: 'EXC_NORMAL', [CIRCUIT_TRACKS.STEEL]: 'EXC_HARD' });
const DESCENT_TRACK_CODES = Object.freeze({ [DESCENT_TRACKS.NORMAL]: 'DM_COH_NORMAL', [DESCENT_TRACKS.STEEL]: 'DM_COH_HARD' });

// 科研轨道 → 快照字段前缀 + 周常状态文件里沿用的样本 kind（不改旧账本格式）。
const RESEARCH_TRACK_SOURCES = Object.freeze({
  [RESEARCH_TRACKS.DEEP]: {
    score: 'EntratiLabConquestCacheScoreMission',
    unlocked: 'EntratiLabConquestUnlocked',
    tokens: null,
    sampleKind: 'EntratiLab',
  },
  [RESEARCH_TRACKS.TEMPORAL]: {
    score: 'EchoesHexConquestCacheScoreMission',
    unlocked: 'EchoesHexConquestUnlocked',
    tokens: 'EchoesHexConquestBonusTokensGiven',
    sampleKind: 'EchoesHex',
  },
});

// 旧调用方与旧状态文件沿用的科研样本 kind → 语义轨道 id（持久化格式保持不变）。
const RESEARCH_SAMPLE_KIND_TO_TRACK = Object.freeze(Object.fromEntries(
  Object.entries(RESEARCH_TRACK_SOURCES).map(([track, sources]) => [sources.sampleKind, track]),
));

/**
 * 兼容旧命名：既接受语义轨道 id，也接受历史样本 kind（EntratiLab / EchoesHex）。
 * @param {unknown} value
 */
export function resolveResearchTrack(value) {
  if (typeof value !== 'string') return null;
  if (RESEARCH_TRACK_SOURCES[value]) return value;
  return RESEARCH_SAMPLE_KIND_TO_TRACK[value] || null;
}

/** 语义轨道 id → 周常状态文件里沿用的样本 kind（未映射返回 null）。 */
export function researchSampleKind(track) {
  return RESEARCH_TRACK_SOURCES[resolveResearchTrack(track)]?.sampleKind || null;
}

// 集团 tag（游戏标识）→ 今日剩余声望字段。
const DAILY_STANDING_SOURCES = Object.freeze({
  CetusSyndicate: 'DailyAffiliationCetus',
  SolarisSyndicate: 'DailyAffiliationSolaris',
  EntratiSyndicate: 'DailyAffiliationEntrati',
  ZarimanSyndicate: 'DailyAffiliationZariman',
  EntratiLabSyndicate: 'DailyAffiliationCavia',
  HexSyndicate: 'DailyAffiliationHex',
});

// —— 输入兼容与基础取值 ——

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(target, key) {
  return isPlainObject(target) && Object.prototype.hasOwnProperty.call(target, key);
}

function numberOf(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberOrNullFrom(value, key) {
  return hasOwn(value, key) ? numberOrNull(value[key]) : null;
}

function textOrNull(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function textOrNullFrom(value, key) {
  return hasOwn(value, key) ? textOrNull(value[key]) : null;
}

function listOf(value) {
  return Array.isArray(value) ? value : [];
}

// 周常侧时间口径（与 weekly.msOf 既有实现一致）：$date.$numberLong → $date → 原值；
// 纯数字串按 epoch 毫秒解析，其余交给 Date.parse。
function epochMsOf(value) {
  const raw = value?.$date?.$numberLong ?? value?.$date ?? value;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : Number.NaN;
  if (/^-?\d+$/u.test(String(raw ?? ''))) {
    const numeric = Number(raw);
    return Number.isFinite(numeric) ? numeric : Number.NaN;
  }
  const parsed = Date.parse(String(raw ?? ''));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

// 商店购买记录侧时间口径（与 vendor-shop.msOf 既有实现一致）：只认数字与
// $date.$numberLong，其余交给 Date.parse；两个口径都保留，避免悄悄改变既有判据。
function purchaseMsOf(value) {
  if (typeof value === 'number') return value;
  const long = Number(value?.$date?.$numberLong);
  if (Number.isFinite(long)) return long;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function oidOf(value) {
  return isPlainObject(value) && typeof value.$oid === 'string' ? value.$oid : null;
}

function parseFingerprint(raw) {
  if (typeof raw !== 'string' || !raw) return { parsed: null, ok: true };
  try {
    const value = JSON.parse(raw);
    return { parsed: isPlainObject(value) ? value : null, ok: true };
  } catch {
    return { parsed: null, ok: false };
  }
}

// 旧式合成输入：测试与既有调用方直接传的库存对象。只在确认是快照/包装时下钻一层；
// 显式带 inventory 键的对象一律按包装处理（值为非对象 = 没有库存），不再当库存本体。
function resolveInput(input) {
  if (!isPlainObject(input)) return { inventory: null, meta: null };
  if (input.schemaVersion === ACCOUNT_SNAPSHOT_SCHEMA_VERSION && input.source === ACCOUNT_SNAPSHOT_SOURCE) {
    return { inventory: isPlainObject(input.inventory) ? input.inventory : null, meta: input };
  }
  if (Object.prototype.hasOwnProperty.call(input, 'inventory')) {
    return { inventory: isPlainObject(input.inventory) ? input.inventory : null, meta: input };
  }
  return { inventory: input, meta: null };
}

function snapshotMetaOf(meta) {
  if (!meta) {
    return {
      schemaVersion: null, source: null, envelopeShape: null, asOf: null, asOfBasis: null,
      asOfNote: null, confidence: 'unavailable', syncedAt: null, fileMtime: null,
      fileMtimeMs: null, alecaDir: null, coverage: null, retainedFieldCount: 0, hasMetadata: false,
    };
  }
  const asOf = typeof meta.asOf === 'string' ? meta.asOf : null;
  const syncedAt = typeof meta.syncedAt === 'string' ? meta.syncedAt : asOf;
  return {
    schemaVersion: Number.isInteger(meta.schemaVersion) ? meta.schemaVersion : null,
    source: typeof meta.source === 'string' ? meta.source : null,
    envelopeShape: typeof meta.envelopeShape === 'string' ? meta.envelopeShape : null,
    asOf,
    asOfBasis: typeof meta.asOfBasis === 'string' ? meta.asOfBasis : null,
    asOfNote: typeof meta.asOfNote === 'string' ? meta.asOfNote : null,
    confidence: typeof meta.confidence === 'string' ? meta.confidence : 'unavailable',
    syncedAt,
    fileMtime: typeof meta.fileMtime === 'string' ? meta.fileMtime : null,
    fileMtimeMs: Number.isFinite(Number(meta.fileMtimeMs)) ? Number(meta.fileMtimeMs) : null,
    alecaDir: typeof meta.alecaDir === 'string' ? meta.alecaDir : null,
    coverage: isPlainObject(meta.coverage) ? { ...meta.coverage } : null,
    retainedFieldCount: Number.isInteger(meta.fieldCount) ? meta.fieldCount : 0,
    // 只有输入真的带了账号元数据（快照版本/来源/同步时间）才算有元数据，
    // 空包装对象不能被当成「可信来源」。
    hasMetadata: meta.schemaVersion != null || meta.source != null || meta.syncedAt != null || meta.asOf != null,
  };
}

// —— 库存行重建 ——

// 每条库存行：{ itemType, quantity, rank, collection, fingerprint, fingerprintParsed }
//   quantity = 源条目声明的件数；null 表示「没有声明数量」（消费方自行决定按 1 件还是 0 计）。
//   已装升级每条固定代表 1 件，因此 quantity 恒为 null、rank 取指纹等级。
function buildEntryRow(entry, collection) {
  if (!isPlainObject(entry)) return null;
  const itemType = textOrNullFrom(entry, ITEM_ENTRY_SOURCES.itemType);
  if (!itemType) return null;
  const rawCount = entry[ITEM_ENTRY_SOURCES.itemCount];
  const isUpgrade = collection === UPGRADE_COLLECTION_ID;
  const fingerprint = isUpgrade ? parseFingerprint(entry[ITEM_ENTRY_SOURCES.fingerprint]) : null;
  const row = {
    itemType,
    quantity: isUpgrade || rawCount == null ? null : numberOrNull(rawCount) ?? 0,
    rank: isUpgrade ? numberOf(fingerprint.parsed?.[RIVEN_FINGERPRINT_SOURCES.rank]) : null,
    collection,
  };
  if (isUpgrade) {
    row.fingerprint = fingerprint.parsed ? { ...fingerprint.parsed } : null;
    row.fingerprintParsed = fingerprint.ok;
  }
  return row;
}

function buildCollectionRows(inventory, collection) {
  const raw = inventory?.[COLLECTION_SOURCE_BY_ID.get(collection)];
  if (!Array.isArray(raw)) return Object.freeze([]);
  const rows = [];
  for (const entry of raw) {
    const row = buildEntryRow(entry, collection);
    if (row) rows.push(Object.freeze(row));
  }
  return Object.freeze(rows);
}

// —— 语义命名空间构建 ——

function buildAccountNamespace(inventory, meta) {
  const scalar = (key) => numberOf(inventory?.[ACCOUNT_SCALAR_SOURCES[key]]);
  const platinumPurchased = scalar('platinumPurchased');
  const platinumFree = scalar('platinumFree');
  // 杜卡德余额：杂项集合里的杜卡德物品数量（无记录 = 0）。
  const ducatRow = listOf(inventory?.[COLLECTION_SOURCE_BY_ID.get(INVENTORY_COLLECTIONS.RESOURCES)])
    .find((entry) => isPlainObject(entry) && entry[ITEM_ENTRY_SOURCES.itemType] === DUCAT_SOURCE_ITEM);
  return Object.freeze({
    masteryRank: scalar('masteryRank'),
    tradesRemaining: scalar('tradesRemaining'),
    credits: scalar('credits'),
    endo: scalar('endo'),
    platinum: Object.freeze({
      purchased: platinumPurchased,
      free: platinumFree,
      total: platinumPurchased + platinumFree,
    }),
    ducatBalance: ducatRow == null ? 0 : (numberOrNull(ducatRow[ITEM_ENTRY_SOURCES.itemCount]) ?? 0),
    glyphImagePath: textOrNullFrom(inventory ?? {}, GLYPH_SOURCE),
    syncedAt: meta.syncedAt,
    asOf: meta.asOf,
    confidence: meta.confidence,
  });
}

function buildInventoryNamespace(inventory, meta) {
  const cache = new Map();
  const collectionsOf = (scope) => {
    if (Array.isArray(scope)) return scope;
    return SCOPE_COLLECTIONS.get(scope === undefined ? INVENTORY_SCOPES.ALL : scope) || null;
  };
  const rowsOf = (collection) => {
    if (!cache.has(collection)) cache.set(collection, buildCollectionRows(inventory, collection));
    return cache.get(collection);
  };
  const rowsForScope = (scope) => {
    const collections = collectionsOf(scope);
    if (!collections) return Object.freeze([]);
    if (collections.length === 1) return rowsOf(collections[0]);
    return Object.freeze(collections.flatMap((collection) => [...rowsOf(collection)]));
  };
  return Object.freeze({
    // 语义行：{ itemType, quantity|null, rank|null, collection }
    rows: (scope) => rowsForScope(scope),
    // 持有路径集合（存在性判定）
    itemTypes: (scope) => new Set(rowsForScope(scope).map((row) => row.itemType)),
    has: (itemType, scope) => rowsForScope(scope).some((row) => row.itemType === itemType),
    // 计数口径：未声明数量的条目按 1 件计（掉落监测 / 估值既有语义）。
    quantityTotals: (scope) => {
      const totals = new Map();
      for (const row of rowsForScope(scope)) totals.set(row.itemType, (totals.get(row.itemType) || 0) + (row.quantity ?? 1));
      return totals;
    },
    // 合计持有数量（未声明数量按 1 件计）；accountSummary 的商店货币余额口径。
    quantityOf: (itemType, scope) => {
      let total = 0;
      for (const row of rowsForScope(scope)) if (row.itemType === itemType) total += row.quantity ?? 1;
      return total;
    },
    // 指定集合内首个条目的已声明数量（无记录 = 0）；杜卡德/内融类余额的旧口径。
    amountOf: (itemType, collection) => {
      const rows = rowsOf(collection === undefined ? INVENTORY_COLLECTIONS.RESOURCES : collection);
      const row = rows.find((item) => item.itemType === itemType);
      return row?.quantity ?? 0;
    },
    // 该作用域下源快照是否提供了库存数组（区分「空库存」与「快照没有这一栏」）。
    collectionKnown: (scope) => {
      const collections = collectionsOf(scope);
      if (!collections) return false;
      return collections.some((collection) => Array.isArray(inventory?.[COLLECTION_SOURCE_BY_ID.get(collection)]));
    },
    hasInventory: Boolean(inventory),
    fieldCoverage: meta.coverage,
    retainedFieldCount: meta.retainedFieldCount,
  });
}

function buildEquipmentNamespace(inventoryApi) {
  return Object.freeze({
    known: () => inventoryApi.collectionKnown(INVENTORY_SCOPES.EQUIPMENT),
    itemTypes: () => inventoryApi.itemTypes(INVENTORY_SCOPES.EQUIPMENT),
    has: (itemType) => inventoryApi.itemTypes(INVENTORY_SCOPES.EQUIPMENT).has(itemType),
  });
}

// —— 紫卡：指纹 → 语义记录（公开纯函数兼容入口） ——

function isRivenRecord(value) {
  return hasOwn(value, 'weaponKey') && hasOwn(value, 'attributes');
}

function normalizeAttributeList(raw) {
  if (!Array.isArray(raw)) return Object.freeze([]);
  return Object.freeze(raw.map((entry) => {
    const attribute = {};
    if (hasOwn(entry, RIVEN_FINGERPRINT_SOURCES.attributeTag)) {
      attribute.tag = entry[RIVEN_FINGERPRINT_SOURCES.attributeTag];
    }
    if (hasOwn(entry, RIVEN_FINGERPRINT_SOURCES.attributeValue)) {
      // 保留源值：消费方用 /0x40000000 还原 roll，缺失必须仍是 NaN 而不是 0。
      attribute.value = entry[RIVEN_FINGERPRINT_SOURCES.attributeValue];
    }
    return Object.freeze(attribute);
  }));
}

function normalizeChallenge(raw) {
  if (!isPlainObject(raw)) return null;
  return Object.freeze({
    progress: numberOf(raw[RIVEN_FINGERPRINT_SOURCES.challengeProgress]),
    required: numberOf(raw[RIVEN_FINGERPRINT_SOURCES.challengeRequired]),
  });
}

/**
 * 把紫卡指纹统一成语义记录（幂等）。
 * 兼容入参：AlecaFrame UpgradeFingerprint 对象、本函数产出的语义记录、或 undefined/null。
 * @param {unknown} value
 */
export function normalizeRivenRecord(value) {
  if (isRivenRecord(value)) return value;
  const fp = isPlainObject(value) ? value : {};
  return Object.freeze({
    itemType: null,
    weaponKey: textOrNull(fp[RIVEN_FINGERPRINT_SOURCES.weaponKey]),
    polarity: textOrNull(fp[RIVEN_FINGERPRINT_SOURCES.polarity]),
    rerolls: numberOf(fp[RIVEN_FINGERPRINT_SOURCES.rerolls]),
    masteryRequirement: numberOrNull(fp[RIVEN_FINGERPRINT_SOURCES.masteryRequirement]),
    rank: numberOrNull(fp[RIVEN_FINGERPRINT_SOURCES.rank]),
    attributes: Object.freeze({
      buffs: normalizeAttributeList(fp[RIVEN_FINGERPRINT_SOURCES.buffs]),
      curses: normalizeAttributeList(fp[RIVEN_FINGERPRINT_SOURCES.curses]),
    }),
    challenge: normalizeChallenge(fp[RIVEN_FINGERPRINT_SOURCES.challenge]),
    isVeiled: false,
  });
}

function buildRivensNamespace(inventoryApi, meta) {
  const rivenRows = () => inventoryApi.rows(RIVEN_SOURCE_COLLECTION_IDS);
  return Object.freeze({
    // 已开封紫卡：指纹可解析且带武器键；逐字段语义化，业务不再接触指纹键名。
    installed: () => rivenRows()
      .filter((row) => row.collection === UPGRADE_COLLECTION_ID && row.fingerprintParsed && row.fingerprint && row.fingerprint[RIVEN_FINGERPRINT_SOURCES.weaponKey])
      .map((row) => Object.freeze({
        ...normalizeRivenRecord(row.fingerprint),
        itemType: row.itemType,
        rank: numberOf(row.fingerprint[RIVEN_FINGERPRINT_SOURCES.rank]),
        isVeiled: false,
      })),
    // 未开封紫卡：未装升级里的紫卡条目，以及已装但只有开封挑战、没有武器键的条目。
    veiled: () => rivenRows()
      .filter((row) => row.itemType.includes(RIVEN_ITEM_PATH_MARKER))
      .map((row) => {
        if (row.collection === INVENTORY_COLLECTIONS.RAW_UPGRADES) {
          return { itemType: row.itemType, quantity: row.quantity ?? 1, challenge: null, isVeiled: true };
        }
        if (!row.fingerprintParsed || !row.fingerprint) return null;
        const record = normalizeRivenRecord(row.fingerprint);
        if (record.weaponKey || !record.challenge) return null;
        return { itemType: row.itemType, quantity: 1, challenge: record.challenge, isVeiled: true };
      })
      .filter(Boolean)
      .map((row) => Object.freeze(row)),
    asOf: meta.asOf,
  });
}

function buildStandingNamespace(inventory) {
  const rawAffiliations = inventory?.[AFFILIATION_SOURCES.list];
  const affiliations = listOf(rawAffiliations)
    .filter((entry) => isPlainObject(entry) && textOrNullFrom(entry, AFFILIATION_SOURCES.tag))
    .map((entry) => Object.freeze({
      tag: textOrNullFrom(entry, AFFILIATION_SOURCES.tag),
      standing: numberOf(entry[AFFILIATION_SOURCES.standing]),
      title: numberOf(entry[AFFILIATION_SOURCES.title]),
      weeklyMissions: Object.freeze(listOf(entry[AFFILIATION_SOURCES.weeklyMissions])
        .filter((mission) => isPlainObject(mission))
        .map((mission) => Object.freeze({
          weekCount: numberOrNullFrom(mission, AFFILIATION_SOURCES.missionWeekCount),
          completed: mission[AFFILIATION_SOURCES.missionCompleted] === true,
        }))),
    }));
  const byTag = new Map(affiliations.map((entry) => [entry.tag, entry]));
  return Object.freeze({
    affiliations: () => affiliations,
    affiliation: (tag) => byTag.get(tag) || null,
    // 今日剩余声望（无该区字段 = null，卡片据此隐藏余量列而不是显示 0）。
    dailyRemaining: (tag) => {
      const source = DAILY_STANDING_SOURCES[tag];
      if (!source) return null;
      const value = Number(inventory?.[source]);
      return Number.isFinite(value) ? value : null;
    },
    // 指定周序号的集团周任务；没有该周记录返回 null。
    weeklyMission: (tag, weekCount) => byTag.get(tag)?.weeklyMissions.find((mission) => mission.weekCount === weekCount) || null,
  });
}

function buildWeeklyNamespace(inventory, meta) {
  const circuitEntries = listOf(inventory?.[WEEKLY_SOURCES.circuit]).filter(isPlainObject);
  const descentEntries = listOf(inventory?.[WEEKLY_SOURCES.descent]).filter(isPlainObject);
  const challengeEntries = listOf(inventory?.[WEEKLY_SOURCES.challenges]).filter(isPlainObject);
  const calendarRaw = inventory?.[WEEKLY_SOURCES.calendar];
  const calendarSeason = isPlainObject(calendarRaw) ? calendarRaw[CALENDAR_SOURCES.seasonProgress] : null;
  const calendarYear = isPlainObject(calendarRaw) ? calendarRaw[CALENDAR_SOURCES.yearProgress] : null;
  const archonEntries = listOf(inventory?.[WEEKLY_SOURCES.archonRewards]).filter(isPlainObject);

  const circuitOf = (track, now) => {
    const code = CIRCUIT_TRACK_CODES[track];
    if (!code) return null;
    const entry = circuitEntries.find((item) => item[CIRCUIT_ENTRY_SOURCES.category] === code);
    if (!entry) return null;
    const expiryMs = epochMsOf(entry[CIRCUIT_ENTRY_SOURCES.expiry]);
    const pendingRewards = listOf(entry[CIRCUIT_ENTRY_SOURCES.pendingRewards]).filter(isPlainObject).map((node) => Object.freeze({
      requiredTotalXp: numberOf(node[CIRCUIT_ENTRY_SOURCES.requiredTotalXp]),
      rewards: Object.freeze(listOf(node[CIRCUIT_ENTRY_SOURCES.rewards]).filter(isPlainObject).map((reward) => Object.freeze({
        storeItem: textOrNullFrom(reward, CIRCUIT_ENTRY_SOURCES.storeItem),
        count: numberOf(reward[CIRCUIT_ENTRY_SOURCES.itemCount]) || 1,
      }))),
    }));
    const goal = pendingRewards.reduce((max, node) => Math.max(max, node.requiredTotalXp), 0);
    return Object.freeze({
      track,
      earned: numberOf(entry[CIRCUIT_ENTRY_SOURCES.earned]),
      claimed: numberOf(entry[CIRCUIT_ENTRY_SOURCES.claimed]),
      goal,
      expiryMs,
      expired: !(expiryMs > Number(now)),
      choices: Object.freeze(listOf(entry[CIRCUIT_ENTRY_SOURCES.choices]).map(String)),
      pendingRewards: Object.freeze(pendingRewards),
    });
  };

  const descentOf = (track, now) => {
    const code = DESCENT_TRACK_CODES[track];
    if (!code) return null;
    const entry = descentEntries.find((item) => item[DESCENT_ENTRY_SOURCES.category] === code);
    if (!entry) return null;
    const expiryMs = epochMsOf(entry[DESCENT_ENTRY_SOURCES.expiry]);
    const goal = listOf(entry[DESCENT_ENTRY_SOURCES.pendingRewards])
      .reduce((max, node) => Math.max(max, numberOf(node?.[DESCENT_ENTRY_SOURCES.floorCheckpoint])), 0);
    return Object.freeze({
      track,
      claimed: numberOf(entry[DESCENT_ENTRY_SOURCES.claimed]),
      goal,
      expiryMs,
      expired: !(expiryMs > Number(now)),
    });
  };

  return Object.freeze({
    circuit: circuitOf,
    descent: descentOf,
    // 衰退室：本周搜索脉冲次数与重置时刻（重置在未来才代表本周计数）。
    netracell: () => Object.freeze({
      count: numberOf(inventory?.[WEEKLY_SOURCES.netracellCount]),
      resetAtMs: epochMsOf(inventory?.[WEEKLY_SOURCES.netracellResetAt]),
    }),
    // 午夜电波进度：挑战键（小写）→ 进度值；键与旧实现完全一致。
    challengeProgress: () => new Map(challengeEntries.map((entry) => [
      String(entry[CHALLENGE_ENTRY_SOURCES.name] || '').toLowerCase(),
      numberOf(entry[CHALLENGE_ENTRY_SOURCES.progress]),
    ])),
    // 执刑官猎杀最近奖励：记录条数 + 首条 SortieId（与本周 archonHunt.id 对账用）。
    archonRewards: () => Object.freeze({
      count: archonEntries.length,
      firstSortieId: oidOf(archonEntries[0]?.[ARCHON_ENTRY_SOURCES.sortieId]),
    }),
    // 1999 日历：赛季类型 / 轮次 / 最后完成节点 / 已激活挑战 / 全年增益。
    calendar: () => {
      if (!isPlainObject(calendarSeason)) return null;
      return Object.freeze({
        seasonType: textOrNullFrom(calendarSeason, CALENDAR_SOURCES.seasonType),
        lastCompletedDayIdx: numberOrNullFrom(calendarSeason, CALENDAR_SOURCES.lastCompletedDayIdx),
        activatedChallenges: Object.freeze(listOf(calendarSeason[CALENDAR_SOURCES.activatedChallenges]).map(String)),
        iteration: isPlainObject(calendarRaw) ? numberOrNullFrom(calendarRaw, CALENDAR_SOURCES.iteration) : null,
        yearUpgrades: Object.freeze(listOf(calendarYear?.[CALENDAR_SOURCES.yearUpgrades]).map(String)),
      });
    },
    // 科研：通关分 / 是否解锁 / HEX 奖励令牌（其余轨道 tokens 恒为 null）。
    // 兼容旧命名：既接受语义轨道 id，也接受历史样本 kind（EntratiLab / EchoesHex）。
    research: (track) => {
      const sources = RESEARCH_TRACK_SOURCES[resolveResearchTrack(track)];
      if (!sources) return null;
      return Object.freeze({
        track: resolveResearchTrack(track),
        sampleKind: sources.sampleKind,
        score: Math.max(0, numberOf(inventory?.[sources.score])),
        unlocked: numberOf(inventory?.[sources.unlocked]) > 0,
        tokens: sources.tokens ? Object.freeze(listOf(inventory?.[sources.tokens]).map(numberOf)) : null,
      });
    },
    syncedAt: meta.syncedAt,
    asOf: meta.asOf,
  });
}

function buildVendorPurchasesNamespace(inventory) {
  const raw = listOf(inventory?.[VENDOR_PURCHASE_SOURCES.list]);
  const purchasesOf = (vendorType) => {
    const vendor = raw.find((entry) => isPlainObject(entry) && String(entry[VENDOR_PURCHASE_SOURCES.vendorType]) === vendorType);
    return Object.freeze(listOf(vendor?.[VENDOR_PURCHASE_SOURCES.history])
      .filter(isPlainObject)
      .map((entry) => ({
        expiryMs: purchaseMsOf(entry[VENDOR_PURCHASE_SOURCES.expiry]),
        // Mongo ObjectId 前 4 字节 = 记录创建时间；服务端会把上周购买的 Expiry 推进到新周期，
        // 因此 expiry 相等不足以证明「本周购买」，创建时刻是第二证据。
        createdMs: /^[0-9a-f]{24}$/iu.test(String(entry[VENDOR_PURCHASE_SOURCES.itemId] || ''))
          ? Number.parseInt(String(entry[VENDOR_PURCHASE_SOURCES.itemId]).slice(0, 8), 16) * 1000
          : Number.NaN,
        num: numberOf(entry[VENDOR_PURCHASE_SOURCES.numPurchased]) || 1,
        itemId: String(entry[VENDOR_PURCHASE_SOURCES.itemId] || ''),
      }))
      .filter((entry) => entry.itemId));
  };
  return Object.freeze({
    of: purchasesOf,
    vendors: () => Object.freeze([...new Set(raw.filter(isPlainObject)
      .map((entry) => textOrNullFrom(entry, VENDOR_PURCHASE_SOURCES.vendorType))
      .filter(Boolean))]),
  });
}

/**
 * 把 AccountSnapshot v1 / 旧式包装 / 合成库存对象统一成语义账号视图。
 * 已经是视图时原样返回（幂等）。纯函数，不产生任何 IO。
 * @param {unknown} input
 */
export function buildAccountView(input) {
  if (isAccountView(input)) return input;
  const { inventory, meta: metaInput } = resolveInput(input);
  const meta = snapshotMetaOf(metaInput);
  const inventoryApi = buildInventoryNamespace(inventory, meta);
  return Object.freeze({
    schemaVersion: ACCOUNT_VIEW_SCHEMA_VERSION,
    source: ACCOUNT_VIEW_SOURCE,
    namespaces: ACCOUNT_VIEW_NAMESPACES,
    selectors: ACCOUNT_VIEW_SELECTORS,
    snapshot: Object.freeze(meta),
    hasInventory: Boolean(inventory),
    syncedAt: meta.syncedAt,
    asOf: meta.asOf,
    asOfBasis: meta.asOfBasis,
    confidence: meta.confidence,
    alecaDir: meta.alecaDir,
    fileMtimeMs: meta.fileMtimeMs,
    account: buildAccountNamespace(inventory, meta),
    inventory: inventoryApi,
    equipment: buildEquipmentNamespace(inventoryApi),
    rivens: buildRivensNamespace(inventoryApi, meta),
    standing: buildStandingNamespace(inventory),
    weekly: buildWeeklyNamespace(inventory, meta),
    vendorPurchases: buildVendorPurchasesNamespace(inventory),
  });
}

export function isAccountView(value) {
  return isPlainObject(value)
    && value.schemaVersion === ACCOUNT_VIEW_SCHEMA_VERSION
    && value.source === ACCOUNT_VIEW_SOURCE;
}

export function isAccountSnapshot(value) {
  return isPlainObject(value)
    && value.schemaVersion === ACCOUNT_SNAPSHOT_SCHEMA_VERSION
    && value.source === ACCOUNT_SNAPSHOT_SOURCE;
}

// —— 机器可读的字段映射清单 ——
// 合同测试据此证明「AccountSnapshot 白名单 100% 有语义出口，且业务模块不再自己认识原始字段名」。
export const ACCOUNT_VIEW_FIELD_MAP = Object.freeze({
  collections: ACCOUNT_VIEW_COLLECTION_SOURCES,
  accountScalars: ACCOUNT_SCALAR_SOURCES,
  glyph: GLYPH_SOURCE,
  weekly: WEEKLY_SOURCES,
  circuitEntry: CIRCUIT_ENTRY_SOURCES,
  descentEntry: DESCENT_ENTRY_SOURCES,
  challengeEntry: CHALLENGE_ENTRY_SOURCES,
  calendar: CALENDAR_SOURCES,
  archonEntry: ARCHON_ENTRY_SOURCES,
  affiliations: AFFILIATION_SOURCES,
  dailyStanding: DAILY_STANDING_SOURCES,
  vendorPurchases: VENDOR_PURCHASE_SOURCES,
  research: RESEARCH_TRACK_SOURCES,
  rivenFingerprint: RIVEN_FINGERPRINT_SOURCES,
  syncMarker: SYNC_MARKER_SOURCE,
});

// 边界读取的全部账号快照顶层字段（必须与 account-snapshot 白名单完全一致）。
export const ACCOUNT_VIEW_RAW_TOP_LEVEL_FIELDS = Object.freeze([...new Set([
  ...Object.values(ACCOUNT_VIEW_COLLECTION_SOURCES),
  ...Object.values(ACCOUNT_SCALAR_SOURCES),
  GLYPH_SOURCE,
  ...Object.values(WEEKLY_SOURCES),
  AFFILIATION_SOURCES.list,
  ...Object.values(DAILY_STANDING_SOURCES),
  ...Object.values(RESEARCH_TRACK_SOURCES).flatMap((sources) => [sources.score, sources.unlocked, sources.tokens].filter(Boolean)),
  VENDOR_PURCHASE_SOURCES.list,
  SYNC_MARKER_SOURCE,
])]);

// —— 构建期合同：语义映射必须自洽，禁止出现「有作用域但没有集合」或「有集合但没有源」——
for (const [scope, collections] of SCOPE_COLLECTIONS) {
  if (!collections.length) throw new Error(`account view scope has no collections: ${scope}`);
  for (const collection of collections) {
    if (!COLLECTION_SOURCE_BY_ID.has(collection)) {
      throw new Error(`account view scope ${scope} references unknown collection: ${collection}`);
    }
  }
}
for (const [id, source] of COLLECTION_SOURCES) {
  if (typeof source !== 'string' || !source) throw new Error(`account view collection source missing: ${id}`);
}
for (const track of Object.values(RESEARCH_TRACKS)) {
  if (!RESEARCH_TRACK_SOURCES[track]) throw new Error(`account view research track unmapped: ${track}`);
}
