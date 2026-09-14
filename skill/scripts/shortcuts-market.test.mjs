import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'warframe-market-resilience-'));
process.env.WARFRAME_DATA_CACHE_DIR = cacheDir;
const { queryMarket } = await import('./shortcuts.mjs');

const originalFetch = globalThis.fetch;
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const item = {
  id: 'synthetic-item', slug: 'synthetic_arcane', tags: ['arcane_enhancement'],
  i18n: { en: { name: 'Synthetic Arcane' }, 'zh-hans': { name: '合成赋能' } },
};
const detail = { ...item, maxRank: 5, tradingTax: 10_000 };
const orders = {
  sell: [
    { id: 'sell-1', platinum: 12, quantity: 1, visible: true, user: { ingameName: 'SyntheticSeller', status: 'ingame', locale: 'en' } },
    { id: 'sell-2', platinum: 13, quantity: 1, visible: true, user: { ingameName: 'SecondSeller', status: 'online', locale: 'en' } },
    { id: 'sell-3', platinum: 14, quantity: 1, visible: true, user: { ingameName: '第三位卖家', status: 'online', locale: 'zh-hans' } },
  ],
  buy: [{ id: 'buy-1', platinum: 8, quantity: 1, visible: true, user: { ingameName: 'SyntheticBuyer', status: 'online' } }],
};

test.after(async () => {
  globalThis.fetch = originalFetch;
  await rm(cacheDir, { recursive: true, force: true });
});

test('wm main flow retries a transient detail timeout and returns current orders', async () => {
  let detailCalls = 0;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith('/v2/items')) return json({ data: [item] });
    if (value.includes('/v2/item/synthetic_arcane')) {
      detailCalls++;
      if (detailCalls === 1) {
        const error = new Error('synthetic detail timeout');
        error.name = 'TimeoutError';
        throw error;
      }
      return json({ data: detail });
    }
    if (value.includes('/v2/orders/item/synthetic_arcane/top')) return json({ data: orders });
    if (value.includes('/v1/items/synthetic_arcane/statistics')) return json({ payload: { statistics_closed: { '90days': [
      { datetime: '2026-09-11T00:00:00.000Z', median: 11, volume: 2, mod_rank: 5 },
      { datetime: '2026-09-12T00:00:00.000Z', median: 12, volume: 3, mod_rank: 5 },
      { datetime: '2026-09-13T00:00:00.000Z', median: 13, volume: 4, mod_rank: 5 },
    ] } } });
    throw new Error(`unexpected URL ${value}`);
  };

  const result = await queryMarket('合成赋能 满级');
  assert.equal(result.ok, true);
  assert.equal(result.item.rank, 5);
  assert.equal(result.sell[0].platinum, 12);
  assert.equal(detailCalls, 2);
  assert.equal(result.viewMode, 'quote');
  assert.equal(result.contactTemplates.length, 3);
  assert.match(result.contactTemplates[1], /^\/w SecondSeller /u);
  assert.match(result.contactTemplates[2], /^\/w 第三位卖家 你好/u);

  const trend = await queryMarket('合成赋能 满级 走势');
  assert.equal(trend.ok, true);
  assert.equal(trend.viewMode, 'trend');
  assert.equal(trend.marketQuery, '合成赋能 满级');
  assert.deepEqual(trend.trendSeries.map((point) => point.median), [11, 12, 13]);
});

test('wm order failures open an endpoint circuit and expose a sanitized offline diagnostic', async () => {
  let orderCalls = 0;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes('/v2/item/synthetic_arcane')) return json({ data: detail });
    if (value.includes('/v2/orders/item/synthetic_arcane/top')) {
      orderCalls++;
      throw new TypeError('synthetic network failure');
    }
    if (value.endsWith('/v2/items')) return json({ data: [item] });
    throw new Error(`unexpected URL ${value}`);
  };

  const first = await queryMarket('合成赋能');
  const second = await queryMarket('合成赋能');
  const callsBeforeCircuitProbe = orderCalls;
  const third = await queryMarket('合成赋能');

  assert.equal(first.error, 'market_down');
  assert.equal(second.upstream.category, 'network');
  assert.ok(Number(second.upstream.openUntil) > Date.now());
  assert.equal(third.upstream.category, 'circuit_open');
  assert.equal(third.upstream.attempts, 0);
  assert.equal(orderCalls, callsBeforeCircuitProbe);
  assert.deepEqual(Object.keys(third.upstream).toSorted(), [
    'attempts', 'category', 'endpoint', 'lastCategory', 'lastFailureAt', 'lastStatus', 'openUntil', 'openedAt', 'retryable',
  ]);
});
