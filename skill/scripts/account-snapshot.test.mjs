import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ACCOUNT_SNAPSHOT_ALLOWLIST, ACCOUNT_SNAPSHOT_PROJECTED_FIELDS, ACCOUNT_SNAPSHOT_SCHEMA_VERSION,
  ACCOUNT_SNAPSHOT_SOURCE, MAX_DELTA_EVENTS, adaptAccountSnapshot, diffAccountSnapshots,
} from './account-snapshot.mjs';
import { readSnapshot, weeklyEvidence } from './alecaframe.mjs';

// R15 第三片合同（全部为合成数据，不读真实 AlecaFrame 文件、不联网、不落盘 delta）：
//   1. 旧/新信封形状与顶层白名单剥离
//   2. 条目级/嵌套字段显式投影：多层未知键与敏感 sentinel 从适配后快照完全消失，无原对象引用
//   3. asOf/同步时间与字段元数据（来源/周期/可信度/新鲜度）
//   4. 统一 delta 的稳定身份、顺序、增/减/改/无变化与上限，且不泄露条目内容
//   5. 现有消费方（掉落计数/周常核销/赏金声望/商店已购/父成品持有）在适配前后行为一致

const NOW = Date.parse('2026-09-10T12:00:00.000Z');
const FILE_MTIME = '2026-09-09T20:00:00.000Z';
const ITEM_A = '/Lotus/Types/Items/MiscItems/ItemA';
const ITEM_B = '/Lotus/Types/Items/MiscItems/ItemB';
const ITEM_C = '/Lotus/Types/Items/MiscItems/ItemC';
const ITEM_E = '/Lotus/Types/Items/MiscItems/ItemE';
const ITEM_F = '/Lotus/Upgrades/Mods/ItemF';
// oid 前 8 位是 Unix 秒：与 alecaframe/drops 既有 syncedAt 口径一致
const SYNC_OID = '64a000000000000000000001';
const SYNC_AS_OF = new Date(Number.parseInt('64a00000', 16) * 1000).toISOString();

const isoDay = (base, days) => new Date(base + days * 86400000).toISOString();
const bsonDate = (iso) => ({ $date: { $numberLong: String(Date.parse(iso)) } });

function weeklyEnvelope(options = {}) {
  const base = options.baseNow ?? Date.now();
  const expiryIso = options.expiryIso ?? isoDay(base, 3);
  const resetIso = options.resetIso ?? isoDay(base, 2);
  const weekCount = Math.floor((base - Date.UTC(2014, 1, 10)) / 604_800_000);
  return {
    LastInventorySync: { $oid: options.oid ?? SYNC_OID },
    // 新版顶层信封的识别依据仍是库存组存在（沿用适配前判据），真实快照必有 MiscItems
    MiscItems: options.miscItems ?? [],
    EntratiLabConquestUnlocked: 1,
    EntratiLabConquestCacheScoreMission: options.labScore ?? 34,
    EchoesHexConquestUnlocked: 1,
    EchoesHexConquestCacheScoreMission: options.echoesScore ?? 34,
    EchoesHexConquestBonusTokensGiven: options.tokens ?? [1, 2],
    EntratiVaultCountLastPeriod: options.vaultCount ?? 4,
    EntratiVaultCountResetDate: bsonDate(resetIso),
    LastLiteSortieReward: [{ SortieId: { $oid: options.sortieId ?? 'SORTIE-A' } }],
    ChallengeProgress: options.challengeProgress ?? [{ Name: 'A', Progress: 1 }],
    Affiliations: [{
      Tag: 'KahlSyndicate',
      Standing: 12000,
      Title: 2,
      WeeklyMissions: [{ WeekCount: weekCount, CompletedMission: options.kahlCompleted ?? false }],
    }],
    DescentRewards: options.descentRewards ?? [
      { Category: 'DM_COH_NORMAL', Expiry: bsonDate(expiryIso), FloorClaimed: 9, PendingRewards: [{ FloorCheckpoint: 21 }] },
      { Category: 'DM_COH_HARD', Expiry: bsonDate(expiryIso), FloorClaimed: 0, PendingRewards: [{ FloorCheckpoint: 21 }] },
    ],
    EndlessXP: options.endlessXp ?? [
      { Category: 'EXC_NORMAL', Expiry: bsonDate(expiryIso), Earn: options.circuitEarned ?? 100, PendingRewards: [{ RequiredTotalXp: 1000 }] },
      { Category: 'EXC_HARD', Expiry: bsonDate(expiryIso), Earn: 200, PendingRewards: [{ RequiredTotalXp: 2000 }] },
    ],
    CalendarProgress: {
      Iteration: options.calendarIteration ?? 4,
      SeasonProgress: { SeasonType: 'CST_WINTER', LastCompletedDayIdx: 1, ActivatedChallenges: ['A'] },
    },
    PlayerLevel: 30,
  };
}

function adapt(envelope, options = {}) {
  return adaptAccountSnapshot(envelope, { now: NOW, fileMtime: FILE_MTIME, fileMtimeMs: 1757448000000, ...options });
}

// —— 1. 信封形状与白名单 ——

test('适配器兼容旧版 InventoryJson/InventoryJSON 信封', () => {
  const inventory = {
    LastInventorySync: { $oid: SYNC_OID },
    MiscItems: [{ ItemType: ITEM_A, ItemCount: 3 }],
    RawUpgrades: [],
    PlayerLevel: 30,
  };
  const adapted = adapt({ InventoryJson: JSON.stringify(inventory) });
  assert.equal(adapted.envelopeShape, 'legacy-inventory-json');
  assert.equal(adapted.asOf, SYNC_AS_OF);
  assert.equal(adapted.syncedAt, SYNC_AS_OF);
  assert.equal(adapted.asOfBasis, 'source-sync-oid');
  assert.deepEqual(adapted.inventory.MiscItems, [{ ItemType: ITEM_A, ItemCount: 3 }]);
  assert.equal(adapted.inventory.PlayerLevel, 30);
  assert.equal(adapted.coverage.retainedTopLevelFields, 4);

  // InventoryJSON 变体允许直接给对象
  const objectVariant = adapt({ InventoryJSON: inventory });
  assert.equal(objectVariant.envelopeShape, 'legacy-inventory-json');
  assert.deepEqual(objectVariant.inventory, adapted.inventory);
});

test('适配器识别新版顶层库存信封，缺库存时保留原有报错', () => {
  const adapted = adapt({ MiscItems: [{ ItemType: ITEM_A, ItemCount: 1 }], LastInventorySync: { $oid: SYNC_OID } });
  assert.equal(adapted.envelopeShape, 'direct-inventory');
  assert.deepEqual(adapted.inventory.MiscItems, [{ ItemType: ITEM_A, ItemCount: 1 }]);
  assert.throws(() => adapt({ SomethingElse: 1 }), /账号快照中没有库存数据/u);
  assert.throws(() => adaptAccountSnapshot(null), /账号快照中没有库存数据/u);
  // drops 的旧错误文案仍可按调用方覆盖
  assert.throws(
    () => adaptAccountSnapshot({ SomethingElse: 1 }, { missingInventoryMessage: '账号快照中没有库存数据' }),
    /^Error: 账号快照中没有库存数据$/u,
  );
});

test('适配快照不暴露未消费的顶层原始字段', () => {
  const adapted = adapt({
    LastInventorySync: { $oid: SYNC_OID },
    MiscItems: [{ ItemType: ITEM_A, ItemCount: 2 }],
    WarframeMarketToken: 'SENTINEL-TOKEN',
    AccountId: 'SENTINEL-ACCOUNT',
    FutureUnknownField: { nested: 'SENTINEL-FUTURE' },
  });
  assert.equal(adapted.envelope, undefined);
  assert.deepEqual(Object.keys(adapted.inventory), ['MiscItems', 'LastInventorySync']);
  for (const field of Object.keys(adapted.inventory)) assert.ok(ACCOUNT_SNAPSHOT_ALLOWLIST.includes(field));
  assert.equal(adapted.coverage.inventoryTopLevelFields, 5);
  assert.equal(adapted.coverage.retainedTopLevelFields, 2);
  assert.equal(adapted.coverage.omittedTopLevelFields, 3);
  const serialized = JSON.stringify(adapted);
  for (const sentinel of ['SENTINEL-TOKEN', 'SENTINEL-ACCOUNT', 'SENTINEL-FUTURE']) {
    assert.equal(serialized.includes(sentinel), false, sentinel);
  }
});

test('旧版信封的外层未消费字段也不外传', () => {
  const adapted = adapt({
    InventoryJson: JSON.stringify({ MiscItems: [], LastInventorySync: { $oid: SYNC_OID } }),
    WarframeMarketToken: 'SENTINEL-TOKEN',
    AccountId: 'SENTINEL-ACCOUNT',
  });
  assert.deepEqual(adapted.inventory, { MiscItems: [], LastInventorySync: { $oid: SYNC_OID } });
  assert.equal(JSON.stringify(adapted).includes('SENTINEL-'), false);
});

// —— 1b. 条目级/嵌套字段显式投影（R15 第三片）——
//
// 条目内部的未知键、实例 oid、宠物详情、令牌与未来新增字段都必须在任意深度消失；
// 同时现有消费方真正读取的键必须逐项保留（键名与嵌套层级都不能少）。

// 注入到每一层合成对象的未知/敏感键：任何一项出现在适配后快照里都算失败。
const JUNK = Object.freeze({
  InstanceId: 'SENT-INSTANCE',
  OwnerId: 'SENT-OWNER',
  WarframeMarketToken: 'SENT-TOKEN',
  FutureUnknownField: { deep: { deeper: 'SENT-FUTURE' } },
});
const withJunk = (entry) => ({ ...entry, ...JUNK });

// [字段, ItemType, ItemCount]（ItemCount=null 表示源条目没有该键，投影后也必须缺键）
const ITEM_GROUP_CASES = Object.freeze([
  ['MiscItems', ITEM_A, 3],
  ['Recipes', '/Lotus/Types/Recipes/Weapons/GunBarrelBlueprint', 2],
  ['Consumables', '/Lotus/Types/Items/Consumables/HealthRestore', 8],
  ['FusionTreasures', '/Lotus/Types/Items/FusionTreasures/FusionTreasure', 4],
  ['FlavourItems', '/Lotus/Types/Items/MiscItems/FlavourItem', 1],
  ['SpecialItems', '/Lotus/Types/Items/SpecialItems/SpecialItem', 1],
  ['DataKnives', '/Lotus/Types/Items/DataKnives/DataKnife', 1],
  ['RawUpgrades', '/Lotus/Upgrades/Mods/Raw/RawMod', 5],
  // 装备类只被读 ItemType（父成品持有 / 已拥有索引 / 周报战甲收集）
  ['LongGuns', '/Lotus/Weapons/Tenno/LongGuns/GunPrime', 1],
  ['Pistols', '/Lotus/Weapons/Tenno/Pistol/PistolPrime', null],
  ['Melee', '/Lotus/Weapons/Tenno/Melee/MeleePrime', null],
  ['Suits', '/Lotus/Powersuits/Wukong/WukongPrime', null],
  ['Sentinels', '/Lotus/Types/Sentinels/Sentinel/SentinelPrime', null],
  ['SentinelWeapons', '/Lotus/Weapons/Sentinel/SentinelWeaponPrime', null],
  ['SpaceGuns', '/Lotus/Weapons/Tenno/Archwing/Primary/ArchGun', null],
  ['SpaceMelee', '/Lotus/Weapons/Tenno/Archwing/Melee/ArchMelee', null],
  ['SpaceSuits', '/Lotus/Powersuits/Archwing/ArchSuit', null],
  ['OperatorAmps', '/Lotus/Weapons/Operator/Amps/Amp', null],
  ['OperatorSuits', '/Lotus/Powersuits/Operator/OperatorSuit', null],
  ['CrewShipWeapons', '/Lotus/Weapons/Railjack/CrewShipWeapon', null],
  ['DrifterMelee', '/Lotus/Weapons/Tenno/Melee/DrifterMelee', null],
  ['Horses', '/Lotus/Types/Vehicles/Horse/Horse', null],
  ['Motorcycles', '/Lotus/Types/Vehicles/Motorcycle/Motorcycle', null],
  ['KubrowPets', '/Lotus/Types/Game/KubrowPet/KubrowPet', null],
]);

const UPGRADE_ITEM = '/Lotus/Upgrades/Mods/ItemG';
const SORTIE_ID = 'SORTIE-A';
const VENDOR_ITEM_ID = '64a00000000000000000000a';
const GLYPH = '/Lotus/Upgrades/Glyphs/TestGlyph';
const WEEK_COUNT = Math.floor((NOW - Date.UTC(2014, 1, 10)) / 604_800_000);

// 覆盖全部 53 个白名单字段的合成信封：每个对象层都注入 JUNK，顶层再放未消费字段。
function fullEnvelope() {
  const expiry = bsonDate(isoDay(NOW, 3));
  const reset = bsonDate(isoDay(NOW, 2));
  const envelope = {
    LastInventorySync: withJunk({ $oid: SYNC_OID }),
    Upgrades: [withJunk({ ItemType: UPGRADE_ITEM, UpgradeFingerprint: '{"lvl":3}', ItemCount: 9 })],
    PlayerLevel: 30,
    TradesRemaining: 12,
    RegularCredits: 1_000_000,
    FusionPoints: 55_000,
    PremiumCredits: 100,
    PremiumCreditsFree: 25,
    ActiveAvatarImageType: GLYPH,
    Affiliations: [withJunk({
      Tag: 'KahlSyndicate',
      Standing: 12_000,
      Title: 2,
      WeeklyMissions: [withJunk({ WeekCount: WEEK_COUNT, CompletedMission: true, Challenge: 'SENT-CHALLENGE' })],
    })],
    DailyAffiliationCetus: 5_000,
    DailyAffiliationSolaris: 4_000,
    DailyAffiliationEntrati: 3_000,
    DailyAffiliationZariman: 2_000,
    DailyAffiliationCavia: 1_000,
    DailyAffiliationHex: 500,
    EndlessXP: [withJunk({
      Category: 'EXC_NORMAL',
      Expiry: expiry,
      Earn: 100,
      Claim: 50,
      Choices: ['Mesa'],
      PendingRewards: [withJunk({
        RequiredTotalXp: 1_000,
        Rewards: [withJunk({ StoreItem: '/Lotus/StoreItems/TestReward', ItemCount: 2 })],
      })],
    })],
    DescentRewards: [withJunk({
      Category: 'DM_COH_NORMAL',
      Expiry: expiry,
      FloorClaimed: 9,
      PendingRewards: [withJunk({ FloorCheckpoint: 21 })],
    })],
    EntratiVaultCountLastPeriod: 4,
    EntratiVaultCountResetDate: reset,
    LastLiteSortieReward: [withJunk({
      SortieId: { $oid: SORTIE_ID, DeviceId: 'SENT-SORTIE' },
      StoreItem: '/Lotus/Powersuits/Test',
      Manifest: { Secret: 'SENT-MANIFEST' },
    })],
    ChallengeProgress: [withJunk({ Name: 'SeasonWeeklyHardCompleteConquest', Progress: 1 })],
    CalendarProgress: withJunk({
      Iteration: 4,
      SeasonProgress: withJunk({ SeasonType: 'CST_WINTER', LastCompletedDayIdx: 1, ActivatedChallenges: ['A'] }),
      YearProgress: withJunk({ Upgrades: ['U1'] }),
    }),
    EntratiLabConquestUnlocked: 1,
    EntratiLabConquestCacheScoreMission: 34,
    EchoesHexConquestUnlocked: 1,
    EchoesHexConquestCacheScoreMission: 34,
    EchoesHexConquestBonusTokensGiven: [1, 2],
    RecentVendorPurchases: [withJunk({
      VendorType: 'Teshin',
      PurchaseHistory: [withJunk({ Expiry: expiry, ItemId: VENDOR_ITEM_ID, NumPurchased: 2 })],
    })],
    // 顶层未消费字段（令牌/账号标识/未来新增）也必须消失
    WarframeMarketToken: 'SENT-TOP-TOKEN',
    AccountId: 'SENT-TOP-ACCOUNT',
    FutureTopLevelField: { deep: 'SENT-TOP-FUTURE' },
  };
  for (const [field, itemType, itemCount] of ITEM_GROUP_CASES) {
    envelope[field] = [withJunk(itemCount == null ? { ItemType: itemType } : { ItemType: itemType, ItemCount: itemCount })];
  }
  return envelope;
}

// 与 fullEnvelope 对应的期望投影：逐字段、逐层列出唯一允许保留的键。
function fullExpectation() {
  const expiry = bsonDate(isoDay(NOW, 3));
  const reset = bsonDate(isoDay(NOW, 2));
  const expected = {
    LastInventorySync: { $oid: SYNC_OID },
    Upgrades: [{ ItemType: UPGRADE_ITEM, UpgradeFingerprint: '{"lvl":3}' }],
    PlayerLevel: 30,
    TradesRemaining: 12,
    RegularCredits: 1_000_000,
    FusionPoints: 55_000,
    PremiumCredits: 100,
    PremiumCreditsFree: 25,
    ActiveAvatarImageType: GLYPH,
    Affiliations: [{
      Tag: 'KahlSyndicate',
      Standing: 12_000,
      Title: 2,
      WeeklyMissions: [{ WeekCount: WEEK_COUNT, CompletedMission: true }],
    }],
    DailyAffiliationCetus: 5_000,
    DailyAffiliationSolaris: 4_000,
    DailyAffiliationEntrati: 3_000,
    DailyAffiliationZariman: 2_000,
    DailyAffiliationCavia: 1_000,
    DailyAffiliationHex: 500,
    EndlessXP: [{
      Category: 'EXC_NORMAL',
      Expiry: expiry,
      Earn: 100,
      Claim: 50,
      Choices: ['Mesa'],
      PendingRewards: [{ RequiredTotalXp: 1_000, Rewards: [{ StoreItem: '/Lotus/StoreItems/TestReward', ItemCount: 2 }] }],
    }],
    DescentRewards: [{
      Category: 'DM_COH_NORMAL',
      Expiry: expiry,
      FloorClaimed: 9,
      PendingRewards: [{ FloorCheckpoint: 21 }],
    }],
    EntratiVaultCountLastPeriod: 4,
    EntratiVaultCountResetDate: reset,
    LastLiteSortieReward: [{ SortieId: { $oid: SORTIE_ID } }],
    ChallengeProgress: [{ Name: 'SeasonWeeklyHardCompleteConquest', Progress: 1 }],
    CalendarProgress: {
      Iteration: 4,
      SeasonProgress: { SeasonType: 'CST_WINTER', LastCompletedDayIdx: 1, ActivatedChallenges: ['A'] },
      YearProgress: { Upgrades: ['U1'] },
    },
    EntratiLabConquestUnlocked: 1,
    EntratiLabConquestCacheScoreMission: 34,
    EchoesHexConquestUnlocked: 1,
    EchoesHexConquestCacheScoreMission: 34,
    EchoesHexConquestBonusTokensGiven: [1, 2],
    RecentVendorPurchases: [{
      VendorType: 'Teshin',
      PurchaseHistory: [{ Expiry: expiry, ItemId: VENDOR_ITEM_ID, NumPurchased: 2 }],
    }],
  };
  for (const [field, itemType, itemCount] of ITEM_GROUP_CASES) {
    expected[field] = [itemCount == null ? { ItemType: itemType } : { ItemType: itemType, ItemCount: itemCount }];
  }
  return expected;
}

test('条目级投影逐字段保留消费键：全部白名单字段的键树与期望完全一致', () => {
  const adapted = adapt(fullEnvelope());
  // 键顺序=白名单顺序（兼容既有消费方对稳定形状的依赖）
  assert.deepEqual(Object.keys(adapted.inventory), [...ACCOUNT_SNAPSHOT_ALLOWLIST]);
  assert.deepEqual(adapted.inventory, fullExpectation());
  assert.equal(adapted.coverage.retainedTopLevelFields, ACCOUNT_SNAPSHOT_ALLOWLIST.length);
  assert.equal(adapted.coverage.droppedByProjectionFields, 0);
  // 深层未知/敏感键完全消失
  const serialized = JSON.stringify(adapted);
  for (const sentinel of [
    'SENT-TOP-TOKEN', 'SENT-TOP-ACCOUNT', 'SENT-TOP-FUTURE',
    'SENT-INSTANCE', 'SENT-OWNER', 'SENT-TOKEN', 'SENT-FUTURE',
    'SENT-CHALLENGE', 'SENT-SORTIE', 'SENT-MANIFEST',
  ]) assert.equal(serialized.includes(sentinel), false, sentinel);
  // 每个白名单字段都必须有显式投影函数（不存在整对象透传的兜底分支）
  assert.equal(ACCOUNT_SNAPSHOT_PROJECTED_FIELDS.length, ACCOUNT_SNAPSHOT_ALLOWLIST.length);
  assert.deepEqual([...ACCOUNT_SNAPSHOT_PROJECTED_FIELDS].sort(), [...ACCOUNT_SNAPSHOT_ALLOWLIST].sort());
});

test('投影保持「缺键即缺键」，不把无法证明的值补成 0 或空对象', () => {
  const adapted = adapt({
    MiscItems: [
      { ItemType: ITEM_A },
      { ItemType: ITEM_B, ItemCount: null },
      { ItemType: ITEM_C, ItemCount: 'not-a-number' },
      { ItemType: '/Lotus/Types/Items/MiscItems/ItemD', ItemCount: 0 },
    ],
    DailyAffiliationCetus: 'garbage',
    PlayerLevel: { nested: 'SENT-LEVEL' },
    ActiveAvatarImageType: { nested: 'SENT-GLYPH' },
    EchoesHexConquestBonusTokensGiven: 'not-an-array',
    ChallengeProgress: 'not-an-array',
    CalendarProgress: null,
  });
  // ItemCount 的存在性有语义（缺失按 1 件计），缺失保持缺键，存在则与消费方 Number(x)||0 同口径
  assert.deepEqual(adapted.inventory.MiscItems, [
    { ItemType: ITEM_A },
    { ItemType: ITEM_B },
    { ItemType: ITEM_C, ItemCount: 0 },
    { ItemType: '/Lotus/Types/Items/MiscItems/ItemD', ItemCount: 0 },
  ]);
  assert.equal('ItemCount' in adapted.inventory.MiscItems[0], false);
  // 非有限数字整键丢弃：赏金卡按「无有效数据」隐藏余量列，而不是显示 0
  assert.equal('DailyAffiliationCetus' in adapted.inventory, false);
  assert.equal('PlayerLevel' in adapted.inventory, false);
  assert.equal('ActiveAvatarImageType' in adapted.inventory, false);
  // 非数组容器按空列表处理，与消费方的 `|| []` 口径一致
  assert.deepEqual(adapted.inventory.EchoesHexConquestBonusTokensGiven, []);
  assert.deepEqual(adapted.inventory.ChallengeProgress, []);
  assert.deepEqual(adapted.inventory.CalendarProgress, {});
  assert.equal(adapted.coverage.droppedByProjectionFields, 3);
  assert.equal(JSON.stringify(adapted).includes('SENT-'), false);
});

test('奖励令牌按数值语义投影：对象噪声不进入快照也不产生伪 delta', () => {
  const before = adapt(weeklyEnvelope({ baseNow: NOW, tokens: [1, 2] }));
  assert.deepEqual(before.inventory.EchoesHexConquestBonusTokensGiven, [1, 2]);
  const reordered = adapt(weeklyEnvelope({ baseNow: NOW, tokens: [2, 1] }));
  assert.deepEqual(reordered.inventory.EchoesHexConquestBonusTokensGiven, [2, 1]);
  // 列表摘要忽略顺序：仅换序不算变化
  assert.equal(
    diffAccountSnapshots(before, reordered).events
      .some((event) => event.field === 'EchoesHexConquestBonusTokensGiven'),
    false,
  );
  const noisy = adapt(weeklyEnvelope({
    baseNow: NOW,
    tokens: [{ Reward: 'SENT-TOKEN', Count: 1 }, { Reward: 'B', Count: 2 }],
  }));
  assert.deepEqual(noisy.inventory.EchoesHexConquestBonusTokensGiven, [0, 0]);
  assert.equal(JSON.stringify(noisy).includes('SENT-TOKEN'), false);
  const noisyDelta = diffAccountSnapshots(before, noisy);
  assert.equal(JSON.stringify(noisyDelta).includes('SENT-TOKEN'), false);
});

test('适配后快照不保留源对象引用，深度改动源快照不影响结果', () => {
  const envelope = fullEnvelope();
  const adapted = adapt(envelope);
  const frozen = JSON.stringify(adapted);
  // 输出容器全部新建（顶层、条目、嵌套对象/数组、日期包装）
  assert.notEqual(adapted.inventory, envelope);
  assert.notEqual(adapted.inventory.MiscItems, envelope.MiscItems);
  assert.notEqual(adapted.inventory.MiscItems[0], envelope.MiscItems[0]);
  assert.notEqual(adapted.inventory.Upgrades[0], envelope.Upgrades[0]);
  assert.notEqual(adapted.inventory.Affiliations, envelope.Affiliations);
  assert.notEqual(adapted.inventory.Affiliations[0], envelope.Affiliations[0]);
  assert.notEqual(adapted.inventory.Affiliations[0].WeeklyMissions, envelope.Affiliations[0].WeeklyMissions);
  assert.notEqual(adapted.inventory.Affiliations[0].WeeklyMissions[0], envelope.Affiliations[0].WeeklyMissions[0]);
  assert.notEqual(adapted.inventory.EndlessXP[0].Expiry, envelope.EndlessXP[0].Expiry);
  assert.notEqual(adapted.inventory.EndlessXP[0].Choices, envelope.EndlessXP[0].Choices);
  assert.notEqual(adapted.inventory.EndlessXP[0].PendingRewards, envelope.EndlessXP[0].PendingRewards);
  assert.notEqual(adapted.inventory.EndlessXP[0].PendingRewards[0].Rewards[0], envelope.EndlessXP[0].PendingRewards[0].Rewards[0]);
  assert.notEqual(adapted.inventory.CalendarProgress, envelope.CalendarProgress);
  assert.notEqual(adapted.inventory.CalendarProgress.SeasonProgress, envelope.CalendarProgress.SeasonProgress);
  assert.notEqual(adapted.inventory.CalendarProgress.YearProgress.Upgrades, envelope.CalendarProgress.YearProgress.Upgrades);
  assert.notEqual(adapted.inventory.RecentVendorPurchases[0].PurchaseHistory[0], envelope.RecentVendorPurchases[0].PurchaseHistory[0]);
  assert.notEqual(adapted.inventory.LastInventorySync, envelope.LastInventorySync);
  // 深度改动源快照（改值 / 加键 / 换元素 / 换数组）后适配结果逐字节不变
  envelope.MiscItems[0].ItemCount = 999;
  envelope.MiscItems[0].InjectedAfterAdapt = 'SENT-AFTER';
  envelope.MiscItems.push({ ItemType: ITEM_E, ItemCount: 5 });
  envelope.Affiliations[0].Standing = 1;
  envelope.Affiliations[0].WeeklyMissions[0].CompletedMission = false;
  envelope.EndlessXP[0].Earn = 0;
  envelope.EndlessXP[0].Choices.push('Excalibur');
  envelope.EndlessXP[0].PendingRewards[0].Rewards = [{ StoreItem: '/Lotus/Other' }];
  envelope.CalendarProgress.SeasonProgress.ActivatedChallenges.push('Z');
  envelope.CalendarProgress.Iteration = 99;
  envelope.RecentVendorPurchases = [];
  envelope.LastInventorySync.$oid = '000000000000000000000000';
  assert.equal(JSON.stringify(adapted), frozen);
  assert.equal(adapted.inventory.MiscItems.length, 1);
  assert.equal(adapted.inventory.MiscItems[0].ItemCount, 3);
  assert.equal(adapted.inventory.Affiliations[0].WeeklyMissions[0].CompletedMission, true);
});

test('旧版信封与新版信封经过同一条条目级投影', () => {
  const inventory = {
    LastInventorySync: { $oid: SYNC_OID },
    MiscItems: [withJunk({ ItemType: ITEM_A, ItemCount: 3 })],
    PlayerLevel: 30,
  };
  const legacyText = adapt({ InventoryJson: JSON.stringify(inventory) });
  const legacyObject = adapt({ InventoryJSON: inventory });
  const direct = adapt({ ...inventory });
  assert.deepEqual(legacyText.inventory, direct.inventory);
  assert.deepEqual(legacyObject.inventory, direct.inventory);
  assert.deepEqual(legacyText.inventory.MiscItems, [{ ItemType: ITEM_A, ItemCount: 3 }]);
  for (const adapted of [legacyText, legacyObject, direct]) {
    assert.equal(JSON.stringify(adapted).includes('SENT-'), false);
  }
});

// —— 2. 同步时间与字段元数据 ——

test('缺失/损坏的同步时间戳回退文件时间并标注依据', () => {
  const missing = adapt({ MiscItems: [] });
  assert.equal(missing.asOf, FILE_MTIME);
  assert.equal(missing.asOfBasis, 'file-mtime');
  assert.equal(missing.asOfNote, 'missing-sync-oid');
  assert.equal(missing.confidence, 'derived');
  assert.equal(missing.fields.MiscItems.asOf, FILE_MTIME);
  assert.equal(missing.fields.MiscItems.confidence, 'derived');
  assert.equal(missing.fields.MiscItems.freshness, 'unknown');

  const malformed = adapt({ MiscItems: [], LastInventorySync: { $oid: 'not-an-oid' } });
  assert.equal(malformed.asOf, FILE_MTIME);
  assert.equal(malformed.asOfNote, 'malformed-sync-oid');

  const zero = adapt({ MiscItems: [], LastInventorySync: { $oid: '000000000000000000000000' } });
  assert.equal(zero.asOf, FILE_MTIME);
  assert.equal(zero.asOfNote, 'zero-sync-oid');

  const unavailable = adapt({ MiscItems: [], LastInventorySync: { $oid: 'zz' } }, { fileMtime: 'not-a-date' });
  assert.equal(unavailable.asOf, null);
  assert.equal(unavailable.asOfBasis, 'unavailable');
  assert.equal(unavailable.confidence, 'unavailable');
  assert.equal(unavailable.fileMtime, null);
  assert.equal(unavailable.fields.MiscItems.freshness, 'unknown');
});

test('oid 与 24 位十六进制同步标记都按源同步时间解析', () => {
  const oidVariant = adapt({ MiscItems: [], LastInventorySync: { oid: SYNC_OID } });
  assert.equal(oidVariant.asOf, SYNC_AS_OF);
  assert.equal(oidVariant.asOfBasis, 'source-sync-oid');
  assert.equal(oidVariant.confidence, 'declared');
});

test('字段元数据标注来源、周期归属与可证明的新鲜度', () => {
  const adapted = adapt(weeklyEnvelope({ baseNow: NOW }));
  const fields = adapted.fields;
  assert.equal(fields.EndlessXP.source, ACCOUNT_SNAPSHOT_SOURCE);
  assert.equal(fields.EndlessXP.asOf, SYNC_AS_OF);
  assert.equal(fields.EndlessXP.cycle, 'weekly');
  assert.equal(fields.EndlessXP.cycleBasis, 'declared-expiry');
  assert.equal(fields.EndlessXP.boundaryAt, isoDay(NOW, 3));
  assert.equal(fields.EndlessXP.freshness, 'within-declared-cycle');
  // 科研分数字段本身没有周界，只能借同快照的重置时间
  assert.equal(fields.EntratiLabConquestCacheScoreMission.cycleBasis, 'sibling-reset');
  assert.equal(fields.EntratiLabConquestCacheScoreMission.boundaryAt, isoDay(NOW, 2));
  assert.equal(fields.EntratiVaultCountResetDate.cycleBasis, 'declared-reset');
  // 周序号不是时间戳：周期可归属，但不声称新鲜度
  assert.equal(fields.Affiliations.cycleBasis, 'week-index');
  assert.equal(fields.Affiliations.boundaryAt, null);
  assert.equal(fields.Affiliations.freshness, 'unknown');
  // 执行官的周属性只能靠公开世界状态 join，快照未声明
  assert.equal(fields.LastLiteSortieReward.cycleBasis, 'worldstate-join');
  assert.equal(fields.CalendarProgress.cycle, 'seasonal');
  assert.equal(fields.CalendarProgress.cycleBasis, 'declared-season');
  // 账号标量没有周期证据
  assert.equal(fields.PlayerLevel.cycle, 'none');
  assert.equal(fields.PlayerLevel.cycleBasis, 'not-declared');
  // 元数据只覆盖实际存在的白名单字段
  assert.equal(fields.WarframeMarketToken, undefined);
  assert.equal(adapted.fieldCount, Object.keys(fields).length);
  // 同输入同 now 完全一致
  assert.deepEqual(adapt(weeklyEnvelope({ baseNow: NOW })), adapted);
});

test('过期周期字段标为 past-declared-cycle，不冒充本周', () => {
  const adapted = adapt(weeklyEnvelope({
    baseNow: NOW,
    expiryIso: isoDay(NOW, -2),
    resetIso: isoDay(NOW, -1),
  }));
  assert.equal(adapted.fields.EndlessXP.freshness, 'past-declared-cycle');
  assert.equal(adapted.fields.DescentRewards.freshness, 'past-declared-cycle');
  assert.equal(adapted.fields.EntratiVaultCountResetDate.freshness, 'past-declared-cycle');
  assert.equal(adapted.fields.EntratiLabConquestCacheScoreMission.freshness, 'past-declared-cycle');
});

test('schema/version 合同：输出 v1，delta 拒绝外来版本', () => {
  const adapted = adapt({ MiscItems: [] });
  assert.equal(ACCOUNT_SNAPSHOT_SCHEMA_VERSION, 1);
  assert.equal(adapted.schemaVersion, ACCOUNT_SNAPSHOT_SCHEMA_VERSION);
  assert.equal(adapted.source, ACCOUNT_SNAPSHOT_SOURCE);
  assert.throws(() => diffAccountSnapshots(null, { ...adapted, schemaVersion: 2 }), /unsupported schemaVersion/u);
  assert.throws(() => diffAccountSnapshots({ ...adapted, schemaVersion: 2 }, adapted), /unsupported schemaVersion/u);
  assert.throws(() => diffAccountSnapshots(null, { ...adapted, source: 'other-source' }), /unsupported source/u);
  assert.throws(() => diffAccountSnapshots(null, null), /not an account snapshot/u);
});

// —— 3. 统一 delta ——

test('库存数量 delta：增/减/改/无变化，身份与顺序稳定', () => {
  const before = adapt({
    LastInventorySync: { $oid: SYNC_OID },
    MiscItems: [
      { ItemType: ITEM_A, ItemCount: 3 },
      { ItemType: ITEM_B, ItemCount: 1 },
      { ItemType: ITEM_C, ItemCount: 2 },
    ],
    RawUpgrades: [{ ItemType: '/Lotus/Types/Items/MiscItems/RawSame', ItemCount: 5 }],
    Upgrades: [{ ItemType: ITEM_F, UpgradeFingerprint: '{"lvl":0}' }, { ItemType: ITEM_F, UpgradeFingerprint: '{"lvl":1}' }],
  });
  const after = adapt({
    LastInventorySync: { $oid: SYNC_OID },
    MiscItems: [
      { ItemType: ITEM_A, ItemCount: 5 },
      { ItemType: ITEM_C, ItemCount: 2 },
      { ItemType: ITEM_E, ItemCount: 4 },
    ],
    RawUpgrades: [{ ItemType: '/Lotus/Types/Items/MiscItems/RawSame', ItemCount: 5 }],
    Upgrades: [{ ItemType: ITEM_F, UpgradeFingerprint: '{"lvl":0}' }],
  });
  const delta = diffAccountSnapshots(before, after);
  assert.equal(delta.baseline, false);
  assert.equal(delta.sameAsOf, true);
  assert.equal(delta.from.asOf, SYNC_AS_OF);
  assert.equal(delta.to.asOf, SYNC_AS_OF);
  assert.deepEqual(delta.events.map((event) => [event.id, event.change, event.from, event.to, event.delta]), [
    [`inventory-quantity:MiscItems:${ITEM_A}`, 'changed', 3, 5, 2],
    [`inventory-quantity:MiscItems:${ITEM_B}`, 'removed', 1, 0, -1],
    [`inventory-quantity:MiscItems:${ITEM_E}`, 'added', 0, 4, 4],
    // Upgrades 每条计 1（与 drops 计数口径一致）：仍存在但数量减少 = changed
    [`inventory-quantity:Upgrades:${ITEM_F}`, 'changed', 2, 1, -1],
  ]);
  for (const event of delta.events) {
    assert.equal(event.kind, 'inventory-quantity');
    assert.equal(event.cycle, 'none');
    assert.equal(event.source, ACCOUNT_SNAPSHOT_SOURCE);
    assert.equal(event.asOf, SYNC_AS_OF);
    assert.equal(event.fromAsOf, SYNC_AS_OF);
    assert.deepEqual(event.changedMetrics, []);
  }
  // 无变化 → 空事件；重复调用结果一致
  assert.deepEqual(diffAccountSnapshots(after, after).events, []);
  assert.deepEqual(diffAccountSnapshots(before, after), delta);
  // 首轮只建基线，不把整仓库存算成新增
  const baseline = diffAccountSnapshots(null, before);
  assert.equal(baseline.baseline, true);
  assert.equal(baseline.from, null);
  assert.deepEqual(baseline.events, []);
  assert.equal(baseline.totalEvents, 0);
});

test('周常 delta：标量与记录字段各自稳定成事件', () => {
  const before = adapt(weeklyEnvelope({ baseNow: NOW, challengeProgress: [{ Name: 'A', Progress: 1 }, { Name: 'GONE', Progress: 2 }] }));
  const after = adapt(weeklyEnvelope({
    baseNow: NOW,
    labScore: 40,
    circuitEarned: 200,
    kahlCompleted: true,
    vaultCount: 5,
    sortieId: 'SORTIE-B',
    tokens: [1, 2, 3],
    challengeProgress: [{ Name: 'A', Progress: 3 }],
    descentRewards: [
      { Category: 'DM_COH_NORMAL', Expiry: bsonDate(isoDay(NOW, 3)), FloorClaimed: 21, PendingRewards: [{ FloorCheckpoint: 21 }] },
      { Category: 'DM_COH_HARD', Expiry: bsonDate(isoDay(NOW, 3)), FloorClaimed: 0, PendingRewards: [{ FloorCheckpoint: 21 }] },
      { Category: 'DM_COH_NEW', Expiry: bsonDate(isoDay(NOW, 3)), FloorClaimed: 1, PendingRewards: [{ FloorCheckpoint: 7 }] },
    ],
  }));
  const delta = diffAccountSnapshots(before, after);
  const byId = new Map(delta.events.map((event) => [event.id, event]));
  const kahlEntity = `KahlSyndicate#${Math.floor((NOW - Date.UTC(2014, 1, 10)) / 604_800_000)}`;
  // 顺序：先标量（声明顺序），后记录（声明顺序 + 实体码点序）
  assert.deepEqual([...byId.keys()], [
    'weekly-scalar:EntratiLabConquestCacheScoreMission',
    'weekly-scalar:EntratiVaultCountLastPeriod',
    'weekly-scalar:LastLiteSortieReward',
    'weekly-scalar:EchoesHexConquestBonusTokensGiven',
    'weekly-record:EndlessXP:EXC_NORMAL',
    'weekly-record:DescentRewards:DM_COH_NEW',
    'weekly-record:DescentRewards:DM_COH_NORMAL',
    'weekly-record:ChallengeProgress:A',
    'weekly-record:ChallengeProgress:GONE',
    `weekly-record:Affiliations.WeeklyMissions:${kahlEntity}`,
  ]);

  assert.deepEqual([byId.get('weekly-scalar:EntratiLabConquestCacheScoreMission').from, byId.get('weekly-scalar:EntratiLabConquestCacheScoreMission').to], [34, 40]);
  assert.equal(byId.get('weekly-scalar:EntratiLabConquestCacheScoreMission').cycle, 'weekly');
  assert.deepEqual([byId.get('weekly-scalar:EntratiVaultCountLastPeriod').from, byId.get('weekly-scalar:EntratiVaultCountLastPeriod').to], [4, 5]);
  assert.deepEqual(byId.get('weekly-scalar:LastLiteSortieReward').from, { count: 1, sortieId: 'SORTIE-A' });
  assert.deepEqual(byId.get('weekly-scalar:LastLiteSortieReward').to, { count: 1, sortieId: 'SORTIE-B' });
  assert.deepEqual([byId.get('weekly-scalar:EchoesHexConquestBonusTokensGiven').from.count, byId.get('weekly-scalar:EchoesHexConquestBonusTokensGiven').to.count], [2, 3]);
  assert.notEqual(byId.get('weekly-scalar:EchoesHexConquestBonusTokensGiven').from.digest, byId.get('weekly-scalar:EchoesHexConquestBonusTokensGiven').to.digest);

  const circuit = byId.get('weekly-record:EndlessXP:EXC_NORMAL');
  assert.equal(circuit.kind, 'weekly-record');
  assert.equal(circuit.change, 'changed');
  assert.deepEqual(circuit.changedMetrics, ['earned']);
  assert.equal(circuit.from.earned, 100);
  assert.equal(circuit.to.earned, 200);
  assert.equal(circuit.to.goal, 1000);
  assert.equal(circuit.cycle, 'weekly');
  assert.equal(circuit.fromAsOf, SYNC_AS_OF);

  assert.deepEqual(byId.get('weekly-record:ChallengeProgress:A').changedMetrics, ['progress']);
  assert.deepEqual(byId.get('weekly-record:ChallengeProgress:GONE').change, 'removed');
  assert.equal(byId.get('weekly-record:ChallengeProgress:GONE').to, null);
  assert.deepEqual(byId.get(`weekly-record:Affiliations.WeeklyMissions:${kahlEntity}`).changedMetrics, ['completed']);

  const added = byId.get('weekly-record:DescentRewards:DM_COH_NEW');
  assert.equal(added.change, 'added');
  assert.equal(added.from, null);
  assert.deepEqual(added.to, { expiry: isoDay(NOW, 3), claimed: 1, goal: 7 });
  // 未变化的字段不产生事件（时光科研分数、无尽回廊钢铁、日历）
  for (const id of [
    'weekly-scalar:EchoesHexConquestCacheScoreMission',
    'weekly-scalar:EntratiVaultCountResetDate',
    'weekly-record:EndlessXP:EXC_HARD',
    'weekly-record:CalendarProgress:season',
  ]) assert.equal(byId.has(id), false, id);
});

test('列表摘要识别内容变化（条数与摘要都变），且不携带列表元素', () => {
  // 元素级投影把令牌收敛为有限数字，因此这里验证的是内容变化本身：
  // 同长度不同内容必须产生事件且摘要不同，事件里仍只有 count/digest。
  const before = adapt(weeklyEnvelope({ baseNow: NOW, tokens: [1, 2] }));
  const same = adapt(weeklyEnvelope({ baseNow: NOW, tokens: [2, 1] }));
  assert.equal(
    diffAccountSnapshots(before, same).events.some((event) => event.field === 'EchoesHexConquestBonusTokensGiven'),
    false,
  );

  const changed = adapt(weeklyEnvelope({ baseNow: NOW, tokens: [1, 3] }));
  const event = diffAccountSnapshots(before, changed).events
    .find((candidate) => candidate.field === 'EchoesHexConquestBonusTokensGiven');
  assert.ok(event);
  assert.equal(event.from.count, 2);
  assert.equal(event.to.count, 2);
  assert.notEqual(event.from.digest, event.to.digest);
  assert.deepEqual(Object.keys(event.from), ['count', 'digest']);
  assert.deepEqual(Object.keys(event.to), ['count', 'digest']);
  assert.equal(JSON.stringify(event).includes('Reward'), false);

  const grown = adapt(weeklyEnvelope({ baseNow: NOW, tokens: [1, 2, 3] }));
  const grownEvent = diffAccountSnapshots(before, grown).events
    .find((candidate) => candidate.field === 'EchoesHexConquestBonusTokensGiven');
  assert.deepEqual([grownEvent.from.count, grownEvent.to.count], [2, 3]);
  assert.notEqual(grownEvent.from.digest, grownEvent.to.digest);
});

test('delta 事件不含原始快照或无关字段，且有稳定上限', () => {
  const secret = { WarframeMarketToken: 'SENTINEL-TOKEN', FutureUnknownField: 'SENTINEL-FUTURE' };
  // 条目级/多层 sentinel：delta 只输出既有脱敏投影，不能因嵌套投影把条目内容带出来
  const nested = {
    MiscItems: [{ ItemType: ITEM_A, ItemCount: 1, InstanceId: 'SENTINEL-INSTANCE' }],
    Upgrades: [{ ItemType: ITEM_F, UpgradeFingerprint: '{"lvl":0}', OwnerId: 'SENTINEL-OWNER' }],
    EndlessXP: [{
      Category: 'EXC_NORMAL',
      Earn: 100,
      Extra: 'SENTINEL-XP',
      PendingRewards: [{ RequiredTotalXp: 1_000, Secret: 'SENTINEL-NODE' }],
    }],
  };
  const before = adapt({ LastInventorySync: { $oid: SYNC_OID }, ...nested, ...secret });
  const after = adapt({
    LastInventorySync: { $oid: SYNC_OID },
    ...nested,
    MiscItems: [{ ItemType: ITEM_A, ItemCount: 2, InstanceId: 'SENTINEL-INSTANCE' }],
    ...secret,
  });
  const delta = diffAccountSnapshots(before, after);
  assert.equal(delta.events.length, 1);
  const event = delta.events[0];
  assert.deepEqual(Object.keys(event), [
    'id', 'kind', 'field', 'entity', 'change', 'from', 'to', 'delta', 'changedMetrics',
    'source', 'asOf', 'fromAsOf', 'cycle',
  ]);
  const serialized = JSON.stringify(delta);
  for (const sentinel of ['SENTINEL-TOKEN', 'SENTINEL-FUTURE', 'SENTINEL-INSTANCE', 'SENTINEL-OWNER', 'SENTINEL-XP', 'SENTINEL-NODE']) {
    assert.equal(serialized.includes(sentinel), false, sentinel);
  }
  assert.equal(serialized.includes('UpgradeFingerprint'), false);
  assert.deepEqual(Object.keys(delta.from), ['schemaVersion', 'source', 'asOf', 'asOfBasis']);

  const manyBefore = adapt({
    LastInventorySync: { $oid: SYNC_OID },
    MiscItems: Array.from({ length: MAX_DELTA_EVENTS + 20 }, (_, index) => ({ ItemType: `/Lotus/Item/${String(index).padStart(4, '0')}`, ItemCount: 1 })),
  });
  const manyAfter = adapt({
    LastInventorySync: { $oid: SYNC_OID },
    MiscItems: Array.from({ length: MAX_DELTA_EVENTS + 20 }, (_, index) => ({ ItemType: `/Lotus/Item/${String(index).padStart(4, '0')}`, ItemCount: 2 })),
  });
  const bounded = diffAccountSnapshots(manyBefore, manyAfter);
  assert.equal(bounded.totalEvents, MAX_DELTA_EVENTS + 20);
  assert.equal(bounded.events.length, MAX_DELTA_EVENTS);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.events[0].entity, '/Lotus/Item/0000');
  const limited = diffAccountSnapshots(manyBefore, manyAfter, { limit: 0 });
  assert.deepEqual(limited.events, []);
  assert.equal(limited.truncated, true);
  assert.deepEqual(diffAccountSnapshots(manyBefore, manyAfter), bounded);
});

// —— 4. lastData 读路径集成与兼容性 ——

test('readSnapshot 走版本化适配器，且消费方输出与适配前一致', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'warframe-account-snapshot-'));
  try {
    const envelope = weeklyEnvelope();
    envelope.WarframeMarketToken = 'SENTINEL-TOKEN';
    envelope.AccountId = 'SENTINEL-ACCOUNT';
    // 条目级/多层注入未知字段：消费方输出必须逐字节不变，但快照里不得留痕
    envelope.MiscItems = [withJunk({ ItemType: ITEM_A, ItemCount: 2 })];
    envelope.Affiliations = [withJunk({
      Tag: 'KahlSyndicate',
      Standing: 12_000,
      Title: 2,
      WeeklyMissions: [withJunk({
        WeekCount: Math.floor((Date.now() - Date.UTC(2014, 1, 10)) / 604_800_000),
        CompletedMission: true,
      })],
    })];
    envelope.EndlessXP = [withJunk({
      Category: 'EXC_NORMAL',
      Expiry: bsonDate(isoDay(Date.now(), 3)),
      Earn: 100,
      Claim: 20,
      Choices: ['Mesa'],
      PendingRewards: [withJunk({
        RequiredTotalXp: 1_000,
        Rewards: [withJunk({ StoreItem: '/Lotus/StoreItems/TestReward', ItemCount: 2 })],
      })],
    })];
    envelope.CalendarProgress = withJunk({
      Iteration: 4,
      SeasonProgress: withJunk({ SeasonType: 'CST_WINTER', LastCompletedDayIdx: 1, ActivatedChallenges: ['A'] }),
      YearProgress: withJunk({ Upgrades: ['U1'] }),
    });
    await writeFile(path.join(dir, 'lastData.dat'), JSON.stringify(envelope), 'utf8');
    const snapshot = await readSnapshot(dir);
    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.alecaDir, dir);
    assert.equal(snapshot.envelope, undefined);
    assert.equal(snapshot.syncedAt, SYNC_AS_OF);
    assert.equal(snapshot.fields.EntratiLabConquestCacheScoreMission.cycleBasis, 'sibling-reset');
    const serialized = JSON.stringify(snapshot);
    for (const sentinel of [
      'SENTINEL-TOKEN', 'SENTINEL-ACCOUNT', 'SENT-INSTANCE', 'SENT-OWNER',
      'SENT-TOKEN', 'SENT-FUTURE',
    ]) assert.equal(serialized.includes(sentinel), false, sentinel);
    // 条目级投影确实生效（同一份数据里，只保留消费键）
    assert.deepEqual(snapshot.inventory.MiscItems, [{ ItemType: ITEM_A, ItemCount: 2 }]);
    assert.equal(snapshot.inventory.EndlessXP[0].PendingRewards[0].Rewards[0].OwnerId, undefined);

    const adaptedPanel = await weeklyEvidence(snapshot);
    assert.equal(adaptedPanel.data.rows.length, 11);
    assert.equal(adaptedPanel.data.rows.find((row) => row.name === '深层科研').value, '34 研究点');
    assert.equal(adaptedPanel.data.rows.find((row) => row.name === '时光科研').value, '34 研究点');
    assert.match(adaptedPanel.text, /这些数据只用于辅助判断/u);

    // 兼容性：同一份数据，适配前（原始库存对象）与适配后周常面板逐字节一致
    const rawPanel = await weeklyEvidence({ syncedAt: SYNC_AS_OF, inventory: envelope });
    assert.deepEqual(adaptedPanel, rawPanel);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readSnapshot 对缺失快照文件保持原有失败语义', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'warframe-account-snapshot-missing-'));
  try {
    await assert.rejects(() => readSnapshot(dir), /ENOENT/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// —— 5. 消费方字段覆盖合同 ——

// 商店已购标记（vendor-shop 三档判定）既不是库存数量也不是周常字段，
// 因此不进 delta，但必须留在适配后的快照里，否则「商店」已购标记会静默消失。
test('商店购买记录保留在快照中，只标注源数据声明的边界', () => {
  const adapted = adapt({
    MiscItems: [],
    RecentVendorPurchases: [{
      VendorType: 'Teshin',
      PurchaseHistory: [{ Expiry: bsonDate(isoDay(NOW, 4)), ItemId: SYNC_OID, NumPurchased: 2 }],
    }],
  });
  assert.equal(adapted.inventory.RecentVendorPurchases.length, 1);
  assert.equal(adapted.fields.RecentVendorPurchases.cycle, 'none');
  assert.equal(adapted.fields.RecentVendorPurchases.cycleBasis, 'declared-expiry');
  assert.equal(adapted.fields.RecentVendorPurchases.boundaryAt, isoDay(NOW, 4));
  assert.equal(adapted.fields.RecentVendorPurchases.freshness, 'within-declared-cycle');
});

// 消费方行为合同：同一份合成数据分别喂「原始库存对象」与「适配后快照」，受影响模块的
// 纯函数输出必须一致——证明条目级投影没有删掉任何被真正读取的键。
test('受影响消费方在适配前后输出一致（掉落/周常核销/赏金声望/商店已购/父成品持有）', async () => {
  const [{ countInventory }, { annotateParentOwnership }, { attachBountyStanding }, { vendorPurchases }, { evaluateAutoCheck }] = await Promise.all([
    import('./drops.mjs'),
    import('./alecaframe.mjs'),
    import('./bounties.mjs'),
    import('./vendor-shop.mjs'),
    import('./weekly.mjs'),
  ]);
  const expiry = bsonDate(isoDay(NOW, 4));
  const weekCount = Math.floor((NOW - Date.UTC(2014, 1, 10)) / 604_800_000);
  const raw = {
    LastInventorySync: withJunk({ $oid: SYNC_OID }),
    // 第三条没有 ItemCount：掉落计数必须仍按 1 件计
    MiscItems: [withJunk({ ItemType: ITEM_A, ItemCount: 1 }), withJunk({ ItemType: ITEM_B, ItemCount: 4 }), withJunk({ ItemType: ITEM_C })],
    Recipes: [withJunk({ ItemType: '/Lotus/Types/Recipes/Weapons/GunBarrelBlueprint', ItemCount: 2 })],
    FusionTreasures: [withJunk({ ItemType: '/Lotus/Types/Items/FusionTreasures/FusionTreasure', ItemCount: 3 })],
    RawUpgrades: [withJunk({ ItemType: '/Lotus/Upgrades/Mods/Raw/RawMod', ItemCount: 5 })],
    Upgrades: [
      withJunk({ ItemType: ITEM_F, UpgradeFingerprint: '{"lvl":2}' }),
      withJunk({ ItemType: ITEM_F, UpgradeFingerprint: '{"lvl":0}' }),
    ],
    Suits: [withJunk({ ItemType: '/Lotus/Powersuits/Wukong/WukongPrime' })],
    Affiliations: [
      withJunk({
        Tag: 'CetusSyndicate',
        Standing: 44_000,
        Title: 5,
        WeeklyMissions: [withJunk({ WeekCount: weekCount, CompletedMission: false })],
      }),
      withJunk({
        Tag: 'KahlSyndicate',
        Standing: 12_000,
        Title: 2,
        WeeklyMissions: [withJunk({ WeekCount: weekCount, CompletedMission: true })],
      }),
    ],
    DailyAffiliationCetus: 12_345,
    EntratiVaultCountResetDate: bsonDate(isoDay(NOW, 2)),
    EntratiVaultCountLastPeriod: 4,
    LastLiteSortieReward: [withJunk({ SortieId: { $oid: 'SORTIE-A' }, StoreItem: '/Lotus/x', Manifest: {} })],
    ChallengeProgress: [withJunk({ Name: 'SeasonWeeklyHardCompleteConquest', Progress: 1 })],
    CalendarProgress: withJunk({
      Iteration: 4,
      SeasonProgress: withJunk({ SeasonType: 'CST_WINTER', LastCompletedDayIdx: 1, ActivatedChallenges: ['A'] }),
    }),
    EndlessXP: [withJunk({
      Category: 'EXC_NORMAL',
      Expiry: expiry,
      Earn: 100,
      Claim: 20,
      Choices: ['Mesa'],
      PendingRewards: [withJunk({ RequiredTotalXp: 1_000 })],
    })],
    DescentRewards: [withJunk({ Category: 'DM_COH_NORMAL', Expiry: expiry, FloorClaimed: 9, PendingRewards: [withJunk({ FloorCheckpoint: 21 })] })],
    EntratiLabConquestUnlocked: 1,
    EntratiLabConquestCacheScoreMission: 34,
    RecentVendorPurchases: [withJunk({
      VendorType: 'Teshin',
      PurchaseHistory: [withJunk({ Expiry: expiry, ItemId: VENDOR_ITEM_ID, NumPurchased: 2 })],
    })],
    RegularCredits: 1_000_000,
  };
  const adapted = adapt(raw).inventory;
  assert.equal(JSON.stringify(adapted).includes('SENT-'), false);

  // drops：库存数量基线（含 Upgrades 每条计 1）
  assert.deepEqual(countInventory(adapted), countInventory(raw));
  // alecaframe：父成品持有判定（装备栏 ItemType）
  const entries = [{ uniqueName: ITEM_A, parentUniqueName: '/Lotus/Powersuits/Wukong/WukongPrime' }];
  assert.deepEqual(annotateParentOwnership(entries, adapted), annotateParentOwnership(entries, raw));
  assert.equal(annotateParentOwnership(entries, adapted)[0].parentOwned, true);
  // bounties：赏金卡声望列（总声望 + 等级 + 今日余量），每次用新的卡数据对象
  const bountyData = () => ({ places: [{ key: 'cetus' }], boards: [] });
  assert.deepEqual(attachBountyStanding(bountyData(), adapted), attachBountyStanding(bountyData(), raw));
  // vendor-shop：商店已购三档判定的输入（VendorType/Expiry/ItemId/NumPurchased）
  assert.deepEqual(vendorPurchases(adapted, 'Teshin'), vendorPurchases(raw, 'Teshin'));
  assert.equal(vendorPurchases(adapted, 'Teshin').length, 1);
  // weekly：周常自动核销判定（卡尔 WeekCount/完成标记、科研分数、衰退室、回廊轨道）
  const autoArgs = [null, NOW, null, new Date(NOW).toISOString(), {}];
  const adaptedAuto = evaluateAutoCheck(adapted, ...autoArgs);
  assert.deepEqual(adaptedAuto, evaluateAutoCheck(raw, ...autoArgs));
  assert.equal(adaptedAuto.auto.kahl, true);
});

// R15 第四片源码合同：业务模块不得再直接书写 AlecaFrame 原始字段名。
// 边界模块（信封/白名单/投影 + 语义映射）是唯一豁免；测试 fixture 天然豁免（本文件不在名单内）。
const BOUNDARY_SOURCE_FILES = new Set(['account-snapshot.mjs', 'account-view.mjs']);
const CONSUMER_SOURCE_FILES = [
  'alecaframe.mjs', 'bounties.mjs', 'drops.mjs', 'rivens.mjs', 'rotation-calendar.mjs',
  'shortcuts.mjs', 'subscriptions.mjs', 'trader-shopping.mjs', 'vendor-shop.mjs',
  'warframe-cards.mjs', 'weekly-mega-card.mjs', 'weekly.mjs',
];
// 账号条目/嵌套层的独有键：与厂商清单（ExportVendors）等其它数据源不重名，可全局限定。
const ACCOUNT_NESTED_KEYS = [
  'UpgradeFingerprint', 'WeeklyMissions', 'WeekCount', 'CompletedMission',
  'FloorClaimed', 'FloorCheckpoint', 'RequiredTotalXp', 'PurchaseHistory', 'VendorType',
  'NumPurchased', 'LastCompletedDayIdx', 'ActivatedChallenges', 'SeasonProgress',
  'YearProgress', 'SeasonType', 'SortieId', 'LastInventorySync',
];
// 条目键同时是官方厂商清单的键（price.ItemType / price.ItemCount），因此只禁止
// 「从账号来源读取」这一种写法：接收者链里出现 inventory/account/snapshot 才算越界。
const ACCOUNT_ENTRY_KEYS = new Set(['ItemType', 'ItemCount']);
const ACCOUNT_RECEIVER = /(?:^|[^\w$])([A-Za-z_$][\w$]*)((?:\??\.[A-Za-z_$][\w$]*)+)/gu;
const ACCOUNT_RECEIVER_SEGMENT = /^(?:inventory|Inventory|account|Account|snapshot|Snapshot)$/u;

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/^\s*\/\/.*$/gmu, ' ');
}

async function consumerSource(name) {
  const text = await readFile(new URL(`./${name}`, import.meta.url), 'utf8');
  return stripComments(text);
}

function occurrences(source, field) {
  const member = new RegExp(`\\.${field}\\b`, 'gu');
  const literal = new RegExp(`(['"\`])${field}\\1`, 'gu');
  return (source.match(member) || []).length + (source.match(literal) || []).length;
}

test('源码合同：业务模块不再出现任何 AlecaFrame 快照顶层字段名', async () => {
  assert.equal(BOUNDARY_SOURCE_FILES.has('account-view.mjs'), true);
  const violations = [];
  for (const name of CONSUMER_SOURCE_FILES) {
    assert.equal(BOUNDARY_SOURCE_FILES.has(name), false, `${name} 不能同时是边界模块与业务模块`);
    const source = await consumerSource(name);
    for (const field of ACCOUNT_SNAPSHOT_ALLOWLIST) {
      if (occurrences(source, field)) violations.push(`${name}: ${field}`);
    }
  }
  assert.deepEqual(violations, []);
});

test('源码合同：业务模块不再出现账号条目/嵌套层原始键名', async () => {
  const violations = [];
  for (const name of CONSUMER_SOURCE_FILES) {
    const source = await consumerSource(name);
    for (const field of ACCOUNT_NESTED_KEYS) {
      if (occurrences(source, field)) violations.push(`${name}: ${field}`);
    }
  }
  assert.deepEqual(violations, []);
});

test('源码合同：账号条目键只能出现在其它数据源语境，不能从账号来源读取', async () => {
  const violations = [];
  for (const name of CONSUMER_SOURCE_FILES) {
    const source = await consumerSource(name);
    for (const match of source.matchAll(ACCOUNT_RECEIVER)) {
      const chain = [match[1], ...match[2].split('.')].map((segment) => segment.replace(/^\?/u, ''));
      if (!ACCOUNT_ENTRY_KEYS.has(chain.at(-1))) continue;
      if (chain.slice(0, -1).some((segment) => ACCOUNT_RECEIVER_SEGMENT.test(segment))) {
        violations.push(`${name}: ${chain.join('.')}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('字段映射完整：白名单 100% 有语义出口，且边界不多读任何字段', async () => {
  const { ACCOUNT_VIEW_RAW_TOP_LEVEL_FIELDS } = await import('./account-view.mjs');
  assert.deepEqual([...ACCOUNT_VIEW_RAW_TOP_LEVEL_FIELDS].sort(), [...ACCOUNT_SNAPSHOT_ALLOWLIST].sort());
  assert.equal(new Set(ACCOUNT_VIEW_RAW_TOP_LEVEL_FIELDS).size, ACCOUNT_VIEW_RAW_TOP_LEVEL_FIELDS.length);
});
