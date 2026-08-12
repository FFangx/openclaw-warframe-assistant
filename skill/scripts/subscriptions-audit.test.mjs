import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { diagnoseSubscriptions } from './subscriptions.mjs';

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
