import test from 'node:test';
import assert from 'node:assert/strict';
import {
  robustOrderLow,
  resolveMarketReference,
  summarizeTradeStatistics,
  mergeTraderStates,
  formatTraderShopping,
} from './trader-shopping.mjs';

test('robustOrderLow：无有效卖单返回无价', () => {
  assert.deepEqual(robustOrderLow([], 50), { orderLow: null, orderCount: 0, orderLowSuspicious: false });
  assert.deepEqual(robustOrderLow([{ platinum: 0 }, { platinum: -1 }, { platinum: null }], 50), { orderLow: null, orderCount: 0, orderLowSuspicious: false });
});

test('robustOrderLow：单卖单直接采用最低价', () => {
  const result = robustOrderLow([{ platinum: 50 }], 55);
  assert.deepEqual(result, { orderLow: 50, orderCount: 1, orderLowSuspicious: false });
});

test('robustOrderLow：正常多单取最低价，不判钓鱼', () => {
  const result = robustOrderLow([{ platinum: 10 }, { platinum: 12 }, { platinum: 15 }], 15);
  assert.deepEqual(result, { orderLow: 10, orderCount: 3, orderLowSuspicious: false });
});

test('robustOrderLow：最低单远低于次低与今日中位 → 剔除改用次低价', () => {
  const result = robustOrderLow([{ platinum: 2 }, { platinum: 30 }, { platinum: 32 }], 50);
  assert.deepEqual(result, { orderLow: 30, orderCount: 3, orderLowSuspicious: true });
});

test('robustOrderLow：无今日中位时仅凭次低价差距判定', () => {
  const fishing = robustOrderLow([{ platinum: 2 }, { platinum: 30 }], null);
  assert.deepEqual(fishing, { orderLow: 30, orderCount: 2, orderLowSuspicious: true });
  const normal = robustOrderLow([{ platinum: 30 }, { platinum: 32 }], null);
  assert.deepEqual(normal, { orderLow: 30, orderCount: 2, orderLowSuspicious: false });
});

test('robustOrderLow：最低/次低差距大但与今日中位相当 → 不判钓鱼', () => {
  const result = robustOrderLow([{ platinum: 8 }, { platinum: 9 }], 10);
  assert.deepEqual(result, { orderLow: 8, orderCount: 2, orderLowSuspicious: false });
});

test('resolveMarketReference：有卖单用挂单低值（basis=orders），保留成交对照', () => {
  const stats = { platinum: 50, basis: 'today', todayVolume: 9, todayMedian: 50, median90: 55, dailyVolume: 5, deviationPct: 9 };
  const order = { orderLow: 45, orderCount: 6, orderLowSuspicious: true };
  const ref = resolveMarketReference(stats, order);
  assert.equal(ref.platinum, 45);
  assert.equal(ref.marketBasis, 'orders');
  assert.equal(ref.orderLow, 45);
  assert.equal(ref.orderCount, 6);
  assert.equal(ref.orderLowSuspicious, true);
  assert.equal(ref.todayMedian, 50);
  assert.equal(ref.median90, 55);
});

test('resolveMarketReference：挂单不可用回退成交统计', () => {
  const stats = { platinum: 50, basis: 'today', todayVolume: 9, todayMedian: 50, median90: 55, dailyVolume: 5 };
  const ref = resolveMarketReference(stats, { orderLow: null, orderCount: 0, orderLowSuspicious: false });
  assert.equal(ref.platinum, 50);
  assert.equal(ref.marketBasis, 'today');
  assert.equal(ref.orderLow, null);
});

test('resolveMarketReference：全部无价返回 null', () => {
  const ref = resolveMarketReference(null, { orderLow: null, orderCount: 0, orderLowSuspicious: false });
  assert.equal(ref.platinum, null);
  assert.equal(ref.marketBasis, null);
  assert.equal(ref.orderLowSuspicious, false);
});

test('resolveMarketReference：挂单不可用且今日无成交（仅 90 天）→ 市价待定 null', () => {
  const stats = { platinum: 55, basis: '90days', todayVolume: 0, todayMedian: null, median90: 55, dailyVolume: 5 };
  const ref = resolveMarketReference(stats, { orderLow: null, orderCount: 0, orderLowSuspicious: false });
  assert.equal(ref.platinum, null);
  assert.equal(ref.marketBasis, null);
  assert.equal(ref.median90, 55);
});

const statisticsPayload = (todayRows, dailyRows) => ({ payload: { statistics_closed: { '48hours': todayRows, '90days': dailyRows } } });
const now = Date.parse('2026-08-21T04:00:00Z'); // 北京 2026-08-21 12:00
const todayRow = (hour, median, volume) => ({ datetime: `2026-08-21T0${hour}:00:00.000Z`, median, volume, mod_rank: null });
const dayRow = (day, median, volume) => ({ datetime: `2026-08-${day}T00:00:00.000Z`, median, volume, mod_rank: null });

test('summarizeTradeStatistics：今日 >=10 笔直接采用', () => {
  const result = summarizeTradeStatistics(statisticsPayload(
    [todayRow(2, 10, 6), todayRow(3, 12, 4)],
    [dayRow(10, 15, 30)],
  ), null, now);
  assert.equal(result.basis, 'today');
  assert.equal(result.platinum, 10);
  assert.equal(result.todayVolume, 10);
  assert.equal(result.median90, 15);
});

test('summarizeTradeStatistics：今日 5~9 笔且偏差 <=30% 采用今日', () => {
  const result = summarizeTradeStatistics(statisticsPayload(
    [todayRow(2, 12, 6)],
    [dayRow(10, 15, 30)],
  ), null, now);
  assert.equal(result.basis, 'today');
  assert.equal(result.platinum, 12);
  assert.equal(result.deviationPct, 20);
});

test('summarizeTradeStatistics：今日 5~9 笔但偏差过大回退 90 天', () => {
  const result = summarizeTradeStatistics(statisticsPayload(
    [todayRow(2, 12, 6)],
    [dayRow(10, 30, 30)],
  ), null, now);
  assert.equal(result.basis, '90days');
  assert.equal(result.platinum, 30);
  assert.equal(result.deviationPct, 60);
});

test('summarizeTradeStatistics：今日不足 5 笔回退 90 天', () => {
  const result = summarizeTradeStatistics(statisticsPayload(
    [todayRow(2, 12, 3)],
    [dayRow(10, 30, 30)],
  ), null, now);
  assert.equal(result.basis, '90days');
});

test('summarizeTradeStatistics：无有效数据返回 null', () => {
  const result = summarizeTradeStatistics(statisticsPayload([], []), null, now);
  assert.equal(result, null);
});

test('gradeBaroItem：分级表命中、类型兜底与中文名匹配', async () => {
  const { gradeBaroItem, loadBaroTier } = await import('./trader-shopping.mjs');
  assert.equal(gradeBaroItem({ slug: 'primed_continuity', tradable: true, uniqueName: '/Lotus/Mods/PrimedContinuity', nameEn: 'Primed Continuity' }), 'S');
  assert.equal(gradeBaroItem({ slug: 'unknown_mod', tradable: true, uniqueName: '/Lotus/Mods/Unknown', nameEn: 'Unknown Mod' }), 'B');
  assert.equal(gradeBaroItem({ slug: 'neo_m5', tradable: true, uniqueName: '/Lotus/Relics/NeoM5', nameEn: 'Neo M5' }), 'A');
  assert.equal(gradeBaroItem({ slug: 'neo_m5', tradable: true, uniqueName: '/Lotus/StoreItems/NeoM5Relic', nameEn: 'Neo M5', zhName: '后纪 M5 遗物' }), 'A');
  assert.equal(gradeBaroItem({ slug: 'deco', tradable: false, uniqueName: '/Lotus/Deco', nameEn: 'Deco' }), 'C');
  // 表合同：非 Baro 商品（Daily Tribute）不得入表；评审收敛后的 S 骨架
  const table = loadBaroTier();
  assert.equal(table.items.primed_sure_footed, undefined);
  assert.equal(table.items.primed_shred, 'S');
  assert.equal(table.items.primed_ammo_case, 'B');
});

test('fetchMarketOrders：买卖双方聚合，求购单数/数量作为需求度', async () => {
  const { fetchMarketOrders } = await import('./trader-shopping.mjs');
  const result = await fetchMarketOrders('primed_test', async () => ({
    sell: [{ platinum: 5, quantity: 1 }, { platinum: 40, quantity: 2 }],
    buy: [{ platinum: 3, quantity: 1 }, { platinum: 4, quantity: 5 }, { platinum: 2, quantity: 0 }],
  }));
  assert.equal(result.sell.length, 2);
  assert.equal(result.buyCount, 2); // quantity 0 的买单被过滤
  assert.equal(result.buyQty, 6);
});

test('mergeTraderStates：warframestat 补齐英文名并规范化地点', () => {
  const official = {
    character: "Baro Ki'Teer",
    location: 'PlutoHUB',
    activation: '2026-08-14T12:00:00.000Z',
    expiry: '2026-08-16T12:00:00.000Z',
    inventory: [{ uniqueName: '/Lotus/PrimeBucks', item: null, ducats: 350, credits: 140000 }],
  };
  const wfstat = {
    location: 'Orcus 中继站',
    inventory: [{ uniqueName: '/Lotus/StoreItems/PrimeBucks', item: 'Primed Sure Footed' }],
  };
  const merged = mergeTraderStates(official, wfstat);
  assert.equal(merged.location, 'Orcus 中继站（冥王星）');
  assert.equal(merged.inventory[0].item, 'Primed Sure Footed');
  assert.equal(merged.inventory[0].ducats, 350);
});

test('formatTraderShopping：当前售价口径，不再展示 90 天对照', () => {
  const rows = [{
    zhName: '制衡 Prime', nameEn: 'Primed Equilibrium', uniqueName: '/x', tradable: true,
    ducats: 300, credits: 220000, owned: false, advice: { tag: 'strong', zh: '强烈买' },
    platinum: 45, marketBasis: 'orders', orderLow: 45, orderCount: 6, orderLowSuspicious: false,
    todayMedian: 50, todayVolume: 9, median90: 55, dailyVolume: 6, ratio: 6.67,
    ducatOpportunityPlat: null, ducatPlanShortfall: null,
  }];
  const text = formatTraderShopping({ arrived: true, location: 'Orcus 中继站（冥王星）', ducatBalance: 255, rows, wantDucats: 300, affordable: true });
  assert.match(text, /当前售价 45p（6 单在售）/);
  assert.doesNotMatch(text, /90天/u);
  assert.match(text, /市场路线优先当前售价/);
});

test('formatTraderShopping：未到货分支', () => {
  const text = formatTraderShopping({ arrived: false, character: "Baro Ki'Teer", location: 'Orcus 中继站（冥王星）', activation: '2026-08-22T12:00:00.000Z', ducatBalance: 0 });
  assert.match(text, /尚未到达/);
});

test('appraiseTraderGoods：挂单经稳健判定后作为决策价（orders 接线）', async () => {
  const { appraiseTraderGoods } = await import('./trader-shopping.mjs');
  const rows = await appraiseTraderGoods(
    [{ uniqueName: '/Lotus/StoreItems/Upgrades/Mods/PrimedTest', item: 'Primed Test', ducats: 300, credits: 100 }],
    {
      catalog: { primedtest: { slug: 'primed_test', zh: '测试 Prime' } },
      statisticsFetcher: async () => ({ payload: { statistics_closed: {
        '48hours': [{ datetime: new Date().toISOString(), median: 50, volume: 8, mod_rank: 0 }],
        '90days': [{ datetime: '2026-08-06T00:00:00.000Z', median: 50, volume: 90, mod_rank: 0 }],
      } } }),
      detailFetcher: async () => ({ data: { tradingTax: 1_000_000 } }),
      // 5p 为异常低单（远低于次低 40p 且低于今日中位 50p）→ 应剔除
      ordersFetcher: async () => ({ sell: [{ platinum: 5, quantity: 1 }, { platinum: 40, quantity: 1 }] }),
    },
  );
  assert.equal(rows[0].marketBasis, 'orders');
  assert.equal(rows[0].orderLow, 40);
  assert.equal(rows[0].orderLowSuspicious, true);
  assert.equal(rows[0].platinum, 40);
  assert.equal(rows[0].todayMedian, 50);
});

test('appraiseTraderGoods：挂单失败单项降级，该行无价其余照常', async () => {
  const { appraiseTraderGoods } = await import('./trader-shopping.mjs');
  const rows = await appraiseTraderGoods(
    [{ uniqueName: '/x/Mods/A', item: 'Primed Test', ducats: 300, credits: 100 }],
    {
      catalog: { primedtest: { slug: 'primed_test', zh: '测试 Prime' } },
      statisticsFetcher: async () => { throw new Error('stats down'); },
      detailFetcher: async () => { throw new Error('detail down'); },
      ordersFetcher: async () => { throw new Error('orders down'); },
    },
  );
  assert.equal(rows[0].platinum, null);
  assert.equal(rows[0].tradable, true);
  assert.equal(rows[0].marketBasis, null);
});

test('formatTraderShopping：无近期成交显示市价待定，不再出现今日/90天无数据', () => {
  const rows = [{
    zhName: '测试 Prime', nameEn: 'Primed Test', uniqueName: '/x', tradable: true,
    ducats: 300, credits: 140000, owned: false, advice: { tag: 'strong', zh: '强烈买' },
    platinum: 45, marketBasis: 'orders', orderLow: 45, orderCount: 12, orderLowSuspicious: false,
    todayMedian: null, todayVolume: 0, median90: 55, dailyVolume: 6, ratio: 6.67,
    ducatOpportunityPlat: null, ducatPlanShortfall: null, tradingTax: 1000000,
  }];
  const text = formatTraderShopping({ arrived: true, location: 'Orcus 中继站（冥王星）', ducatBalance: 255, rows, wantDucats: 300, affordable: true });
  assert.doesNotMatch(text, /今日无数据|90天无数据|无p/u);
  assert.match(text, /当前售价 45p（12 单在售）/u);
  assert.match(text, /奸商 140,000现金｜税 1,000,000/u);
});

test('buildTraderShoppingCard：三列对比、实用性标签、需求度与库存可动上限', async () => {
  const { buildTraderShoppingCard } = await import('./warframe-cards.mjs');
  const card = buildTraderShoppingCard({
    arrived: true, fetchedAt: '2026-08-21T12:00:00.000Z', location: 'Orcus 中继站（冥王星）',
    ducatBalance: 255, wantDucats: 300, affordable: true, safeDucatAvailable: 1385, rows: [{
      zhName: '制衡 Prime', nameEn: 'Primed Equilibrium', uniqueName: '/x', iconDataUri: null, tradable: true,
      ducats: 300, credits: 220000, owned: false, advice: { tag: 'must', zh: '公认必买' }, tier: 'S',
      platinum: 30, marketBasis: 'orders', orderLow: 30, orderCount: 6, orderLowSuspicious: true,
      todayMedian: 50, todayVolume: 9, median90: 55, dailyVolume: 6, ratio: 10,
      buyCount: 23, buyQty: 41, ducatNeed: 45, ducatOpportunityPlat: 2, ducatPlanShortfall: null,
      relicRuns: { min: 3, max: 5 }, tradingTax: 1000000,
    }],
  });
  assert.match(card.html, /公认必买/u);
  assert.match(card.html, /补足/u);
  assert.match(card.html, /虚空商人/u);
  assert.match(card.html, /市场/u);
  // 补足列：机会成本 + 预计开遗物区间
  assert.match(card.html, /45<\/span>/u);
  assert.match(card.html, /约 3~5 次遗物/u);
  // 需求度：求购单数 + 今日成交
  assert.match(card.html, /求购 23 单/u);
  assert.match(card.html, /今成交 9 笔/u);
  // 推荐标签=社区口碑分级，不再出现「已剔除异常低单」「90天」
  assert.doesNotMatch(card.html, /已剔除异常低单|90天/u);
  assert.match(card.html, /社区口碑分级/u);
  assert.match(card.html, /库存可动/u);
  assert.match(card.html, /1,385/u);
});

test('buildTraderShoppingCard：无卖单 → 今日成交中位作市场列对比价', async () => {
  const { buildTraderShoppingCard } = await import('./warframe-cards.mjs');
  const card = buildTraderShoppingCard({
    arrived: true, fetchedAt: '2026-08-21T12:00:00.000Z', location: 'Orcus 中继站（冥王星）',
    ducatBalance: 255, wantDucats: 300, affordable: true, rows: [{
      zhName: '极地弹仓 Prime', nameEn: 'Primed Ammo Case', uniqueName: '/y', tradable: true,
      ducats: 300, credits: 210000, owned: false, advice: { tag: 'good', zh: '强推' }, tier: 'A',
      platinum: 30, marketBasis: 'today', orderLow: null, orderCount: 0, orderLowSuspicious: false,
      todayMedian: 30, todayVolume: 55, median90: null, dailyVolume: 0,
      buyCount: 12, ducatNeed: 45, ducatOpportunityPlat: 6.5, ducatPlanShortfall: null, tradingTax: 1000000,
    }],
  });
  assert.match(card.html, /强推/u);
  assert.match(card.html, /今日中位/u);
});

test('buildTraderShoppingCard：无近期成交 → 市场列为市价待定', async () => {
  const { buildTraderShoppingCard } = await import('./warframe-cards.mjs');
  const card = buildTraderShoppingCard({
    arrived: true, fetchedAt: '2026-08-21T12:00:00.000Z', location: 'Orcus 中继站（冥王星）',
    ducatBalance: 255, wantDucats: 300, affordable: true, rows: [{
      zhName: '后纪 M5 遗物', nameEn: 'Neo M5 Relic', uniqueName: '/z', tradable: true,
      ducats: 125, credits: 55000, owned: false, advice: { tag: 'choice', zh: '看需求' }, tier: 'B',
      platinum: null, marketBasis: null, orderLow: null, orderCount: 0, orderLowSuspicious: false,
      todayMedian: null, todayVolume: 0, median90: 55, dailyVolume: 2,
      buyCount: null, ducatOpportunityPlat: null, ducatPlanShortfall: null, tradingTax: 2000,
    }],
  });
  assert.match(card.html, /市价待定/u);
});
