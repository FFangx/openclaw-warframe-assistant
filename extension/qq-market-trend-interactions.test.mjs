import assert from 'node:assert/strict';
import test from 'node:test';
import { createMarketTrendInteractionStore } from './qq-market-trend-interactions.mjs';

test('trend callback tokens are private and actor-bound without letting another actor invalidate them', () => {
  let time = 1000;
  const store = createMarketTrendInteractionStore({ now: () => time, token: () => 'fixed-token', ttlMs: 500 });
  const buttonData = store.register({ accountId: 'bot-a', senderId: 'User-Secret', query: 'Nidus Prime 一套' });
  assert.equal(buttonData, 'wftrend:v1:fixed-token');
  assert.equal(buttonData.includes('User-Secret'), false);
  assert.deepEqual(store.acquire(buttonData, { accountId: 'bot-a', senderId: 'other-user' }), {
    matched: true, ok: false, reason: 'actor-mismatch',
  });
  assert.deepEqual(store.acquire(buttonData, { accountId: 'bot-a', senderId: 'User-Secret' }), {
    matched: true, ok: true, query: 'Nidus Prime 一套',
  });
});

test('valid trend callback is reusable after completion, rejects overlap and expires on schedule', () => {
  let time = 1000;
  const store = createMarketTrendInteractionStore({ now: () => time, token: () => 'another-token', ttlMs: 500 });
  const buttonData = store.register({ accountId: 'bot-a', senderId: 'user-a', query: '赋能充沛 满级' });
  assert.deepEqual(store.acquire(buttonData, { accountId: 'bot-a', senderId: 'USER-A' }), {
    matched: true, ok: true, query: '赋能充沛 满级',
  });
  assert.deepEqual(store.acquire(buttonData, { accountId: 'bot-a', senderId: 'user-a' }), {
    matched: true, ok: false, reason: 'busy',
  });
  assert.equal(store.release(buttonData, { accountId: 'bot-a', senderId: 'user-a' }), true);
  assert.deepEqual(store.acquire(buttonData, { accountId: 'bot-a', senderId: 'user-a' }), {
    matched: true, ok: true, query: '赋能充沛 满级',
  });
  assert.equal(store.release(buttonData, { accountId: 'bot-a', senderId: 'user-a' }), true);
  const expiring = store.register({ accountId: 'bot-a', senderId: 'user-a', query: '悟空p' });
  time = 1600;
  assert.deepEqual(store.acquire(expiring, { accountId: 'bot-a', senderId: 'user-a' }), {
    matched: true, ok: false, reason: 'expired',
  });
});
