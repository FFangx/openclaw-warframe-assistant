import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// 隔离数据缓存目录：订阅模块的词典/奖励翻译缓存必须落在临时目录，
// 否则合成 fixture 会写进真实运行时或仓库缓存目录（2026-08-21 实拍泄漏同类问题）。
const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'wf-sub-outbox-cache-'));
process.env.WARFRAME_DATA_CACHE_DIR = cacheDir;

import { classifyQQSendOutput, defaultOutboxPath, earliestBusinessExpiry, monitorTarget, worldStateBusinessKey } from './subscriptions.mjs';
import { targetKeyOf } from './notification-outbox.mjs';
import { __resetWfdataForTest } from './wfdata.mjs';

const TARGET = 'qqbot:c2c:tester';
const OWNER = 'tester';
const WORLD_STATE_FALLBACK_TTL_MS = 6 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

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

function ledgerWith(subscriptions) {
  return { version: 2, updatedAt: new Date().toISOString(), subscriptions, schedules: {}, audit: [] };
}

function fissureSubscription(overrides = {}) {
  return {
    id: 'sub-fissure', target: TARGET, ownerId: OWNER, ownerName: OWNER,
    type: 'fissure', filter: '', enabled: true, initialized: false, notifyInitial: true,
    seen: [], createdAt: new Date().toISOString(), ...overrides,
  };
}

function invasionSubscription(overrides = {}) {
  return {
    id: 'sub-invasion', target: TARGET, ownerId: OWNER, ownerName: OWNER,
    type: 'invasion', filter: '', enabled: true, initialized: false, notifyInitial: true,
    seen: [], createdAt: new Date().toISOString(), ...overrides,
  };
}

function fissure(id, expiryMs, overrides = {}) {
  return {
    id, node: 'Hydron (Sedna)', missionType: 'Survival', enemy: 'Grineer',
    tier: 'Lith', expiry: iso(expiryMs), isHard: false, isStorm: false, ...overrides,
  };
}

function worldStateWith(fissures, extras = {}) {
  return { timestamp: new Date().toISOString(), fissures, ...extras };
}

async function writeLedger(dir, ledger) {
  const statePath = path.join(dir, 'subscriptions.json');
  await writeFile(statePath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  return statePath;
}

function runOptions(dir, { mailer, worldState, clockNow, outboxPath } = {}) {
  return {
    outboxPath: outboxPath || path.join(dir, 'warframe-delivery-outbox.json'),
    ...(mailer ? { mailer } : {}),
    ...(clockNow ? { now: clockNow } : {}),
    worldStateFetcher: async () => worldState,
  };
}

async function readStore(dir) {
  return JSON.parse(await readFile(path.join(dir, 'warframe-delivery-outbox.json'), 'utf8'));
}

// ---------- 测试 ----------

test('世界状态首轮命中：先原子入队再提交账本再投递，业务键=targetKey+fresh 事件集，expiresAt=最早业务 expiry', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-sub-outbox-flow-'));
  try {
    const expiryMs = Date.now() + 2 * 60 * 60 * 1000;
    const statePath = await writeLedger(dir, ledgerWith([fissureSubscription()]));
    const calls = [];
    const result = await monitorTarget(TARGET, statePath, null, false, async () => {}, runOptions(dir, {
      mailer: async (part) => { calls.push(part); return { ok: true }; },
      worldState: worldStateWith([fissure('f1', expiryMs)]),
    }));

    // 输出恒为 NO_REPLY（投递由 Outbox 完成，cron 不再 announce 二投）
    assert.equal(result.output, 'NO_REPLY\n');
    assert.equal(result.data.ok, true);
    assert.equal(result.data.outbox, true);
    assert.equal(result.data.delivered, 'direct');
    assert.equal(result.data.delivery.sentParts, 1);
    assert.equal(result.data.fresh.length, 1);
    assert.equal(result.data.fresh[0].id, 'fissure:f1');
    // 只发一个文字 part，内容含命中事件
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, 'text');
    assert.match(calls[0].value, /古纪/u);
    assert.match(calls[0].value, /裂缝/u);

    // Outbox 记录：业务键按脱敏 targetKey + 事件集构造，不落原始 target
    const store = await readStore(dir);
    assert.equal(store.schemaVersion, 1);
    assert.equal(store.entries.length, 1);
    const entry = store.entries[0];
    assert.equal(entry.businessKey, worldStateBusinessKey(TARGET, [{
      id: 'fissure:f1', matches: [{ subscriptionId: 'sub-fissure' }],
    }], []));
    assert.equal(entry.target, undefined);
    assert.equal(entry.targetKey, targetKeyOf(TARGET));
    assert.match(entry.contentHash, /^[0-9a-f]{64}$/u);
    assert.equal(entry.status, 'delivered');
    assert.equal(entry.outcome, 'delivered');
    assert.equal(entry.parts[0].status, 'sent');
    assert.equal(entry.parts[0].attempts, 1);
    // 聚合通知用本卡片最早的有效业务 expiry（防止裂缝/警报过期后盲目补发）
    assert.equal(entry.expiresAt, iso(expiryMs));
    assert.equal(store.tombstones[entry.businessKey], entry.deliveredAt);
    // 原始 QQ target 不出现在 Outbox 文件里
    assert.equal((await readFile(path.join(dir, 'warframe-delivery-outbox.json'), 'utf8')).includes(TARGET), false);

    // 账本在入队后提交：seen/初始化已收敛
    const ledger = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(ledger.subscriptions[0].seen.includes('fissure:f1'), true);
    assert.equal(ledger.subscriptions[0].initialized, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('投递失败留 pending：下一轮即使 not_due 也先补投，同一业务键不重复入队', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-sub-outbox-retry-'));
  try {
    const expiryMs = Date.now() + 2 * 60 * 60 * 1000;
    const statePath = await writeLedger(dir, ledgerWith([fissureSubscription()]));
    const worldState = worldStateWith([fissure('f1', expiryMs)]);

    const failCalls = [];
    const first = await monitorTarget(TARGET, statePath, null, false, async () => {}, runOptions(dir, {
      mailer: async (part) => { failCalls.push(part); return { ok: false, category: 'timeout' }; },
      worldState,
    }));
    assert.equal(first.data.delivered, 'queued');
    assert.equal(first.data.delivery.failedParts, 1);
    assert.equal(failCalls.length, 1);
    let store = await readStore(dir);
    assert.equal(store.entries[0].status, 'pending');
    assert.equal(store.entries[0].outcome, 'failed');
    assert.equal(store.entries[0].parts[0].attempts, 1);

    // 第二轮：调度未到点（not_due）——补投发生在 not_due 短路之前
    const okCalls = [];
    const second = await monitorTarget(TARGET, statePath, null, false, async () => {}, runOptions(dir, {
      mailer: async (part) => { okCalls.push(part); return { ok: true }; },
      worldState,
    }));
    assert.equal(second.output, 'NO_REPLY\n');
    assert.equal(second.data.reason, 'not_due');
    assert.equal(second.data.outbox, true);
    assert.equal(second.data.delivery.sentParts, 1);
    assert.equal(okCalls.length, 1); // 只有欠账那条补投
    store = await readStore(dir);
    assert.equal(store.entries.length, 1); // 未重复入队
    assert.equal(store.entries[0].status, 'delivered');
    assert.equal(store.entries[0].parts[0].attempts, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('入队后账本写失败的恢复（同业务键重复）：不重复入队、不重复投递、账本收敛', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-sub-outbox-dedupe-'));
  try {
    const expiryMs = Date.now() + 2 * 60 * 60 * 1000;
    const originalLedger = ledgerWith([fissureSubscription()]);
    const statePath = await writeLedger(dir, originalLedger);
    const beforeFirst = JSON.stringify(originalLedger);
    const worldState = worldStateWith([fissure('f1', expiryMs)]);

    await monitorTarget(TARGET, statePath, null, false, async () => {}, runOptions(dir, {
      mailer: async () => ({ ok: false, category: 'network' }),
      worldState,
    }));

    // 模拟崩溃窗口：Outbox 已入队（pending），但账本写盘丢失（恢复成入队前的旧账本）
    await writeFile(statePath, beforeFirst, 'utf8');

    const calls = [];
    const second = await monitorTarget(TARGET, statePath, null, false, async () => {}, runOptions(dir, {
      mailer: async (part) => { calls.push(part); return { ok: true }; },
      worldState,
    }));
    // 补投发生在缺欠账轮：本轮先投 pending（调用 1 次），随后同业务键命中去重不再投
    assert.equal(calls.length, 1);
    assert.equal(second.data.outbox, true);
    assert.equal(second.data.delivery.sentParts, 1);
    const store = await readStore(dir);
    assert.equal(store.entries.length, 1); // 同一业务键只入队一次
    assert.equal(store.entries[0].status, 'delivered');
    assert.equal(store.entries[0].parts[0].attempts, 2); // 断网 1 次 + 补投 1 次
    // 账本最终收敛（seen 已写入）
    const ledger = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(ledger.subscriptions[0].seen.includes('fissure:f1'), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('聚合通知 expiresAt=最早业务 expiry：事件过期后不再盲目补发', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-sub-outbox-expiry-'));
  try {
    const expiryMs = Date.now() + 60 * 60 * 1000; // f1 一小时后过期
    const statePath = await writeLedger(dir, ledgerWith([fissureSubscription()]));
    const worldState = worldStateWith([fissure('f1', expiryMs), fissure('f2', Date.now() + 3 * 60 * 60 * 1000)]);

    await monitorTarget(TARGET, statePath, null, false, async () => {}, runOptions(dir, {
      mailer: async () => ({ ok: false, category: 'timeout' }),
      worldState,
    }));
    let store = await readStore(dir);
    assert.equal(store.entries.length, 1);
    assert.equal(store.entries[0].expiresAt, iso(expiryMs)); // 最早的业务 expiry
    assert.equal(store.entries[0].status, 'pending');

    // 把 Outbox 时钟推进到业务过期之后：下一轮补投直接把该记录置 expired，绝不发送过期内容
    const later = Date.now() + 2 * 60 * 60 * 1000;
    const calls = [];
    const second = await monitorTarget(TARGET, statePath, null, false, async () => {}, runOptions(dir, {
      mailer: async (part) => { calls.push(part); return { ok: true }; },
      worldState,
      clockNow: () => later,
    }));
    assert.equal(second.data.reason, 'not_due');
    assert.equal(calls.length, 0); // 不补发已过期事件
    assert.deepEqual(second.data.delivery.expiredIds, ['ob-1']);
    store = await readStore(dir);
    assert.equal(store.entries[0].status, 'expired');
    assert.equal(store.entries[0].outcome, 'expired');
    // 账本已提交（即便投递失败/过期也不再重复入队）
    const ledger = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(ledger.subscriptions[0].seen.includes('fissure:f1'), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('无业务 expiry（入侵）的聚合通知使用保守明确的默认 TTL（6h），且不落原始 owner/异常', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-sub-outbox-fallback-'));
  try {
    // 纯函数口径：无过期取 now+6h；有过期取最早
    const base = Date.now();
    assert.equal(earliestBusinessExpiry([], base), iso(base + WORLD_STATE_FALLBACK_TTL_MS));
    assert.equal(earliestBusinessExpiry([{ expiry: iso(base + 10_000) }, { expiry: iso(base + 60_000) }], base), iso(base + 10_000));
    assert.equal(earliestBusinessExpiry([{ expiry: '不是时间' }, {}], base), iso(base + WORLD_STATE_FALLBACK_TTL_MS));

    const statePath = await writeLedger(dir, ledgerWith([invasionSubscription()]));
    const worldState = worldStateWith([], {
      invasions: [{
        id: 'inv1', node: 'Vesper (Venus)',
        attacker: { reward: { items: ['Forma'] } }, defender: { reward: { items: ['Reactor'] } },
        rewardTypes: [], completion: 30,
      }],
    });
    const calls = [];
    const result = await monitorTarget(TARGET, statePath, null, false, async () => {}, runOptions(dir, {
      mailer: async (part) => { calls.push(part); return { ok: true }; },
      worldState,
    }));
    assert.equal(result.data.delivered, 'direct');
    assert.equal(calls.length, 1);
    assert.match(calls[0].value, /稀有入侵/u);
    const store = await readStore(dir);
    assert.equal(store.entries.length, 1);
    // 无业务 expiry：保守 6h（允许 ms 级误差）
    assert.ok(Math.abs(Date.parse(store.entries[0].expiresAt) - (Date.now() + WORLD_STATE_FALLBACK_TTL_MS)) < 60_000);
    // 不落盘原始 owner/异常原文（异常只留固定类别）
    const raw = await readFile(path.join(dir, 'warframe-delivery-outbox.json'), 'utf8');
    assert.equal(raw.includes(OWNER), false);
    assert.deepEqual(store.entries[0].attemptsLog.map((item) => item.category), ['delivered']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('业务键：fresh 与 closing 区分，事件集合稳定（排序无关）且不含原始 target', () => {
  const freshKey = worldStateBusinessKey(TARGET, [
    { id: 'a', matches: [{ subscriptionId: 'sub-1' }] },
    { id: 'b', matches: [{ subscriptionId: 'sub-2' }] },
  ], []);
  // 事件顺序无关（集合语义）
  assert.equal(freshKey, worldStateBusinessKey(TARGET, [
    { id: 'b', matches: [{ subscriptionId: 'sub-2' }] },
    { id: 'a', matches: [{ subscriptionId: 'sub-1' }] },
  ], []));
  // fresh 与 closing 区分
  assert.notEqual(freshKey, worldStateBusinessKey(TARGET, [{ id: 'a' }, { id: 'b' }], [{ id: 'c' }]));
  assert.notEqual(freshKey, worldStateBusinessKey(TARGET, [], [{ id: 'a' }, { id: 'b' }]));
  // 同一事件后来被新建订阅再次命中，不能被旧业务键/tombstone 吞掉
  assert.notEqual(
    worldStateBusinessKey(TARGET, [{ id: 'a', matches: [{ subscriptionId: 'sub-1' }] }], []),
    worldStateBusinessKey(TARGET, [{ id: 'a', matches: [{ subscriptionId: 'sub-2' }] }], []),
  );
  // 不含原始 target
  assert.equal(freshKey.includes(TARGET), false);
  assert.match(freshKey, /^worldstate:[0-9a-f]{64}:[0-9a-f]{64}$/u);
});

test('默认 QQ 发送结果必须含 messageId 且无 provider error 才算服务端接受', () => {
  assert.deepEqual(classifyQQSendOutput('notice\n{"messageId":"m-1"}'), { ok: true, category: null });
  assert.deepEqual(classifyQQSendOutput('{"error":"rejected"}'), { ok: false, category: 'provider_rejected' });
  assert.deepEqual(classifyQQSendOutput('{"ok":true}'), { ok: false, category: 'missing_message_id' });
  assert.deepEqual(classifyQQSendOutput('not-json'), { ok: false, category: 'invalid_response' });
  assert.deepEqual(classifyQQSendOutput('{broken'), { ok: false, category: 'invalid_response' });
});

test('monitor（announce）路径不启用 Outbox：保持原输出与先记账行为', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-sub-outbox-monitor-'));
  try {
    const expiryMs = Date.now() + 2 * 60 * 60 * 1000;
    const statePath = await writeLedger(dir, ledgerWith([fissureSubscription()]));
    const worldState = worldStateWith([fissure('f1', expiryMs)]);
    // directDeliver = null：monitor 路径，不进入 Outbox 事务链
    const result = await monitorTarget(TARGET, statePath, null, false, null, runOptions(dir, {
      mailer: async () => { throw new Error('monitor 路径不应投递'); },
      worldState,
    }));
    assert.equal(result.output.includes('星际战甲订阅提醒'), true);
    assert.equal(result.data.outbox, undefined);
    await assert.rejects(access(path.join(dir, 'warframe-delivery-outbox.json')), /ENOENT/u);
    // 账本照旧先提交
    const ledger = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(ledger.subscriptions[0].seen.includes('fissure:f1'), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('默认 Outbox 路径与订阅状态同目录（warframe-delivery-outbox.json）', () => {
  const statePath = path.join(os.tmpdir(), 'state', 'warframe-subscriptions.json');
  assert.equal(defaultOutboxPath(statePath), path.join(os.tmpdir(), 'state', 'warframe-delivery-outbox.json'));
});
