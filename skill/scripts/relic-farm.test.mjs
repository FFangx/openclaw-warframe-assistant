import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRelicFarmPlan, classifyRelicSources } from './relic-farm.mjs';
import { buildRelicFarmCard, buildRelicFarmSetCard, buildShortcutContextEnvelope, buildShortcutNextActions, parseNaturalWorldQuestion, parseShortcutMessage } from './shortcuts.mjs';
import { renderNextActions } from './card-actions.mjs';
import { buildWhereToBuyCard } from './vendor-shop-card.mjs';

const target = { name: 'Synthetic Prime Systems Blueprint', zhName: '合成 Prime 系统蓝图', slug: 'synthetic_prime_systems_blueprint', chance: 2, rarity: 'rare' };
const matches = [
  { name: 'Lith S1', zhName: '古纪 S1', vaulted: false, rewards: [target] },
  { name: 'Meso S2', zhName: '前纪 S2', vaulted: false, rewards: [target] },
  { name: 'Axi S3', zhName: '后纪 S3', vaulted: true, rewards: [target] },
];

test('正式获取短命令走确定性路线，口语获取问法只由自然语言路由改写', () => {
  assert.deepEqual(parseShortcutMessage('获取 悟空Prime系统蓝图'), { command: 'relic-farm', query: '悟空Prime系统蓝图' });
  assert.equal(parseShortcutMessage('哪里刷 悟空Prime系统蓝图'), null);
  assert.equal(parseShortcutMessage('悟空Prime系统蓝图哪里刷'), null);
  assert.equal(parseShortcutMessage('怎么刷 悟空Prime系统蓝图'), null);
  assert.deepEqual(parseNaturalWorldQuestion('悟空系统在哪里获得'), { kind: 'relic-farm', command: '获取 悟空系统', personal: false });
  assert.deepEqual(parseNaturalWorldQuestion('悟空系统哪里出'), { kind: 'relic-reverse', command: '遗物 悟空系统', personal: false });
});

test('哪里刷/怎么刷/哪里买/在哪换是自然语言问法，规范到获取/购买而不是快捷命令', () => {
  // 快捷命令入口只认正式的「获取」「购买」前缀
  assert.deepEqual(parseShortcutMessage('获取 悟空Prime系统蓝图'), { command: 'relic-farm', query: '悟空Prime系统蓝图' });
  assert.deepEqual(parseShortcutMessage('购买 诡文枭主'), { command: 'where-to-buy', query: '诡文枭主' });
  for (const colloquial of [
    '悟空Prime系统蓝图哪里刷', '哪里刷 悟空Prime系统蓝图', '怎么刷 悟空Prime系统蓝图', '悟空Prime系统蓝图怎么刷',
    '诡文枭主在哪里买', '诡文枭主哪里买', '诡文枭主在哪换', '诡文枭主哪里换',
    '哪里买 诡文枭主', '在哪换 诡文枭主', '怎么买 诡文枭主', '去哪买 诡文枭主',
  ]) {
    assert.equal(parseShortcutMessage(colloquial), null, colloquial);
  }
  // 自然语言路由把口语规范成正式命令：刷/获得→获取，买/换/兑换→购买
  assert.deepEqual(parseNaturalWorldQuestion('Caliban p哪里刷'), { kind: 'relic-farm', command: '获取 Caliban p', personal: false });
  assert.deepEqual(parseNaturalWorldQuestion('怎么刷 Caliban p'), { kind: 'relic-farm', command: '获取 Caliban p', personal: false });
  assert.deepEqual(parseNaturalWorldQuestion('诡文枭主在哪里买'), { kind: 'where-to-buy', command: '购买 诡文枭主', personal: false });
  assert.deepEqual(parseNaturalWorldQuestion('诡文枭主在哪换'), { kind: 'where-to-buy', command: '购买 诡文枭主', personal: false });
  assert.deepEqual(parseNaturalWorldQuestion('哪里买 诡文枭主'), { kind: 'where-to-buy', command: '购买 诡文枭主', personal: false });
  assert.deepEqual(parseNaturalWorldQuestion('在哪换 诡文枭主'), { kind: 'where-to-buy', command: '购买 诡文枭主', personal: false });
  assert.deepEqual(parseNaturalWorldQuestion('怎么买 诡文枭主'), { kind: 'where-to-buy', command: '购买 诡文枭主', personal: false });
});

test('获取 X 的整套上下文保留实体规范名，下一句「这个甲多少钱」可直接续查市价', () => {
  const rewards = [
    { name: 'Synthetic Prime Blueprint', zhName: '合成 Prime 蓝图', slug: 'synthetic_prime_blueprint', chance: 11 },
    { name: 'Synthetic Prime Neuroptics Blueprint', zhName: '合成 Prime 头部神经光元 蓝图', slug: 'synthetic_prime_neuroptics_blueprint', chance: 2 },
    { name: 'Synthetic Prime Chassis Blueprint', zhName: '合成 Prime 机体 蓝图', slug: 'synthetic_prime_chassis_blueprint', chance: 25.33 },
    { name: 'Synthetic Prime Systems Blueprint', zhName: '合成 Prime 系统 蓝图', slug: 'synthetic_prime_systems_blueprint', chance: 2 },
  ];
  const setMatches = rewards.map((reward, index) => ({ name: `Lith S${index + 1}`, vaulted: false, rewards: [reward] }));
  const data = buildRelicFarmPlan({ query: '合成 p', matches: setMatches, sourceMap: {}, bountyChecked: true });
  assert.equal(data.ok, true);
  assert.equal(data.setMode, true);
  data.nextActions = buildShortcutNextActions(data, { query: '合成 p' });
  const envelope = buildShortcutContextEnvelope(data, { query: '合成 p' });
  // 实体：整套战甲，displayName 给模型看，canonicalName 可直接拼成 wm 查询
  assert.deepEqual(envelope.entities[0], { type: 'prime-set', displayName: '合成 Prime', canonicalName: 'Synthetic Prime' });
  const priceFollowup = parseShortcutMessage(`wm ${envelope.entities[0].canonicalName}`);
  assert.deepEqual(priceFollowup, { command: 'market', query: 'Synthetic Prime' });
  // 信封携带的 nextActions 与卡片渲染的是同一份 {command,label} 数据
  assert.deepEqual(envelope.nextActions, data.nextActions);
  assert.equal(envelope.scope, 'public');
});

test('nextActions 与卡片提示、上下文信封使用同一结构且内容一致', () => {
  // Prime 整套市价卡 → 提示获取路线
  const marketData = { ok: true, kind: 'market', query: '夜灵p', item: { name: 'Revenant Prime Set', zhName: 'Revenant Prime Set' }, sell: [{ platinum: 100 }], buy: [], fetchedAt: '2026-08-21T00:00:00.000Z' };
  marketData.nextActions = buildShortcutNextActions(marketData, { query: '夜灵p' });
  assert.deepEqual(marketData.nextActions, [{ command: '获取 Revenant Prime', label: '查看获取路线' }]);
  const marketEnvelope = buildShortcutContextEnvelope(marketData, { query: '夜灵p' });
  assert.deepEqual(marketEnvelope.nextActions, marketData.nextActions);
  assert.equal(marketEnvelope.entities[0].type, 'market-item');
  const marketChips = renderNextActions(marketData.nextActions);
  for (const action of marketData.nextActions) assert.match(marketChips, new RegExp(action.command.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));

  // 购买反查卡 → 提示市价 + 商人货单
  const buyData = {
    ok: true, kind: 'where-to-buy', query: '诡文枭主',
    hits: [{ itemName: '诡文枭主', vendorZh: '泰辛', availability: '常驻' }], total: 1,
    fetchedAt: '2026-08-21T00:00:00.000Z',
  };
  buyData.nextActions = buildShortcutNextActions(buyData, { query: '诡文枭主' });
  assert.deepEqual(buyData.nextActions, [
    { command: 'wm 诡文枭主', label: '查看玩家市场' },
    { command: '商店 泰辛', label: '查看商人货单' },
  ]);
  const buyEnvelope = buildShortcutContextEnvelope(buyData, { query: '诡文枭主' });
  assert.deepEqual(buyEnvelope.nextActions, buyData.nextActions);
  assert.deepEqual(buyEnvelope.entities[0], { type: 'shop-item', displayName: '诡文枭主', canonicalName: '诡文枭主' });
  const buyCard = buildWhereToBuyCard(buyData, buyData.fetchedAt);
  for (const action of buyData.nextActions) assert.match(buyCard.html, new RegExp(action.command.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
});

test('获取结果生成可复用的下一步动作与安全上下文', () => {
  const data = buildRelicFarmPlan({ query: '合成p', matches, sourceMap: {}, bountyChecked: true });
  data.nextActions = buildShortcutNextActions(data, { query: '合成p' });
  const envelope = buildShortcutContextEnvelope(data, { query: '合成p' });
  assert.match(data.nextActions[0].command, /^wm /u);
  assert.equal(envelope.entities[0].type, 'prime-part');
  assert.equal('rows' in envelope, false);
  const card = buildRelicFarmCard(data);
  assert.match(card.html, /下一步/u);
  assert.match(card.html, /wm /u);
});

test('Market Prime 整套提示回到正式获取命令且不携带 Set 后缀', () => {
  const actions = buildShortcutNextActions({ ok: true, kind: 'market', item: { name: 'Revenant Prime Set', zhName: 'Revenant Prime Set' } });
  assert.deepEqual(actions, [{ command: '获取 Revenant Prime', label: '查看获取路线' }]);
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
