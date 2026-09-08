import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertCommandRequest,
  buildCommandRequest,
  buildFissureDecision,
  buildRecommendDecision,
  decodeCommandRequestString,
  deriveRecommendRequestFromFissure,
  encodeCommandRequest,
} from './command-request.mjs';
import { executePersonalUseCase } from './personal-usecase.mjs';
import { executePublicUseCase } from './public-usecase.mjs';
import { runShortcut } from './shortcuts.mjs';
import { runAlecaMessage } from './alecaframe.mjs';

const sources = ['before_dispatch', 'inbound_claim', 'before_agent_reply', 'fast-command', 'tool-command', 'dispatch-fallback'];
const identity = {
  channel: 'qqbot', target: 'qqbot:c2c:user-a', actorId: 'user-a',
  personalAllowed: true, isGroup: false,
};

test('裂缝与开遗物在共享用例边界生成四字段 CommandRequest，所有入口等价', async () => {
  const fissureRequests = [];
  const recommendRequests = [];
  for (const source of sources) {
    await executePublicUseCase({ ...identity, source, text: '裂缝 九重天' }, {
      runShortcut: async (command) => {
        fissureRequests.push(command.request);
        return { handled: true, ok: true, text: 'ok' };
      },
    });
    await executePersonalUseCase({ ...identity, source, text: '开遗物 单人 九重天' }, {
      execute: async (command) => {
        recommendRequests.push(command.request);
        return { handled: true, ok: true, text: 'ok' };
      },
    });
  }
  for (const request of fissureRequests) {
    assert.deepEqual(Object.keys(request).sort(), ['args', 'commandId', 'privacyScope', 'source']);
    assert.equal(request.commandId, 'fissure');
    assert.equal(request.privacyScope, 'public');
    assert.equal(request.args.stormOnly, true);
  }
  for (const request of recommendRequests) {
    assert.equal(request.commandId, 'recommend');
    assert.equal(request.privacyScope, 'userPrivate');
    assert.equal(request.args.squad, 1);
    assert.equal(request.args.fissureScope, 'storm');
  }
  assert.deepEqual(fissureRequests.map(({ source: _, ...request }) => request), fissureRequests.map(({ source: _, ...request }) => request)[0] ? Array(fissureRequests.length).fill(fissureRequests.map(({ source: _, ...request }) => request)[0]) : []);
  assert.deepEqual(recommendRequests.map(({ source: _, ...request }) => request), recommendRequests.map(({ source: _, ...request }) => request)[0] ? Array(recommendRequests.length).fill(recommendRequests.map(({ source: _, ...request }) => request)[0]) : []);
});

test('协议拒绝隐私字段走私、嵌套未知键、错误 scope、未知来源和超限负载', async () => {
  const request = await buildCommandRequest({
    matched: { commandId: 'recommend', query: '单人 九重天' }, source: 'tool-command',
  });
  for (const invalid of [
    { ...request, target: 'qqbot:c2c:secret' },
    { ...request, privacyScope: 'public' },
    { ...request, source: 'invented-adapter' },
    { ...request, args: { ...request.args, traderTarget: { ...request.args.traderTarget, sender: 'secret' } } },
  ]) assert.throws(() => assertCommandRequest(invalid), /invalid command request/u);
  assert.throws(() => decodeCommandRequestString(`{"schemaVersion":1,"padding":"${'x'.repeat(9000)}"}`), /byte budget/u);
});

test('编码往返保留语义，未知版本不回退文本重解析', async () => {
  const request = await buildCommandRequest({
    matched: { commandId: 'fissure', query: '钢铁 生存' }, source: 'dispatch-fallback',
  });
  assert.deepEqual(decodeCommandRequestString(encodeCommandRequest(request)), request);
  assert.throws(() => decodeCommandRequestString(JSON.stringify({ ...JSON.parse(encodeCommandRequest(request)), schemaVersion: 2 })), /schemaVersion/u);
  const ducat = await buildCommandRequest({
    matched: { commandId: 'recommend', query: '杜卡德' }, source: 'tool-command',
  });
  assert.equal(ducat.args.traderTarget.type, 'ordinary');
  await assert.rejects(() => runShortcut('裂缝', { request: ducat }), /not supported by this executor/u);
  await assert.rejects(() => runAlecaMessage('开遗物', { request }), /not supported by this executor/u);
});

test('执行端优先消费结构化裂缝参数，不重新解析被污染的原文', async () => {
  const request = await buildCommandRequest({
    matched: { commandId: 'fissure', query: '九重天' }, source: 'tool-command',
  });
  const expiry = new Date(Date.now() + 60 * 60_000).toISOString();
  const result = await runShortcut('wm 这段原文绝不能重新路由', {
    request,
    worldState: {
      timestamp: new Date().toISOString(),
      _dataSource: 'api.warframe.com',
      fissures: [{
        id: 'storm-1', tier: 'Axi', missionType: 'Skirmish', enemy: 'Corpus',
        node: 'Veil Node (Veil Proxima)', expiry, expired: false, isStorm: true,
      }],
    },
    renderCard: async () => 'structured.png',
  });
  assert.equal(result.command, 'fissure');
  assert.equal(result.data.filters.stormOnly, true);
  assert.equal(result.data.decision.understanding.query, '九重天');
  assert.equal(result.mediaUrl, 'structured.png');
});

test('裂缝私聊增强只能从结构化筛选派生，不能携带身份或原文', async () => {
  const fissure = await buildCommandRequest({
    matched: { commandId: 'fissure', query: '后纪 九重天 速刷' }, source: 'fast-command',
  });
  const recommendation = deriveRecommendRequestFromFissure(fissure);
  assert.equal(recommendation.commandId, 'recommend');
  assert.equal(recommendation.args.fissureScope, 'storm');
  assert.equal(recommendation.args.tierFilter, 'Axi');
  assert.equal(recommendation.args.preference, 'speed');
  assert.equal(JSON.stringify(recommendation).includes('后纪 九重天'), false);

  const mission = await buildCommandRequest({
    matched: { commandId: 'fissure', query: '生存' }, source: 'fast-command',
  });
  assert.equal(deriveRecommendRequestFromFissure(mission), null);
});

test('Decision 只暴露理解、候选、结论和证据，并区分陈旧与缺价', () => {
  const fissure = buildFissureDecision({
    filters: { query: '九重天' }, rows: [{ id: 'f1', tier: 'Axi' }],
    evidence: { source: 'cache', freshness: 'stale-cache', fetchedAt: '2026-09-08T00:00:00.000Z' },
  });
  assert.deepEqual(Object.keys(fissure).sort(), ['candidates', 'commandId', 'conclusion', 'evidence', 'scope', 'understanding']);
  assert.equal(fissure.conclusion, 'inferred');

  const recommend = buildRecommendDecision({
    parsed: { understanding: { mode: 'plat' } },
    data: {
      ok: true,
      rows: [{ relic: { base: 'Axi A1', zh: '后纪 A1', count: 1 }, valuation: { priceReliable: false } }],
      decisionEvidence: { priceTable: { stale: true } },
    },
  });
  assert.equal(recommend.conclusion, 'inferred');
  assert.equal(recommend.candidates[0].priceReliable, false);
  assert.equal(recommend.evidence.priceTable.stale, true);
});

test('个人身份拒绝发生在 CommandRequest 建立之前', async () => {
  let called = false;
  const outcome = await executePersonalUseCase({
    ...identity, source: 'tool-command', text: '开遗物 单人', isGroup: true,
  }, { execute: async () => { called = true; } });
  assert.equal(outcome.result.kind, 'personal-denied');
  assert.equal(called, false);
});
