import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// 隔离奖励缓存目录：reward-zh-fallback 的 inbox/学习词典必须落在临时目录，
// 否则本文件的合成 fixture（如 totally alad v xyz thing）会写进真实运行时或
// 仓库缓存目录的 reward-zh-inbox.json（2026-08-21 实拍泄漏，两条缓存都被污染）。
// 模块按需解析 WARFRAME_DATA_CACHE_DIR（延迟到首次读写），在此设置即可生效。
const rewardCacheDir = await mkdtemp(path.join(os.tmpdir(), 'wf-sub-audit-reward-cache-'));
process.env.WARFRAME_DATA_CACHE_DIR = rewardCacheDir;

import { appendFreshMatches, currentNotificationMatches, deliverMonitorResult, diagnoseSubscriptions, manageCommand, matchedBountyTarget, monitorDeliveryParts, notificationSource, translateRewardName } from './subscriptions.mjs';
import { buildIntelCard } from './warframe-cards.mjs';
import { parseQQMediaTarget, resolveQQCredentials, sendQQLosslessLocalImage } from './qq-lossless-image.mjs';
import { clearPendingRewards, flushRewardQueues, readPendingRewards } from './reward-zh-fallback.mjs';

test.after(async () => {
  await rm(rewardCacheDir, { recursive: true, force: true });
});

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
  // 2026-08-19 火卫一 Gulliver 实拍回归：进攻方希芙蓝图（Sortie 路径词）/ 防守方德拉枪托
  assert.equal(translateRewardName('GrineerCombatKnifeSortieBlueprint', translations), '希芙 蓝图');
  const full = new Map([...translations, ['dera vandal stock', '德拉·破坏者 枪托']]);
  assert.equal(translateRewardName('DeraVandalStock', full), '德拉·破坏者 枪托');
});

test('全链查无的奖励名会排队进 AI 查证 inbox', async () => {
  await clearPendingRewards();
  assert.equal(translateRewardName('TotallyUnknownXyzThing', new Map()), '未收录奖励');
  await flushRewardQueues();
  const pending = await readPendingRewards();
  assert.ok(pending.some((item) => item.english === 'totally unknown xyz thing'));
});

test('官方预翻译的混写奖励名保留拉丁专名、不进 inbox', async () => {
  await clearPendingRewards();
  // 2026-08-19 冥王星 Hades 入侵防守方实拍：世界状态直接给「异融 Alad V 导航坐标」
  assert.equal(translateRewardName('异融 Alad V 导航坐标', new Map()), '异融 Alad V 导航坐标');
  assert.equal(translateRewardName('暗影 Forma 蓝图', new Map()), '暗影 Forma 蓝图');
  // 纯英文名即使带 Alad V 也照旧排队，不猜
  assert.equal(translateRewardName('Totally Alad V Xyz Thing', new Map()), '未收录奖励');
  await flushRewardQueues();
  const pending = await readPendingRewards();
  assert.ok(!pending.some((item) => item.english === '异融 alad v 导航坐标'));
  assert.ok(pending.some((item) => item.english === 'totally alad v xyz thing'));
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

test('订阅直投完整保留两张本地原图并按顺序调用 QQ outbound', async () => {
  const result = {
    output: 'MEDIA:C:\\cards\\weekly.png\nMEDIA:C:\\cards\\deals.png\n',
    data: { losslessMediaUrls: ['C:\\cards\\weekly.png'] },
  };
  assert.deepEqual(monitorDeliveryParts(result), {
    mediaUrls: ['C:\\cards\\weekly.png', 'C:\\cards\\deals.png'],
    text: '',
  });
  const calls = [];
  const sent = await deliverMonitorResult(
    result,
    'qqbot:c2c:test',
    async (target, args) => calls.push({ kind: 'normal', target, args }),
    async (target, mediaUrl) => calls.push({ kind: 'lossless', target, mediaUrl }),
  );
  assert.equal(sent, 2);
  assert.deepEqual(calls, [
    { kind: 'lossless', target: 'qqbot:c2c:test', mediaUrl: 'C:\\cards\\weekly.png' },
    { kind: 'normal', target: 'qqbot:c2c:test', args: ['--media', 'C:\\cards\\deals.png'] },
  ]);
});

test('QQ 周常无损直投使用 /files srv_send_msg 一步链路且不再发 msg_type=7', async () => {
  assert.deepEqual(parseQQMediaTarget('qqbot:c2c:user-id'), { scope: 'c2c', id: 'user-id' });
  assert.deepEqual(resolveQQCredentials({ channels: { qqbot: { appId: 'app', clientSecret: 'secret' } } }), { appId: 'app', clientSecret: 'secret' });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-qq-lossless-'));
  const image = path.join(dir, 'weekly.png');
  await writeFile(image, Buffer.from('png-bytes'));
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const body = JSON.parse(options.body);
    return new Response(JSON.stringify(url.includes('getAppAccessToken')
      ? { access_token: 'token', expires_in: 7200 }
      : { file_info: 'sent' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    await sendQQLosslessLocalImage('qqbot:c2c:user-id', image, {
      config: { channels: { qqbot: { appId: 'app', clientSecret: 'secret' } } },
      fetchImpl,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /\/v2\/users\/user-id\/files$/u);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    file_type: 1,
    file_data: Buffer.from('png-bytes').toString('base64'),
    srv_send_msg: true,
  });
  assert.equal(calls.some((call) => /\/messages$/u.test(call.url)), false);
});

test('仲裁阵营双源一致：warframestat 的 Infested 与排期缓存的 Infestation 都显示 Infestation', async () => {
  const { allCandidates } = await import('./subscriptions.mjs');
  const base = {
    node: 'SolNode172', type: 'MT_TERRITORY', expiry: new Date(Date.now() + 3600_000).toISOString(),
  };
  const fromStat = allCandidates({ arbitration: { ...base, enemy: 'Infested', source: 'warframestat.us' } }).arbitration[0];
  const fromSchedule = allCandidates({ arbitration: { ...base, enemy: 'Infestation', source: 'browse.wf' } }).arbitration[0];
  const fromCode = allCandidates({ arbitration: { ...base, enemy: 'FC_INFESTATION', source: 'browse.wf' } }).arbitration[0];
  assert.equal(fromStat.enemy, 'Infestation');
  assert.equal(fromSchedule.enemy, 'Infestation'); // 之前回退成「未知阵营」的 bug
  assert.equal(fromCode.enemy, 'Infestation');
  const empty = allCandidates({ arbitration: { ...base, enemy: null } }).arbitration[0];
  assert.equal(empty.enemy, '未知阵营');
});
