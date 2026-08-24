import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeWishlistUseCase, wishlistNeedsImmediateInspection } from './wishlist-usecase.mjs';
import { dispatchCommand } from '../skill/scripts/dispatch.mjs';

function harness(overrides = {}) {
  const calls = [];
  const result = overrides.result || { ok: true, kind: 'wishlist', command: 'create', cronAction: 'ensure', mediaUrl: 'card.png' };
  const ports = {
    async manage(request) { calls.push(['manage', request.commandId, request.target, request.actorId]); return result; },
    async syncCron(target, action) { calls.push(['cron', target, action]); },
    async refreshGateway(target) { calls.push(['refresh', target]); },
    async enqueuePrimary(value) { calls.push(['primary', value.command]); return { accepted: true, mediaDelivered: true }; },
    async inspectCurrent(target, value) {
      calls.push(['inspect', target, value.command]);
      return { ok: true, hitCount: 1, marketCards: 1, deliveries: [{ mediaUrl: 'market.png', text: '/w seller' }] };
    },
    async enqueueFollowups(deliveries) { calls.push(['followups', deliveries.map((item) => [item.mediaUrl, item.text])]); },
    log(level, message) { calls.push(['log', level, message]); },
    ...overrides.ports,
  };
  return { calls, ports };
}

const baseRequest = {
  text: '愿望 悟空 Prime 一套 80', channel: 'qqbot', target: 'qqbot:c2c:user-a',
  actorId: 'USER-A', actorDisplayName: '用户', isGroup: false,
};

test('裸入口、两条工具入口与 fallback 共享完全相同的愿望业务顺序', async () => {
  const sources = ['before_dispatch', 'inbound_claim', 'before_agent_reply', 'tool-command', 'tool-subscription'];
  const snapshots = [];
  for (const source of sources) {
    const { calls, ports } = harness();
    const outcome = await executeWishlistUseCase({ ...baseRequest, source }, ports);
    assert.equal(outcome.ok, true, source);
    assert.deepEqual(outcome.currentMarket, { ok: true, hitCount: 1, marketCards: 1 }, source);
    snapshots.push(calls);
  }
  for (const calls of snapshots) assert.deepEqual(calls, snapshots[0]);
  assert.deepEqual(snapshots[0].map((entry) => entry[0]), ['manage', 'cron', 'refresh', 'primary', 'inspect', 'followups']);
});

test('只有建立、批量建立、改价和恢复会在主反馈入队后立即检查行情', async () => {
  for (const action of ['create', 'createMany', 'reprice', 'resume', 'summary', 'pause', 'bought', 'cancel']) {
    const { calls, ports } = harness({ result: { ok: true, command: action, cronAction: action === 'cancel' ? 'remove' : 'ensure' } });
    const outcome = await executeWishlistUseCase(baseRequest, ports);
    assert.equal(calls.some((entry) => entry[0] === 'inspect'), ['create', 'createMany', 'reprice', 'resume'].includes(action), action);
    assert.equal(outcome.action, action);
  }
  assert.equal(wishlistNeedsImmediateInspection({ ok: false, command: 'create' }), false);
});

test('身份门拒绝非 QQ、缺 target 和缺 sender，群聊则按可信 sender 放行', async () => {
  for (const request of [
    { ...baseRequest, channel: 'web', target: 'web:user-a' },
    { ...baseRequest, target: '' },
    { ...baseRequest, actorId: '' },
  ]) {
    const { calls, ports } = harness();
    const outcome = await executeWishlistUseCase(request, ports);
    assert.equal(outcome.ok, false);
    assert.equal(calls.length, 0);
  }
  const { calls, ports } = harness();
  const outcome = await executeWishlistUseCase({ ...baseRequest, target: 'qqbot:group:room-a', isGroup: true }, ports);
  assert.equal(outcome.ok, true);
  assert.deepEqual(calls[0], ['manage', 'wishlist', 'qqbot:group:room-a', 'user-a']);
});

test('manage 失败不编排监控；cron 与行情失败不回滚愿望；主反馈失败不发跟随卡', async () => {
  {
    const { calls, ports } = harness({ ports: { async manage() { throw new Error('boom'); } } });
    const outcome = await executeWishlistUseCase(baseRequest, ports);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.result.text, '愿望单暂时无法更新，请稍后重试。');
    assert.equal(calls.some((entry) => entry[0] === 'cron'), false);
    assert.equal(calls.some((entry) => entry[0] === 'refresh'), false);
    assert.equal(calls.some((entry) => entry[0] === 'inspect'), false);
  }
  {
    const { calls, ports } = harness({ ports: {
      async syncCron() { throw new Error('cron'); },
      async inspectCurrent() { throw new Error('market'); },
    } });
    const outcome = await executeWishlistUseCase(baseRequest, ports);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.warnings.length, 1);
    assert.equal(outcome.currentMarket.retry, 'scheduled_calibration');
    assert.deepEqual(calls.filter((entry) => entry[0] !== 'log').map((entry) => entry[0]), ['manage', 'refresh', 'primary']);
  }
  {
    const { calls, ports } = harness({ ports: { async enqueuePrimary() { throw new Error('qq'); } } });
    const outcome = await executeWishlistUseCase(baseRequest, ports);
    assert.equal(outcome.delivery.accepted, false);
    assert.equal(calls.some((entry) => entry[0] === 'inspect'), false);
  }
  {
    const { calls, ports } = harness({ ports: { async enqueuePrimary() { return { accepted: false, mediaDelivered: false }; } } });
    const outcome = await executeWishlistUseCase(baseRequest, ports);
    assert.equal(outcome.delivery.accepted, false);
    assert.equal(calls.some((entry) => entry[0] === 'inspect'), false);
  }
});

test('dispatch 缺少完整插件编排时明确拒绝且不创建愿望账本', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'warframe-wishlist-dispatch-'));
  const statePath = path.join(dir, 'wishlist.json');
  try {
    const result = await dispatchCommand('愿望 测试物品 20', {
      target: 'qqbot:c2c:user-a', owner: 'user-a', wishlistState: statePath,
    });
    assert.equal(result.handled, true);
    assert.equal(result.ok, false);
    assert.equal(result.kind, 'wishlist-orchestration-required');
    await assert.rejects(access(statePath));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
