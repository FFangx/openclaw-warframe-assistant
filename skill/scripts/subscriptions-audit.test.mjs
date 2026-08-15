import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendFreshMatches, currentNotificationMatches, diagnoseSubscriptions, manageCommand, matchedBountyTarget, notificationSource, translateRewardName } from './subscriptions.mjs';
import { buildIntelCard } from './warframe-cards.mjs';

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

test('赏金订阅卡把实际命中目标放在主标题区域而非只显示代表奖励', () => {
  const item = {
    id: 'bounty:test', type: 'bounty', placeZh: '殁世幽都', jobZh: '异物取回', levels: [15, 25],
    topReward: '破片射击 5.68%', expiry: '2099-01-01T00:00:00.000Z',
    matches: [{ condition: '赏金 · 尖刃弹头' }], subscriptionDetail: '赏金 · 尖刃弹头',
  };
  item.matchedTarget = matchedBountyTarget(item);
  const card = buildIntelCard({ title: '订阅命中 · 1 条更新', items: [item], fetchedAt: '2026-08-13T00:00:00.000Z' });
  assert.equal(item.matchedTarget, '尖刃弹头');
  assert.ok(card.html.indexOf('尖刃弹头') < card.html.indexOf('异物取回'));
  assert.match(card.html, /奖池代表奖励：破片射击 5\.68%/u);
});

test('备用世界状态的连写入侵部件名可命中简中目录', () => {
  const translations = new Map([
    ['strun wraith stock', '斯特朗·亡魂 枪托'],
    ['dera vandal barrel', '德拉·破坏者 枪管'],
  ]);
  assert.equal(translateRewardName('StrunWraithStock', translations), '斯特朗·亡魂 枪托');
  assert.equal(translateRewardName('DeraVandalBarrel', translations), '德拉·破坏者 枪管');
});

test('订阅卡来源只依据本次实际展示的情报', () => {
  const invasion = { type: 'invasion' };
  const scheduledArbitration = { type: 'arbitration', source: 'browse.wf' };
  assert.equal(notificationSource([invasion]), 'warframestat.us');
  assert.equal(notificationSource([scheduledArbitration]), 'browse.wf');
  assert.equal(notificationSource([invasion, scheduledArbitration]), 'warframestat.us + browse.wf');
  const card = buildIntelCard({ title: '订阅命中', items: [invasion], source: notificationSource([invasion]), fetchedAt: '2026-08-16T00:00:00.000Z' });
  assert.match(card.html, /来源：世界状态/u);
  assert.doesNotMatch(card.html, /仲裁排期/u);
});
