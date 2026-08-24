import test from 'node:test';
import assert from 'node:assert/strict';
import { executeSubscriptionUseCase } from './subscription-usecase.mjs';

function harness(overrides = {}) {
  const calls = [];
  const result = overrides.result || {
    handled: true,
    ok: true,
    text: '订阅成功：裂缝',
    cronAction: 'ensure',
    dropsCronAction: 'remove',
  };
  const ports = {
    async manage(request) {
      calls.push(['manage', request.commandId, request.target, request.actorId, request.personalAllowed]);
      return result;
    },
    async syncMonitors(target, actions) { calls.push(['sync', target, actions]); },
    log(level, message) { calls.push(['log', level, message]); },
    ...overrides.ports,
  };
  return { calls, ports };
}

const baseRequest = {
  text: '订阅 裂缝 钢铁',
  channel: 'qqbot',
  target: 'qqbot:c2c:user-a',
  actorId: 'USER-A',
  actorDisplayName: '用户',
  personalAllowed: true,
  isGroup: false,
};

test('三个快捷入口和两条模型工具入口共享相同订阅业务顺序', async () => {
  const sources = ['before_dispatch', 'inbound_claim', 'before_agent_reply', 'tool-command', 'tool-subscription'];
  const snapshots = [];
  for (const source of sources) {
    const { calls, ports } = harness();
    const outcome = await executeSubscriptionUseCase({ ...baseRequest, source }, ports);
    assert.equal(outcome.ok, true, source);
    snapshots.push(calls);
  }
  for (const calls of snapshots) assert.deepEqual(calls, snapshots[0]);
  assert.deepEqual(snapshots[0], [
    ['manage', 'subscription', 'qqbot:c2c:user-a', 'user-a', true],
    ['sync', 'qqbot:c2c:user-a', { world: 'ensure', drops: 'remove' }],
  ]);
});

test('身份门拒绝非 QQ、非法 target 和缺 sender，可信群聊按发送者隔离放行', async () => {
  for (const request of [
    { ...baseRequest, channel: 'web', target: 'web:user-a' },
    { ...baseRequest, target: 'model:public' },
    { ...baseRequest, actorId: '' },
  ]) {
    const { calls, ports } = harness();
    const outcome = await executeSubscriptionUseCase(request, ports);
    assert.equal(outcome.ok, false);
    assert.equal(calls.length, 0);
  }
  const { calls, ports } = harness();
  const outcome = await executeSubscriptionUseCase({
    ...baseRequest,
    target: 'qqbot:group:room-a',
    personalAllowed: false,
    isGroup: true,
  }, ports);
  assert.equal(outcome.ok, true);
  assert.deepEqual(calls[0], ['manage', 'subscription', 'qqbot:group:room-a', 'user-a', false]);
});

test('账本管理失败不触发监测同步，错误保持一致且不泄露异常', async () => {
  const { calls, ports } = harness({
    ports: { async manage() { throw new Error('private path'); } },
  });
  const outcome = await executeSubscriptionUseCase(baseRequest, ports);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.result.error, 'manage_failed');
  assert.equal(outcome.result.text, '订阅暂时无法更新，请稍后重试。');
  assert.equal(calls.some((entry) => entry[0] === 'sync'), false);
});

test('监测同步失败保留账本结果并返回统一降级警告', async () => {
  const { calls, ports } = harness({
    ports: { async syncMonitors() { throw new Error('cron'); } },
  });
  const outcome = await executeSubscriptionUseCase(baseRequest, ports);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.degraded, true);
  assert.match(outcome.result.text, /后台监测任务同步失败/u);
  assert.equal(outcome.warnings.length, 1);
  assert.equal(calls.some((entry) => entry[0] === 'manage'), true);
});

test('脚本明确失败时不尝试创建或删除监测任务', async () => {
  const { calls, ports } = harness({ result: { ok: false, text: '订阅暂时不可用。' } });
  const outcome = await executeSubscriptionUseCase(baseRequest, ports);
  assert.equal(outcome.ok, false);
  assert.equal(calls.some((entry) => entry[0] === 'sync'), false);
});
