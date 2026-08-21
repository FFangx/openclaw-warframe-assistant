import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryEndpointHealthStore, resilientJsonRequest } from './http-resilience.mjs';

const response = (status, body = {}, headers = {}) => new Response(JSON.stringify(body), { status, headers });

test('network errors retry within the attempt budget and recover', async () => {
  let calls = 0;
  const delays = [];
  const store = new MemoryEndpointHealthStore();
  const data = await resilientJsonRequest('https://example.invalid/item', {
    endpoint: 'market:item', healthStore: store,
    fetchImpl: async () => {
      calls++;
      if (calls === 1) throw new TypeError('synthetic connection reset');
      return response(200, { ok: true });
    },
    sleep: async (ms) => delays.push(ms),
  });
  assert.deepEqual(data, { ok: true });
  assert.equal(calls, 2);
  assert.deepEqual(delays, [250]);
  assert.equal((await store.read())['market:item'].consecutiveFailures, 0);
});

test('non-retryable 403 opens a long circuit and the next process skips the endpoint', async () => {
  let calls = 0;
  let clock = 1_000;
  const store = new MemoryEndpointHealthStore();
  await assert.rejects(() => resilientJsonRequest('https://example.invalid/worldstate', {
    endpoint: 'worldstate:primary:pc', healthStore: store, maxAttempts: 2,
    fetchImpl: async () => { calls++; return response(403); }, now: () => clock,
  }), (error) => error.diagnostic.category === 'http_error'
    && error.diagnostic.attempts === 1
    && error.diagnostic.openUntil === clock + 15 * 60_000);
  assert.equal(calls, 1);

  await assert.rejects(() => resilientJsonRequest('https://example.invalid/worldstate', {
    endpoint: 'worldstate:primary:pc', healthStore: store,
    fetchImpl: async () => { calls++; return response(200); }, now: () => clock,
  }), (error) => error.diagnostic.category === 'circuit_open' && error.diagnostic.attempts === 0);
  assert.equal(calls, 1);
});

test('repeated timeouts open a short circuit and a post-cooldown success closes it', async () => {
  let calls = 0;
  let clock = 10_000;
  const store = new MemoryEndpointHealthStore();
  const timeout = async () => {
    calls++;
    const error = new Error('synthetic timeout');
    error.name = 'TimeoutError';
    throw error;
  };
  for (let failure = 0; failure < 2; failure++) {
    await assert.rejects(() => resilientJsonRequest('https://example.invalid/orders', {
      endpoint: 'market:orders', healthStore: store, maxAttempts: 1, fetchImpl: timeout, now: () => clock,
    }));
    clock += 1_000;
  }
  const opened = (await store.read())['market:orders'].openUntil;
  assert.ok(opened > clock);

  clock = opened + 1;
  const data = await resilientJsonRequest('https://example.invalid/orders', {
    endpoint: 'market:orders', healthStore: store,
    fetchImpl: async () => { calls++; return response(200, { recovered: true }); }, now: () => clock,
  });
  assert.deepEqual(data, { recovered: true });
  assert.equal((await store.read())['market:orders'].openUntil, null);
});

test('429 honors retry-after and records an endpoint-scoped diagnostic', async () => {
  let clock = 50_000;
  const store = new MemoryEndpointHealthStore();
  await assert.rejects(() => resilientJsonRequest('https://example.invalid/catalog', {
    endpoint: 'market:catalog', healthStore: store, maxAttempts: 1,
    fetchImpl: async () => response(429, {}, { 'retry-after': '2' }), now: () => clock,
  }), (error) => error.diagnostic.endpoint === 'market:catalog'
    && error.diagnostic.category === 'rate_limited'
    && error.diagnostic.retryAfterMs === 2_000);
  assert.ok((await store.read())['market:catalog'].openUntil >= clock + 30_000);
});

test('telemetry: 失败→恢复→再次失败 累计最终失败/类别/HTTP 状态/开熔断次数，恢复保留累计', async () => {
  let calls = 0;
  let clock = 1_000;
  const store = new MemoryEndpointHealthStore();
  const timeout = async () => {
    calls++;
    const error = new Error('synthetic timeout');
    error.name = 'TimeoutError';
    throw error;
  };

  // 失败 1、2：连续超时（maxAttempts=1，每次都是最终失败）
  for (let failure = 0; failure < 2; failure++) {
    await assert.rejects(() => resilientJsonRequest('https://example.invalid/orders', {
      endpoint: 'market:orders', healthStore: store, maxAttempts: 1, fetchImpl: timeout, now: () => clock,
    }));
    clock += 1_000;
  }
  let state = (await store.read())['market:orders'];
  assert.equal(state.totalFailures, 2);
  assert.deepEqual(state.failureCategoryCounts, { timeout: 2 });
  assert.deepEqual(state.failureStatusCounts, {}); // 超时无 HTTP 状态，不计入
  assert.equal(state.circuitOpenCount, 1); // 第二次失败达到阈值 → 新开熔断一次
  assert.equal(state.consecutiveFailures, 2);
  assert.ok(Number(state.openUntil) > clock);

  // 恢复：成功只清当前连续失败/开路状态，累计遥测保留
  clock = Number(state.openUntil) + 1;
  const data = await resilientJsonRequest('https://example.invalid/orders', {
    endpoint: 'market:orders', healthStore: store,
    fetchImpl: async () => { calls++; return response(200, { recovered: true }); }, now: () => clock,
  });
  assert.deepEqual(data, { recovered: true });
  state = (await store.read())['market:orders'];
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(state.lastCategory, null);
  assert.equal(state.openUntil, null);
  assert.equal(state.openedAt, null);
  assert.equal(state.totalFailures, 2, '恢复不得清零累计失败次数');
  assert.deepEqual(state.failureCategoryCounts, { timeout: 2 });
  assert.equal(state.circuitOpenCount, 1, '恢复不得清零累计开熔断次数');

  // 再次失败：403 单次即开熔断 → 类别/HTTP 状态累计、开熔断次数 +1
  clock += 10_000;
  await assert.rejects(() => resilientJsonRequest('https://example.invalid/orders', {
    endpoint: 'market:orders', healthStore: store, maxAttempts: 2,
    fetchImpl: async () => { calls++; return response(403); }, now: () => clock,
  }));
  state = (await store.read())['market:orders'];
  assert.equal(state.totalFailures, 3);
  assert.deepEqual(state.failureCategoryCounts, { timeout: 2, http_error: 1 });
  assert.deepEqual(state.failureStatusCounts, { '403': 1 });
  assert.equal(state.circuitOpenCount, 2);
  assert.equal(state.consecutiveFailures, 1); // 恢复后重新从 1 起算

  // 状态绝不记录 URL、请求头、响应体或凭据
  const json = JSON.stringify(state);
  assert.ok(!json.includes('https://'));
  assert.ok(!json.includes('example.invalid'));
  assert.ok(!json.includes('headers'));
  assert.ok(!json.includes('token'));
  assert.ok(!json.includes('body'));
});

test('telemetry: 旧 v1 健康条目缺累计字段仍可读，从零起步继续累计', async () => {
  const store = new MemoryEndpointHealthStore({
    'market:legacy': {
      consecutiveFailures: 1, lastFailureAt: 1_000, lastCategory: 'network',
      lastStatus: null, openedAt: null, openUntil: null,
    },
  });
  let clock = 2_000;
  const timeout = async () => {
    const error = new Error('synthetic timeout');
    error.name = 'TimeoutError';
    throw error;
  };
  await assert.rejects(() => resilientJsonRequest('https://example.invalid/legacy', {
    endpoint: 'market:legacy', healthStore: store, maxAttempts: 1, fetchImpl: timeout, now: () => clock,
  }));
  const state = (await store.read())['market:legacy'];
  assert.equal(state.totalFailures, 1);
  assert.deepEqual(state.failureCategoryCounts, { timeout: 1 });
  assert.equal(state.circuitOpenCount, 1); // 旧连续失败 1 + 本次 1 = 2 → 达到阈值新开熔断
  assert.equal(state.consecutiveFailures, 2);
  assert.ok(Number(state.openUntil) > clock);
});
