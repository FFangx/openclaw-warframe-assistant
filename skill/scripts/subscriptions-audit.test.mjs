import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendFreshMatches, currentNotificationMatches, diagnoseSubscriptions, manageCommand } from './subscriptions.mjs';

async function fixture(ledger, run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-sub-audit-'));
  const state = path.join(dir, 'ledger.json');
  await writeFile(state, JSON.stringify(ledger), 'utf8');
  try { return await run(state); } finally { await rm(dir, { recursive: true, force: true }); }
}

const context = { target: 'qqbot:c2c:user', ownerId: 'user' };

test('诊断按自然语言中的订阅条件找到对应流水', async () => fixture({
  version: 2, subscriptions: [{
    id: 'sub1', target: context.target, ownerId: context.ownerId, type: 'bounty', filter: '尖刃弹头',
    enabled: true, initialized: true, seen: ['bounty:first'], createdAt: '2026-08-12T00:00:00.000Z',
  }], schedules: {}, audit: [
    { subscriptionId: 'sub1', checkedAt: '2026-08-12T01:00:00.000Z', sourceStatus: 'available', snapshotId: 'a', matchCount: 1, newMatchCount: 1, outcome: 'notification_prepared' },
    { subscriptionId: 'sub1', checkedAt: '2026-08-12T03:30:00.000Z', sourceStatus: 'available', snapshotId: 'b', matchCount: 0, newMatchCount: 0, outcome: 'no_match' },
    { subscriptionId: 'sub1', checkedAt: '2026-08-12T06:00:00.000Z', sourceStatus: 'unavailable', snapshotId: 'c', matchCount: 0, newMatchCount: 0, outcome: 'source_unavailable', error: '403' },
  ],
}, async (state) => {
  const result = await diagnoseSubscriptions(state, context, '尖刃弹头这么久没轮换到吗');
  assert.equal(result.found, true);
  assert.equal(result.reports[0].notificationsPrepared, 1);
  assert.equal(result.reports[0].checksAfterLastNotification, 2);
  assert.equal(result.reports[0].matchesAfterLastNotification, 0);
  assert.equal(result.reports[0].sourceFailuresAfterLastNotification, 1);
}));

test('旧订阅没有审计时明确说明不可追溯，不拿 seen 猜历史', async () => fixture({
  version: 1, subscriptions: [{
    id: 'old', target: context.target, ownerId: context.ownerId, type: 'bounty', filter: '测试奖励',
    enabled: true, initialized: true, seen: ['legacy'], createdAt: '2026-08-01T00:00:00.000Z',
  }], schedules: {},
}, async (state) => {
  const result = await diagnoseSubscriptions(state, context, '测试奖励');
  assert.equal(result.reports[0].checks, 0);
  assert.match(result.text, /旧版尚未留下逐轮审计/);
}));

test('用户新建赏金订阅会标记首次当前命中需要提醒', async () => fixture({
  version: 2, subscriptions: [], schedules: {}, audit: [],
}, async (state) => {
  const result = await manageCommand('订阅 赏金 尖刃弹头', context, state);
  const ledger = JSON.parse(await readFile(state, 'utf8'));
  assert.equal(result.ok, true);
  assert.match(result.text, /首次监测若当前已经命中会立即提醒/);
  assert.equal(ledger.subscriptions[0].initialized, false);
  assert.equal(ledger.subscriptions[0].notifyInitial, true);
}));

test('自动种下的默认订阅仍保持首次静默基线', async () => fixture({
  version: 2, subscriptions: [], schedules: {}, audit: [],
}, async (state) => {
  const { seedDefaults } = await import('./subscriptions.mjs');
  await seedDefaults(context, state);
  const ledger = JSON.parse(await readFile(state, 'utf8'));
  assert.equal(ledger.subscriptions.length, 4);
  assert.ok(ledger.subscriptions.every((item) => item.notifyInitial === false));
}));

test('首次命中立即提醒且已见事件不会重复提醒', () => {
  const current = [{ id: 'bounty:current' }];
  const subscription = { id: 'new', type: 'bounty', filter: '尖刃弹头', ownerId: 'user', initialized: false, notifyInitial: true };
  const initial = currentNotificationMatches(subscription, current);
  const freshById = appendFreshMatches(new Map(), subscription, initial);
  assert.deepEqual(initial, current);
  assert.equal(freshById.size, 1);
  assert.equal(freshById.get('bounty:current').matches[0].condition, '赏金 · 尖刃弹头');
  assert.deepEqual(currentNotificationMatches({ initialized: false, notifyInitial: false }, current), []);
  assert.deepEqual(currentNotificationMatches({ initialized: true }, current, new Set(['bounty:current'])), []);
});
