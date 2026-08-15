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
