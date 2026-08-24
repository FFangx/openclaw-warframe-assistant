import test from 'node:test';
import assert from 'node:assert/strict';
import { executePersonalUseCase } from './personal-usecase.mjs';

function harness(overrides = {}) {
  const calls = [];
  const result = overrides.result || { handled: true, ok: true, command: 'inventory', text: '库存查询完成。', mediaUrl: 'inventory.png' };
  const ports = {
    async execute(request) {
      calls.push(['execute', request.commandId, request.text, request.target, request.actorId, request.personalAllowed]);
      return result;
    },
    log(level, message) { calls.push(['log', level, message]); },
    ...overrides.ports,
  };
  return { calls, ports };
}

const baseRequest = {
  text: '我的库存 悟空p',
  channel: 'qqbot',
  target: 'qqbot:c2c:user-a',
  actorId: 'USER-A',
  actorDisplayName: '用户',
  personalAllowed: true,
  isGroup: false,
};

test('三个快捷入口、模型工具和调度器 fallback 共享相同个人账号用例', async () => {
  const sources = ['before_dispatch', 'inbound_claim', 'before_agent_reply', 'tool-command', 'dispatch-fallback'];
  const snapshots = [];
  for (const source of sources) {
    const { calls, ports } = harness();
    const outcome = await executePersonalUseCase({ ...baseRequest, source }, ports);
    assert.equal(outcome.ok, true, source);
    assert.equal(outcome.commandId, 'account', source);
    snapshots.push(calls);
  }
  for (const calls of snapshots) assert.deepEqual(calls, snapshots[0]);
  assert.deepEqual(snapshots[0], [['execute', 'account', '我的库存 悟空p', 'qqbot:c2c:user-a', 'user-a', true]]);
});

test('共享用例保留注册表中每类个人命令的稳定 commandId', async () => {
  for (const [text, commandId] of [
    ['我的账号', 'account'],
    ['开遗物 单人', 'recommend'],
    ['精炼推荐', 'refine'],
    ['杜卡德 600', 'ducat-plan'],
    ['奸商推荐', 'trader-shopping'],
    ['商店 泰辛', 'shop'],
    ['本周好货', 'weekly-deals'],
    ['轮换日历', 'rotation-calendar'],
    ['紫卡 3', 'rivens'],
  ]) {
    const { ports } = harness();
    const outcome = await executePersonalUseCase({ ...baseRequest, text }, ports);
    assert.equal(outcome.commandId, commandId, text);
    assert.equal(outcome.result.commandId, commandId, text);
  }
});

test('个人账号身份门拒绝群聊、非用户、非 QQ、目标错配与缺发送者', async () => {
  for (const request of [
    { ...baseRequest, personalAllowed: false },
    { ...baseRequest, target: 'qqbot:group:room-a', isGroup: true },
    { ...baseRequest, channel: 'web', target: 'web:user-a' },
    { ...baseRequest, target: 'qqbot:c2c:user-b' },
    { ...baseRequest, actorId: '' },
  ]) {
    const { calls, ports } = harness();
    const outcome = await executePersonalUseCase(request, ports);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.result.kind, 'personal-denied');
    assert.equal(calls.length, 0);
  }
});

test('个人账号执行异常统一为脱敏错误且不回显内部信息', async () => {
  const { calls, ports } = harness({ ports: { async execute() { throw new Error('private snapshot path'); } } });
  const outcome = await executePersonalUseCase(baseRequest, ports);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.result.kind, 'personal-failed');
  assert.equal(outcome.result.text, '个人账号查询暂时失败，请稍后重试。');
  assert.doesNotMatch(outcome.result.text, /private snapshot path/u);
  assert.equal(calls.some((entry) => entry[0] === 'log'), true);
});

test('个人账号模块的明确业务拒绝原样保留', async () => {
  const { ports } = harness({ result: { handled: true, ok: false, command: 'inventory', text: '库存里没有这个物品。' } });
  const outcome = await executePersonalUseCase(baseRequest, ports);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.result.text, '库存里没有这个物品。');
  assert.equal(outcome.result.commandId, 'account');
});

test('非个人命令不会进入 AlecaFrame 执行端口', async () => {
  const { calls, ports } = harness();
  const outcome = await executePersonalUseCase({ ...baseRequest, text: 'wm 悟空p' }, ports);
  assert.equal(outcome.result.kind, 'personal-unparsed');
  assert.equal(calls.length, 0);
});

test('调度器 fallback 只在匹配的可信 QQ 私聊身份下执行刷新帮助', async () => {
  const { dispatchCommand } = await import('./dispatch.mjs');
  const result = await dispatchCommand('刷新账号', {
    personalAllowed: true,
    target: 'qqbot:c2c:user-a',
    owner: 'user-a',
  });
  assert.equal(result.handled, true);
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'refresh-help');
  assert.match(result.text, /AlecaFrame/u);

  const denied = await dispatchCommand('刷新账号', {
    personalAllowed: true,
    target: 'model:public',
    owner: 'user-a',
  });
  assert.equal(denied.kind, 'personal-denied');
  assert.equal(denied.ok, false);
});
