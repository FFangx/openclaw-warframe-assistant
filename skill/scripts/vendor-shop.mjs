#!/usr/bin/env node

// vendor-shop.mjs — 「商店」功能核心：货单装配 × 已购三档判定 × 哪里买反查 × 未来上架扫描。
// 数据链：
//   货单     = ExportVendors.json（browse.wf 在线，staleCachedJson 双层缓存）
//   本期复现 = vendor-rotation.mjs（可算类 42 家：种子×周期确定性重放）
//   商人档案 = vendor-meta.json（wiki 查证的身份/位置/货币，纯展示）
//   中文名   = weekly.mjs storeItemZh（静态表 → lang.json → 蓝图拆解）
//   已购判定 = 快照 RecentVendorPurchases（oid 对齐三档，见 resolvePurchaseMarks）
//   瓦奇娅/达尔沃 = 官方 worldState.php（PrimeVaultTraders 含未来排期 / DailyDeals 含实时余量）
// 判定诚实度三档（用户 2026-08-05 拍板）：
//   ✅ 已购买 = oid 对齐唯一解，或一次性物品库存直判「已拥有」
//   ☑ 已购?  = oid 对齐多解但候选收敛不到单一商品——只汇总计数，不硬标具体商品
//   · 计数   = 真轮换商人/散账购买，「本期已购 M 件」

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { staleCachedJson } from './wfdata.mjs';
import { cycleDurationOf, generateVendorOffers } from './vendor-rotation.mjs';
import { loadNameTables, storeItemZh } from './weekly.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_VENDORS_URL = 'https://browse.wf/warframe-public-export-plus/ExportVendors.json';
const OFFICIAL_WORLDSTATE_URL = 'https://api.warframe.com/cdn/worldState.php';
const FETCH_TIMEOUT_MS = 20_000;
// 货单文件只在版本更新时变（24h 足够）；官方 worldState 里达尔沃每日轮换（15min 平衡新鲜与流量）
const VENDORS_TTL_MS = 24 * 60 * 60 * 1000;
const WORLDSTATE_TTL_MS = 15 * 60 * 1000;
// 常驻条目在生成器里的「永不过期」哨兵（2035 年）；购买记录里的常驻限购重置期也在远期
const EVERGREEN_EXPIRY_MS = 2_051_240_400_000;

// 总览卡收录顺序（用户拍板 8 家 + 达尔沃；瓦奇娅/达尔沃不在 ExportVendors，走官方 worldState 特殊装配）
export const SHOP_VENDORS = Object.freeze([
  { key: '/Lotus/Types/Game/VendorManifests/Hubs/TeshinHardModeVendorManifest', alias: ['泰辛', 'teshin', '钢铁荣誉', '钢铁商店'] },
  { key: 'varzia', alias: ['瓦奇娅', 'varzia', 'prime重生', '禁卫瓦奇娅'] },
  { key: '/Lotus/Types/Game/VendorManifests/Hubs/IronwakeDondaVendorManifest', alias: ['圣言者', 'palladino', '帕拉迪诺', '钢铁守望'] },
  { key: '/Lotus/Types/Game/VendorManifests/Hubs/EliteAlertVendorManifest', alias: ['仲裁荣誉', '仲裁商店', 'arbiters'] },
  { key: '/Lotus/Types/Game/VendorManifests/Kahl/ChipperVendorManifest', alias: ['切片哥', 'chipper', '卡尔商店', '存货储备'] },
  { key: '/Lotus/Types/Game/VendorManifests/Hubs/HunhowVendorManifest', alias: ['hunhow', '浑霍', 'hunhow商店'] },
  { key: '/Lotus/Types/Game/VendorManifests/Duviri/AcrithisVendorManifest', alias: ['言录使', 'acrithis'] },
  { key: '/Lotus/Types/Game/VendorManifests/EntratiLabs/EntratiLabVendorManifest', alias: ['鸟三', '璀璨珍宝', 'bird3', '鸟3'] },
  { key: '/Lotus/Types/Game/VendorManifests/Solaris/NightcapVendorManifest', alias: ['nightcap', '睡帽'] },
  { key: 'darvo', alias: ['达尔沃', 'darvo', '每日特惠', '特惠'] },
]);

// ==== 基础数据加载（全部带缓存/降级） ====

async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  return response.json();
}

// ExportVendors：94 家 manifest 全量；失败退陈旧快照（stale 标注上卡页脚）
export async function loadExportVendors() {
  const result = await staleCachedJson('export-vendors', { ttlMs: VENDORS_TTL_MS, version: 1 }, () => fetchJson(EXPORT_VENDORS_URL));
  return { vendors: result.data, stale: result.stale, cachedAt: result.cachedAt };
}

// 官方 worldState：瓦奇娅（PrimeVaultTraders）与达尔沃（DailyDeals）唯一来源；失败返回 null 上卡显示占位
export async function loadOfficialWorldState() {
  try {
    const result = await staleCachedJson('official-worldstate', { ttlMs: WORLDSTATE_TTL_MS, version: 1 }, () => fetchJson(OFFICIAL_WORLDSTATE_URL));
    return result.data;
  } catch {
    return null;
  }
}

let vendorMetaPromise = null;
export function loadVendorMeta() {
  vendorMetaPromise ??= readFile(path.join(SCRIPT_DIR, 'vendor-meta.json'), 'utf8')
    .then((text) => JSON.parse(text))
    .catch(() => ({}));
  return vendorMetaPromise;
}

// ==== 商人分类（与 probe-all-vendors 同判据） ====
// cyclic  = 有轮换条目但每期把池全出完（「随机」退化成固定货单+限购重置）→ 本期与未来都可精确算
// rotating = 每期只出池的子集（官服相位不可复现，2026-08-05 判死）→ 只能展示候选池
// fixed   = 全常驻
export function classifyVendor(manifest) {
  const items = manifest?.items || [];
  const rollable = items.filter((item) => item.probability !== undefined);
  const weekly = items.filter((item) => item.rotatedWeekly);
  const capacity = rollable.reduce((sum, item) => sum + 1 + (item.duplicates || 0), 0);
  if (rollable.length && manifest.numItems && manifest.numItems.maxValue < capacity) return 'rotating';
  if (rollable.length || weekly.length) return 'cyclic';
  return 'fixed';
}

// ==== 快照购买记录 ====

const msOf = (value) => {
  if (typeof value === 'number') return value;
  const long = Number(value?.$date?.$numberLong);
  if (Number.isFinite(long)) return long;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

export function vendorPurchases(inventory, typeName) {
  const vendor = (inventory?.RecentVendorPurchases || []).find((entry) => String(entry.VendorType) === typeName);
  return (vendor?.PurchaseHistory || []).map((entry) => ({
    expiryMs: msOf(entry.Expiry),
    // Mongo ObjectId 的前 4 字节是记录创建时间。服务端会把上周购买记录的
    // Expiry 推进到新周期，因此 expiry 相等仍不足以证明「本周购买」。
    createdMs: /^[0-9a-f]{24}$/iu.test(String(entry.ItemId || ''))
      ? Number.parseInt(String(entry.ItemId).slice(0, 8), 16) * 1000
      : Number.NaN,
    num: Number(entry.NumPurchased) || 1,
    itemId: String(entry.ItemId || ''),
  })).filter((entry) => entry.itemId);
}

// ==== 已购三档判定（本功能的核心纯函数，测试重点） ====
// 事实依据（2026-08-05 圣言者 5 笔真实购买实锤）：每期轮换商品在服务器按生成序拿连号 oid；
// oid 只给相对位置，锚点靠「偏移跨度 vs 组内商品数」的对齐约束推出。
// 输入 offers=generateVendorOffers 生成序；purchases=vendorPurchases 输出。
// 返回 { marks: Array<'bought'|null>（与 offers 对位）, boughtTotal, unresolved, evergreenBought }
export function resolvePurchaseMarks(offers, purchases) {
  const marks = new Array(offers.length).fill(null);
  let boughtTotal = 0;      // 本期轮换商品累计购买件数（含未定位）
  let unresolved = 0;       // 对齐多解、定位不到具体商品的件数
  let evergreenBought = 0;  // 常驻限购商品的购买件数（oid 无锚点，只计数）

  // 轮换 offers 按过期时刻分组：同组=同一轮生成=oid 连号；常驻（2035 哨兵）不参与对齐
  const groups = new Map();
  offers.forEach((offer, index) => {
    if (offer.alwaysOffered || offer.expiry >= EVERGREEN_EXPIRY_MS - 1) return;
    const list = groups.get(offer.expiry) || [];
    list.push(index);
    groups.set(offer.expiry, list);
  });

  const leftovers = [];
  const byExpiry = new Map();
  for (const purchase of purchases) {
    if (groups.has(purchase.expiryMs)) {
      const list = byExpiry.get(purchase.expiryMs) || [];
      list.push(purchase);
      byExpiry.set(purchase.expiryMs, list);
    } else {
      leftovers.push(purchase);
    }
  }
  evergreenBought = leftovers.reduce((sum, purchase) => sum + purchase.num, 0);

  for (const [expiryMs, groupPurchases] of byExpiry) {
    const slotIndexes = groups.get(expiryMs);
    const slots = slotIndexes.length;
    // oid 末 8 字节足够比较偏移（前 4 字节是时间戳，同组相同）；BigInt 防 53 位精度损失
    const oids = groupPurchases.map((purchase) => ({ purchase, oid: BigInt(`0x${purchase.itemId.slice(-16)}`) }));
    oids.sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
    const base = oids[0].oid;
    const offsets = oids.map((entry) => Number(entry.oid - base));
    const span = offsets[offsets.length - 1];
    boughtTotal += groupPurchases.reduce((sum, purchase) => sum + purchase.num, 0);

    // 防御：跨度不该超过组内商品数（超了=对齐假设被打破，整组诚实降级为计数）
    if (span > slots - 1 || offsets.length > slots) {
      unresolved += groupPurchases.length;
      continue;
    }
    // 合法基准 k：所有购买都落在 [0, slots-1] 内
    const validBases = [];
    for (let k = 0; k + span <= slots - 1; k += 1) validBases.push(k);
    for (let i = 0; i < offsets.length; i += 1) {
      // 该购买在所有合法对齐下的候选商品集合；收敛到单一 storeItem 才敢标「已购买」
      const candidates = new Set(validBases.map((k) => offers[slotIndexes[k + offsets[i]]].storeItem));
      if (candidates.size === 1) marks[slotIndexes[validBases[0] + offsets[i]]] = 'bought';
      else unresolved += 1;
    }
  }
  return { marks, boughtTotal, unresolved, evergreenBought };
}

// ==== 未来上架扫描（「订阅 商品」用；仅可算类商人有效） ====
// 逐周期把 now 拨到未来重放，直到目标商品出现在轮换区；常驻商品返回 { evergreen: true }
export function nextAppearance(typeName, manifest, storeItem, { from = Date.now(), horizonMs = 120 * 24 * 3600_000, cycleOffset } = {}) {
  const target = String(storeItem);
  // 泰辛走 8 周表：逐周找下一次精选命中
  if (typeName === TESHIN_KEY) {
    const tail = target.split('/').pop();
    const slot = TESHIN_ROTATION.indexOf(tail);
    if (slot < 0) {
      const always = (manifest.items || []).find((item) => item.storeItem === target && item.alwaysOffered);
      return always ? { evergreen: true } : null;
    }
    const { week } = teshinWeekInfo(from);
    for (let candidate = week; candidate <= week + 8; candidate += 1) {
      if (((candidate % 8) + 8) % 8 !== slot) continue;
      const start = TESHIN_EPOCH_MS + candidate * 604_800_000;
      const end = start + 604_800_000;
      if (end <= from) continue;
      return { at: start, expiry: end, current: start <= from };
    }
    return null;
  }
  const always = (manifest.items || []).find((item) => item.storeItem === target && (item.alwaysOffered || item.rotatedWeekly));
  // rotatedWeekly 条目每期都会重新上架（视同常驻），订阅它没有意义
  if (always) return { evergreen: true };
  const cycle = cycleDurationOf(manifest);
  if (!cycle) return null;
  for (let at = from; at < from + horizonMs; at += cycle) {
    const { offers } = generateVendorOffers(typeName, manifest, { now: at, ...(cycleOffset ? { cycleOffset } : {}) });
    const hit = offers.find((offer) => offer.storeItem === target && !offer.alwaysOffered);
    if (hit && hit.expiry > from) {
      // 上架时刻 = 本期开始 = 过期时刻 - 条目时长；用周期对齐回推最稳
      const start = hit.expiry - cycle <= from ? from : hit.expiry - cycle;
      return { at: start, expiry: hit.expiry, current: hit.expiry - cycle <= from };
    }
  }
  return null;
}

// ==== 名称/价格展示工具 ====

const compact = (value) => String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/[\s_\-:：·'’&（）()]+/gu, '');
const stripStore = (value) => String(value ?? '').replace('/StoreItems/', '/');

// 货币 → 卡片 currency() 图标 kind；查无返回 null（用中文名文字显示）
const CURRENCY_KIND = Object.freeze({
  '/Lotus/Types/Items/MiscItems/SteelEssence': 'steelEssence',
  '/Lotus/Types/Items/MiscItems/PrimeBucks': 'ducat',
  '/Lotus/Types/Items/MiscItems/RivenFragment': 'riftPlasm',
});

export function priceParts(offer, zhOf) {
  const parts = [];
  for (const price of offer.itemPrices || []) {
    const kind = CURRENCY_KIND[price.ItemType] || null;
    const zh = zhOf?.(price.ItemType) || String(price.ItemType).split('/').pop();
    parts.push({ kind, count: price.ItemCount, label: zh });
  }
  if (offer.credits) parts.push({ kind: 'credit', count: offer.credits, label: '现金' });
  if (offer.platinum) parts.push({ kind: 'plat', count: offer.platinum, label: '白金' });
  return parts;
}

// 商品显示名：storeItemZh 链（静态表→lang.json→蓝图拆解）→ Bundle 静态表 → 现金包正则 → 路径尾段
// Bundle/现金包是打包物，lang.json 无词条（圣言者货单实测缺口）
const BUNDLE_ZH = Object.freeze({
  RivenModPack: '裂罅 Mod 包',
  CircuitSilverSteelPathFusionBundle: '6,000 内融核心',
  CircuitGoldSteelPathFusionBundle: '30,000 内融核心',
  EvergreenLoginRewardFusionBundle: '30,000 内融核心（登录奖励包）',
  RandomSyndicateProjectionPack: '集团遗物包（随机）',
  UmbraFormaBlueprint: 'Umbra Forma 蓝图',
  RawShotgunRandomMod: '霓弹枪裂罅 Mod', RawRifleRandomMod: '步枪裂罅 Mod',
  RawModularPistolRandomMod: '组合枪裂罅 Mod', RawModularMeleeRandomMod: 'Zaw 裂罅 Mod',
  // StoreItem 路径与物品目录/语言键不共尾名的官方商店条目。
  PrimeLisetFiligreeScene: '精工掐丝 Prime 装饰',
  MPVAviaPrimeArmorSet: '飞空 Prime 护甲套装',
  MPVVetalaPrimeArmorSet: '维塔拉 Prime 护甲套装',
  MPVVervSentrexSentAccessories: '热忱圣塔斯守护配件',
  GrendelKeyA: 'Grendel 机体定位装置',
  GrendelKeyB: 'Grendel 头部神经光元定位装置',
  GrendelKeyC: 'Grendel 系统定位装置',
  AmberStarBlueprint: '阿耶檀识琥珀星蓝图',
  AshCrewedCaptainGenerator: '忍力（船员）',
  GarudaCrewedCaptainGenerator: '维纳（船员）',
  LatroxUneCrewedMemberGenerator: '拉托罗·恩（船员）',
  JarkaLarCrewedMemberGenerator: 'Jarka Lar（船员）',
  // 官方导出没有可对齐的名称语言键；按物品类型给中文释义，不伪造正式译名。
  DuviriVendorBoonItem: '双衍王境增益（具体内容随机）',
});
export function itemZh(storeItem, names) {
  const direct = storeItemZh(storeItem, names);
  if (direct) return direct;
  const tail = String(storeItem).split('/').pop();
  if (BUNDLE_ZH[tail]) return BUNDLE_ZH[tail];
  const credits = tail.match(/^(\d+)Credits$/u);
  if (credits) return `${Number(credits[1]).toLocaleString('zh-CN')} 现金`;
  // MPV 套包（瓦奇娅）不在 lang.json：内部名转可读（与 lookup.mjs 同款正则）
  const pack = tail.match(/^MPV([A-Z][a-z]+)([A-Z][a-z]+)?Prime(Single|Dual)Pack$/u);
  if (pack) return `${pack[1]}${pack[2] ? `+${pack[2]}` : ''} Prime ${pack[3] === 'Dual' ? '双人包' : '单人包'}`;
  // 内部类名不能直接上用户卡片；词典/目录短暂缺失时给诚实中文占位。
  return '游戏内商品（名称待词典同步）';
}

// ==== 泰辛周精选特判 ====
// generateVendorOffers 把 rotatedWeekly 全当常驻（私服近似），真官服每周只上 1 件精选——
// 社区 8 周表（browse.wf typestripped/live.js，EPOCH 2025-01-06）周序实测与游戏一致。
// 表项→manifest rotatedWeekly 条目的映射已逐一对过（Kitgun=ModularPistol、Zaw=ModularMelee、3万Endo=LoginRewardFusionBundle）
export const TESHIN_KEY = '/Lotus/Types/Game/VendorManifests/Hubs/TeshinHardModeVendorManifest';
const TESHIN_EPOCH_MS = 1_736_121_600_000;
const TESHIN_ROTATION = Object.freeze([
  'UmbraFormaBlueprint', 'Kuva', 'RawModularPistolRandomMod', 'Forma',
  'RawModularMeleeRandomMod', 'EvergreenLoginRewardFusionBundle', 'RawRifleRandomMod', 'RawShotgunRandomMod',
]);
export function teshinWeekInfo(now = Date.now()) {
  const week = Math.trunc((now - TESHIN_EPOCH_MS) / 604_800_000);
  return { week, tail: TESHIN_ROTATION[((week % 8) + 8) % 8], weekEndMs: TESHIN_EPOCH_MS + (week + 1) * 604_800_000 };
}

// RecentVendorPurchases 会提前写入未来几期的限购记录。周计数必须与本周
// 结束时刻精确对齐，不能只用「尚未过期」，否则未来周会被误报为本周已购。
export function purchasesForCycle(purchases, cycleExpiryMs, cycleStartMs = Number.NEGATIVE_INFINITY) {
  return purchases.filter((purchase) => Number.isFinite(purchase.expiryMs)
    && purchase.expiryMs === cycleExpiryMs
    && Number.isFinite(purchase.createdMs)
    && purchase.createdMs >= cycleStartMs
    && purchase.createdMs < cycleExpiryMs);
}

// ==== 装配：单商人详情 ====

// 返回一份「渲染无关」的数据对象，卡片层照着画；inventory 传 null = 无已购标（降级）
export async function buildVendorDetail(vendorKey, { vendors, meta, names, inventory, now = Date.now(), purchaseNotBeforeMs = Number.NEGATIVE_INFINITY } = {}) {
  const manifest = vendors[vendorKey];
  if (!manifest) return null;
  const kind = classifyVendor(manifest);
  const vendorMeta = meta[vendorKey] || {};
  const purchases = inventory
    ? vendorPurchases(inventory, vendorKey).filter((purchase) => purchase.createdMs >= purchaseNotBeforeMs && purchase.createdMs <= now)
    : [];

  const detail = {
    key: vendorKey,
    kind,
    zhName: vendorMeta.zhName || vendorKey.split('/').pop(),
    meta: vendorMeta,
    boughtTotal: 0,
    unresolved: 0,
    evergreenBought: 0,
    rotating: [],   // 本期轮换（可算类）或空（真轮换）
    evergreen: [],  // 常驻区
    pool: [],       // 真轮换类候选池
    cycleMs: 0,
    nextRotationAt: null,
  };

  const rowOf = (offer, mark) => ({
    name: itemZh(offer.storeItem, names),
    storeItem: offer.storeItem,
    quantity: Number(offer.quantity) > 1 ? Number(offer.quantity) : null,
    prices: priceParts(offer, names?.zhOf),
    limit: offer.purchaseLimit ?? null,
    syndicate: offer.syndicate ? { minRank: offer.syndicate.minRank, standing: offer.syndicate.standingCost } : null,
    mark: mark || null,
    expiry: offer.expiry && offer.expiry < EVERGREEN_EXPIRY_MS - 1 ? offer.expiry : null,
    probability: offer.probability,
    durationHours: offer.durationHours,
  });

  if (vendorKey === TESHIN_KEY) {
    // 泰辛：官服每周只上架一件精选（generateVendorOffers 复现不了），用社区 8 周表直构造；
    // 已购只做计数——本周真实上架集合未知，oid 对齐的 slots 前提不成立，不硬猜
    const { tail, weekEndMs } = teshinWeekInfo(now);
    const items = manifest.items || [];
    const featured = items.find((item) => item.rotatedWeekly && item.storeItem.split('/').pop() === tail
      && (tail !== 'Kuva' || (item.itemPrices?.[0]?.ItemCount ?? 0) > 20)); // 两个 Kuva 条目：周精选是 55 精华那个
    const weeklySure = items.filter((item) => item.rotatedWeekly && item.probability === 1);
    detail.rotating = [featured, ...weeklySure].filter(Boolean).map((item) => ({ ...rowOf({ ...item, expiry: weekEndMs }, null), featured: item === featured }));
    detail.evergreen = items.filter((item) => item.alwaysOffered).map((item) => rowOf({ ...item, expiry: null }, null));
    detail.kind = 'cyclic';
    detail.cycleMs = 604_800_000;
    detail.nextRotationAt = weekEndMs;
    detail.boughtTotal = purchasesForCycle(purchases, weekEndMs, weekEndMs - 604_800_000).reduce((sum, purchase) => sum + purchase.num, 0);
    detail.scheduleSource = '周精选排期来自社区 8 周表';
    return detail;
  }

  if (kind === 'rotating') {
    // 真轮换：本期货单不可知，展示候选池 + 已购计数（诚实标注）
    detail.boughtTotal = purchases.reduce((sum, purchase) => sum + purchase.num, 0);
    detail.pool = (manifest.items || []).map((item) => rowOf({ ...item, expiry: null }, null));
    detail.cycleMs = (() => { try { return cycleDurationOf(manifest); } catch { return 0; } })();
    return detail;
  }

  // 可算类/固定：重放本期货单 + oid 对齐
  let offers = [];
  try {
    offers = generateVendorOffers(vendorKey, manifest, { now }).offers;
  } catch {
    offers = (manifest.items || []).map((item) => ({ ...item, expiry: EVERGREEN_EXPIRY_MS, alwaysOffered: true }));
  }
  const { marks, boughtTotal, unresolved, evergreenBought } = resolvePurchaseMarks(offers, purchases);
  detail.boughtTotal = boughtTotal;
  detail.unresolved = unresolved;
  detail.evergreenBought = evergreenBought;
  offers.forEach((offer, index) => {
    const row = rowOf(offer, marks[index]);
    // syndicate 在原始 manifest 条目上，重放输出不带——补查
    const rawItem = (manifest.items || []).find((item) => item.storeItem === offer.storeItem);
    if (rawItem?.syndicate) row.syndicate = { minRank: rawItem.syndicate.minRank, standing: rawItem.syndicate.standingCost };
    if (offer.alwaysOffered || offer.expiry >= EVERGREEN_EXPIRY_MS - 1) detail.evergreen.push(row);
    else detail.rotating.push(row);
  });
  const rotatingExpiries = detail.rotating.map((row) => row.expiry).filter(Boolean);
  detail.nextRotationAt = rotatingExpiries.length ? Math.min(...rotatingExpiries) : null;
  try { detail.cycleMs = cycleDurationOf(manifest); } catch { detail.cycleMs = 0; }
  return detail;
}

// ==== 装配：瓦奇娅 / 达尔沃（官方 worldState 特殊商人） ====

export function buildVarziaDetail(worldState, names, now = Date.now()) {
  const trader = worldState?.PrimeVaultTraders?.[0];
  if (!trader) return null;
  const zhOf = names?.zhOf;
  const rowOf = (entry) => ({
    name: itemZh(stripStore(entry.ItemType), names),
    storeItem: entry.ItemType,
    regal: Number(entry.PrimePrice) || 0, // PrimePrice=御品阿耶（WFCD 契约错位命名的官方版）
    aya: Number(entry.RegularPrice) || 0,
  });
  const current = (trader.Manifest || []).map(rowOf);
  const evergreen = (trader.EvergreenManifest || []).map(rowOf);
  // ScheduleInfo：未来各期 {Expiry, FeaturedItem}；取当前之后最近一期做预告
  const schedule = (trader.ScheduleInfo || [])
    .map((entry) => ({ expiryMs: msOf(entry.Expiry), featured: entry.FeaturedItem ? itemZh(stripStore(entry.FeaturedItem), names) : null }))
    .filter((entry) => Number.isFinite(entry.expiryMs))
    .sort((a, b) => a.expiryMs - b.expiryMs);
  const currentEnd = msOf(trader.Expiry);
  const next = schedule.find((entry) => entry.expiryMs > currentEnd && entry.featured);
  return {
    key: 'varzia', kind: 'schedule', zhName: '禁卫瓦奇娅',
    expiryMs: currentEnd, current, evergreen,
    next: next ? { featured: next.featured, startMs: currentEnd } : null,
  };
}

export function buildDarvoDetail(worldState, names) {
  const deals = worldState?.DailyDeals || [];
  if (!deals.length) return null;
  return {
    key: 'darvo', kind: 'daily', zhName: '达尔沃每日特惠',
    deals: deals.map((deal) => ({
      name: itemZh(stripStore(deal.StoreItem), names),
      discount: Number(deal.Discount) || 0,
      salePrice: Number(deal.SalePrice) || 0,
      originalPrice: Number(deal.OriginalPrice) || 0,
      total: Number(deal.AmountTotal) || 0,
      sold: Number(deal.AmountSold) || 0,
      expiryMs: msOf(deal.Expiry),
    })),
  };
}

// ==== 装配：总览 ====

export async function buildShopOverview({ vendors, meta, names, inventory, worldState, now = Date.now() } = {}) {
  const rows = [];
  for (const entry of SHOP_VENDORS) {
    if (entry.key === 'varzia') {
      const varzia = buildVarziaDetail(worldState, names, now);
      rows.push(varzia
        ? { key: 'varzia', zhName: '禁卫瓦奇娅', badge: 'Prime 重生', expiryMs: varzia.expiryMs, summary: `当期 ${varzia.current.length} 件${varzia.next?.featured ? ` · 下期 ${varzia.next.featured}` : ''}`, bought: null }
        : { key: 'varzia', zhName: '禁卫瓦奇娅', badge: 'Prime 重生', expiryMs: null, summary: '货单获取失败或接档期', bought: null });
      continue;
    }
    if (entry.key === 'darvo') {
      const darvo = buildDarvoDetail(worldState, names);
      const deal = darvo?.deals?.[0];
      rows.push(deal
        ? { key: 'darvo', zhName: '达尔沃每日特惠', badge: '每日轮换', expiryMs: deal.expiryMs, summary: `${deal.name} -${deal.discount}% · 余 ${Math.max(0, deal.total - deal.sold)}/${deal.total}`, bought: null }
        : { key: 'darvo', zhName: '达尔沃每日特惠', badge: '每日轮换', expiryMs: null, summary: '特惠获取失败', bought: null });
      continue;
    }
    const detail = await buildVendorDetail(entry.key, { vendors, meta, names, inventory, now });
    if (!detail) continue;
    const kindBadge = detail.kind === 'rotating' ? '随机轮换'
      : detail.kind === 'cyclic' ? (detail.cycleMs === 604_800_000 ? '每周轮换' : detail.cycleMs > 0 && detail.cycleMs <= 86_400_000 ? '每日限购重置' : '周期轮换')
      : '固定货单';
    const boughtText = detail.boughtTotal + detail.evergreenBought;
    // 总览摘要：泰辛点名本周精选；其余可算类报件数；真轮换只给计数
    const boughtNames = detail.rotating.filter((row) => row.mark === 'bought').map((row) => row.name);
    const featuredRow = detail.rotating.find((row) => row.featured);
    const summary = entry.key === TESHIN_KEY && featuredRow
      ? `本周精选：${featuredRow.name}`
      : detail.kind === 'rotating'
        ? `候选池 ${detail.pool.length} 件 · 本期货单游戏内可见`
        : `本期轮换 ${detail.rotating.length} 件 · 常驻 ${detail.evergreen.length} 件`;
    rows.push({
      key: entry.key,
      zhName: detail.zhName,
      badge: kindBadge,
      expiryMs: detail.nextRotationAt,
      summary,
      bought: boughtText > 0 ? { total: boughtText, names: boughtNames.slice(0, 2) } : null,
      location: detail.meta.location || null,
    });
  }
  return { rows, generatedAt: now };
}

// ==== 本周好货（周一随周报推送的第二张卡；2026-08-06 用户拍板「商店功能=有没有好东西在卖」） ====
// T 级=价值标签（T0 出现必抢稀缺件 / T1 每周值得看的限购高价值）。
// 只覆盖「可算/实时源」商人（泰辛 8 周表、圣言者确定性重放、瓦奇娅官方排期）；
// 言录使/鸟三等真轮换家的 T0 货（催化剂/连接器/源力石）拿不到本期货单——卡底一行提示游戏内自查。
const DONDA_KEY = '/Lotus/Types/Game/VendorManifests/Hubs/IronwakeDondaVendorManifest';
function dealTierOf(vendorKey, row) {
  const tail = String(row.storeItem).split('/').pop();
  if (tail === 'UmbraFormaBlueprint') return { tier: 'T0', note: '8 周一遇 · 全游戏最稀缺 Forma' };
  if (tail === 'RivenIdentifier') return { tier: 'T1', note: '免做紫卡开封挑战' };
  if (tail === 'RivenModPack') return { tier: 'T1', note: '紫卡包' };
  if (/^Raw\w+RandomMod$/u.test(tail)) return { tier: 'T1', note: '周轮换紫卡' };
  if (tail === 'Kuva') {
    const count = row.prices?.[0]?.count ?? 0;
    if (vendorKey === TESHIN_KEY && count > 20) return { tier: 'T1', note: '精华换赤毒性价比最高档' };
    if (vendorKey === DONDA_KEY) return { tier: 'T1', note: null };
  }
  return null;
}

// 返回渲染无关的数据对象；inventory=null 时已购标降级消失（诚实降级，与详情卡同约定）
export async function buildWeeklyDeals({ vendors, meta, names, inventory, worldState, now = Date.now() } = {}) {
  const sections = [];
  const { weekEndMs } = teshinWeekInfo(now);
  const weekStartMs = weekEndMs - 604_800_000;
  for (const key of [TESHIN_KEY, DONDA_KEY]) {
    const detail = await buildVendorDetail(key, { vendors, meta, names, inventory, now, purchaseNotBeforeMs: weekStartMs });
    if (!detail) continue;
    const rows = [];
    for (const row of [...detail.rotating, ...detail.evergreen]) {
      const hit = dealTierOf(key, row);
      if (!hit) continue;
      // 同商品多条目（圣言者紫卡包×2）合并：限购相加，已购标取并集
      const existing = rows.find((item) => item.storeItem === row.storeItem);
      if (existing) {
        existing.limit = (existing.limit || 0) + (row.limit || 0);
        if (row.mark === 'bought') existing.mark = 'bought';
        continue;
      }
      rows.push({ ...row, tier: hit.tier, tierNote: hit.note });
    }
    if (!rows.length) continue;
    rows.sort((a, b) => (a.tier === b.tier ? 0 : a.tier === 'T0' ? -1 : 1));
    sections.push({
      key,
      vendorZh: detail.zhName,
      rows,
      // 「本周已购」只统计与本期轮换 expiry 精确对齐的记录。evergreenBought
      // 包含无法归入本期的旧账/常驻长周期记录，不能并入周计数。
      boughtTotal: detail.boughtTotal,
      nextRotationAt: detail.nextRotationAt,
    });
  }
  // 瓦奇娅当期复刻（官方排期实时源）：主打包 + 剩余时间；接档期/拉取失败整行消失
  let varzia = null;
  const varziaDetail = buildVarziaDetail(worldState, names, now);
  if (varziaDetail?.current?.length) {
    const packs = varziaDetail.current.filter((row) => /Prime.*(单|双)件包|Pack/u.test(row.name)).map((row) => row.name);
    varzia = {
      // 双件包名自带两甲名（信息量最大），没有再退首个包名
      summary: packs.find((name) => name.includes('双件包')) || packs[0] || `当期 ${varziaDetail.current.length} 件`,
      count: varziaDetail.current.length,
      expiryMs: varziaDetail.expiryMs,
      next: varziaDetail.next?.featured || null,
    };
  }
  return {
    sections,
    varzia,
    generatedAt: now,
    hint: '言录使 · 鸟三璀璨珍宝为随机货架（催化剂/连接器/源力石候选），本期货单请游戏内确认',
  };
}

// ==== 哪里买反查（全 94 家 + 瓦奇娅/达尔沃不参与——它们货单时变，反查只覆盖 ExportVendors） ====

export function whereToBuy(query, { vendors, meta, names } = {}) {
  const q = compact(query);
  if (!q || q.length < 2) return { query, hits: [] };
  // 查询变体：中文「蓝图」↔ tail 里的 Blueprint（lang.json 查无时 itemZh 退回英文 tail，不做变体会漏 Umbra Forma 蓝图这类）
  const variants = [...new Set([q, q.replace(/蓝图$/u, 'blueprint'), q.replace(/blueprint$/u, '蓝图')])];
  const hits = [];
  for (const [typeName, manifest] of Object.entries(vendors)) {
    for (const item of manifest.items || []) {
      const zh = itemZh(item.storeItem, names);
      const tail = String(item.storeItem).split('/').pop();
      const hay = [compact(zh), compact(tail)];
      if (!variants.some((variant) => hay.some((value) => value.includes(variant)))) continue;
      const kind = classifyVendor(manifest);
      const vendorMeta = meta[typeName] || {};
      // 泰辛周精选：8 周表可预测，不按「随机上架」误导
      const teshinFeatured = typeName === TESHIN_KEY && item.rotatedWeekly && TESHIN_ROTATION.includes(tail);
      hits.push({
        vendorKey: typeName,
        vendorZh: vendorMeta.zhName || typeName.split('/').pop(),
        location: vendorMeta.location || null,
        itemName: zh,
        storeItem: item.storeItem,
        prices: priceParts(item, names?.zhOf),
        syndicate: item.syndicate ? { minRank: item.syndicate.minRank, standing: item.syndicate.standingCost } : null,
        availability: item.alwaysOffered ? '常驻'
          : teshinFeatured ? '每周精选（8 周轮换）'
          : kind === 'cyclic' ? (item.rotatedWeekly ? '每周轮换' : '周期轮换')
          : `随机上架${item.probability != null ? `（每期 ${Math.round(item.probability * 100)}%）` : ''}`,
        kind: teshinFeatured ? 'teshin-featured' : kind,
      });
    }
  }
  // 排序：常驻优先（马上能买）→ 泰辛精选/周期轮换 → 随机；同档按商人收录顺序
  const rank = (hit) => (hit.availability === '常驻' ? 0 : hit.kind === 'cyclic' || hit.kind === 'teshin-featured' ? 1 : 2);
  hits.sort((a, b) => rank(a) - rank(b));
  return { query, hits: hits.slice(0, 24), total: hits.length };
}

// ==== 行内物品图：三层链 wm thumb（已预热）→ browse.wf 原图 → AlecaFrame 插画；并发解析、失败静默无图 ====

export async function attachRowIcons(rows, { alecaDir = null } = {}) {
  const list = (rows || []).filter((row) => row?.storeItem && row.iconDataUri === undefined);
  if (!list.length) return;
  const [{ imageDataUri, gameIconDataUri }, drops] = await Promise.all([import('./wfdata.mjs'), import('./drops.mjs')]);
  let catalog = new Map();
  try { catalog = await drops.loadCatalog(alecaDir || drops.defaultAlecaDir()); } catch { catalog = new Map(); }
  let slugs = null;
  try { slugs = await drops.marketSlugMap(); } catch { slugs = null; }
  await Promise.all(list.map(async (row) => {
    // 商店路径 /Lotus/StoreItems/… vs 库存/目录路径 /Lotus/… 差一段
    const uniqueName = String(row.storeItem).replace('/StoreItems/', '/');
    const meta = catalog.get(uniqueName);
    try {
      const wmEntry = slugs && meta?.englishName ? drops.findMarketEntry(slugs, meta.englishName) : null;
      const marketImageUrl = drops.marketDisplayImageUrl(wmEntry);
      if (marketImageUrl) row.iconDataUri = await imageDataUri(marketImageUrl);
      if (!row.iconDataUri) row.iconDataUri = await gameIconDataUri(uniqueName);
      if (!row.iconDataUri && meta?.imageName) row.iconDataUri = await imageDataUri(`https://cdn.alecaframe.com/warframeData/img/${meta.imageName}`);
      if (!row.iconDataUri) row.iconDataUri = null;
    } catch { row.iconDataUri = null; }
  }));
}

// ==== 汇总入口：一次拉齐所有依赖（命令层调这个） ====

export async function loadShopContext({ inventory = null } = {}) {
  const [{ vendors, stale }, meta, names, worldState] = await Promise.all([
    loadExportVendors(),
    loadVendorMeta(),
    loadNameTables({ includeShopCatalogs: true }),
    loadOfficialWorldState(),
  ]);
  return { vendors, meta, names, worldState, inventory, stale };
}

// 按用户输入找收录商人（序号 → 别名精确 → 包含）；返回 SHOP_VENDORS 条目或 null
export function resolveVendorAlias(query) {
  const q = compact(query);
  if (!q) return null;
  // 总览卡序号直选：1 起，顺序=SHOP_VENDORS=卡片从上到下（compact 的 NFKC 已把全角数字归一）
  if (/^\d{1,2}$/u.test(q)) return SHOP_VENDORS[Number(q) - 1] || null;
  for (const entry of SHOP_VENDORS) {
    if (entry.alias.some((alias) => compact(alias) === q)) return entry;
  }
  for (const entry of SHOP_VENDORS) {
    if (entry.alias.some((alias) => compact(alias).includes(q) || q.includes(compact(alias)))) return entry;
  }
  return null;
}

// ==== CLI（探针/测试用）：node vendor-shop.mjs overview|detail <商人>|where <物品> ====
async function main() {
  const [, , command, ...rest] = process.argv;
  const context = await loadShopContext();
  if (command === 'detail') {
    const alias = resolveVendorAlias(rest.join(' '));
    if (!alias) { console.log(JSON.stringify({ ok: false, error: 'unknown vendor' })); return; }
    const detail = alias.key === 'varzia' ? buildVarziaDetail(context.worldState, context.names)
      : alias.key === 'darvo' ? buildDarvoDetail(context.worldState, context.names)
      : await buildVendorDetail(alias.key, context);
    console.log(JSON.stringify(detail, null, 1));
    return;
  }
  if (command === 'where') {
    console.log(JSON.stringify(whereToBuy(rest.join(' '), context), null, 1));
    return;
  }
  console.log(JSON.stringify(await buildShopOverview(context), null, 1));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
