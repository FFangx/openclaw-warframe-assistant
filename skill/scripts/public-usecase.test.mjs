import test from 'node:test';
import assert from 'node:assert/strict';
import { executePublicUseCase } from './public-usecase.mjs';

const base = { channel: 'qqbot', target: 'qqbot:c2c:user-a', actorId: 'user-a', personalAllowed: true, isGroup: false };
function ports(calls, result = { handled: true, ok: true, text: 'ok' }) {
  return {
    queryArbitration: async (c) => (calls.push(['arbitration', c.commandId, c.personalAllowed]), result),
    queryIntel: async (c) => (calls.push(['intel', c.commandId, c.intelType, c.personalAllowed]), result),
    runPersonalTrader: async (c) => (calls.push(['trader-personal', c.commandId, c.personalAllowed]), result),
    runShortcut: async (c) => (calls.push(['shortcut', c.commandId, c.personalAllowed]), result),
    log: (level, message) => calls.push(['log', level, message]),
  };
}

test('五个入口共享公开命令分类与执行序列', async () => {
  for (const text of ['仲裁', '警报', 'wm 悟空p']) {
    const snapshots = [];
    for (const source of ['before_dispatch', 'inbound_claim', 'before_agent_reply', 'tool-command', 'dispatch-fallback']) {
      const calls = [];
      const outcome = await executePublicUseCase({ ...base, source, text }, ports(calls));
      assert.equal(outcome.ok, true);
      snapshots.push(calls);
    }
    for (const calls of snapshots) assert.deepEqual(calls, snapshots[0]);
  }
});

test('全部公开命令族保留注册表中的稳定 commandId', async () => {
  const cases = [
    ['帮助', 'help'],
    ['wm 悟空p', 'market'],
    ['遗物 前x1', 'relic'],
    ['获取 悟空Prime蓝图', 'relic-farm'],
    ['普通裂缝', 'fissure'],
    ['仲裁', 'arbitration'],
    ['警报', 'alert'],
    ['入侵', 'invasion'],
    ['活动', 'event'],
    ['突击', 'sortie'],
    ['钢铁侵袭', 'incursion'],
    ['赏金 火卫二', 'bounty'],
    ['虚空商人', 'trader'],
    ['购买 裂罅破解器', 'where-to-buy'],
  ];
  for (const [text, commandId] of cases) {
    const calls = [];
    const outcome = await executePublicUseCase({ ...base, text, personalAllowed: false }, ports(calls));
    assert.equal(outcome.commandId, commandId, text);
    assert.equal(outcome.result.commandId, commandId, text);
    assert.equal(outcome.ok, true, text);
  }
});

test('公开命令只在完整可信私聊身份下启用个人增强', async () => {
  const trusted = [];
  await executePublicUseCase({ ...base, text: '虚空商人' }, ports(trusted));
  assert.deepEqual(trusted[0], ['trader-personal', 'trader', true]);
  for (const request of [
    { ...base, text: '虚空商人', personalAllowed: false },
    { ...base, text: '虚空商人', target: 'qqbot:c2c:user-b' },
    { ...base, text: '虚空商人', isGroup: true },
    { ...base, text: '虚空商人', channel: 'web' },
  ]) {
    const calls = [];
    await executePublicUseCase(request, ports(calls));
    assert.deepEqual(calls[0], ['intel', 'trader', 'trader', false]);
  }
});

test('通用公开短命令收到调用级个人增强且不依赖全局环境', async () => {
  const calls = [];
  await executePublicUseCase({ ...base, text: '普通裂缝' }, ports(calls));
  assert.deepEqual(calls[0], ['shortcut', 'fissure', true]);
});

test('公开执行异常统一脱敏，非公开命令不进入端口', async () => {
  const calls = [];
  const failing = ports(calls);
  failing.runShortcut = async () => { throw new Error('private path'); };
  const failed = await executePublicUseCase({ ...base, text: 'wm 悟空p' }, failing);
  assert.equal(failed.result.kind, 'public-failed');
  assert.doesNotMatch(failed.result.text, /private path/u);
  const unparsed = await executePublicUseCase({ ...base, text: '我的账号' }, ports(calls));
  assert.equal(unparsed.result.kind, 'public-unparsed');
});
