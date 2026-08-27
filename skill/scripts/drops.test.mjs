import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  attachPrices, defaultOutboxPath, describeDrop, marketDisplayImagePath, monitorDrops, withLock,
} from './drops.mjs';
import { targetKeyOf } from './notification-outbox.mjs';
import { buildDropsAlertCard } from './warframe-cards.mjs';

const TARGET = 'qqbot:c2c:tester';
const ITEM = '/Lotus/Types/Items/MiscItems/OrokinCell';
// oid 前 8 位是 Unix 时间戳：快照 syncedAt 由此推导，与 drops.mjs readSnapshot 同口径
const SYNCED_AT = new Date(Number.parseInt('64a00000', 16) * 1000).toISOString();

async function writeSnapshot(alecaDir, count, mtimeMs) {
  const snapshotPath = path.join(alecaDir, 'lastData.dat');
  await writeFile(snapshotPath, JSON.stringify({
    LastInventorySync: { $oid: '64a000000000000000000001' },
    MiscItems: [{ ItemType: ITEM, ItemCount: count }],
  }), 'utf8');
  const at = new Date(mtimeMs);
  await utimes(snapshotPath, at, at);
  return snapshotPath;
}

async function fixture(dir, { count, mtimeMs, ledger = true } = {}) {
  const alecaDir = path.join(dir, 'aleca');
  await mkdir(path.join(alecaDir, 'cachedData', 'json'), { recursive: true });
  const snapshotPath = await writeSnapshot(alecaDir, count, mtimeMs);
  const ledgerPath = path.join(dir, 'subscriptions.json');
  if (ledger) {
    await writeFile(ledgerPath, JSON.stringify({
      subscriptions: [{ id: 'sub-1', target: TARGET, enabled: true, type: 'drops', filter: '全部', createdAt: SYNCED_AT }],
    }), 'utf8');
  }
  return { alecaDir, snapshotPath, ledgerPath };
}

function monitorOptions(dir, overrides = {}) {
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

test('掉落监测会自动回收被超时进程遗留的陈旧锁', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'warframe-drops-lock-'));
  const statePath = path.join(dir, 'drops.json');
  const lockPath = `${statePath}.lock`;
  await writeFile(lockPath, '', 'utf8');
  const old = new Date(Date.now() - 5 * 60 * 1000);
  await utimes(lockPath, old, old);

  const value = await withLock(statePath, async () => 'recovered');
  assert.equal(value, 'recovered');
  await assert.rejects(stat(lockPath), (error) => error?.code === 'ENOENT');
});

test('遗物掉落提醒显示入库状态', () => {
  const uniqueName = '/Lotus/Types/Game/Projections/LithT1Bronze';
  const drop = describeDrop(uniqueName, 1, new Map([[uniqueName, {
    englishName: 'Lith T1 Intact', displayName: '古纪 T1 遗物（完整）', category: 'Relics',
    rarity: null, tradable: true, isPrime: false, ducats: null, imageName: null, vaulted: true,
  }]]));
  assert.equal(drop.isRelic, true);
  assert.equal(drop.vaulted, true);
  assert.match(buildDropsAlertCard({ drops: [drop], total: 1, syncedAt: new Date().toISOString() }).html, /已入库/u);
});

test('掉落卡日均成交量明确标注为交易笔数', () => {
  const card = buildDropsAlertCard({
    drops: [{
      uniqueName: '/Test/Arcane', displayName: '次要·无情', gained: 1,
      tradable: true, isArcane: true, rarityZh: '稀有', platinum: 1,
      marketBasis: 'today', dailyVolume: 79.4,
    }],
    total: 1,
    syncedAt: new Date().toISOString(),
  });
  assert.match(card.html, /日均 79\.4 笔交易/u);
});

test('市场部件使用副图，主蓝图和套装继续使用成品主图', () => {
  assert.equal(marketDisplayImagePath({
    icon: 'items/images/en/nyx_prime_systems.png',
    thumb: 'items/images/en/thumbs/nyx_prime_systems.128x128.png',
    subIcon: 'sub_icons/warframe/prime_systems_128x128.png',
  }), 'sub_icons/warframe/prime_systems_128x128.png');
  assert.equal(marketDisplayImagePath({
    icon: 'items/images/en/gyre_prime_blueprint.webp',
    thumb: 'items/images/en/thumbs/gyre_prime_blueprint.128x128.webp',
    subIcon: 'sub_icons/blueprint_128x128.png',
  }), 'items/images/en/thumbs/gyre_prime_blueprint.128x128.webp');
  assert.equal(marketDisplayImagePath({
    icon: 'items/images/en/nyx_prime_set.png',
    thumb: 'items/images/en/thumbs/nyx_prime_set.128x128.png',
    subIcon: null,
  }), 'items/images/en/thumbs/nyx_prime_set.128x128.png');
});

test('Market 已知问号占位素材被拒绝，正常素材不受影响', () => {
  const placeholderHash = 'fd671126fd4051e8e3addc13ae56d1f0';
  const placeholderIcon = (slug) => `items/images/en/${slug}.${placeholderHash}.png`;
  const placeholderThumb = (slug) => `items/images/en/thumbs/${slug}.${placeholderHash}.128x128.png`;
  assert.equal(marketDisplayImagePath({
    icon: placeholderIcon('granums_nemesis'), thumb: placeholderThumb('granums_nemesis'), subIcon: null,
  }), null);
  assert.equal(marketDisplayImagePath({
    icon: placeholderIcon('worms_torment'), thumb: placeholderThumb('worms_torment'), subIcon: null,
  }), null);
  assert.equal(marketDisplayImagePath({
    icon: 'items/images/en/normal.png',
    thumb: 'items/images/en/thumbs/normal.128x128.png',
    subIcon: `sub_icons/prime_systems.${placeholderHash}.png`,
  }), null);
  assert.equal(marketDisplayImagePath({
    icon: 'items/images/en/lingering_torment.e63fea80ff3cb599d0840090716ad730.png',
    thumb: 'items/images/en/thumbs/lingering_torment.e63fea80ff3cb599d0840090716ad730.128x128.png',
    subIcon: null,
  }), 'items/images/en/thumbs/lingering_torment.e63fea80ff3cb599d0840090716ad730.128x128.png');
});

test('掉落查价覆盖全部卡片行、限制并发并只用真实成交索引兜底', async () => {
  const drops = Array.from({ length: 9 }, (_, index) => ({
    uniqueName: `/Test/Item${index + 1}`,
    displayName: `物品 ${index + 1}`,
    englishName: `Item ${index + 1}`,
    tradable: true,
    isMod: index >= 3,
    isArcane: false,
  }));
  const slugs = new Map(drops.map((drop, index) => [drop.englishName.toLowerCase().replace(/\s+/gu, ''), {
    slug: `item_${index + 1}`,
    zhName: null,
  }]));
  let active = 0;
  let maxActive = 0;
  const queried = [];
  const quoteFetcher = async (slug) => {
    queried.push(slug);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    const number = Number(slug.split('_').at(-1));
    return number <= 6 ? { platinum: number, basis: '90days', dailyVolume: number } : null;
  };
  const priceIndex = {
    item7: { p0: 7.5, p0Basis: 'closed' },
    item8: { p0: 8.5, p0Basis: 'closed' },
    item9: { p0: 9.5, p0Basis: 'sell' },
  };

  await attachPrices(drops, { slugs, quoteFetcher, priceIndex });

  assert.equal(queried.length, 9);
  assert.ok(maxActive <= 3);
  assert.equal(drops[5].platinum, 6);
  assert.equal(drops[6].platinum, 7.5);
  assert.equal(drops[6].marketBasis, 'daily-closed');
  assert.equal(drops[7].platinum, 8.5);
  assert.equal(drops[8].platinum, null);
});

test('AlecaFrame tradable:false 假阴性：精确 Market 命中即可交易并查价', async () => {
  const key = (name) => String(name).toLowerCase().replace(/\s+/gu, '');
  const slugs = new Map([[key("Granum's Nemesis"), { slug: 'granums_nemesis', zhName: '格拉努之劲敌' }]]);
  const queried = [];
  const drop = {
    uniqueName: '/Lotus/Upgrades/Mods/Railjack/Gunnery/VidarCorpusKiller',
    englishName: "Granum's Nemesis",
    displayName: '未收录物品（VidarCorpusKiller）',
    tradable: false,
    isMod: true,
    isArcane: false,
  };
  await attachPrices([drop], {
    slugs,
    quoteFetcher: async (slug) => { queried.push(slug); return { platinum: 18, basis: '90days', dailyVolume: 2.4 }; },
    priceIndex: {},
  });
  assert.equal(drop.tradable, true);
  assert.equal(drop.marketSlug, 'granums_nemesis');
  assert.deepEqual(queried, ['granums_nemesis']);
  assert.equal(drop.platinum, 18);
  assert.equal(drop.marketBasis, '90days');
  assert.equal(drop.dailyVolume, 2.4);
  assert.equal(drop.displayName, '格拉努之劲敌');
});

test('无精确 Market 命中的 tradable:false 掉落保持不可交易、不查价', async () => {
  const key = (name) => String(name).toLowerCase().replace(/\s+/gu, '');
  const slugs = new Map([[key("Granum's Nemesis"), { slug: 'granums_nemesis', zhName: '格拉努之劲敌' }]]);
  const queried = [];
  const drops = [{
    uniqueName: '/Lotus/Upgrades/Mods/Railjack/Gunnery/VidarCorpusKiller',
    englishName: 'Granum Nemesis',
    displayName: '格拉努之劲敌',
    tradable: false,
    isMod: true,
    isArcane: false,
  }, {
    uniqueName: '/Lotus/Upgrades/Mods/Unknown/NoEntry',
    englishName: 'Definitely Not On Market',
    displayName: '未收录物品（NoEntry）',
    tradable: false,
    isMod: true,
    isArcane: false,
  }];
  await attachPrices(drops, {
    slugs,
    quoteFetcher: async (slug) => { queried.push(slug); return { platinum: 1 }; },
    priceIndex: {},
  });
  for (const drop of drops) {
    assert.equal(drop.tradable, false);
    assert.equal(drop.marketSlug, undefined);
    assert.equal(drop.platinum, undefined);
  }
  assert.deepEqual(queried, []);
});

test('无精确条目的可交易掉落仍走真实 closed 成交索引兜底', async () => {
  const queried = [];
  const drop = {
    uniqueName: '/Lotus/Upgrades/Mods/Unknown/TradableNoEntry',
    englishName: 'Settled Tradable Mod',
    displayName: '有成交的可交易 Mod',
    tradable: true,
    isMod: true,
    isArcane: false,
  };
  await attachPrices([drop], {
    slugs: new Map(),
    quoteFetcher: async (slug) => { queried.push(slug); return { platinum: 1 }; },
    priceIndex: { settledtradablemod: { p0: 12, p0Basis: 'closed' } },
  });
  assert.equal(drop.marketSlug, undefined);
  assert.equal(drop.platinum, 12);
  assert.equal(drop.marketBasis, 'daily-closed');
  assert.deepEqual(queried, []);
});

test('战甲强化 Mod 不被 /Powersuits/ 路径误判为战甲，显示官方中文名', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'warframe-drops-catalog-'));
  await mkdir(path.join(dir, 'cachedData', 'json'), { recursive: true });
  const augment = '/Lotus/Powersuits/Berserker/GrappleAugmentCard';
  const frame = '/Lotus/Powersuits/Wukong/WukongPrime';
  await writeFile(path.join(dir, 'cachedData', 'json', 'Mods.json'), JSON.stringify([
    { uniqueName: augment, name: 'Swing Line', rarity: 'Rare', tradable: true },
  ]), 'utf8');
  await writeFile(path.join(dir, 'cachedData', 'json', 'Warframes.json'), JSON.stringify([
    { uniqueName: frame, name: 'Wukong Prime', rarity: null, tradable: false },
  ]), 'utf8');
  await writeFile(path.join(dir, 'cachedData', 'json', 'lang.json'), JSON.stringify({
    [augment]: { zh: { name: '摆荡钩索' } },
    [frame]: { zh: { name: '悟空 Prime' } },
  }), 'utf8');
  const previous = process.env.WARFRAME_OFFLINE;
  process.env.WARFRAME_OFFLINE = '1';
  try {
    const { loadCatalog } = await import('./drops.mjs');
    const catalog = await loadCatalog(dir);
    assert.equal(catalog.get(augment).displayName, '摆荡钩索');
    // 真战甲仍按硬规则保留英文名，不受本修复影响
    assert.equal(catalog.get(frame).displayName, 'Wukong Prime');
    const drop = describeDrop(augment, 1, catalog);
    assert.equal(drop.displayName, '摆荡钩索');
    assert.equal(drop.isMod, true);
  } finally {
    if (previous == null) delete process.env.WARFRAME_OFFLINE;
    else process.env.WARFRAME_OFFLINE = previous;
  }
});

// ---------- 通知 Outbox 集成（R3 第一片：掉落通知链） ----------
// Offline 包装：禁止目录/lang 在线兜底和真实缓存读写，保证测试不触碰真实状态。

function testOffline(name, fn) {
  test(name, async () => {
    const previous = process.env.WARFRAME_OFFLINE;
    process.env.WARFRAME_OFFLINE = '1';
    try { await fn(); }
    finally {
      if (previous == null) delete process.env.WARFRAME_OFFLINE;
      else process.env.WARFRAME_OFFLINE = previous;
    }
  });
}

testOffline('掉落新情报：先入统一 Outbox 再投递，业务键=同步事件，输出恒为 NO_REPLY', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'warframe-drops-outbox-flow-'));
  const t1 = Date.now() - 120_000;
  const t2 = Date.now();
  await fixture(dir, { count: 3, mtimeMs: t1 });

  const first = await monitorDrops(monitorOptions(dir));
  assert.equal(first.output, 'NO_REPLY\n');
  assert.equal(first.data.reason, 'baseline_created');

  const calls = [];
  await writeSnapshot(path.join(dir, 'aleca'), 6, t2);
  const second = await monitorDrops(monitorOptions(dir, {
    mailer: async (part) => { calls.push(part); return { ok: true }; },
  }));
  assert.equal(second.output, 'NO_REPLY\n');
  assert.equal(second.data.ok, true);
  assert.equal(second.data.delivered, 'direct');
  assert.equal(second.data.matched.length, 1);
  // 文字兜底链路：只发一个文字 part；内容包含掉落名称与数量
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'text');
  assert.match(calls[0].value, /Orokin Cell/u);
  assert.match(calls[0].value, /×3/u);
  // Outbox 记录：schemaVersion/业务键/内容哈希/parts/时间/尝试/结果/终态齐全
  const outboxPath = defaultOutboxPath(monitorOptions(dir).statePath);
  const store = JSON.parse(await readFile(outboxPath, 'utf8'));
  assert.equal(store.schemaVersion, 1);
  assert.equal(store.entries.length, 1);
  const entry = store.entries[0];
  assert.equal(entry.businessKey, `drops:${targetKeyOf(TARGET)}:${SYNCED_AT}`);
  assert.equal(entry.target, undefined);
  assert.equal(entry.targetKey, targetKeyOf(TARGET));
  assert.match(entry.contentHash, /^[0-9a-f]{64}$/u);
  assert.equal(entry.status, 'delivered');
  assert.equal(entry.outcome, 'delivered');
  assert.equal(entry.parts[0].status, 'sent');
  assert.equal(entry.parts[0].attempts, 1);
  assert.ok(entry.createdAt && entry.expiresAt && entry.deliveredAt);
  assert.equal(store.tombstones[entry.businessKey], entry.deliveredAt);
  // 状态文件：版本升 2，旧欠账字段不再出现
  const dropsState = JSON.parse(await readFile(monitorOptions(dir).statePath, 'utf8'));
  assert.equal(dropsState.version, 2);
  assert.equal(dropsState.pendingDelivery, undefined);
  assert.ok(dropsState.baseline[ITEM]);
});

testOffline('投递失败留在 Outbox 欠账，快照未变的下轮仍补投且不重发已成功 part', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'warframe-drops-outbox-retry-'));
  const t1 = Date.now() - 120_000;
  const t2 = Date.now();
  await fixture(dir, { count: 3, mtimeMs: t1 });
  await monitorDrops(monitorOptions(dir));

  await writeSnapshot(path.join(dir, 'aleca'), 6, t2);
  const failCalls = [];
  const failed = await monitorDrops(monitorOptions(dir, {
    mailer: async (part) => { failCalls.push(part); return { ok: false, category: 'timeout' }; },
  }));
  assert.equal(failed.data.delivered, 'queued');
  let store = JSON.parse(await readFile(defaultOutboxPath(monitorOptions(dir).statePath), 'utf8'));
  assert.equal(store.entries[0].status, 'pending');
  assert.equal(store.entries[0].outcome, 'failed');
  assert.equal(store.entries[0].parts[0].attempts, 1);
  assert.deepEqual(store.entries[0].attemptsLog.map((item) => item.category), ['failed']);
  assert.equal(store.entries[0].attemptsLog[0].resultCode, 'timeout');

  // 快照没有新变化（等价 Gateway 重启后的下一轮）：补投发生在 mtime 闸门之前
  const okCalls = [];
  const recovered = await monitorDrops(monitorOptions(dir, {
    mailer: async (part) => { okCalls.push(part); return { ok: true }; },
  }));
  assert.equal(recovered.output, 'NO_REPLY\n');
  assert.equal(recovered.data.reason, 'unchanged');
  assert.equal(okCalls.length, 1); // 只有欠账那条文字
  assert.equal(okCalls[0].kind, 'text');
  store = JSON.parse(await readFile(defaultOutboxPath(monitorOptions(dir).statePath), 'utf8'));
  assert.equal(store.entries[0].status, 'delivered');
  assert.equal(store.entries[0].parts[0].attempts, 2);
});

testOffline('入队后基线写失败的恢复（同业务键重复）：不重复入队、不重复投递', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'warframe-drops-outbox-dedupe-'));
  const t1 = Date.now() - 120_000;
  const t2 = Date.now();
  await fixture(dir, { count: 3, mtimeMs: t1 });
  await monitorDrops(monitorOptions(dir));
  const baselineAfterFirst = JSON.parse(await readFile(monitorOptions(dir).statePath, 'utf8'));

  await writeSnapshot(path.join(dir, 'aleca'), 6, t2);
  await monitorDrops(monitorOptions(dir, {
    mailer: async () => ({ ok: false, category: 'network' }),
  }));

  // 模拟崩溃窗口：Outbox 已入队（pending），但状态文件仍停留在旧基线（基线写丢失）
  await writeFile(monitorOptions(dir).statePath, JSON.stringify(baselineAfterFirst), 'utf8');

  const calls = [];
  await monitorDrops(monitorOptions(dir, {
    mailer: async (part) => { calls.push(part); return { ok: true }; },
  }));
  const store = JSON.parse(await readFile(defaultOutboxPath(monitorOptions(dir).statePath), 'utf8'));
  assert.equal(store.entries.length, 1); // 同一业务键只入队一次
  assert.equal(store.entries[0].status, 'delivered');
  assert.equal(store.entries[0].parts[0].attempts, 2); // 断网 1 次 + 恢复 1 次
  assert.equal(calls.length, 1); // 恢复轮只补投一次
  // 基线最终收敛到最新
  const state = JSON.parse(await readFile(monitorOptions(dir).statePath, 'utf8'));
  assert.equal(state.baseline[ITEM], 6);
});

testOffline('旧 pendingDelivery 兼容迁移：不丢欠账、TTL 48h 保持、超期丢弃、状态收敛 v2', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'warframe-drops-outbox-migrate-'));
  const t1 = Date.now() - 120_000;
  await fixture(dir, { count: 3, mtimeMs: t1 });
  const snapshotPath = path.join(dir, 'aleca', 'lastData.dat');
  const { mtimeMs } = await stat(snapshotPath);
  const legacyQueue = [
    { id: 'old-1', message: 'MEDIA:C:\\legacy\\drops.png\n补充说明', queuedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
    { id: 'old-2', message: '早该过期的欠账', queuedAt: new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString() },
  ];
  await writeFile(monitorOptions(dir).statePath, JSON.stringify({
    version: 1, updatedAt: new Date().toISOString(),
    baseline: { [ITEM]: 3 }, lastMtimeMs: mtimeMs, lastSyncedAt: SYNCED_AT,
    pendingDelivery: legacyQueue,
  }), 'utf8');

  const calls = [];
  const result = await monitorDrops(monitorOptions(dir, {
    mailer: async (part) => { calls.push(part); return { ok: true }; },
  }));
  assert.equal(result.output, 'NO_REPLY\n');
  // 媒体 + 文字两个 part 逐项投递（迁移后立即补投）
  assert.deepEqual(calls.map((part) => part.kind), ['media', 'text']);
  assert.equal(calls[0].value, 'C:\\legacy\\drops.png');
  assert.equal(calls[1].value, '补充说明');

  const outboxPath = defaultOutboxPath(monitorOptions(dir).statePath);
  const store = JSON.parse(await readFile(outboxPath, 'utf8'));
  assert.equal(store.entries.length, 1);
  const entry = store.entries[0];
  assert.equal(entry.businessKey, `legacy:${targetKeyOf(TARGET)}:old-1`);
  assert.equal(entry.status, 'delivered');
  // TTL 保持：按原 queuedAt 起算 48h，不因迁移重置
  assert.equal(entry.expiresAt, new Date(Date.parse(legacyQueue[0].queuedAt) + 48 * 60 * 60 * 1000).toISOString());
  const dropsState = JSON.parse(await readFile(monitorOptions(dir).statePath, 'utf8'));
  assert.equal(dropsState.version, 2);
  assert.equal(dropsState.pendingDelivery, undefined);

  // 幂等：再次运行同一旧文件（若写回丢失）不会产生重复记录
  const secondCalls = [];
  await writeFile(monitorOptions(dir).statePath, JSON.stringify({
    version: 1, updatedAt: new Date().toISOString(),
    baseline: { [ITEM]: 3 }, lastMtimeMs: mtimeMs, lastSyncedAt: SYNCED_AT,
    pendingDelivery: legacyQueue,
  }), 'utf8');
  await monitorDrops(monitorOptions(dir, {
    mailer: async (part) => { secondCalls.push(part); return { ok: true }; },
  }));
  const storeAfterSecond = JSON.parse(await readFile(outboxPath, 'utf8'));
  assert.equal(storeAfterSecond.entries.length, 1);
  assert.equal(secondCalls.length, 0); // 去重命中：不再补投
});
