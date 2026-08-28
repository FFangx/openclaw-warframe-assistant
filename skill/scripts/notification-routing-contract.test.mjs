import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, utimes, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  OUTBOX_FILE_NAME,
  ROUTING_FAMILIES,
  analyzeOutboxEntries,
  assertFamilyMediaTransport,
  assertFamilyOfBusinessKey,
  classifyBusinessKey,
  proactiveFamilyKeys,
  validateRoutingRegistry,
} from './notification-routing-contract.mjs';
import { createOutbox, targetKeyOf } from './notification-outbox.mjs';
import { defaultOutboxPath as dropsDefaultOutboxPath, dropsBusinessKey, monitorDrops } from './drops.mjs';
import {
  defaultOutboxPath as subscriptionsDefaultOutboxPath,
  weeklyBusinessKey,
  weeklyPartsFor,
  worldStateBusinessKey,
} from './subscriptions.mjs';
import {
  defaultOutboxPath as wishlistDefaultOutboxPath,
  manageWishlist,
  monitorWishlist,
  orderIdentity,
  wishlistHitBusinessKey,
} from './wishlist.mjs';

// R5 通知路由合同测试：验证 operations.md「订阅调度」记录的四类主动通知（掉落 / 世界状态 /
// 周常周报 / 愿望单）经共享 Outbox 的路由事实——业务键前缀、共享文件、monitor/dry-run 例外、
// 周报主图无损运输。合同本身是结构化数据（notification-routing-contract.mjs），
// 生产路径从合同取前缀/文件名/运输模式；本测试用合同校验真实投递路径，
// 缺失、重复、未知、错路由（或与合同不符的生产路径）都会失败。

const TARGET = 'qqbot:c2c:tester';
const BASE = Date.parse('2026-08-25T00:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const tk = targetKeyOf(TARGET);
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

const CATALOG = [{ id: 'item-foo', slug: 'foo_prime_set', name: 'Foo Prime Set', zhName: '福 Prime 套装' }];
const ORDER = { id: 'o-1', itemId: 'item-foo', slug: 'foo_prime_set', type: 'sell', platinum: 20, perTrade: 1, seller: 'seller-a' };
const IDENTITY = { target: TARGET, ownerId: 'member-a', ownerName: '测试用户' };

// ---------- 注册表本身 ----------

test('路由注册表：恰好四类主动家族 + legacy 迁移键；前缀唯一；周报无损 / 愿望单擦除', () => {
  const summary = validateRoutingRegistry();
  assert.deepEqual(summary.proactive, ['drops', 'worldstate', 'weekly', 'wishlist']);
  assert.deepEqual(proactiveFamilyKeys(), ['drops', 'worldstate', 'weekly', 'wishlist']);
  assert.deepEqual(Object.keys(ROUTING_FAMILIES), ['drops', 'worldstate', 'weekly', 'wishlist', 'legacy']);
  for (const key of summary.proactive) {
    const family = ROUTING_FAMILIES[key];
    assert.equal(family.prefix, `${key}:`);
    assert.equal(family.outboxFileName, OUTBOX_FILE_NAME);
    assert.equal(family.businessKey.targetKey, 'sha256');
    assert.ok(['event', 'digest'].includes(family.businessKey.payload));
    assert.ok(family.entryPoints.length > 0);
    for (const point of family.entryPoints) {
      assert.equal(typeof point.command, 'string');
      assert.equal(typeof point.usesOutbox, 'boolean');
    }
  }
  // 文档化例外（entryPoints）：monitor/announce 与 dry-run 不经 Outbox；deliver 经 Outbox
  assert.deepEqual(ROUTING_FAMILIES.drops.entryPoints.map((p) => [p.command, p.usesOutbox]),
    [['monitor', true], ['monitor --dry-run', false]]);
  assert.equal(ROUTING_FAMILIES.drops.entryPoints[1].outbound, false);
  assert.deepEqual(ROUTING_FAMILIES.worldstate.entryPoints.map((p) => [p.command, p.usesOutbox]),
    [['monitor', false], ['deliver', true]]);
  assert.deepEqual(ROUTING_FAMILIES.weekly.entryPoints.map((p) => [p.command, p.usesOutbox]),
    [['monitor', false], ['deliver', true]]);
  assert.deepEqual(ROUTING_FAMILIES.wishlist.entryPoints.map((p) => [p.command, p.usesOutbox]),
    [['monitor', false], ['calibrate', false], ['gateway_start', false], ['deliver', true], ['deliver --dry-run', false]]);
  assert.equal(ROUTING_FAMILIES.wishlist.entryPoints.at(-1).outbound, false);
  // 周报主图无损 + 好货卡普通；愿望单终态擦除，其余家族不擦除
  assert.equal(ROUTING_FAMILIES.weekly.media.primary, 'lossless');
  assert.equal(ROUTING_FAMILIES.weekly.media.rest, 'media');
  assert.equal(ROUTING_FAMILIES.wishlist.redactOnTerminal, true);
  for (const key of ['drops', 'worldstate', 'weekly']) assert.equal(ROUTING_FAMILIES[key].redactOnTerminal, false);
  assert.equal(ROUTING_FAMILIES.legacy.kind, 'migration');
});

test('注册表校验（负向）：缺失、未知、前缀重复、周报非无损、愿望单未擦除、入口点矛盾都抛错', () => {
  // 缺失：文档化家族被删 → 抛错（contract 缺项）
  const missingWeekly = { ...ROUTING_FAMILIES };
  delete missingWeekly.weekly;
  assert.throws(() => validateRoutingRegistry(missingWeekly), /缺失.*weekly/u);
  // 未知：注册表里出现文档外家族 → 抛错（contract 多项）
  assert.throws(
    () => validateRoutingRegistry({ ...ROUTING_FAMILIES, extra: { ...ROUTING_FAMILIES.drops, key: 'extra' } }),
    /未知/u,
  );
  // 重复：两个家族共用同一前缀 → 抛错
  const duplicatePrefix = { ...ROUTING_FAMILIES, weekly: { ...ROUTING_FAMILIES.weekly, prefix: ROUTING_FAMILIES.drops.prefix } };
  assert.throws(() => validateRoutingRegistry(duplicatePrefix), /重复/u);
  // 周报主图不得退化为普通媒体
  const mediaWeekly = { ...ROUTING_FAMILIES, weekly: { ...ROUTING_FAMILIES.weekly, media: { primary: 'media', rest: 'media' } } };
  assert.throws(() => validateRoutingRegistry(mediaWeekly), /lossless/u);
  // 愿望单必须终态擦除
  const noRedact = { ...ROUTING_FAMILIES, wishlist: { ...ROUTING_FAMILIES.wishlist, redactOnTerminal: false } };
  assert.throws(() => validateRoutingRegistry(noRedact), /redactOnTerminal/u);
  // 入口点重复
  const duplicateEntry = { ...ROUTING_FAMILIES, weekly: { ...ROUTING_FAMILIES.weekly, entryPoints: [ROUTING_FAMILIES.weekly.entryPoints[0], ROUTING_FAMILIES.weekly.entryPoints[0]] } };
  assert.throws(() => validateRoutingRegistry(duplicateEntry), /重复入口点/u);
  // 禁止 outbound 却声明经 Outbox
  const badOutbound = {
    ...ROUTING_FAMILIES,
    wishlist: {
      ...ROUTING_FAMILIES.wishlist,
      entryPoints: ROUTING_FAMILIES.wishlist.entryPoints.map((p) => (p.command === 'deliver' ? { ...p, outbound: false } : p)),
    },
  };
  assert.throws(() => validateRoutingRegistry(badOutbound), /禁止 outbound/u);
  // 前缀实际路由到别的家族（内错路由）
  const misrouted = { ...ROUTING_FAMILIES, weekly: { ...ROUTING_FAMILIES.weekly, prefix: ROUTING_FAMILIES.wishlist.prefix } };
  assert.throws(() => validateRoutingRegistry(misrouted), /实际路由/u);
});

// ---------- 业务键分类 ----------

test('业务键分类：四类家族键可识别；未知前缀、畸形键、错误 payload 被拒绝', () => {
  const weeklyKey = weeklyBusinessKey(TARGET, 'weekly:2026-08-24', ['sub-a']);
  const classified = classifyBusinessKey(weeklyKey);
  assert.equal(classified.known, true);
  assert.equal(classified.familyKey, 'weekly');
  assert.equal(classified.valid, true);
  assert.equal(classified.targetKey, tk);
  assert.equal(classified.payload, weeklyKey.split(':').at(-1));
  // 未知前缀
  const unknown = classifyBusinessKey(`unknown:${tk}:${DIGEST_B}`);
  assert.equal(unknown.known, false);
  assert.equal(unknown.valid, false);
  assert.equal(unknown.reason, 'unknown_prefix');
  // 畸形键
  assert.equal(classifyBusinessKey('weekly:nope').reason, 'malformed');
  assert.equal(classifyBusinessKey('').reason, 'malformed');
  // 已知前缀但 payload 非摘要（weekly/worldstate/wishlist 要求 digest）
  const badPayload = classifyBusinessKey(`weekly:${tk}:not-a-digest`);
  assert.equal(badPayload.known, true);
  assert.equal(badPayload.valid, false);
  assert.equal(badPayload.reason, 'bad_payload');
  // event payload 家族（drops/legacy）：任何非空载荷都合法
  assert.equal(classifyBusinessKey(`drops:${tk}:${iso(BASE)}`).valid, true);
  assert.equal(classifyBusinessKey(`legacy:${tk}:old-1`).valid, true);
});

// ---------- 生产路径与合同的对应关系 ----------

test('四类生产路径业务键都路由到自己的家族；错路由断言抛错', () => {
  const dropsKey = dropsBusinessKey(TARGET, iso(BASE));
  const worldstateKey = worldStateBusinessKey(TARGET, [{ id: 'f1', matches: [{ subscriptionId: 'sub-a' }] }], []);
  const weeklyKey = weeklyBusinessKey(TARGET, 'weekly:2026-08-24', ['sub-a']);
  const wishlistKey = wishlistHitBusinessKey(TARGET, [{ orderIdentity: orderIdentity(ORDER), wishIds: ['WABC1'] }]);
  assert.match(dropsKey, /^drops:[0-9a-f]{64}:.+$/u);
  assert.match(worldstateKey, /^worldstate:[0-9a-f]{64}:[0-9a-f]{64}$/u);
  assert.match(weeklyKey, /^weekly:[0-9a-f]{64}:[0-9a-f]{64}$/u);
  assert.match(wishlistKey, /^wishlist:[0-9a-f]{64}:[0-9a-f]{64}$/u);
  for (const [key, family] of [
    [dropsKey, 'drops'], [worldstateKey, 'worldstate'], [weeklyKey, 'weekly'], [wishlistKey, 'wishlist'],
  ]) {
    assertFamilyOfBusinessKey(key, family);
  }
  // 错路由：按别的家族断言同一业务键必须失败
  assert.throws(() => assertFamilyOfBusinessKey(dropsKey, 'weekly'), /路由/u);
  assert.throws(() => assertFamilyOfBusinessKey(worldstateKey, 'drops'), /路由/u);
  assert.throws(() => assertFamilyOfBusinessKey(weeklyKey, 'wishlist'), /路由/u);
  assert.throws(() => assertFamilyOfBusinessKey(wishlistKey, 'weekly'), /路由/u);
  // 未知键（不属于任何文档化家族）也必须失败
  assert.throws(() => assertFamilyOfBusinessKey(`unknown:${tk}:${DIGEST_B}`, 'drops'), /不在路由合同内/u);
});

test('共享 Outbox：四个家族的 defaultOutboxPath 指向同一份状态文件（warframe-delivery-outbox.json）', () => {
  const dir = path.join(os.tmpdir(), 'state');
  const outboxPath = path.join(dir, OUTBOX_FILE_NAME);
  assert.equal(dropsDefaultOutboxPath(path.join(dir, 'warframe-drops.json')), outboxPath);
  assert.equal(subscriptionsDefaultOutboxPath(path.join(dir, 'warframe-subscriptions.json')), outboxPath);
  assert.equal(wishlistDefaultOutboxPath(path.join(dir, 'warframe-wishlist.json')), outboxPath);
  // 三个家族对同一状态目录推导出同一个文件（共享 Outbox，业务键前缀区分）
  assert.equal(dropsDefaultOutboxPath(path.join(dir, 'a.json')), subscriptionsDefaultOutboxPath(path.join(dir, 'b.json')));
});

test('周报媒体运输合同：主图 lossless、好货卡 media、文字降级不适用；违例被拒', () => {
  const parts = weeklyPartsFor({ output: 'MEDIA:main.png\nMEDIA:deals.png\n', data: { mediaUrl: 'main.png', dealsMediaUrl: 'deals.png' } });
  // 好货卡 part 缺省 transport（Outbox 归一为 'media'），与合同「主图 lossless、其余 media」等效
  assert.deepEqual(parts.map((part) => part.transport ?? 'media'), ['lossless', 'media']);
  assertFamilyMediaTransport('weekly', parts);
  assertFamilyMediaTransport('weekly', [{ kind: 'text', value: '渲染失败退文字' }]);
  // 负向：主图不带 lossless
  assert.throws(() => assertFamilyMediaTransport('weekly', [{ kind: 'media', value: 'main.png' }]), /lossless/u);
  // 负向：主图普通、好货卡却 lossless（顺序/首位违例）
  assert.throws(() => assertFamilyMediaTransport('weekly', [
    { kind: 'media', value: 'main.png', transport: 'media' },
    { kind: 'media', value: 'deals.png', transport: 'lossless' },
  ]), /违例/u);
  // 负向：未知运输模式
  assert.throws(() => assertFamilyMediaTransport('weekly', [{ kind: 'media', value: 'x.png', transport: 'email' }]), /未知/u);
  // 负向：周报规则（lossless 首位）不适用于其他家族
  assert.throws(() => assertFamilyMediaTransport('drops', parts), /违例/u);
});

test('Outbox 记录审计：四类真实记录全绿；未知/错形状/擦除/运输违例逐条标记', () => {
  const weeklyKey = weeklyBusinessKey(TARGET, 'weekly:2026-08-24', ['sub-a']);
  const wishlistKey = wishlistHitBusinessKey(TARGET, [{ orderIdentity: orderIdentity(ORDER), wishIds: ['WABC1'] }]);
  const real = analyzeOutboxEntries([
    { id: 'ob-1', businessKey: dropsBusinessKey(TARGET, iso(BASE)), redactOnTerminal: false, parts: [{ kind: 'text', value: '掉落说明' }] },
    { id: 'ob-2', businessKey: worldStateBusinessKey(TARGET, [{ id: 'f1', matches: [{ subscriptionId: 'sub-a' }] }], []), redactOnTerminal: false, parts: [{ kind: 'media', value: 'a.png' }] },
    { id: 'ob-3', businessKey: weeklyKey, redactOnTerminal: false, parts: [{ kind: 'media', value: 'main.png', transport: 'lossless' }, { kind: 'media', value: 'deals.png' }] },
    { id: 'ob-4', businessKey: wishlistKey, redactOnTerminal: true, parts: [{ kind: 'text', value: '含卖家信息的通知' }] },
    { id: 'ob-5', businessKey: `legacy:${tk}:old-1`, redactOnTerminal: false, parts: [{ kind: 'media', value: 'legacy.png' }] },
  ]);
  assert.equal(real.length, 5);
  for (const item of real) {
    assert.equal(item.known, true);
    assert.equal(item.valid, true);
    assert.deepEqual(item.violations, []);
  }

  const broken = analyzeOutboxEntries([
    { id: 'x1', businessKey: `unknown:${tk}:${DIGEST_B}`, redactOnTerminal: false, parts: [] },
    { id: 'x2', businessKey: `weekly:${tk}:${DIGEST_A}`, redactOnTerminal: true, parts: [{ kind: 'media', value: 'main.png', transport: 'media' }] },
    { id: 'x3', businessKey: `weekly:${tk}:${DIGEST_A}`, redactOnTerminal: false, parts: [{ kind: 'media', value: 'main.png' }, { kind: 'media', value: 'deals.png', transport: 'lossless' }] },
    { id: 'x4', businessKey: `wishlist:${tk}:${DIGEST_B}`, redactOnTerminal: true, parts: [{ kind: 'media', value: 'x.png', transport: 'email' }] },
    { id: 'x5', businessKey: `weekly:${tk}:not-a-digest`, redactOnTerminal: false, parts: [] },
    { id: 'x6', businessKey: `wishlist:${tk}:${DIGEST_B}`, redactOnTerminal: false, parts: [{ kind: 'text', value: 'x' }] },
  ]);
  const codeOf = (item) => item.violations.map((violation) => violation.code || violation);
  assert.deepEqual(codeOf(broken[0]), ['unknown_prefix']);
  assert.deepEqual(codeOf(broken[1]), ['redact_mismatch', 'part_transport']);
  assert.deepEqual(codeOf(broken[2]), ['part_transport', 'part_transport']);
  assert.equal(broken[2].violations[0].expected, 'lossless');
  assert.equal(broken[2].violations[1].expected, 'media');
  assert.deepEqual(codeOf(broken[3]), ['unknown_transport']);
  assert.equal(broken[3].violations[0].actual, 'email');
  assert.deepEqual(codeOf(broken[4]), ['bad_payload']);
  assert.deepEqual(codeOf(broken[5]), ['redact_mismatch']);
});

// ---------- 文档化例外（monitor / dry-run）的行为验证 ----------

const DROP_ITEM = '/Lotus/Types/Items/MiscItems/OrokinCell';
const SYNCED_AT = new Date(Number.parseInt('64a00000', 16) * 1000).toISOString();

async function writeSnapshot(alecaDir, count, mtimeMs) {
  const snapshotPath = path.join(alecaDir, 'lastData.dat');
  await writeFile(snapshotPath, JSON.stringify({
    LastInventorySync: { $oid: '64a000000000000000000001' },
    MiscItems: [{ ItemType: DROP_ITEM, ItemCount: count }],
  }), 'utf8');
  const at = new Date(mtimeMs);
  await utimes(snapshotPath, at, at);
  return snapshotPath;
}

async function dropsFixture(dir) {
  const alecaDir = path.join(dir, 'aleca');
  await mkdir(path.join(alecaDir, 'cachedData', 'json'), { recursive: true });
  const ledgerPath = path.join(dir, 'subscriptions.json');
  await writeFile(ledgerPath, JSON.stringify({
    subscriptions: [{ id: 'sub-1', target: TARGET, enabled: true, type: 'drops', filter: '全部', createdAt: SYNCED_AT }],
  }), 'utf8');
  return { alecaDir, ledgerPath };
}

function dropsOptions(dir, overrides = {}) {
  return {
    statePath: path.join(dir, 'drops.json'),
    ledgerPath: path.join(dir, 'subscriptions.json'),
    target: TARGET,
    cardDir: null,
    alecaDir: path.join(dir, 'aleca'),
    dryRun: false,
    attachOptions: { slugs: new Map(), quoteFetcher: async () => null, priceIndex: {} },
    skipIcons: true,
    ...overrides,
  };
}

test('掉落 --dry-run 例外：只输出预览，不落 Outbox、不调用 QQ outbound', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-routing-drops-dryrun-'));
  const previous = process.env.WARFRAME_OFFLINE;
  process.env.WARFRAME_OFFLINE = '1';
  try {
    const t1 = Date.now() - 120_000;
    const t2 = Date.now();
    await dropsFixture(dir);
    await writeSnapshot(path.join(dir, 'aleca'), 3, t1);
    // 先建基线（生产 monitor 的第一轮不推送）
    const first = await monitorDrops(dropsOptions(dir));
    assert.equal(first.data.reason, 'baseline_created');
    // 快照变化后 --dry-run：预览 JSON、无 Outbox 文件、outbound 从未被调用
    await writeSnapshot(path.join(dir, 'aleca'), 6, t2);
    const outboundCalls = [];
    const preview = await monitorDrops(dropsOptions(dir, {
      dryRun: true,
      mailer: async (part) => { outboundCalls.push(part); return { ok: true }; },
    }));
    const parsed = JSON.parse(preview.output);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.matched.length, 1);
    assert.equal(outboundCalls.length, 0);
    await assert.rejects(access(dropsDefaultOutboxPath(dropsOptions(dir).statePath)), /ENOENT/u);
  } finally {
    if (previous == null) delete process.env.WARFRAME_OFFLINE;
    else process.env.WARFRAME_OFFLINE = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('愿望单 deliver --dry-run 例外：即使提供 outbox/mailer 也不入队、不调 outbound，只输出预览', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-routing-wishlist-dryrun-'));
  const statePath = path.join(dir, 'wishlist.json');
  const outbox = createOutbox({ memory: true });
  const clock = () => iso(BASE);
  try {
    const manage = await manageWishlist('愿望 福 Prime ≤ 20', IDENTITY, statePath, {
      render: false,
      catalogFetcher: async () => CATALOG,
      fetchItemMetadata: async () => ({}),
    });
    assert.equal(manage.ok, true);
    const outboundCalls = [];
    const result = await monitorWishlist(TARGET, statePath, null, true, {
      ownerId: IDENTITY.ownerId,
      skipWebSocket: true,
      forceRest: true,
      fetchOrders: async () => [ORDER],
      outbox,
      mailer: async (part) => { outboundCalls.push(part); return { ok: true }; },
      now: clock,
    });
    // 只输出预览：命中文本直接返回，无 outbox 标记、无投递、无入队
    assert.match(result.output, /愿望单命中/u);
    assert.equal(result.data.outbox, undefined);
    assert.equal(result.data.delivery, undefined);
    assert.equal(outboundCalls.length, 0);
    assert.equal((await outbox.snapshot()).entries.length, 0, 'dry-run 绝不入队');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
