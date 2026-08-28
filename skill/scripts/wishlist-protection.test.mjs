// wishlist-protection.mjs 故障注入/合同测试（整改 R4 第二切片）。
//
// 零网络、零 QQ、零真实账本/Outbox：合并分组、令牌桶、并发上限与合并扫描
// 编排全部注入假时钟/假定时器/假 fetch/假 monitor 实现，可精确断言。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createConcurrencyGate,
  createTokenBucket,
  groupActiveWishes,
  runCoalescedWishlistScan,
  wishFetchGroupKey,
} from './wishlist-protection.mjs';

function createFakeTimers() {
  const entries = [];
  let seq = 0;
  return {
    setTimeout(fn, ms) { const id = ++seq; entries.push({ id, fn, ms, cleared: false }); return id; },
    clearTimeout(id) { const found = entries.find((entry) => entry.id === id); if (found) found.cleared = true; },
    fireTimeouts() {
      const fired = entries.filter((entry) => !entry.cleared);
      for (const entry of fired) entry.cleared = true;
      for (const entry of fired) entry.fn();
      return fired.length;
    },
    pending() { return entries.filter((entry) => !entry.cleared).length; },
  };
}

const wish = (overrides) => ({
  itemId: 'item-foo',
  slug: 'foo_prime_set',
  rank: 0,
  rankMode: 'exact',
  maxRank: 3,
  target: 'qqbot:group:a',
  ...overrides,
});

test('wishFetchGroupKey：按 itemId+rank 档合并，max/any/等级不同档互不合并', () => {
  assert.equal(wishFetchGroupKey(wish({ itemId: 'item-a', slug: 'a', rankMode: 'exact', rank: 0 })), 'item-a|exact|0|3');
  assert.equal(wishFetchGroupKey(wish({ itemId: 'item-a', slug: 'a', rankMode: 'max', rank: null, maxRank: 3 })), 'item-a|max||3');
  assert.equal(wishFetchGroupKey(wish({ itemId: 'item-a', slug: 'a', rankMode: 'any', rank: null, maxRank: null })), 'item-a|any||');
  // 同商品不同等级档 → 不同组键（Market /top?rank= 参数不同）
  assert.notEqual(
    wishFetchGroupKey(wish({ itemId: 'item-a', rank: 0, rankMode: 'exact' })),
    wishFetchGroupKey(wish({ itemId: 'item-a', rank: 1, rankMode: 'exact' })),
  );
  assert.equal(wishFetchGroupKey({ withoutItemId: true }), null);
});

test('groupActiveWishes：多 target 同商品同等级合并为一组，缺 itemId/slug 被过滤', () => {
  const groups = groupActiveWishes([
    wish({ itemId: 'item-a', rank: 0 }),
    wish({ itemId: 'item-a', rank: 0, target: 'qqbot:group:b' }),
    wish({ itemId: 'item-a', rank: 1 }),
    wish({ itemId: 'item-b', rank: 0, slug: 'b_set' }),
    { target: 'qqbot:c2c:x', slug: 'no-item' }, // 无 itemId → 过滤
    wish({ itemId: 'item-c', slug: '' }), // 无 slug → 过滤
  ]);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].wishes.length, 2);
  assert.deepEqual(groups.map((group) => group.key), ['item-a|exact|0|3', 'item-a|exact|1|3', 'item-b|exact|0|3']);
  // 代表 wish 保序（组内第一个）
  assert.equal(groups[0].wish.itemId, 'item-a');
  assert.equal(groups[2].wish.slug, 'b_set');
});

test('令牌桶：容量内即时消耗；耗尽后 consume 阻塞，假定时器推进补桶后释放（FIFO）', async () => {
  const clock = { now: 1_000_000 };
  const timers = createFakeTimers();
  const bucket = createTokenBucket({ capacity: 2, refillMs: 1_000, now: () => clock.now, timers });
  assert.deepEqual(bucket.status(), { tokens: 2, capacity: 2, refillMs: 1000, waiting: 0 });

  await bucket.consume();
  await bucket.consume();
  assert.equal(bucket.status().tokens, 0);
  const order = [];
  bucket.consume().then(() => order.push('a'));
  bucket.consume().then(() => order.push('b'));
  assert.equal(bucket.status().waiting, 2);

  // 推进 1 秒补 1 个令牌：唤醒第一个等待者
  clock.now += 1_000;
  timers.fireTimeouts();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['a']);
  assert.equal(bucket.status().waiting, 1);
  assert.equal(bucket.status().tokens, 0);

  // 再推进 2 秒：补 2 个（容量上限 2），释放第二个等待者并再攒 1 个
  clock.now += 2_000;
  timers.fireTimeouts();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(bucket.status().tokens, 1);

  bucket.dispose();
  assert.equal(timers.pending(), 0, 'dispose 清除补桶定时器');
});

test('令牌桶：长时间跨度的补桶按 elapsed/refillMs 累计且不超容量', async () => {
  const clock = { now: 0 };
  const timers = createFakeTimers();
  const bucket = createTokenBucket({ capacity: 3, refillMs: 1_000, now: () => clock.now, timers });
  clock.now += 2_500;
  assert.equal(bucket.status().tokens, 3, '超出容量被钳制');
  await bucket.consume();
  assert.equal(bucket.status().tokens, 2);
});

test('并发上限：limit=2 时前两任务立即运行、第三个 FIFO 排队，完成后放行', async () => {
  const gate = createConcurrencyGate({ limit: 2 });
  let running = 0;
  const maxObserved = { value: 0 };
  const trace = [];
  const task = (name, waitMs) => () => new Promise((resolve) => {
    running += 1;
    maxObserved.value = Math.max(maxObserved.value, running);
    trace.push(`start-${name}`);
    setTimeout(() => { running -= 1; trace.push(`end-${name}`); resolve(name); }, waitMs);
  });
  const first = gate.run(task('a', 5));
  const second = gate.run(task('b', 10));
  const third = gate.run(task('c', 1));
  await new Promise((resolve) => setImmediate(resolve)); // 让任务启动微任务落定
  assert.deepEqual(gate.status(), { limit: 2, running: 2, queued: 1 });
  assert.deepEqual(trace, ['start-a', 'start-b']);
  await Promise.all([first, second, third]);
  assert.deepEqual(gate.status(), { limit: 2, running: 0, queued: 0 });
  assert.ok(maxObserved.value <= 2, '并发不超过 2');
  assert.deepEqual(trace.filter((item) => item.startsWith('start-')), ['start-a', 'start-b', 'start-c'], '三个任务全部执行且 c 在第 2 个之后才开始');
  assert.equal(trace.filter((item) => item.startsWith('end-')).length, 3);
});

test('合并扫描真实使用并发门：多个组并行启动且峰值不超过 limit', async () => {
  let running = 0;
  let maxObserved = 0;
  const started = [];
  const result = await runCoalescedWishlistScan({
    wishes: [
      wish({ itemId: 'item-a', slug: 'a_set' }),
      wish({ itemId: 'item-b', slug: 'b_set' }),
      wish({ itemId: 'item-c', slug: 'c_set' }),
    ],
    tokenBucket: { consume: async () => {} },
    concurrency: createConcurrencyGate({ limit: 2 }),
    fetchOne: async (entry) => {
      running += 1;
      maxObserved = Math.max(maxObserved, running);
      started.push(entry.itemId);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running -= 1;
      return [{ id: `order-${entry.itemId}` }];
    },
    monitorTarget: async () => ({ ok: true }),
  });
  assert.equal(result.ok, true);
  assert.equal(maxObserved, 2, '合并编排应真正利用并发门，但不得超过 limit=2');
  assert.deepEqual(started, ['item-a', 'item-b', 'item-c']);
});

test('合并扫描：相同 itemId+rank 跨 target 只请求一次，逐 target 分发其所需组订单', async () => {
  const fetches = [];
  const monitors = [];
  const wishes = [
    wish({ itemId: 'item-a', rank: 0, target: 'qqbot:group:a' }),
    wish({ itemId: 'item-a', rank: 0, target: 'qqbot:group:b' }),
    wish({ itemId: 'item-b', rank: 0, slug: 'b_set', target: 'qqbot:group:a' }),
  ];
  const result = await runCoalescedWishlistScan({
    wishes,
    fetchOne: async (w) => { fetches.push(w.itemId); return [{ id: `order-${w.itemId}` }]; },
    tokenBucket: createTokenBucket({ capacity: 10, refillMs: 1_000 }),
    concurrency: createConcurrencyGate({ limit: 2 }),
    monitorTarget: async (target, targetWishes, info) => {
      monitors.push({ target, count: targetWishes.length, orders: info.orders, allFailed: info.allFailed });
      return { ok: true };
    },
  });
  assert.equal(fetches.length, 2, 'item-a 跨 targets 只请求一次');
  assert.deepEqual(new Set(fetches), new Set(['item-a', 'item-b']));
  assert.equal(monitors.length, 2, '每个 target 一次监控（per-target 语义保留）');
  const groupA = monitors.find((monitor) => monitor.target === 'qqbot:group:a');
  const groupB = monitors.find((monitor) => monitor.target === 'qqbot:group:b');
  assert.deepEqual(groupA.orders.map((order) => order.id), ['order-item-a', 'order-item-b']);
  assert.deepEqual(groupB.orders.map((order) => order.id), ['order-item-a']);
  assert.equal(groupA.allFailed, false);
  assert.equal(result.ok, true);
  assert.equal(result.groups, 2);
  assert.equal(result.fetched, 2);
  assert.equal(result.failedGroups, 0);
  assert.equal(result.marketAvailable, true);
  assert.equal(result.targets, 2);
});

test('合并扫描：部分组失败不阻断其余；target 所需组全败时 allFailed=true（诚实降级）', async () => {
  const monitors = [];
  const result = await runCoalescedWishlistScan({
    wishes: [
      wish({ itemId: 'item-a', rank: 0, target: 'qqbot:group:a' }),
      wish({ itemId: 'item-b', rank: 0, target: 'qqbot:group:a' }),
      wish({ itemId: 'item-a', rank: 0, target: 'qqbot:c2c:b' }),
    ],
    fetchOne: async (w) => {
      if (w.itemId === 'item-a') throw new Error('Warframe.Market top orders HTTP 503');
      return [{ id: 'order-item-b' }];
    },
    tokenBucket: createTokenBucket({ capacity: 10, refillMs: 1_000 }),
    concurrency: createConcurrencyGate({ limit: 2 }),
    monitorTarget: async (target, targetWishes, info) => {
      monitors.push({ target, orders: info.orders, allFailed: info.allFailed, hasFailures: info.hasFailures, failedKeys: info.failedKeys });
      return { ok: true };
    },
  });
  assert.equal(result.failedGroups, 1);
  assert.equal(result.fetched, 1);
  assert.equal(result.marketAvailable, true, '部分可用不算整体不可用');
  assert.equal(result.ok, false);
  const groupA = monitors.find((monitor) => monitor.target === 'qqbot:group:a');
  const groupB = monitors.find((monitor) => monitor.target === 'qqbot:c2c:b');
  assert.equal(groupA.allFailed, false, 'target A 仍有 item-b 成功');
  assert.equal(groupA.hasFailures, true, 'target A 有一组失败，不能标记为完整校准');
  assert.equal(groupA.failedKeys.length, 1);
  assert.deepEqual(groupA.orders.map((order) => order.id), ['order-item-b']);
  assert.equal(groupB.allFailed, true, 'target B 的唯一组失败 → 调用方应如实记 restError');
  assert.equal(groupB.hasFailures, true);
  assert.deepEqual(groupB.orders, []);
});

test('合并扫描：全部组失败 → marketAvailable=false；无活跃愿望 → 不调用任何注入函数', async () => {
  let fetchCalls = 0;
  let monitorCalls = 0;
  const result = await runCoalescedWishlistScan({
    wishes: [wish({ itemId: 'item-a' })],
    fetchOne: async () => { fetchCalls += 1; throw new Error('network down'); },
    tokenBucket: createTokenBucket({ capacity: 10, refillMs: 1_000 }),
    concurrency: createConcurrencyGate({ limit: 2 }),
    monitorTarget: async () => { monitorCalls += 1; return { ok: true }; },
  });
  assert.equal(result.marketAvailable, false, 'Market 完全不可用要如实报告');
  assert.equal(result.ok, false);
  assert.equal(result.failedGroups, 1);
  assert.equal(result.fetched, 0);
  assert.match(result.lastError, /network down/u);

  let calls = 0;
  const none = await runCoalescedWishlistScan({
    wishes: [],
    fetchOne: async () => { calls += 1; return []; },
    tokenBucket: createTokenBucket(),
    concurrency: createConcurrencyGate(),
    monitorTarget: async () => { calls += 1; return { ok: true }; },
  });
  assert.equal(none.reason, 'no_active_wishes');
  assert.equal(none.marketAvailable, null);
  assert.equal(calls, 0, '无活跃愿望不请求 Market');
});

test('合并扫描：monitorTarget 抛错（如 Outbox 入队失败）计入失败但不吞其他 target', async () => {
  const result = await runCoalescedWishlistScan({
    wishes: [
      wish({ itemId: 'item-a', target: 'qqbot:group:a' }),
      wish({ itemId: 'item-a', target: 'qqbot:c2c:b' }),
    ],
    fetchOne: async () => [{ id: 'o-1' }],
    tokenBucket: createTokenBucket({ capacity: 10, refillMs: 1_000 }),
    concurrency: createConcurrencyGate({ limit: 2 }),
    monitorTarget: async (target) => {
      if (target === 'qqbot:group:a') throw new Error('outbox storage full');
      return { ok: true, delivery: { sentParts: 0 } };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.targets, 1);
  assert.match(result.lastError, /outbox storage full/u);
  assert.equal(result.marketAvailable, true);
});
