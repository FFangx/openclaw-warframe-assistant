import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWeeklyUseCase } from './weekly-usecase.mjs';

function harness(overrides = {}) {
  const calls = [];
  const result = overrides.result || { ok: true, text: '本周已完成 2/11。', mediaUrl: 'weekly.png' };
  const ports = {
    async manage(request) {
      calls.push(['manage', request.commandId, request.target, request.actorId, request.personalAllowed]);
      return result;
    },
    log(level, message) { calls.push(['log', level, message]); },
    ...overrides.ports,
  };
  return { calls, ports };
}

const baseRequest = {
  text: '完成 1 3',
  channel: 'qqbot',
  target: 'qqbot:c2c:user-a',
  actorId: 'USER-A',
  actorDisplayName: '用户',
  personalAllowed: true,
  isGroup: false,
};

test('三个快捷入口、模型工具和调度器 fallback 共享相同周常用例', async () => {
  const sources = ['before_dispatch', 'inbound_claim', 'before_agent_reply', 'tool-command', 'dispatch-fallback'];
  const snapshots = [];
  for (const source of sources) {
    const { calls, ports } = harness();
    const outcome = await executeWeeklyUseCase({ ...baseRequest, source }, ports);
    assert.equal(outcome.ok, true, source);
    snapshots.push(calls);
  }
  for (const calls of snapshots) assert.deepEqual(calls, snapshots[0]);
  assert.deepEqual(snapshots[0], [['manage', 'weekly', 'qqbot:c2c:user-a', 'user-a', true]]);
});

test('周常身份门拒绝群聊、非用户、非 QQ、非法 target 与缺发送者', async () => {
  for (const request of [
    { ...baseRequest, personalAllowed: false },
    { ...baseRequest, target: 'qqbot:group:room-a', isGroup: true },
    { ...baseRequest, channel: 'web', target: 'web:user-a' },
    { ...baseRequest, target: 'model:public' },
    { ...baseRequest, actorId: '' },
  ]) {
    const { calls, ports } = harness();
    const outcome = await executeWeeklyUseCase(request, ports);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.result.kind, 'weekly-denied');
    assert.equal(calls.length, 0);
  }
});

test('周常执行异常统一为脱敏错误且不回显内部信息', async () => {
  const { calls, ports } = harness({ ports: { async manage() { throw new Error('private path'); } } });
  const outcome = await executeWeeklyUseCase(baseRequest, ports);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.result.kind, 'weekly-failed');
  assert.equal(outcome.result.text, '周常暂时无法查询或更新，请稍后重试。');
  assert.doesNotMatch(outcome.result.text, /private path/u);
  assert.equal(calls.some((entry) => entry[0] === 'log'), true);
});

test('周常模块的明确业务拒绝原样保留', async () => {
  const { calls, ports } = harness({ result: { ok: false, text: '无法识别：未知项目。' } });
  const outcome = await executeWeeklyUseCase(baseRequest, ports);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.result.text, '无法识别：未知项目。');
  assert.deepEqual(calls[0], ['manage', 'weekly', 'qqbot:c2c:user-a', 'user-a', true]);
});

test('调度器 fallback 使用可信私聊身份进入同一周常帮助路径', async () => {
  const { dispatchCommand } = await import('./dispatch.mjs');
  const result = await dispatchCommand('周常帮助', {
    personalAllowed: true,
    target: 'qqbot:c2c:user-a',
    owner: 'user-a',
  });
  assert.equal(result.handled, true);
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'weekly');
  assert.match(result.text, /星际战甲周常命令/u);

  const denied = await dispatchCommand('周常帮助', {
    personalAllowed: true,
    target: 'model:public',
    owner: 'user-a',
  });
  assert.equal(denied.kind, 'weekly-denied');
  assert.equal(denied.ok, false);
});
