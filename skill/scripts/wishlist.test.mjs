import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  applyWishlistOrders,
  buildWishlistHitCard,
  fetchTopOrdersForWishes,
  manageWishlist,
  matchesWishlistOrder,
  monitorWishlist,
  normalizeWishlistOrder,
  parseWishlistCommand,
  subscribeToNewOrders,
} from './wishlist.mjs';

const identity = { target: 'qqbot:group:test', ownerId: 'member-a', ownerName: '测试用户' };
const catalog = [{ id: 'item-foo', slug: 'foo_prime_set', name: 'Foo Prime Set', zhName: '福 Prime 套装' }];

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'warframe-wishlist-'));
  return { dir, state: path.join(dir, 'wishlist.json'), options: { render: false, catalogFetcher: async () => catalog, fetchItemMetadata: async () => ({}) } };
}

test('parses the compact Chinese command surface and explicit ranks', () => {
  assert.deepEqual(parseWishlistCommand('愿望 福 Prime  ≤ 12'), { kind: 'create', itemQuery: '福 Prime', maxPrice: 12 });
  assert.deepEqual(parseWishlistCommand('愿望单'), { kind: 'summary' });
  assert.deepEqual(parseWishlistCommand('改价 WABCD 9'), { kind: 'action', action: 'reprice', selector: 'WABCD', price: 9 });
  assert.equal(parseWishlistCommand('愿望 福 0').kind, 'create');
});

test('creates, summarizes and updates an isolated wishlist ledger', async () => {
  const { state, options } = await fixture();
  const created = await manageWishlist('愿望 福 Prime ≤ 12', identity, state, options);
  assert.equal(created.ok, true);
  assert.match(created.wish.id, /^W[A-Z2-9]{3}$/u);
  assert.equal(created.cronAction, 'ensure');
  assert.equal(created.wish.itemId, 'item-foo');

  const summary = await manageWishlist('愿望单', identity, state, options);
  assert.equal(summary.ok, true);
  assert.match(summary.text, /福 Prime/u);

  const repriced = await manageWishlist(`改价 ${created.wish.id} 8`, identity, state, options);
  assert.equal(repriced.wish.maxPrice, 8);
  const paused = await manageWishlist(`暂停 ${created.wish.id}`, identity, state, options);
  assert.equal(paused.wish.status, 'paused');
  const resumed = await manageWishlist(`继续 ${created.wish.id}`, identity, state, options);
  assert.equal(resumed.wish.status, 'active');
  const bought = await manageWishlist(`已购 ${created.wish.id}`, identity, state, options);
  assert.equal(bought.wish.status, 'bought');
  assert.equal(bought.cronAction, 'remove');
});

test('creates up to five wishes atomically and keeps rank variants separate', async () => {
  const { state, options } = await fixture();
  const multi = await manageWishlist('愿望 Bar 8；福 Prime 满级 20', identity, state, {
    ...options,
    catalogFetcher: async () => [...catalog, { id: 'item-bar', slug: 'bar', name: 'Bar', zhName: '巴' }],
    fetchItemMetadata: async (slug) => (slug === 'foo_prime_set' ? { maxRank: 5 } : {}),
  });
  assert.equal(multi.ok, true);
  assert.equal(multi.wishes.length, 2);
  assert.equal(new Set(multi.wishes.map((wish) => wish.id)).size, 2);
  assert.equal(multi.wishes.some((wish) => wish.rankMode === 'max'), true);
  assert.equal(multi.wishes.some((wish) => wish.rankMode === 'any'), true);
  const stateAfter = JSON.parse(await readFile(state, 'utf8'));
  assert.equal(stateAfter.wishes.length, 2);
});

test('scopes the ten-wish quota to the current target and owner', async () => {
  const { state, options } = await fixture();
  const many = Array.from({ length: 10 }, (_, index) => ({
    id: `item-${index}`, slug: `item-${index}`, name: `Item ${index}`, zhName: `物品${index}`,
  }));
  const localOptions = { ...options, catalogFetcher: async () => many };
  const first = await manageWishlist(`愿望 ${many.slice(0, 5).map((item) => `${item.zhName} 10`).join('；')}`, identity, state, localOptions);
  assert.equal(first.ok, true);
  const second = await manageWishlist(`愿望 ${many.slice(5).map((item) => `${item.zhName} 10`).join('；')}`, identity, state, localOptions);
  assert.equal(second.ok, true);
  const otherTarget = await manageWishlist(`愿望 ${many[0].zhName} 10`, { ...identity, target: 'qqbot:private:other' }, state, localOptions);
  assert.equal(otherTarget.ok, true);
});

test('uses per-item price and exact rank when matching orders', () => {
  const wish = { id: 'WABCD', target: 't', ownerId: 'o', itemId: 'item-foo', maxPrice: 40, status: 'active', enabled: true, rank: 5, rankMode: 'exact' };
  assert.equal(normalizeWishlistOrder({ itemId: 'item-foo', type: 'sell', platinum: 80, perTrade: 2, rank: 5 }).unitPrice, 40);
  assert.equal(matchesWishlistOrder(wish, { itemId: 'item-foo', type: 'sell', platinum: 80, perTrade: 2, rank: 5 }), true);
  assert.equal(matchesWishlistOrder(wish, { itemId: 'item-foo', type: 'sell', platinum: 80, perTrade: 2, rank: 4 }), false);
  assert.equal(matchesWishlistOrder(wish, { itemId: 'item-foo', type: 'sell', platinum: 82, perTrade: 2, rank: 5 }), false);
});

test('treats a seller price edit as a new candidate and reprice resets the baseline', async () => {
  const initialLedger = { wishes: [{ id: 'W3K7', target: identity.target, ownerId: identity.ownerId, itemId: 'item-foo', itemName: 'Foo', maxPrice: 15, status: 'active', enabled: true, initialized: true }] };
  const expensive = { id: 'same-order', itemId: 'item-foo', type: 'sell', platinum: 20, perTrade: 1 };
  const lowered = { ...expensive, platinum: 14 };
  const first = applyWishlistOrders(initialLedger, [expensive], { source: 'rest' });
  assert.equal(first.hits.length, 0);
  const second = applyWishlistOrders(first.ledger, [lowered], { source: 'rest' });
  assert.equal(second.hits.length, 1, 'same order id at a newly qualifying price should alert');

  const { state, options } = await fixture();
  const created = await manageWishlist('愿望 福 10', identity, state, options);
  await monitorWishlist(identity.target, state, null, true, { ownerId: identity.ownerId, fetchOrders: async () => [expensive], forceRest: true, skipWebSocket: true });
  const repriced = await manageWishlist(`改价 ${created.wish.id} 25`, identity, state, options);
  assert.equal(repriced.wish.initialized, false);
  assert.deepEqual(repriced.wish.seenOrderIds, []);
  const hit = await monitorWishlist(identity.target, state, null, true, { ownerId: identity.ownerId, fetchOrders: async () => [expensive], forceRest: true, skipWebSocket: true });
  assert.equal(hit.data.hitCount, 1, 'raising the threshold should immediately inspect existing orders again');
});

test('validates max-rank metadata before creating a ranked wish', async () => {
  const { state, options } = await fixture();
  const ranked = await manageWishlist('愿望 福 Prime 满级 20', identity, state, { ...options, fetchItemMetadata: async () => ({ maxRank: 5 }) });
  assert.equal(ranked.ok, true);
  assert.equal(ranked.wish.rankMode, 'max');
  assert.equal(ranked.wish.maxRank, 5);
  const outOfRange = await manageWishlist('愿望 福 Prime 等级 6 20', { ...identity, ownerId: 'member-b' }, state, { ...options, fetchItemMetadata: async () => ({ maxRank: 5 }) });
  assert.equal(outOfRange.error, 'rank_out_of_range');
});

test('REST calibration requests item top orders, not a global recent feed', async () => {
  let requested = '';
  const orders = await fetchTopOrdersForWishes([{ itemId: 'item-foo', slug: 'foo_prime_set', rankMode: 'exact', rank: 5 }], async (url) => {
    requested = url;
    return { ok: true, json: async () => ({ data: { sell: [{ id: 'o-1', itemId: 'item-foo', platinum: 20, perTrade: 1, rank: 5 }] } }) };
  });
  assert.match(requested, /\/v2\/orders\/item\/foo_prime_set\/top\?rank=5$/u);
  assert.equal(orders[0].itemId, 'item-foo');
});

test('websocket uses wfm protocol and deduplicates the same order', async () => {
  let socketArgs;
  let sent;
  class FakeSocket {
    constructor(url, protocol) { socketArgs = [url, protocol]; queueMicrotask(() => this.onopen?.({})); }
    addEventListener(event, handler) { this[`on${event}`] = handler; }
    send(value) {
      sent = JSON.parse(value);
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ route: '@wfm|event/subscriptions/newOrder', payload: { id: 'o-1', itemId: 'item-foo', type: 'sell', platinum: 20, perTrade: 1 } }) }), 0);
    }
    close() { queueMicrotask(() => this.onclose?.({})); }
  }
  const seen = [];
  const result = await subscribeToNewOrders({ WebSocketImpl: FakeSocket, durationMs: 30, onOrder: async (order) => seen.push(order) });
  assert.deepEqual(socketArgs, ['wss://ws.warframe.market/socket', 'wfm']);
  assert.equal(sent.route, '@wfm|cmd/subscribe/newOrders');
  assert.deepEqual(sent.payload, { platform: 'pc', crossplay: true });
  assert.equal(result.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(applyWishlistOrders({ wishes: [{ id: 'WABCD', target: 't', ownerId: 'o', itemId: 'item-foo', maxPrice: 20, status: 'active', enabled: true, initialized: true }] }, [...seen, ...seen], { source: 'ws' }).hits.length, 1);
});

test('monitor baselines first item-top calibration and only reports later unseen hits', async () => {
  const { state, options } = await fixture();
  const created = await manageWishlist('愿望 福 20', identity, state, options);
  const order = { id: 'o-1', itemId: 'item-foo', slug: 'foo_prime_set', type: 'sell', platinum: 20, perTrade: 1 };
  const fetchOrders = async () => [order];
  const first = await monitorWishlist(identity.target, state, null, true, { ownerId: identity.ownerId, fetchOrders, forceRest: true, skipWebSocket: true });
  assert.equal(first.data.hitCount, 1, 'the first calibration should notify a newly created qualifying wish');
  const second = await monitorWishlist(identity.target, state, null, true, { ownerId: identity.ownerId, fetchOrders, forceRest: true, skipWebSocket: true });
  assert.equal(second.data.hitCount, 0, 'same item-top order is deduplicated after baseline');
  assert.equal(created.wish.id.length, 4);
});

test('REST failure reloads before writing calibration and preserves concurrent wishes', async () => {
  const { state, options } = await fixture();
  await manageWishlist('愿望 福 20', identity, state, options);
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  let release;
  const releasePromise = new Promise((resolve) => { release = resolve; });
  const monitoring = monitorWishlist(identity.target, state, null, true, {
    ownerId: identity.ownerId,
    forceRest: true,
    skipWebSocket: true,
    fetchOrders: async () => {
      started();
      await releasePromise;
      throw new Error('market unavailable');
    },
  });
  await startedPromise;
  await manageWishlist('愿望 Bar 20', identity, state, {
    ...options,
    catalogFetcher: async () => [...catalog, { id: 'item-bar', slug: 'bar', name: 'Bar', zhName: '巴' }],
  });
  release();
  const result = await monitoring;
  assert.equal(result.data.restError, 'market unavailable');
  const persisted = JSON.parse(await readFile(state, 'utf8'));
  assert.equal(persisted.wishes.length, 2);
  assert.equal(persisted.calibration.targets[identity.target].lastError, 'market unavailable');
});

test('hit card translates seller presence states for QQ readers', () => {
  const card = buildWishlistHitCard({ hits: [
    { wishId: 'W3K7', wish: { itemName: 'Foo Prime Set', maxPrice: 20 }, order: { seller: 'A', status: 'ingame', unitPrice: 10 } },
    { wishId: 'W8L2', wish: { itemName: 'Bar', maxPrice: 20 }, order: { seller: 'B', status: 'online', unitPrice: 11 } },
  ] });
  assert.match(card.html, /状态 游戏中/u);
  assert.match(card.html, /状态 在线/u);
});
