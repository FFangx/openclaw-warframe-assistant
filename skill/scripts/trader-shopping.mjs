#!/usr/bin/env node

// 奸商购物助手：到货单 × 本机库存 × 杜卡德余额 → 双路线购买建议，零 AI 判断。
// 路线 A：安全兑换 Prime 部件的白金机会成本 + 奸商现金；路线 B：成交中位价 + 准确交易税。
// 口径：Prime MOD 用 rank 0 成交统计（奸商卖 0 级，满级价含 4 万 Endo 虚高）；
//      不可交易品标「独占无市场价」三态，绝不当 0 白金沉底。
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const WORLDSTATE_BASE = 'https://api.warframestat.us';
const OFFICIAL_WORLDSTATE_URL = 'https://api.warframe.com/cdn/worldState.php';
const MARKET_BASE = 'https://api.warframe.market';
const TIMEOUT_MS = 20_000;
const CATALOG_CACHE_TTL_MS = 60 * 60 * 1000;
const STATISTICS_CACHE_TTL_MS = 15 * 60 * 1000;
const PRICE_CONCURRENCY = 3;
const TODAY_MIN_VOLUME = 3;

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

async function getJson(url, headers = {}, attempt = 0) {
  const response = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) {
    if (attempt < 2 && (response.status === 429 || response.status >= 500)) {
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      return getJson(url, headers, attempt + 1);
    }
    throw new Error(`HTTP ${response.status}: ${url}`);
  }
  return response.json();
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
export async function fetchOfficialTrader() {
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
  // version 3：目录结构升级；交易税不在 /v2/items 中，另由单品详情精确读取。
  const result = await staleCachedJson('market-catalog-compact', { ttlMs: CATALOG_CACHE_TTL_MS, version: 3 }, async () => {
    const items = await getJson(`${MARKET_BASE}/v2/items`, { Platform: 'pc', Crossplay: 'true', Language: 'zh-hans' });
    const catalog = {};
    for (const item of items.data || []) {
      const en = item.i18n?.en?.name;
      if (!en) continue;
      catalog[compact(en)] = {
        slug: item.slug,
        zh: item.i18n?.['zh-hans']?.name || null,
        thumb: item.i18n?.en?.thumb || null,
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

const validStatisticRows = (rows, isMod) => (Array.isArray(rows) ? rows : []).filter((row) => {
  if (isMod && Number(row?.mod_rank) !== 0) return false;
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

export function summarizeTradeStatistics(payload, isMod, now = Date.now()) {
  const closed = payload?.payload?.statistics_closed || payload?.statistics_closed || {};
  const hourly = validStatisticRows(closed['48hours'], isMod);
  const daily = validStatisticRows(closed['90days'], isMod);
  const todayKey = beijingDayKey(now);
  const todayRows = hourly.filter((row) => beijingDayKey(row.datetime) === todayKey);
  const todayVolume = todayRows.reduce((sum, row) => sum + Number(row.volume), 0);
  const total90Volume = daily.reduce((sum, row) => sum + Number(row.volume), 0);
  const todayMedian = weightedMedian(todayRows);
  const median90 = weightedMedian(daily);
  const useToday = todayMedian != null && todayVolume >= TODAY_MIN_VOLUME;
  const platinum = useToday ? todayMedian : median90;
  if (platinum == null) return null;
  return {
    platinum,
    basis: useToday ? 'today' : '90days',
    todayVolume,
    median90,
    dailyVolume: dailyAverage(total90Volume),
  };
}

// —— 单件估值：优先今日真实成交中位（至少 3 笔），样本不足回退 90 天成交中位；失败退统计缓存 ——
async function fetchTradeStatistics(slug, isMod, statisticsFetcher) {
  try {
    if (statisticsFetcher) return summarizeTradeStatistics(await statisticsFetcher(slug, isMod), isMod);
    const { staleCachedJson } = await import('./wfdata.mjs');
    const result = await staleCachedJson(`market-statistics-${slug}`, {
      ttlMs: STATISTICS_CACHE_TTL_MS, version: 1,
    }, () => getJson(`${MARKET_BASE}/v1/items/${slug}/statistics`, {
      Platform: 'pc', Crossplay: 'true', Language: 'zh-hans',
    }));
    const summary = summarizeTradeStatistics(result.data, isMod);
    return summary ? { ...summary, stale: result.stale, cachedAt: result.cachedAt } : null;
  } catch {
    return null;
  }
}

// 推荐矩阵：缺+贵=强烈买；缺+便宜=顺手买；已有+比值高=可倒卖；已有+比值低=跳过
export function decide(row) {
  if (!row.tradable) return row.owned ? { tag: 'skip', zh: '已拥有' } : { tag: 'exclusive', zh: '独占·看喜好' };
  const ratio = row.ratio ?? 0;
  if (!row.owned) return ratio >= 0.15 ? { tag: 'strong', zh: '强烈买' } : { tag: 'buy', zh: '顺手买' };
  return ratio >= 0.25 ? { tag: 'flip', zh: '可囤倒卖' } : { tag: 'skip', zh: '跳过' };
}

// /v2/items 目录不含 tradingTax，必须查单品详情；税值基本静态，按物品缓存 7 天。
async function fetchTradingTax(slug, detailFetcher) {
  if (detailFetcher) {
    const detail = await detailFetcher(slug);
    const tax = Number(detail?.tradingTax ?? detail?.data?.tradingTax ?? detail);
    return Number.isFinite(tax) ? tax : null;
  }
  try {
    const { staleCachedJson } = await import('./wfdata.mjs');
    const result = await staleCachedJson(`market-item-detail-${slug}`, { ttlMs: 7 * 24 * 60 * 60 * 1000, version: 1 }, async () => {
      const payload = await getJson(`${MARKET_BASE}/v2/item/${slug}`, { Platform: 'pc', Crossplay: 'true', Language: 'zh-hans' });
      return { tradingTax: payload.data?.tradingTax ?? null };
    });
    const tax = Number(result.data?.tradingTax);
    return Number.isFinite(tax) ? tax : null;
  } catch { return null; }
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
  const rows = await mapLimit(goods, PRICE_CONCURRENCY, async (entry) => {
    const isMod = /\/Mods\//u.test(entry.uniqueName || '');
    const zhLocal = entry.zhLocal ?? options.zhOf?.(entry.uniqueName) ?? null;
    const meta = catalog[compact(entry.item)] || (zhLocal ? catalogByZh.get(compact(zhLocal)) : null) || null;
    const [quote, tradingTax] = meta ? await Promise.all([
      fetchTradeStatistics(meta.slug, isMod, options.statisticsFetcher),
      fetchTradingTax(meta.slug, options.detailFetcher),
    ]) : [null, null];
    const platinum = quote?.platinum ?? null;
    const ducats = Number(entry.ducats) || 0;
    // 比值 = 白金/杜卡德：花同样杜卡德换回最多白金的货排最前
    const ratio = platinum != null && ducats > 0 ? platinum / ducats : null;
    const row = {
      uniqueName: entry.uniqueName,
      nameEn: entry.item,
      zhName: meta?.zh || zhLocal || null,
      wmThumb: meta?.thumb || null,
      ducats,
      credits: Number(entry.credits) || 0,
      // 商店路径归一后比对：快照库存用的是非 StoreItems 路径
      owned: owned.has(stripStoreItem(entry.uniqueName)),
      tradable: Boolean(meta),
      platinum,
      marketBasis: quote?.basis ?? null,
      marketStatsStale: Boolean(quote?.stale),
      marketStatsCachedAt: quote?.cachedAt ?? null,
      todayVolume: quote?.todayVolume ?? null,
      median90: quote?.median90 ?? null,
      dailyVolume: quote?.dailyVolume ?? null,
      ratio: ratio != null ? Math.round(ratio * 100) / 100 : null,
      tradingTax: tradingTax ?? meta?.tradingTax ?? null,
    };
    return { ...row, advice: decide(row) };
  });
  // 排序：可交易按比值降序；独占压后但不沉底（放跳过之前）
  const rank = { strong: 0, buy: 1, flip: 2, exclusive: 3, skip: 4 };
  rows.sort((a, b) => (rank[a.advice.tag] - rank[b.advice.tag]) || ((b.ratio ?? -1) - (a.ratio ?? -1)) || b.ducats - a.ducats);
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
      const spec = parseDucatSpec('杜卡德 保留1');
      const ducatCandidates = await refreshDucatPrices(buildDucatCandidates(options.inventoryValuation, spec), {
        maxLiveQuotes: options.maxLiveDucatQuotes ?? 12,
        ...(options.ducatQuoteFetcher ? { quoteFetcher: options.ducatQuoteFetcher } : {}),
        ...(options.ducatCatalog ? { catalog: options.ducatCatalog } : {}),
      });
      safeDucatAvailable = ducatCandidates.reduce((sum, entry) => sum + entry.available * entry.ducatsEach, 0);
      const currentCredits = Number(inventory?.RegularCredits) || 0;
      for (const row of rows) {
        if (!row.tradable || row.platinum == null || row.ducats <= 0) continue;
        // 行级结论表示「只买这一件」：已有杜卡德先抵扣，只为缺口找部件。
        const immediateNeed = Math.max(0, row.ducats - base.ducatBalance);
        const plan = immediateNeed > 0
          ? optimizeDucatTarget(ducatCandidates, immediateNeed)
          : { complete: true, target: 0, totalDucats: 0, totalPlat: 0, rows: [] };
        row.ducatNeed = immediateNeed;
        row.ducatPlanDucats = plan.totalDucats;
        if (!plan.complete) {
          row.ducatPlanShortfall = Math.max(0, immediateNeed - plan.totalDucats);
          row.advice = { tag: 'need', zh: '库存不足' };
          continue;
        }
        row.ducatOpportunityPlat = plan.totalPlat;
        row.platSaving = Math.round((row.platinum - plan.totalPlat) * 10) / 10;
        row.creditSaving = row.tradingTax == null ? null : row.tradingTax - row.credits;
        row.vendorCreditPressure = currentCredits > 0 ? Math.round(row.credits / currentCredits * 1000) / 10 : null;
        row.marketCreditPressure = row.tradingTax != null && currentCredits > 0 ? Math.round(row.tradingTax / currentCredits * 1000) / 10 : null;
        if (row.platSaving < 0 && row.creditSaving > 0) {
          row.breakEvenCreditsPerPlat = Math.round(row.creditSaving / Math.abs(row.platSaving));
        }
        row.advice = decideEconomicRoute(row);
      }
      // 先展示能改变购买决定的项目；独占装饰品放在经济结论之后，避免长货单淹没关键信息。
      const economicRank = { strong: 0, buy: 1, cash: 2, flip: 3, choice: 4, need: 5, market: 6, exclusive: 7, skip: 8 };
      rows.sort((a, b) => (economicRank[a.advice.tag] ?? 99) - (economicRank[b.advice.tag] ?? 99)
        || (b.platSaving ?? -Infinity) - (a.platSaving ?? -Infinity)
        || (b.ratio ?? -1) - (a.ratio ?? -1));
    } catch { /* 兑换估值失败时保留原有白金/杜卡德比值推荐 */ }
  }
  // 购物车口径：所有「建议买」的杜卡德合计 vs 余额
  const wantDucats = rows.filter((row) => ['strong', 'buy', 'cash'].includes(row.advice.tag))
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
    const priority = { strong: 0, buy: 1, cash: 2, flip: 3, need: 4 };
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
    const basis = row.marketBasis === 'today' ? '今日成交中位' : '90天成交中位';
    const price = row.tradable ? (row.platinum != null ? `${basis}${row.platinum}p${row.marketStatsStale ? '（缓存）' : ''}，日均${row.dailyVolume ?? 0}笔` : '暂无成交统计') : '独占无市场价';
    const ratio = row.ratio != null ? `｜1杜=${row.ratio}p` : '';
    const route = row.ducatOpportunityPlat != null
      ? `｜补足${row.ducatNeed}杜机会成本${row.ducatOpportunityPlat}p｜交易税${row.tradingTax?.toLocaleString('zh-CN') ?? '未知'}现金`
      : row.ducatPlanShortfall ? `｜安全库存还差${row.ducatPlanShortfall}杜` : '';
    lines.push(`${row.advice.zh}｜${name}｜${row.ducats}杜+${row.credits.toLocaleString('zh-CN')}现金｜${price}${route}${ratio}${row.owned ? '｜已有' : ''}`);
  }
  if (result.rows.length > 16) lines.push(`其余 ${result.rows.length - 16} 件已在卡片中省略，优先保留会影响购买决策的项目。`);
  lines.push(`经济性推荐合计 ${result.wantDucats} 杜卡德${result.affordable ? '，余额够用' : `，还差 ${result.ducatShortfall} 杜卡德，可发「杜卡德 ${result.ducatShortfall}」生成兑换方案`}。价格优先取今日成交中位，样本不足回退 90 天成交中位；仅供参考。`);
  return lines.join('\n');
}
