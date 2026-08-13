import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidenceEnvelope, STATE_ASSERTION_POLICY } from './evidence.mjs';

test('静态掉落资料不会被标记成当前状态证据', () => {
  const evidence = buildEvidenceEnvelope({ ok: true, source: 'drops' }, 'lookup', 'drops Bladed Rounds');
  assert.equal(evidence.scope, 'static_reference');
  assert.equal(evidence.evidenceType, 'reference');
  assert.notEqual(evidence.finding, 'confirmed_present');
});

test('当前轮明确未命中只证明该范围内不存在', () => {
  const fetchedAt = new Date().toISOString();
  const expiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const evidence = buildEvidenceEnvelope({
    ok: true, kind: 'bounty', facts: {
      type: 'bounty-reward-current-check', currentlyAvailable: false,
      fetchedAt, expiry,
    },
  }, 'command', '赏金 尖刃弹头');
  assert.equal(evidence.scope, 'current_rotation');
  assert.equal(evidence.finding, 'confirmed_absent_in_scope');
  assert.equal(evidence.asOf, fetchedAt);
});

test('通用策略覆盖当前、旧快照和未知范围，而非绑定赏金事件', () => {
  assert.match(STATE_ASSERTION_POLICY, /现在\/当前\/本轮\/今天\/本周/);
  assert.match(STATE_ASSERTION_POLICY, /旧快照/);
  assert.match(STATE_ASSERTION_POLICY, /未覆盖或未知/);
});

test('已经过期的实时结果不能继续证明当前状态', () => {
  const evidence = buildEvidenceEnvelope({
    ok: true, kind: 'bounty', facts: {
      type: 'bounty-reward-current-check', currentlyAvailable: true,
      fetchedAt: '2020-01-01T00:00:00.000Z', expiry: '2020-01-01T01:00:00.000Z',
    },
  }, 'command', '赏金 示例奖励');
  assert.equal(evidence.freshness, 'expired');
  assert.equal(evidence.finding, 'stale_evidence');
});

test('订阅诊断是审计证据而非当前世界状态', () => {
  const evidence = buildEvidenceEnvelope({
    ok: true, kind: 'subscription-diagnosis', facts: {
      type: 'subscription-diagnosis', finding: 'audit_report', checkedAt: '2026-08-13T00:00:00.000Z',
    },
  }, 'subscription_diagnosis', '尖刃弹头');
  assert.equal(evidence.scope, 'subscription_audit');
  assert.equal(evidence.evidenceType, 'local_audit_log');
  assert.equal(evidence.finding, 'audit_report');
});
