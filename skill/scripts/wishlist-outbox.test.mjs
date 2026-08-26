import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { contentHashOf, createOutbox, targetKeyOf } from './notification-outbox.mjs';
import {
  defaultOutboxPath,
  manageWishlist,
  monitorWishlist,
  orderIdentity,
  processWishlistLiveOrder,
  wishlistHitBusinessKey,
  wishlistHitsToPairs,
} from './wishlist.mjs';

const IDENTITY = { target: 'qqbot:group:test', ownerId: 'member-a', ownerName: '测试用户' };
const TARGET_B = 'qqbot:c2c:member-b';
const CATALOG = [{ id: 'item-foo', slug: 'foo_prime_set', name: 'Foo Prime Set', zhName: '福 Prime 套装' }];
const SELLER = 'seller-a';
const ORDER = { id: 'o-1', itemId: 'item-foo', slug: 'foo_prime_set', type: 'sell', platinum: 20, perTrade: 1, seller: SELLER };
const BASE = Date.parse('2026-08-25T00:00:00.000Z');
const WISHLIST_TTL_MS = 10 * 60 * 1000;
const NOT_DUE_INTERVAL_MS = Number.MAX_SAFE_INTEGER;
const iso = (ms) => new Date(ms).toISOString();

function clockAt(startMs = BASE) {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms) => { current += ms; },
    set: (ms) => { current = ms; },
  };
}

async function fixture(clock = clockAt()) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'warframe-wishlist-outbox-'));
  const state = path.join(dir, 'wishlist.json');
  const outboxPath = path.join(dir, 'warframe-delivery-outbox.json');
  const outbox = createOutbox({ filePath: outboxPath, now: clock.now });
  const manage = {
    render: false,
    catalogFetcher: async () => CATALOG,
    fetchItemMetadata: async () => ({}),
  };
  return { dir, state, outbox, outboxPath, clock, manage };
}

// 命中卡默认不上图（cardDir=null → 纯文字 part）；需要媒体 part 时传渲染桩（renderCard）

async function createWish(state, manage, identity = IDENTITY) {
  const result = await manageWishlist('愿望 福 Prime ≤ 20', identity, state, manage);
  assert.equal(result.ok, true);
  return result.wish;
}

async function readStore(dir) {
  return JSON.parse(await readFile(path.join(dir, 'warframe-delivery-outbox.json'), 'utf8'));
}

async function readLedger(state) {
  return JSON.parse(await readFile(state, 'utf8'));
}

// mailer 收到的 part 是 Outbox 内部对象（终态擦除会就地清空 value）；
// 测试在发送时刻做快照，模拟真实投递（发送时即使用当时的值）。
function snapshotPart(part) {
  return { kind: part.kind, value: String(part.value ?? ''), transport: part.transport };
}

function okMailer(calls) {
  return async (part) => { calls.push(snapshotPart(part)); return { ok: true }; };
}

function failMailer(calls, category = 'timeout') {
  return async (part) => { calls.push(snapshotPart(part)); return { ok: false, category }; };
}

test('REST 校准 deliver 事务：命中先原子入队→提交 seen/calibration 账本→锁外逐 part 投递，终态擦除', async () => {
  const { dir, state, outbox, clock, manage } = await fixture();
  try {
    const wish = await createWish(state, manage);
    const calls = [];
    const result = await monitorWishlist(IDENTITY.target, state, dir, false, {
      ownerId: IDENTITY.ownerId,
      skipWebSocket: true,
      forceRest: true,
      fetchOrders: async () => [ORDER],
      outbox,
      mailer: okMailer(calls),
      now: clock.now,
      renderCard: async () => 'C:\\cards\\hit.png',
    });

    assert.equal(result.output, 'NO_REPLY\n');
    assert.equal(result.data.outbox, true);
    assert.equal(result.data.hitCount, 1);
    assert.equal(result.data.delivered, 'direct');
    assert.equal(result.data.delivery.sentParts, 2);
    // 锁外逐 part：图片先、文字后（与旧直投顺序一致）
    assert.deepEqual(calls.map((part) => part.kind), ['media', 'text']);
    assert.equal(calls[0].value, 'C:\\cards\\hit.png');
    assert.match(calls[1].value, /愿望单命中/u);
    assert.match(calls[1].value, new RegExp(SELLER, 'u')); // 瞬时 payload 含私聊模板

    // Outbox 记录：业务键 = 脱敏 targetKey + 稳定集合哈希；10min 业务 TTL；终态擦除
    const store = await readStore(dir);
    assert.equal(store.entries.length, 1);
    const entry = store.entries[0];
    const expectedKey = wishlistHitBusinessKey(IDENTITY.target, [{ orderIdentity: orderIdentity(ORDER), wishIds: [wish.id] }]);
    assert.equal(entry.businessKey, expectedKey);
    assert.equal(entry.target, undefined);
    assert.equal(entry.targetKey, targetKeyOf(IDENTITY.target));
    assert.equal(entry.redactOnTerminal, true);
    assert.equal(entry.expiresAt, iso(BASE + WISHLIST_TTL_MS));
    assert.equal(entry.status, 'delivered');
    assert.equal(entry.outcome, 'delivered');
    // 终态 payload 擦除：只留 contentHash/part 状态/时间/脱敏结果审计
    assert.equal(entry.contentHash, contentHashOf([{ kind: 'media', value: 'C:\\cards\\hit.png' }, { kind: 'text', value: calls[1].value }]));
    assert.deepEqual(entry.parts.map((part) => [part.kind, part.value, part.status]), [['media', '', 'sent'], ['text', '', 'sent']]);
    assert.deepEqual(entry.attemptsLog.map((item) => item.category), ['delivered', 'delivered']);
    assert.equal(store.tombstones[entry.businessKey], entry.deliveredAt);
    // 原始 target/seller 不落 Outbox 文件
    const raw = await readFile(path.join(dir, 'warframe-delivery-outbox.json'), 'utf8');
    assert.equal(raw.includes(IDENTITY.target), false);
    assert.equal(raw.includes(SELLER), false);

    // wishlist 账本提交：seen/lastMatchAt/calibration 已收敛，seller 永不入账本
    const ledger = await readLedger(state);
    assert.ok(ledger.wishes[0].seenOrderIds.includes(orderIdentity(ORDER)));
    assert.ok(ledger.wishes[0].lastMatchAt);
    assert.equal(ledger.calibration.targets[IDENTITY.target].lastRestAt, iso(BASE));
    assert.equal(JSON.stringify(ledger).includes(SELLER), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('投递失败留 pending：下一轮 REST not_due 先补投，同一业务键不重复入队', async () => {
  const { dir, state, outbox, clock, manage } = await fixture();
  try {
    await createWish(state, manage);
    const firstCalls = [];
    const first = await monitorWishlist(IDENTITY.target, state, null, false, {
      ownerId: IDENTITY.ownerId,
      skipWebSocket: true,
      forceRest: true,
      fetchOrders: async () => [ORDER],
      outbox,
      mailer: failMailer(firstCalls),
      now: clock.now,
    });
    assert.equal(first.data.delivered, 'queued');
    assert.equal(first.data.delivery.failedParts, 1);
    assert.equal(firstCalls.length, 1);

    // 第二轮：calibration 未到点（not_due）——补投发生在 not_due 短路前
    const secondCalls = [];
    const second = await monitorWishlist(IDENTITY.target, state, null, false, {
      ownerId: IDENTITY.ownerId,
      skipWebSocket: true,
      forceRest: false,
      restIntervalMs: NOT_DUE_INTERVAL_MS,
      fetchOrders: async () => [ORDER],
      outbox,
      mailer: okMailer(secondCalls),
      now: clock.now,
    });
    assert.equal(second.output, 'NO_REPLY\n');
    assert.equal(second.data.reason, 'not_due');
    assert.equal(second.data.outbox, true);
    assert.equal(second.data.delivery.sentParts, 1);
    assert.equal(secondCalls.length, 1); // 只有欠账那条补投，没有新通知
    const store = await readStore(dir);
    assert.equal(store.entries.length, 1); // 未重复入队
    assert.equal(store.entries[0].status, 'delivered');
    assert.equal(store.entries[0].parts[0].attempts, 2);
    assert.deepEqual(store.entries[0].attemptsLog.map((item) => item.category), ['failed', 'delivered']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('入队成功但账本写失败：下轮同一业务键恢复（不重复入队、不重复投递、账本收敛）', async () => {
  const { dir, state, outbox, clock, manage } = await fixture();
  try {
    await createWish(state, manage);
    const before = await readFile(state, 'utf8');
    const firstCalls = [];
    await monitorWishlist(IDENTITY.target, state, null, false, {
      ownerId: IDENTITY.ownerId,
      skipWebSocket: true,
      forceRest: true,
      fetchOrders: async () => [ORDER],
      outbox,
      mailer: failMailer(firstCalls),
      now: clock.now,
    });
    // 模拟崩溃窗口：Outbox 已入队（pending），但账本写盘丢失（恢复成旧账本）
    await writeFile(state, before, 'utf8');

    const secondCalls = [];
    const second = await monitorWishlist(IDENTITY.target, state, null, false, {
      ownerId: IDENTITY.ownerId,
      skipWebSocket: true,
      forceRest: true,
      fetchOrders: async () => [ORDER],
      outbox,
      mailer: okMailer(secondCalls),
      now: clock.now,
    });
    // 本轮先补投 pending（1 次），随后同业务键命中去重不再投
    assert.equal(secondCalls.length, 1);
    assert.equal(second.data.outbox, true);
    assert.equal(second.data.delivery.sentParts, 1);
    const store = await readStore(dir);
    assert.equal(store.entries.length, 1);
    assert.equal(store.entries[0].status, 'delivered');
    assert.equal(store.entries[0].parts[0].attempts, 2);
    // 账本最终收敛（seen 已写入）
    const ledger = await readLedger(state);
    assert.ok(ledger.wishes[0].seenOrderIds.includes(orderIdentity(ORDER)));
    assert.equal(ledger.wishes[0].initialized, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('WS 一笔订单命中多 target：全部入队成功才一次提交 ledger，每 target 独立业务键与投递状态', async () => {
  const { dir, state, outbox, clock, manage } = await fixture();
  try {
    const wishA = await createWish(state, manage);
    const wishB = await createWish(state, manage, { target: TARGET_B, ownerId: 'member-b', ownerName: '用户B' });
    const results = await processWishlistLiveOrder(ORDER, state, null, { outbox, now: clock.now });
    assert.equal(results.length, 2);
    const byTarget = Object.fromEntries(results.map((result) => [result.target, result]));
    assert.equal(byTarget[IDENTITY.target].outbox, true);
    assert.equal(byTarget[TARGET_B].outbox, true);
    assert.notEqual(byTarget[IDENTITY.target].businessKey, byTarget[TARGET_B].businessKey);
    assert.match(byTarget[IDENTITY.target].businessKey, /^wishlist:[0-9a-f]{64}:[0-9a-f]{64}$/u);
    // 业务键不含原始 target/order/wish id
    for (const result of results) {
      assert.equal(result.businessKey.includes(IDENTITY.target), false);
      assert.equal(result.businessKey.includes(TARGET_B), false);
      assert.equal(result.businessKey.includes(ORDER.id), false);
      assert.equal(result.businessKey.includes(wishA.id), false);
      assert.equal(result.businessKey.includes(wishB.id), false);
    }

    // 账本一次提交：两个 target 的 wish 都已 seen
    const ledger = await readLedger(state);
    const seenA = ledger.wishes.find((wish) => wish.target === IDENTITY.target && wish.ownerId === IDENTITY.ownerId);
    const seenB = ledger.wishes.find((wish) => wish.target === TARGET_B);
    assert.ok(seenA.seenOrderIds.includes(orderIdentity(ORDER)));
    assert.ok(seenB.seenOrderIds.includes(orderIdentity(ORDER)));
    assert.equal(JSON.stringify(ledger).includes(SELLER), false);

    // 每 target 独立投递：各自 mailer 只收到本 target 的 part
    const callsA = [];
    const callsB = [];
    const summaryA = await outbox.deliverPending({ target: IDENTITY.target, mailer: okMailer(callsA), keyPrefix: 'wishlist:' });
    const summaryB = await outbox.deliverPending({ target: TARGET_B, mailer: okMailer(callsB), keyPrefix: 'wishlist:' });
    assert.deepEqual(summaryA.deliveredIds, [byTarget[IDENTITY.target].entryId]);
    assert.deepEqual(summaryB.deliveredIds, [byTarget[TARGET_B].entryId]);
    assert.equal(callsA.length, 1);
    assert.equal(callsB.length, 1);
    const store = await readStore(dir);
    assert.equal(store.entries.length, 2);
    assert.equal(store.entries.every((entry) => entry.status === 'delivered' && entry.parts.every((part) => part.value === '')), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('第二目标入队失败：不提交 seen；恢复后同业务键去重、全量投递', async () => {
  const { dir, state, outbox, clock, manage } = await fixture();
  try {
    await createWish(state, manage);
    await createWish(state, manage, { target: TARGET_B, ownerId: 'member-b', ownerName: '用户B' });
    const before = JSON.stringify(await readLedger(state));
    const failingOutbox = {
      enqueue: async (input) => {
        if (input.target === TARGET_B) throw new Error('outbox storage full');
        return outbox.enqueue(input);
      },
      deliverPending: (...args) => outbox.deliverPending(...args),
    };
    await assert.rejects(
      processWishlistLiveOrder(ORDER, state, null, { outbox: failingOutbox, now: clock.now }),
      /outbox storage full/u,
    );
    // seen 未提交（A 的入队是孤儿 pending，由下轮同键恢复）；B 无记录
    const ledgerAfter = JSON.stringify(await readLedger(state));
    assert.equal(ledgerAfter, before);
    const storeAfter = await readStore(dir);
    assert.equal(storeAfter.entries.length, 1);
    assert.equal(storeAfter.entries[0].status, 'pending');

    // 恢复轮：全部入队成功 → 一次提交 → 每 target 各投一次
    const results = await processWishlistLiveOrder(ORDER, state, null, { outbox, now: clock.now });
    assert.equal(results.length, 2);
    const ledger = await readLedger(state);
    assert.equal(ledger.wishes.filter((wish) => wish.seenOrderIds.includes(orderIdentity(ORDER))).length, 2);
    const callsA = [];
    const callsB = [];
    const summaryA = await outbox.deliverPending({ target: IDENTITY.target, mailer: okMailer(callsA), keyPrefix: 'wishlist:' });
    const summaryB = await outbox.deliverPending({ target: TARGET_B, mailer: okMailer(callsB), keyPrefix: 'wishlist:' });
    assert.equal(callsA.length, 1);
    assert.equal(callsB.length, 1);
    assert.equal(summaryA.deliveredIds.length + summaryB.deliveredIds.length, 2);
    const store = await readStore(dir);
    assert.equal(store.entries.length, 2);
    assert.equal(store.entries.every((entry) => entry.status === 'delivered'), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('REST/WS 双源同业务键去重（账本写失败窗口）：只提醒一次', async () => {
  const { dir, state, outbox, clock, manage } = await fixture();
  try {
    const wish = await createWish(state, manage);
    const beforeWs = await readFile(state, 'utf8'); // WS 前的账本（未 seen）
    // WS 源：先入队成功（Outbox pending），但账本写盘丢失（模拟崩溃窗口）
    await processWishlistLiveOrder(ORDER, state, null, { outbox, now: clock.now });
    await writeFile(state, beforeWs, 'utf8');

    // REST 源：同一 orderIdentity+wish 集合 → 同业务键；先补投 pending 后去重
    const calls = [];
    const result = await monitorWishlist(IDENTITY.target, state, null, false, {
      ownerId: IDENTITY.ownerId,
      skipWebSocket: true,
      forceRest: true,
      fetchOrders: async () => [ORDER],
      outbox,
      mailer: okMailer(calls),
      now: clock.now,
    });
    assert.equal(calls.length, 1); // 只投一次（补投那一条）
    assert.equal(result.data.hitCount, 1);
    assert.equal(result.data.delivery.sentParts, 1);
    const store = await readStore(dir);
    assert.equal(store.entries.length, 1, 'REST 与 WS 同键去重：同一 order+wish 只有一条记录');
    const expectedKey = wishlistHitBusinessKey(IDENTITY.target, [{ orderIdentity: orderIdentity(ORDER), wishIds: [wish.id] }]);
    assert.equal(store.entries[0].businessKey, expectedKey);
    assert.equal(store.entries[0].status, 'delivered');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('图片成功文字失败：下一轮只补投文字，不重发成功图片', async () => {
  const { dir, state, outbox, clock, manage } = await fixture();
  try {
    await createWish(state, manage);
    const firstCalls = [];
    const first = await monitorWishlist(IDENTITY.target, state, dir, false, {
      ownerId: IDENTITY.ownerId,
      skipWebSocket: true,
      forceRest: true,
      fetchOrders: async () => [ORDER],
      outbox,
      mailer: async (part) => {
        firstCalls.push(part);
        return part.kind === 'media' ? { ok: true } : { ok: false, category: 'provider_rejected' };
      },
      now: clock.now,
      renderCard: async () => 'C:\\cards\\hit.png',
    });
    assert.equal(first.data.delivery.sentParts, 1);
    assert.equal(first.data.delivery.failedParts, 1);
    assert.deepEqual(firstCalls.map((part) => part.kind), ['media', 'text']);

    const secondCalls = [];
    const second = await monitorWishlist(IDENTITY.target, state, dir, false, {
      ownerId: IDENTITY.ownerId,
      skipWebSocket: true,
      forceRest: false,
      restIntervalMs: NOT_DUE_INTERVAL_MS,
      fetchOrders: async () => [ORDER],
      outbox,
      mailer: okMailer(secondCalls),
      now: clock.now,
      renderCard: async () => 'C:\\cards\\hit.png',
    });
    assert.deepEqual(secondCalls.map((part) => part.kind), ['text'], '成功媒体不重发');
    assert.equal(second.data.delivery.sentParts, 1);
    const store = await readStore(dir);
    assert.equal(store.entries.length, 1);
    assert.equal(store.entries[0].status, 'delivered');
    assert.deepEqual(store.entries[0].parts.map((part) => [part.kind, part.status]), [['media', 'sent'], ['text', 'sent']]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('10 分钟业务 TTL：过期不盲发，终态 payload 立即擦除', async () => {
  const { dir, state, outbox, clock, manage } = await fixture();
  try {
    await createWish(state, manage);
    const firstCalls = [];
    await monitorWishlist(IDENTITY.target, state, null, false, {
      ownerId: IDENTITY.ownerId,
      skipWebSocket: true,
      forceRest: true,
      fetchOrders: async () => [ORDER],
      outbox,
      mailer: failMailer(firstCalls),
      now: clock.now,
    });
    let store = await readStore(dir);
    assert.equal(store.entries[0].status, 'pending');
    assert.equal(store.entries[0].expiresAt, iso(BASE + WISHLIST_TTL_MS));

    // 推进到 10min 业务 TTL 之后：立即置 expired，不再调用 mailer
    clock.advance(WISHLIST_TTL_MS + 60_000);
    const laterCalls = [];
    const second = await monitorWishlist(IDENTITY.target, state, null, false, {
      ownerId: IDENTITY.ownerId,
      skipWebSocket: true,
      forceRest: false,
      restIntervalMs: NOT_DUE_INTERVAL_MS,
      fetchOrders: async () => [ORDER],
      outbox,
      mailer: okMailer(laterCalls),
      now: clock.now,
    });
    assert.equal(second.data.reason, 'not_due');
    assert.equal(laterCalls.length, 0, '过期通知绝不盲发');
    assert.deepEqual(second.data.delivery.expiredIds, [store.entries[0].id]);
    store = await readStore(dir);
    assert.equal(store.entries[0].status, 'expired');
    assert.equal(store.entries[0].outcome, 'expired');
    // 终态擦除：只留 contentHash/状态/时间/脱敏审计
    assert.equal(store.entries[0].parts[0].value, '');
    assert.equal(store.entries[0].parts[0].status, 'pending');
    assert.ok(store.entries[0].contentHash);
    assert.deepEqual(store.entries[0].attemptsLog.map((item) => item.category), ['failed', 'expired']);
    const raw = await readFile(path.join(dir, 'warframe-delivery-outbox.json'), 'utf8');
    assert.equal(raw.includes('愿望单命中'), false);
    assert.equal(raw.includes(SELLER), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('未到期欠账跨重启恢复：pending 保留 payload 到 10min TTL 并补投', async () => {
  const { dir, state, outbox, clock, manage } = await fixture();
  try {
    await createWish(state, manage);
    await monitorWishlist(IDENTITY.target, state, null, false, {
      ownerId: IDENTITY.ownerId,
      skipWebSocket: true,
      forceRest: true,
      fetchOrders: async () => [ORDER],
      outbox,
      mailer: failMailer([]),
      now: clock.now,
    });
    // 「进程重启」：新 Outbox 实例从磁盘恢复（pending 仍带 payload）
    const restarted = createOutbox({ filePath: path.join(dir, 'warframe-delivery-outbox.json'), now: clock.now });
    const restored = await restarted.snapshot();
    assert.equal(restored.entries[0].status, 'pending');
    assert.equal(restored.entries[0].parts[0].value.includes('愿望单命中'), true);
    const calls = [];
    const summary = await restarted.deliverPending({ target: IDENTITY.target, mailer: okMailer(calls), keyPrefix: 'wishlist:' });
    assert.equal(calls.length, 1);
    assert.deepEqual(summary.deliveredIds, [restored.entries[0].id]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('业务键语义：集合顺序无关、同单多愿聚合、双源同键、不含原始标识', () => {
  const wishIds = ['WABC1', 'WXYZ9'];
  const pair = { orderIdentity: orderIdentity(ORDER), wishIds };
  const key = wishlistHitBusinessKey(IDENTITY.target, [pair]);
  // 集合语义：愿望顺序无关
  assert.equal(key, wishlistHitBusinessKey(IDENTITY.target, [{ orderIdentity: orderIdentity(ORDER), wishIds: [...wishIds].reverse() }]));
  // 命中愿望集合不同 → 不同键（同单新增愿望不会被旧 tombstone 吞掉）
  assert.notEqual(key, wishlistHitBusinessKey(IDENTITY.target, [{ orderIdentity: orderIdentity(ORDER), wishIds: ['WABC1'] }]));
  // 订单身份不同（同 id 改价=新候选）→ 不同键
  assert.notEqual(key, wishlistHitBusinessKey(IDENTITY.target, [{ orderIdentity: `${ORDER.id}@19:1:`, wishIds }]));
  // 不同 target → 不同键（每 target 独立业务键）
  assert.notEqual(key, wishlistHitBusinessKey(TARGET_B, [pair]));
  // 不含原始 target/order/wish id（只有脱敏摘要）
  assert.equal(key.includes(IDENTITY.target), false);
  assert.equal(key.includes(ORDER.id), false);
  assert.equal(key.includes('WABC1'), false);
  assert.match(key, /^wishlist:[0-9a-f]{64}:[0-9a-f]{64}$/u);

  // 命中 → 稳定对：同一订单多愿望聚合为 { order, wishes } 一对
  const pairs = wishlistHitsToPairs([
    { wishId: 'WABC1', order: ORDER },
    { wishId: 'WXYZ9', order: ORDER },
    { wishId: 'WABC1', order: ORDER },
  ]);
  assert.deepEqual(pairs, [{ orderIdentity: orderIdentity(ORDER), wishIds: ['WABC1', 'WXYZ9'] }]);
});

test('defaultOutboxPath 与其他切片一致（与状态同目录 warframe-delivery-outbox.json）', () => {
  const statePath = path.join(os.tmpdir(), 'state', 'warframe-wishlist.json');
  assert.equal(defaultOutboxPath(statePath), path.join(os.tmpdir(), 'state', 'warframe-delivery-outbox.json'));
});
