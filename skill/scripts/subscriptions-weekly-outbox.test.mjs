import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// 隔离数据缓存目录：周常模块的词典/目录缓存必须落在临时目录，
// 否则合成 fixture 会写进真实运行时或仓库缓存目录（2026-08-21 实拍泄漏同类问题）。
const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'wf-weekly-outbox-cache-'));
process.env.WARFRAME_DATA_CACHE_DIR = cacheDir;

import {
  createSubscriptionsMailer,
  monitorTarget,
  weeklyBusinessKey,
  weeklyDeliveryExpiry,
  weeklyPartsFor,
} from './subscriptions.mjs';
import { contentHashOf, targetKeyOf } from './notification-outbox.mjs';
import { __resetWfdataForTest } from './wfdata.mjs';

const TARGET = 'qqbot:c2c:tester';
const OWNER = 'tester';
// 周一 00:30 UTC 固定基准（周报窗口内）；周界 = 2026-08-31T00:00:00Z（+7d，超出 48h 硬上限）
const MONDAY = Date.parse('2026-08-24T00:30:00.000Z');
// weekStart() 返回完整 ISO 时间戳：weeklyId 与账本 seen 标记同口径
const WEEK_ID = 'weekly:2026-08-24T00:00:00.000Z';
const NEXT_RESET_MONDAY = '2026-08-31T00:00:00.000Z';
// 周六 12:00 UTC：距下周一 00:00 UTC 正好 36h（48h 内，expiresAt 可保留周界本身）
const SATURDAY = Date.parse('2026-08-29T12:00:00.000Z');
const MAIN = 'C:\\tmp\\weekly-main.png';
const DEALS = 'C:\\tmp\\weekly-deals.png';
const iso = (ms) => new Date(ms).toISOString();
const TEXT_FALLBACK = '📅 本周周常已刷新，发送“周常”查看详细清单。';

test.before(() => {
  // 预制活动/赏金词典与空响应 fetch：任何残余联网都命中本地桩，测试绝不联网。
  __resetWfdataForTest({ eventMap: new Map(), oracleConquestMap: new Map(), bountyZh: { jobs: {}, challenges: {}, challengeDetails: {}, nodes: {}, items: {}, languageTails: {} } });
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
});

test.after(async () => {
  delete globalThis.fetch;
  try { await import('./wfdata.mjs').then((m) => m.__resetWfdataForTest({})); } catch { /* 测试环境清理 */ }
  await rm(cacheDir, { recursive: true, force: true });
});

// ---------- fixture ----------

function ledgerWith(subscriptions, schedules = {}) {
  return { version: 2, updatedAt: new Date().toISOString(), subscriptions, schedules, audit: [] };
}

function weeklySubscription(overrides = {}) {
  return {
    id: 'sub-weekly', target: TARGET, ownerId: OWNER, ownerName: OWNER,
    type: 'weekly', filter: '', enabled: true, initialized: false, notifyInitial: true,
    seen: [], createdAt: new Date().toISOString(), ...overrides,
  };
}

async function writeLedger(dir, ledger) {
  const statePath = path.join(dir, 'subscriptions.json');
  await writeFile(statePath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  return statePath;
}

async function readLedger(statePath) {
  return JSON.parse(await readFile(statePath, 'utf8'));
}

async function readStore(dir) {
  return JSON.parse(await readFile(path.join(dir, 'warframe-delivery-outbox.json'), 'utf8'));
}

// weeklyRender 注入端口：生产默认走真实渲染链（defaultWeeklyRender），测试整体替换，
// 保证零联网、零真实快照/状态读写，双卡内容可控。
function runOptions(dir, { mailer, clockNow, weeklyRender, worldState } = {}) {
  return {
    outboxPath: path.join(dir, 'warframe-delivery-outbox.json'),
    ...(mailer ? { mailer } : {}),
    ...(clockNow ? { now: clockNow } : {}),
    ...(weeklyRender ? { weeklyRender } : {}),
    worldStateFetcher: async () => worldState || { timestamp: new Date().toISOString(), fissures: [] },
  };
}

function dualCards() {
  return async () => ({ mediaUrl: MAIN, dealsMediaUrl: DEALS });
}

function clockAt(ms) {
  let current = ms;
  return { now: () => current, advance: (delta) => { current += delta; } };
}

// ---------- 测试 ----------

test('weekly 主动周报：主图无损/好货卡普通按序入 Outbox，先原子入队再提交账本再投递', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-weekly-outbox-flow-'));
  try {
    const statePath = await writeLedger(dir, ledgerWith([weeklySubscription()]));
    const calls = [];
    const result = await monitorTarget(TARGET, statePath, null, false, async () => {}, runOptions(dir, {
      mailer: async (part) => { calls.push(part); return { ok: true }; },
      clockNow: () => MONDAY,
      weeklyRender: dualCards(),
    }));

    // 输出恒为 NO_REPLY：投递由 Outbox 逐 part 完成，cron 不再 announce 二投
    assert.equal(result.output, 'NO_REPLY\n');
    assert.equal(result.data.ok, true);
    assert.equal(result.data.outbox, true);
    assert.equal(result.data.delivered, 'direct');
    assert.equal(result.data.delivery.sentParts, 2);
    assert.equal(result.data.businessKey, weeklyBusinessKey(TARGET, WEEK_ID, ['sub-weekly']));
    // 双卡顺序与投递模式：主周报无损原图（/files + srv_send_msg=true）→ 好货卡普通 --media
    assert.deepEqual(calls.map((part) => part.kind), ['media', 'media']);
    assert.equal(calls[0].value, MAIN);
    assert.equal(calls[0].transport, 'lossless');
    assert.equal(calls[1].value, DEALS);
    assert.equal(calls[1].transport, 'media');

    // Outbox 记录：业务键 = 脱敏 targetKey + weeklyId + 订阅集合哈希；parts 持久化 mode
    const store = await readStore(dir);
    assert.equal(store.schemaVersion, 1);
    assert.equal(store.entries.length, 1);
    const entry = store.entries[0];
    assert.match(entry.businessKey, /^weekly:[0-9a-f]{64}:[0-9a-f]{64}$/u);
    assert.equal(entry.businessKey, `weekly:${targetKeyOf(TARGET)}:${weeklyBusinessKey(TARGET, WEEK_ID, ['sub-weekly']).split(':').at(-1)}`);
    assert.equal(entry.target, undefined);
    assert.equal(entry.targetKey, targetKeyOf(TARGET));
    assert.deepEqual(entry.parts.map((part) => [part.kind, part.transport]), [['media', 'lossless'], ['media', 'media']]);
    assert.equal(entry.parts[0].status, 'sent');
    assert.equal(entry.parts[1].status, 'sent');
    // contentHash 包含投递模式：与同内容普通投递不同，与落盘 parts 一致
    assert.notEqual(entry.contentHash, contentHashOf([{ kind: 'media', value: MAIN }, { kind: 'media', value: DEALS }]));
    assert.equal(entry.contentHash, contentHashOf(entry.parts));
    // expiresAt：本周界（+7d）超过 48h 硬上限 → 封顶 createdAt+48h
    assert.equal(entry.createdAt, iso(MONDAY));
    assert.equal(entry.expiresAt, iso(MONDAY + 48 * 60 * 60 * 1000));
    assert.equal(store.tombstones[entry.businessKey], entry.deliveredAt);

    // 事务顺序：账本在入队后提交（seen/调度收敛）
    const ledger = await readLedger(statePath);
    assert.equal(ledger.subscriptions[0].seen.includes(WEEK_ID), true);
    assert.ok(Number.isFinite(Date.parse(ledger.schedules[TARGET].weekly)));

    // 不保存原始 target / owner / subscriptionId
    const raw = await readFile(path.join(dir, 'warframe-delivery-outbox.json'), 'utf8');
    assert.equal(raw.includes(TARGET), false);
    assert.equal(raw.includes(OWNER), false);
    assert.equal(raw.includes('sub-weekly'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('主图成功好货卡失败：只补投好货卡，下一轮 not_due 前补投且不重发主图', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-weekly-outbox-partial-'));
  try {
    const statePath = await writeLedger(dir, ledgerWith([weeklySubscription()]));
    const failCalls = [];
    const first = await monitorTarget(TARGET, statePath, null, false, async () => {}, runOptions(dir, {
      mailer: async (part) => { failCalls.push(part); return part.value === DEALS ? { ok: false, category: 'timeout' } : { ok: true }; },
      clockNow: () => MONDAY,
      weeklyRender: dualCards(),
    }));
    assert.equal(first.data.delivered, 'direct'); // 至少一个 part 已发出（主图成功）
    assert.equal(first.data.delivery.sentParts, 1);
    assert.equal(first.data.delivery.failedParts, 1);
    assert.equal(failCalls.length, 2); // 两张卡都尝试过：主图成功、好货卡失败
    let store = await readStore(dir);
    assert.equal(store.entries[0].status, 'pending');
    assert.equal(store.entries[0].outcome, 'failed');
    assert.equal(store.entries[0].parts[0].status, 'sent');
    assert.equal(store.entries[0].parts[0].attempts, 1);
    assert.equal(store.entries[0].parts[1].status, 'pending');
    assert.equal(store.entries[0].parts[1].attempts, 1);
    assert.deepEqual(store.entries[0].attemptsLog.map((item) => item.category), ['delivered', 'failed']);

    // 账本已提交（seen 已核销）→ 模拟调度已蹲到周界：下一轮 not_due 也先补投欠账
    const ledger = await readLedger(statePath);
    ledger.schedules[TARGET] = { ...ledger.schedules[TARGET], weekly: iso(Date.now() + 60 * 60 * 1000) };
    await writeFile(statePath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');

    const okCalls = [];
    const second = await monitorTarget(TARGET, statePath, null, false, async () => {}, runOptions(dir, {
      mailer: async (part) => { okCalls.push(part); return { ok: true }; },
      clockNow: () => MONDAY,
      weeklyRender: dualCards(),
    }));
    assert.equal(second.output, 'NO_REPLY\n');
    assert.equal(second.data.reason, 'not_due'); // 补投发生在 not_due 短路之前
    assert.equal(second.data.delivery.sentParts, 1);
    // 只补投好货卡：主图（已成功）不重发
    assert.equal(okCalls.length, 1);
    assert.equal(okCalls[0].value, DEALS);
    assert.equal(okCalls[0].transport, 'media');
    store = await readStore(dir);
    assert.equal(store.entries.length, 1); // 未重复入队
    assert.equal(store.entries[0].status, 'delivered');
    assert.equal(store.entries[0].parts[0].attempts, 1); // 主图只发一次
    assert.equal(store.entries[0].parts[1].attempts, 2); // 好货卡补投一次
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('双卡都失败后重启（新 Outbox 实例）：pending 从磁盘恢复，本轮优先补投双卡并保持顺序', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-weekly-outbox-restart-'));
  try {
    const statePath = await writeLedger(dir, ledgerWith([weeklySubscription()]));
    const failCalls = [];
    await monitorTarget(TARGET, statePath, null, false, async () => {}, runOptions(dir, {
      mailer: async (part) => { failCalls.push(part); return { ok: false, category: 'network' }; },
      clockNow: () => MONDAY,
      weeklyRender: dualCards(),
    }));
    assert.equal(failCalls.length, 2);
    let store = await readStore(dir);
    assert.equal(store.entries[0].status, 'pending');
    assert.equal(store.entries[0].parts[0].attempts, 1);

    // 「Gateway 重启」：monitorTarget 每次都新建 Outbox 实例（从磁盘恢复），
    // 快照未变时本轮先补投 pending，再走调度短路
    const okCalls = [];
    const second = await monitorTarget(TARGET, statePath, null, false, async () => {}, runOptions(dir, {
      mailer: async (part) => { okCalls.push(part); return { ok: true }; },
      clockNow: () => MONDAY,
      weeklyRender: dualCards(),
    }));
    assert.ok(['not_due', 'no_fresh'].includes(second.data.reason), `reason=${second.data.reason}`);
    assert.equal(okCalls.length, 2);
    assert.deepEqual(okCalls.map((part) => part.value), [MAIN, DEALS]);
    assert.deepEqual(okCalls.map((part) => part.transport), ['lossless', 'media']);
    store = await readStore(dir);
    assert.equal(store.entries.length, 1);
    assert.equal(store.entries[0].status, 'delivered');
    assert.equal(store.entries[0].parts[0].attempts, 2);
    assert.equal(store.entries[0].parts[1].attempts, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('入队后账本写失败的恢复：同业务键去重不重复入队/投递，账本最终收敛', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-weekly-outbox-dedupe-'));
  try {
    const originalLedger = ledgerWith([weeklySubscription()]);
    const statePath = await writeLedger(dir, originalLedger);
    const beforeFirst = JSON.stringify(originalLedger);

    await monitorTarget(TARGET, statePath, null, false, async () => {}, runOptions(dir, {
      mailer: async () => ({ ok: false, category: 'network' }),
      clockNow: () => MONDAY,
      weeklyRender: dualCards(),
    }));

    // 模拟崩溃窗口：Outbox 已入队（pending），但账本写盘丢失（恢复成入队前的旧账本）
    await writeFile(statePath, beforeFirst, 'utf8');

    const calls = [];
    const second = await monitorTarget(TARGET, statePath, null, false, async () => {}, runOptions(dir, {
      mailer: async (part) => { calls.push(part); return { ok: true }; },
      clockNow: () => MONDAY,
      weeklyRender: dualCards(),
    }));
    // 本轮先补投 pending（2 part），随后同业务键命中去重不再入队
    assert.equal(calls.length, 2);
    assert.equal(second.data.outbox, true);
    assert.equal(second.data.delivery.sentParts, 2);
    const store = await readStore(dir);
    assert.equal(store.entries.length, 1); // 同一业务键只入队一次
    assert.equal(store.entries[0].status, 'delivered');
    assert.equal(store.entries[0].parts[0].attempts, 2); // 断网 1 次 + 补投 1 次
    // 账本最终收敛（seen 已写入）
    const ledger = await readLedger(statePath);
    assert.equal(ledger.subscriptions[0].seen.includes(WEEK_ID), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('同周新建周常订阅不被旧 tombstone 吞掉：新订阅集合 → 新业务键 → 独立投递', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-weekly-outbox-newsub-'));
  try {
    const statePath = await writeLedger(dir, ledgerWith([weeklySubscription({ id: 'sub-a' })]));
    const firstCalls = [];
    await monitorTarget(TARGET, statePath, null, false, async () => {}, runOptions(dir, {
      mailer: async (part) => { firstCalls.push(part); return { ok: true }; },
      clockNow: () => MONDAY,
      weeklyRender: dualCards(),
    }));
    assert.equal(firstCalls.length, 2);
    const storeAfterFirst = await readStore(dir);
    const keyA = storeAfterFirst.entries[0].businessKey;
    assert.equal(storeAfterFirst.entries[0].status, 'delivered');
    assert.equal(storeAfterFirst.tombstones[keyA], storeAfterFirst.entries[0].deliveredAt);

    // 同周新建订阅 B（addOne 语义：会重置该 target 调度，下轮立即重试）
    const ledger = await readLedger(statePath);
    ledger.subscriptions.push(weeklySubscription({ id: 'sub-b' }));
    delete ledger.schedules[TARGET];
    await writeFile(statePath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');

    const secondCalls = [];
    const second = await monitorTarget(TARGET, statePath, null, false, async () => {}, runOptions(dir, {
      mailer: async (part) => { secondCalls.push(part); return { ok: true }; },
      clockNow: () => MONDAY,
      weeklyRender: dualCards(),
    }));
    assert.equal(second.data.outbox, true);
    assert.equal(secondCalls.length, 2); // 新订阅拿到同一份本周清单
    const store = await readStore(dir);
    assert.equal(store.entries.length, 2);
    const entryB = store.entries.find((entry) => entry.businessKey !== keyA);
    // 新业务键未被旧 tombstone 吞掉，且与旧的 keyA 不同（订阅集合哈希变了）
    assert.equal(entryB.businessKey, weeklyBusinessKey(TARGET, WEEK_ID, ['sub-b']));
    assert.notEqual(entryB.businessKey, keyA);
    assert.equal(entryB.status, 'delivered');
    // 只有 A（旧）在 tombstone 集合里的键是 keyA
    assert.equal(store.tombstones[keyA], store.entries.find((entry) => entry.businessKey === keyA).deliveredAt);
    // 账本收敛：两个订阅都核销了本周
    const ledgerAfter = await readLedger(statePath);
    assert.equal(ledgerAfter.subscriptions.every((item) => (item.seen || []).includes(WEEK_ID)), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('周界过期不投：expiresAt=本周下次重置边界（48h 内如实保留），过界后置 expired 不补发旧周报', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-weekly-outbox-boundary-'));
  try {
    const statePath = await writeLedger(dir, ledgerWith([weeklySubscription()]));
    const failCalls = [];
    const first = await monitorTarget(TARGET, statePath, null, false, async () => {}, runOptions(dir, {
      mailer: async (part) => { failCalls.push(part); return { ok: false, category: 'timeout' }; },
      clockNow: () => SATURDAY,
      weeklyRender: dualCards(),
    }));
    assert.equal(failCalls.length, 2);
    let store = await readStore(dir);
    assert.equal(store.entries.length, 1);
    // 周六 12:00 → 下周一 00:00 UTC（36h，在 48h 硬上限内）：expiresAt 如实保留周界
    assert.equal(store.entries[0].createdAt, iso(SATURDAY));
    assert.equal(store.entries[0].expiresAt, NEXT_RESET_MONDAY);
    assert.equal(store.entries[0].status, 'pending');

    // 时钟推进过周界（账本已提交 → 调度蹲到周界）：补投把本周记录置 expired，绝不补发旧周报
    const ledger = await readLedger(statePath);
    ledger.schedules[TARGET] = { ...ledger.schedules[TARGET], weekly: iso(Date.now() + 60 * 60 * 1000) };
    await writeFile(statePath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
    const afterBoundary = SATURDAY + 38 * 60 * 60 * 1000; // 2026-08-31T02:00:00Z
    const calls = [];
    const second = await monitorTarget(TARGET, statePath, null, false, async () => {}, runOptions(dir, {
      mailer: async (part) => { calls.push(part); return { ok: true }; },
      clockNow: () => afterBoundary,
      weeklyRender: dualCards(),
    }));
    assert.equal(calls.length, 0); // 过界不补发
    assert.equal(second.data.reason, 'not_due');
    assert.deepEqual(second.data.delivery.expiredIds, ['ob-1']);
    store = await readStore(dir);
    assert.equal(store.entries[0].status, 'expired');
    assert.equal(store.entries[0].outcome, 'expired');
    assert.ok(store.entries[0].expiredAt);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('文字降级：渲染失败退文字 --message part，同样走 Outbox 事务链', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-weekly-outbox-text-'));
  try {
    const statePath = await writeLedger(dir, ledgerWith([weeklySubscription()]));
    const calls = [];
    const result = await monitorTarget(TARGET, statePath, null, false, async () => {}, runOptions(dir, {
      mailer: async (part) => { calls.push(part); return { ok: true }; },
      clockNow: () => MONDAY,
      weeklyRender: async () => ({ mediaUrl: null, dealsMediaUrl: null }),
    }));
    assert.equal(result.output, 'NO_REPLY\n');
    assert.equal(result.data.outbox, true);
    assert.equal(result.data.delivered, 'direct');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, 'text');
    assert.equal(calls[0].value, TEXT_FALLBACK);
    const store = await readStore(dir);
    assert.equal(store.entries[0].parts.length, 1);
    assert.equal(store.entries[0].parts[0].kind, 'text');
    assert.equal(store.entries[0].parts[0].transport, 'media'); // 文字 part 归一为默认模式
    const ledger = await readLedger(statePath);
    assert.equal(ledger.subscriptions[0].seen.includes(WEEK_ID), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('monitor（announce）路径周常保持原样：先提交账本再返回输出，不进 Outbox', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-weekly-outbox-monitor-'));
  try {
    const statePath = await writeLedger(dir, ledgerWith([weeklySubscription()]));
    // directDeliver = null：monitor 路径，不进入 Outbox 事务链
    const result = await monitorTarget(TARGET, statePath, null, false, null, runOptions(dir, {
      mailer: async () => { throw new Error('monitor 路径不应投递'); },
      clockNow: () => MONDAY,
      weeklyRender: async () => ({ mediaUrl: null, dealsMediaUrl: null }),
    }));
    assert.equal(result.output, `${TEXT_FALLBACK}\n`);
    assert.equal(result.data.outbox, undefined);
    await assert.rejects(access(path.join(dir, 'warframe-delivery-outbox.json')), /ENOENT/u);
    // 账本照旧先提交
    const ledger = await readLedger(statePath);
    assert.equal(ledger.subscriptions[0].seen.includes(WEEK_ID), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('weeklyPartsFor：主图无损、好货卡普通、文字降级 --message', () => {
  assert.deepEqual(weeklyPartsFor({
    output: `MEDIA:${MAIN}\nMEDIA:${DEALS}\n`,
    data: { mediaUrl: MAIN, dealsMediaUrl: DEALS },
  }), [{ kind: 'media', value: MAIN, transport: 'lossless' }, { kind: 'media', value: DEALS }]);
  assert.deepEqual(weeklyPartsFor({
    output: `MEDIA:${MAIN}\n`,
    data: { mediaUrl: MAIN },
  }), [{ kind: 'media', value: MAIN, transport: 'lossless' }]);
  assert.deepEqual(weeklyPartsFor({ output: `${TEXT_FALLBACK}\n`, data: { weekly: WEEK_ID } }), [{ kind: 'text', value: TEXT_FALLBACK }]);
});

test('weeklyBusinessKey：集合语义（顺序无关）、区分 weeklyId/订阅集合、不含原文 target/subscriptionId', () => {
  const keyAb = weeklyBusinessKey(TARGET, WEEK_ID, ['sub-a', 'sub-b']);
  assert.equal(keyAb, weeklyBusinessKey(TARGET, WEEK_ID, ['sub-b', 'sub-a']));
  assert.equal(weeklyBusinessKey(TARGET, WEEK_ID, ['sub-a']), weeklyBusinessKey(TARGET, WEEK_ID, ['sub-a']));
  assert.notEqual(keyAb, weeklyBusinessKey(TARGET, WEEK_ID, ['sub-a']));
  assert.notEqual(keyAb, weeklyBusinessKey(TARGET, WEEK_ID, ['sub-b']));
  assert.notEqual(keyAb, weeklyBusinessKey(TARGET, 'weekly:2026-08-31', ['sub-a', 'sub-b']));
  assert.notEqual(keyAb, weeklyBusinessKey('qqbot:c2c:other', WEEK_ID, ['sub-a', 'sub-b']));
  // 原文（target / weeklyId / subscriptionId）只进入哈希，不落明文
  assert.equal(keyAb.includes(TARGET), false);
  assert.equal(keyAb.includes('weekly:2026-08-24'), false);
  assert.equal(keyAb.includes('sub-a'), false);
  assert.match(keyAb, /^weekly:[0-9a-f]{64}:[0-9a-f]{64}$/u);
});

test('weeklyDeliveryExpiry：本周下次重置边界（周一 00:00 UTC）', () => {
  assert.equal(weeklyDeliveryExpiry(MONDAY), NEXT_RESET_MONDAY);
  assert.equal(weeklyDeliveryExpiry(SATURDAY), NEXT_RESET_MONDAY);
});

test('默认 mailer：无损 part 走 sendQQLosslessLocalImage，抛错映射固定类别；普通 part 要求 messageId', async () => {
  const sent = [];
  const lossless = [];
  const mailer = createSubscriptionsMailer(TARGET, {
    send: async (target, args) => { sent.push([target, args]); return 'notice\n{"messageId":"m-1"}'; },
    sendLossless: async (target, mediaPath) => { lossless.push([target, mediaPath]); return { file_id: 'f-1' }; },
  });
  // 无损 part：只调 sendQQLosslessLocalImage，不调普通 CLI
  assert.deepEqual(await mailer({ kind: 'media', value: MAIN, transport: 'lossless' }), { ok: true, category: null });
  assert.deepEqual(lossless, [[TARGET, MAIN]]);
  assert.equal(sent.length, 0);
  // 普通媒体 part：--media；文字 part：--message
  assert.deepEqual(await mailer({ kind: 'media', value: DEALS }), { ok: true, category: null });
  assert.deepEqual(sent.at(-1), [TARGET, ['--media', DEALS]]);
  assert.deepEqual(await mailer({ kind: 'text', value: '说明' }), { ok: true, category: null });
  assert.deepEqual(sent.at(-1), [TARGET, ['--message', '说明']]);

  // 抛错映射固定脱敏类别（原始异常不落盘）
  const throwing = createSubscriptionsMailer(TARGET, {
    send: async () => { const error = new Error('CLI boom'); error.code = 'ETIMEDOUT'; throw error; },
    sendLossless: async () => { throw new Error('api down'); },
  });
  assert.deepEqual(await throwing({ kind: 'media', value: DEALS }), { ok: false, category: 'timeout' });
  assert.deepEqual(await throwing({ kind: 'media', value: MAIN, transport: 'lossless' }), { ok: false, category: 'process_error' });
  // 普通 part 必须有 messageId 且无 provider error
  const rejected = createSubscriptionsMailer(TARGET, { send: async () => '{"error":"rejected"}' });
  assert.deepEqual(await rejected({ kind: 'text', value: 'x' }), { ok: false, category: 'provider_rejected' });
  const noId = createSubscriptionsMailer(TARGET, { send: async () => '{"ok":true}' });
  assert.deepEqual(await noId({ kind: 'text', value: 'x' }), { ok: false, category: 'missing_message_id' });
});
