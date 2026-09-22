import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { manageWishlist, monitorWishlist, readWishlistLedger, runDueWishlistTracking, trackingDelayMs, wishlistTrackingText } from './wishlist.mjs';

const BASE = Date.parse('2026-09-17T10:00:00.000Z');
const IDENTITY = { target: 'qqbot:c2c:user-a', ownerId: 'user-a', ownerName: '玩家' };
const CATALOG = [{ id: 'item-a', slug: 'item_a', name: 'Item A', zhName: '物品 A' }];
const options = { render: false, catalogFetcher: async () => CATALOG, fetchItemMetadata: async () => ({ maxRank: 10 }) };
const order = (id, price, extra = {}) => ({ id, itemId: 'item-a', type: 'sell', platinum: price, perTrade: 1, visible: true, rank: 0, seller: `seller-${id}`, ...extra });

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wishlist-tracking-'));
  const state = path.join(dir, 'wishlist.json');
  const created = await manageWishlist('愿望 物品 A 40', IDENTITY, state, options);
  assert.equal(created.ok, true);
  const first = await monitorWishlist(IDENTITY.target, state, null, false, {
    ownerId: IDENTITY.ownerId, forceRest: true, skipWebSocket: true, render: false,
    now: () => BASE, fetchOrders: async () => [order('high', 30), order('low', 20)],
  });
  assert.equal(first.data.hitCount, 1);
  assert.equal(first.data.hits[0].order.id, 'low');
  return { state, wish: created.wish };
}

test('adaptive schedule uses 10s, 30s and 2m bands', () => {
  assert.equal(trackingDelayMs(0), 10_000);
  assert.equal(trackingDelayMs(5 * 60_000), 30_000);
  assert.equal(trackingDelayMs(30 * 60_000), 120_000);
});

test('tracking notices preserve wish rank and cap, and give a fresh whisper only for a cheaper order', () => {
  const wish = { itemName: 'Test Item', zhName: '测试商品', rankMode: 'max', maxPrice: 100 };
  const track = { currentPrice: 95 };
  const replacement = { seller: 'NewSeller', rank: 10, unitPrice: 85, platinum: 85 };
  const lower = wishlistTrackingText({ type: 'lower', wish, track, replacement });
  assert.match(lower, /满级（愿望上限 100p）/u);
  assert.match(lower, /95p → 85p/u);
  assert.match(lower, /\n\/w NewSeller .*85 platinum/u);
  const removed = wishlistTrackingText({ type: 'removed', wish, track });
  assert.doesNotMatch(removed, /\/w /u);
});

test('first absence waits 2s and only a second successful absence reports removal', async () => {
  const { state } = await setup();
  const first = await runDueWishlistTracking(state, { now: () => BASE + 10_000, fetchOrder: async () => null, fetchTop: async () => [] });
  assert.equal(first.events.length, 0);
  let ledger = await readWishlistLedger(state);
  assert.equal(Date.parse(ledger.trackedOrders[0].nextCheckAt), BASE + 12_000);

  const failed = await runDueWishlistTracking(state, { now: () => BASE + 12_000, fetchOrder: async () => { throw new Error('429'); }, fetchTop: async () => [] });
  assert.equal(failed.events.length, 0);
  assert.equal((await readWishlistLedger(state)).trackedOrders.length, 1);

  ledger = await readWishlistLedger(state);
  ledger.trackedOrders[0].nextCheckAt = new Date(BASE + 13_000).toISOString();
  await writeFile(state, `${JSON.stringify(ledger, null, 2)}\n`);
  const removed = await runDueWishlistTracking(state, { now: () => BASE + 13_000, fetchOrder: async () => null, fetchTop: async () => [] });
  assert.equal(removed.events[0].type, 'removed');
  assert.equal((await readWishlistLedger(state)).trackedOrders.length, 0);
});

test('a lower replacement switches target and resets the one-hour window', async () => {
  const { state } = await setup();
  const result = await runDueWishlistTracking(state, {
    now: () => BASE + 10_000,
    fetchOrder: async () => order('low', 20),
    fetchTop: async () => [order('new-low', 15), order('low', 20)],
  });
  assert.equal(result.events[0].type, 'lower');
  const track = (await readWishlistLedger(state)).trackedOrders[0];
  assert.equal(track.orderId, 'new-low');
  assert.equal(Date.parse(track.expiresAt), BASE + 10_000 + 60 * 60_000);
});

test('tracking status is enqueued before the tracked-order state is committed', async () => {
  const { state } = await setup();
  await assert.rejects(() => runDueWishlistTracking(state, {
    now: () => BASE + 10_000,
    fetchOrder: async () => order('low', 18),
    fetchTop: async () => [order('low', 18)],
    enqueueEvent: async () => { throw new Error('outbox unavailable'); },
  }), /outbox unavailable/u);
  const track = (await readWishlistLedger(state)).trackedOrders[0];
  assert.equal(track.currentPrice, 20);
  assert.equal(Date.parse(track.nextCheckAt), BASE + 10_000);
});

test('natural-language selector never chooses the first duplicate item silently', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wishlist-selector-'));
  const state = path.join(dir, 'wishlist.json');
  await manageWishlist('愿望 物品 A 等级 0 40', IDENTITY, state, options);
  await manageWishlist('愿望 物品 A 满级 40', IDENTITY, state, options);
  const result = await manageWishlist('暂停 物品 A', IDENTITY, state, options);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'ambiguous_selector');
  assert.equal(result.candidates.length, 2);
  const persisted = JSON.parse(await readFile(state, 'utf8'));
  assert.equal(persisted.wishes.every((wish) => wish.status === 'active'), true);
});
