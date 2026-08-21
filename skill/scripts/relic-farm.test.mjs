import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRelicFarmPlan, classifyRelicSources } from './relic-farm.mjs';
import { buildRelicFarmCard, buildRelicFarmSetCard, parseNaturalWorldQuestion, parseShortcutMessage } from './shortcuts.mjs';

const target = { name: 'Synthetic Prime Systems Blueprint', zhName: '合成 Prime 系统蓝图', slug: 'synthetic_prime_systems_blueprint', chance: 2, rarity: 'rare' };
const matches = [
  { name: 'Lith S1', zhName: '古纪 S1', vaulted: false, rewards: [target] },
  { name: 'Meso S2', zhName: '前纪 S2', vaulted: false, rewards: [target] },
  { name: 'Axi S3', zhName: '后纪 S3', vaulted: true, rewards: [target] },
];

test('哪里刷短命令与自然说法进入获取路线，不再落普通遗物反查', () => {
  assert.deepEqual(parseShortcutMessage('哪里刷 悟空Prime系统蓝图'), { command: 'relic-farm', query: '悟空Prime系统蓝图' });
  assert.deepEqual(parseShortcutMessage('哪里刷悟空Prime系统蓝图'), { command: 'relic-farm', query: '悟空Prime系统蓝图' });
  assert.deepEqual(parseShortcutMessage('悟空Prime系统蓝图哪里刷'), { command: 'relic-farm', query: '悟空Prime系统蓝图' });
  assert.deepEqual(parseShortcutMessage('怎么刷 悟空Prime系统蓝图'), { command: 'relic-farm', query: '悟空Prime系统蓝图' });
  assert.deepEqual(parseNaturalWorldQuestion('悟空系统在哪里获得'), { kind: 'relic-farm', command: '哪里刷 悟空系统', personal: false });
  assert.deepEqual(parseNaturalWorldQuestion('悟空系统哪里出'), { kind: 'relic-reverse', command: '遗物 悟空系统', personal: false });
});

test('来源分类明确区分常驻、当前赏金和静态轮换池', () => {
  const rows = classifyRelicSources([
    { place: '虚空 Hepit（捕获）', chance: 12.5 },
    { place: '希图斯悬赏 Lv10-30', chance: 8.33 },
  ], [{ placeZh: '希图斯', jobZh: '合成赏金', levels: [10, 30], chance: 11.11 }], { bountyChecked: true });
  assert.deepEqual(rows.map((row) => row.availability), ['current', 'always']);
  assert.equal(rows[0].place, '希图斯 合成赏金 Lv10-30');

  const rotated = classifyRelicSources([{ place: '福尔图娜悬赏 Lv40-60', chance: 7.14 }], [], { bountyChecked: true });
  assert.equal(rotated[0].availability, 'rotation');
  assert.equal(rotated[0].availabilityZh, '悬赏轮换池');

  const unchecked = classifyRelicSources([{ place: '殁世幽都悬赏 Lv30-40', chance: 6.25 }], [], { bountyChecked: false });
  assert.equal(unchecked[0].availability, 'unknown');
  assert.equal(unchecked[0].availabilityZh, '来源待确认');

  const legacyte = classifyRelicSources([{ place: 'H?llvania Legacyte Harvest轮次C', chance: 15.86 }]);
  assert.equal(legacyte[0].place, '霍瓦尼亚 传承种收割轮次C');
});

test('常见目标保持完整，不为提高单件概率误导用户精炼', () => {
  const commonTarget = { ...target, chance: 25.33, rarity: 'common' };
  const data = buildRelicFarmPlan({
    query: '合成系统',
    matches: [{ name: 'Lith S1', vaulted: false, rewards: [commonTarget] }],
    sourceMap: { 'Lith S1': [{ place: '虚空 Hepit（捕获）', chance: 12.5 }] },
    bountyChecked: true,
  });
  assert.equal(data.rows[0].refinement.zh, '完整');
  assert.equal(data.rows[0].refinement.chance, 25.33);
  assert.equal(data.rows[0].sources[0].combinedChance, 3.17);
});

test('获取路线优先已有库存，再按可信可用性和联合概率排序', () => {
  const data = buildRelicFarmPlan({
    query: '合成系统', matches,
    sourceMap: {
      'Lith S1': [{ place: '虚空 Hepit（捕获）', chance: 12.5 }],
      'Meso S2': [{ place: '希图斯悬赏 Lv10-30', chance: 20 }],
      'Axi S3': [{ place: '塞德娜 Xini轮次C', chance: 14.29 }],
    },
    bountyHitsByRelic: { 'Meso S2': [{ placeZh: '希图斯', jobZh: '合成赏金', levels: [10, 30], chance: 10 }] },
    bountyChecked: true,
    ownedRelics: [{ baseName: 'Meso S2', count: 3 }, { baseName: 'Meso S2', count: 2 }],
    fetchedAt: '2026-08-21T00:00:00.000Z',
  });
  assert.equal(data.ok, true);
  assert.equal(data.target.zhName, '合成 Prime 系统蓝图');
  assert.equal(data.rows[0].relic.name, 'Meso S2');
  assert.equal(data.rows[0].relic.ownedCount, 5);
  assert.equal(data.rows[0].refinement.zh, '光辉');
  assert.equal(data.rows[0].refinement.chance, 10);
  assert.equal(data.rows[0].sources[0].availability, 'current');
  assert.equal(data.rows[0].sources[0].combinedChance, 1);
  assert.equal(data.rows.find((row) => row.relic.name === 'Axi S3').sources.length, 0);
  const card = buildRelicFarmCard(data);
  assert.match(card.html, /获取路线/u);
  assert.match(card.html, /先开现有库存/u);
  assert.match(card.html, /当前赏金/u);
  assert.match(card.html, /联合 1%/u);
});

test('模糊目标命中多个具体部件时要求澄清', () => {
  const data = buildRelicFarmPlan({
    query: '合成 Prime',
    matches: [{
      name: 'Lith S1', vaulted: false,
      rewards: [target, { ...target, name: 'Synthetic Prime Chassis Blueprint', zhName: '合成 Prime 机体蓝图', slug: 'synthetic_prime_chassis_blueprint' }],
    }],
  });
  assert.equal(data.ok, false);
  assert.equal(data.error, 'ambiguous_target');
  assert.deepEqual(new Set(data.choices), new Set(['合成 Prime 系统蓝图', '合成 Prime 机体蓝图']));
});

test('Vanguard 遗物使用国际服中文并标明限时阿耶来源', () => {
  const data = buildRelicFarmPlan({
    query: '合成系统',
    matches: [{ name: 'Vanguard E1', vaulted: true, rewards: [target] }],
    sourceMap: {},
    bountyChecked: true,
  });
  assert.equal(data.rows[0].relic.vanguard, true);
  const card = buildRelicFarmCard(data);
  assert.match(card.html, /先锋 E1/u);
  assert.match(card.html, /瓦奇娅限时阿耶兑换，当前未开放/u);
  assert.doesNotMatch(card.html, /Vanguard/u);
});

test('同一 Prime 战甲的四个部件生成整套获取总览', () => {
  const rewards = [
    { name: 'Synthetic Prime Blueprint', zhName: '合成 Prime 蓝图', slug: 'synthetic_prime_blueprint', chance: 11 },
    { name: 'Synthetic Prime Neuroptics Blueprint', zhName: '合成 Prime 头部神经光元 蓝图', slug: 'synthetic_prime_neuroptics_blueprint', chance: 2 },
    { name: 'Synthetic Prime Chassis Blueprint', zhName: '合成 Prime 机体 蓝图', slug: 'synthetic_prime_chassis_blueprint', chance: 25.33 },
    { name: 'Synthetic Prime Systems Blueprint', zhName: '合成 Prime 系统 蓝图', slug: 'synthetic_prime_systems_blueprint', chance: 2 },
  ];
  const setMatches = rewards.map((reward, index) => ({ name: `Lith S${index + 1}`, vaulted: false, rewards: [reward] }));
  const data = buildRelicFarmPlan({
    query: '合成 p', matches: setMatches,
    sourceMap: Object.fromEntries(setMatches.map((relic) => [relic.name, [{ place: '虚空 Hepit（捕获）', chance: 12.5 }]])),
    bountyChecked: true, ownedRelics: [{ baseName: 'Lith S4', count: 4 }],
  });
  assert.equal(data.ok, true);
  assert.equal(data.setMode, true);
  assert.equal(data.set.zhName, '合成 Prime');
  assert.equal(data.components.length, 4);
  assert.equal(data.components[3].route.relic.ownedCount, 4);
  data.headIconDataUri = 'data:image/png;base64,c2V0';
  data.components[0].iconDataUri = 'data:image/png;base64,cGFydA==';
  const card = buildRelicFarmSetCard(data);
  assert.match(card.html, /Prime 套装/u);
  assert.match(card.html, /头部神经光元 蓝图/u);
  assert.match(card.html, /data:image\/png;base64,c2V0/u);
  assert.match(card.html, /data:image\/png;base64,cGFydA==/u);
  assert.match(card.html, /先锋＝瓦奇娅限时阿耶兑换/u);
  assert.match(buildRelicFarmCard(data).html, /获取总览/u);
});
