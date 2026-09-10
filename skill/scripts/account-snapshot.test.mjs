import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ACCOUNT_SNAPSHOT_ALLOWLIST, ACCOUNT_SNAPSHOT_SCHEMA_VERSION, ACCOUNT_SNAPSHOT_SOURCE,
  MAX_DELTA_EVENTS, adaptAccountSnapshot, diffAccountSnapshots,
} from './account-snapshot.mjs';
import { readSnapshot, weeklyEvidence } from './alecaframe.mjs';

// R15 第二片合同（全部为合成数据，不读真实 AlecaFrame 文件、不联网、不落盘 delta）：
//   1. 旧/新信封形状与白名单剥离
//   2. asOf/同步时间与字段元数据（来源/周期/可信度/新鲜度）
//   3. 统一 delta 的稳定身份、顺序、增/减/改/无变化与上限
//   4. 适配器接入 lastData 读路径后，周常证据面板仍是原 11 项

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

test('白名单只作用于顶层：条目内部字段原样保留（本片边界）', () => {
  // 现有消费方直接读条目字段（ItemType/ItemCount/UpgradeFingerprint…），
  // 二次投影会改变用户输出；条目级投影留给后续切片，这里固定该边界。
  const adapted = adapt({ MiscItems: [{ ItemType: ITEM_A, ItemCount: 4, InstanceId: 'INSTANCE-1' }] });
  assert.deepEqual(adapted.inventory.MiscItems[0], { ItemType: ITEM_A, ItemCount: 4, InstanceId: 'INSTANCE-1' });
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

test('列表摘要能识别对象内容变化，且忽略对象键序与列表顺序', () => {
  const before = adapt(weeklyEnvelope({
    baseNow: NOW,
    tokens: [{ Reward: 'A', Count: 1 }, { Reward: 'B', Count: 2 }],
  }));
  const reordered = adapt(weeklyEnvelope({
    baseNow: NOW,
    tokens: [{ Count: 2, Reward: 'B' }, { Count: 1, Reward: 'A' }],
  }));
  assert.equal(
    diffAccountSnapshots(before, reordered).events.some((event) => event.field === 'EchoesHexConquestBonusTokensGiven'),
    false,
  );

  const changed = adapt(weeklyEnvelope({
    baseNow: NOW,
    tokens: [{ Reward: 'A', Count: 1 }, { Reward: 'B', Count: 3 }],
  }));
  const event = diffAccountSnapshots(before, changed).events
    .find((candidate) => candidate.field === 'EchoesHexConquestBonusTokensGiven');
  assert.ok(event);
  assert.equal(event.from.count, 2);
  assert.equal(event.to.count, 2);
  assert.notEqual(event.from.digest, event.to.digest);
  assert.equal(JSON.stringify(event).includes('Reward'), false);
});

test('delta 事件不含原始快照或无关字段，且有稳定上限', () => {
  const secret = { WarframeMarketToken: 'SENTINEL-TOKEN', FutureUnknownField: 'SENTINEL-FUTURE' };
  const before = adapt({ LastInventorySync: { $oid: SYNC_OID }, MiscItems: [{ ItemType: ITEM_A, ItemCount: 1 }], ...secret });
  const after = adapt({ LastInventorySync: { $oid: SYNC_OID }, MiscItems: [{ ItemType: ITEM_A, ItemCount: 2 }], ...secret });
  const delta = diffAccountSnapshots(before, after);
  assert.equal(delta.events.length, 1);
  const event = delta.events[0];
  assert.deepEqual(Object.keys(event), [
    'id', 'kind', 'field', 'entity', 'change', 'from', 'to', 'delta', 'changedMetrics',
    'source', 'asOf', 'fromAsOf', 'cycle',
  ]);
  const serialized = JSON.stringify(delta);
  assert.equal(serialized.includes('SENTINEL-'), false);
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
    await writeFile(path.join(dir, 'lastData.dat'), JSON.stringify(envelope), 'utf8');
    const snapshot = await readSnapshot(dir);
    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.alecaDir, dir);
    assert.equal(snapshot.envelope, undefined);
    assert.equal(snapshot.syncedAt, SYNC_AS_OF);
    assert.equal(JSON.stringify(snapshot).includes('SENTINEL-TOKEN'), false);
    assert.equal(snapshot.fields.EntratiLabConquestCacheScoreMission.cycleBasis, 'sibling-reset');

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

const CONSUMER_SOURCE_FILES = [
  'alecaframe.mjs', 'bounties.mjs', 'drops.mjs', 'rivens.mjs', 'rotation-calendar.mjs',
  'shortcuts.mjs', 'subscriptions.mjs', 'trader-shopping.mjs', 'vendor-shop.mjs',
  'warframe-cards.mjs', 'weekly-mega-card.mjs', 'weekly.mjs',
];
// 同名字段但不是账号快照：state.inventory.length（奸商货单行）与聚合对象上的 count
const NON_SNAPSHOT_PROPERTIES = new Set(['count', 'length']);

async function consumerSource(name) {
  const text = await readFile(new URL(`./${name}`, import.meta.url), 'utf8');
  return text.replace(/^\s*\/\/.*$/gmu, '');
}

function stringArrayConstant(source, constant) {
  const block = source.match(new RegExp(`const ${constant} = \\[([\\s\\S]*?)\\];`, 'u'));
  assert.ok(block, `${constant} not found in consumer source`);
  return [...block[1].matchAll(/'([^']+)'/gu)].map((match) => match[1]);
}

test('白名单覆盖消费方读取的全部快照字段（兼容性合同）', async () => {
  const consumed = new Set();
  for (const name of CONSUMER_SOURCE_FILES) {
    const source = await consumerSource(name);
    for (const match of source.matchAll(/(?:[A-Za-z_$][\w$]*\??\.)*inventory\??\.([A-Za-z_][A-Za-z0-9_]*)/gu)) {
      if (!NON_SNAPSHOT_PROPERTIES.has(match[1])) consumed.add(match[1]);
    }
  }
  const alecaSource = await consumerSource('alecaframe.mjs');
  for (const constant of ['ACCOUNT_GROUPS', 'EQUIPMENT_GROUPS']) {
    for (const field of stringArrayConstant(alecaSource, constant)) consumed.add(field);
  }
  for (const field of stringArrayConstant(await consumerSource('drops.mjs'), 'COUNTED_GROUPS')) consumed.add(field);
  for (const field of stringArrayConstant(await consumerSource('trader-shopping.mjs'), 'OWNED_GROUPS')) consumed.add(field);
  for (const match of (await consumerSource('bounties.mjs')).matchAll(/dailyKey: '([A-Za-z]+)'/gu)) consumed.add(match[1]);
  // 动态模板键：inventory[`${kind}ConquestUnlocked`] / CacheScoreMission
  for (const kind of ['EntratiLab', 'EchoesHex']) {
    consumed.add(`${kind}ConquestUnlocked`);
    consumed.add(`${kind}ConquestCacheScoreMission`);
  }
  assert.ok(consumed.size >= 40, `consumer field scan too small: ${consumed.size}`);
  assert.deepEqual([...consumed].filter((field) => !ACCOUNT_SNAPSHOT_ALLOWLIST.includes(field)).sort(), []);
});
