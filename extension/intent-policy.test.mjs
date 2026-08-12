import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyNaturalWarframeQuery } from './intent-policy.mjs';

test('订阅历史的多种说法统一进入诊断，不依赖固定句式', () => {
  for (const input of [
    '尖刃弹头的赏金这么久都没轮换到吗',
    '上次提醒以后尖刃弹头又出过吗',
    '第二轮为什么没通知我',
    '这个赏金是不是漏推送了',
    '我订阅的奖励怎么一直没来',
  ]) {
    assert.equal(classifyNaturalWarframeQuery(input).requiredOperation, 'subscription_diagnosis', input);
  }
});

test('静态获取问题不会误走订阅诊断', () => {
  const result = classifyNaturalWarframeQuery('尖刃弹头在哪里掉，概率多少');
  assert.equal(result.subscriptionHistory, false);
  assert.equal(result.staticReferenceSufficient, true);
});

test('当前状态问题即使不是订阅，也禁止仅靠静态资料', () => {
  const result = classifyNaturalWarframeQuery('本轮赏金有尖刃弹头吗');
  assert.equal(result.temporal, true);
  assert.equal(result.staticReferenceSufficient, false);
});
