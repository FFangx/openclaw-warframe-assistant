#!/usr/bin/env node

// 奸商购物助手：到货单 × 本机库存 × 杜卡德余额 → 买什么/够不够，零 AI 判断。
// 排序键 = 白金价 ÷ 杜卡德价（倒爷指标）：不管贵因实用还是稀有，都指向「这次该买」。
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
  // version 2：加 thumb 字段，旧缓存无此字段必须打散
  const result = await staleCachedJson('market-catalog-compact', { ttlMs: CATALOG_CACHE_TTL_MS, version: 2 }, async () => {
    const items = await getJson(`${MARKET_BASE}/v2/items`, { Platform: 'pc', Crossplay: 'true', Language: 'zh-hans' });
    const catalog = {};
    for (const item of items.data || []) {
      const en = item.i18n?.en?.name;
      if (!en) continue;
      catalog[compact(en)] = { slug: item.slug, zh: item.i18n?.['zh-hans']?.name || null, thumb: item.i18n?.en?.thumb || null };
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
    const quote = meta ? await fetchLowestSell(meta.slug, isMod, options.priceFetcher) : null;
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
  // 购物车口径：所有「建议买」的杜卡德合计 vs 余额
  const wantDucats = rows.filter((row) => row.advice.tag === 'strong' || row.advice.tag === 'buy')
    .reduce((sum, row) => sum + row.ducats, 0);
  return { ...base, ok: true, arrived: true, rows, wantDucats, affordable: base.ducatBalance >= wantDucats };
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
  for (const row of result.rows) {
    const name = row.zhName || (row.tradable ? row.nameEn : '未收录物品');
    const price = row.tradable ? (row.platinum != null ? `市价${row.platinum}p${row.priceStale ? '（离线快照）' : ''}` : '暂无卖单') : '独占无市场价';
    const ratio = row.ratio != null ? `｜1杜=${row.ratio}p` : '';
    lines.push(`${row.advice.zh}｜${name}｜${row.ducats}杜+${row.credits.toLocaleString('zh-CN')}银｜${price}${ratio}${row.owned ? '｜已有' : ''}`);
  }
  lines.push(`建议购入合计 ${result.wantDucats} 杜卡德${result.affordable ? '，余额够用' : '，余额不足——优先「强烈买」'}。价格为当前在线最低卖单，仅供参考。`);
  return lines.join('\n');
}
