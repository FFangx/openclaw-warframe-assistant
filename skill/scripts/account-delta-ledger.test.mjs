import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ACCOUNT_DELTA_BASELINE_FIELDS, ACCOUNT_DELTA_QUANTITY_FIELDS, adaptAccountSnapshot,
} from './account-snapshot.mjs';
import { INVENTORY_SCOPES, inventoryScopeSources } from './account-view.mjs';
import {
  DELTA_LEDGER_CONSUMERS, DELTA_LEDGER_DEGRADED, DELTA_LEDGER_FILE_NAME, DELTA_LEDGER_SCHEMA_VERSION,
  MAX_LEDGER_EVENTS, MAX_LEDGER_EVENTS_BYTES, MAX_LEDGER_EVENT_AGE_MS,
  createDeltaLedger, defaultDeltaLedgerPath, ledgerBusyError,
} from './account-delta-ledger.mjs';

// R15 第五片专项合同：本地 delta 账本的边界、故障注入与隐私/容量上限。
// 全部落在临时目录，不触碰真实 AlecaFrame lastData.dat / deltas.dat 与助手状态目录。

const ITEM = '/Lotus/Types/Items/MiscItems/OrokinCell';
const MOD = '/Lotus/Upgrades/Mods/Rifle/ExpertiseMod';
const CONQUEST = 'EntratiLabConquestCacheScoreMission';
const DROPS = DELTA_LEDGER_CONSUMERS.DROPS;
const WEEKLY = DELTA_LEDGER_CONSUMERS.WEEKLY;
const CLOCK_MS = Date.parse('2026-08-20T00:00:00Z');
const SYNC_SECONDS = CLOCK_MS / 1000;

const oidOf = (seconds) => `${Math.floor(seconds).toString(16).padStart(8, '0')}${'0'.repeat(16)}`;

// 快照夹具：只含 delta 关心的字段 + 真实 lastData 里会被适配器丢掉的敏感字段
function envelopeOf({ seconds = SYNC_SECONDS, count = 3, mods = 1, score = 21, resetAt = null } = {}) {
  const inventory = {
    LastInventorySync: { $oid: oidOf(seconds) },
    MiscItems: [{ ItemType: ITEM, ItemCount: count, _id: { $oid: 'deadbeefdeadbeefdeadbeef' } }],
    RawUpgrades: Array.from({ length: mods }, (_, index) => ({ ItemType: MOD, UpgradeFingerprint: JSON.stringify({ lvl: index }) })),
    [CONQUEST]: score,
  };
  if (resetAt != null) {
    inventory.EntratiVaultCountResetDate = { $date: { $numberLong: String(resetAt) } };
    inventory.EntratiVaultCountLastPeriod = 5;
  }
  return inventory;
}

const snapshotOf = (options = {}) => adaptAccountSnapshot(envelopeOf(options), { now: CLOCK_MS, fileMtimeMs: CLOCK_MS });

async function tempLedger(options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'warframe-delta-ledger-'));
  const statePath = path.join(dir, DELTA_LEDGER_FILE_NAME);
  const ledger = createDeltaLedger({ statePath, clock: () => CLOCK_MS, ...options });
  const read = async () => JSON.parse(await readFile(statePath, 'utf8'));
  return { dir, statePath, ledger, read };
}

// ---------- 上限与路径合同 ----------

test('事件上限是明确常量：条数 / 体积 / 保留期', () => {
  assert.equal(DELTA_LEDGER_SCHEMA_VERSION, 1);
  assert.equal(DELTA_LEDGER_FILE_NAME, 'warframe-account-delta-ledger.json');
  assert.equal(MAX_LEDGER_EVENTS, 512);
  assert.equal(MAX_LEDGER_EVENTS_BYTES, 256 * 1024);
  assert.equal(MAX_LEDGER_EVENT_AGE_MS, 7 * 24 * 60 * 60 * 1000);
});

test('默认账本路径位于助手自身状态目录，与 drops/weekly 状态文件同目录', () => {
  const stateDir = path.join(os.tmpdir(), 'state');
  const expected = path.join(stateDir, DELTA_LEDGER_FILE_NAME);
  assert.equal(defaultDeltaLedgerPath(path.join(stateDir, 'warframe-drops.json')), expected);
  assert.equal(defaultDeltaLedgerPath(path.join(stateDir, 'warframe-weekly.json')), expected);
});

test('合同：账本数量事件组与 drops 计数作用域同源，基线字段都是 delta 必需字段', () => {
  // 两边一旦漂移，drops 就会漏掉落或把别的组当成掉落
  assert.deepEqual(
    [...ACCOUNT_DELTA_QUANTITY_FIELDS].sort(),
    [...inventoryScopeSources(INVENTORY_SCOPES.DROP_MONITOR)].sort(),
  );
  assert.ok(ACCOUNT_DELTA_BASELINE_FIELDS.includes('MiscItems'));
  assert.ok(ACCOUNT_DELTA_BASELINE_FIELDS.includes('EndlessXP'));
  // 账号同步 oid、装备栏、宠物等与 delta 无关的字段不进基线
  for (const field of ['LastInventorySync', 'KubrowPets', 'LongGuns', 'ActiveAvatarImageType']) {
    assert.equal(ACCOUNT_DELTA_BASELINE_FIELDS.includes(field), false, field);
  }
});

// ---------- 首次基线 / 幂等 ----------

test('首次入库只建基线不造事件；同一快照重复入库幂等且不改写文件', async () => {
  const { statePath, ledger } = await tempLedger();
  const first = await ledger.ingest(snapshotOf({ count: 3 }));
  assert.equal(first.ok, true);
  assert.equal(first.baselineCreated, true);
  assert.equal(first.appended, 0);
  assert.equal(first.events, 0);

  const bytesAfterFirst = await readFile(statePath, 'utf8');
  const statusAfterFirst = await ledger.status();
  assert.equal(statusAfterFirst.baselinePresent, true);
  assert.equal(statusAfterFirst.events, 0);
  assert.equal(statusAfterFirst.nextSeq, 1);

  // 重复快照：不产生事件、不改写文件（updatedAt 也不动）
  const repeat = await ledger.ingest(snapshotOf({ count: 3 }));
  assert.equal(repeat.unchanged, true);
  assert.equal(repeat.appended, 0);
  assert.equal(repeat.baselineCreated, false);
  assert.equal(await readFile(statePath, 'utf8'), bytesAfterFirst);

  // 两个固定消费者已随首个基线一起注册。
  const batch = await ledger.read(DROPS);
  assert.equal(batch.initialized, false);
  assert.deepEqual(batch.eventIds, []);
  assert.equal(batch.baselinePresent, true);
});

test('两个固定消费者随基线同时注册；晚读取者仍看到同一批事件', async () => {
  const { ledger } = await tempLedger();
  await ledger.ingest(snapshotOf({ count: 3 }));
  // drops 先接入（水位 0）：之后的变化它会看到
  assert.deepEqual((await ledger.read(DROPS)).eventIds, []);
  await ledger.ingest(snapshotOf({ count: 6, seconds: SYNC_SECONDS + 60 }));
  const drops = await ledger.read(DROPS);
  assert.equal(drops.eventIds.length, 1);
  // weekly 虽然晚读，仍从自己的 0 游标看到同一事件，不能被 drops 的读取吞掉。
  const weekly = await ledger.read(WEEKLY);
  assert.equal(weekly.initialized, false);
  assert.deepEqual(weekly.eventIds, drops.eventIds);
});

// ---------- 变化事件 / 两个消费者 / 独立 ack ----------

test('变化生成稳定有序事件；drops 与 weekly 看到同一批 eventId，ack 互不吞并', async () => {
  const { ledger } = await tempLedger();
  await ledger.ingest(snapshotOf({ count: 3, mods: 1, score: 21 }));
  assert.deepEqual((await ledger.read(DROPS)).eventIds, []);
  assert.deepEqual((await ledger.read(WEEKLY)).eventIds, []);

  const changed = await ledger.ingest(snapshotOf({ count: 6, mods: 2, score: 34, seconds: SYNC_SECONDS + 120 }));
  assert.equal(changed.baselineCreated, false);
  assert.equal(changed.appended, 3); // MiscItems +3、RawUpgrades +1、科研分数 21→34

  const drops = await ledger.read(DROPS);
  const weekly = await ledger.read(WEEKLY);
  assert.equal(drops.eventIds.length, 3);
  assert.deepEqual(drops.eventIds, weekly.eventIds);
  assert.deepEqual(drops.eventIds, ['acct-delta-v1-1', 'acct-delta-v1-2', 'acct-delta-v1-3']);
  assert.equal(drops.gap, false);
  assert.equal(weekly.gap, false);

  // 事件内容：数量事件带 from/to/delta，周常标量事件带 cycle
  const quantity = drops.events.find((event) => event.kind === 'inventory-quantity' && event.entity === ITEM);
  assert.deepEqual(
    { field: quantity.field, change: quantity.change, from: quantity.from, to: quantity.to, delta: quantity.delta },
    { field: 'MiscItems', change: 'changed', from: 3, to: 6, delta: 3 },
  );
  assert.equal(quantity.asOf, new Date((SYNC_SECONDS + 120) * 1000).toISOString());
  // 事件只保留最小字段集：无源对象、无 diff 冗余 id、无账号标识
  assert.deepEqual(Object.keys(quantity).sort(), [
    'asOf', 'at', 'change', 'changedMetrics', 'cycle', 'delta', 'entity', 'eventId', 'field',
    'from', 'fromAsOf', 'kind', 'seq', 'to',
  ]);
  const scalar = drops.events.find((event) => event.kind === 'weekly-scalar');
  assert.equal(scalar.field, CONQUEST);
  assert.equal(scalar.cycle, 'weekly');
  assert.equal(scalar.from, 21);
  assert.equal(scalar.to, 34);

  // drops 确认后：自己清空，weekly 仍能读到同一批 eventId
  await ledger.ack(DROPS, drops.uptoSeq);
  assert.deepEqual((await ledger.read(DROPS)).eventIds, []);
  assert.deepEqual((await ledger.read(WEEKLY)).eventIds, drops.eventIds);
  await ledger.ack(WEEKLY, weekly.uptoSeq);
  assert.deepEqual((await ledger.read(WEEKLY)).eventIds, []);
});

test('处理失败不 ack：下一轮重放同一批事件，游标只前不后', async () => {
  const { ledger } = await tempLedger();
  await ledger.ingest(snapshotOf({ count: 3 }));
  await ledger.read(DROPS);
  await ledger.ingest(snapshotOf({ count: 6, seconds: SYNC_SECONDS + 60 }));

  const first = await ledger.read(DROPS);
  assert.equal(first.eventIds.length, 1);
  // 处理失败（抛错/降级）→ 不调用 ack → 同一批事件原样重现
  const retry = await ledger.read(DROPS);
  assert.deepEqual(retry.eventIds, first.eventIds);
  assert.equal(retry.cursor, first.cursor);

  await ledger.ack(DROPS, first.uptoSeq);
  assert.deepEqual((await ledger.read(DROPS)).eventIds, []);
  // 游标单调：回退请求被忽略
  const store = await ledger.status();
  const cursor = store.consumers.find((entry) => entry.id === DROPS).cursor;
  await ledger.ack(DROPS, 0);
  assert.equal((await ledger.status()).consumers.find((entry) => entry.id === DROPS).cursor, cursor);
});

// ---------- 重启恢复 / 并发 ----------

test('重启恢复：新实例从同一文件恢复基线、事件与各自游标', async () => {
  const { statePath, ledger } = await tempLedger();
  await ledger.ingest(snapshotOf({ count: 3 }));
  await ledger.read(DROPS);
  await ledger.read(WEEKLY);
  await ledger.ingest(snapshotOf({ count: 6, seconds: SYNC_SECONDS + 60 }));
  await ledger.ack(DROPS, (await ledger.read(DROPS)).uptoSeq);

  // 「重启」：全新实例，无内存状态
  const restarted = createDeltaLedger({ statePath, clock: () => CLOCK_MS });
  const status = await restarted.status();
  assert.equal(status.baselinePresent, true);
  assert.equal(status.events, 1);
  assert.deepEqual(status.baselineFields, ['EntratiLabConquestCacheScoreMission', 'MiscItems', 'RawUpgrades']);
  const drops = await restarted.read(DROPS);
  assert.deepEqual(drops.eventIds, []); // 已确认的不重放
  const weekly = await restarted.read(WEEKLY);
  assert.equal(weekly.eventIds.length, 1); // 未确认的仍在

  // 重启后同一快照再入库仍幂等
  assert.equal((await restarted.ingest(snapshotOf({ count: 6, seconds: SYNC_SECONDS + 60 }))).unchanged, true);
});

test('并发不丢：同进程串行 + 两个实例交叉写入后事件序列连续、文件无残留', async () => {
  const { statePath, ledger, read } = await tempLedger();
  await ledger.ingest(snapshotOf({ count: 1, mods: 0 }));
  const other = createDeltaLedger({ statePath, clock: () => CLOCK_MS });
  const results = await Promise.all([
    ledger.ingest(snapshotOf({ count: 2, mods: 0, seconds: SYNC_SECONDS + 60 })),
    other.ingest(snapshotOf({ count: 3, mods: 0, seconds: SYNC_SECONDS + 120 })),
    ledger.ingest(snapshotOf({ count: 4, mods: 0, seconds: SYNC_SECONDS + 180 })),
  ]);
  assert.ok(results.every((result) => result.ok));
  const appended = results.reduce((sum, result) => sum + result.appended, 0);
  assert.equal(appended, 3); // 三次都相对上一次基线产生了变化

  const store = await read();
  assert.equal(store.events.length, appended); // 一次都没丢
  assert.deepEqual(store.events.map((event) => event.seq), [1, 2, 3]);
  assert.equal(store.nextSeq, 4);
  assert.equal(store.lostSeq, 0);
  assert.equal(store.baseline.payload.inventory.MiscItems[0].ItemCount, 4); // 最后落地的基线

  const leftovers = (await readdir(path.dirname(statePath))).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
  await assert.rejects(stat(`${statePath}.lock`), (error) => error?.code === 'ENOENT');
});

// ---------- 锁：陈旧回收 / 有效锁不抢 ----------

test('陈旧锁自动回收；仍有效的锁只按「稍后重试」降级，不抢锁不改文件', async () => {
  const { statePath, ledger, read } = await tempLedger();
  const lockPath = `${statePath}.lock`;
  await writeFile(lockPath, '999:stale\n', 'utf8');
  const old = new Date(Date.now() - 10 * 60 * 1000);
  await utimes(lockPath, old, old);

  assert.equal((await ledger.ingest(snapshotOf({ count: 3 }))).ok, true);
  await assert.rejects(stat(lockPath), (error) => error?.code === 'ENOENT'); // 用完释放

  // 新鲜的锁（不属于本进程）不被回收：四个写/读操作都降级，文件保持原样
  await writeFile(lockPath, '999:fresh\n', 'utf8');
  const before = await readFile(statePath, 'utf8');
  const blocked = createDeltaLedger({ statePath, clock: () => CLOCK_MS, lockAttempts: 2, lockWaitMs: 1 });
  for (const [name, run] of [
    ['ingest', () => blocked.ingest(snapshotOf({ count: 99 }))],
    ['read', () => blocked.read(DROPS)],
    ['ack', () => blocked.ack(DROPS, 7)],
  ]) {
    const result = await run();
    assert.equal(result.ok, false, name);
    assert.equal(result.degraded, DELTA_LEDGER_DEGRADED.LOCKED, name);
  }
  assert.equal(await readFile(statePath, 'utf8'), before);
  assert.equal((await read()).baseline.payload.inventory.MiscItems[0].ItemCount, 3);

  await unlink(lockPath);
  assert.equal((await blocked.ingest(snapshotOf({ count: 99 }))).ok, true);
});

test('注入的锁失败按降级返回，不把锁竞争伪装成崩溃', async () => {
  const { statePath } = await tempLedger();
  const busy = createDeltaLedger({
    statePath,
    clock: () => CLOCK_MS,
    lock: async () => { throw ledgerBusyError(); },
  });
  const result = await busy.ingest(snapshotOf({}));
  assert.equal(result.ok, false);
  assert.equal(result.degraded, DELTA_LEDGER_DEGRADED.LOCKED);
  assert.equal((await busy.read(DROPS)).degraded, DELTA_LEDGER_DEGRADED.LOCKED);
});

// ---------- 损坏 / 超前 schema ----------

test('损坏或超前 schema 不静默清空：四个操作全部降级，原文件字节不变', async () => {
  const cases = [
    ['invalid_json', '{ not json', DELTA_LEDGER_DEGRADED.CORRUPT],
    ['not_object', '[]', DELTA_LEDGER_DEGRADED.CORRUPT],
    ['unexpected_kind', JSON.stringify({ schemaVersion: 1, kind: 'something-else', events: [] }), DELTA_LEDGER_DEGRADED.CORRUPT],
    ['invalid_schema_version', JSON.stringify({ kind: 'account-delta-ledger', events: [] }), DELTA_LEDGER_DEGRADED.CORRUPT],
    ['events_not_array', JSON.stringify({ schemaVersion: 1, kind: 'account-delta-ledger', events: {} }), DELTA_LEDGER_DEGRADED.CORRUPT],
    ['event_without_seq', JSON.stringify({ schemaVersion: 1, kind: 'account-delta-ledger', events: [{ eventId: 'x' }] }), DELTA_LEDGER_DEGRADED.CORRUPT],
    ['future_schema', JSON.stringify({
      schemaVersion: DELTA_LEDGER_SCHEMA_VERSION + 1, kind: 'account-delta-ledger',
      events: [], nextSeq: 9, lostSeq: 8, consumers: { drops: { cursor: 8 } },
    }), DELTA_LEDGER_DEGRADED.FUTURE_SCHEMA],
  ];
  for (const [label, content, expected] of cases) {
    const { statePath, ledger } = await tempLedger();
    await writeFile(statePath, content, 'utf8');
    const before = await readFile(statePath, 'utf8');
    const runs = [
      ['ingest', () => ledger.ingest(snapshotOf({}))],
      ['read', () => ledger.read(DROPS)],
      ['peek', () => ledger.peek(DROPS)],
      ['ack', () => ledger.ack(DROPS, 5)],
      ['status', () => ledger.status()],
    ];
    for (const [name, run] of runs) {
      const result = await run();
      assert.equal(result.ok, false, `${label}:${name}`);
      assert.equal(result.degraded, expected, `${label}:${name}`);
    }
    assert.equal(await readFile(statePath, 'utf8'), before, `${label} 不得改写也不可能清空文件`);
  }
});

test('文件缺失不是损坏：首次入库正常建基线并初始化消费者', async () => {
  const { statePath, ledger } = await tempLedger();
  assert.equal((await ledger.status()).empty, true);
  assert.equal((await ledger.peek(DROPS)).pending, 0);
  const beforeIngest = await ledger.read(DROPS);
  assert.equal(beforeIngest.ok, true);
  assert.equal(beforeIngest.empty, true);
  await assert.rejects(stat(statePath), (error) => error?.code === 'ENOENT');
  assert.equal((await ledger.ingest(snapshotOf({ count: 3 }))).baselineCreated, true);
  assert.equal((await ledger.status()).baselinePresent, true);
  assert.equal((await ledger.status()).empty, false);
});

test('已存在账本的关键结构异常一律只读降级，不修复、不重建基线', async () => {
  const { statePath, ledger } = await tempLedger();
  await ledger.ingest(snapshotOf({ count: 3 }));
  await ledger.ingest(snapshotOf({ count: 4, seconds: SYNC_SECONDS + 60 }));
  const valid = JSON.parse(await readFile(statePath, 'utf8'));
  const mutations = [
    ['null_baseline', (value) => { value.baseline = null; }],
    ['noncanonical_baseline', (value) => { value.baseline.payload.inventory.MiscItems[0].OwnedBy = 'secret'; }],
    ['missing_consumer', (value) => { delete value.consumers.weekly; }],
    ['bad_cursor', (value) => { value.consumers.drops.cursor = value.nextSeq + 10; }],
    ['bad_next_seq', (value) => { value.nextSeq = 0; }],
    ['bad_lost_seq', (value) => { value.lostSeq = value.nextSeq; }],
    ['duplicate_event', (value) => { value.events.push({ ...value.events[0] }); }],
    ['wrong_event_id', (value) => { value.events[0].eventId = 'forged'; }],
    ['unknown_top_level', (value) => { value.rawAccount = 'must-not-pass'; }],
  ];
  for (const [label, mutate] of mutations) {
    const damaged = structuredClone(valid);
    mutate(damaged);
    await writeFile(statePath, JSON.stringify(damaged), 'utf8');
    const before = await readFile(statePath, 'utf8');
    for (const run of [
      () => ledger.ingest(snapshotOf({ count: 9 })),
      () => ledger.read(DROPS),
      () => ledger.ack(DROPS, 1),
      () => ledger.status(),
    ]) {
      const result = await run();
      assert.equal(result.ok, false, label);
      assert.equal(result.degraded, DELTA_LEDGER_DEGRADED.CORRUPT, label);
    }
    assert.equal(await readFile(statePath, 'utf8'), before, label);
  }
});

// ---------- 容量：条数 / 体积 / 保留期 ----------

test('容量上限：条数与保留期裁剪都记入断档，消费者 ack 后自愈、互不影响', async () => {
  const { statePath, ledger, read } = await tempLedger({ limits: { events: 3 } });
  await ledger.ingest(snapshotOf({ count: 1, mods: 0 }));
  await ledger.read(DROPS);
  await ledger.read(WEEKLY);
  for (let index = 1; index <= 5; index += 1) {
    await ledger.ingest(snapshotOf({ count: 1 + index, mods: 0, seconds: SYNC_SECONDS + index * 60 }));
  }
  const store = await read();
  assert.equal(store.events.length, 3); // 条数上限
  assert.deepEqual(store.events.map((event) => event.seq), [3, 4, 5]);
  assert.equal(store.lostSeq, 2); // 被裁掉的最高序号

  const drops = await ledger.read(DROPS);
  assert.equal(drops.gap, true);
  assert.deepEqual(drops.eventIds, ['acct-delta-v1-3', 'acct-delta-v1-4', 'acct-delta-v1-5']);
  await ledger.ack(DROPS, drops.uptoSeq);
  assert.equal((await ledger.read(DROPS)).gap, false); // ack 越过断档后自愈
  assert.equal((await ledger.read(WEEKLY)).gap, true); // 另一个消费者不受影响

  // 保留期：时钟前进超过 ageMs 后旧事件被裁剪并记断档
  let clockMs = CLOCK_MS;
  const agingPath = path.join(path.dirname(statePath), 'aging-ledger.json');
  const aging = createDeltaLedger({ statePath: agingPath, clock: () => clockMs, limits: { ageMs: 60_000 } });
  await aging.ingest(snapshotOf({ count: 1, mods: 0 }));
  await aging.read(DROPS);
  await aging.ingest(snapshotOf({ count: 2, mods: 0, seconds: SYNC_SECONDS + 60 }));
  assert.equal((await aging.read(DROPS)).eventIds.length, 1);
  clockMs += 10 * 60_000;
  await aging.ingest(snapshotOf({ count: 3, mods: 0, seconds: SYNC_SECONDS + 120 }));
  const aged = JSON.parse(await readFile(agingPath, 'utf8'));
  assert.deepEqual(aged.events.map((event) => event.seq), [2]);
  assert.equal(aged.lostSeq, 1);
  assert.equal((await aging.read(DROPS)).gap, true);
});

test('单次变化量超过上限：只落上限内事件、其余如实记为断档，确认后自愈', async () => {
  const { ledger, read } = await tempLedger();
  const bulk = (count, itemCount, seconds) => adaptAccountSnapshot({
    LastInventorySync: { $oid: oidOf(seconds) },
    MiscItems: Array.from({ length: count }, (_, index) => ({ ItemType: `/Lotus/Bulk${index}`, ItemCount: itemCount })),
  }, { now: CLOCK_MS });
  await ledger.ingest(bulk(600, 1, SYNC_SECONDS));
  await ledger.read(DROPS);
  await ledger.read(WEEKLY);
  const changed = await ledger.ingest(bulk(600, 2, SYNC_SECONDS + 60));
  assert.equal(changed.truncated, true);
  assert.equal(changed.appended, MAX_LEDGER_EVENTS);
  assert.equal(changed.dropped, 600 - MAX_LEDGER_EVENTS);

  const store = await read();
  assert.equal(store.events.length, MAX_LEDGER_EVENTS);
  assert.deepEqual(store.events.map((event) => event.seq), Array.from({ length: MAX_LEDGER_EVENTS }, (_, index) => index + 1));
  assert.equal(store.nextSeq, 601);
  assert.equal(store.lostSeq, 600); // 未落盘的尾部事件占用序号，不会让消费者永久卡住

  const drops = await ledger.read(DROPS);
  assert.equal(drops.gap, true);
  assert.equal(drops.eventIds.length, MAX_LEDGER_EVENTS);
  assert.equal(drops.uptoSeq, 600);
  await ledger.ack(DROPS, drops.uptoSeq);
  assert.equal((await ledger.read(DROPS)).gap, false); // ack 到水位即越过断档
  assert.equal((await ledger.read(WEEKLY)).gap, true); // 未确认的消费者仍看到断档
});

test('体积上限：超出总字节预算的旧事件被裁剪，超预算的单条事件也不会突破上限', async () => {
  const { statePath, ledger, read } = await tempLedger({ limits: { bytes: 400 } });
  await ledger.ingest(snapshotOf({ count: 1, mods: 0 }));
  await ledger.read(DROPS);
  for (let index = 1; index <= 6; index += 1) {
    await ledger.ingest(snapshotOf({ count: 1 + index, mods: 0, seconds: SYNC_SECONDS + index * 60 }));
  }
  const store = await read();
  assert.ok(store.events.length < 6, '体积上限必须真的裁剪');
  assert.ok(JSON.stringify(store.events).length <= 400);
  assert.equal(store.lostSeq, 6 - store.events.length);
  assert.equal((await ledger.read(DROPS)).gap, true);
});

// ---------- 隐私白名单 ----------

test('隐私白名单：只落最小脱敏基线 / 有界事件 / 每消费者游标', async () => {
  const { statePath, ledger, read } = await tempLedger();
  const alecaDir = 'C:\\Users\\someone\\AppData\\Local\\AlecaFrame';
  const secretOid = 'deadbeefdeadbeefdeadbeef';
  const sessionToken = 'SECRET_SESSION_TOKEN';
  // 旧版信封 + 真实 lastData 里常见的敏感兄弟字段：令牌、账号标识、实例 oid、宠物详情、路径
  const rawEnvelope = {
    InventoryJson: JSON.stringify({
      LastInventorySync: { $oid: oidOf(SYNC_SECONDS) },
      MiscItems: [{ ItemType: ITEM, ItemCount: 3, _id: { $oid: secretOid }, OwnedBy: 'PLAYER_ACCOUNT_ID' }],
      WFMarketToken: { tk: sessionToken },
      KubrowPets: [{ ItemType: '/Lotus/Types/Game/KubrowPet', Details: { name: 'SECRET_PET_NAME' } }],
      Affiliations: [{ Tag: 'KahlSyndicate', Standing: 1000, WeeklyMissions: [{ WeekCount: 651, CompletedMission: true }] }],
      Upgrades: [{ ItemType: '/Lotus/Upgrades/Mods/Rifle/ExpertiseMod', UpgradeFingerprint: '{"lvl":10}' }],
      EndlessXP: [{
        Category: 'CIRCUIT_NORMAL', Expiry: { $date: { $numberLong: String(CLOCK_MS + 60_000) } }, Earn: 100,
        Claim: 9, Choices: ['secret-choice'], PendingRewards: [{ RequiredTotalXp: 200, StoreItem: '/Lotus/SecretReward' }],
      }],
    }),
    ownerId: 'qq-owner-12345',
  };
  const snapshot = adaptAccountSnapshot(rawEnvelope, { alecaDir, now: CLOCK_MS, fileMtimeMs: CLOCK_MS });
  await ledger.ingest(snapshot);
  await ledger.read(DROPS);
  await ledger.read(WEEKLY);
  await ledger.ingest(adaptAccountSnapshot({
    ...rawEnvelope,
    InventoryJson: JSON.stringify({
      ...JSON.parse(rawEnvelope.InventoryJson),
      MiscItems: [{ ItemType: ITEM, ItemCount: 9, _id: { $oid: secretOid }, OwnedBy: 'PLAYER_ACCOUNT_ID' }],
    }),
  }, { alecaDir, now: CLOCK_MS, fileMtimeMs: CLOCK_MS }));

  const raw = await readFile(statePath, 'utf8');
  for (const forbidden of [
    'InventoryJson', 'WFMarketToken', sessionToken, secretOid, 'PLAYER_ACCOUNT_ID', 'SECRET_PET_NAME',
    'KubrowPets', alecaDir, 'AlecaFrame', 'qq-owner-12345', 'alecaDir', 'ownerId',
    'LastInventorySync', oidOf(SYNC_SECONDS), '$oid', 'fileMtime',
    'secret-choice', '/Lotus/SecretReward', 'UpgradeFingerprint', 'Standing', 'Claim', 'Choices', 'StoreItem',
  ]) {
    assert.equal(raw.includes(forbidden), false, `账本不得包含 ${forbidden}`);
  }

  const store = JSON.parse(raw);
  assert.deepEqual(Object.keys(store).sort(), [
    'baseline', 'consumers', 'events', 'kind', 'lostSeq', 'nextSeq', 'schemaVersion', 'updatedAt',
  ]);
  assert.deepEqual(Object.keys(store.baseline).sort(), ['at', 'payload']);
  assert.deepEqual(Object.keys(store.baseline.payload).sort(), ['asOf', 'asOfBasis', 'inventory', 'schemaVersion', 'source']);
  assert.deepEqual(Object.keys(store.consumers).sort(), ['drops', 'weekly']);
  assert.deepEqual(Object.keys(store.consumers.drops).sort(), ['ackedAt', 'cursor']);
  // 基线字段 ⊆ delta 必需字段白名单（装备栏/宠物/账号字段都不在）
  const baselineFields = (await ledger.status()).baselineFields;
  assert.ok(baselineFields.length > 0);
  for (const field of baselineFields) assert.ok(ACCOUNT_DELTA_BASELINE_FIELDS.includes(field), field);
  // 只保留快照里真实存在且 delta 需要的组
  assert.deepEqual(Object.keys(store.baseline.payload.inventory).sort(), ['Affiliations', 'EndlessXP', 'MiscItems', 'Upgrades']);
  assert.deepEqual(Object.keys(store.baseline.payload.inventory.Affiliations[0]).sort(), ['Tag', 'WeeklyMissions']);
  assert.deepEqual(Object.keys(store.baseline.payload.inventory.Upgrades[0]), ['ItemType']);
  assert.deepEqual(Object.keys(store.baseline.payload.inventory.EndlessXP[0]).sort(), ['Category', 'Earn', 'Expiry', 'PendingRewards']);
  assert.deepEqual(Object.keys(store.baseline.payload.inventory.EndlessXP[0].PendingRewards[0]), ['RequiredTotalXp']);
  // 审计面只有计数/水位，不含事件载荷与基线内容
  const status = await ledger.status();
  assert.deepEqual(Object.keys(status).sort(), [
    'baselineAsOf', 'baselineFields', 'baselinePresent', 'consumers', 'empty', 'events', 'lostSeq',
    'nextSeq', 'ok', 'schemaVersion', 'updatedAt',
  ]);
});
