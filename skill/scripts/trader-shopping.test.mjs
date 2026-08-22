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
  // 遗物兜底=看需求（无数据不声称强推）；动态判定在 appraise 层升级 A
  assert.equal(gradeBaroItem({ slug: 'neo_m5', tradable: true, uniqueName: '/Lotus/Relics/NeoM5', nameEn: 'Neo M5' }), 'B');
  assert.equal(gradeBaroItem({ slug: 'neo_m5', tradable: true, uniqueName: '/Lotus/StoreItems/NeoM5Relic', nameEn: 'Neo M5', zhName: '后纪 M5 遗物' }), 'B');
  assert.equal(gradeBaroItem({ slug: 'deco', tradable: false, uniqueName: '/Lotus/Deco', nameEn: 'Deco' }), 'C');
  // 表合同：非 Baro 商品（Daily Tribute）不得入表；评审收敛后的 S 骨架
  const table = loadBaroTier();
  assert.equal(table.items.primed_sure_footed, undefined);
  assert.equal(table.items.primed_shred, 'S');
  assert.equal(table.items.primed_ammo_case, 'B');
});

test('appraiseTraderGoods：遗物奖励清单——官方中文名/库存持有与数量/单件市场，全有保持 B', async () => {
  const { appraiseTraderGoods } = await import('./trader-shopping.mjs');
  const relicDb = { rewardsByBase: new Map([['Axi M5', [
    { name: 'Masseter Prime Blade', rarity: 'Rare', chance: 2, slug: 'masseter_prime_blade' },
    { name: 'Forma Blueprint', rarity: 'Uncommon', chance: 25.33, slug: null },
    { name: 'Rubico Prime Barrel', rarity: 'Uncommon', chance: 11, slug: 'rubico_prime_barrel' },
    { name: 'Valkyr Prime Systems', rarity: 'Uncommon', chance: 25.33, slug: 'valkyr_prime_systems' },
    { name: 'Weird Prime Blade', rarity: 'Common', slug: 'weird_prime_blade' },
  ]]]) };
  const stats = async () => ({ payload: { statistics_closed: { '48hours': [{ datetime: new Date().toISOString(), median: 8, volume: 6 }], '90days': [{ datetime: '2026-08-06T00:00:00.000Z', median: 9, volume: 40 }] } } });
  const run = (valuation, itemName = 'Axi M5') => appraiseTraderGoods(
    [{ uniqueName: '/Lotus/Types/Game/Projections/AxiM5', item: itemName, ducats: 125, credits: 55000 }],
    {
      // 目录键='Axi M5 Relic' 的 compact；货单只给 'Axi M5' → 走 slug 候选 axi_m5_relic
      catalog: {
        axim5relic: { slug: 'axi_m5_relic', zh: '后纪 M5 遗物' },
        masseterprimeblade: { slug: 'masseter_prime_blade', zh: 'Masseter Prime 刀刃' },
        rubicoprimebarrel: { slug: 'rubico_prime_barrel', zh: 'Rubico Prime 枪管' },
        valkyrprimesystems: { slug: 'valkyr_prime_systems', zh: 'Valkyr Prime 系统' },
        formablueprint: { slug: 'forma_blueprint', zh: 'Forma 蓝图' },
      },
      statisticsFetcher: stats,
      detailFetcher: async () => ({ data: { tradingTax: 2000, i18n: { 'zh-hans': { description: '一个包含着奥罗金秘密的神器。' } } } }),
      ordersFetcher: async () => ({ sell: [{ platinum: 8, quantity: 1 }], buy: [{ platinum: 6, quantity: 3 }] }),
      relicDb,
      // 杜卡德价值表（slug → {d}）：奖励行与白金同构展示
      priceTable: { masseter_prime_blade: { d: 100 }, valkyr_prime_systems: { d: 45 }, rubico_prime_barrel: { d: 45 }, forma_blueprint: { d: 0 } },
      // 官方词典兜底（仅目录未收录的奖励名命中；测试注入，免网络）
      officialZh: new Map([['weird prime blade', '怪奇 Prime 刀刃']]),
      inventoryValuation: valuation,
    },
  );
  const missing = await run([{ englishName: 'Valkyr Prime Systems', count: 2 }]);
  assert.equal(missing[0].tradable, true);
  assert.equal(missing[0].slug, 'axi_m5_relic');
  assert.equal(missing[0].relicKind, true);
  assert.equal(missing[0].tier, 'A');
  assert.equal(missing[0].advice.tag, 'good');
  assert.equal(missing[0].description, '一个包含着奥罗金秘密的神器。');
  assert.equal(missing[0].relicParts.missingCount, 4);
  assert.equal(missing[0].relicParts.missing[0].name, 'Masseter Prime Blade'); // 稀有优先
  assert.equal(missing[0].relicParts.missing[0].rare, true);
  // 奖励全清单：官方中文名（wm 同款）+ 库存对照 + 单件市场（价格/杜卡德/近期成交）
  const rewards = missing[0].relicRewards;
  assert.equal(rewards.length, 5);
  const byName = Object.fromEntries(rewards.map((reward) => [reward.nameEn, reward]));
  assert.equal(byName['Masseter Prime Blade'].name, 'Masseter Prime 刀刃');
  assert.equal(byName['Masseter Prime Blade'].rarity, 'Rare');
  assert.deepEqual(
    { owned: byName['Masseter Prime Blade'].owned, count: byName['Masseter Prime Blade'].count, platinum: byName['Masseter Prime Blade'].platinum, ducats: byName['Masseter Prime Blade'].ducats, recentVolume: byName['Masseter Prime Blade'].recentVolume },
    { owned: false, count: 0, platinum: 8, ducats: 100, recentVolume: 6 },
  );
  assert.equal(byName['Valkyr Prime Systems'].name, 'Valkyr Prime 系统');
  assert.equal(byName['Valkyr Prime Systems'].owned, true);
  assert.equal(byName['Valkyr Prime Systems'].count, 2);
  // 档位按掉落率判定（25.33%→常见，即使 rarity 字段误标 Uncommon；11%→罕见）
  assert.equal(byName['Forma Blueprint'].rarity, 'Common');
  assert.equal(byName['Valkyr Prime Systems'].rarity, 'Common');
  assert.equal(byName['Rubico Prime Barrel'].rarity, 'Uncommon');
  assert.equal(byName['Forma Blueprint'].name, 'Forma 蓝图');
  assert.equal(byName['Forma Blueprint'].slug, 'forma_blueprint');
  // 表内 d=0（无杜卡德值）→ null，行内显示「杜 —」
  assert.equal(byName['Forma Blueprint'].ducats, null);
  // 目录未收录 → 官方词典兜底 + 无市场条目（不可交易）且无杜卡德值
  assert.equal(byName['Weird Prime Blade'].name, '怪奇 Prime 刀刃');
  assert.equal(byName['Weird Prime Blade'].tradable, false);
  assert.equal(byName['Weird Prime Blade'].slug, null);
  assert.equal(byName['Weird Prime Blade'].ducats, null);
  // 货单名称带 Relic 后缀或中文纪元名也匹配（relicPartsOf 解析 base='Axi M5'）
  const suffixed = await run([{ englishName: 'Valkyr Prime Systems', count: 2 }], 'Axi M5 Relic');
  assert.equal(suffixed[0].relicParts.missingCount, 4);
  const complete = await run([
    { englishName: 'Valkyr Prime Systems', count: 2 },
    { englishName: 'Masseter Prime Blade', count: 1 },
    { englishName: 'Rubico Prime Barrel', count: 1 },
    { englishName: 'Weird Prime Blade', count: 1 },
    { englishName: 'Forma Blueprint', count: 3 },
  ]);
  assert.equal(complete[0].tier, 'B');
  assert.equal(complete[0].relicParts.missingCount, 0);
  assert.ok(complete[0].relicRewards.every((reward) => reward.owned));
});

test('estimateRelicRuns：按期望 ±30% 给出区间，无效输入返回 null', async () => {
  const { estimateRelicRuns } = await import('./trader-shopping.mjs');
  assert.deepEqual(estimateRelicRuns(100, 10), { min: 8, max: 15 });
  assert.deepEqual(estimateRelicRuns(45, 12.5), { min: 3, max: 6 });
  assert.equal(estimateRelicRuns(0, 10), null);
  assert.equal(estimateRelicRuns(100, 0), null);
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
      relicRuns: { min: 3, max: 5 }, recentVolume: 9, description: '+55% 技能持续时间', tradingTax: 1000000,
    }],
  });
  assert.match(card.html, /公认必买/u);
  assert.match(card.html, /补足/u);
  assert.match(card.html, /虚空商人/u);
  assert.match(card.html, /市场/u);
  // 商品说明（Market i18n 中文描述）与原补足位置
  assert.match(card.html, /\+55% 技能持续时间/u);
  // 补足列：机会成本 + 预计开遗物区间
  assert.match(card.html, /45<\/span>/u);
  assert.match(card.html, /约 3~5 次遗物/u);
  // 需求度：求购单数 + 近 48 小时成交量
  assert.match(card.html, /求购 23 单/u);
  assert.match(card.html, /近期成交 9 笔/u);
  // 推荐标签=社区口碑分级，不再出现「已剔除异常低单」「90天」
  assert.doesNotMatch(card.html, /已剔除异常低单|90天/u);
  assert.match(card.html, /口碑分级/u);
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

test('buildTraderShoppingCard：遗物奖励清单一行一件、官方中文名+持有/市场信息、行高随清单自动缩放', async () => {
  const { buildTraderShoppingCard } = await import('./warframe-cards.mjs');
  const card = buildTraderShoppingCard({
    arrived: true, fetchedAt: '2026-08-21T12:00:00.000Z', location: 'Orcus 中继站（冥王星）',
    ducatBalance: 255, wantDucats: 0, affordable: true, rows: [{
      zhName: '后纪 M5 遗物', nameEn: 'Axi M5 Relic', uniqueName: '/z', tradable: true, relicKind: true,
      ducats: 125, credits: 55000, owned: false, advice: { tag: 'good', zh: '强推' }, tier: 'A',
      platinum: 8, marketBasis: 'orders', orderLow: 8, orderCount: 6, orderLowSuspicious: false,
      todayMedian: 30, todayVolume: 55, median90: null, dailyVolume: 0,
      buyCount: 38, ducatOpportunityPlat: null, ducatPlanShortfall: null, tradingTax: 2000,
      relicRewards: [
        { nameEn: 'Masseter Prime Blade', name: 'Masseter Prime 刀刃', rarity: 'Rare', owned: false, count: 0, slug: 'masseter_prime_blade', tradable: true, platinum: 8, ducats: 100, recentVolume: 89 },
        { nameEn: 'Valkyr Prime Systems', name: 'Valkyr Prime 系统', rarity: 'Common', owned: true, count: 2, slug: 'valkyr_prime_systems', tradable: true, platinum: 15, ducats: 45, recentVolume: 12 },
        { nameEn: 'Forma Blueprint', name: 'Forma 蓝图', rarity: 'Uncommon', owned: false, count: 0, slug: null, tradable: false, platinum: null, ducats: null, recentVolume: null },
      ],
    }],
  });
  assert.match(card.html, /Masseter Prime 刀刃/u);
  assert.match(card.html, /已持有 ×2/u);
  assert.match(card.html, /未持有/u);
  // 旧「未持有：」堆叠格式已移除
  assert.doesNotMatch(card.html, /未持有：/u);
  // 照遗物正查模板：彩色档位前缀（稀有/罕见/常见），无星标
  assert.match(card.html, /稀有/u);
  assert.match(card.html, /罕见/u);
  assert.match(card.html, /常见/u);
  assert.doesNotMatch(card.html, /★/u);
  // 价格/杜卡德 = 图标+数字（无 p 后缀），不再展示税
  assert.doesNotMatch(card.html, />\d+p</u);
  assert.doesNotMatch(card.html, /税 2,000|税 6,000/u);
  assert.match(card.html, /近期成交 89 笔/u);
  assert.match(card.html, /近期成交 12 笔/u);
  assert.match(card.html, /不可交易/u);
  // 市场区为固定宽度三段（52px/40px/近期成交），内部左对齐、各行以第一行为基准对齐
  assert.match(card.html, /flex:0 0 52px/u);
  assert.match(card.html, /flex:0 0 40px/u);
  // 行高 = 96 + 3 行 × 18，自动缩放（相对普通行 106 更高）
  assert.equal(card.height, 86 + 30 + 22 + (96 + 3 * 18) + 34);
  const plain = buildTraderShoppingCard({
    arrived: true, fetchedAt: '2026-08-21T12:00:00.000Z', location: 'Orcus 中继站（冥王星）',
    ducatBalance: 0, wantDucats: 0, affordable: true, rows: [{
      zhName: '制衡 Prime', nameEn: 'Primed Equilibrium', uniqueName: '/x', tradable: true,
      ducats: 300, credits: 220000, owned: false, advice: { tag: 'must', zh: '公认必买' }, tier: 'S',
      platinum: 30, marketBasis: 'orders', orderLow: 30, orderCount: 6, orderLowSuspicious: false,
      todayMedian: 50, todayVolume: 9, median90: 55, dailyVolume: 6, tradingTax: 1000000,
    }],
  });
  assert.equal(plain.height, 86 + 30 + 22 + 106 + 34);
});
