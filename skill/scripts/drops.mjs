#!/usr/bin/env node

// 掉落监测：只读 AlecaFrame 本机快照，diff 出两次同步之间的新增物品，
// 按订阅条件过滤后推送 QQ 图片卡。管理命令走 subscriptions.mjs 的账本
// （type: 'drops'），本文件只负责 monitor 与基线状态。
//
// 设计要点（不要回退）：
// - 每分钟 cron 唤醒时先 stat lastData.dat 的 mtime，与基线一致就输出 NO_REPLY，
//   不解密、不联网、不调模型。
// - 增量不依赖 deltas.dat 的重置语义（它何时清零由 AlecaFrame 决定），
//   而是自己保存上一次快照的「路径→数量」全量基线做 diff，MOD/赋能一并覆盖。
// - 首次运行只建立基线不推送，避免把整个仓库当成新掉落。
// - 玩家 OID、物品实例 ID、原始 JSON 不进输出。

import { createDecipheriv } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripDataUriReplacer } from './wfdata.mjs';
import { promisify } from 'node:util';
import { buildDropsAlertCard, renderWarframeCard } from './warframe-cards.mjs';

const execFileAsync = promisify(execFile);

const SNAPSHOT_KEY = Buffer.from([76, 69, 79, 45, 65, 76, 69, 67, 9, 69, 79, 45, 65, 76, 69, 67]);
const SNAPSHOT_IV = Buffer.from([49, 50, 70, 71, 66, 51, 54, 45, 76, 69, 51, 45, 113, 61, 57, 0]);
const MARKET_ORDERS_URL = 'https://api.warframe.market/v2/orders/item';
const MARKET_ITEMS_URL = 'https://api.warframe.market/v2/items';
const FETCH_TIMEOUT_MS = 20_000;
// 单次汇报最多联网查价的物品数，防止一次性入库大量物品时打爆市场 API
const MAX_PRICED_ITEMS = 6;
const MAX_CARD_ROWS = 12;
// 投递欠账保留 48 小时：网络恢复后自动补投，超期丢弃防无限堆积
const PENDING_TTL_MS = 48 * 60 * 60 * 1000;
// cron 最长运行 120 秒；超过两分钟的锁不可能再属于正常任务，可安全回收。
// 防止进程被 cron 强制终止后遗留 .lock，令后续监测永久报“状态正忙”。
const LOCK_STALE_MS = 2 * 60 * 1000;
// 与插件同源：本地脚本无权直调 gateway，发消息走 openclaw CLI；测试可用环境变量注入假 CLI
const OPENCLAW_CLI = process.env.OPENCLAW_CLI_PATH
  || path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'openclaw', 'openclaw.mjs');

// 快照里参与掉落 diff 的库存分组：数量类 + MOD/赋能类
const COUNTED_GROUPS = ['MiscItems', 'Recipes', 'Consumables', 'FusionTreasures', 'RawUpgrades'];

const COMPONENT_ZH = {
  Blueprint: '蓝图', Chassis: '机体蓝图', Neuroptics: '头部神经光元蓝图', Systems: '系统蓝图',
  Barrel: '枪管', Receiver: '枪机', Stock: '枪托', Blade: '刀刃', Handle: '握柄', Hilt: '剑柄',
  Grip: '握柄', Link: '连接器', Ornament: '饰物', String: '弓弦', UpperLimb: '上弓臂', LowerLimb: '下弓臂',
  Head: '头部', Gauntlet: '拳套', Disc: '圆盘', Stars: '星镖', Chain: '锁链', Boot: '靴部',
  // 双持武器部件是复数形态（Akjagara Barrels/Receivers/Links），漏了会英文穿帮上卡
  Barrels: '枪管', Receivers: '枪机', Links: '连接器', Blades: '刀刃', Handles: '握柄',
  OrokinCell: '奥罗金电池',
};
const RARITY_ZH = { Common: '常见', Uncommon: '罕见', Rare: '稀有', Legendary: '传说' };

const normalize = (value) => String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ');

function defaultAlecaDir() {
  return process.env.ALECAFRAME_DATA_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'AlecaFrame');
}

function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) result._.push(token);
    else {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next != null && !next.startsWith('--')) { result[key] = next; index += 1; }
      else result[key] = true;
    }
  }
  return result;
}

// ---------- 快照读取与计数 ----------

async function readSnapshot(alecaDir) {
  const file = path.join(alecaDir, 'lastData.dat');
  const encrypted = await readFile(file);
  let text;
  if (encrypted[0] === 0x7b) {
    text = encrypted.toString('utf8');
  } else {
    const decipher = createDecipheriv('aes-128-cbc', SNAPSHOT_KEY, SNAPSHOT_IV);
    text = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }
  const envelope = JSON.parse(text.replace(/\0+$/gu, ''));
  // 两种格式：旧版包 InventoryJson 信封；新版（2026-08 起）顶层直接就是库存对象
  const inventoryText = envelope.InventoryJson || envelope.InventoryJSON;
  const inventory = inventoryText
    ? (typeof inventoryText === 'string' ? JSON.parse(inventoryText) : inventoryText)
    : (envelope.MiscItems || envelope.RawUpgrades ? envelope : null);
  if (!inventory) throw new Error('账号快照中没有库存数据');
  const fileStat = await stat(file);
  const oid = inventory.LastInventorySync?.$oid || inventory.LastInventorySync?.oid || '';
  const oidSeconds = /^[0-9a-f]{24}$/iu.test(oid) ? Number.parseInt(oid.slice(0, 8), 16) : 0;
  const syncedAt = oidSeconds > 0 ? new Date(oidSeconds * 1000).toISOString() : fileStat.mtime.toISOString();
  return { inventory, syncedAt, fileMtimeMs: fileStat.mtimeMs };
}

// 把快照压成「物品路径 → 总数量」。Upgrades（已装等级的 MOD/赋能）按条目数计 1。
function countInventory(inventory) {
  const counts = {};
  const add = (type, amount) => {
    if (!type) return;
    counts[type] = (counts[type] || 0) + amount;
  };
  for (const group of COUNTED_GROUPS) {
    for (const item of Array.isArray(inventory[group]) ? inventory[group] : []) {
      add(item?.ItemType, item?.ItemCount != null ? Number(item.ItemCount) || 0 : 1);
    }
  }
  for (const item of Array.isArray(inventory.Upgrades) ? inventory.Upgrades : []) add(item?.ItemType, 1);
  return counts;
}

// ---------- 本地目录：路径 → 名称/分类/稀有度 ----------

const CATALOG_FILES = [
  'Mods.json', 'Arcanes.json', 'Warframes.json', 'Primary.json', 'Secondary.json', 'Melee.json',
  'Sentinels.json', 'SentinelWeapons.json', 'Arch-Gun.json', 'Arch-Melee.json', 'Archwing.json',
  'Misc.json', 'Resources.json', 'Gear.json', 'Pets.json', 'Railjack.json', 'Relics.json',
];

async function loadCatalog(alecaDir) {
  const { getLangTable, readAlecaJson } = await import('./wfdata.mjs');
  // 本地缺失走在线兑底；词典全挂时用英文名兑底
  const lang = await getLangTable({ alecaDir }).catch(() => ({}));
  const zhName = (uniqueName) => lang?.[uniqueName]?.zh?.name || null;
  const byUniqueName = new Map();
  const componentEntries = [];
  for (const filename of CATALOG_FILES) {
    const items = await readAlecaJson(`json/${filename}`, { alecaDir });
    if (!Array.isArray(items)) continue;
    const category = filename.replace(/\.json$/iu, '');
    for (const item of items) {
      if (!item?.uniqueName) continue;
      const isWarframe = category === 'Warframes' || String(item.uniqueName).includes('/Powersuits/');
      const isPrime = Boolean(item.isPrime) || /\bPrime\b/u.test(item.name || '');
      if (!byUniqueName.has(item.uniqueName)) {
        byUniqueName.set(item.uniqueName, {
          englishName: item.name || '',
          // 战甲名按硬规则保留英文
          displayName: isWarframe ? (item.name || '未收录战甲') : (zhName(item.uniqueName) || item.name || '未收录物品'),
          category,
          rarity: item.rarity || null,
          tradable: item.tradable !== false,
          isPrime,
          ducats: Number(item.ducats ?? item.primeSellingPrice) || null,
          imageName: item.imageName || null,
        });
      }
      for (const component of item.components || []) {
        if (component?.uniqueName) componentEntries.push({ item, component, isWarframe, isPrime });
      }
    }
  }
  // 组件放到第二遍注册：像红化结晶这类资源常出现在武器配方里，
  // 顶层正名必须赢过「某武器 某材料」这种组件式命名
  for (const { item, component, isWarframe, isPrime } of componentEntries) {
    if (byUniqueName.has(component.uniqueName)) continue;
    const official = zhName(component.uniqueName);
    // catalog 的部件名可能带空格（如 "Lower Limb"），词典 key 统一按去空格匹配
    const componentKey = String(component.name || '').replace(/\s+/gu, '');
    const parent = isWarframe ? (item.name || '') : (zhName(item.uniqueName) || item.name || '');
    const typed = COMPONENT_ZH[componentKey] ? `${parent} ${COMPONENT_ZH[componentKey]}`.trim() : null;
    const entry = {
      englishName: `${item.name || ''} ${component.name || ''}`.trim(),
      // 官方词典有完整名就直接用，避免「高级 Naramon 晶体 Naramon 晶体」式重复拼接
      displayName: official || typed || `${parent} ${component.name || ''}`.trim() || '未收录部件',
      category: 'Component',
      rarity: null,
      tradable: component.tradable !== false,
      isPrime: isPrime || /\bPrime\b/u.test(component.uniqueName),
      // 目录自带杜卡德价值（与 primeSellingPrice 同值）；非 Prime 部件无此字段
      ducats: Number(component.ducats ?? component.primeSellingPrice) || null,
      imageName: component.imageName || item.imageName || null,
      // 杜卡德安全清仓需要知道「保留 N 套」究竟要留几件；
      // 双持/拳套等部件 itemCount=2，不能一律按 1 处理。
      parentUniqueName: item.uniqueName || null,
      parentEnglishName: item.name || null,
      parentDisplayName: parent || item.name || null,
      setRequired: Math.max(1, Number(component.itemCount) || 1),
    };
    byUniqueName.set(component.uniqueName, entry);
    // 遗物开出的是蓝图（…HelmetBlueprint），目录部件是成品（…HelmetComponent）——差一个后缀，
    // 不注册别名就会「未收录物品（Sevagoth Prime Helmet Blueprint）」（2026-08-04 真实掉落实锤）
    const blueprintAlias = component.uniqueName.replace(/Component$/u, 'Blueprint');
    if (blueprintAlias !== component.uniqueName && !byUniqueName.has(blueprintAlias)) {
      byUniqueName.set(blueprintAlias, entry);
    }
  }
  return byUniqueName;
}

// 目录未收录时给一个可读的中文兜底，不把内部路径亮给用户
function fallbackName(uniqueName) {
  const tail = String(uniqueName).split('/').at(-1) || '';
  const spaced = tail.replace(/([a-z])([A-Z])/gu, '$1 $2');
  return `未收录物品（${spaced}）`;
}

function describeDrop(uniqueName, gained, catalog) {
  const meta = catalog.get(uniqueName) || null;
  const englishName = meta?.englishName || '';
  const isPrime = meta ? meta.isPrime : /Prime/iu.test(uniqueName);
  const isMod = meta?.category === 'Mods';
  const isArcane = meta?.category === 'Arcanes';
  const rarity = meta?.rarity || null;
  return {
    uniqueName,
    gained,
    displayName: meta?.displayName || fallbackName(uniqueName),
    englishName,
    category: meta?.category || 'Unknown',
    rarity,
    rarityZh: rarity ? (RARITY_ZH[rarity] || rarity) : null,
    tradable: meta ? meta.tradable : false,
    isPrime,
    isMod,
    isArcane,
    ducats: meta?.ducats ?? null,
    imageName: meta?.imageName ?? null,
    // 「值得关注」：Prime 部件 / 稀有以上 MOD / 赋能。资源类刷屏就靠它挡
    notable: isPrime || isArcane || (isMod && (rarity === 'Rare' || rarity === 'Legendary')),
  };
}

// ---------- 订阅过滤 ----------

// filter 为空 = 只推「值得关注」的；写了筛选词则按词匹配
function dropMatches(drop, filter) {
  // 社区别名转官方词，保证能命中英文名/官方中文名
  const value = normalize(filter).toLowerCase().replace(/福马/gu, 'forma').replace(/土豆/gu, '反应堆 催化剂');
  if (!value) return drop.notable;
  if (/全部|所有|all/iu.test(value)) return true;
  const wantPrime = /prime|部件|p卡|派姆/iu.test(value);
  const wantMod = /mod|模组|卡/iu.test(value) && !/p卡/iu.test(value);
  const wantArcane = /赋能|arcane/iu.test(value);
  const wantRare = /稀有|传说|珍贵|rare|legendary/iu.test(value);
  if (wantPrime && drop.isPrime) return true;
  if (wantArcane && drop.isArcane) return true;
  if (wantMod && drop.isMod && (!wantRare || drop.rarity === 'Rare' || drop.rarity === 'Legendary')) return true;
  if (wantRare && !wantMod && !wantPrime && !wantArcane && (drop.rarity === 'Rare' || drop.rarity === 'Legendary' || drop.isPrime)) return true;
  // 具体物品名匹配（中文显示名或英文名包含筛选词）
  const haystack = `${drop.displayName} ${drop.englishName}`.toLowerCase();
  const words = value.split(' ').filter((word) => word && !/^(?:prime|部件|mod|模组|赋能|稀有|传说|珍贵)$/iu.test(word));
  return words.length > 0 && words.every((word) => haystack.includes(word));
}

// ---------- Market 查价 ----------

let marketSlugsPromise = null;

// 英文名（小写去空格）→ market slug 的映射，整表拉一次后常驻本进程
async function marketSlugMap() {
  if (marketSlugsPromise) return marketSlugsPromise;
  marketSlugsPromise = (async () => {
    const response = await fetch(MARKET_ITEMS_URL, {
      headers: { Platform: 'pc', Crossplay: 'true', Language: 'zh-hans' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`market items HTTP ${response.status}`);
    const payload = await response.json();
    const bySquashedName = new Map();
    for (const item of payload?.data || []) {
      const english = normalize(item?.i18n?.en?.name).toLowerCase().replace(/\s+/gu, '');
      if (english && item.slug) bySquashedName.set(english, { slug: item.slug, zhName: normalize(item?.i18n?.['zh-hans']?.name) || null, thumb: item?.i18n?.en?.thumb || null });
    }
    return bySquashedName;
  })();
  return marketSlugsPromise;
}

async function lowestSellPrice(slug, { rankZero = false } = {}) {
  // 掉落的 MOD/赋能是 0 级形态，按 rank=0 询价（满级价虚高误导）
  const response = await fetch(`${MARKET_ORDERS_URL}/${slug}/top${rankZero ? '?rank=0' : ''}`, {
    headers: { Platform: 'pc', Crossplay: 'true', Language: 'zh-hans' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const payload = await response.json();
  // ⚠ wm /top 列表不按价格排序（实测 9,11,2,12,2），必须取真实最小值
  const prices = (payload?.data?.sell || [])
    .filter((order) => order.visible !== false)
    .map((order) => Number(order.platinum))
    .filter(Number.isFinite);
  return prices.length ? Math.min(...prices) : null;
}

// wm 目录查询：部件商品带 Blueprint 尾缀（Ash Prime Chassis 商品名=…Chassis Blueprint），直查不中时补尾缀再试
function findMarketEntry(slugs, englishName) {
  const key = String(englishName || '').toLowerCase().replace(/\s+/gu, '');
  if (!key) return null;
  return slugs.get(key) || slugs.get(`${key}blueprint`) || null;
}

// 给可交易掉落补市价；失败静默降级为无价格，绝不伪造
async function attachPrices(drops) {
  let slugs;
  try { slugs = await marketSlugMap(); } catch { return; }
  const priceable = drops.filter((drop) => drop.tradable && drop.englishName).slice(0, MAX_PRICED_ITEMS);
  await Promise.all(priceable.map(async (drop) => {
    const entry = findMarketEntry(slugs, drop.englishName);
    if (!entry) return;
    // Market 的 zh-hans 名比本地词典更贴近交易场景，命中时优先展示
    if (entry.zhName && drop.displayName.startsWith('未收录')) drop.displayName = entry.zhName;
    try { drop.platinum = await lowestSellPrice(entry.slug, { rankZero: drop.isMod || drop.isArcane }); } catch { drop.platinum = null; }
  }));
}

// ---------- 基线状态 ----------

function emptyState() {
  return { version: 1, updatedAt: null, baseline: null, lastMtimeMs: 0, lastSyncedAt: null, pendingDelivery: [] };
}

async function readState(statePath) {
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf8'));
    return { ...emptyState(), ...parsed };
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyState();
    throw error;
  }
}

async function writeState(statePath, state) {
  await mkdir(path.dirname(statePath), { recursive: true });
  state.updatedAt = new Date().toISOString();
  const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(state)}\n`, 'utf8');
  await rename(tempPath, statePath);
}

async function withLock(statePath, operation) {
  await mkdir(path.dirname(statePath), { recursive: true });
  const lockPath = `${statePath}.lock`;
  let handle = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { handle = await open(lockPath, 'wx'); break; }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
          await unlink(lockPath).catch((unlinkError) => {
            if (unlinkError?.code !== 'ENOENT') throw unlinkError;
          });
          continue;
        }
      } catch (statError) {
        if (statError?.code !== 'ENOENT') throw statError;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  if (!handle) throw new Error('掉落监测状态正忙');
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, 'utf8');
    return await operation();
  }
  finally {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}

// ---------- 订阅账本（复用 subscriptions.mjs 的文件格式，只读） ----------

async function activeDropSubscriptions(ledgerPath, target) {
  try {
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
    const wanted = String(target || '').toLowerCase();
    return (Array.isArray(ledger.subscriptions) ? ledger.subscriptions : [])
      .filter((item) => String(item.target || '').toLowerCase() === wanted && item.enabled && item.type === 'drops');
  } catch {
    return [];
  }
}

// ---------- 直接投递与欠账补投 ----------

// 自己发消息并确认结果（cron announce 是 best-effort，失败即丢）；有 messageId 才算送达
async function sendDirect(target, message) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [OPENCLAW_CLI, 'message', 'send',
      '--channel', 'qqbot', '--target', target, '--message', message, '--json',
    ], { timeout: 60_000, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'utf8' });
    const start = stdout.search(/[[{]/u);
    if (start < 0) return false;
    const payload = JSON.parse(stdout.slice(start));
    return Boolean(payload?.messageId) && !payload?.error;
  } catch {
    return false;
  }
}

// 逐条补投欠账；成功/过期移除，仍失败的留到下轮。返回队列是否有变化
async function flushPending(state, target) {
  const queue = Array.isArray(state.pendingDelivery) ? state.pendingDelivery : [];
  if (!queue.length) return false;
  const kept = [];
  for (const entry of queue) {
    if (Date.now() - Date.parse(entry.queuedAt) > PENDING_TTL_MS) continue;
    if (await sendDirect(target, entry.message)) continue;
    kept.push(entry);
  }
  const changed = kept.length !== queue.length;
  state.pendingDelivery = kept;
  return changed;
}

// ---------- monitor 主流程 ----------

async function monitorDrops({ statePath, ledgerPath, target, cardDir, alecaDir, dryRun }) {
  return withLock(statePath, async () => {
    const subscriptions = await activeDropSubscriptions(ledgerPath, target);
    if (!subscriptions.length && !dryRun) return { output: 'NO_REPLY\n', data: { ok: true, reason: 'no_subscriptions' } };

    const state = await readState(statePath);
    // 先补投上轮欠账（网络恢复后自动重发），再看有没有新变化
    if (!dryRun && await flushPending(state, target)) await writeState(statePath, state);
    const snapshotFile = path.join(alecaDir, 'lastData.dat');

    // 零成本闸门：mtime 没变就直接休眠，不解密不联网
    let mtimeMs;
    try { mtimeMs = (await stat(snapshotFile)).mtimeMs; } catch {
      return { output: 'NO_REPLY\n', data: { ok: true, reason: 'snapshot_missing' } };
    }
    if (!dryRun && state.baseline && mtimeMs === state.lastMtimeMs) {
      return { output: 'NO_REPLY\n', data: { ok: true, reason: 'unchanged' } };
    }

    // 游戏结算时 AlecaFrame 可能正在写文件，读到半成品就静默等下一分钟重试，不把错误推给用户
    let snapshot;
    try { snapshot = await readSnapshot(alecaDir); }
    catch (error) {
      return { output: 'NO_REPLY\n', data: { ok: false, reason: 'snapshot_read_failed', error: String(error?.message || error) } };
    }
    const counts = countInventory(snapshot.inventory);

    // 首次运行：只建基线，不推送
    if (!state.baseline) {
      await writeState(statePath, { ...state, baseline: counts, lastMtimeMs: snapshot.fileMtimeMs, lastSyncedAt: snapshot.syncedAt });
      return { output: 'NO_REPLY\n', data: { ok: true, reason: 'baseline_created', tracked: Object.keys(counts).length } };
    }

    // diff：只关心新增（数量上升）；消耗/出售导致的下降不打扰
    const gainedEntries = [];
    for (const [type, count] of Object.entries(counts)) {
      const before = Number(state.baseline[type]) || 0;
      if (count > before) gainedEntries.push([type, count - before]);
    }

    const previousSyncedAt = state.lastSyncedAt;
    await writeState(statePath, { ...state, baseline: counts, lastMtimeMs: snapshot.fileMtimeMs, lastSyncedAt: snapshot.syncedAt });

    if (!gainedEntries.length) return { output: 'NO_REPLY\n', data: { ok: true, reason: 'no_gains' } };

    const catalog = await loadCatalog(alecaDir);
    const drops = gainedEntries.map(([type, gained]) => describeDrop(type, gained, catalog));

    // 任一订阅命中即入选；记录命中条件用于卡片上显示
    const matched = [];
    for (const drop of drops) {
      const hits = subscriptions.filter((subscription) => dropMatches(drop, subscription.filter));
      if (hits.length) {
        drop.condition = [...new Set(hits.map((hit) => hit.filter ? `掉落 · ${hit.filter}` : '掉落 · 重点物品'))].join('；');
        matched.push(drop);
      }
    }
    if (dryRun) {
      return { output: `${JSON.stringify({ ok: true, gained: drops, matched }, null, 2)}\n`, data: { ok: true, matched } };
    }
    if (!matched.length) return { output: 'NO_REPLY\n', data: { ok: true, reason: 'no_match', gained: drops.length } };

    // 排序：Prime → 赋能 → 稀有MOD → 其他；补市价后渲染
    matched.sort((a, b) => Number(b.isPrime) - Number(a.isPrime) || Number(b.isArcane) - Number(a.isArcane) || Number(b.isMod) - Number(a.isMod));
    await attachPrices(matched);
    // 物品图降级链（用户定：风格向 wm 看齐）：wm 素材 → browse.wf 游戏原图（同源同风格） → AlecaFrame 插画 → 字母块
    try {
      const { imageDataUri, gameIconDataUri, primeWarframePartIconDataUri } = await import('./wfdata.mjs');
      let slugs = null;
      try { slugs = await marketSlugMap(); } catch { slugs = null; }
      await Promise.all(matched.slice(0, MAX_CARD_ROWS).map(async (drop) => {
        const wmEntry = slugs ? findMarketEntry(slugs, drop.englishName) : null;
        drop.iconDataUri = await primeWarframePartIconDataUri(drop.uniqueName, drop.englishName);
        if (!drop.iconDataUri && wmEntry?.thumb) drop.iconDataUri = await imageDataUri(`https://warframe.market/static/assets/${wmEntry.thumb}`);
        if (!drop.iconDataUri) drop.iconDataUri = await gameIconDataUri(drop.uniqueName);
        if (!drop.iconDataUri && drop.imageName) drop.iconDataUri = await imageDataUri(`https://cdn.alecaframe.com/warframeData/img/${drop.imageName}`);
      }));
    } catch { /* 无图降级 */ }

    // 玩家浮印头图（glyph）：解析失败退原 SVG
    let glyphDataUri = null;
    try {
      const { gameIconDataUri } = await import('./wfdata.mjs');
      glyphDataUri = await gameIconDataUri(snapshot.inventory.ActiveAvatarImageType) || null;
    } catch { glyphDataUri = null; }
    const card = buildDropsAlertCard({
      drops: matched.slice(0, MAX_CARD_ROWS),
      total: matched.length,
      totalDucats: matched.reduce((sum, drop) => sum + (drop.ducats || 0) * drop.gained, 0),
      syncedAt: snapshot.syncedAt,
      previousSyncedAt,
      glyphDataUri,
    });
    let mediaUrl = null;
    if (cardDir) {
      try { mediaUrl = await renderWarframeCard(card, cardDir); } catch { /* 下面文字兜底 */ }
    }
    let message;
    if (mediaUrl) {
      message = `MEDIA:${mediaUrl}`;
    } else {
      const lines = ['🎁 入库新掉落', ...matched.slice(0, MAX_CARD_ROWS).map((drop) => {
        const tags = [drop.ducats ? `${drop.ducats * drop.gained} 杜卡德` : '', drop.platinum ? `卖单 ${drop.platinum} 白金` : ''].filter(Boolean).join('，');
        return `• ${drop.displayName} ×${drop.gained}${tags ? `（${tags}）` : ''}`;
      })];
      if (matched.length > MAX_CARD_ROWS) lines.push(`…共 ${matched.length} 项`);
      const ducatsSum = matched.reduce((sum, drop) => sum + (drop.ducats || 0) * drop.gained, 0);
      if (ducatsSum) lines.push(`本批 Prime 部件共可换 ${ducatsSum} 杜卡德。`);
      lines.push('数据来自本机账号快照，价格为当前在线最低卖单，仅供参考。');
      message = lines.join('\n');
    }
    // 先落盘再投递：即使 cron 在发送期间强杀进程，下一轮仍能从欠账队列补投。
    const deliveryId = `${Date.now()}-${process.pid}`;
    const queuedState = await readState(statePath);
    queuedState.pendingDelivery = [...(Array.isArray(queuedState.pendingDelivery) ? queuedState.pendingDelivery : []), {
      id: deliveryId, message, queuedAt: new Date().toISOString(),
    }];
    await writeState(statePath, queuedState);
    // 自发并确认；输出恒为 NO_REPLY，不再走 announce
    if (await sendDirect(target, message)) {
      const sentState = await readState(statePath);
      sentState.pendingDelivery = (Array.isArray(sentState.pendingDelivery) ? sentState.pendingDelivery : [])
        .filter((entry) => entry.id !== deliveryId);
      await writeState(statePath, sentState);
      return { output: 'NO_REPLY\n', data: { ok: true, matched, delivered: 'direct' } };
    }
    return { output: 'NO_REPLY\n', data: { ok: true, matched, delivered: 'queued' } };
  });
}

function outputJson(value) {
  process.stdout.write(`${JSON.stringify(value, stripDataUriReplacer)}\n`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (command === 'monitor') {
    if (!args.state || !args.ledger || !args.target) {
      outputJson({ ok: false, error: 'monitor 需要 --state、--ledger 与 --target' });
      process.exitCode = 1;
      return;
    }
    const result = await monitorDrops({
      statePath: path.resolve(String(args.state)),
      ledgerPath: path.resolve(String(args.ledger)),
      target: normalize(args.target),
      cardDir: args['card-dir'] ? path.resolve(String(args['card-dir'])) : null,
      alecaDir: args['aleca-dir'] ? path.resolve(String(args['aleca-dir'])) : defaultAlecaDir(),
      dryRun: String(args['dry-run']).toLowerCase() === 'true',
    });
    process.stdout.write(result.output);
    return;
  }
  outputJson({ ok: false, error: '用法：drops.mjs monitor --state <path> --ledger <path> --target <qq-target> [--card-dir <dir>] [--dry-run true]' });
  process.exitCode = 1;
}

export { monitorDrops, dropMatches, countInventory, loadCatalog, describeDrop, defaultAlecaDir, marketSlugMap, findMarketEntry, withLock };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // monitor 的 stdout 会被 cron 直接投递到 QQ，异常绝不能漏裸 JSON
    if (process.argv[2] === 'monitor') {
      process.stderr.write(`[warframe-drops] ${String(error?.stack || error)}\n`);
      process.stdout.write('NO_REPLY\n');
    }
    else outputJson({ ok: false, error: String(error?.message || error) });
    process.exitCode = 1;
  });
}
