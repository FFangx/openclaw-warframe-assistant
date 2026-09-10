import assert from 'node:assert/strict';
import test from 'node:test';

import { ACCOUNT_SNAPSHOT_ALLOWLIST, ACCOUNT_SNAPSHOT_SCHEMA_VERSION, adaptAccountSnapshot } from './account-snapshot.mjs';
import {
  ACCOUNT_VIEW_FIELD_MAP, ACCOUNT_VIEW_NAMESPACES, ACCOUNT_VIEW_RAW_TOP_LEVEL_FIELDS,
  ACCOUNT_VIEW_SCHEMA_VERSION, ACCOUNT_VIEW_SELECTORS, ACCOUNT_VIEW_SOURCE, CIRCUIT_TRACKS,
  DESCENT_TRACKS, INVENTORY_COLLECTIONS, INVENTORY_SCOPES, RESEARCH_TRACKS,
  buildAccountView, isAccountSnapshot, isAccountView, normalizeRivenRecord,
  researchSampleKind, resolveResearchTrack,
} from './account-view.mjs';

// R15 第四片合同（全部为合成数据；不读真实 lastData.dat/deltas.dat、不联网、不落盘）：
//   1. 视图版本/命名空间/选择器形状稳定
//   2. 语义集合 ↔ 原始组名映射完整，白名单 100% 有语义出口
//   3. 视图不引用原快照对象，也不泄露原始字段名或敏感 sentinel
//   4. 真实 AccountSnapshot、旧 { inventory } 包装、合成库存对象三种输入产出等价视图
//   5. 迁移后的业务纯函数在「原始库存 vs 适配后快照」下输出一致

const NOW = Date.parse('2026-09-10T12:00:00.000Z');
const SYNC_OID = '6aa29bc00000000000000000'; // 前 8 位 = 2026-09-10T12:00:00Z
const bsonDate = (ms) => ({ $date: { $numberLong: String(ms) } });
const expiry = bsonDate(NOW + 3 * 86_400_000);
const weekCount = Math.floor((NOW - Date.UTC(2014, 1, 10)) / 604_800_000);
const SENTINEL = 'SENTINEL-DO-NOT-LEAK';
const VENDOR_ITEM_ID = '68c1f00000000000000000ab';

const ITEM_A = '/Lotus/Types/Items/MiscItems/ItemA';
const ITEM_B = '/Lotus/Types/Items/MiscItems/ItemB';
const ITEM_C = '/Lotus/Types/Items/MiscItems/ItemC';
const UPGRADE_MOD = '/Lotus/Upgrades/Mods/Rifle/TestMod';
const DUCAT_ITEM = '/Lotus/Types/Items/MiscItems/PrimeBucks';
const RIVEN_ITEM = '/Lotus/Types/Riven/Weapons/Randomized/TestRiven';
const RIVEN_WEAPON = '/Lotus/Weapons/Tenno/LongGuns/TestRifle';
const WARFRAME_A = '/Lotus/Powersuits/Wukong/WukongPrime';
const RAW_UPGRADE_MOD = '/Lotus/Upgrades/Mods/Raw/RawMod';

// 合成敏感数据：适配前的信封里存在，适配后必须不存在，视图也不得重新引入。
// 注意不占用同步标记自己的 $oid/oid 键（那是白名单允许的同步依据），只加无关身份键。
function withJunk(entry) {
  return { ...entry, AccountId: SENTINEL, DeviceId: SENTINEL, secret: SENTINEL };
}

function syntheticRawInventory() {
  return {
    LastInventorySync: withJunk({ $oid: SYNC_OID }),
    // 第三条没有 ItemCount：掉落计数按 1 件计，余额口径按 0 计；杜卡德只在杂项集合里
    MiscItems: [
      withJunk({ ItemType: ITEM_A, ItemCount: 3 }),
      withJunk({ ItemType: ITEM_B, ItemCount: 0 }),
      withJunk({ ItemType: ITEM_C }),
      withJunk({ ItemType: DUCAT_ITEM, ItemCount: 1 }),
    ],
    Recipes: [withJunk({ ItemType: '/Lotus/Types/Recipes/Weapons/GunBarrelBlueprint', ItemCount: 2 })],
    Consumables: [withJunk({ ItemType: '/Lotus/Types/Items/Consumables/Test', ItemCount: 5 })],
    FusionTreasures: [withJunk({ ItemType: '/Lotus/Types/Items/FusionTreasures/FusionTreasure', ItemCount: 3 })],
    RawUpgrades: [withJunk({ ItemType: RAW_UPGRADE_MOD, ItemCount: 5 })],
    Upgrades: [
      withJunk({ ItemType: UPGRADE_MOD, UpgradeFingerprint: JSON.stringify({ lvl: 2 }) }),
      withJunk({ ItemType: UPGRADE_MOD, UpgradeFingerprint: '{"lvl":4}' }),
      withJunk({ ItemType: RIVEN_ITEM, UpgradeFingerprint: JSON.stringify({ compat: RIVEN_WEAPON, pol: 'madurai', rerolls: 3, lvlReq: 8, buffs: [{ Tag: 'dmg', Value: 0 }], curses: [] }) }),
      withJunk({ ItemType: '/Lotus/Types/Riven/Weapons/Randomized/Veiled', UpgradeFingerprint: JSON.stringify({ challenge: { Progress: 2, Required: 10 } }) }),
    ],
    Suits: [withJunk({ ItemType: WARFRAME_A })],
    LongGuns: [withJunk({ ItemType: '/Lotus/Weapons/Tenno/LongGuns/TestRifle' })],
    PlayerLevel: 30,
    TradesRemaining: 7,
    RegularCredits: 1_000_000,
    FusionPoints: 12_345,
    PremiumCredits: 100,
    PremiumCreditsFree: 25,
    ActiveAvatarImageType: '/Lotus/Interface/Icons/Glyphs/TestGlyph.png',
    Affiliations: [
      withJunk({ Tag: 'CetusSyndicate', Standing: 44_000, Title: 5, WeeklyMissions: [withJunk({ WeekCount: weekCount, CompletedMission: false })] }),
      withJunk({ Tag: 'KahlSyndicate', Standing: 12_000, Title: 2, WeeklyMissions: [withJunk({ WeekCount: weekCount, CompletedMission: true })] }),
    ],
    DailyAffiliationCetus: 12_345,
    DailyAffiliationSolaris: 0,
    EntratiVaultCountLastPeriod: 4,
    EntratiVaultCountResetDate: expiry,
    LastLiteSortieReward: [withJunk({ SortieId: { $oid: 'SORTIE-A' }, StoreItem: '/Lotus/x', Manifest: { secret: SENTINEL } })],
    ChallengeProgress: [withJunk({ Name: 'SeasonWeeklyHardCompleteConquest', Progress: 1 })],
    CalendarProgress: withJunk({
      Iteration: 4,
      SeasonProgress: withJunk({ SeasonType: 'CST_WINTER', LastCompletedDayIdx: 1, ActivatedChallenges: ['CalendarChallengeA'] }),
      YearProgress: withJunk({ Upgrades: ['CalendarUpgradeA'] }),
    }),
    EndlessXP: [withJunk({
      Category: 'EXC_NORMAL',
      Expiry: expiry,
      Earn: 100,
      Claim: 20,
      Choices: ['Mesa'],
      PendingRewards: [withJunk({ RequiredTotalXp: 1_000, Rewards: [withJunk({ StoreItem: '/Lotus/StoreItems/Test', ItemCount: 2 })] })],
    })],
    DescentRewards: [withJunk({ Category: 'DM_COH_NORMAL', Expiry: expiry, FloorClaimed: 9, PendingRewards: [withJunk({ FloorCheckpoint: 21 })] })],
    EntratiLabConquestUnlocked: 1,
    EntratiLabConquestCacheScoreMission: 34,
    EchoesHexConquestUnlocked: 1,
    EchoesHexConquestCacheScoreMission: 21,
    EchoesHexConquestBonusTokensGiven: [1, 2],
    RecentVendorPurchases: [withJunk({
      VendorType: 'Teshin',
      PurchaseHistory: [withJunk({ Expiry: expiry, ItemId: VENDOR_ITEM_ID, NumPurchased: 2 })],
    })],
  };
}

const adapt = (raw) => adaptAccountSnapshot(raw, { now: NOW, fileMtime: '2026-09-10T11:00:00.000Z', fileMtimeMs: Date.parse('2026-09-10T11:00:00.000Z') });

// ——————————————————————————————————————————————————————————————
// 1. 版本与形状
// ——————————————————————————————————————————————————————————————

test('视图版本与命名空间：v1 常量、命名空间齐全、选择器清单可调用', () => {
  const view = buildAccountView(syntheticRawInventory());
  assert.equal(ACCOUNT_VIEW_SCHEMA_VERSION, 1);
  assert.equal(ACCOUNT_VIEW_SOURCE, 'account-view');
  assert.equal(view.schemaVersion, 1);
  assert.equal(view.source, 'account-view');
  assert.equal(isAccountView(view), true);
  assert.equal(isAccountSnapshot(view), false);
  assert.deepEqual(view.namespaces, ACCOUNT_VIEW_NAMESPACES);
  assert.deepEqual(view.selectors, ACCOUNT_VIEW_SELECTORS);
  for (const name of ACCOUNT_VIEW_NAMESPACES) {
    assert.equal(typeof view[name], 'object', name);
    assert.equal(Object.isFrozen(view[name]), true, name);
  }
  for (const selector of ACCOUNT_VIEW_SELECTORS) {
    const [namespace, method] = selector.split('.');
    assert.equal(typeof view[namespace][method], 'function', selector);
  }
});

test('视图幂等：已是视图时原样返回，重复包装不改变形状', () => {
  const view = buildAccountView(syntheticRawInventory());
  assert.equal(buildAccountView(view), view);
  assert.equal(buildAccountView(buildAccountView(view)), view);
});

test('视图元数据透传快照的 asOf/可信度，不改写来源语义', () => {
  const raw = syntheticRawInventory();
  const adapted = adapt(raw);
  const view = buildAccountView(adapted);
  assert.equal(view.snapshot.schemaVersion, ACCOUNT_SNAPSHOT_SCHEMA_VERSION);
  assert.equal(view.snapshot.source, 'alecaframe.lastData');
  assert.equal(view.snapshot.asOf, new Date(NOW).toISOString());
  assert.equal(view.snapshot.asOfBasis, 'source-sync-oid');
  assert.equal(view.snapshot.confidence, 'declared');
  assert.equal(view.syncedAt, adapted.syncedAt);
  assert.equal(view.alecaDir, adapted.alecaDir);
  assert.equal(view.fileMtimeMs, adapted.fileMtimeMs);
  // 覆盖计数来自适配器：本夹具的顶层键全部在白名单内，没有未知顶层字段
  assert.equal(view.snapshot.coverage.retainedTopLevelFields, Object.keys(raw).length);
  assert.equal(view.snapshot.coverage.omittedTopLevelFields, 0);
  assert.equal(view.snapshot.retainedFieldCount, view.snapshot.coverage.retainedTopLevelFields);
  // 旧式包装与无元数据输入都不应伪造成可信来源
  assert.equal(buildAccountView({ inventory: syntheticRawInventory() }).snapshot.confidence, 'unavailable');
  assert.equal(buildAccountView(syntheticRawInventory()).snapshot.asOf, null);
});

test('空输入：视图仍然成形，语义选择器返回空结果而不是抛错', () => {
  for (const empty of [null, undefined, { inventory: null }]) {
    const view = buildAccountView(empty);
    assert.equal(view.hasInventory, false);
    assert.equal(view.snapshot.hasMetadata, false);
    assert.equal(view.account.masteryRank, 0);
    assert.equal(view.account.ducatBalance, 0);
    assert.equal(view.account.glyphImagePath, null);
    assert.deepEqual(view.inventory.rows(), []);
    assert.equal(view.inventory.itemTypes().size, 0);
    assert.equal(view.inventory.quantityOf(ITEM_A), 0);
    assert.equal(view.inventory.amountOf(ITEM_A), 0);
    assert.equal(view.inventory.collectionKnown(INVENTORY_SCOPES.RESOURCES), false);
    assert.equal(view.equipment.known(), false);
    assert.deepEqual(view.rivens.installed(), []);
    assert.deepEqual(view.rivens.veiled(), []);
    assert.deepEqual(view.standing.affiliations(), []);
    assert.equal(view.standing.affiliation('CetusSyndicate'), null);
    assert.equal(view.standing.dailyRemaining('CetusSyndicate'), null);
    assert.equal(view.weekly.circuit(CIRCUIT_TRACKS.NORMAL, NOW), null);
    assert.equal(view.weekly.descent(DESCENT_TRACKS.NORMAL, NOW), null);
    assert.equal(Number.isNaN(view.weekly.netracell().resetAtMs), true);
    assert.equal(view.weekly.netracell().count, 0);
    assert.equal(view.weekly.challengeProgress().size, 0);
    assert.deepEqual(view.weekly.archonRewards(), { count: 0, firstSortieId: null });
    assert.equal(view.weekly.calendar(), null);
    assert.equal(view.weekly.research(RESEARCH_TRACKS.DEEP).score, 0);
    assert.deepEqual(view.vendorPurchases.of('Teshin'), []);
    assert.deepEqual(view.vendorPurchases.vendors(), []);
  }
  // 空库存对象（旧合成输入）语义上「有库存但一件没有」：与旧实现一致，选择器全部为空。
  const emptyInventory = buildAccountView({});
  assert.equal(emptyInventory.hasInventory, true);
  assert.equal(emptyInventory.snapshot.hasMetadata, false);
  assert.deepEqual(emptyInventory.inventory.rows(), []);
  assert.equal(emptyInventory.equipment.known(), false);
  assert.deepEqual(emptyInventory.standing.affiliations(), []);
  assert.equal(emptyInventory.weekly.calendar(), null);
});

// ——————————————————————————————————————————————————————————————
// 2. 映射完整性与选择器语义
// ——————————————————————————————————————————————————————————————

test('映射完整：语义集合与白名单一一对应，映射表无空洞', () => {
  const collections = Object.values(ACCOUNT_VIEW_FIELD_MAP.collections);
  assert.equal(collections.length, 25);
  assert.equal(new Set(collections).size, collections.length);
  assert.deepEqual([...ACCOUNT_VIEW_RAW_TOP_LEVEL_FIELDS].sort(), [...ACCOUNT_SNAPSHOT_ALLOWLIST].sort());
  assert.equal(ACCOUNT_VIEW_FIELD_MAP.syncMarker, 'LastInventorySync');
  for (const [semantic, raw] of Object.entries(ACCOUNT_VIEW_FIELD_MAP.collections)) {
    assert.equal(typeof semantic, 'string');
    assert.equal(ACCOUNT_SNAPSHOT_ALLOWLIST.includes(raw), true, raw);
  }
  for (const [semantic, raw] of Object.entries(ACCOUNT_VIEW_FIELD_MAP.accountScalars)) {
    assert.equal(ACCOUNT_SNAPSHOT_ALLOWLIST.includes(raw), true, `${semantic}=${raw}`);
  }
  for (const [tag, raw] of Object.entries(ACCOUNT_VIEW_FIELD_MAP.dailyStanding)) {
    assert.equal(ACCOUNT_SNAPSHOT_ALLOWLIST.includes(raw), true, `${tag}=${raw}`);
  }
  for (const [track, sources] of Object.entries(ACCOUNT_VIEW_FIELD_MAP.research)) {
    assert.equal(ACCOUNT_SNAPSHOT_ALLOWLIST.includes(sources.score), true);
    assert.equal(ACCOUNT_SNAPSHOT_ALLOWLIST.includes(sources.unlocked), true);
    assert.ok(RESEARCH_TRACKS.DEEP === track || RESEARCH_TRACKS.TEMPORAL === track);
  }
});

test('语义集合常量与作用域集合只包含已登记的集合', () => {
  const registered = new Set(Object.values(INVENTORY_COLLECTIONS));
  assert.equal(registered.size, 25);
  for (const collection of registered) assert.equal(typeof collection, 'string');
  for (const scope of [INVENTORY_SCOPES.ALL, INVENTORY_SCOPES.EQUIPMENT, INVENTORY_SCOPES.DROP_MONITOR, INVENTORY_SCOPES.OWNERSHIP, INVENTORY_SCOPES.VALUATION]) {
    assert.equal(typeof scope, 'string');
  }
  const view = buildAccountView(syntheticRawInventory());
  // 掉落监测口径：数量类 + 已装升级（每条计 1、未声明数量按 1 件）
  assert.deepEqual([...view.inventory.quantityTotals(INVENTORY_SCOPES.DROP_MONITOR)], [
    [ITEM_A, 3], [ITEM_B, 0], [ITEM_C, 1], [DUCAT_ITEM, 1],
    ['/Lotus/Types/Recipes/Weapons/GunBarrelBlueprint', 2],
    ['/Lotus/Types/Items/Consumables/Test', 5],
    ['/Lotus/Types/Items/FusionTreasures/FusionTreasure', 3],
    [RAW_UPGRADE_MOD, 5],
    [UPGRADE_MOD, 2], [RIVEN_ITEM, 1], ['/Lotus/Types/Riven/Weapons/Randomized/Veiled', 1],
  ]);
  // 估值口径含 resources/blueprints/consumables/raw-upgrades/installed-upgrades（不含融合物/装备本体）
  assert.deepEqual(
    [...view.inventory.itemTypes(INVENTORY_SCOPES.VALUATION)].sort(),
    [ITEM_A, ITEM_B, ITEM_C, DUCAT_ITEM, RAW_UPGRADE_MOD, UPGRADE_MOD, RIVEN_ITEM,
      '/Lotus/Types/Items/Consumables/Test',
      '/Lotus/Types/Recipes/Weapons/GunBarrelBlueprint', '/Lotus/Types/Riven/Weapons/Randomized/Veiled'].sort(),
  );
  // 拥有判定口径不含战甲/守护等实体本体（对齐既有奸商口径）
  assert.equal(view.inventory.itemTypes(INVENTORY_SCOPES.OWNERSHIP).has(WARFRAME_A), false);
  assert.equal(view.inventory.itemTypes(INVENTORY_SCOPES.OWNERSHIP).has(ITEM_A), true);
  // 装备口径含战甲与武器本体
  assert.equal(view.equipment.itemTypes().has(WARFRAME_A), true);
  assert.equal(view.equipment.has('/Lotus/Weapons/Tenno/LongGuns/TestRifle'), true);
  // 战甲口径只含战甲
  assert.deepEqual([...view.inventory.itemTypes(INVENTORY_SCOPES.WARFRAMES)], [WARFRAME_A]);
});

test('数量语义：声明数量、显式 0、缺失数量三种情况分别可辨', () => {
  const view = buildAccountView(syntheticRawInventory());
  const rows = view.inventory.rows(INVENTORY_SCOPES.RESOURCES);
  assert.deepEqual(rows.map((row) => [row.itemType, row.quantity]), [[ITEM_A, 3], [ITEM_B, 0], [ITEM_C, null], [DUCAT_ITEM, 1]]);
  // 合计持有数量：缺失数量按 1 件（掉落/估值口径）
  assert.equal(view.inventory.quantityOf(ITEM_C), 1);
  // 已声明数量：无声明即 0（余额口径）
  assert.equal(view.inventory.amountOf(ITEM_C), 0);
  assert.equal(view.inventory.amountOf(ITEM_B), 0);
  assert.equal(view.inventory.amountOf(ITEM_A), 3);
  assert.equal(view.inventory.amountOf('/Lotus/Types/Items/MiscItems/Unknown'), 0);
  // 资源集合内条目数量与资源集合存在性
  assert.equal(view.inventory.collectionKnown(INVENTORY_SCOPES.RESOURCES), true);
  assert.equal(view.inventory.collectionKnown(INVENTORY_SCOPES.RAW_UPGRADES), true);
  // 行对象是重建的：不共享源条目引用
  const raw = syntheticRawInventory();
  const rawView = buildAccountView(raw);
  assert.notEqual(rawView.inventory.rows(INVENTORY_SCOPES.RESOURCES)[0], raw.MiscItems[0]);
});

test('账号标量：段位/交易/现金/内融/白金/浮印/杜卡德按语义读取', () => {
  const view = buildAccountView(syntheticRawInventory());
  assert.equal(view.account.masteryRank, 30);
  assert.equal(view.account.tradesRemaining, 7);
  assert.equal(view.account.credits, 1_000_000);
  assert.equal(view.account.endo, 12_345);
  assert.deepEqual({ ...view.account.platinum }, { purchased: 100, free: 25, total: 125 });
  assert.equal(view.account.glyphImagePath, '/Lotus/Interface/Icons/Glyphs/TestGlyph.png');
  assert.equal(view.account.ducatBalance, 1);
});

test('集团语义：总声望/等级/今日剩余/周任务按 tag 读取，缺失区返回 null', () => {
  const view = buildAccountView(syntheticRawInventory());
  assert.equal(view.standing.affiliations().length, 2);
  assert.deepEqual({ ...view.standing.affiliation('KahlSyndicate') }.standing, 12_000);
  assert.equal(view.standing.affiliation('KahlSyndicate').title, 2);
  assert.equal(view.standing.affiliation('HexSyndicate'), null);
  assert.equal(view.standing.dailyRemaining('CetusSyndicate'), 12_345);
  assert.equal(view.standing.dailyRemaining('SolarisSyndicate'), 0);
  assert.equal(view.standing.dailyRemaining('HexSyndicate'), null);
  assert.equal(view.standing.dailyRemaining('UnknownSyndicate'), null);
  assert.deepEqual({ ...view.standing.weeklyMission('KahlSyndicate', weekCount) }, { weekCount, completed: true });
  assert.equal(view.standing.weeklyMission('KahlSyndicate', weekCount + 1), null);
  assert.equal(view.standing.weeklyMission('HexSyndicate', weekCount), null);
});

test('周常语义：轨道/科研/日历/电波/执刑官按语义轨道 id 读取', () => {
  const view = buildAccountView(syntheticRawInventory());
  const circuit = view.weekly.circuit(CIRCUIT_TRACKS.NORMAL, NOW);
  assert.equal(circuit.earned, 100);
  assert.equal(circuit.claimed, 20);
  assert.equal(circuit.goal, 1_000);
  assert.equal(circuit.expired, false);
  assert.deepEqual([...circuit.choices], ['Mesa']);
  assert.deepEqual(circuit.pendingRewards.map((node) => node.requiredTotalXp), [1_000]);
  assert.deepEqual(circuit.pendingRewards[0].rewards.map((reward) => [reward.storeItem, reward.count]), [['/Lotus/StoreItems/Test', 2]]);
  assert.equal(view.weekly.circuit(CIRCUIT_TRACKS.STEEL, NOW), null);
  assert.equal(view.weekly.circuit('EXC_NORMAL', NOW), null); // 原始轨道码不是语义 id

  const descent = view.weekly.descent(DESCENT_TRACKS.NORMAL, NOW);
  assert.deepEqual({ claimed: descent.claimed, goal: descent.goal, expired: descent.expired }, { claimed: 9, goal: 21, expired: false });
  assert.equal(view.weekly.descent(DESCENT_TRACKS.STEEL, NOW), null);

  // 过期轨道：过期时刻在过去时 expired=true，消费方据此不核销
  const stale = buildAccountView({ ...syntheticRawInventory(), LastLiteSortieReward: [], EndlessXP: [{ Category: 'EXC_NORMAL', Expiry: bsonDate(NOW - 1000), Earn: 999, PendingRewards: [{ RequiredTotalXp: 1 }] }] });
  assert.equal(stale.weekly.circuit(CIRCUIT_TRACKS.NORMAL, NOW).expired, true);

  assert.deepEqual({ count: view.weekly.netracell().count, resetMsFuture: view.weekly.netracell().resetAtMs > NOW }, { count: 4, resetMsFuture: true });
  assert.deepEqual(view.weekly.challengeProgress().get('seasonweeklyhardcompleteconquest'), 1);
  assert.deepEqual({ ...view.weekly.archonRewards() }, { count: 1, firstSortieId: 'SORTIE-A' });

  const calendar = view.weekly.calendar();
  assert.equal(calendar.seasonType, 'CST_WINTER');
  assert.equal(calendar.iteration, 4);
  assert.equal(calendar.lastCompletedDayIdx, 1);
  assert.deepEqual([...calendar.activatedChallenges], ['CalendarChallengeA']);
  assert.deepEqual([...calendar.yearUpgrades], ['CalendarUpgradeA']);

  const deep = view.weekly.research(RESEARCH_TRACKS.DEEP);
  const temporal = view.weekly.research(RESEARCH_TRACKS.TEMPORAL);
  assert.deepEqual({ score: deep.score, unlocked: deep.unlocked, tokens: deep.tokens }, { score: 34, unlocked: true, tokens: null });
  assert.deepEqual({ score: temporal.score, unlocked: temporal.unlocked, tokens: [...temporal.tokens] }, { score: 21, unlocked: true, tokens: [1, 2] });
  assert.equal(view.weekly.research('EntratiLab').track, RESEARCH_TRACKS.DEEP);
  assert.equal(view.weekly.research('unknown-track'), null);
});

test('科研轨道兼容映射：语义 id 与历史样本 kind 双向可解析', () => {
  assert.equal(resolveResearchTrack('EntratiLab'), RESEARCH_TRACKS.DEEP);
  assert.equal(resolveResearchTrack('EchoesHex'), RESEARCH_TRACKS.TEMPORAL);
  assert.equal(resolveResearchTrack(RESEARCH_TRACKS.DEEP), RESEARCH_TRACKS.DEEP);
  assert.equal(resolveResearchTrack(null), null);
  assert.equal(researchSampleKind(RESEARCH_TRACKS.DEEP), 'EntratiLab');
  assert.equal(researchSampleKind(RESEARCH_TRACKS.TEMPORAL), 'EchoesHex');
  assert.equal(researchSampleKind('unknown'), null);
});

test('商店已购语义：按商人给出创建时刻/过期时刻/件数，且过滤无 ItemId 的脏记录', () => {
  const view = buildAccountView(syntheticRawInventory());
  const purchases = view.vendorPurchases.of('Teshin');
  assert.equal(purchases.length, 1);
  assert.equal(purchases[0].num, 2);
  assert.equal(purchases[0].itemId, VENDOR_ITEM_ID);
  assert.equal(purchases[0].expiryMs, NOW + 3 * 86_400_000);
  assert.equal(purchases[0].createdMs, Number.parseInt(VENDOR_ITEM_ID.slice(0, 8), 16) * 1000);
  assert.deepEqual(view.vendorPurchases.of('Unknown'), []);
  assert.deepEqual([...view.vendorPurchases.vendors()], ['Teshin']);
  const dirty = buildAccountView({ RecentVendorPurchases: [{ VendorType: 'Teshin', PurchaseHistory: [{ ItemId: '', NumPurchased: 1 }] }] });
  assert.deepEqual(dirty.vendorPurchases.of('Teshin'), []);
});

test('紫卡语义：已开封给出武器键/极性/洗练/词条，未开封给出挑战进度', () => {
  const view = buildAccountView(syntheticRawInventory());
  const installed = view.rivens.installed();
  assert.equal(installed.length, 1);
  assert.equal(installed[0].itemType, RIVEN_ITEM);
  assert.equal(installed[0].weaponKey, RIVEN_WEAPON);
  assert.equal(installed[0].polarity, 'madurai');
  assert.equal(installed[0].rerolls, 3);
  assert.equal(installed[0].masteryRequirement, 8);
  assert.deepEqual(installed[0].attributes.buffs.map((attribute) => [attribute.tag, attribute.value]), [['dmg', 0]]);
  assert.deepEqual([...installed[0].attributes.curses], []);
  const veiled = view.rivens.veiled();
  assert.deepEqual(veiled, [{ itemType: '/Lotus/Types/Riven/Weapons/Randomized/Veiled', quantity: 1, challenge: { progress: 2, required: 10 }, isVeiled: true }]);
});

test('紫卡指纹归一化：旧合成指纹对象与语义记录等价，且幂等', () => {
  const raw = { compat: RIVEN_WEAPON, pol: 'madurai', rerolls: 3, lvlReq: 8, lvl: 2, buffs: [{ Tag: 'dmg', Value: 5 }], curses: [{ Tag: 'zoom', Value: 1 }], challenge: { Progress: 1, Required: 2 } };
  const record = normalizeRivenRecord(raw);
  assert.equal(record.weaponKey, RIVEN_WEAPON);
  assert.equal(record.polarity, 'madurai');
  assert.equal(record.rerolls, 3);
  assert.equal(record.masteryRequirement, 8);
  assert.equal(record.rank, 2);
  assert.deepEqual(record.attributes.buffs.map((attribute) => [attribute.tag, attribute.value]), [['dmg', 5]]);
  assert.deepEqual(record.attributes.curses.map((attribute) => [attribute.tag, attribute.value]), [['zoom', 1]]);
  assert.deepEqual({ ...record.challenge }, { progress: 1, required: 2 });
  assert.equal(normalizeRivenRecord(record), record);
  // 缺失键保持缺失：消费方用 /0x40000000 还原 roll 时必须得到 NaN 而不是 0
  const empty = normalizeRivenRecord({});
  assert.equal(empty.weaponKey, null);
  assert.equal(empty.masteryRequirement, null);
  assert.deepEqual([...empty.attributes.buffs], []);
  assert.equal(empty.challenge, null);
  assert.equal(normalizeRivenRecord(null).weaponKey, null);
});

// ——————————————————————————————————————————————————————————————
// 3. 无引用共享 / 无原始字段与敏感泄露
// ——————————————————————————————————————————————————————————————

test('视图不泄露原始字段名或合成敏感 sentinel', () => {
  const raw = syntheticRawInventory();
  const serializedRawView = JSON.stringify(buildAccountView(raw));
  const serializedAdaptedView = JSON.stringify(buildAccountView(adapt(raw)));
  for (const payload of [serializedRawView, serializedAdaptedView]) {
    assert.equal(payload.includes(SENTINEL), false);
    for (const field of ACCOUNT_VIEW_RAW_TOP_LEVEL_FIELDS) {
      assert.equal(payload.includes(`"${field}"`), false, field);
    }
    for (const nested of ['ItemType', 'ItemCount', 'UpgradeFingerprint', 'WeeklyMissions', 'VendorType', 'PurchaseHistory', 'SortieId']) {
      assert.equal(payload.includes(`"${nested}"`), false, nested);
    }
  }
});

test('视图不共享源容器：改写来源或视图都不互相影响', () => {
  const raw = syntheticRawInventory();
  const view = buildAccountView(raw);
  const before = view.inventory.rows(INVENTORY_SCOPES.RESOURCES)[0];
  raw.MiscItems[0].ItemCount = 999;
  assert.equal(before.quantity, 3, '已投影行不受源对象后续改写影响');
  const fresh = buildAccountView(syntheticRawInventory());
  const row = fresh.inventory.rows(INVENTORY_SCOPES.RESOURCES)[0];
  assert.equal(Object.isFrozen(row), true, '视图行是只读的，消费方无法反向写入');
  assert.equal(fresh.inventory.rows(INVENTORY_SCOPES.RESOURCES)[0].quantity, 3);
  const calendar = fresh.weekly.calendar();
  assert.notEqual(calendar.activatedChallenges, raw.CalendarProgress.SeasonProgress.ActivatedChallenges);
});

test('适配后快照的条目级投影仍然生效：视图读不到被剥离的未知键', () => {
  const adapted = adapt(syntheticRawInventory());
  assert.equal(JSON.stringify(adapted.inventory).includes(SENTINEL), false);
  const view = buildAccountView(adapted);
  const row = view.inventory.rows(INVENTORY_SCOPES.RESOURCES)[0];
  assert.deepEqual(Object.keys(row).sort(), ['collection', 'itemType', 'quantity', 'rank']);
});

// ——————————————————————————————————————————————————————————————
// 4. 三种输入等价
// ——————————————————————————————————————————————————————————————

test('输入兼容：真实快照、旧 { inventory } 包装、合成库存对象产出等价视图', () => {
  const raw = syntheticRawInventory();
  const adapted = adapt(raw);
  const fromRaw = buildAccountView(raw);
  const fromWrapper = buildAccountView({ inventory: raw, syncedAt: adapted.syncedAt });
  const fromSnapshot = buildAccountView(adapted);
  const semanticOf = (view) => ({
    // 语义比较刻意排除 asOf/syncedAt/confidence 等元数据：它们本就来自输入形态差异
    account: { ...view.account, syncedAt: null, asOf: null, confidence: 'ignored' },
    dropCounts: [...view.inventory.quantityTotals(INVENTORY_SCOPES.DROP_MONITOR)],
    equipment: [...view.equipment.itemTypes()],
    rivensInstalled: view.rivens.installed(),
    rivensVeiled: view.rivens.veiled(),
    standing: view.standing.affiliations(),
    daily: ['CetusSyndicate', 'SolarisSyndicate', 'HexSyndicate'].map((tag) => view.standing.dailyRemaining(tag)),
    circuit: view.weekly.circuit(CIRCUIT_TRACKS.NORMAL, NOW),
    descent: view.weekly.descent(DESCENT_TRACKS.NORMAL, NOW),
    netracell: view.weekly.netracell(),
    challenges: [...view.weekly.challengeProgress()],
    archon: view.weekly.archonRewards(),
    calendar: view.weekly.calendar(),
    research: [view.weekly.research(RESEARCH_TRACKS.DEEP), view.weekly.research(RESEARCH_TRACKS.TEMPORAL)],
    purchases: view.vendorPurchases.of('Teshin'),
  });
  assert.deepEqual(semanticOf(fromRaw), semanticOf(fromSnapshot));
  assert.deepEqual(semanticOf(fromWrapper), semanticOf(fromSnapshot));
});

// ——————————————————————————————————————————————————————————————
// 5. 迁移后的业务纯函数输出等价
// ——————————————————————————————————————————————————————————————

test('业务纯函数等价：原始库存与适配后快照的输出一致（掉落/持有/声望/已购/周常/紫卡）', async () => {
  const [{ countInventory }, { annotateParentOwnership, weeklyEvidence }, { attachBountyStanding }, { vendorPurchases }, { evaluateAutoCheck, archimedeaResearchProgress }, { assembleRivens }, { buildOwnedIndex, readDucatBalance }] = await Promise.all([
    import('./drops.mjs'),
    import('./alecaframe.mjs'),
    import('./bounties.mjs'),
    import('./vendor-shop.mjs'),
    import('./weekly.mjs'),
    import('./rivens.mjs'),
    import('./trader-shopping.mjs'),
  ]);
  const raw = syntheticRawInventory();
  const adapted = adapt(raw);

  assert.deepEqual(countInventory(raw), countInventory(adapted));
  assert.equal(countInventory(adapted)[ITEM_C], 1);

  const entries = [{ uniqueName: ITEM_A, parentUniqueName: WARFRAME_A }];
  assert.deepEqual(annotateParentOwnership(entries, raw), annotateParentOwnership(entries, adapted));
  assert.equal(annotateParentOwnership(entries, adapted)[0].parentOwned, true);
  assert.equal(annotateParentOwnership(entries, {})[0].parentOwned, null);
  assert.deepEqual(annotateParentOwnership(entries, null), [{ uniqueName: ITEM_A, parentUniqueName: WARFRAME_A, parentOwned: null }]);

  const bountyData = () => ({ places: [{ key: 'cetus' }], boards: [{ key: 'EntratiLabSyndicate' }] });
  assert.deepEqual(attachBountyStanding(bountyData(), raw), attachBountyStanding(bountyData(), adapted));
  assert.deepEqual(attachBountyStanding(bountyData(), raw).places[0].standing, { standing: 44_000, title: 5, daily: 12_345 });
  assert.equal(attachBountyStanding({ places: [{ key: 'cetus' }] }, null).places[0].standing, undefined);

  assert.deepEqual(vendorPurchases(raw, 'Teshin'), vendorPurchases(adapted, 'Teshin'));
  assert.equal(vendorPurchases(adapted, 'Teshin').length, 1);

  assert.deepEqual([...buildOwnedIndex(raw)].sort(), [...buildOwnedIndex(adapted)].sort());
  assert.equal(readDucatBalance(raw), readDucatBalance(adapted));
  assert.equal(readDucatBalance(adapted), 1);

  const autoArgs = [null, NOW, null, new Date(NOW).toISOString(), {}];
  assert.deepEqual(evaluateAutoCheck(raw, ...autoArgs), evaluateAutoCheck(adapted, ...autoArgs));
  const auto = evaluateAutoCheck(adapted, ...autoArgs);
  assert.equal(auto.auto.kahl, true);
  assert.equal(auto.progress.netracell, '本周 4/5 次');
  assert.equal(auto.progress['circuit-normal'], '阶层经验 100/1000');
  // 科研进度兼容历史 kind 与语义轨道 id
  const researchArgs = [NOW, new Date(NOW).toISOString(), {}];
  assert.deepEqual(archimedeaResearchProgress(adapted, 'EntratiLab', ...researchArgs), archimedeaResearchProgress(raw, RESEARCH_TRACKS.DEEP, ...researchArgs));
  assert.equal(archimedeaResearchProgress(adapted, RESEARCH_TRACKS.DEEP, ...researchArgs).score, 34);

  // 顶部证据面板（alecaframe.weeklyEvidence）接收 { syncedAt, inventory } 旧形态
  const panel = await weeklyEvidence(adapted);
  const rawPanel = await weeklyEvidence({ syncedAt: adapted.syncedAt, inventory: raw });
  assert.equal(panel.data.rows.length, 11);
  assert.deepEqual(panel, rawPanel);
  assert.equal(panel.data.rows.find((row) => row.name === '深层科研').value, '34 研究点');
  assert.equal(panel.data.rows.find((row) => row.name === '衰退室').value, '4/5 次');

  // 紫卡装配：契约与自选两种输入一致
  const table = { dataByRivenInternalID: { [RIVEN_ITEM]: { fusionLimit: 8, rivenStats: { dmg: { baseValue: 1.5, shortString: 'D', prefixTag: 'vex', suffixTag: 'ido' } } } }, weaponStats: { [RIVEN_WEAPON]: { name: 'Test Rifle', omegaAtt: 1 } } };
  const fromRaw = await assembleRivens({ inventory: raw, table });
  const fromAdapted = await assembleRivens({ inventory: adapted, table });
  assert.deepEqual(fromRaw, fromAdapted);
  assert.equal(fromAdapted.opened.length, 1);
  assert.equal(fromAdapted.opened[0].compat, RIVEN_WEAPON);
  assert.equal(fromAdapted.opened[0].rerolls, 3);
  assert.equal(fromAdapted.veiled.length, 1);
  assert.deepEqual(fromAdapted.veiled[0].challenge, { progress: 2, required: 10 });
});

test('业务纯函数等价：轮换日历的「已有」标在两种输入下一致', async () => {
  const { buildRotationCalendar, __resetRotationTablesForTest, CIRCUIT_EPOCH_MS } = await import('./rotation-calendar.mjs');
  __resetRotationTablesForTest({
    frames: Array.from({ length: 11 }, () => [{ zh: '战甲A', en: 'FrameA' }]),
    weapons: Array.from({ length: 9 }, () => [{ zh: '武器X', en: 'WeaponX' }]),
  });
  const names = { uniqByName: new Map([['FrameA', WARFRAME_A]]) };
  const raw = syntheticRawInventory();
  const adapted = adapt(raw);
  const now = CIRCUIT_EPOCH_MS + 3 * 604_800_000;
  const fromRaw = await buildRotationCalendar({ weeks: 2, inventory: raw, names, worldState: null, now });
  const fromAdapted = await buildRotationCalendar({ weeks: 2, inventory: adapted, names, worldState: null, now });
  assert.deepEqual(fromRaw, fromAdapted);
  assert.equal(fromRaw.rows[0].frames[0].owned, true);
});
