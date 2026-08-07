import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDucatCandidates,
  optimizeDucatTarget,
  parseDucatSpec,
} from './ducat-planner.mjs';
import { normalizeTraderLocation, selectTraderGoal, summarizeTradeStatistics, traderShopping } from './trader-shopping.mjs';
import { buildTraderShoppingCard } from './warframe-cards.mjs';
import { primeWarframePartIconPath } from './wfdata.mjs';

const part = (overrides = {}) => ({
  catKey: 'part',
  uniqueName: '/Lotus/Types/Recipes/Weapons/CheapPrimePartBlueprint',
  englishName: 'Cheap Prime Part Blueprint',
  name: '廉价 Prime 部件蓝图',
  count: 10,
  ducats: 45,
  unit: 3,
  setRequired: 1,
  ...overrides,
});

test('Prime 战甲三类部件统一使用游戏内通用原图', () => {
  assert.match(
    primeWarframePartIconPath('/Lotus/Types/Recipes/WarframeRecipes/GyrePrimeChassisBlueprint', 'Gyre Prime Chassis Blueprint'),
    /GenericWarframePrimeChassis\.png$/u,
  );
  assert.match(
    primeWarframePartIconPath('/Lotus/Types/Recipes/WarframeRecipes/VorunaPrimeHelmetBlueprint', 'Voruna Prime Neuroptics Blueprint'),
    /GenericWarframePrimeHelmet\.png$/u,
  );
  assert.match(
    primeWarframePartIconPath('/Lotus/Types/Recipes/WarframeRecipes/XakuPrimeSystemsBlueprint', 'Xaku Prime Systems Blueprint'),
    /GenericWarframePrimeSystem\.png$/u,
  );
  assert.match(primeWarframePartIconPath(null, 'Protea Prime Neuroptics Blueprint'), /GenericWarframePrimeHelmet\.png$/u);
  assert.equal(primeWarframePartIconPath('/Lotus/Types/Recipes/Weapons/BratonPrimeStockBlueprint', 'Braton Prime Stock'), null);
  assert.equal(primeWarframePartIconPath('/Lotus/Types/Recipes/WarframeRecipes/ExcaliburChassisBlueprint', 'Excalibur Chassis Blueprint'), null);
});

test('短命令解析目标、清仓与按套保留', () => {
  assert.deepEqual(parseDucatSpec('杜卡德 600 保留1'), {
    query: '600 保留1', mode: 'target', target: 600, clearance: false,
    reserveCount: 1, reserveSets: null,
  });
  assert.equal(parseDucatSpec('杜卡德 清仓').mode, 'clearance');
  assert.equal(parseDucatSpec('杜卡德兑换 清仓 保留2套').reserveSets, 2);
});

test('保留一套会按配方数量保留双持部件', () => {
  const spec = parseDucatSpec('杜卡德 清仓 保留1套');
  const [candidate] = buildDucatCandidates([part({ count: 5, setRequired: 2 })], spec);
  assert.equal(candidate.reserve, 2);
  assert.equal(candidate.available, 3);
});

test('目标规划优先选择白金机会成本最低的有界组合', () => {
  const candidates = buildDucatCandidates([
    part({ name: '甲', count: 4, ducats: 100, unit: 9 }),
    part({ name: '乙', count: 4, ducats: 45, unit: 2 }),
  ], parseDucatSpec('杜卡德 200 保留0'));
  const plan = optimizeDucatTarget(candidates, 200);
  assert.equal(plan.complete, true);
  assert.equal(plan.totalDucats, 235);
  assert.equal(plan.totalPlat, 15);
  assert.equal(plan.rows[0].name, '乙');
});

const defaultTraderInventory = [{
  uniqueName: '/Lotus/StoreItems/Upgrades/Mods/PrimedTest',
  item: 'Primed Test',
  ducats: 300,
  credits: 200_000,
}];

const traderFixture = (inventoryCount = 10, traderInventory = defaultTraderInventory) => traderShopping({
  RegularCredits: 2_000_000,
  MiscItems: [{ ItemType: '/Lotus/Types/Items/MiscItems/PrimeBucks', ItemCount: 105 }],
}, {
  traderState: {
    character: "Baro Ki'Teer",
    location: 'Kronia Relay (Saturn)',
    activation: '2026-08-07T00:00:00.000Z',
    expiry: '2026-08-09T00:00:00.000Z',
    inventory: traderInventory,
  },
  catalog: {
    primedtest: { slug: 'primed_test', zh: '测试 Prime', thumb: null },
    primedtesttwo: { slug: 'primed_test_two', zh: '测试 Prime 二', thumb: null },
  },
  statisticsFetcher: async () => ({ payload: { statistics_closed: {
    '48hours': [{ datetime: new Date().toISOString(), median: 25, volume: 8, mod_rank: 0 }],
    '90days': [{ datetime: '2026-08-06T00:00:00.000Z', median: 24, volume: 90, mod_rank: 0 }],
  } } }),
  detailFetcher: async () => ({ data: { tradingTax: 1_000_000 } }),
  inventoryValuation: [part({ count: inventoryCount })],
  ducatCatalog: {
    cheapprimepartblueprint: { slug: 'cheap_prime_part_blueprint', zhName: '廉价 Prime 部件蓝图' },
  },
  ducatQuoteFetcher: async () => 3,
});

test('奸商联动使用 0 级成交中位价、准确交易税和安全库存机会成本', async () => {
  const result = await traderFixture();
  const [row] = result.rows;
  assert.equal(row.tradingTax, 1_000_000);
  assert.equal(row.ducatNeed, 195);
  assert.equal(row.ducatOpportunityPlat, 15);
  assert.equal(row.platSaving, 10);
  assert.equal(row.creditSaving, 800_000);
  assert.equal(row.advice.tag, 'strong');
  assert.equal(result.safeDucatAvailable, 405);
  assert.equal(result.ducatShortfall, 195);
});

test('开遗物可从当前货单自动或按商品名建立动态盈亏目标', async () => {
  const result = await traderFixture();
  const automatic = selectTraderGoal(result, { type: 'trader', query: '' });
  assert.equal(automatic.ok, true);
  assert.equal(automatic.goal.name, '测试 Prime');
  assert.equal(automatic.goal.ducats, 300);
  assert.equal(automatic.goal.marketPlat, 25);
  assert.equal(automatic.goal.ducatsPerPlat, 12);
  assert.equal(automatic.goal.source, 'trader');

  const named = selectTraderGoal(result, { type: 'item', query: '测试 Prime' });
  assert.equal(named.ok, true);
  assert.equal(named.goal.source, 'item');
  assert.equal(selectTraderGoal(result, { type: 'item', query: '测试 Prine' }).goal.name, '测试 Prime');
  assert.equal(selectTraderGoal(result, { type: 'item', query: '不存在' }).error, 'trader_item_not_found');
});

test('奸商地点使用游戏内中继站格式', async () => {
  assert.equal(normalizeTraderLocation('Kronia Relay (Saturn)'), 'Kronia 中继站（土星）');
  assert.equal(normalizeTraderLocation('土星 Kronia 中继站'), 'Kronia 中继站（土星）');
  assert.equal((await traderFixture()).location, 'Kronia 中继站（土星）');
});

test('成交统计优先今日中位且样本不足回退 90 天中位', () => {
  const now = Date.parse('2026-08-07T12:00:00.000Z');
  const payload = { payload: { statistics_closed: {
    '48hours': [
      { datetime: '2026-08-07T02:00:00.000Z', median: 20, volume: 1, mod_rank: 0 },
      { datetime: '2026-08-07T03:00:00.000Z', median: 30, volume: 4, mod_rank: 0 },
      { datetime: '2026-08-07T04:00:00.000Z', median: 999, volume: 1, mod_rank: 10 },
    ],
    '90days': [
      { datetime: '2026-08-05T00:00:00.000Z', median: 24, volume: 90, mod_rank: 0 },
      { datetime: '2026-08-06T00:00:00.000Z', median: 26, volume: 90, mod_rank: 0 },
    ],
  } } };
  assert.deepEqual(summarizeTradeStatistics(payload, true, now), {
    platinum: 30, basis: 'today', todayVolume: 5, median90: 24, dailyVolume: 2,
  });
  payload.payload.statistics_closed['48hours'][1].volume = 1;
  assert.equal(summarizeTradeStatistics(payload, true, now).basis, '90days');
  assert.equal(summarizeTradeStatistics(payload, true, now).platinum, 24);
});

test('奸商每件商品独立使用当前余额，不按展示顺序累扣', async () => {
  const result = await traderFixture(10, [
    ...defaultTraderInventory,
    {
      uniqueName: '/Lotus/StoreItems/Upgrades/Mods/PrimedTestTwo',
      item: 'Primed Test Two',
      ducats: 280,
      credits: 200_000,
    },
  ]);
  const needs = Object.fromEntries(result.rows.map((row) => [row.nameEn, row.ducatNeed]));
  assert.equal(needs['Primed Test'], 195);
  assert.equal(needs['Primed Test Two'], 175);
});

test('奸商卡片用杜卡德图标展示行内缺口和顶部摘要', async () => {
  const result = await traderFixture();
  const card = buildTraderShoppingCard(result);
  assert.match(card.html, /补足\s+<span[^>]*>.*?<img[^>]+>.*?195/su);
  assert.match(card.html, /各商品独立判断/u);
  assert.doesNotMatch(card.html, /补足\s+195\s+杜/u);
  assert.doesNotMatch(card.html, /当前\s+105\s+杜/u);
});

test('安全库存无法补足时不会误报奸商路线划算', async () => {
  const result = await traderFixture(2);
  assert.equal(result.rows[0].advice.tag, 'need');
  assert.equal(result.rows[0].ducatPlanShortfall, 150);
  const card = buildTraderShoppingCard(result);
  assert.match(card.html, /今日成交中位/u);
  assert.match(card.html, /90日均/u);
  assert.match(card.html, /市场行情仍可参考/u);
  assert.match(card.html, /Kronia 中继站（土星）/u);
});
