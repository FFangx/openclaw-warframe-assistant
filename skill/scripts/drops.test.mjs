import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  attachPrices, defaultDeltaLedgerPath, defaultOutboxPath, describeDrop, marketDisplayImagePath,
  monitorDrops, withLock,
} from './drops.mjs';
import { targetKeyOf } from './notification-outbox.mjs';
import { DELTA_LEDGER_CONSUMERS, createDeltaLedger } from './account-delta-ledger.mjs';
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

// R15 第五片：基线/事件/游标都在助手本地 delta 账本里，与 drops 状态文件同目录
const deltaLedgerPathOf = (dir) => defaultDeltaLedgerPath(path.join(dir, 'drops.json'));
const readDeltaLedger = async (dir) => JSON.parse(await readFile(deltaLedgerPathOf(dir), 'utf8'));

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

test('未接挑战与已显示挑战的裂罅都匹配 Veiled 商品，成交查询不按等级过滤', async () => {
  const cases = [
    ['RawRifleRandomMod', 'Rifle'], ['LotusRifleRandomModRare', 'Rifle'],
    ['RawShotgunRandomMod', 'Shotgun'], ['LotusShotgunRandomModRare', 'Shotgun'],
    ['RawPistolRandomMod', 'Pistol'], ['LotusPistolRandomModRare', 'Pistol'],
    ['RawMeleeRandomMod', 'Melee'], ['PlayerMeleeWeaponRandomModRare', 'Melee'],
    ['RawModularMeleeRandomMod', 'Zaw'], ['LotusModularMeleeRandomModRare', 'Zaw'],
    ['RawModularPistolRandomMod', 'Kitgun'], ['LotusModularPistolRandomModRare', 'Kitgun'],
    ['RawArchgunRandomMod', 'Archgun'], ['LotusArchgunRandomModRare', 'Archgun'],
    ['RawSentinelWeaponRandomMod', 'Companion Weapon'],
  ];
  const drops = cases.map(([tail, name]) => ({
    uniqueName: `/Lotus/Upgrades/Mods/Randomized/${tail}`,
    englishName: `${name} Riven Mod`, displayName: `${name} 裂罅 Mod`,
    gained: 1, tradable: false, isMod: true,
  }));
  const slugs = new Map(cases.map(([, name]) => [
    `${name} Riven Mod (Veiled)`.toLowerCase().replace(/\s+/gu, ''),
    { slug: `${name.toLowerCase().replace(/ /gu, '_')}_riven_mod_(veiled)` },
  ]));
  const queries = [];
  const attachOptions = {
    slugs, priceIndex: {},
    quoteFetcher: async (slug, rankZero) => {
      queries.push(slug);
      assert.equal(rankZero, false);
      return { platinum: 12, basis: '90days', dailyVolume: 100 };
    },
  };
  // 单张卡最多查 12 行；分两批覆盖目录中的全部 15 个路径身份。
  await attachPrices(drops.slice(0, 8), attachOptions);
  await attachPrices(drops.slice(8), attachOptions);
  assert.equal(queries.length, 15);
  for (const drop of drops) {
    assert.equal(drop.tradable, true);
    assert.equal(drop.platinum, 12);
    assert.match(drop.marketSlug, /_riven_mod_\(veiled\)$/u);
  }
  const card = buildDropsAlertCard({ drops, syncedAt: SYNCED_AT });
  assert.doesNotMatch(card.html, /不可交易/u);
  assert.match(card.html, /90日中位/u);
});

test('两种 Veiled 裂罅统计失败仍保持可交易，未知随机 Mod 不误套商品价', async () => {
  const makeDrop = (tail) => ({
    uniqueName: `/Lotus/Upgrades/Mods/Randomized/${tail}`,
    englishName: 'Pistol Riven Mod', displayName: '手枪裂罅 Mod', gained: 1,
    tradable: false, isMod: true,
  });
  const raw = makeDrop('RawPistolRandomMod');
  const challengeShown = makeDrop('LotusPistolRandomModRare');
  const unknown = makeDrop('RawUnknownRandomMod');
  const options = {
    slugs: new Map([['pistolrivenmod(veiled)', { slug: 'pistol_riven_mod_(veiled)' }]]),
    quoteFetcher: async () => { throw new Error('offline'); },
    priceIndex: {},
  };
  await attachPrices([raw, challengeShown, unknown], options);
  for (const drop of [raw, challengeShown]) {
    assert.equal(drop.tradable, true);
    assert.equal(drop.platinum, null);
    assert.equal(drop.marketSlug, 'pistol_riven_mod_(veiled)');
    assert.match(buildDropsAlertCard({ drops: [drop], syncedAt: SYNCED_AT }).html, /暂无可靠估值/u);
  }
  for (const drop of [unknown]) {
    assert.equal(drop.marketSlug, undefined);
    assert.equal(drop.platinum, undefined);
  }
  await attachPrices([raw], { ...options, priceIndex: { 'pistolrivenmod(veiled)': { p0: 9, p0Basis: 'closed' } } });
  assert.equal(raw.platinum, 9);
  assert.equal(raw.marketBasis, 'daily-closed');
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
  // 状态文件：版本升 3，旧基线/欠账字段不再出现（基线与事件流已迁入 delta 账本）
  const dropsState = JSON.parse(await readFile(monitorOptions(dir).statePath, 'utf8'));
  assert.equal(dropsState.version, 3);
  assert.equal(dropsState.pendingDelivery, undefined);
  assert.equal(dropsState.baseline, undefined);
  // delta 账本：最小脱敏基线 + 两个随基线固定注册的独立消费者游标
  const ledgerStore = await readDeltaLedger(dir);
  assert.equal(ledgerStore.kind, 'account-delta-ledger');
  assert.equal(ledgerStore.schemaVersion, 1);
  assert.deepEqual(ledgerStore.baseline.payload.inventory.MiscItems, [{ ItemType: ITEM, ItemCount: 6 }]);
  assert.deepEqual(Object.keys(ledgerStore.baseline.payload.inventory), ['MiscItems']);
  assert.ok(ledgerStore.consumers.drops.cursor >= 1);
  assert.deepEqual(ledgerStore.consumers.weekly, { cursor: 0, ackedAt: null });
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

testOffline('入队后基线/游标写失败的恢复（同业务键重复）：不重复入队、不重复投递', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'warframe-drops-outbox-dedupe-'));
  const t1 = Date.now() - 120_000;
  const t2 = Date.now();
  await fixture(dir, { count: 3, mtimeMs: t1 });
  await monitorDrops(monitorOptions(dir));
  const ledgerAfterFirst = JSON.parse(await readFile(deltaLedgerPathOf(dir), 'utf8'));
  const stateAfterFirst = JSON.parse(await readFile(monitorOptions(dir).statePath, 'utf8'));

  await writeSnapshot(path.join(dir, 'aleca'), 6, t2);
  await monitorDrops(monitorOptions(dir, {
    mailer: async () => ({ ok: false, category: 'network' }),
  }));

  // 模拟崩溃窗口：Outbox 已入队（pending），但 delta 账本的基线/游标与闸门状态都没写成功
  await writeFile(deltaLedgerPathOf(dir), JSON.stringify(ledgerAfterFirst), 'utf8');
  await writeFile(monitorOptions(dir).statePath, JSON.stringify(stateAfterFirst), 'utf8');

  const calls = [];
  await monitorDrops(monitorOptions(dir, {
    mailer: async (part) => { calls.push(part); return { ok: true }; },
  }));
  const store = JSON.parse(await readFile(defaultOutboxPath(monitorOptions(dir).statePath), 'utf8'));
  assert.equal(store.entries.length, 1); // 同一业务键只入队一次
  assert.equal(store.entries[0].status, 'delivered');
  assert.equal(store.entries[0].parts[0].attempts, 2); // 断网 1 次 + 恢复 1 次
  assert.equal(calls.length, 1); // 恢复轮只补投一次
  // 账本最终收敛到最新基线，且本消费者游标已越过该事件
  const ledgerStore = await readDeltaLedger(dir);
  assert.deepEqual(ledgerStore.baseline.payload.inventory.MiscItems, [{ ItemType: ITEM, ItemCount: 6 }]);
  assert.equal(ledgerStore.consumers.drops.cursor, ledgerStore.nextSeq - 1);
});

testOffline('旧 pendingDelivery 兼容迁移：不丢欠账、TTL 48h 保持、超期丢弃、状态收敛 v3', async () => {  const dir = await mkdtemp(path.join(os.tmpdir(), 'warframe-drops-outbox-migrate-'));
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
  assert.equal(dropsState.version, 3);
  assert.equal(dropsState.pendingDelivery, undefined);
  assert.equal(dropsState.baseline, undefined);

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

// ---------- R15 第五片：drops 与 weekly 共享同一个 delta 账本 ----------

testOffline('drops 与 weekly 消费同一账本：drops 确认后 weekly 仍看到同一批 eventId，审计面不带载荷', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'warframe-drops-ledger-shared-'));
  const t1 = Date.now() - 120_000;
  const t2 = Date.now();
  await fixture(dir, { count: 3, mtimeMs: t1 });
  const ledgerPath = deltaLedgerPathOf(dir);
  const weeklyLedger = createDeltaLedger({ statePath: ledgerPath });

  const first = await monitorDrops(monitorOptions(dir));
  assert.equal(first.data.reason, 'baseline_created');
  // weekly 在变化之前接入（水位起步）：之后的变化它必须能看到
  assert.deepEqual((await weeklyLedger.read(DELTA_LEDGER_CONSUMERS.WEEKLY)).eventIds, []);

  await writeSnapshot(path.join(dir, 'aleca'), 6, t2);
  const calls = [];
  const second = await monitorDrops(monitorOptions(dir, {
    mailer: async (part) => { calls.push(part); return { ok: true }; },
  }));
  assert.equal(second.data.delivered, 'direct');
  assert.equal(second.data.ledgerEvents, 1);
  assert.equal(second.data.ledgerGap, false);

  // 审计面只有计数：不得带 eventId / 事件载荷 / 基线
  const audit = JSON.stringify(second.data);
  assert.equal(audit.includes('acct-delta'), false);
  assert.equal(audit.includes('baseline'), false);

  // drops 已推进自己的游标，weekly 的游标独立且仍能读到同一批 eventId
  const store = await readDeltaLedger(dir);
  assert.equal(store.consumers.drops.cursor, store.nextSeq - 1);
  assert.equal(store.consumers.weekly.cursor, 0);
  const eventIds = store.events.map((event) => event.eventId);
  assert.deepEqual(eventIds, ['acct-delta-v1-1']);
  const weeklyBatch = await weeklyLedger.read(DELTA_LEDGER_CONSUMERS.WEEKLY);
  assert.deepEqual(weeklyBatch.eventIds, eventIds);
  assert.deepEqual(weeklyBatch.events.map((event) => event.entity), [ITEM]);
  await weeklyLedger.ack(DELTA_LEDGER_CONSUMERS.WEEKLY, weeklyBatch.uptoSeq);
  assert.deepEqual((await weeklyLedger.read(DELTA_LEDGER_CONSUMERS.WEEKLY)).eventIds, []);
  assert.equal((await readDeltaLedger(dir)).consumers.drops.cursor, store.consumers.drops.cursor);
});

testOffline('delta 账本损坏：诚实降级不推送、不覆盖原文件，欠账仍补投；修复后不重复通知', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'warframe-drops-ledger-corrupt-'));
  const t1 = Date.now() - 180_000;
  const t2 = Date.now() - 60_000;
  const t3 = Date.now();
  await fixture(dir, { count: 3, mtimeMs: t1 });
  await monitorDrops(monitorOptions(dir));
  const healthyLedger = await readFile(deltaLedgerPathOf(dir), 'utf8');

  // 一次投递失败：欠账留在 Outbox（pending）
  await writeSnapshot(path.join(dir, 'aleca'), 6, t2);
  const failed = await monitorDrops(monitorOptions(dir, { mailer: async () => ({ ok: false, category: 'timeout' }) }));
  assert.equal(failed.data.delivered, 'queued');

  // 账本损坏：不推送新掉落、不改写文件，但既有欠账照旧补投
  await writeFile(deltaLedgerPathOf(dir), '{ broken json', 'utf8');
  await writeSnapshot(path.join(dir, 'aleca'), 9, t3);
  const calls = [];
  const degraded = await monitorDrops(monitorOptions(dir, {
    mailer: async (part) => { calls.push(part); return { ok: true }; },
  }));
  assert.equal(degraded.output, 'NO_REPLY\n');
  assert.equal(degraded.data.ok, false);
  assert.equal(degraded.data.reason, 'delta_ledger_unavailable');
  assert.equal(degraded.data.degraded, 'corrupt');
  assert.equal(calls.length, 1); // 只有欠账那一条
  assert.equal(await readFile(deltaLedgerPathOf(dir), 'utf8'), '{ broken json');
  const outboxPath = defaultOutboxPath(monitorOptions(dir).statePath);
  let store = JSON.parse(await readFile(outboxPath, 'utf8'));
  assert.equal(store.entries.length, 1);
  assert.equal(store.entries[0].status, 'delivered');

  // 修复账本后恢复消费：未确认事件重放，但同一业务键不重复通知
  await writeFile(deltaLedgerPathOf(dir), healthyLedger, 'utf8');
  const recoveredCalls = [];
  const recovered = await monitorDrops(monitorOptions(dir, {
    mailer: async (part) => { recoveredCalls.push(part); return { ok: true }; },
  }));
  assert.equal(recovered.output, 'NO_REPLY\n');
  assert.equal(recovered.data.ok, true);
  assert.equal(recoveredCalls.length, 0);
  store = JSON.parse(await readFile(outboxPath, 'utf8'));
  assert.equal(store.entries.length, 1);
  assert.equal((await readDeltaLedger(dir)).baseline.payload.inventory.MiscItems[0].ItemCount, 9);
});
