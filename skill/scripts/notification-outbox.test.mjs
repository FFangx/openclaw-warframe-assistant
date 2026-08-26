import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ATTEMPT_LOG_LIMIT,
  DEFAULT_TTL_MS,
  ENTRIES_LIMIT,
  TOMBSTONE_LIMIT,
  contentHashOf,
  createOutbox,
  migrateLegacyDeliveryQueue,
  parseLegacyMessage,
  targetKeyOf,
} from './notification-outbox.mjs';

const TARGET = 'qqbot:c2c:tester';
const BASE = Date.parse('2026-08-25T00:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

function clockAt(startMs = BASE) {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms) => { current += ms; },
    set: (ms) => { current = ms; },
  };
}

function memoryOutbox(clock = clockAt(), ttlMs = DEFAULT_TTL_MS) {
  return createOutbox({ memory: true, now: clock.now, ttlMs });
}

function partEntry(parts, clock) {
  return memoryOutbox(clock).enqueue({ businessKey: 'bk-1', target: TARGET, parts });
}

test('入队记录包含 schemaVersion/业务键/内容哈希/parts/时间/尝试/结果类别/最终状态', async () => {
  const clock = clockAt();
  const { entry, created } = await partEntry([{ kind: 'media', value: 'C:\\cards\\a.png' }, { kind: 'text', value: '掉落说明' }], clock);
  assert.equal(created, true);
  assert.equal(entry.schemaVersion, 1);
  assert.equal(entry.businessKey, 'bk-1');
  assert.equal(entry.target, undefined);
  assert.equal(entry.targetKey, targetKeyOf(TARGET));
  assert.match(entry.contentHash, /^[0-9a-f]{64}$/u);
  assert.deepEqual(entry.parts.map((part) => part.kind), ['media', 'text']);
  for (const part of entry.parts) {
    assert.equal(part.status, 'pending');
    assert.equal(part.attempts, 0);
    assert.equal(part.sentAt, null);
  }
  assert.equal(entry.status, 'pending');
  assert.equal(entry.outcome, 'pending');
  assert.equal(entry.attempts, 0);
  assert.deepEqual(entry.attemptsLog, []);
  assert.equal(entry.createdAt, iso(BASE));
  assert.equal(entry.expiresAt, iso(BASE + DEFAULT_TTL_MS)); // 创建 + 48h
  assert.equal(entry.deliveredAt, null);
});

test('内容哈希：内容相同哈希相同，任一 part 漂移哈希改变（且与业务键/目标解耦）', () => {
  const partsA = [{ kind: 'media', value: 'C:\\a.png' }, { kind: 'text', value: '文字' }];
  const partsB = [{ kind: 'media', value: 'C:\\a.png' }, { kind: 'text', value: '文字' }];
  const partsC = [{ kind: 'media', value: 'C:\\a.png' }, { kind: 'text', value: '改了一个字' }];
  assert.equal(contentHashOf(partsA), contentHashOf(partsB));
  assert.notEqual(contentHashOf(partsA), contentHashOf(partsC));
});

test('旧欠账消息解析：MEDIA: 行转媒体 part，其余为文字 part', () => {
  assert.deepEqual(parseLegacyMessage('MEDIA:C:\\cards\\a.png'), [{ kind: 'media', value: 'C:\\cards\\a.png' }]);
  assert.deepEqual(parseLegacyMessage('普通文字'), [{ kind: 'text', value: '普通文字' }]);
  assert.deepEqual(parseLegacyMessage('MEDIA:a.png\nMEDIA:b.png\n说明文字'), [
    { kind: 'media', value: 'a.png' },
    { kind: 'media', value: 'b.png' },
    { kind: 'text', value: '说明文字' },
  ]);
});

test('同一业务键不重复入队：pending、已投递、重启后都命中去重', async () => {
  const clock = clockAt();
  const outbox = memoryOutbox(clock);
  const first = await outbox.enqueue({ businessKey: 'evt-1', target: TARGET, parts: [{ kind: 'text', value: 'a' }] });
  assert.equal(first.created, true);
  const second = await outbox.enqueue({ businessKey: 'evt-1', target: TARGET, parts: [{ kind: 'text', value: 'a' }] });
  assert.equal(second.created, false);
  assert.equal(second.deduped, true);
  assert.equal(second.entry.id, first.entry.id);
  // 投递成功（tombstone）后仍去重
  await outbox.deliverPending({ target: TARGET, mailer: async () => ({ ok: true }) });
  const afterDelivered = await outbox.enqueue({ businessKey: 'evt-1', target: TARGET, parts: [{ kind: 'text', value: 'a' }] });
  assert.equal(afterDelivered.created, false);
  assert.equal(afterDelivered.deduped, true);
});

test('重启后 pending 从磁盘恢复；同一业务键跨实例仍去重', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'warframe-outbox-recover-'));
  const filePath = path.join(dir, 'outbox.json');
  const clock = clockAt();
  const first = createOutbox({ filePath, now: clock.now });
  await first.enqueue({ businessKey: 'evt-1', target: TARGET, parts: [{ kind: 'media', value: 'C:\\a.png' }] });
  // 「进程重启」：新实例从磁盘加载
  const second = createOutbox({ filePath, now: clock.now });
  assert.deepEqual((await second.snapshot()).entries.map((entry) => entry.businessKey), ['evt-1']);
  const again = await second.enqueue({ businessKey: 'evt-1', target: TARGET, parts: [{ kind: 'media', value: 'C:\\a.png' }] });
  assert.equal(again.created, false);
  const summary = await second.deliverPending({ target: TARGET, mailer: async () => ({ ok: true }) });
  assert.deepEqual(summary.deliveredIds, ['ob-1']);
  // 磁盘上的最终状态完整可查
  const onDisk = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(onDisk.entries[0].status, 'delivered');
  assert.equal(onDisk.entries[0].outcome, 'delivered');
  assert.equal(onDisk.entries[0].parts[0].status, 'sent');
  assert.equal(onDisk.tombstones['evt-1'], onDisk.entries[0].deliveredAt);
});

test('两个进程等价实例并发入队不会互相覆盖，状态文件不保存原始 target', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'warframe-outbox-concurrent-'));
  const filePath = path.join(dir, 'outbox.json');
  const first = createOutbox({ filePath });
  const second = createOutbox({ filePath });
  await Promise.all([
    first.enqueue({ businessKey: 'parallel-a', target: TARGET, parts: [{ kind: 'text', value: 'a' }] }),
    second.enqueue({ businessKey: 'parallel-b', target: 'qqbot:c2c:other', parts: [{ kind: 'text', value: 'b' }] }),
  ]);
  const raw = await readFile(filePath, 'utf8');
  assert.equal(raw.includes(TARGET), false);
  assert.equal(raw.includes('qqbot:c2c:other'), false);
  const store = JSON.parse(raw);
  assert.deepEqual(store.entries.map((entry) => entry.businessKey).sort(), ['parallel-a', 'parallel-b']);
  assert.ok(store.entries.every((entry) => /^[0-9a-f]{64}$/u.test(entry.targetKey) && entry.target === undefined));
});

test('逐 part 持久化：图片成功文字失败，重试只补投文字且成功图片不重发', async () => {
  const clock = clockAt();
  const outbox = memoryOutbox(clock);
  const { entry } = await outbox.enqueue({
    businessKey: 'two-parts',
    target: TARGET,
    parts: [{ kind: 'media', value: 'C:\\a.png' }, { kind: 'text', value: '说明' }],
  });
  const mediaCalls = [];
  const textCalls = [];
  const firstRound = await outbox.deliverPending({
    target: TARGET,
    mailer: async (part) => {
      if (part.kind === 'media') { mediaCalls.push(part.value); return { ok: true }; }
      textCalls.push(part.value);
      return { ok: false, category: 'timeout' };
    },
  });
  assert.deepEqual(mediaCalls, ['C:\\a.png']);
  assert.deepEqual(textCalls, ['说明']);
  assert.equal(firstRound.sentParts, 1);
  assert.equal(firstRound.failedParts, 1);
  assert.equal(firstRound.deliveredIds.length, 0);
  assert.deepEqual(firstRound.pendingIds, [entry.id]);
  assert.equal(entry.parts[0].status, 'sent');
  assert.equal(entry.parts[1].status, 'pending');
  assert.equal(entry.parts[0].attempts, 1);
  assert.equal(entry.parts[1].attempts, 1);
  // 结果类别：图片 delivered、文字 failed
  assert.deepEqual(entry.attemptsLog.map((item) => item.category), ['delivered', 'failed']);
  assert.equal(entry.outcome, 'failed');

  // 第二轮（等价进程重启后的补投）：图片必须不再发送，只重试文字
  const secondCalls = [];
  const secondRound = await outbox.deliverPending({
    target: TARGET,
    mailer: async (part) => {
      secondCalls.push(`${part.kind}:${part.value}`);
      return { ok: true };
    },
  });
  assert.deepEqual(secondCalls, ['text:说明']);
  assert.deepEqual(secondRound.deliveredIds, [entry.id]);
  assert.equal(entry.status, 'delivered');
  assert.equal(entry.outcome, 'delivered');
  assert.equal(entry.parts[1].attempts, 2);
  assert.equal(entry.attempts, 3); // 1 次媒体 + 2 次文字
});

test('每个 part 结果立即落盘：part2 尝试时磁盘上 part1 已为 sent（崩溃窗口收敛）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'warframe-outbox-persist-'));
  const filePath = path.join(dir, 'outbox.json');
  const clock = clockAt();
  const outbox = createOutbox({ filePath, now: clock.now });
  await outbox.enqueue({
    businessKey: 'persist-per-part',
    target: TARGET,
    parts: [{ kind: 'media', value: 'C:\\a.png' }, { kind: 'text', value: '说明' }],
  });
  let diskCheck = null;
  await outbox.deliverPending({
    target: TARGET,
    mailer: async (part) => {
      if (part.kind !== 'text') return { ok: true };
      // 文字 part 开始时检查磁盘：媒体 part 必须已经持久化为 sent
      const onDisk = JSON.parse(await readFile(filePath, 'utf8'));
      diskCheck = onDisk.entries[0].parts.map((item) => ({ kind: item.kind, status: item.status, attempts: item.attempts }));
      return { ok: false, category: 'text_failed' };
    },
  });
  assert.deepEqual(diskCheck, [
    { kind: 'media', status: 'sent', attempts: 1 },
    // 文字 part 尚未完成本轮发送：磁盘只记录上一轮已有状态（media sent，text 仍为 pending/0 次）
    { kind: 'text', status: 'pending', attempts: 0 },
  ]);
  // 「进程重启」后重试：媒体不再发送
  const restarted = createOutbox({ filePath, now: clock.now });
  const calls = [];
  await restarted.deliverPending({
    target: TARGET,
    mailer: async (part) => { calls.push(part.kind); return { ok: true }; },
  });
  assert.deepEqual(calls, ['text']);
});

test('TTL：超过 expireAt 的记录置为 expired 不再尝试，48h 边界内正常投递', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'warframe-outbox-ttl-'));
  const filePath = path.join(dir, 'outbox.json');
  const clock = clockAt();
  const outbox = createOutbox({ filePath, now: clock.now });
  await outbox.enqueue({ businessKey: 'fresh', target: TARGET, parts: [{ kind: 'text', value: '新' }], createdAt: iso(BASE) });
  await outbox.enqueue({ businessKey: 'old', target: TARGET, parts: [{ kind: 'text', value: '旧' }], createdAt: iso(BASE - DEFAULT_TTL_MS - 1000) });
  let mailerCalls = 0;
  const summary = await outbox.deliverPending({
    target: TARGET,
    mailer: async () => { mailerCalls += 1; return { ok: true }; },
  });
  assert.equal(mailerCalls, 1); // 只有 fresh 被尝试
  assert.deepEqual(summary.expiredIds.length, 1);
  const store = await outbox.snapshot();
  const old = store.entries.find((entry) => entry.businessKey === 'old');
  assert.equal(old.status, 'expired');
  assert.equal(old.outcome, 'expired');
  assert.ok(old.expiredAt);
  // 超期记录不会被后续投递再次尝试
  const later = createOutbox({ filePath, now: clock.now });
  let laterCalls = 0;
  await later.deliverPending({ target: TARGET, mailer: async () => { laterCalls += 1; return { ok: true }; } });
  assert.equal(laterCalls, 0);
  assert.equal((await later.snapshot()).entries.find((entry) => entry.businessKey === 'old').status, 'expired');
});

test('调用方显式 expiresAt：合法且不晚于默认 TTL；更早的业务过期如实保留', async () => {
  const clock = clockAt();
  const outbox = memoryOutbox(clock);
  // 合法且早于默认 TTL：按业务过期保留（世界状态聚合通知用最早 expiry）
  const early = await outbox.enqueue({
    businessKey: 'exp-early',
    target: TARGET,
    parts: [{ kind: 'text', value: '早过期' }],
    expiresAt: iso(BASE + 2 * 60 * 60 * 1000),
  });
  assert.equal(early.entry.expiresAt, iso(BASE + 2 * 60 * 60 * 1000));
  // 不晚于默认 TTL：请求晚于 48h 被封顶到默认 TTL（缺省行为仍是 createdAt + 48h）
  const late = await outbox.enqueue({
    businessKey: 'exp-late',
    target: TARGET,
    parts: [{ kind: 'text', value: '晚过期' }],
    expiresAt: iso(BASE + DEFAULT_TTL_MS + 24 * 60 * 60 * 1000),
  });
  assert.equal(late.entry.expiresAt, iso(BASE + DEFAULT_TTL_MS));
  // 未传 expiresAt：保持缺省 createdAt + 48h（掉落行为不变）
  const fresh = await outbox.enqueue({
    businessKey: 'exp-default',
    target: TARGET,
    parts: [{ kind: 'text', value: '默认' }],
  });
  assert.equal(fresh.entry.expiresAt, iso(BASE + DEFAULT_TTL_MS));
  // 与 createdAt 并存：以 createdAt 起算
  const backdated = await outbox.enqueue({
    businessKey: 'exp-backdated',
    target: TARGET,
    parts: [{ kind: 'text', value: '回填' }],
    createdAt: iso(BASE - 60 * 60 * 1000),
    expiresAt: iso(BASE + 60 * 60 * 1000),
  });
  assert.equal(backdated.entry.createdAt, iso(BASE - 60 * 60 * 1000));
  assert.equal(backdated.entry.expiresAt, iso(BASE + 60 * 60 * 1000));
});

test('调用方显式 expiresAt：非法时间直接抛错，不静默使用默认值', async () => {
  const clock = clockAt();
  const outbox = memoryOutbox(clock);
  await assert.rejects(
    outbox.enqueue({ businessKey: 'exp-bad', target: TARGET, parts: [{ kind: 'text', value: 'x' }], expiresAt: '不是时间' }),
    /expiresAt/u,
  );
  // 抛错不产生记录（下一次合法入队仍是第一条）
  const good = await outbox.enqueue({ businessKey: 'exp-good', target: TARGET, parts: [{ kind: 'text', value: 'x' }] });
  assert.equal(good.entry.id, 'ob-1');
});

test('显式 expiresAt 到期后不再尝试投递（事件过期即停补投），未到期前正常投递', async () => {
  const clock = clockAt();
  const outbox = memoryOutbox(clock);
  await outbox.enqueue({
    businessKey: 'exp-window',
    target: TARGET,
    parts: [{ kind: 'text', value: '时效通知' }],
    expiresAt: iso(BASE + 60 * 60 * 1000),
  });
  let calls = 0;
  const first = await outbox.deliverPending({ target: TARGET, mailer: async () => { calls += 1; return { ok: true }; } });
  assert.equal(calls, 1);
  assert.deepEqual(first.deliveredIds, ['ob-1']);
  // 时钟推进到业务过期之后：新入队的同源通知（不同业务键）立即置 expired，不再发送
  clock.advance(2 * 60 * 60 * 1000);
  await outbox.enqueue({
    businessKey: 'exp-window-2',
    target: TARGET,
    parts: [{ kind: 'text', value: '时效通知二' }],
    expiresAt: iso(BASE + 60 * 60 * 1000),
  });
  const second = await outbox.deliverPending({ target: TARGET, mailer: async () => { calls += 1; return { ok: true }; } });
  assert.equal(calls, 1);
  assert.deepEqual(second.expiredIds, ['ob-2']);
  assert.equal((await outbox.snapshot()).entries.find((entry) => entry.businessKey === 'exp-window-2').status, 'expired');
});

test('tombstone 有界：超限淘汰最早投递键，其余键保持去重', async () => {
  const clock = clockAt();
  const outbox = memoryOutbox(clock);
  const deliveredKeys = [];
  for (let index = 0; index < TOMBSTONE_LIMIT + 5; index += 1) {
    const key = `evt-${index}`;
    await outbox.enqueue({ businessKey: key, target: TARGET, parts: [{ kind: 'text', value: String(index) }] });
    await outbox.deliverPending({ target: TARGET, mailer: async () => ({ ok: true }) });
    deliveredKeys.push(key);
  }
  const store = await outbox.snapshot();
  assert.ok(Object.keys(store.tombstones).length <= TOMBSTONE_LIMIT);
  // 最早投递的键被淘汰，最新投递的键仍在
  assert.equal(store.tombstones[deliveredKeys[0]], undefined);
  assert.equal(store.tombstones[deliveredKeys.at(-1)], store.entries.find((entry) => entry.businessKey === deliveredKeys.at(-1)).deliveredAt);
});

test('记录有界：终态被淘汰，pending 永不淘汰', async () => {
  const clock = clockAt();
  const outbox = memoryOutbox(clock);
  for (let index = 0; index < ENTRIES_LIMIT + 30; index += 1) {
    const key = `evt-${index}`;
    await outbox.enqueue({ businessKey: key, target: TARGET, parts: [{ kind: 'text', value: String(index) }] });
    await outbox.deliverPending({ target: TARGET, mailer: async () => ({ ok: true }) });
  }
  // 剩余记录的 pending 位：入队 10 条不投递的
  for (let index = 0; index < 10; index += 1) {
    await outbox.enqueue({ businessKey: `pending-${index}`, target: TARGET, parts: [{ kind: 'text', value: String(index) }] });
  }
  const entries = (await outbox.snapshot()).entries;
  // 终态记录被压缩到上限内；pending 永不淘汰（因此总条数 = 上限 + 幸存 pending）
  assert.ok(entries.length <= ENTRIES_LIMIT + 10);
  assert.ok(entries.filter((entry) => entry.status !== 'pending').length <= ENTRIES_LIMIT);
  const pendingKeys = entries.filter((entry) => entry.status === 'pending').map((entry) => entry.businessKey);
  for (let index = 0; index < 10; index += 1) assert.ok(pendingKeys.includes(`pending-${index}`));
});

test('旧欠账迁移：幂等、TTL 保持 48h 起算、超期不迁、多 part 正确拆解', async () => {
  const clock = clockAt();
  const outbox = memoryOutbox(clock);
  const legacy = [
    { id: 'old-1', message: 'MEDIA:C:\\cards\\legacy.png', queuedAt: iso(BASE - 60 * 60 * 1000) },
    { id: 'old-2', message: 'MEDIA:a.png\nMEDIA:b.png\n说明文字', queuedAt: iso(BASE - 2 * 60 * 60 * 1000) },
    { id: 'old-3', message: '纯文字欠账', queuedAt: iso(BASE - 60 * 60 * 1000) },
    { id: 'old-4', message: '过期欠账', queuedAt: iso(BASE - DEFAULT_TTL_MS - 60_000) },
  ];
  const first = await migrateLegacyDeliveryQueue(legacy, outbox, { target: TARGET, now: clock.now });
  assert.deepEqual(first, { migrated: 3, skipped: 0, expired: 1 });
  const store = await outbox.snapshot();
  assert.equal(store.entries.length, 3);
  const legacy1 = store.entries.find((entry) => entry.businessKey === `legacy:${targetKeyOf(TARGET)}:old-1`);
  assert.deepEqual(legacy1.parts.map((part) => part.kind), ['media']);
  assert.equal(legacy1.parts[0].value, 'C:\\cards\\legacy.png');
  // TTL 保持：以原 queuedAt 起算 48h，不因迁移重置时钟
  assert.equal(legacy1.expiresAt, iso(BASE - 60 * 60 * 1000 + DEFAULT_TTL_MS));
  const legacy2 = store.entries.find((entry) => entry.businessKey === `legacy:${targetKeyOf(TARGET)}:old-2`);
  assert.deepEqual(legacy2.parts.map((part) => part.kind), ['media', 'media', 'text']);
  // 幂等：重复迁移同一批不会产生重复记录
  const second = await migrateLegacyDeliveryQueue(legacy, outbox, { target: TARGET, now: clock.now });
  assert.deepEqual(second, { migrated: 0, skipped: 3, expired: 1 });
  assert.equal((await outbox.snapshot()).entries.length, 3);
});

test('目标过滤：只投递本 target 的 pending', async () => {
  const clock = clockAt();
  const outbox = memoryOutbox(clock);
  await outbox.enqueue({ businessKey: 'mine', target: TARGET, parts: [{ kind: 'text', value: '我' }] });
  await outbox.enqueue({ businessKey: 'other', target: 'qqbot:c2c:other', parts: [{ kind: 'text', value: '别人' }] });
  let calls = 0;
  const summary = await outbox.deliverPending({ target: TARGET, mailer: async () => { calls += 1; return { ok: true }; } });
  assert.equal(calls, 1);
  assert.deepEqual(summary.deliveredIds, ['ob-1']);
  const store = await outbox.snapshot();
  assert.equal(store.entries.find((entry) => entry.businessKey === 'other').status, 'pending');
});

test('mailer 抛错按失败处理并记录类别，不中断其余 part 与其余记录', async () => {
  const clock = clockAt();
  const outbox = memoryOutbox(clock);
  const { entry } = await outbox.enqueue({
    businessKey: 'thrower',
    target: TARGET,
    parts: [{ kind: 'text', value: '第一段' }, { kind: 'text', value: '第二段' }],
  });
  const summary = await outbox.deliverPending({
    target: TARGET,
    mailer: async (part) => {
      if (part.value === '第一段') throw new Error('CLI 崩溃');
      return { ok: true };
    },
  });
  assert.equal(summary.sentParts, 1);
  assert.equal(summary.failedParts, 1);
  assert.deepEqual(summary.pendingIds, [entry.id]);
  assert.deepEqual(entry.attemptsLog.map((item) => item.category), ['failed', 'delivered']);
  assert.equal(entry.attemptsLog[0].resultCode, 'mailer_exception');
});

test('尝试明细有界：只保留最近 ATTEMPT_LOG_LIMIT 条', async () => {
  const clock = clockAt();
  const outbox = memoryOutbox(clock);
  await outbox.enqueue({ businessKey: 'log-limit', target: TARGET, parts: [{ kind: 'text', value: 'x' }] });
  for (let index = 0; index < ATTEMPT_LOG_LIMIT + 7; index += 1) {
    await outbox.deliverPending({ target: TARGET, mailer: async () => ({ ok: index === ATTEMPT_LOG_LIMIT + 6 }) });
  }
  const entry = (await outbox.snapshot()).entries[0];
  assert.equal(entry.attemptsLog.length, ATTEMPT_LOG_LIMIT);
});

test('状态文件损坏或 schemaVersion 超前：抛错绝不静默重置（防丢欠账）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'warframe-outbox-corrupt-'));
  const jsonPath = path.join(dir, 'outbox.json');
  await writeFile(jsonPath, '{ 这不是 JSON', 'utf8');
  await assert.rejects(createOutbox({ filePath: jsonPath }).snapshot(), /损坏/u);
  await writeFile(jsonPath, JSON.stringify({ schemaVersion: 99, entries: [] }), 'utf8');
  await assert.rejects(createOutbox({ filePath: jsonPath }).snapshot(), /schemaVersion/u);
});

test('载入容错：非法记录丢弃，合法记录恢复；不编造投递状态', async () => {  const dir = await mkdtemp(path.join(os.tmpdir(), 'warframe-outbox-normalize-'));
  const filePath = path.join(dir, 'outbox.json');
  const clock = clockAt();
  const outbox = createOutbox({ filePath, now: clock.now });
  await outbox.enqueue({ businessKey: 'good', target: TARGET, parts: [{ kind: 'text', value: '好' }] });
  await outbox.enqueue({ businessKey: 'good2', target: TARGET, parts: [{ kind: 'text', value: '好二' }] });
  // 手改文件：混入缺关键字段记录、非法 part 记录、合法部分 sent 记录
  const store = await outbox.snapshot();
  store.entries.push(
    { id: 'bad-1', businessKey: 'bad-1', target: TARGET, parts: '不是数组' }, // 缺 parts 数组
    { id: 'bad-2', businessKey: 'bad-2', target: TARGET, parts: [{ kind: 'audio', value: 'x' }] }, // 非法 part
  );
  store.entries[0].parts[0].status = 'sent';
  store.entries[0].parts[0].sentAt = iso(BASE);
  await writeFile(filePath, `${JSON.stringify(store)}\n`, 'utf8');
  const restarted = createOutbox({ filePath, now: clock.now });
  const loaded = await restarted.snapshot();
  assert.deepEqual(loaded.entries.map((entry) => entry.businessKey), ['good', 'good2']);
  // 合法 sent part 原样恢复；未投递的不被编造成 sent
  assert.equal(loaded.entries[0].parts[0].status, 'sent');
  assert.equal(loaded.entries[1].parts[0].status, 'pending');
  // 恢复后 delivered 记录不会再次投递
  let calls = 0;
  await restarted.deliverPending({ target: TARGET, mailer: async () => { calls += 1; return { ok: true }; } });
  assert.equal(calls, 1); // 只有 good2
});

test('手改记录缺 expiresAt：按超期安全处理，不无限重试', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'warframe-outbox-noexpiry-'));
  const filePath = path.join(dir, 'outbox.json');
  const clock = clockAt();
  const outbox = createOutbox({ filePath, now: clock.now });
  await outbox.enqueue({ businessKey: 'no-expiry', target: TARGET, parts: [{ kind: 'text', value: 'x' }] });
  const store = await outbox.snapshot();
  delete store.entries[0].expiresAt;
  await writeFile(filePath, `${JSON.stringify(store)}\n`, 'utf8');
  const restarted = createOutbox({ filePath, now: clock.now });
  let calls = 0;
  const summary = await restarted.deliverPending({
    target: TARGET,
    mailer: async () => { calls += 1; return { ok: true }; },
  });
  assert.equal(calls, 0);
  assert.equal(summary.expiredIds.length, 1);
  assert.equal((await restarted.snapshot()).entries[0].status, 'expired');
});

test('contentHash 包含媒体投递模式（transport）：无损与普通同一文件不同哈希；缺省=media 向后兼容', () => {
  const value = 'C:\\cards\\weekly.png';
  const normal = contentHashOf([{ kind: 'media', value, transport: 'media' }]);
  const lossless = contentHashOf([{ kind: 'media', value, transport: 'lossless' }]);
  const absent = contentHashOf([{ kind: 'media', value }]);
  assert.notEqual(normal, lossless); // 模式在内容指纹里：无损/普通不互相去重
  assert.equal(normal, absent);      // 缺省与显式媒体同一指纹（旧记录载入后哈希语义不变）
});

test('part transport 持久化：无损/普通按序落盘，载入重启后原样保留', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'warframe-outbox-transport-'));
  const filePath = path.join(dir, 'outbox.json');
  const clock = clockAt();
  const outbox = createOutbox({ filePath, now: clock.now });
  const { entry } = await outbox.enqueue({
    businessKey: 'weekly-cards',
    target: TARGET,
    parts: [
      { kind: 'media', value: 'C:\\cards\\weekly.png', transport: 'lossless' },
      { kind: 'media', value: 'C:\\cards\\deals.png' },
    ],
  });
  assert.deepEqual(entry.parts.map((part) => part.transport), ['lossless', 'media']);
  // 落盘与重启恢复（模拟 Gateway 重启）
  const restarted = createOutbox({ filePath, now: clock.now });
  const loaded = await restarted.snapshot();
  assert.deepEqual(loaded.entries[0].parts.map((part) => [part.kind, part.transport]), [['media', 'lossless'], ['media', 'media']]);
  // 投递器观察到持久化的模式（默认媒体不受影响）
  const calls = [];
  await restarted.deliverPending({ target: TARGET, mailer: async (part) => { calls.push(part.transport); return { ok: true }; } });
  assert.deepEqual(calls, ['lossless', 'media']);
});

test('旧格式记录（part 无 transport）兼容：载入归一为默认媒体，只补投未发送 part', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'warframe-outbox-legacy-part-'));
  const filePath = path.join(dir, 'outbox.json');
  const clock = clockAt();
  const outbox = createOutbox({ filePath, now: clock.now });
  await outbox.enqueue({
    businessKey: 'legacy-part',
    target: TARGET,
    parts: [{ kind: 'media', value: 'C:\\old.png' }, { kind: 'text', value: '旧说明' }],
  });
  // 模拟前一版（无 transport 字段）落盘的旧记录：去掉 transport，并保留部分已发送状态
  const store = await outbox.snapshot();
  for (const part of store.entries[0].parts) delete part.transport;
  store.entries[0].parts[0].status = 'sent';
  store.entries[0].parts[0].sentAt = iso(BASE);
  await writeFile(filePath, `${JSON.stringify(store)}\n`, 'utf8');

  const restarted = createOutbox({ filePath, now: clock.now });
  const calls = [];
  const summary = await restarted.deliverPending({
    target: TARGET,
    mailer: async (part) => { calls.push(part); return { ok: true }; },
  });
  // 旧记录不丢部分状态；只补投未发送的文字 part，归一为默认 'media'（普通投递路径不变）
  assert.deepEqual(summary.deliveredIds, ['ob-1']);
  assert.deepEqual(calls.map((part) => [part.kind, part.transport]), [['text', 'media']]);
  const loaded = await restarted.snapshot();
  assert.equal(loaded.entries[0].status, 'delivered');
  assert.deepEqual(loaded.entries[0].parts.map((part) => [part.kind, part.transport, part.status]), [['media', 'media', 'sent'], ['text', 'media', 'sent']]);
});

test('redactOnTerminal：delivered/expired 终态立即擦除 part.value，只留 contentHash/状态/时间/脱敏审计', async () => {
  const clock = clockAt();
  const outbox = memoryOutbox(clock);
  const parts = [{ kind: 'media', value: 'C:\\cards\\敏感图.png' }, { kind: 'text', value: '包含敏感卖家的通知' }];
  const { entry } = await outbox.enqueue({ businessKey: 'redact-1', target: TARGET, parts, redactOnTerminal: true });
  const originalHash = entry.contentHash;
  assert.equal(entry.redactOnTerminal, true);
  const summary = await outbox.deliverPending({ target: TARGET, mailer: async () => ({ ok: true }) });
  assert.deepEqual(summary.deliveredIds, ['ob-1']);
  // 终态擦除：内容哈希/审计保留，payload 清空
  assert.deepEqual(entry.parts.map((part) => [part.kind, part.value, part.status]), [['media', '', 'sent'], ['text', '', 'sent']]);
  assert.equal(entry.contentHash, originalHash);
  assert.deepEqual(entry.attemptsLog.map((item) => item.category), ['delivered', 'delivered']);
  assert.equal((await outbox.snapshot()).tombstones['redact-1'], entry.deliveredAt);

  // expired 终态同样擦除
  const expired = await outbox.enqueue({
    businessKey: 'redact-2', target: TARGET, redactOnTerminal: true,
    parts: [{ kind: 'text', value: '敏感过期通知' }], expiresAt: iso(BASE + 60 * 1000),
  });
  clock.advance(2 * 60 * 1000);
  let calls = 0;
  await outbox.deliverPending({ target: TARGET, mailer: async () => { calls += 1; return { ok: true }; } });
  assert.equal(calls, 0);
  assert.equal(expired.entry.status, 'expired');
  assert.equal(expired.entry.parts[0].value, '');
  assert.deepEqual(expired.entry.attemptsLog.map((item) => item.category), ['expired']);
});

test('redactOnTerminal 记录重启后仍可恢复终态；无标记的旧记录行为不变（payload 保留）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'warframe-outbox-redact-restart-'));
  const filePath = path.join(dir, 'outbox.json');
  const clock = clockAt();
  const outbox = createOutbox({ filePath, now: clock.now });
  await outbox.enqueue({ businessKey: 'redact', target: TARGET, redactOnTerminal: true, parts: [{ kind: 'text', value: '敏感内容' }] });
  await outbox.enqueue({ businessKey: 'plain', target: TARGET, parts: [{ kind: 'text', value: '普通内容' }] });
  await outbox.deliverPending({ target: TARGET, mailer: async () => ({ ok: true }) });

  const raw = await readFile(filePath, 'utf8');
  assert.equal(raw.includes('敏感内容'), false);
  assert.equal(raw.includes('普通内容'), true); // 掉落/世界状态/周报等旧记录行为不变
  const restarted = createOutbox({ filePath, now: clock.now });
  const loaded = await restarted.snapshot();
  const redact = loaded.entries.find((entry) => entry.businessKey === 'redact');
  const plain = loaded.entries.find((entry) => entry.businessKey === 'plain');
  assert.equal(redact.status, 'delivered');
  assert.deepEqual(redact.parts.map((part) => [part.value, part.status]), [['', 'sent']]);
  assert.ok(redact.contentHash);
  assert.equal(plain.parts[0].value, '普通内容');
  assert.equal(plain.status, 'delivered');
});

test('redactOnTerminal 的 pending 记录仍必须保留 payload，损坏的空 payload 不会被当作可投递欠账', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'warframe-outbox-redact-pending-'));
  const filePath = path.join(dir, 'outbox.json');
  const clock = clockAt();
  const outbox = createOutbox({ filePath, now: clock.now });
  await outbox.enqueue({ businessKey: 'redact-pending', target: TARGET, redactOnTerminal: true, parts: [{ kind: 'text', value: '待投递敏感内容' }] });
  const store = JSON.parse(await readFile(filePath, 'utf8'));
  store.entries[0].parts[0].value = '';
  await writeFile(filePath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');

  const restarted = createOutbox({ filePath, now: clock.now });
  const loaded = await restarted.snapshot();
  assert.equal(loaded.entries.length, 0);
});

test('keyPrefix 过滤：只投递本链业务键前缀的 pending；缺省不过滤（旧行为不变）', async () => {
  const clock = clockAt();
  const outbox = memoryOutbox(clock);
  await outbox.enqueue({ businessKey: `wishlist:${targetKeyOf(TARGET)}:${'a'.repeat(64)}`, target: TARGET, parts: [{ kind: 'text', value: '愿望' }] });
  await outbox.enqueue({ businessKey: `worldstate:${targetKeyOf(TARGET)}:${'b'.repeat(64)}`, target: TARGET, parts: [{ kind: 'text', value: '世界' }] });
  await outbox.enqueue({ businessKey: `weekly:${targetKeyOf(TARGET)}:${'c'.repeat(64)}`, target: TARGET, parts: [{ kind: 'text', value: '周报' }] });
  const wishlistCalls = [];
  const first = await outbox.deliverPending({ target: TARGET, mailer: async (part) => { wishlistCalls.push(part.value); return { ok: true }; }, keyPrefix: 'wishlist:' });
  assert.deepEqual(wishlistCalls, ['愿望']);
  assert.deepEqual(first.deliveredIds, ['ob-1']);
  const store = await outbox.snapshot();
  assert.equal(store.entries.find((entry) => entry.businessKey.startsWith('worldstate:')).status, 'pending');
  assert.equal(store.entries.find((entry) => entry.businessKey.startsWith('weekly:')).status, 'pending');
  // 缺省（不传 keyPrefix）恢复旧行为：整 target 的 pending 全投
  const allCalls = [];
  await outbox.deliverPending({ target: TARGET, mailer: async (part) => { allCalls.push(part.value); return { ok: true }; } });
  assert.deepEqual(allCalls.sort(), ['世界', '周报']);
});
