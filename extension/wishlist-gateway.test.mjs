// wishlist-gateway.mjs 故障注入测试（整改 R4 第一切片）。
//
// 全部测试零网络、零 QQ、零真实账本/快照：WebSocket、时钟、定时器、
// 账本索引与恢复扫描全部注入假实现或可控制 deferred。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWishlistGateway, GATEWAY_STATE } from './wishlist-gateway.mjs';

const EVENT_ROUTE = '@wfm|event/subscriptions/newOrder';
const SUBSCRIBE_ROUTE = '@wfm|cmd/subscribe/newOrders';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createFakeTimers() {
  const entries = [];
  let seq = 0;
  return {
    setTimeout(fn, ms) { const id = ++seq; entries.push({ id, fn, ms, kind: 'timeout', cleared: false }); return id; },
    clearTimeout(id) { const found = entries.find((entry) => entry.id === id); if (found) found.cleared = true; },
    setInterval(fn, ms) { const id = ++seq; entries.push({ id, fn, ms, kind: 'interval', cleared: false }); return id; },
    clearInterval(id) { const found = entries.find((entry) => entry.id === id); if (found) found.cleared = true; },
    fireTimeouts() {
      const fired = entries.filter((entry) => entry.kind === 'timeout' && !entry.cleared);
      for (const entry of fired) entry.cleared = true;
      for (const entry of fired) entry.fn();
      return fired.length;
    },
    // 精确定时器操作：断线重连与 20～30 秒保护轮询并存时按等待时长挑选触发
    fireTimeoutWhere(predicate) {
      const found = entries.find((entry) => entry.kind === 'timeout' && !entry.cleared && predicate(entry));
      if (!found) return null;
      found.cleared = true;
      found.fn();
      return found;
    },
    pendingTimeoutWaits() {
      return entries.filter((entry) => entry.kind === 'timeout' && !entry.cleared).map((entry) => entry.ms);
    },
    pendingTimeouts() { return entries.filter((entry) => entry.kind === 'timeout' && !entry.cleared).length; },
    pendingIntervals() { return entries.filter((entry) => entry.kind === 'interval' && !entry.cleared).length; },
  };
}

class FakeSocket {
  static instances = [];
  constructor(url, protocol) {
    this.url = url;
    this.protocol = protocol;
    this.sent = [];
    this.closed = false;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    FakeSocket.instances.push(this);
  }

  send(value) { this.sent.push(value); }
  open() { this.onopen?.({}); }
  message(value) { this.onmessage?.({ data: typeof value === 'string' ? value : JSON.stringify(value) }); }
  error() { this.onerror?.({}); }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({});
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness(overrides = {}) {
  const state = { nowMs: 1_700_000_000_000 };
  const timers = createFakeTimers();
  const scans = [];
  const protectionScans = [];
  const metricsEvents = [];
  const gateway = createWishlistGateway({
    WebSocketImpl: FakeSocket,
    now: () => state.nowMs,
    timers,
    loadItemIds: async () => new Set(overrides.itemIds || ['item-foo']),
    onOpen: overrides.onOpen || ((socket) => socket.send(JSON.stringify({ route: SUBSCRIBE_ROUTE }))),
    onOrder: overrides.onOrder || (async () => {}),
    recoveryScan: overrides.recoveryScan || (async () => { scans.push(state.nowMs); return { ok: true, targets: 1 }; }),
    protectionScan: overrides.protectionScan || (async () => { protectionScans.push(state.nowMs); return { ok: true }; }),
    metricsSink: overrides.metricsSink || ((event) => { metricsEvents.push(event); }),
    ...(overrides.gateway || {}),
  });
  return { state, timers, scans, protectionScans, metricsEvents, gateway };
}

test('初次成功连接不扫：状态按未连接→连接中→健康演进并记录活跃时间', async () => {
  FakeSocket.instances = [];
  const { state, timers, gateway } = harness();
  assert.equal(gateway.status().stopped, true);
  assert.equal(gateway.status().health, GATEWAY_STATE.NOT_CONNECTED);

  await gateway.start();
  assert.equal(gateway.status().health, GATEWAY_STATE.CONNECTING);
  assert.equal(gateway.status().socketOpen, true);
  assert.equal(FakeSocket.instances.length, 1);
  const socket = FakeSocket.instances[0];
  assert.equal(socket.url, 'wss://ws.warframe.market/socket');
  assert.equal(socket.protocol, 'wfm');

  state.nowMs += 1;
  socket.open();
  assert.equal(gateway.status().health, GATEWAY_STATE.HEALTHY);
  assert.equal(gateway.status().connectedAt, new Date(state.nowMs).toISOString());
  assert.equal(gateway.status().lastActivityAt, new Date(state.nowMs).toISOString());
  assert.ok(socket.sent.length >= 1);
  assert.equal(JSON.parse(socket.sent[0]).route, SUBSCRIBE_ROUTE);

  // 初次成功连接绝不触发恢复扫描
  await flush();
  assert.equal(gateway.status().recoveryScan.running, false);
  assert.equal(gateway.status().recoveryScan.lastStartedAt, null);
  assert.equal(gateway.status().disconnectCount, 0);
  assert.equal(gateway.status().reconnectCount, 0);

  await gateway.stop();
  assert.equal(gateway.status().stopped, true);
  assert.equal(gateway.status().health, GATEWAY_STATE.NOT_CONNECTED);
  assert.equal(timers.pendingIntervals(), 0, 'stop 清掉索引刷新定时器');
});

test('消息刷新最近活跃；非索引商品不进入订单队列；同一 socket 重复 open 不重复处理', async () => {
  FakeSocket.instances = [];
  const state = { nowMs: 1_700_000_000_000 };
  const timers = createFakeTimers();
  const calls = [];
  const first = deferred();
  const second = deferred();
  const liv = createWishlistGateway({
    WebSocketImpl: FakeSocket,
    now: () => state.nowMs,
    timers,
    loadItemIds: async () => new Set(['item-foo']),
    onOpen: (socket) => socket.send(JSON.stringify({ route: SUBSCRIBE_ROUTE })),
    onOrder: async (order) => {
      calls.push(order.id);
      if (order.id === 'o-1') await first.promise;
      if (order.id === 'o-2') await second.promise;
    },
    recoveryScan: async () => {},
  });
  await liv.start();
  const socket = FakeSocket.instances[0];
  socket.open();
  socket.open();
  assert.equal(socket.sent.length, 1, '同一 socket 重复 open 不重复订阅');
  state.nowMs += 10;
  socket.message({ route: '@wfm|event/subscriptions/other', payload: { itemId: 'item-foo' } });
  assert.equal(liv.status().lastActivityAt, new Date(state.nowMs).toISOString(), '任何消息都刷新最近活跃');
  assert.deepEqual(calls, []);

  socket.message({ route: EVENT_ROUTE, payload: { id: 'o-1', itemId: 'item-foo', type: 'sell' } });
  socket.message({ route: EVENT_ROUTE, payload: { id: 'o-2', itemId: 'item-foo', type: 'sell' } });
  socket.message({ route: EVENT_ROUTE, payload: { id: 'o-other', itemId: 'item-unknown', type: 'sell' } });
  await flush();
  assert.deepEqual(calls, ['o-1'], '串行队列：第二条订单在第一条完成后才开始');
  first.resolve();
  await flush();
  assert.deepEqual(calls, ['o-1', 'o-2']);
  second.resolve();
  await flush();
  assert.deepEqual(calls, ['o-1', 'o-2'], '非索引商品不进入订单队列');

  await liv.stop();
});

test('WebSocket 构造失败如实进入 unhealthy，并按退避继续重连', async () => {
  const timers = createFakeTimers();
  class BrokenSocket {
    constructor() { throw new Error('constructor unavailable'); }
  }
  const gateway = createWishlistGateway({
    WebSocketImpl: BrokenSocket,
    timers,
    now: () => 1_700_000_000_000,
    loadItemIds: async () => new Set(['item-foo']),
  });

  await gateway.start();
  assert.equal(gateway.status().health, GATEWAY_STATE.UNHEALTHY);
  assert.equal(gateway.status().socketOpen, false);
  assert.equal(gateway.status().disconnectedSince, new Date(1_700_000_000_000).toISOString());
  // 断线保护第二切片：除了退避重连定时器，还安排了 20～30 秒保护轮询定时器
  assert.equal(timers.pendingTimeouts(), 2, '重连退避 + 保护轮询各一个定时器');
  assert.equal(gateway.status().protection.mode, 'protection');

  gateway.stop();
  assert.equal(timers.pendingTimeouts(), 0);
});

test('关闭→重连→恰好一次恢复扫描，并记录断线起点与恢复时间', async () => {
  FakeSocket.instances = [];
  const { state, timers, scans, gateway } = harness({
    gateway: { jitter: () => 0.5 },
  });
  await gateway.start();
  let socket = FakeSocket.instances[0];
  socket.open();
  await flush();
  assert.equal(scans.length, 0, '初次连接不扫');

  // 断线：healthy → unhealthy，记录 disconnectedSince 并安排重连
  state.nowMs += 100;
  socket.error();
  assert.equal(gateway.status().health, GATEWAY_STATE.UNHEALTHY);
  assert.equal(gateway.status().socketOpen, false);
  assert.equal(gateway.status().disconnectedSince, new Date(state.nowMs).toISOString());
  assert.equal(gateway.status().disconnectCount, 1);
  assert.equal(gateway.status().lastRecoveredAt, null);
  // 保护轮询定时器与退避重连定时器并存（首次重连等待 1000ms、保护轮询 25s）
  assert.deepEqual(timers.pendingTimeoutWaits().sort((a, b) => a - b), [1000, 25000], '重连退避 + 保护轮询');
  assert.equal(gateway.status().reconnectMs, 2000, '退避翻倍');
  assert.equal(gateway.status().protection.mode, 'protection');

  // 重连成功：触发恰好一次恢复扫描（先等保护轮询的扫描槽完成，避免单飞遮挡）
  state.nowMs += 1;
  timers.fireTimeouts();
  await flush();
  assert.equal(gateway.status().health, GATEWAY_STATE.CONNECTING);
  socket = FakeSocket.instances[1];
  socket.open();
  assert.equal(gateway.status().health, GATEWAY_STATE.HEALTHY);
  assert.equal(gateway.status().lastDisconnectedAt, new Date(state.nowMs - 1).toISOString());
  assert.equal(gateway.status().lastRecoveredAt, new Date(state.nowMs).toISOString());
  assert.equal(gateway.status().disconnectedSince, null);
  assert.equal(gateway.status().reconnectMs, 1000, '恢复后退避重置');
  await flush();
  assert.equal(scans.length, 1, '恢复扫描触发一次');
  assert.equal(gateway.status().recoveryScan.running, false);
  assert.equal(gateway.status().recoveryScan.lastCompletedAt, new Date(scans[0]).toISOString());
  assert.deepEqual(gateway.status().recoveryScan.lastResult, { ok: true, targets: 1 });
  assert.equal(gateway.status().recoveryScan.lastError, null);

  // 再次断线→重连：新的恢复周期允许第二次恢复扫描
  const firstScanAt = scans[0];
  state.nowMs += 200;
  socket.error();
  state.nowMs += 1;
  timers.fireTimeouts();
  await flush();
  FakeSocket.instances[2].open();
  await flush();
  assert.equal(scans.length, 2, '新恢复周期触发第二次恢复扫描');
  assert.ok(scans[1] > firstScanAt);
  assert.equal(gateway.status().disconnectCount, 2);

  await gateway.stop();
});

test('重复 open 不重扫：同一 socket 重复 open 不产生额外扫描', async () => {
  FakeSocket.instances = [];
  const { state, timers, scans, gateway } = harness();
  await gateway.start();
  let socket = FakeSocket.instances[0];
  socket.open();
  state.nowMs += 1;
  socket.open(); // 初次 healthy 后的重复 open 事件
  socket.open();
  await flush();
  assert.equal(scans.length, 0, '初次连接 + 重复 open 都不扫');

  socket.error();
  state.nowMs += 1;
  timers.fireTimeouts();
  await flush();
  socket = FakeSocket.instances[1];
  socket.open();
  await flush();
  assert.equal(scans.length, 1, '恢复扫描一次');
  socket.open(); // 恢复后的重复 open 事件
  socket.open();
  await flush();
  assert.equal(scans.length, 1, '重复 open 不重扫');

  await gateway.stop();
});

test('连接抖动单飞：扫描进行中再次断线重连不并发重复，完成后的新恢复周期允许第二次扫描', async () => {
  FakeSocket.instances = [];
  const gate = deferred();
  const { state, timers, scans, gateway } = harness({
    recoveryScan: async () => { scans.push(state.nowMs); await gate.promise; return { ok: true, targets: 2 }; },
  });
  await gateway.start();
  let socket = FakeSocket.instances[0];
  socket.open();
  await flush();
  assert.equal(scans.length, 0);

  // 第一次断线→重连：恢复扫描启动并被 gate 挂住
  socket.error();
  state.nowMs += 1;
  timers.fireTimeouts();
  await flush();
  socket = FakeSocket.instances[1];
  socket.open();
  await flush();
  assert.equal(scans.length, 1);
  assert.equal(gateway.status().recoveryScan.running, true);

  // 扫描尚未完成时连接抖动（close→reconnect→open）：单飞不新增扫描
  socket.error();
  state.nowMs += 1;
  timers.fireTimeouts();
  await flush();
  const socketAfterJitter = FakeSocket.instances[2];
  socketAfterJitter.open();
  await flush();
  assert.equal(scans.length, 1, '抖动不并发重复扫描');
  assert.equal(gateway.status().recoveryScan.running, true);

  // 扫描完成后：下一次断线→重连是新的恢复周期，允许第二次恢复扫描
  state.nowMs += 1;
  gate.resolve();
  await flush();
  assert.equal(gateway.status().recoveryScan.running, false);
  assert.equal(scans.length, 1);

  socketAfterJitter.error();
  state.nowMs += 1;
  timers.fireTimeouts();
  await flush();
  FakeSocket.instances[3].open();
  await flush();
  assert.equal(scans.length, 2, '新恢复周期允许第二次扫描');

  await gateway.stop();
});

test('stop 后不扫：断线后停止，定时器不再重连也不扫描；重启后初次连接仍不扫', async () => {
  FakeSocket.instances = [];
  const { state, timers, scans, gateway } = harness();
  await gateway.start();
  const socket = FakeSocket.instances[0];
  socket.open();
  await flush();
  assert.equal(scans.length, 0);

  socket.error(); // 断线，安排重连
  gateway.stop();
  assert.equal(gateway.status().stopped, true);
  assert.equal(timers.pendingTimeouts(), 0, 'stop 清掉重连定时器');
  assert.equal(timers.pendingIntervals(), 0, 'stop 清掉索引刷新定时器');
  const socketCount = FakeSocket.instances.length;
  assert.equal(timers.fireTimeouts(), 0);
  assert.equal(FakeSocket.instances.length, socketCount, 'stop 后不重连');
  await flush();
  assert.equal(scans.length, 0, 'stop 后不扫');

  // 同一实例重新 start（重启语义）：初次连接仍不扫，不把上次断线当恢复
  await gateway.start();
  state.nowMs += 1;
  FakeSocket.instances[socketCount].open();
  await flush();
  assert.equal(scans.length, 0, '重启后初次连接不扫');

  await gateway.stop();
});

test('恢复扫描失败记录 lastError 且留待下一次恢复周期重试', async () => {
  FakeSocket.instances = [];
  const gate = deferred();
  const { state, timers, gateway } = harness({
    recoveryScan: async () => { await gate.promise; throw new Error('market unavailable'); },
  });
  await gateway.start();
  let socket = FakeSocket.instances[0];
  socket.open();
  socket.error();
  state.nowMs += 1;
  timers.fireTimeouts();
  await flush();
  socket = FakeSocket.instances[1];
  socket.open();
  await flush();
  assert.equal(gateway.status().recoveryScan.running, true, '扫描在等待网络故障');
  gate.resolve();
  await flush();
  assert.equal(gateway.status().recoveryScan.running, false);
  assert.equal(gateway.status().recoveryScan.lastError, 'market unavailable');
  assert.equal(gateway.status().recoveryScan.lastCompletedAt, null);

  state.nowMs += 10;
  socket.error();
  state.nowMs += 1;
  timers.fireTimeouts();
  await flush();
  FakeSocket.instances[2].open();
  await flush();
  assert.equal(gateway.status().recoveryScan.lastStartedAt, new Date(state.nowMs).toISOString(), '下一次恢复周期再次尝试');
  assert.equal(gateway.status().recoveryScan.lastError, 'market unavailable');
  await gateway.stop();
});

test('索引清空是主动关闭：不算断线、不进入 unhealthy、不触发扫描', async () => {
  FakeSocket.instances = [];
  let itemIds = new Set(['item-foo']);
  const { state, timers, gateway } = harness({
    gateway: { loadItemIds: async () => new Set(itemIds) },
  });
  await gateway.start();
  let socket = FakeSocket.instances[0];
  socket.open();

  itemIds = new Set([]);
  await gateway.refresh();
  assert.equal(gateway.status().health, GATEWAY_STATE.NOT_CONNECTED, '索引清空后主动关闭');
  assert.equal(gateway.status().disconnectCount, 0);
  assert.equal(gateway.status().disconnectedSince, null);
  const socketCount = FakeSocket.instances.length;
  await flush();
  assert.equal(FakeSocket.instances.length, socketCount, '没有安排重连');
  assert.equal(timers.pendingTimeouts(), 0);
  assert.equal(gateway.status().recoveryScan.lastStartedAt, null);

  // 重新出现活跃愿望：重新连接视为初次连接，不扫
  itemIds = new Set(['item-foo']);
  await gateway.refresh();
  assert.equal(gateway.status().health, GATEWAY_STATE.CONNECTING);
  socket = FakeSocket.instances[socketCount];
  socket.open();
  await flush();
  assert.equal(gateway.status().recoveryScan.lastStartedAt, null, '恢复监控但不触发恢复扫描');
  assert.equal(socket.url, 'wss://ws.warframe.market/socket');
  assert.equal(gateway.status().protection.mode, 'live', '无断线/静默时始终 live');

  await gateway.stop();
});

test('断线进入保护：首次保护扫描按抖动间隔（默认 20～30 秒），之后持续轮询', async () => {
  FakeSocket.instances = [];
  const { state, timers, protectionScans, gateway } = harness({
    gateway: { protectionMinMs: 20_000, protectionMaxMs: 30_000, jitter: () => 0.5 },
  });
  await gateway.start();
  const socket = FakeSocket.instances[0];
  socket.open();
  assert.equal(gateway.status().protection.mode, 'live');

  socket.error();
  assert.equal(gateway.status().protection.mode, 'protection');
  assert.notEqual(gateway.status().protection.enteredAt, null);
  assert.deepEqual(timers.pendingTimeoutWaits().sort((a, b) => a - b), [1000, 25000], '重连退避 1s + 保护轮询 25s（jitter 0.5 中值）');
  assert.equal(protectionScans.length, 0, '首次扫描在轮询定时器上，不立即打 Market');

  // 25 秒后轮询：恰好一次保护扫描，并安排下一轮抖动轮询
  state.nowMs += 25_000;
  timers.fireTimeoutWhere((entry) => entry.ms === 25_000);
  await flush();
  assert.equal(protectionScans.length, 1);
  assert.equal(gateway.status().protection.polls, 1);
  assert.equal(gateway.status().protection.lastScanStartedAt, new Date(state.nowMs).toISOString());
  assert.equal(gateway.status().protection.lastScanError, null);
  assert.ok(timers.pendingTimeoutWaits().includes(25_000), '下一轮保护轮询已调度');

  // 第二次轮询：polls 递增、扫描再次执行
  state.nowMs += 25_000;
  timers.fireTimeoutWhere((entry) => entry.ms === 25_000);
  await flush();
  assert.equal(protectionScans.length, 2);
  assert.equal(gateway.status().protection.polls, 2);

  await gateway.stop();
});

test('抖动边界：jitter=0 取 20 秒下限、jitter=1 取 30 秒上限、越界钳制', async () => {
  FakeSocket.instances = [];
  for (const [jitter, expected] of [[() => 0, 20_000], [() => 1, 30_000], [() => 2, 30_000], [() => -1, 20_000]]) {
    const { timers, gateway } = harness({
      gateway: { jitter, protectionMinMs: 20_000, protectionMaxMs: 30_000 },
    });
    await gateway.start();
    FakeSocket.instances[0].open();
    FakeSocket.instances[0].error();
    assert.ok(timers.pendingTimeoutWaits().includes(expected), `jitter → 保护轮询 ${expected}ms`);
    await gateway.stop();
    FakeSocket.instances = [];
  }
});

test('健康但事件流静默超过阈值：进入保护轮询；任一消息刷新活跃即退出并取消定时器', async () => {
  FakeSocket.instances = [];
  const { state, timers, protectionScans, gateway } = harness({
    gateway: { staleAfterMs: 10_000, jitter: () => 0.5 },
  });
  await gateway.start();
  const socket = FakeSocket.instances[0];
  socket.open();
  assert.equal(gateway.status().protection.mode, 'live');

  // 静默超过阈值：30 秒索引刷新节拍评估后进入保护
  state.nowMs += 11_000;
  await gateway.refresh();
  assert.equal(gateway.status().protection.mode, 'protection');
  assert.ok(timers.pendingTimeoutWaits().includes(25_000), '静默流进入保护轮询');
  assert.equal(protectionScans.length, 0);

  // 任一消息帧（即使与愿望无关）刷新最近活动 → 退出保护并取消轮询定时器
  state.nowMs += 1;
  socket.message({ route: '@wfm|event/subscriptions/other', payload: { itemId: 'item-other' } });
  assert.equal(gateway.status().protection.mode, 'live');
  assert.equal(gateway.status().protection.enteredAt, null);
  assert.equal(timers.pendingTimeoutWaits().includes(25_000), false, '退出保护后无保护轮询定时器');
  await flush();
  assert.equal(protectionScans.length, 0, '静默期间未到 25 秒轮询点先恢复');

  await gateway.stop();
});

test('恢复退出保护：重连成功且流新鲜后离开保护模式（恢复扫描仍恰好一次）', async () => {
  FakeSocket.instances = [];
  const { state, timers, scans, protectionScans, gateway } = harness({
    gateway: { jitter: () => 0.5 },
  });
  await gateway.start();
  let socket = FakeSocket.instances[0];
  socket.open();
  assert.equal(scans.length, 0);

  socket.error();
  assert.equal(gateway.status().protection.mode, 'protection');
  state.nowMs += 1;
  timers.fireTimeoutWhere((entry) => entry.ms === 1000); // 只触发重连，保护轮询留待断线窗口
  assert.equal(gateway.status().health, GATEWAY_STATE.CONNECTING);
  socket = FakeSocket.instances[1];
  socket.open();
  assert.equal(gateway.status().health, GATEWAY_STATE.HEALTHY);
  assert.equal(gateway.status().protection.mode, 'live', '连接恢复即退出保护');
  assert.equal(timers.pendingTimeoutWaits().includes(25_000), false, '保护轮询定时器已取消');
  await flush();
  assert.equal(scans.length, 1, '恢复扫描恰好一次');
  assert.equal(protectionScans.length, 0, '恢复前没有保护扫描可跑');

  await gateway.stop();
});

test('保护扫描与恢复扫描共用单飞槽：占用时恢复不并发重复，完成后新恢复周期才扫描', async () => {
  FakeSocket.instances = [];
  const gate = deferred();
  const { state, timers, scans, protectionScans, gateway } = harness({
    protectionScan: async () => { protectionScans.push(state.nowMs); await gate.promise; return { ok: true }; },
    gateway: { jitter: () => 0.5 },
  });
  await gateway.start();
  let socket = FakeSocket.instances[0];
  socket.open();

  // 断线 → 保护；25 秒轮询扫描启动并被 gate 挂住
  socket.error();
  state.nowMs += 25_000;
  timers.fireTimeoutWhere((entry) => entry.ms === 25_000);
  await flush();
  assert.equal(protectionScans.length, 1);
  assert.equal(gateway.status().protection.lastScanStartedAt != null, true);

  // 扫描进行中重连成功：恢复扫描被单飞跳过（不并发重复），保护扫描不算恢复扫描
  state.nowMs += 1;
  timers.fireTimeoutWhere((entry) => entry.ms === 1000);
  socket = FakeSocket.instances[1];
  socket.open();
  await flush();
  assert.equal(scans.length, 0, '保护扫描进行中，恢复扫描不并发重复');
  assert.equal(protectionScans.length, 1);

  // 完成后：新一轮断线→重连是新的恢复周期，允许第二次恢复扫描
  state.nowMs += 1;
  gate.resolve();
  await flush();
  socket.error();
  state.nowMs += 1;
  timers.fireTimeoutWhere((entry) => entry.ms === 1000); // 重连
  timers.fireTimeoutWhere((entry) => entry.ms === 25000); // 保护轮询（仍在保护模式，扫描已释放）
  await flush();
  FakeSocket.instances[2].open();
  await flush();
  assert.equal(scans.length, 1, '新恢复周期允许恢复扫描');
  assert.equal(protectionScans.length, 2, '第二次断线也进入保护轮询');

  await gateway.stop();
});

test('stop 清除保护定时器；索引清空退出保护并不再扫描', async () => {
  FakeSocket.instances = [];
  let itemIds = new Set(['item-foo']);
  const { state, timers, protectionScans, gateway } = harness({
    gateway: { loadItemIds: async () => new Set(itemIds), jitter: () => 0.5 },
  });
  await gateway.start();
  const socket = FakeSocket.instances[0];
  socket.open();
  socket.error();
  assert.equal(gateway.status().protection.mode, 'protection');
  assert.ok(timers.pendingTimeoutWaits().includes(25_000));

  // 索引清空 = 主动关闭：退出保护、取消轮询（重连定时器保留但 connect 会因空索引放弃）
  itemIds = new Set();
  await gateway.refresh();
  assert.equal(gateway.status().protection.mode, 'live');
  assert.equal(timers.pendingTimeoutWaits().includes(25_000), false, '保护轮询已取消');
  assert.equal(protectionScans.length, 0);

  gateway.stop();
  assert.equal(timers.pendingTimeouts(), 0, 'stop 清掉全部定时器');
  assert.equal(timers.pendingIntervals(), 0);
});

test('指标事件：断线/恢复（含断线时长）/保护进出/扫描完成，全部无标识字段', async () => {
  FakeSocket.instances = [];
  const { state, timers, metricsEvents, gateway } = harness({
    gateway: { jitter: () => 0.5 },
  });
  await gateway.start();
  const socket = FakeSocket.instances[0];
  socket.open();

  state.nowMs += 100;
  socket.error(); // 断线起点 t+100ms
  await flush();
  assert.ok(metricsEvents.some((event) => event.type === 'disconnect'));
  assert.ok(metricsEvents.some((event) => event.type === 'protection-enter'));

  // 25 秒后保护扫描完成 → scan 事件
  state.nowMs += 25_000;
  timers.fireTimeoutWhere((entry) => entry.ms === 25_000);
  await flush();
  const scanEvent = metricsEvents.find((event) => event.type === 'scan' && event.scope === 'protection');
  assert.ok(scanEvent, '保护扫描完成事件');
  assert.equal(scanEvent.ok, true);
  assert.equal('result' in scanEvent, false, '指标接口不透传可能含目标结果的原始扫描返回值');
  assert.deepEqual(scanEvent.summary, { ok: true, groups: 0, fetched: 0, failedGroups: 0 });

  // 重连成功 → recover 含断线时长 + protection-exit
  state.nowMs += 1;
  timers.fireTimeoutWhere((entry) => entry.ms === 1000);
  FakeSocket.instances[1].open();
  const recover = metricsEvents.filter((event) => event.type === 'recover');
  assert.equal(recover.length, 1);
  assert.equal(recover[0].durationMs, 25_001, '断线时长 = 恢复时刻 − 断线起点');
  assert.ok(metricsEvents.some((event) => event.type === 'protection-exit'));

  for (const event of metricsEvents) {
    assert.equal('target' in event, false, '指标事件不含 target');
    assert.equal('ownerId' in event, false, '指标事件不含 ownerId');
  }
  await flush();
  await gateway.stop();
});

test('失败扫描指标保留脱敏组摘要，不透传错误上的目标数据', async () => {
  FakeSocket.instances = [];
  const failure = new Error('Market unavailable');
  failure.scanSummary = { groups: 2, fetched: 0, failedGroups: 2, target: 'qqbot:c2c:secret' };
  const { state, timers, metricsEvents, gateway } = harness({
    protectionScan: async () => { throw failure; },
    gateway: { jitter: () => 0 },
  });
  await gateway.start();
  FakeSocket.instances[0].open();
  state.nowMs += 1;
  FakeSocket.instances[0].error();
  state.nowMs += 20_000;
  timers.fireTimeoutWhere((entry) => entry.ms === 20_000);
  await flush();
  const scanEvent = metricsEvents.find((event) => event.type === 'scan' && event.scope === 'protection');
  assert.ok(scanEvent);
  assert.equal(scanEvent.ok, false);
  assert.deepEqual(scanEvent.summary, { ok: false, groups: 2, fetched: 0, failedGroups: 2 });
  assert.equal(JSON.stringify(scanEvent).includes('qqbot:c2c:secret'), false);
  gateway.stop();
});
