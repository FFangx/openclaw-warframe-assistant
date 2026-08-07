#!/usr/bin/env node

// 奸商购物助手：到货单 × 本机库存 × 杜卡德余额 → 双路线购买建议，零 AI 判断。
// 路线 A：安全兑换 Prime 部件的白金机会成本 + 奸商现金；路线 B：市场卖价 + 准确交易税。
// 口径：Prime MOD 用 rank 0 卖单价（奸商卖 0 级，满级价含 4 万 Endo 虚高）；
//      不可交易品标「独占无市场价」三态，绝不当 0 白金沉底。
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const WORLDSTATE_BASE = 'https://api.warframestat.us';
const OFFICIAL_WORLDSTATE_URL = 'https://api.warframe.com/cdn/worldState.php';
const MARKET_BASE = 'https://api.warframe.market';
const TIMEOUT_MS = 20_000;
const CATALOG_CACHE_TTL_MS = 60 * 60 * 1000;
const PRICE_CONCURRENCY = 3;

// 巴洛到访中继站（ExportRegions + dict.zh 实证，专名官方保留英文）
const RELAY_ZH = Object.freeze({
  MercuryHUB: '水星 Larunda 中继站',
  EarthHUB: '地球 Strata 中继站',
  SaturnHUB: '土星 Kronia 中继站',
  PlutoHUB: '冥王星 Orcus 中继站',
  TradeHUB1: '火星 Maroo 的市集',
});

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
    location: wfstat.location || official.location,
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

// —— 单件估值：MOD 类按 rank 0（奌商卖 0 级），其余不带 rank；失败回放价格记忆（标 stale） ——
async function fetchLowestSell(slug, isMod, priceFetcher) {
  const rank = isMod ? 0 : '-';
  try {
    const rankParam = isMod ? '?rank=0' : '';
    const payload = priceFetcher
      ? await priceFetcher(slug, isMod)
      : await getJson(`${MARKET_BASE}/v2/orders/item/${slug}/top${rankParam}`, { Platform: 'pc', Crossplay: 'true' });
    // ⚠ wm /top 列表不按价格排序，真实最低卖价要自己算
    const sell = (payload.data?.sell || []).filter((order) => order.visible !== false);
    const prices = sell.map((order) => Number(order.platinum)).filter(Number.isFinite);
    const price = prices.length ? Math.min(...prices) : null;
    // 注入 priceFetcher（测试/打桩）时不碰真实价格记忆
    if (price != null && !priceFetcher) {
      const { rememberPrice } = await import('./wfdata.mjs');
      await rememberPrice(slug, rank, price);
    }
    return price != null ? { platinum: price, stale: false } : null;
  } catch {
    if (priceFetcher) return null;
    const { recallPrice } = await import('./wfdata.mjs');
    const memory = await recallPrice(slug, rank);
    return memory ? { platinum: memory.platinum, stale: true, at: memory.at } : null;
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

// goods: [{uniqueName,item,ducats,credits}]；options 可注入 catalog/owned/ducatBalance/priceFetcher/zhOf 打桩
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
      fetchLowestSell(meta.slug, isMod, options.priceFetcher),
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
      priceStale: Boolean(quote?.stale),
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

// 主入口：inventory=解密后的快照库存对象；traderState/officialTrader/catalog/priceFetcher/zhOf 可注入
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
    location: state.location || '未知中继站',
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
  // 玩家市场=当前 0 级卖价+物品交易税。现金不硬折白金，保留双轴结论。
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
    const price = row.tradable ? (row.platinum != null ? `市价${row.platinum}p${row.priceStale ? '（离线快照）' : ''}` : '暂无卖单') : '独占无市场价';
    const ratio = row.ratio != null ? `｜1杜=${row.ratio}p` : '';
    const route = row.ducatOpportunityPlat != null
      ? `｜补足${row.ducatNeed}杜机会成本${row.ducatOpportunityPlat}p｜交易税${row.tradingTax?.toLocaleString('zh-CN') ?? '未知'}现金`
      : row.ducatPlanShortfall ? `｜安全库存还差${row.ducatPlanShortfall}杜` : '';
    lines.push(`${row.advice.zh}｜${name}｜${row.ducats}杜+${row.credits.toLocaleString('zh-CN')}现金｜${price}${route}${ratio}${row.owned ? '｜已有' : ''}`);
  }
  if (result.rows.length > 16) lines.push(`其余 ${result.rows.length - 16} 件已在卡片中省略，优先保留会影响购买决策的项目。`);
  lines.push(`经济性推荐合计 ${result.wantDucats} 杜卡德${result.affordable ? '，余额够用' : `，还差 ${result.ducatShortfall} 杜卡德，可发「杜卡德 ${result.ducatShortfall}」生成兑换方案`}。价格为当前在线最低卖单，仅供参考。`);
  return lines.join('\n');
}
