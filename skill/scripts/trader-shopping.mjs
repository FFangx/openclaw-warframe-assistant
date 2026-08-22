#!/usr/bin/env node

// 奸商购物助手：到货单 × 本机库存 × 杜卡德余额 → 双路线购买建议，零 AI 判断。
// 路线 A：安全兑换 Prime 部件的白金机会成本 + 奸商现金；路线 B：当前市场可买价 + 准确交易税。
// 口径：
//  - 市场路线决策价 = 当前卖单「稳健低值」：取最低价；若最低价明显低于次低价(<70%)且低于今日成交
//    中位较多(<60%)，判定为钓鱼/抢跑单改用次低价；无卖单时回退今日成交中位(≥10 笔，或 5~9 笔且
//    偏差 ≤30%)，再回退 90 天成交中位。Baro 到访期大量低价挂单立即反映，钓鱼单不会砸穿参考价。
//  - 今日/90 天成交中位保留为对照展示；Prime MOD 用 rank 0 成交统计（奸商卖 0 级，满级价虚高）。
//  - 不可交易品标「独占无市场价」三态，绝不当 0 白金沉底。
//  - 推荐标签（2026-08-22 改）＝实用性：社区口碑分级表 baro-tier.json（S 公认必买/A 强推/B 看需求/C 收藏）
//    优先；未收录按类型兜底（遗物 A、Mod B、武器/部件 B、非交易 C）；状态优先（已有=跳过、库存不足=需补）。
//    经济数据（机会成本/现金/税/需求度）保留为三列展示与极端价格提示，不再驱动推荐标签。
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resilientJsonRequest } from './http-resilience.mjs';

const WORLDSTATE_BASE = 'https://api.warframestat.us';
const OFFICIAL_WORLDSTATE_URL = 'https://api.warframe.com/cdn/worldState.php';
const MARKET_BASE = 'https://api.warframe.market';
// 官方 worldState.php 体积大（实测 ~9s），独立宽松超时；Market 端点沿用 resilience 的 8s×2
const OFFICIAL_WORLDSTATE_TIMEOUT_MS = 20_000;
const OFFICIAL_TRADER_CACHE_TTL_MS = 2 * 60 * 1000;
const CATALOG_CACHE_TTL_MS = 60 * 60 * 1000;
const STATISTICS_CACHE_TTL_MS = 60 * 60 * 1000;
const ORDERS_CACHE_TTL_MS = 60 * 1000;
const PRICE_CONCURRENCY = 5;
const TODAY_MIN_VOLUME = 5;
const TODAY_STRONG_VOLUME = 10;
const TODAY_MAX_MEDIAN_DEVIATION = 0.30;

// 巴洛到访中继站（ExportRegions + dict.zh 实证，专名官方保留英文）
const RELAY_ZH = Object.freeze({
  MercuryHUB: 'Larunda 中继站（水星）',
  EarthHUB: 'Strata 中继站（地球）',
  SaturnHUB: 'Kronia 中继站（土星）',
  PlutoHUB: 'Orcus 中继站（冥王星）',
  TradeHUB1: "Maroo 的市集（火星）",
});

const RELAY_BY_NAME = Object.freeze({
  larunda: RELAY_ZH.MercuryHUB,
  strata: RELAY_ZH.EarthHUB,
  kronia: RELAY_ZH.SaturnHUB,
  orcus: RELAY_ZH.PlutoHUB,
  maroo: RELAY_ZH.TradeHUB1,
});

// warframestat 的 location 目前仍可能返回英文；统一成游戏内「节点 中继站（星球）」顺序。
export function normalizeTraderLocation(value) {
  const raw = String(value ?? '').normalize('NFKC').trim();
  if (!raw) return '未知中继站';
  if (RELAY_ZH[raw]) return RELAY_ZH[raw];
  const lower = raw.toLowerCase();
  for (const [name, translated] of Object.entries(RELAY_BY_NAME)) {
    if (lower.includes(name)) return translated;
  }
  return raw;
}

// 快照里代表「已拥有」的库存组（探针实测：升过级的 MOD 在 Upgrades，不在 RawUpgrades）
const OWNED_GROUPS = [
  'RawUpgrades', 'Upgrades', 'MiscItems', 'Recipes', 'Consumables', 'FlavourItems',
  'LongGuns', 'Pistols', 'Melee', 'Sentinels', 'SentinelWeapons',
  'SpaceGuns', 'SpaceMelee', 'SpaceSuits', 'OperatorAmps',
];

const DUCAT_ITEM_TYPE = '/Lotus/Types/Items/MiscItems/PrimeBucks';

// 端点健康键：与 shortcuts/wfdata 共用同一份 health 文件，熔断与累计遥测跨入口一致。
function endpointFor(url) {
  if (url.includes('worldState.php')) return 'worldstate:official:raw';
  if (url.includes('/pc/voidTrader/')) return 'worldstate:warframestat:trader';
  if (url.includes('/v2/orders/item/')) return 'market:v2:orders';
  if (url.includes('/v1/items/')) return 'market:v1:statistics';
  if (url.includes('/v2/item/')) return 'market:v2:detail';
  if (url.includes('/v2/items')) return 'market:v2:catalog';
  return 'market:unknown';
}

// 网络级错误(超时/DNS/连接)与 429/5xx 均按 http-resilience 重试并记录端点健康；403 开 15 分钟熔断。
async function getJson(url, headers = {}) {
  return resilientJsonRequest(url, {
    endpoint: endpointFor(url),
    headers,
    timeoutMs: url.includes('worldState.php') ? OFFICIAL_WORLDSTATE_TIMEOUT_MS : 8_000,
    maxAttempts: 2,
  });
}

async function mapLimit(values, limit, mapper) {
  const results = new Array(values.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (index < values.length) {
      const current = index;
      index += 1;
      results[current] = await mapper(values[current], current);
    }
  }));
  return results;
}

const compact = (value) => String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/[\s_\-:：·'’&]+/gu, '');

function editDistance(left, right) {
  const a = [...String(left || '')];
  const b = [...String(right || '')];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

// —— 奸商到货单（warframestat.us，字段契约见 WFCD VoidTraderItem：uniqueName/item/ducats/credits） ——
export async function fetchTraderState() {
  return getJson(`${WORLDSTATE_BASE}/pc/voidTrader/?language=zh`);
}
// 商店路径与库存路径对齐：/Lotus/StoreItems/… → /Lotus/…（owned 比对用快照库存路径）
const stripStoreItem = (value) => String(value ?? '').replace('/StoreItems/', '/');

// —— 官方 worldState.php VoidTraders：到货瞬间比镜像新鲜，Manifest 含 PrimePrice(杜)/RegularPrice(现金) ——
// 该文件体积大、每次 ~9s；货单只在 Baro 周期内变化，提取结果按 2 分钟 TTL 磁盘缓存；刷新失败退陈旧。
export async function fetchOfficialTrader() {
  const { staleCachedJson } = await import('./wfdata.mjs');
  const result = await staleCachedJson('official-trader-manifest', { ttlMs: OFFICIAL_TRADER_CACHE_TTL_MS, version: 1 }, async () => {
    const state = await getJson(OFFICIAL_WORLDSTATE_URL, { 'User-Agent': 'Mozilla/5.0' });
    const trader = state?.VoidTraders?.[0];
    if (!trader) throw new Error('官方 worldState 无 VoidTraders');
    const ms = (value) => Number(value?.$date?.$numberLong);
    return {
      character: "Baro Ki'Teer",
      location: RELAY_ZH[trader.Node] || trader.Node || '未知中继站',
      activation: new Date(ms(trader.Activation)).toISOString(),
      expiry: new Date(ms(trader.Expiry)).toISOString(),
      inventory: (trader.Manifest || []).map((item) => ({
        uniqueName: stripStoreItem(item.ItemType),
        item: null, // 英文名由 warframestat 同步补齐；兼不可得时用 zhOf/目录中文名兑付
        ducats: Number(item.PrimePrice) || 0,
        credits: Number(item.RegularPrice) || 0,
      })),
    };
  });
  return { ...result.data, stale: result.stale, cachedAt: result.cachedAt };
}

// 双源合并：官方定「货单+价格+时间」（真值），warframestat 补英文名；任一源挂了用另一源兼底
export function mergeTraderStates(official, wfstat) {
  if (!official) return wfstat;
  if (!wfstat) return official;
  const nameByPath = new Map((wfstat.inventory || []).map((item) => [stripStoreItem(item.uniqueName), item.item]).filter(([, name]) => name));
  return {
    ...official,
    location: normalizeTraderLocation(wfstat.location || official.location),
    inventory: (official.inventory || []).map((item) => ({ ...item, item: nameByPath.get(item.uniqueName) || item.item })),
  };
}
// —— wm 目录（1 请求持久双层缓存 1h，wm 挂掉退陈旧快照）：英文名 compact → { slug, zh }，仅精确匹配零模糊 ——
export async function loadMarketCatalog() {
  const { staleCachedJson } = await import('./wfdata.mjs');
  // version 4：保留主图与部件副图；交易税不在 /v2/items 中，另由单品详情精确读取。
  const result = await staleCachedJson('market-catalog-compact', { ttlMs: CATALOG_CACHE_TTL_MS, version: 4 }, async () => {
    const items = await getJson(`${MARKET_BASE}/v2/items`, { Platform: 'pc', Crossplay: 'true', Language: 'zh-hans' });
    const catalog = {};
    for (const item of items.data || []) {
      const en = item.i18n?.en?.name;
      if (!en) continue;
      catalog[compact(en)] = {
        slug: item.slug,
        zh: item.i18n?.['zh-hans']?.name || null,
        icon: item.i18n?.en?.icon || null,
        thumb: item.i18n?.en?.thumb || null,
        subIcon: item.i18n?.en?.subIcon || null,
        tradingTax: Number.isFinite(Number(item.tradingTax)) ? Number(item.tradingTax) : null,
      };
    }
    if (!Object.keys(catalog).length) throw new Error('wm 目录为空');
    return catalog;
  });
  return result.data;
}

// —— 库存拥有索引：uniqueName 精确比对（零名称模糊） ——
export function buildOwnedIndex(inventory) {
  const owned = new Set();
  for (const group of OWNED_GROUPS) {
    for (const entry of inventory?.[group] || []) {
      if (entry?.ItemType) owned.add(entry.ItemType);
    }
  }
  return owned;
}

export function readDucatBalance(inventory) {
  const entry = (inventory?.MiscItems || []).find((item) => item.ItemType === DUCAT_ITEM_TYPE);
  const count = Number(entry?.ItemCount);
  return Number.isFinite(count) ? count : 0;
}

const round1 = (value) => Math.round(Number(value) * 10) / 10;
const dailyAverage = (total) => {
  const average = Number(total) / 90;
  return average > 0 && average < 0.1 ? Math.round(average * 100) / 100 : round1(average);
};

const beijingDayKey = (value) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(value));
  const part = (type) => parts.find((entry) => entry.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
};

const statisticRank = (rankFilter) => {
  if (rankFilter && typeof rankFilter === 'object' && Number.isInteger(Number(rankFilter.rank))) return Number(rankFilter.rank);
  return rankFilter === true ? 0 : null;
};

const validStatisticRows = (rows, rankFilter) => (Array.isArray(rows) ? rows : []).filter((row) => {
  const rank = statisticRank(rankFilter);
  if (rank != null && Number(row?.mod_rank) !== rank) return false;
  return Number.isFinite(Number(row?.median)) && Number(row?.volume) > 0 && !Number.isNaN(new Date(row?.datetime).getTime());
});

// statistics 只给小时/日聚合，按成交量对各桶中位数再做加权中位，避免低成交时段与高成交时段等权。
const weightedMedian = (rows) => {
  const ordered = rows
    .map((row) => ({ median: Number(row.median), volume: Number(row.volume) }))
    .sort((a, b) => a.median - b.median);
  const total = ordered.reduce((sum, row) => sum + row.volume, 0);
  if (!total) return null;
  let cumulative = 0;
  for (const row of ordered) {
    cumulative += row.volume;
    if (cumulative >= total / 2) return round1(row.median);
  }
  return round1(ordered.at(-1).median);
};

export function summarizeTradeStatistics(payload, rankFilter, now = Date.now()) {
  const closed = payload?.payload?.statistics_closed || payload?.statistics_closed || {};
  const hourly = validStatisticRows(closed['48hours'], rankFilter);
  const daily = validStatisticRows(closed['90days'], rankFilter);
  const todayKey = beijingDayKey(now);
  const todayRows = hourly.filter((row) => beijingDayKey(row.datetime) === todayKey);
  const todayVolume = todayRows.reduce((sum, row) => sum + Number(row.volume), 0);
  // 近期成交量 = 统计端点 48hours 窗口全量合计（用户口径：近 48 小时成交，展示为「近期成交」）
  const recentVolume = hourly.reduce((sum, row) => sum + Number(row.volume), 0);
  const total90Volume = daily.reduce((sum, row) => sum + Number(row.volume), 0);
  const todayMedian = weightedMedian(todayRows);
  const median90 = weightedMedian(daily);
  const deviation = todayMedian != null && median90 != null && median90 > 0
    ? Math.abs(todayMedian - median90) / median90
    : null;
  const useToday = todayMedian != null && (
    todayVolume >= TODAY_STRONG_VOLUME
    || (todayVolume >= TODAY_MIN_VOLUME && deviation != null && deviation <= TODAY_MAX_MEDIAN_DEVIATION)
  );
  const platinum = useToday ? todayMedian : median90;
  if (platinum == null) return null;
  return {
    platinum,
    basis: useToday ? 'today' : '90days',
    todayVolume,
    recentVolume,
    todayMedian,
    median90,
    deviationPct: deviation == null ? null : Math.round(deviation * 100),
    dailyVolume: dailyAverage(total90Volume),
  };
}

// —— 单件估值：今日 >=10 笔直接采用；5~9 笔且相对 90 日中位偏差 <=30% 时采用；否则回退 90 日中位。——
export async function fetchTradeStatistics(slug, rankFilter, statisticsFetcher) {
  try {
    if (statisticsFetcher) return summarizeTradeStatistics(await statisticsFetcher(slug, rankFilter), rankFilter);
    const { staleCachedJson } = await import('./wfdata.mjs');
    const result = await staleCachedJson(`market-statistics-${slug}`, {
      ttlMs: STATISTICS_CACHE_TTL_MS, version: 2,
    }, async () => {
      try {
        return await getJson(`${MARKET_BASE}/v1/items/${slug}/statistics`, {
          Platform: 'pc', Crossplay: 'true', Language: 'zh-hans',
        });
      } catch (error) {
        // 确定性缺失（404）：负缓存空统计表，避免每次都重打无条目标品
        if (error?.diagnostic?.category === 'not_found') return { payload: { statistics_closed: {} } };
        throw error;
      }
    });
    const summary = summarizeTradeStatistics(result.data, rankFilter);
    return summary ? { ...summary, stale: result.stale, cachedAt: result.cachedAt } : null;
  } catch {
    return null;
  }
}

// —— 补足杜卡德缺口的「预计开遗物次数」：全库最优遗物按 Intact 概率 × 杜卡德值求每发期望，±30% 区间 ——
export function estimateRelicRuns(needDucats, bestExpectation) {
  const need = Number(needDucats);
  const expect = Number(bestExpectation);
  if (!(need > 0) || !(expect > 0)) return null;
  return { min: Math.max(1, Math.ceil(need / (expect * 1.3))), max: Math.ceil(need / (expect * 0.7)) };
}

export async function bestRelicExpectation({ relicDb = null, priceTable = null, alecaDir = null } = {}) {
  const db = relicDb
    ?? await import('./recommend.mjs').then((m) => m.loadLocalRelicDb(alecaDir)).catch(() => null);
  if (!db?.rewardsByBase) return null;
  const prices = priceTable && Object.keys(priceTable).length
    ? priceTable
    : await import('./recommend.mjs').then((m) => m.loadPriceTable()).catch(() => null) ?? null;
  let best = 0;
  for (const entries of db.rewardsByBase.values()) {
    let sum = 0;
    for (const entry of entries) {
      const ducats = Number(prices?.[String(entry.slug ?? '')]?.d) || 0;
      sum += (Number(entry.chance) || 0) / 100 * ducats;
    }
    if (sum > best) best = sum;
  }
  return best > 0 ? best : null;
}

// —— 当前卖单（全量订单端点：data 即订单数组；/top 只给每方向 5 条，不能当真实在售数）——
// 60 秒磁盘缓存：单次奸商推荐要拉 30 件商品，重复查询避免整批重打 Market；
// 挂单低值仍来自新鲜度 ≤60s 的快照，不影响「当前可买价」语义。
// 同一端点同时含求购单：buyCount/buyQty = 市场当前需求度（与社区口碑分级互为印证）。
function summarizeOrders(sell, buy) {
  const visible = (order) => order.visible !== false && Number(order.quantity) > 0;
  const sellList = sell.filter(visible);
  const buyList = buy.filter(visible);
  return {
    sell: sellList,
    buyCount: buyList.length,
    buyQty: buyList.reduce((sum, order) => sum + Number(order.quantity || 0), 0),
  };
}

export async function fetchMarketOrders(slug, ordersFetcher) {
  try {
    if (ordersFetcher) {
      const payload = await ordersFetcher(slug);
      return summarizeOrders(
        Array.isArray(payload?.sell) ? payload.sell : [],
        Array.isArray(payload?.buy) ? payload.buy : [],
      );
    }
    const { staleCachedJson } = await import('./wfdata.mjs');
    const result = await staleCachedJson(`market-orders-${slug}`, { ttlMs: ORDERS_CACHE_TTL_MS, version: 4 }, async () => {
      try {
        const payload = await getJson(`${MARKET_BASE}/v2/orders/item/${slug}`, { Platform: 'pc', Crossplay: 'true', Language: 'zh-hans' });
        const all = Array.isArray(payload?.data) ? payload.data
          : Array.isArray(payload?.payload?.orders) ? payload.payload.orders
            : [];
        return summarizeOrders(
          all.filter((order) => String(order.order_type ?? order.type ?? '') === 'sell'),
          all.filter((order) => String(order.order_type ?? order.type ?? '') === 'buy'),
        );
      } catch (error) {
        // 确定性缺失（404）：负缓存空订单，避免每次都重打无条目标品
        if (error?.diagnostic?.category === 'not_found') return summarizeOrders([], []);
        throw error;
      }
    });
    // 刷新失败退出的陈旧挂单不冒充「当前」：整体放弃，走成交统计兜底
    if (result.stale) return null;
    return result.data;
  } catch {
    return null;
  }
}

// 稳健低值：最低价与次低价差距大（<70%）、且相对今日成交中位明显偏低（<60%）时，
// 最低单按钓鱼/抢跑单剔除改用次低价；不满足则用最低价。
export function robustOrderLow(sells, todayMedian) {
  const prices = (sells || [])
    .map((order) => Number(order?.platinum))
    .filter((price) => Number.isFinite(price) && price > 0)
    .sort((a, b) => a - b);
  if (!prices.length) return { orderLow: null, orderCount: 0, orderLowSuspicious: false };
  const low1 = prices[0];
  const low2 = prices[1] ?? null;
  const suspicious = low2 != null && low1 < low2 * 0.7
    && (todayMedian == null || low1 < todayMedian * 0.6);
  return {
    orderLow: Math.round((suspicious ? low2 : low1) * 10) / 10,
    orderCount: prices.length,
    orderLowSuspicious: Boolean(suspicious),
  };
}

// 市场路线最终参考价（对比价）：当前卖单稳健低值优先；无卖单改用今日成交中位；
// Baro 期 90 天历史价混入非奸商期行情且被奸商冲击，无参考价值，不再兜底；
// 两者都没有 → null（卡片显示市价待定）。对比价即「省 X 白金」的基数。
export function resolveMarketReference(statistics, order) {
  const orderOk = order?.orderLow != null;
  const todayOk = statistics?.todayMedian != null;
  return {
    platinum: orderOk ? order.orderLow : (todayOk ? statistics.todayMedian : null),
    marketBasis: orderOk ? 'orders' : (todayOk ? 'today' : null),
    orderLow: order?.orderLow ?? null,
    orderCount: order?.orderCount ?? null,
    orderLowSuspicious: Boolean(order?.orderLowSuspicious),
    todayVolume: statistics?.todayVolume ?? null,
    recentVolume: statistics?.recentVolume ?? null,
    todayMedian: statistics?.todayMedian ?? null,
    median90: statistics?.median90 ?? null,
    dailyVolume: statistics?.dailyVolume ?? null,
    deviationPct: statistics?.deviationPct ?? null,
    stale: statistics?.stale ?? null,
    cachedAt: statistics?.cachedAt ?? null,
  };
}

// —— 实用性推荐：社区口碑分级表（baro-tier.json）+ 状态优先，价格不再驱动标签 ——
let baroTierCache = null;
export function loadBaroTier() {
  if (baroTierCache) return baroTierCache;
  try {
    baroTierCache = JSON.parse(readFileSync(new URL('./baro-tier.json', import.meta.url), 'utf8'));
  } catch {
    baroTierCache = { items: {}, tiers: {} };
  }
  return baroTierCache;
}

const TIER_ADVICE = {
  S: { tag: 'must', zh: '公认必买' },
  A: { tag: 'good', zh: '强推' },
  B: { tag: 'choice', zh: '看需求' },
  C: { tag: 'premium', zh: '收藏向' },
};

// 分级：表命中 > 类型兜底（遗物 A、Mod/武器/部件 B、非交易 C）
export function gradeBaroItem(row, overrides = null) {
  const table = overrides ?? loadBaroTier();
  const items = table.items ?? table; // 兼容 {items:{...}} 表对象与测试注平的 {slug:tier}
  const key = String(row.slug ?? row.nameEn ?? '').toLowerCase();
  const tier = items?.[key] ?? null;
  if (tier) return tier;
  if (!row.tradable) return 'C';
  const un = String(row.uniqueName ?? '');
  const zhName = String(row.zhName ?? '');
  if (/Relic/u.test(un) || /遗物/u.test(row.nameEn ?? '') || /遗物/u.test(zhName)) return 'B'; // 兜底=看需求；动态判定（奖励 vs 库存）在 appraise 层升级为 A
  return 'B';
}

export function decidePractical(row, tier) {
  if (!row.tradable && !row.relicKind) return row.owned ? { tag: 'skip', zh: '已有' } : { tag: 'exclusive', zh: '独占·收藏' };
  if (row.owned) return { tag: 'skip', zh: '已有·跳过' };
  return TIER_ADVICE[tier] ?? TIER_ADVICE.B;
}

// 旧经济性判定：保留导出（测试/回退用），主流程不再接线
export function decide(row) {
  if (!row.tradable) return row.owned ? { tag: 'skip', zh: '已拥有' } : { tag: 'exclusive', zh: '独占·看喜好' };
  const ratio = row.ratio ?? 0;
  if (!row.owned) return ratio >= 0.15 ? { tag: 'strong', zh: '强烈买' } : { tag: 'buy', zh: '顺手买' };
  return ratio >= 0.25 ? { tag: 'flip', zh: '可囤倒卖' } : { tag: 'skip', zh: '跳过' };
}

// /v2/items 目录不含 tradingTax/description → 一次性构建本地清单 baro-static.json
// （tradingTax/description 是不变信息；运行时优先读清单，仅清单外商品在线兜底，减少限流压力）。
let baroStaticCache = null;
export function loadBaroStatic() {
  if (baroStaticCache) return baroStaticCache;
  try {
    baroStaticCache = JSON.parse(readFileSync(new URL('./baro-static.json', import.meta.url), 'utf8'));
  } catch {
    baroStaticCache = { items: {} };
  }
  return baroStaticCache;
}

async function fetchItemInfo(slug, detailFetcher) {
  if (detailFetcher) {
    const detail = await detailFetcher(slug);
    const tax = Number(detail?.tradingTax ?? detail?.data?.tradingTax ?? detail);
    return {
      tradingTax: Number.isFinite(tax) && tax > 0 ? tax : null,
      description: detail?.data?.i18n?.['zh-hans']?.description ?? detail?.i18n?.['zh-hans']?.description ?? null,
    };
  }
  const staticEntry = loadBaroStatic().items?.[slug];
  if (staticEntry) return { tradingTax: staticEntry.tax ?? null, description: staticEntry.desc ?? null };
  try {
    const { staleCachedJson } = await import('./wfdata.mjs');
    const result = await staleCachedJson(`market-item-detail-${slug}`, { ttlMs: 7 * 24 * 60 * 60 * 1000, version: 3 }, async () => {
      try {
        const payload = await getJson(`${MARKET_BASE}/v2/item/${slug}`, { Platform: 'pc', Crossplay: 'true', Language: 'zh-hans' });
        return {
          tradingTax: payload.data?.tradingTax ?? null,
          description: payload.data?.i18n?.['zh-hans']?.description ?? null,
        };
      } catch (error) {
        // 确定性缺失（404）：负缓存 7 天，货单里无条目标品不再每次重打
        if (error?.diagnostic?.category === 'not_found') return { tradingTax: null, description: null };
        throw error;
      }
    });
    const tax = Number(result.data?.tradingTax);
    return {
      tradingTax: Number.isFinite(tax) && tax > 0 ? tax : null,
      description: result.data?.description ?? null,
    };
  } catch { return { tradingTax: null, description: null }; }
}

// 两条路线的双轴判断。现金不折算成白金：一边省白金、一边省现金时
// 明确给出取舍与盈亏平衡提示，避免伪造个人「现金汇率」。
export function decideEconomicRoute(row) {
  if (!row.tradable) return row.owned ? { tag: 'skip', zh: '已拥有' } : { tag: 'exclusive', zh: '独占·看喜好' };
  if (row.ducatOpportunityPlat == null || row.platinum == null) return decide(row);
  const platSaving = Number(row.platSaving) || 0;
  const creditKnown = row.creditSaving != null;
  const creditSaving = Number(row.creditSaving) || 0;
  if (row.owned) {
    if (platSaving > 0 && (!creditKnown || creditSaving >= 0)) return { tag: 'flip', zh: '可囤倒卖' };
    return { tag: 'skip', zh: '已有·跳过' };
  }
  if (platSaving >= 0 && (!creditKnown || creditSaving >= 0)) return { tag: 'strong', zh: '强烈买' };
  if (platSaving >= 0) return { tag: 'buy', zh: '可以买' };
  if (creditKnown && creditSaving > 0) {
    const extraPlat = Math.abs(platSaving);
    const modestPremium = extraPlat <= Math.max(3, Number(row.platinum) * 0.15);
    return modestPremium ? { tag: 'cash', zh: '省现金' } : { tag: 'choice', zh: '看需求' };
  }
  return { tag: 'market', zh: '市场买' };
}

// goods: [{uniqueName,item,ducats,credits}]；options 可注入 catalog/owned/statisticsFetcher/zhOf 打桩
export async function appraiseTraderGoods(goods, options = {}) {
  const catalog = options.catalog ?? await loadMarketCatalog();
  const owned = options.owned ?? new Set();
  // 中文名反查索引（官方源无英文名时用 lang.json 中文名匹配 wm 目录）：从同一份目录现建，零额外请求
  const catalogByZh = new Map(Object.values(catalog).filter((meta) => meta?.zh).map((meta) => [compact(meta.zh), meta]));
  // 遗物动态分级：RewardsByBase（Relics.json Intact 行，只读）÷ 库存已拥有部件（valuation englishName）
  let relicDbPromise = null;
  const relicDbOf = () => {
    if (!relicDbPromise) {
      relicDbPromise = (async () => {
        if (options.relicDb) return options.relicDb;
        const { loadLocalRelicDb } = await import('./recommend.mjs');
        return loadLocalRelicDb(options.alecaDir);
      })().catch(() => null);
    }
    return relicDbPromise;
  };
  const ownedEnglishNames = new Set((options.inventoryValuation ?? [])
    .map((entry) => compact(String(entry.englishName ?? '')))
    .filter(Boolean));
  const RARITY_RANK = { Rare: 0, Uncommon: 1, Common: 2 };
  const isRelicRow = (row) => /Relic/u.test(row.uniqueName ?? '') || /遗物/u.test(row.nameEn ?? '') || /遗物/u.test(row.zhName ?? '');
  const enrichRelicRow = async (row) => {
    if (!isRelicRow(row)) return row;
    row.relicKind = true; // 遗物：即使 Market 无商品条目也按实用性分级（动态 A/B），不作独占
    const db = await relicDbOf();
    const nameEn = String(row.nameEn ?? '').trim();
    // 货单可能带 Relic 后缀（如 'Neo M5 Relic'），遗物库键去后缀（'Neo M5'）
    const baseName = nameEn.replace(/\s+relic$/iu, '').trim();
    const entries = db?.rewardsByBase?.get(baseName) ?? db?.rewardsByBase?.get(nameEn);
    if (!Array.isArray(entries) || !entries.length) return row;
    const missing = entries
      .filter((entry) => !ownedEnglishNames.has(compact(String(entry.name ?? ''))))
      .sort((a, b) => (RARITY_RANK[a.rarity] ?? 9) - (RARITY_RANK[b.rarity] ?? 9));
    row.relicParts = {
      total: entries.length,
      missingCount: missing.length,
      missing: missing.slice(0, 4).map((entry) => ({ name: entry.name, rare: entry.rarity === 'Rare' })),
    };
    if (missing.length) row.tier = 'A'; // 仍有未持有部件 → 强推；全有/无数据 → 保持兜底 B
    return row;
  };
  const rows = await mapLimit(goods, PRICE_CONCURRENCY, async (entry) => {
    const isMod = /\/Mods\//u.test(entry.uniqueName || '');
    const zhLocal = entry.zhLocal ?? options.zhOf?.(entry.uniqueName) ?? null;
    const meta = catalog[compact(entry.item)] || (zhLocal ? catalogByZh.get(compact(zhLocal)) : null) || null;
    const base = {
      uniqueName: entry.uniqueName,
      nameEn: entry.item,
      zhName: meta?.zh || zhLocal || null,
      slug: meta?.slug ?? null,
      wmIcon: meta?.icon || null,
      wmThumb: meta?.thumb || null,
      wmSubIcon: meta?.subIcon || null,
      ducats: Number(entry.ducats) || 0,
      credits: Number(entry.credits) || 0,
      // 商店路径归一后比对：快照库存用的是非 StoreItems 路径
      owned: owned.has(stripStoreItem(entry.uniqueName)),
      tradable: Boolean(meta),
    };
    // 单件行情/税/挂单失败不整条爆炸：该行无价继续展示（诚实降级），其余商品照常建议
    try {
      const [quote, itemInfo, rawOrders] = meta ? await Promise.all([
        fetchTradeStatistics(meta.slug, isMod, options.statisticsFetcher),
        fetchItemInfo(meta.slug, options.detailFetcher),
        fetchMarketOrders(meta.slug, options.ordersFetcher),
      ]) : [null, { tradingTax: null, description: null }, null];
      const orderInfo = rawOrders
        ? robustOrderLow(rawOrders.sell, quote?.todayMedian ?? null)
        : { orderLow: null, orderCount: 0, orderLowSuspicious: false };
      const ref = resolveMarketReference(quote, orderInfo);
      const row = {
        ...base,
        platinum: ref.platinum,
        marketBasis: ref.marketBasis,
        orderLow: ref.orderLow,
        orderCount: ref.orderCount,
        orderLowSuspicious: ref.orderLowSuspicious,
        marketStatsStale: Boolean(ref.stale),
        marketStatsCachedAt: ref.cachedAt ?? null,
        todayVolume: ref.todayVolume ?? null,
        recentVolume: ref.recentVolume ?? null,
        todayMedian: ref.todayMedian ?? null,
        median90: ref.median90 ?? null,
        dailyVolume: ref.dailyVolume ?? null,
        deviationPct: ref.deviationPct ?? null,
        buyCount: rawOrders?.buyCount ?? null,
        buyQty: rawOrders?.buyQty ?? null,
        tradingTax: itemInfo?.tradingTax ?? meta?.tradingTax ?? null,
        description: itemInfo?.description ?? null,
      };
      const ratio = row.platinum != null && row.ducats > 0 ? row.platinum / row.ducats : null;
      row.ratio = ratio != null ? Math.round(ratio * 100) / 100 : null;
      row.tier = gradeBaroItem(row, options.tierOverride ?? null);
      await enrichRelicRow(row);
      return { ...row, advice: decidePractical(row, row.tier) };
    } catch {
      const row = {
        ...base,
        platinum: null, marketBasis: null, orderLow: null, orderCount: null, orderLowSuspicious: false,
        marketStatsStale: false, marketStatsCachedAt: null, todayVolume: null, recentVolume: null,
        todayMedian: null,
        median90: null, dailyVolume: null, deviationPct: null, ratio: null, tradingTax: null,
      };
      row.tier = gradeBaroItem(row, options.tierOverride ?? null);
      await enrichRelicRow(row);
      return { ...row, advice: decidePractical(row, row.tier) };
    }
  });
  // 排序：实用性分级优先；同分级按商品杜卡德价值；独占收藏压后但不在沉底（放跳过之前）
  const rank = { must: 0, good: 1, need: 2, choice: 3, exclusive: 4, premium: 4, skip: 5 };
  rows.sort((a, b) => (rank[a.advice.tag] - rank[b.advice.tag]) || ((b.ducats ?? 0) - (a.ducats ?? 0)) || ((b.ratio ?? -1) - (a.ratio ?? -1)));
  return rows;
}

// 主入口：inventory=解密后的快照库存对象；traderState/officialTrader/catalog/statisticsFetcher/zhOf 可注入
export async function traderShopping(inventory, options = {}) {
  // 双源并发：官方源权威（到货瞬间无镜像延迟），warframestat 补英文名；全挂才报错
  let state = options.traderState ?? null;
  if (!state) {
    const [official, wfstat] = await Promise.allSettled([
      options.officialTrader !== undefined ? Promise.resolve(options.officialTrader) : fetchOfficialTrader(),
      fetchTraderState(),
    ]);
    state = mergeTraderStates(
      official.status === 'fulfilled' ? official.value : null,
      wfstat.status === 'fulfilled' ? wfstat.value : null,
    );
    if (!state) throw (official.status === 'rejected' ? official.reason : new Error('奌商数据源全部不可用'));
  }
  const fetchedAt = new Date().toISOString();
  const base = {
    kind: 'trader-shopping',
    fetchedAt,
    character: state.character || "Baro Ki'Teer",
    location: normalizeTraderLocation(state.location),
    activation: state.activation,
    expiry: state.expiry,
    ducatBalance: readDucatBalance(inventory),
  };
  if (!Array.isArray(state.inventory) || !state.inventory.length) {
    return { ...base, ok: true, arrived: false, rows: [] };
  }
  const owned = buildOwnedIndex(inventory);
  const rows = await appraiseTraderGoods(state.inventory, { ...options, owned });
  let safeDucatAvailable = null;
  // 双路线经济性：奸商=兑换杜卡德的 Prime 部件机会成本+现金标价；
  // 玩家市场=今日/90 天成交中位价+物品交易税。现金不硬折白金，保留双轴结论。
  if (Array.isArray(options.inventoryValuation) && options.inventoryValuation.length) {
    try {
      const { parseDucatSpec, buildDucatCandidates, refreshDucatPrices, optimizeDucatTarget } = await import('./ducat-planner.mjs');
      // 机会成本按「激进」口径：补足杜卡德时可动用全部部件（含已入库）。
      // 这是市场对比的假设口径，不改变「杜卡德 X」命令默认的已入库保护。
      const spec = parseDucatSpec('杜卡德 激进');
      const ducatCandidates = await refreshDucatPrices(buildDucatCandidates(options.inventoryValuation, spec), {
        maxStatisticsQuotes: options.maxDucatStatisticsQuotes ?? options.maxLiveDucatQuotes ?? 24,
        ...(options.ducatStatisticsFetcher ? { statisticsFetcher: options.ducatStatisticsFetcher } : {}),
        ...(options.ducatCatalog ? { catalog: options.ducatCatalog } : {}),
      });
      safeDucatAvailable = ducatCandidates.reduce((sum, entry) => sum + entry.available * entry.ducatsEach, 0);
      const currentCredits = Number(inventory?.RegularCredits) || 0;
      // 预计开遗物次数：全库最优遗物每发期望杜卡德（Intact 口径，±30% 区间）；失败不阻塞
      const bestExpectation = await bestRelicExpectation({
        relicDb: options.relicDb,
        priceTable: options.priceTable,
        alecaDir: options.alecaDir,
      }).catch(() => null);
      for (const row of rows) {
        // 遗物即使无 Market 条目也参与补足/次数计算；其余商品仍要求可交易且有对比价
        if ((!row.tradable && !row.relicKind) || (!row.relicKind && row.platinum == null) || row.ducats <= 0) continue;
        // 行级结论表示「只买这一件」：已有杜卡德先抵扣，只为缺口找部件。
        const immediateNeed = Math.max(0, row.ducats - base.ducatBalance);
        const plan = immediateNeed > 0
          ? optimizeDucatTarget(ducatCandidates, immediateNeed)
          : { complete: true, target: 0, totalDucats: 0, totalPlat: 0, rows: [] };
        row.ducatNeed = immediateNeed;
        row.ducatPlanDucats = plan.totalDucats;
        if (row.ducatNeed + (row.ducatPlanShortfall ?? 0) > 0) {
          row.relicRuns = estimateRelicRuns(row.ducatNeed + (row.ducatPlanShortfall ?? 0), bestExpectation);
        }
        if (!plan.complete) {
          row.ducatPlanShortfall = Math.max(0, immediateNeed - plan.totalDucats);
          row.advice = { tag: 'need', zh: '库存不足' };
          continue;
        }
        row.ducatOpportunityPlat = plan.totalPlat;
        row.platSaving = row.platinum == null ? null : Math.round((row.platinum - plan.totalPlat) * 10) / 10;
        row.creditSaving = row.tradingTax == null ? null : row.tradingTax - row.credits;
        row.vendorCreditPressure = currentCredits > 0 ? Math.round(row.credits / currentCredits * 1000) / 10 : null;
        row.marketCreditPressure = row.tradingTax != null && currentCredits > 0 ? Math.round(row.tradingTax / currentCredits * 1000) / 10 : null;
        if (row.platSaving < 0 && row.creditSaving > 0) {
          row.breakEvenCreditsPerPlat = Math.round(row.creditSaving / Math.abs(row.platSaving));
        }
        // 推荐标签由实用性决定（社区口碑分级 + 状态）；经济数据只作三列展示与极端价格提示
        row.advice = decidePractical(row, row.tier);
      }
      // 先展示实用分级；独占收藏放在之后，避免长货单淹没关键信息
      const practicalRank = { must: 0, good: 1, need: 2, choice: 3, exclusive: 4, premium: 4, skip: 5 };
      rows.sort((a, b) => (practicalRank[a.advice.tag] ?? 99) - (practicalRank[b.advice.tag] ?? 99)
        || (b.ducats ?? 0) - (a.ducats ?? 0)
        || (b.ratio ?? -1) - (a.ratio ?? -1));
    } catch { /* 兑换估值失败时保留实用性分级推荐 */ }
  }
  // 购物车口径：所有「推荐买」（S 公认必买/A 强推）的杜卡德合计 vs 余额
  const wantDucats = rows.filter((row) => ['must', 'good'].includes(row.advice.tag))
    .reduce((sum, row) => sum + row.ducats, 0);
  return {
    ...base,
    ok: true,
    arrived: true,
    rows,
    currentCredits: Number(inventory?.RegularCredits) || 0,
    safeDucatAvailable,
    wantDucats,
    ducatShortfall: Math.max(0, wantDucats - base.ducatBalance),
    affordable: base.ducatBalance >= wantDucats,
  };
}

// 为裂缝推荐解析一个可交易的奸商目标。自动模式只选当前推荐/缺杜卡德的商品；
// 指定模式允许直接按中英文商品名匹配当前货单，但不可交易品没有市场对标口径。
export function selectTraderGoal(result, target = { type: 'trader', query: '' }) {
  if (!result?.arrived) return { ok: false, error: 'trader_not_arrived' };
  const tradable = (result.rows || []).filter((row) => row.tradable && Number(row.platinum) > 0 && Number(row.ducats) > 0);
  let row = null;
  if (target.type === 'item') {
    const needle = compact(target.query);
    const exact = tradable.filter((item) => [item.zhName, item.nameEn].some((name) => compact(name) === needle));
    const partial = tradable.filter((item) => [item.zhName, item.nameEn].some((name) => compact(name).includes(needle)));
    const fuzzy = needle.length >= 4
      ? tradable.map((item) => ({ item, distance: Math.min(...[item.zhName, item.nameEn].filter(Boolean).map((name) => editDistance(compact(name), needle))) }))
        .sort((a, b) => a.distance - b.distance)
      : [];
    const uniqueFuzzy = fuzzy[0]?.distance <= 1 && fuzzy[1]?.distance !== fuzzy[0].distance ? fuzzy[0].item : null;
    row = exact[0] || partial[0] || uniqueFuzzy || null;
    if (!row) return { ok: false, error: 'trader_item_not_found', query: target.query };
  } else {
    const priority = { must: 0, good: 1, need: 2 };
    row = tradable.filter((item) => priority[item.advice?.tag] != null)
      .sort((a, b) => priority[a.advice.tag] - priority[b.advice.tag]
        || (b.ratio ?? -1) - (a.ratio ?? -1)
        || (b.dailyVolume ?? 0) - (a.dailyVolume ?? 0))[0] || null;
    if (!row) return { ok: false, error: 'no_recommended_trader_target' };
  }
  const ducatsPerPlat = Math.round(Number(row.ducats) / Number(row.platinum) * 10) / 10;
  return {
    ok: true,
    goal: {
      source: target.type === 'item' ? 'item' : 'trader',
      name: row.zhName || row.nameEn || '目标商品',
      nameEn: row.nameEn || null,
      uniqueName: row.uniqueName,
      ducats: Number(row.ducats),
      currentDucats: Number(result.ducatBalance) || 0,
      shortfall: Math.max(0, Number(row.ducats) - (Number(result.ducatBalance) || 0)),
      marketPlat: Number(row.platinum),
      ducatsPerPlat,
      marketBasis: row.marketBasis || null,
      todayVolume: row.todayVolume ?? null,
      median90: row.median90 ?? null,
      dailyVolume: row.dailyVolume ?? null,
      credits: Number(row.credits) || 0,
      tradingTax: row.tradingTax ?? null,
      advice: row.advice || null,
    },
  };
}

// 本机系统时区不是北京时间，所有用户可见时间必须显式指定 Asia/Shanghai
const beijingTime = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未知时间';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
};

export function formatTraderShopping(result) {
  if (!result.arrived) {
    return `奸商 ${result.character} 尚未到达。预计 ${beijingTime(result.activation)} 到 ${result.location}；到货后再来问「奸商买什么」。当前杜卡德余额 ${result.ducatBalance.toLocaleString('zh-CN')}。`;
  }
  const lines = [`【奸商购物推荐】${result.location}｜杜卡德余额 ${result.ducatBalance.toLocaleString('zh-CN')}`];
  for (const row of result.rows.slice(0, 16)) {
    const name = row.zhName || (row.tradable ? row.nameEn : '未收录物品');
    const basis = row.marketBasis === 'orders' ? `当前售价 ${row.platinum}p（${row.orderCount ?? 0} 单在售${row.orderLowSuspicious ? '·已剔除异常低单' : ''}）`
      : row.marketBasis === 'today' ? `今日成交中位 ${row.platinum}p（${row.todayVolume ?? 0} 笔）`
        : '市价待定（无近期成交）';
    const price = row.tradable
      ? row.platinum != null
        ? `${basis}${row.marketStatsStale ? '（缓存）' : ''}`
        : '市价待定（无近期成交）'
      : '独占无市场价';
    const ratio = row.ratio != null ? `｜1杜=${row.ratio}p` : '';
    // 所有可交易商品统一展示：补足杜卡德（或缺口）/ 奸商价 / 交易税，无论推荐与否
    const tax = row.tradingTax == null ? '未知' : row.tradingTax.toLocaleString('zh-CN');
    const credits = row.credits.toLocaleString('zh-CN');
    const route = !row.tradable
      ? ''
      : row.ducatOpportunityPlat != null
        ? `｜补足${row.ducatNeed}杜≈${row.ducatOpportunityPlat}p｜奸商 ${credits}现金｜税 ${tax}`
        : row.ducatPlanShortfall != null
          ? `｜还差${row.ducatPlanShortfall}杜（库存可动${row.ducatPlanDucats ?? 0}杜）｜奸商 ${credits}现金｜税 ${tax}`
          : `｜奸商 ${credits}现金｜税 ${tax}`;
    lines.push(`${row.advice.zh}｜${name}｜${row.ducats}杜+${credits}现金｜${price}${route}${ratio}${row.owned ? '｜已有' : ''}`);
  }
  if (result.rows.length > 16) lines.push(`其余 ${result.rows.length - 16} 件已在卡片中省略，优先保留会影响购买决策的项目。`);
  lines.push(`经济性推荐合计 ${result.wantDucats} 杜卡德${result.affordable ? '，余额够用' : `，还差 ${result.ducatShortfall} 杜卡德，可发「杜卡德 ${result.ducatShortfall}」生成兑换方案`}。市场路线优先当前售价（剔除异常低单），无卖单改用今日成交中位；90 天历史价不适用 Baro 期行情；补足杜卡德按激进口径（含已入库部件）估算；仅供参考。`);
  return lines.join('\n');
}
