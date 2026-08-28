import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'wf-schedule-contract-cache-'));
process.env.WARFRAME_DATA_CACHE_DIR = cacheDir;
const { SCHEDULE_CONTRACT, scheduleDocViolations, validateScheduleContract, validateScheduleDocs } = await import('./schedule-contract.mjs');
const { monitorTarget, updateSchedule } = await import('./subscriptions.mjs');
const { REST_INTERVAL_MS } = await import('./wishlist.mjs');
const { createTokenBucket } = await import('./wishlist-protection.mjs');
const { weekStart, nextReset } = await import('./weekly.mjs');

const skillRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIN = 60_000;
const HOUR = 60 * MIN;
const TARGET = 'qqbot:c2c:tester';
const iso = (value) => new Date(value).toISOString();
test.after(async () => rm(cacheDir, { recursive: true, force: true }));

test('调度合同与 operations.md 一致，关键漂移会失败', async () => {
  assert.equal(validateScheduleContract(), true);
  assert.throws(() => validateScheduleContract({ ...SCHEDULE_CONTRACT, weekly: { weekdayUtc: 2, hourUtc: 0, minuteUtc: 0 } }), /weekly/u);
  assert.throws(() => validateScheduleContract({ ...SCHEDULE_CONTRACT, wishlist: { ...SCHEDULE_CONTRACT.wishlist, marketStartSpacingMs: 200 } }), /3 req\/s/u);
  const operations = await readFile(path.join(skillRoot, 'references', 'operations.md'), 'utf8');
  assert.deepEqual(scheduleDocViolations(operations), []);
  assert.equal(validateScheduleDocs(operations), true);
  assert.throws(() => validateScheduleDocs(operations.replace('每周一 00:00 UTC 刷新', '每周二刷新')), /漂移/u);
});

test('世界状态未到 nextCheckAt 返回 NO_REPLY 且零联网', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-schedule-gate-'));
  try {
    const statePath = path.join(dir, 'subscriptions.json');
    const now = Date.now();
    await writeFile(statePath, JSON.stringify({
      version: 2,
      subscriptions: [{ id: 's1', target: TARGET, ownerId: 'tester', type: 'fissure', enabled: true, initialized: false, notifyInitial: true, seen: [], createdAt: iso(now) }],
      schedules: { [TARGET]: { fissure: iso(now + MIN) } }, audit: [],
    }));
    let fetches = 0;
    const result = await monitorTarget(TARGET, statePath, null, false, null, {
      worldStateFetcher: async () => { fetches += 1; throw new Error('不得联网'); },
    });
    assert.equal(result.output, `${SCHEDULE_CONTRACT.worldstate.notDueOutput}\n`);
    assert.equal(result.data.reason, 'not_due');
    assert.equal(fetches, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('世界状态按现有事件边界更新调度', () => {
  const now = Date.now();
  const fissureExpiry = now + 2 * HOUR;
  const bountyExpiry = now + 40 * MIN;
  const traderArrival = now + 6 * HOUR;
  const ledger = { subscriptions: [{ id: 'r1', target: TARGET, type: 'rotation', enabled: true, meta: { at: now + 3 * HOUR } }], schedules: {} };
  updateSchedule(ledger, TARGET, {
    fissures: [{ expiry: iso(fissureExpiry) }], bountyCandidates: [{ expiry: iso(bountyExpiry) }],
    voidTrader: { activation: iso(traderArrival), expiry: iso(now + 16 * HOUR), active: false },
  }, new Set(['fissure', 'bounty', 'trader', 'weekly', 'rotation', 'alert']), 'weekly:test');
  const schedule = ledger.schedules[TARGET];
  const offset = SCHEDULE_CONTRACT.worldstate.wakeOffsetMs;
  assert.equal(schedule.fissure, iso(fissureExpiry + offset));
  assert.equal(schedule.bounty, iso(bountyExpiry + offset));
  assert.equal(schedule.trader, iso(traderArrival + offset));
  assert.equal(schedule.rotation, iso(now + 3 * HOUR + offset));
  assert.equal(schedule.unpredictable, iso(Date.parse(schedule.lastFetchAt) + SCHEDULE_CONTRACT.worldstate.unpredictableMs));
  assert.equal(schedule.weekly, iso(Date.parse(nextReset(new Date(schedule.lastFetchAt))) + offset));
});

test('愿望校准、Market 速率和周常周界匹配合同', () => {
  assert.equal(REST_INTERVAL_MS, SCHEDULE_CONTRACT.wishlist.calibrationMs);
  assert.deepEqual(createTokenBucket().status(), { tokens: 1, capacity: 1, refillMs: SCHEDULE_CONTRACT.wishlist.marketStartSpacingMs, waiting: 0 });
  assert.equal(weekStart(new Date('2026-08-31T12:00:00Z')), '2026-08-31T00:00:00.000Z');
  assert.equal(weekStart(new Date('2026-08-30T23:59:59Z')), '2026-08-24T00:00:00.000Z');
  assert.equal(nextReset(new Date('2026-08-31T12:00:00Z')), '2026-09-07T00:00:00.000Z');
});

test('reward-zh 源码声明是每日 isolated agent cron', async () => {
  const configPath = path.join(skillRoot, '..', 'config', 'cron', 'reward-zh-ai.job.json');
  let job;
  try { job = JSON.parse(await readFile(configPath, 'utf8')); } catch {
    assert.equal(path.basename(path.dirname(skillRoot)), 'skills', '源码布局缺少 reward-zh cron 声明');
    return;
  }
  const rule = SCHEDULE_CONTRACT.rewardZh;
  assert.equal(job.declarationKey, rule.declarationKey);
  assert.equal(job.schedule.kind, rule.scheduleKind);
  assert.equal(job.schedule.everyMs, rule.everyMs);
  assert.equal(job.sessionTarget, rule.sessionTarget);
  assert.equal(job.payload.kind, rule.payloadKind);
});
