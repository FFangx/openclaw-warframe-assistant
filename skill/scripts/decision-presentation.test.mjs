import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCommandRequest, buildFissureDecision, buildRecommendDecision } from './command-request.mjs';
import { formatRecommend, formatRecommendFollowup, recommendView, parseRecommendCommand } from './recommend.mjs';
import { fissureView, formatFissures } from './shortcuts.mjs';
import { buildFissureQueryCard, buildFissureRecommendCard } from './warframe-cards.mjs';

// —— R12 第二片合同：卡片与文字 Presentation 只消费 { decision, facts } ——
// 1) 修改 Decision（了解/候选/顺序/结论/缺价/陈旧证据）会一致驱动卡片与文字；
// 2) 旧 data 中与 Decision 冲突的筛选/候选/结论不影响 Presentation；
// 3) 缺价、陈旧证据、无结果/错误、个人权限降级语义仍正确；
// 4) 入口协议与隐私字段合同不回退（Decision 不携带个人标识/完整工具结果）。

const fetchedAt = '2026-09-08T08:00:00.000Z';
const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();

function allFilters(extra = {}) {
  return { query: '', hardOnly: false, normalOnly: false, speedOnly: false, stormOnly: false, era: null, missions: [], ...extra };
}

function fissureRow(id, { tier = 'Lith', mission = '捕获', node = 'Hepit', planet = '地球', hard = false, storm = false, recommendation = null, tags = [] } = {}) {
  return { id, tier, mission, missionType: mission, node, planet, faction: 'Corpus', hard, storm, expiry: future, tags, recommendation };
}

function fissureResult({ filters = allFilters(), rows, freshness = 'fresh', scope = 'public', ok = true, facts = {} } = {}) {
  const decision = buildFissureDecision({ filters, rows, evidence: { source: 'api.warframe.com', scope: 'worldstate', freshness }, scope, ok });
  return fissureView({ decision, fetchedAt, personalized: facts.personalized, recommendationModeZh: facts.recommendationModeZh || null, recommendationValuationIncompleteCount: facts.recommendationValuationIncompleteCount || 0, nextActions: [], ...facts });
}

test('修改裂缝 Decision 会一致改变卡片与文字（候选顺序与筛选标题）', () => {
  const rowA = fissureRow('a', { tier: 'Lith', mission: '捕获', node: 'Hepit', planet: '地球' });
  const rowB = fissureRow('b', { tier: 'Axi', mission: '前哨战', node: 'Veil Node', planet: '面纱比邻星', storm: true, tags: [{ key: 'bonus', zh: '额外收益' }] });
  const baseline = fissureResult({ rows: [rowA, rowB] });
  const reversed = fissureResult({ rows: [rowB, rowA] });
  const baselineText = formatFissures(baseline);
  const reversedText = formatFissures(reversed);
  const baselineCard = buildFissureQueryCard(baseline).html;
  const reversedCard = buildFissureQueryCard(reversed).html;

  // 候选顺序：卡片行序与文字行序同时翻转。
  assert.ok(baselineCard.indexOf('地球') < baselineCard.indexOf('面纱比邻星'));
  assert.ok(reversedCard.indexOf('面纱比邻星') < reversedCard.indexOf('地球'));
  assert.ok(baselineText.indexOf('Hepit') < baselineText.indexOf('Veil Node'));
  assert.ok(reversedText.indexOf('Veil Node') < reversedText.indexOf('Hepit'));
  assert.match(baselineText, /^当前裂缝：2 条/mu);
  assert.match(baselineText, /额外收益/u);

  // 筛选标题：Decision.understanding 的 era/筛选旗标驱动卡片标题。
  const filtered = fissureResult({ filters: allFilters({ query: '后纪 钢铁', era: 'Axi', hardOnly: true }), rows: [fissureRow('c', { tier: 'Axi', hard: true, mission: '歼灭', node: '采矿平台', planet: '火卫一' })] });
  assert.match(buildFissureQueryCard(filtered).html, /后纪钢铁虚空裂缝/u);
  assert.match(formatFissures(filtered), /钢铁 · 后纪 歼灭/u);

  // 结论等级：改成 insufficient 后文字走「无结果」分支（卡片不应再展示列表）。
  const empty = fissureResult({ rows: [], ok: false, facts: { error: 'no_matches', userError: { nextSteps: ['开遗物', '裂缝（去掉筛选）'] } } });
  assert.match(formatFissures(empty), /^当前没有符合“裂缝”的活动裂缝。/u);
});

test('修改开遗物 Decision 会一致改变卡片与文字（模式与候选顺序）', () => {
  const baseRow = (id, relicZh, price) => ({
    id, relicBase: 'Lith ' + id, relicZh, count: 2, relicVaulted: false, tier: 'Lith', missionZh: '捕获',
    node: 'Hepit', planet: '地球', hard: false, storm: false, tags: [{ key: 'speed', zh: '速刷' }],
    expiry: future, expectedValue: price, expectedDucats: 20, priceReliable: true,
    refineZh: '光辉', targetEconomy: null, topReward: { zhName: '稀有奖励', price }, topDucat: { zhName: '高杜奖励', ducats: 20 },
  });
  const rowA = baseRow('a', '古纪 T1', 50);
  const rowB = baseRow('b', '古纪 T2', 40);
  const understanding = parseRecommendCommand('').understanding;
  const viewOf = (candidates, mode = 'plat') => ({
    decision: { commandId: 'recommend', scope: 'userPrivate', understanding: { ...understanding, mode }, candidates, conclusion: 'confirmed', evidence: {} },
    facts: { fetchedAt, squad: 4, matchedRelicCount: 2, totalFissures: 3, ducatGoal: null, requiem: null, strategySync: null, error: null, userError: null, unsupported: [], issues: [] },
  });

  const baseline = viewOf([rowA, rowB]);
  const reversed = viewOf([rowB, rowA]);
  const baselineText = formatRecommend(baseline);
  const reversedText = formatRecommend(reversed);
  const baselineCard = buildFissureRecommendCard(baseline).html;
  const reversedCard = buildFissureRecommendCard(reversed).html;
  assert.ok(baselineCard.indexOf('古纪 T1') < baselineCard.indexOf('古纪 T2'));
  assert.ok(reversedCard.indexOf('古纪 T2') < reversedCard.indexOf('古纪 T1'));
  assert.ok(baselineText.indexOf('古纪 T1') < baselineText.indexOf('古纪 T2'));
  assert.ok(reversedText.indexOf('古纪 T2') < reversedText.indexOf('古纪 T1'));
  assert.match(baselineText, /^🎯 开遗物 · 赚白金 · 全部裂缝/u);

  // 模式（understanding.mode）驱动标题/口径行：白金 vs 杜卡德。
  const ducat = viewOf([rowA], 'ducat');
  assert.match(buildFissureRecommendCard(ducat).html, /现在换杜卡德开什么最赚/u);
  assert.match(formatRecommend(ducat), /· 赚杜卡德 ·/u);
  assert.match(formatRecommendFollowup(ducat), /当前为普通杜卡德/u);

  // 结论等级：改成 insufficient 后文字回退错误分支，不再渲染「可立即开」。
  const insufficient = { ...baseline, decision: { ...baseline.decision, conclusion: 'insufficient' }, facts: { ...baseline.facts, error: 'no_match', userError: { nextSteps: ['开遗物（放宽筛选）'] } } };
  assert.match(formatRecommend(insufficient), /当前没有能配上你库存遗物的裂缝/u);
});

test('旧 data 与 Decision 冲突时，裂缝卡片与文字只信 Decision', () => {
  const rowA = fissureRow('a', { mission: '歼灭', node: '采矿平台', planet: '火卫一', tags: [{ key: 'speed', zh: '速刷' }] });
  const view = fissureView({
    // 旧 data 里塞满与 Decision 冲突的筛选/标题/候选/计数。
    filters: { query: '钢铁 后纪 冲突', hardOnly: true, normalOnly: false, speedOnly: false, stormOnly: false, era: 'Axi', missions: ['Defense'] },
    title: '冲突标题·钢铁后纪',
    normal: [{ id: 'polluted', tier: 'Meso', mission: '污染任务', node: 'Polluted', planet: '火星', hard: false }],
    hard: [{ id: 'polluted-hard', tier: 'Requiem', mission: '污染钢铁', node: 'Polluted-P', planet: '阋神星', hard: true }],
    normalTotal: 8, hardTotal: 7, total: 99,
    ok: false,
    fetchedAt,
    decision: buildFissureDecision({
      filters: allFilters({ query: '全部' }),
      rows: [rowA],
      evidence: { source: 'api.warframe.com', scope: 'worldstate', freshness: 'fresh' },
      ok: true,
    }),
  });
  const card = buildFissureQueryCard(view).html;
  const text = formatFissures(view);
  assert.match(card, /当前虚空裂缝/u);           // 标题来自 Decision.understanding，而非 data.title
  assert.doesNotMatch(card, /冲突标题|钢铁后纪/u);
  assert.match(card, /采矿平台/u);               // 行来自 Decision.candidates
  assert.ok(!card.includes('polluted'));
  assert.match(text, /^当前裂缝：1 条/mu);
  assert.match(text, /采矿平台/u);
  assert.doesNotMatch(text, /污染任务|冲突/u);
});

test('旧 data 与 Decision 冲突时，开遗物卡片与文字只信 Decision', () => {
  const row = {
    id: 'r1', relicBase: 'Lith T1', relicZh: '古纪 T1', count: 3, relicVaulted: false, tier: 'Lith',
    missionZh: '歼灭', node: 'Paimon', planet: '火星', hard: false, storm: false, tags: [],
    expiry: future, expectedValue: 25, expectedDucats: 33, priceReliable: true, refineZh: '无瑕',
    targetEconomy: null, topReward: { zhName: '稀有奖励', price: 25 }, topDucat: { zhName: '杜卡德奖励', ducats: 33 },
  };
  const understanding = parseRecommendCommand('').understanding;
  const view = recommendView({
    // 旧 data 冲突：杜卡德模式、不同的行、不同的计数与成功标志。
    ok: false, error: 'no_steel_fissures', mode: 'ducat', preference: 'yield', fissureScope: 'steel',
    vaultFilter: 'all', squad: 1, matchedRelicCount: 9, totalFissures: 42, valuationIncompleteCount: 5,
    rows: [{ id: 'polluted', relic: { zh: '污染遗物', count: 1, vaulted: true }, expectedValue: 1, expectedDucats: 1, valuation: { priceReliable: true } }],
    understanding: '开遗物 · 赚杜卡德 · 仅钢铁 · 收益 · 单人',
    fetchedAt,
    decision: {
      commandId: 'recommend', scope: 'userPrivate',
      understanding: { ...understanding, mode: 'plat' },
      candidates: [row], conclusion: 'confirmed', evidence: {},
    },
  });
  const card = buildFissureRecommendCard(view).html;
  const text = formatRecommend(view);
  assert.match(card, /现在开什么遗物最值/u);       // 白金模式，而非旧 data 的赚杜卡德
  assert.match(card, /古纪 T1/u);
  assert.ok(!card.includes('污染遗物'));
  assert.match(text, /^🎯 开遗物 · 赚白金/u);
  assert.match(text, /古纪 T1/u);
  assert.doesNotMatch(text, /污染遗物|赚杜卡德/u);
});

test('缺价语义仍正确：候选 priceReliable=false 驱动卡片与文字的一致性提示', () => {
  const row = {
    id: 'r1', relicBase: 'Axi T1', relicZh: '后纪 T1', count: 3, relicVaulted: false, tier: 'Axi',
    missionZh: '前哨战', node: 'Veil Node', planet: '面纱比邻星', hard: false, storm: true, tags: [],
    expiry: future, expectedValue: null, expectedDucats: 42, priceReliable: false, refineZh: null,
    targetEconomy: null, topReward: { zhName: '稀有奖励', price: 30 }, topDucat: { zhName: '杜卡德奖励', ducats: 42 },
  };
  const view = recommendView({
    ok: true, perspective: 'fissure', mode: 'plat', preference: 'balanced', fissureScope: 'storm',
    vaultFilter: 'all', squad: 4, matchedRelicCount: 1, totalFissures: 1, valuationIncompleteCount: 1,
    rows: [row], fetchedAt,
    decision: {
      commandId: 'recommend', scope: 'userPrivate',
      understanding: parseRecommendCommand('').understanding,
      candidates: [row], conclusion: 'inferred',
      evidence: { worldState: null, priceTable: null, localDb: null },
    },
  });
  const card = buildFissureRecommendCard(view).html;
  const text = formatRecommend(view);
  // 缺价不能在卡片或文字里伪装成 0/null 估值。
  assert.match(card, /白金估值暂缺/u);
  assert.match(card, /已按杜卡德兜底/u);
  assert.doesNotMatch(card, /null|undefined/u);
  assert.match(text, /白金估值暂缺/u);
  assert.doesNotMatch(text, /null|undefined|期望 [0-9]+ 白金/u);
});

test('陈旧证据语义仍正确：Decision.evidence 驱动离线快照提示（卡片与文字同源）', () => {
  const staleAt = '2026-09-08T06:00:00.000Z';
  const row = {
    id: 'r1', relicBase: 'Lith T1', relicZh: '古纪 T1', count: 1, relicVaulted: true, tier: 'Lith',
    missionZh: '捕获', node: 'Hepit', planet: '地球', hard: false, storm: false, tags: [],
    expiry: future, expectedValue: 10, expectedDucats: 15, priceReliable: true, refineZh: null,
    targetEconomy: null, topReward: { zhName: '奖励', price: 10 }, topDucat: { zhName: '杜', ducats: 15 },
  };
  const understanding = parseRecommendCommand('').understanding;
  const viewOf = (priceTable) => recommendView({
    ok: true, mode: 'plat', preference: 'balanced', fissureScope: 'all', vaultFilter: 'all', squad: 4,
    matchedRelicCount: 1, totalFissures: 1, rows: [row], fetchedAt,
    decision: {
      commandId: 'recommend', scope: 'userPrivate', understanding, candidates: [row],
      conclusion: priceTable?.stale ? 'inferred' : 'confirmed',
      evidence: { worldState: null, priceTable, localDb: null },
    },
  });
  const staleText = formatRecommend(viewOf({ source: 'warframe.market', scope: 'market-price-table', stale: true, cachedAt: staleAt }));
  const freshText = formatRecommend(viewOf({ source: 'warframe.market', scope: 'market-price-table', stale: false, cachedAt: null }));
  assert.match(staleText, /⚠ warframe\.market 暂不可用，价格为 .* 离线快照/u);
  assert.doesNotMatch(freshText, /离线快照/u);

  // 裂缝侧：陈旧证据由 Decision.evidence.facts.freshness 标注，同源驱动文字来源行。
  const staleFissure = fissureResult({ rows: [fissureRow('s')], freshness: 'stale-cache' });
  const freshFissure = fissureResult({ rows: [fissureRow('f')], freshness: 'fresh' });
  assert.match(formatFissures(staleFissure), /来源：世界状态（缓存快照）/u);
  assert.match(formatFissures(freshFissure), /来源：世界状态 ·/u);
});

test('无结果/错误语义仍正确：insufficient 配合 facts 分类且结论驱动文字', () => {
  const noMatch = fissureResult({
    rows: [], ok: false, facts: { error: 'no_matches', userError: { nextSteps: ['开遗物', '裂缝（去掉筛选）', '帮助 裂缝'] } },
    filters: allFilters({ query: '九重天', stormOnly: true }),
  });
  assert.match(formatFissures(noMatch), /当前没有符合“九重天”的活动裂缝。/u);
  assert.match(formatFissures(noMatch), /下一步：开遗物｜裂缝（去掉筛选）｜帮助 裂缝/u);

  const unavailable = fissureResult({
    rows: [], ok: false,
    facts: { error: 'source_unavailable', userError: { code: 'source_unavailable', retryable: true, httpStatus: 403, retryHint: '15 分钟', nextSteps: ['裂缝 九重天（稍后重试）'] } },
    filters: allFilters({ query: '九重天', stormOnly: true }),
  });
  assert.match(formatFissures(unavailable), /当前无法取得“九重天”裂缝的最新世界状态。/u);
  assert.match(formatFissures(unavailable), /15 分钟/u);
  assert.doesNotMatch(formatFissures(unavailable), /当前裂缝：/u);
});

test('个人权限降级仍正确：scope=personal 但增强未运行时按公开降级展示', () => {
  const row = fissureRow('p', { recommendation: { relic: { base: 'Lith T1', zh: '古纪 T1', count: 7, vaulted: true }, expectedValue: 12, expectedDucats: 40, refineZh: '无瑕', valuation: { priceReliable: true } } });
  // 增强成功（personalized=true）：卡片展示库存推荐。
  const enhanced = fissureResult({ rows: [row], scope: 'personal', facts: { personalized: true, recommendationModeZh: '白金' } });
  const enhancedCard = buildFissureQueryCard(enhanced).html;
  assert.match(enhancedCard, /库存推荐 · 白金/u);
  assert.match(enhancedCard, /推荐 古纪 T1/u);
  assert.match(formatFissures(enhanced), /推荐 古纪 T1/u);

  // 增强失败降级（personalized=false）：同一 Decision scope 是 personal，但展示必须退回公开语义，
  // 不得泄露/暗示库存内容。
  const downgraded = fissureResult({ rows: [fissureRow('p')], scope: 'personal', facts: { personalized: false } });
  const downgradedCard = buildFissureQueryCard(downgraded).html;
  assert.match(downgradedCard, /公开任务/u);
  assert.doesNotMatch(downgradedCard, /库存推荐|推荐 古纪 T1/u);
  assert.doesNotMatch(formatFissures(downgraded), /推荐 古纪 T1/u);

  // 纯公开（scope=public, personalized=false）：行为一致。
  const publicView = fissureResult({ rows: [row], scope: 'public', facts: { personalized: false } });
  assert.match(buildFissureQueryCard(publicView).html, /公开任务/u);
});

test('Decision 与视图不携带个人标识或完整工具结果，入口协议字段合同不回退', async () => {
  // 候选投影面向渲染：多余的原始字段被剥掉。
  const pollutedRow = {
    id: 'x1', tier: 'Axi', missionType: 'Skirmish', mission: '前哨战', node: 'Veil Node', planet: '面纱比邻星',
    faction: 'Corpus', hard: false, storm: true, tags: [{ key: 'bonus', zh: '额外收益' }], expiry: future,
    userId: 'qqbot:c2c:secret-user', rawSnapshot: { secret: 1 }, fullToolResult: ['secret payload'],
    recommendation: { relic: { base: 'Axi T1', zh: '后纪 T1', count: 3, vaulted: false }, expectedValue: 10, expectedDucats: 20, refineZh: null, valuation: { priceReliable: true } },
  };
  const decision = buildFissureDecision({
    filters: allFilters({ query: '九重天', stormOnly: true }), rows: [pollutedRow],
    evidence: { source: 'api.warframe.com', scope: 'worldstate', freshness: 'fresh' }, scope: 'public', ok: true,
  });
  assert.deepEqual(Object.keys(decision).sort(), ['candidates', 'commandId', 'conclusion', 'evidence', 'scope', 'understanding']);
  const serialized = JSON.stringify(decision);
  assert.doesNotMatch(serialized, /secret-user|rawSnapshot|fullToolResult|secret payload/u);
  assert.deepEqual(Object.keys(decision.candidates[0]).sort(), [
    'expiry', 'faction', 'hard', 'hasRecommendation', 'id', 'mission', 'missionType', 'node',
    'planet', 'priceReliable', 'recommendation', 'storm', 'tags', 'tier',
  ]);
  assert.equal(decision.candidates[0].recommendation, null);

  const personalDecision = buildFissureDecision({
    filters: allFilters(), rows: [pollutedRow], evidence: { freshness: 'fresh' }, scope: 'personal', ok: true,
  });
  assert.equal(personalDecision.candidates[0].recommendation.relic.base, 'Axi T1');
  const changedRelicDecision = structuredClone(personalDecision);
  changedRelicDecision.candidates[0].recommendation.relic.base = 'Axi T2';
  assert.notEqual(
    buildFissureQueryCard(fissureView({ decision: personalDecision, fetchedAt, recommendationModeZh: '白金' })).key,
    buildFissureQueryCard(fissureView({ decision: changedRelicDecision, fetchedAt, recommendationModeZh: '白金' })).key,
  );

  // 视图 facts 也仅白名单字段；入口 CommandRequest 仍是严格四字段 + 允许来源。
  const view = fissureView({ decision, userId: 'qqbot:c2c:secret-user', fetchedAt, personalized: false });
  assert.doesNotMatch(JSON.stringify(view), /secret-user/u);

  const request = await buildCommandRequest({ matched: { commandId: 'fissure', query: '九重天' }, source: 'tool-command' });
  assert.deepEqual(Object.keys(request).sort(), ['args', 'commandId', 'privacyScope', 'source']);
  assert.equal(request.privacyScope, 'public');
  assert.equal(request.args.stormOnly, true);

  const recommendRequest = await buildCommandRequest({ matched: { commandId: 'recommend', query: '单人 九重天' }, source: 'before_dispatch' });
  assert.deepEqual(Object.keys(recommendRequest).sort(), ['args', 'commandId', 'privacyScope', 'source']);
  assert.equal(recommendRequest.privacyScope, 'userPrivate');
});
