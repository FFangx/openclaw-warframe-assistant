import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyFissure, formatRecommend, parseDucatRecommendTarget, parseFissurePreference, parseRelicVaultFilter, recommendFissures, recommendRefinement } from './recommend.mjs';
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
  assert.deepEqual(parseDucatRecommendTarget('白金 速刷'), { type: 'none', query: '' });
});

test('ordinary Ducat mode ranks gross Ducat expectation while trader target ranks same-draw savings', async () => {
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
  assert.equal(targeted.rows[0].relic.base, 'Lith C1');
  assert.equal(targeted.rows[0].targetEconomy.expectedSaving, 2.5);
  assert.equal(targeted.rows[0].targetEconomy.conversionChance, 100);
  const card = buildFissureRecommendCard(targeted).html;
  assert.match(card, /测试奸商商品/u);
  assert.match(card, /预计省/u);
  assert.match(card, /不读取实时奖励/u);
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
    kind: 'recommend', command: '开遗物 杜卡德 电冲弹药', personal: true,
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
  assert.match(buildFissureRecommendCard(fissureData).html, /已入库/u);

  const refineData = await recommendRefinement(relics, { localDb, prices });
  assert.equal(refineData.rows[0].vaulted, true);
  assert.match(buildRefineRecommendCard(refineData).html, /已入库/u);
});
