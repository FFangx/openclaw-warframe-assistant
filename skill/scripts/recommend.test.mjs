import assert from 'node:assert/strict';
import test from 'node:test';

import { buildWfInfoDucatStrategy, classifyFissure, formatRecommend, parseDucatRecommendTarget, parseFissurePreference, parseFissureScope, parseRelicVaultFilter, recommendFissures, recommendRefinement } from './recommend.mjs';
import { parseAlecaMessage } from './alecaframe.mjs';
import { parseNaturalWorldQuestion, parseShortcutMessage } from './shortcuts.mjs';
import { buildFissureQueryCard, buildFissureRecommendCard, buildRefineRecommendCard } from './warframe-cards.mjs';

const relics = [{ baseName: 'Lith T1', count: 7, refinement: 'Intact', vaulted: true }];
const rewards = [
  { name: 'Common A', slug: 'common_a', chance: 25.33 },
  { name: 'Common B', slug: 'common_b', chance: 25.33 },
  { name: 'Common C', slug: 'common_c', chance: 25.33 },
  { name: 'Uncommon A', slug: 'uncommon_a', chance: 11 },
  { name: 'Uncommon B', slug: 'uncommon_b', chance: 11 },
  { name: 'Rare', slug: 'rare', chance: 2 },
];
const prices = Object.fromEntries(rewards.map((reward, index) => [reward.slug, {
  p: [3, 4, 5, 8, 9, 30][index],
  d: [15, 15, 15, 45, 45, 100][index],
  zh: `奖励 ${index + 1}`,
}]));
const localDb = { rewardsByBase: new Map([['Lith T1', rewards]]) };

test('builds a WFInfo target strategy with one consistent fair-price map', () => {
  const reliablePrices = Object.fromEntries(Object.entries(prices).map(([slug, entry], index) => [slug, {
    ...entry, reliable: true, marketBasis: index === 0 ? 'today' : '90d', dailyVolume: index + 1,
  }]));
  const strategy = buildWfInfoDucatStrategy({
    name: '测试商品', ducats: 350, marketPlat: 20, marketBasis: 'today', expiresAt: '2026-08-09T00:00:00.000Z',
  }, rewards, reliablePrices, new Date('2026-08-08T00:00:00.000Z'));
  assert.equal(strategy.breakEven, 17.5);
  assert.equal(strategy.mode, 'baro-target');
  assert.equal(strategy.prices['Common A'].platinum, 3);
  assert.equal(strategy.prices['Common A'].basis, 'today');
  assert.equal(Object.keys(strategy.prices).length, rewards.length);
});

function fissure(id, missionType, extra = {}) {
  return {
    id,
    tier: 'Lith',
    missionType,
    node: `${id} (Earth)`,
    expiry: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    expired: false,
    ...extra,
  };
}

const worldState = {
  fissures: [
    fissure('capture', 'Capture'),
    fissure('exterminate', 'Extermination'),
    fissure('hard-exterminate', 'Extermination', { isHard: true }),
    fissure('defense', 'Defense'),
    fissure('survival', 'Survival'),
    fissure('interception', 'Interception'),
    fissure('excavation', 'Excavation'),
    fissure('storm', 'Skirmish', { isStorm: true }),
  ],
};

async function run(preference) {
  return recommendFissures(relics, { preference, worldState, localDb, prices });
}

test('parses the four recommendation preferences', () => {
  assert.equal(parseFissurePreference('裂缝推荐'), 'balanced');
  assert.equal(parseFissurePreference('杜卡德 速刷'), 'speed');
  assert.equal(parseFissurePreference('白金 舒适 单人'), 'comfort');
  assert.equal(parseFissurePreference('额外收益'), 'yield');
});

test('parses a dedicated Steel Path fissure scope', () => {
  assert.equal(parseFissureScope('开遗物 钢铁'), 'steel');
  assert.equal(parseFissureScope('开遗物 钢铁之路 速刷'), 'steel');
  assert.equal(parseFissureScope('开遗物 速刷'), 'all');
  assert.deepEqual(parseDucatRecommendTarget('钢铁 速刷'), { type: 'none', query: '' });
});

test('parses relic vault filters without confusing 未入库 with 入库', () => {
  assert.equal(parseRelicVaultFilter('裂缝推荐'), 'all');
  assert.equal(parseRelicVaultFilter('裂缝推荐 未入库 白金 速刷'), 'unvaulted');
  assert.equal(parseRelicVaultFilter('裂缝推荐 当前可获取'), 'unvaulted');
  assert.equal(parseRelicVaultFilter('裂缝推荐 已入库 杜卡德'), 'vaulted');
});

test('parses ordinary, automatic trader and named-item Ducat modes', () => {
  assert.deepEqual(parseDucatRecommendTarget('杜卡德 未入库'), { type: 'ordinary', query: '' });
  assert.deepEqual(parseDucatRecommendTarget('杜卡德 奸商 速刷'), { type: 'trader', query: '' });
  assert.deepEqual(parseDucatRecommendTarget('杜卡德 Primed Flow 单人'), { type: 'item', query: 'Primed Flow' });
  assert.deepEqual(parseDucatRecommendTarget('串联弹匣 Prime 单人'), { type: 'item', query: '串联弹匣 Prime' });
  assert.deepEqual(parseDucatRecommendTarget('白金 速刷'), { type: 'none', query: '' });
});

test('trader target filters by break-even then ranks own-relic Ducat expectation', async () => {
  const flatRewards = (prefix) => rewards.map((reward, index) => ({ ...reward, slug: `${prefix}_${index}` }));
  const highDucat = flatRewards('high');
  const cheapDucat = flatRewards('cheap');
  const mixedPrices = {};
  highDucat.forEach((reward) => { mixedPrices[reward.slug] = { p: 20, d: 100, zh: '高杜高价奖励' }; });
  cheapDucat.forEach((reward) => { mixedPrices[reward.slug] = { p: 2, d: 45, zh: '低价兑换奖励' }; });
  const mixedRelics = [
    { baseName: 'Lith H1', count: 2, refinement: 'Intact', vaulted: false },
    { baseName: 'Lith C1', count: 2, refinement: 'Intact', vaulted: false },
  ];
  const mixedDb = { rewardsByBase: new Map([['Lith H1', highDucat], ['Lith C1', cheapDucat]]) };
  const oneFissure = { fissures: [fissure('capture', 'Capture')] };
  const ordinary = await recommendFissures(mixedRelics, { mode: 'ducat', worldState: oneFissure, localDb: mixedDb, prices: mixedPrices });
  assert.equal(ordinary.ducatStrategy, 'ordinary');
  assert.equal(ordinary.rows[0].relic.base, 'Lith H1');
  assert.equal(ordinary.rows[0].expectedDucats, 100);

  const ducatGoal = { name: '测试奸商商品', uniqueName: 'test', ducats: 300, marketPlat: 30, ducatsPerPlat: 10, marketBasis: 'today', dailyVolume: 5 };
  const targeted = await recommendFissures(mixedRelics, { mode: 'ducat', ducatGoal, worldState: oneFissure, localDb: mixedDb, prices: mixedPrices });
  assert.equal(targeted.ducatStrategy, 'trader');
  assert.equal(targeted.squad, 1);
  assert.equal(targeted.rows[0].relic.base, 'Lith C1');
  assert.equal(targeted.rows[0].targetEconomy.viable, true);
  assert.equal(targeted.rows[0].targetEconomy.expectedDucats, 45);
  assert.equal(targeted.rows[0].targetEconomy.expectedPlat, 2);
  assert.equal(targeted.rows[0].targetEconomy.efficiency, 22.5);
  const card = buildFissureRecommendCard(targeted).html;
  assert.match(card, /测试奸商商品/u);
  assert.match(card, /立即可开/u);
  assert.match(card, /WFInfo 按实际四选一守保本线/u);
  assert.doesNotMatch(card, /转换概率|预计省/u);
});

test('trader target adds three obtainable unowned relics with sources', async () => {
  const ownedRewards = rewards.map((reward, index) => ({ ...reward, slug: `owned_${index}` }));
  const acquireRewards = rewards.map((reward, index) => ({ ...reward, slug: `acquire_${index}` }));
  const mixedPrices = {};
  ownedRewards.forEach((reward) => { mixedPrices[reward.slug] = { p: 20, d: 45, zh: '高价库存奖励' }; });
  acquireRewards.forEach((reward) => { mixedPrices[reward.slug] = { p: 2, d: 45, zh: '低价可刷奖励' }; });
  const mixedDb = {
    rewardsByBase: new Map([['Lith O1', ownedRewards], ['Lith A1', acquireRewards]]),
    relicsByBase: new Map([
      ['Lith O1', { base: 'Lith O1', era: 'Lith', vaulted: false }],
      ['Lith A1', { base: 'Lith A1', era: 'Lith', vaulted: false }],
    ]),
  };
  const goal = { name: '测试商品', ducats: 300, marketPlat: 30, shortfall: 180, ducatsPerPlat: 10 };
  const data = await recommendFissures([{ baseName: 'Lith O1', count: 1, refinement: 'Intact', vaulted: false }], {
    mode: 'ducat', ducatGoal: goal, worldState: { fissures: [fissure('capture', 'Capture')] },
    localDb: mixedDb, prices: mixedPrices,
    relicSources: { 'Lith A1': [{ place: '地球 Hepit（捕获）', chance: 12.5 }] },
  });
  assert.equal(data.ok, true);
  assert.equal(data.rows.length, 0);
  assert.equal(data.acquireRows.length, 1);
  assert.equal(data.acquireRows[0].relic.base, 'Lith A1');
  assert.equal(data.acquireRows[0].sources[0].place, '地球 Hepit（捕获）');
  const card = buildFissureRecommendCard(data).html;
  assert.match(card, /建议获取/u);
  assert.match(card, /地球 Hepit（捕获）/u);
});

test('vault filter only recommends matching relics already present in inventory', async () => {
  const mixedRelics = [
    ...relics,
    { baseName: 'Lith U1', count: 3, refinement: 'Intact', vaulted: false },
  ];
  const mixedDb = { rewardsByBase: new Map([['Lith T1', rewards], ['Lith U1', rewards]]) };
  const unvaulted = await recommendFissures(mixedRelics, { vaultFilter: 'unvaulted', worldState, localDb: mixedDb, prices });
  assert.equal(unvaulted.vaultFilter, 'unvaulted');
  assert.equal(unvaulted.appraisedCount, 1);
  assert.equal(unvaulted.rows.every((row) => row.relic.base === 'Lith U1' && row.relic.vaulted === false), true);
  const unvaultedCard = buildFissureRecommendCard(unvaulted).html;
  assert.match(unvaultedCard, /未入库/u);
  assert.doesNotMatch(unvaultedCard, /当前可获取/u);

  const vaulted = await recommendFissures(mixedRelics, { vaultFilter: 'vaulted', worldState, localDb: mixedDb, prices });
  assert.equal(vaulted.appraisedCount, 1);
  assert.equal(vaulted.rows.every((row) => row.relic.base === 'Lith T1' && row.relic.vaulted === true), true);
});

test('vault filter reports when inventory has no matching relics', async () => {
  const data = await recommendFissures(relics, { vaultFilter: 'unvaulted', worldState, localDb, prices });
  assert.equal(data.ok, false);
  assert.equal(data.error, 'no_relics_for_vault_filter');
  assert.match(formatRecommend(data), /没有“未入库”遗物/u);
});

test('labels mission experience without inventing a numeric time factor', () => {
  assert.deepEqual(classifyFissure({ missionType: 'Capture' }).map((tag) => tag.key), ['speed']);
  assert.deepEqual(classifyFissure({ missionType: 'Defense' }).map((tag) => tag.key), ['comfort', 'endless']);
  assert.deepEqual(classifyFissure({ missionType: 'Interception' }).map((tag) => tag.key), ['endless']);
  assert.deepEqual(classifyFissure({ missionType: 'Skirmish', isStorm: true }).map((tag) => tag.key), ['bonus']);
});

test('uses the unified Chinese name for Volatile missions', async () => {
  const data = await recommendFissures(relics, {
    preference: 'balanced',
    worldState: { fissures: [fissure('volatile', 'Volatile', { isStorm: true })] },
    localDb,
    prices,
  });
  assert.equal(data.rows[0].missionZh, '反应堆破坏');
});

test('keeps Void Cascade and Void Flood official Chinese names distinct', async () => {
  const data = await recommendFissures(relics, {
    preference: 'balanced',
    worldState: {
      fissures: [
        fissure('cascade', 'Void Cascade'),
        fissure('flood', 'Void Flood'),
      ],
    },
    localDb,
    prices,
  });
  assert.equal(data.rows.find((row) => row.missionType === 'Void Cascade')?.missionZh, '虚空覆涌');
  assert.equal(data.rows.find((row) => row.missionType === 'Void Flood')?.missionZh, '虚空洪流');
});

test('balanced mode recommends at most two distinct routes for one relic', async () => {
  const data = await run('balanced');
  assert.equal(data.ok, true);
  assert.equal(data.preference, 'balanced');
  assert.equal(data.rows.length, 2);
  assert.equal(new Set(data.rows.map((row) => row.id)).size, 2);
  assert.equal(data.rows.every((row) => row.tags.some((tag) => tag.key === 'speed')), true);
  assert.equal(data.matchedRelicCount, 1);
});

test('speed and comfort preferences choose the best two routes for each relic', async () => {
  const speed = await run('speed');
  assert.equal(speed.rows.length, 2);
  assert.equal(speed.rows.every((row) => row.tags.some((tag) => tag.key === 'speed')), true);

  const comfort = await run('comfort');
  assert.equal(comfort.rows.length, 2);
  assert.deepEqual(new Set(comfort.rows.map((row) => row.missionType)), new Set(['Defense', 'Survival']));
});

test('yield preference chooses Void Storm then Steel Path for each relic', async () => {
  const data = await run('yield');
  assert.equal(data.rows[0].storm, true);
  assert.equal(data.rows[1].hard, true);
});

test('Steel Path scope only returns Steel Path fissures', async () => {
  const data = await recommendFissures(relics, { fissureScope: 'steel', worldState, localDb, prices });
  assert.equal(data.ok, true);
  assert.equal(data.fissureScope, 'steel');
  assert.equal(data.rows.length, 1);
  assert.equal(data.rows.every((row) => row.hard), true);
  assert.match(buildFissureRecommendCard(data).html, /仅钢铁/u);

  const empty = await recommendFissures(relics, {
    fissureScope: 'steel', worldState: { fissures: [fissure('normal', 'Capture')] }, localDb, prices,
  });
  assert.equal(empty.error, 'no_steel_fissures');
  assert.match(formatRecommend(empty), /当前没有.*钢铁裂缝/u);
});

test('ranks distinct relics by value before expanding each to at most two routes', async () => {
  const pricedRewards = (prefix, price) => rewards.map((reward, index) => ({
    ...reward,
    slug: `${prefix}_${index}`,
    price,
  }));
  const highRewards = pricedRewards('high_value', 50);
  const midRewards = pricedRewards('mid_value', 40);
  const lowRewards = pricedRewards('low_value', 30);
  const rankedPrices = {};
  for (const reward of [...highRewards, ...midRewards, ...lowRewards]) {
    rankedPrices[reward.slug] = { p: reward.price, d: 15, zh: reward.slug };
  }
  const rankedRelics = [
    { baseName: 'Lith H1', count: 1, refinement: 'Intact', vaulted: false },
    { baseName: 'Lith M1', count: 1, refinement: 'Intact', vaulted: false },
    { baseName: 'Lith L1', count: 1, refinement: 'Intact', vaulted: false },
  ];
  const rankedDb = { rewardsByBase: new Map([
    ['Lith H1', highRewards],
    ['Lith M1', midRewards],
    ['Lith L1', lowRewards],
  ]) };
  const data = await recommendFissures(rankedRelics, { worldState, localDb: rankedDb, prices: rankedPrices });
  assert.deepEqual(data.rows.map((row) => row.relic.base), [
    'Lith H1', 'Lith H1', 'Lith M1', 'Lith M1', 'Lith L1', 'Lith L1',
  ]);
  for (const base of ['Lith H1', 'Lith M1', 'Lith L1']) {
    const routes = data.rows.filter((row) => row.relic.base === base);
    assert.equal(routes.length, 2);
    assert.equal(new Set(routes.map((row) => row.id)).size, 2);
  }
  assert.match(buildFissureRecommendCard(data).html, /每种最多 2 条路线/u);
});

test('fissure-first perspective keeps every fissure once and may repeat its best compatible relic', async () => {
  const data = await recommendFissures(relics, { perspective: 'fissure', minRemainMs: 0, worldState, localDb, prices });
  assert.equal(data.perspective, 'fissure');
  assert.equal(data.rows.length, worldState.fissures.length);
  assert.equal(new Set(data.rows.map((row) => row.id)).size, worldState.fissures.length);
  assert.equal(data.rows.every((row) => row.relic.base === 'Lith T1'), true);
});

test('fissure-first perspective also recommends owned Requiem relics for Requiem fissures', async () => {
  const requiemRelics = [{ baseName: 'Requiem I', count: 2, refinement: 'Intact', vaulted: false }];
  const requiemDb = { rewardsByBase: new Map([['Requiem I', rewards]]) };
  const requiemFissure = fissure('requiem', 'Survival', { tier: 'Requiem' });
  const data = await recommendFissures(requiemRelics, {
    perspective: 'fissure', minRemainMs: 0, worldState: { fissures: [requiemFissure] }, localDb: requiemDb, prices,
  });
  assert.equal(data.rows[0].relic.base, 'Requiem I');
});

test('裂缝推荐兼容到任务卡，开遗物进入遗物先行个人模式', () => {
  assert.deepEqual(parseShortcutMessage('裂缝推荐 杜卡德'), { command: 'fissure', query: '杜卡德' });
  assert.deepEqual(parseAlecaMessage('开遗物 杜卡德'), { command: 'recommend', query: '杜卡德' });
  assert.equal(parseAlecaMessage('裂缝推荐'), null);
});

test('自然语言购买奸商商品会进入指定商品的开遗物模式', () => {
  assert.deepEqual(parseNaturalWorldQuestion('我先买电冲弹药，怎么开遗物合适'), {
    kind: 'recommend', command: '开遗物 电冲弹药', personal: true,
  });
  assert.deepEqual(parseNaturalWorldQuestion('怎么开遗物合适'), {
    kind: 'recommend', command: '开遗物', personal: true,
  });
});

test('merged fissure card shows all task labels and only exposes inventory in personalized data', () => {
  const baseRow = {
    id: 'capture', tier: 'Lith', mission: '捕获', missionType: 'Capture', faction: 'Corpus', planet: '地球', node: 'Hepit',
    expiry: new Date(Date.now() + 60 * 60 * 1000).toISOString(), hard: false, storm: false,
    tags: [{ key: 'speed', zh: '速刷' }],
  };
  const publicHtml = buildFissureQueryCard({
    title: '当前虚空裂缝', normal: [baseRow], hard: [], normalTotal: 1, hardTotal: 0, total: 1, fetchedAt: new Date().toISOString(), personalized: false,
  }).html;
  assert.match(publicHtml, /普通/u);
  assert.match(publicHtml, /速刷/u);
  assert.doesNotMatch(publicHtml, /前纪 D8/u);

  const personalHtml = buildFissureQueryCard({
    title: '当前虚空裂缝', normal: [{ ...baseRow, recommendation: { relic: { zh: '古纪 T1', count: 7, vaulted: true }, expectedValue: 12, expectedDucats: 40, refineZh: '无瑕' } }],
    hard: [], normalTotal: 1, hardTotal: 0, total: 1, fetchedAt: new Date().toISOString(), personalized: true, recommendationModeZh: '白金',
  }).html;
  assert.match(personalHtml, /推荐 古纪 T1/u);
  assert.match(personalHtml, /已入库/u);
});

test('裂缝与精炼推荐保留并展示遗物入库状态', async () => {
  const fissureData = await run('balanced');
  assert.equal(fissureData.rows[0].relic.vaulted, true);
  const fissureCard = buildFissureRecommendCard(fissureData).html;
  assert.match(fissureCard, /已入库/u);
  assert.match(fissureCard, /建议(?:光辉|无瑕|不精炼)/u);
  assert.match(fissureCard, /价格优先今日中位，样本不足取90日/u);
  assert.doesNotMatch(fissureCard, /日均/u);

  const refineData = await recommendRefinement(relics, { localDb, prices });
  assert.equal(refineData.rows[0].vaulted, true);
  assert.match(buildRefineRecommendCard(refineData).html, /已入库/u);
});
