import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDucatPlan,
  buildDucatCandidates,
  optimizeDucatTarget,
  parseDucatSpec,
} from './ducat-planner.mjs';
import { annotateParentOwnership } from './alecaframe.mjs';
import { normalizeTraderLocation, selectTraderGoal, summarizeTradeStatistics, traderShopping } from './trader-shopping.mjs';
import { buildDucatPlanCard, buildTraderShoppingCard } from './warframe-cards.mjs';
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
    reserveCount: 1, reserveSets: null, reserveExplicit: true, aggressive: false,
  });
  assert.equal(parseDucatSpec('杜卡德 清仓').mode, 'clearance');
  assert.equal(parseDucatSpec('杜卡德 清仓').reserveExplicit, false);
  assert.equal(parseDucatSpec('杜卡德 清仓').aggressive, false);
  assert.equal(parseDucatSpec('杜卡德兑换 清仓 保留2套').reserveSets, 2);
  const aggressive = parseDucatSpec('杜卡德 600 激进');
  assert.equal(aggressive.reserveExplicit, true);
  assert.equal(aggressive.aggressive, true);
  assert.equal(aggressive.reserveCount, 0);
  assert.equal(parseDucatSpec('杜卡德 600 激进').target, 600);
});

test('默认保留已入库（不可再生），未入库全量参与；显式保留/激进优先覆盖', () => {
  const smart = parseDucatSpec('杜卡德 600');
  const candidates = buildDucatCandidates([
    part({ name: '已入库件', count: 3, vaulted: true, setRequired: 2 }),
    part({ name: '未入库件', count: 3, vaulted: false, setRequired: 2 }),
    part({ name: '状态未知件', count: 3, vaulted: null }),
  ], smart);
  const byName = new Map(candidates.map((entry) => [entry.name, entry]));
  // 已入库 → 全部保留 → available=0 → 不进候选
  assert.equal(candidates.some((entry) => entry.name === '已入库件'), false);
  assert.deepEqual([byName.get('未入库件').reserve, byName.get('未入库件').available, byName.get('未入库件').reserveReason, byName.get('未入库件').reserveState], [0, 3, null, null]);
  assert.deepEqual([byName.get('状态未知件').reserve, byName.get('状态未知件').available], [0, 3]);

  // 显式保留1：已入库也只留 1 个（数量保留语义，vault 不再默认保护）
  const [forced] = buildDucatCandidates([part({ count: 2, vaulted: true })], parseDucatSpec('杜卡德 保留1'));
  assert.equal(forced.reserve, 1);
  assert.equal(forced.available, 1);
  assert.equal(forced.reserveReason, null);

  // 激进：已入库也参与、每种保留 0
  const [aggressive] = buildDucatCandidates([part({ count: 2, vaulted: true })], parseDucatSpec('杜卡德 600 激进'));
  assert.equal(aggressive.reserve, 0);
  assert.equal(aggressive.available, 2);
});

test('本机装备栏为 Prime 部件标注对应成品拥有状态', () => {
  const entries = [
    part({ parentUniqueName: '/Lotus/Weapons/Tenno/LongGuns/OwnedPrime' }),
    part({ name: '未拥有', parentUniqueName: '/Lotus/Weapons/Tenno/LongGuns/MissingPrime' }),
  ];
  const marked = annotateParentOwnership(entries, {
    LongGuns: [{ ItemType: '/Lotus/Weapons/Tenno/LongGuns/OwnedPrime' }],
  });
  assert.equal(marked[0].parentOwned, true);
  assert.equal(marked[1].parentOwned, false);
  assert.equal(annotateParentOwnership(entries, {})[0].parentOwned, null);
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

test('杜卡德机会成本只使用成交中位，不再混入最低卖单', async () => {
  const plan = await buildDucatPlan([
    part({ count: 2, parentOwned: true }),
  ], parseDucatSpec('杜卡德 清仓'), {
    catalog: {
      cheapprimepartblueprint: { slug: 'cheap_prime_part_blueprint', zhName: '廉价 Prime 部件蓝图' },
    },
    statisticsFetcher: async () => ({ payload: { statistics_closed: {
      '48hours': [{ datetime: new Date().toISOString(), median: 3, volume: 8 }],
      '90days': [{ datetime: '2026-08-06T00:00:00.000Z', median: 4, volume: 900 }],
    } } }),
  });
  assert.equal(plan.rows[0].unitPlat, 3);
  assert.equal(plan.rows[0].lowestSell, undefined);
  assert.equal(plan.rows[0].marketBasis, 'today');
  assert.equal(plan.rows[0].dailyVolume, 10);
  assert.equal(plan.totalPlat, 6);
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
  // 无有效卖单 → 回退成交统计，保持既有断言；挂单低值口径由 trader-shopping.test.mjs 单独覆盖
  ordersFetcher: async () => ({ sell: [] }),
  detailFetcher: async () => ({ data: { tradingTax: 1_000_000 } }),
  // 未入库（可刷）：默认全部参与，安全库存=库存全额
  inventoryValuation: [part({ count: inventoryCount, vaulted: false })],
  ducatCatalog: {
    cheapprimepartblueprint: { slug: 'cheap_prime_part_blueprint', zhName: '廉价 Prime 部件蓝图' },
  },
  ducatStatisticsFetcher: async () => ({ payload: { statistics_closed: {
    '48hours': [{ datetime: new Date().toISOString(), median: 3, volume: 8 }],
    '90days': [{ datetime: '2026-08-06T00:00:00.000Z', median: 3, volume: 900 }],
  } } }),
});

test('奸商联动两侧均使用成交中位价、准确交易税和安全库存机会成本', async () => {
  const result = await traderFixture();
  const [row] = result.rows;
  assert.equal(row.tradingTax, 1_000_000);
  assert.equal(row.ducatNeed, 195);
  assert.equal(row.ducatOpportunityPlat, 15);
  assert.equal(row.platSaving, 10);
  assert.equal(row.creditSaving, 800_000);
  assert.equal(row.advice.tag, 'strong');
  assert.equal(result.safeDucatAvailable, 450);
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
    platinum: 30, basis: 'today', todayVolume: 5, todayMedian: 30,
    median90: 24, deviationPct: 25, dailyVolume: 2,
  });
  payload.payload.statistics_closed['48hours'][1].volume = 1;
  assert.equal(summarizeTradeStatistics(payload, true, now).basis, '90days');
  assert.equal(summarizeTradeStatistics(payload, true, now).platinum, 24);

  payload.payload.statistics_closed['48hours'][1] = { datetime: '2026-08-07T03:00:00.000Z', median: 60, volume: 4, mod_rank: 0 };
  assert.equal(summarizeTradeStatistics(payload, true, now).basis, '90days');
  payload.payload.statistics_closed['48hours'][1].volume = 9;
  assert.equal(summarizeTradeStatistics(payload, true, now).basis, 'today');
  assert.equal(summarizeTradeStatistics(payload, true, now).platinum, 60);
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

test('杜卡德卡片名称变化时不会复用旧图片缓存', () => {
  const row = {
    uniqueName: '/Lotus/Types/Recipes/Weapons/WeaponParts/PrimeFangHandle',
    name: '狼牙 Prime 握柄',
    englishName: 'Fang Prime Handle',
    owned: 2,
    reserve: 1,
    reserveReason: '未持有',
    reserveState: 'unowned',
    exchangeQty: 1,
    ducatsEach: 45,
    totalDucats: 45,
    unitPlat: 3,
    totalPlat: 3,
    marketBasis: 'today',
    dailyVolume: 10,
  };
  const data = {
    mode: 'target', target: 300, reserveLabel: '智能保留', reserveExplicit: false,
    reserveSets: null, complete: true, totalDucats: 45, totalPlat: 3,
    syncedAt: '2026-08-07T23:05:34.000Z', rows: [row],
  };
  const corrected = buildDucatPlanCard(data);
  const stale = buildDucatPlanCard({ ...data, rows: [{ ...row, name: '帕里斯 Prime 握柄' }] });
  assert.notEqual(corrected.key, stale.key);
  assert.match(corrected.html, /狼牙 Prime 握柄/u);
  const incomplete = buildDucatPlanCard({ ...data, complete: false, shortfall: 275 });
  assert.match(incomplete.html, /还差\s+<span[^>]*>.*?<img[^>]+>.*?275/su);
});

test('安全库存无法补足时不会误报奸商路线划算', async () => {
  const result = await traderFixture(2);
  assert.equal(result.rows[0].advice.tag, 'need');
  assert.equal(result.rows[0].ducatPlanShortfall, 105);
  const card = buildTraderShoppingCard(result);
  assert.match(card.html, /今日成交中位/u);
  assert.match(card.html, /90天 \d+p · 日均/u);
  assert.match(card.html, /市场行情仍可参考/u);
  assert.match(card.html, /Kronia 中继站（土星）/u);
});

test('默认模式把已入库部件移入保护区，不进入候选与目标优化', async () => {
  const entries = [
    part({ name: 'Valkyr Prime 机体蓝图', count: 1, vaulted: true, unit: 35, ducats: 100 }),
    part({ name: '古早 Prime 蓝图', count: 10, vaulted: false, unit: 3, ducats: 45 }),
  ];
  const plan = await buildDucatPlan(entries, parseDucatSpec('杜卡德 清仓'), {
    catalog: {
      cheapprimepartblueprint: { slug: 'cheap_prime_part_blueprint', zhName: '古早 Prime 蓝图' },
      valkyrprimechassisblueprint: { slug: 'valkyr_prime_chassis_blueprint', zhName: 'Valkyr Prime 机体蓝图' },
    },
    statisticsFetcher: async () => ({ payload: { statistics_closed: {
      '48hours': [{ datetime: new Date().toISOString(), median: 3, volume: 8 }],
      '90days': [{ datetime: '2026-08-06T00:00:00.000Z', median: 4, volume: 900 }],
    } } }),
  });
  assert.equal(plan.rows.some((row) => row.name === 'Valkyr Prime 机体蓝图'), false);
  assert.equal(plan.rows[0].name, '古早 Prime 蓝图');
  assert.equal(plan.protectedParts.length, 1);
  assert.equal(plan.protectedParts[0].name, 'Valkyr Prime 机体蓝图');
  assert.equal(plan.protectedParts[0].unitPlat, 35);
  assert.equal(plan.reserveLabel, '已入库保留');
});

test('激进模式把已入库也纳入候选', async () => {
  const entries = [part({ name: 'Valkyr Prime 机体蓝图', count: 1, vaulted: true, unit: 35, ducats: 100 })];
  const candidates = buildDucatCandidates(entries, parseDucatSpec('杜卡德 600 激进'));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].reserve, 0);
  assert.equal(candidates[0].vaulted, true);
});

test('formatDucatPlan：已入库保留区与空候选提示', async () => {
  const { formatDucatPlan } = await import('./ducat-planner.mjs');
  const text = formatDucatPlan({
    mode: 'clearance', reserveLabel: '已入库保留', rows: [], protectedParts: [
      { name: 'Valkyr Prime 机体蓝图', count: 1, ducatsEach: 100, unitPlat: 35 },
    ],
  });
  assert.match(text, /另有 1 件已入库部件默认保留/u);
  assert.match(text, /Valkyr Prime 机体蓝图/u);
  assert.match(text, /杜卡德 600 激进/u);
});

test('杜卡德卡片：vault 徽标与已入库保留区', () => {
  const row = {
    uniqueName: '/Lotus/Types/Recipes/WarframeRecipes/ValkyrPrimeChassisBlueprint',
    name: 'Valkyr Prime 机体蓝图', englishName: 'Valkyr Prime Chassis Blueprint',
    owned: 1, reserve: 0, exchangeQty: 1, ducatsEach: 100, totalDucats: 100, totalPlat: 35,
    unitPlat: 35, marketBasis: 'today', dailyVolume: 10, vaulted: true,
  };
  const card = buildDucatPlanCard({
    mode: 'clearance', reserveLabel: '已入库保留', reserveExplicit: false, aggressive: false,
    reserveSets: null, complete: true, totalDucats: 100, totalPlat: 35,
    syncedAt: '2026-08-07T23:05:34.000Z', rows: [row],
    protectedParts: [{ uniqueName: '/x/Prot', name: '战狼 Prime 蓝图', count: 1, ducatsEach: 45, unitPlat: 8 }],
  });
  assert.match(card.html, /已入库/u);
  assert.match(card.html, /未入库/u);
  assert.match(card.html, /已入库保留/u);
  assert.match(card.html, /战狼 Prime 蓝图/u);
  assert.match(card.html, /杜卡德 600 激进/u);
});
