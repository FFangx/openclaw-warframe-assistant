#!/usr/bin/env node

// 杜卡德兑换规划器：本机 Prime 部件库存 × 杜卡德固定值 × 市场机会成本。
// 只给建议，不写库存；目标模式用有界整数规划寻找白金损失最低的组合。

const MARKET_BASE = 'https://api.warframe.market';
const TIMEOUT_MS = 20_000;
const LIVE_PRICE_CONCURRENCY = 3;
const DEFAULT_LIVE_QUOTES = 14;

const compact = (value) => String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/[\s_\-:：·'’&]+/gu, '');
const round1 = (value) => Math.round((Number(value) || 0) * 10) / 10;

async function getJson(url, headers = {}) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.json();
}

async function mapLimit(values, limit, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index], index);
    }
  }));
  return results;
}

export function parseDucatSpec(message) {
  const text = String(message ?? '').normalize('NFKC').trim().replace(/^\//u, '');
  const match = text.match(/^(?:杜卡德|杜卡德推荐|杜卡德兑换)(?:\s+(.*))?$/u);
  if (!match) return null;
  const query = (match[1] || '').trim();
  const setReserveMatch = query.match(/保留\s*(\d+)\s*套/u);
  const itemReserveMatch = query.match(/保留\s*(\d+)(?!\s*套)/u);
  const withoutReserve = query
    .replace(/保留\s*\d+\s*套/gu, ' ')
    .replace(/保留\s*\d+/gu, ' ');
  const targetMatch = withoutReserve.match(/(?:^|\s)(\d[\d,]*)\s*(?:杜|杜卡德)?(?:\s|$)/u);
  const target = targetMatch ? Number(targetMatch[1].replace(/,/gu, '')) : 0;
  const clearance = /清仓/u.test(query);
  const reserveExplicit = Boolean(setReserveMatch || itemReserveMatch);
  return {
    query,
    mode: target > 0 ? 'target' : clearance ? 'clearance' : 'recommend',
    target: Number.isFinite(target) && target > 0 ? Math.floor(target) : 0,
    clearance,
    reserveCount: itemReserveMatch ? Math.max(0, Number(itemReserveMatch[1]) || 0) : 1,
    reserveSets: setReserveMatch ? Math.max(0, Number(setReserveMatch[1]) || 0) : null,
    reserveExplicit,
  };
}

function reserveFor(entry, spec) {
  if (spec.reserveSets != null) return Math.max(0, spec.reserveSets * Math.max(1, Number(entry.setRequired) || 1));
  if (spec.reserveExplicit) return Math.max(0, spec.reserveCount);
  // 默认智能保留：当前已经拥有对应成品时，最后一件多余蓝图/部件也可换杜；
  // 未拥有或快照无法确认时按配方保留一套，双持部件会正确保留 2 件。
  if (entry.parentOwned === true) return 0;
  return Math.max(1, Number(entry.setRequired) || 1);
}

function reserveReason(entry, spec) {
  if (spec.reserveSets != null || spec.reserveExplicit) return null;
  if (entry.parentOwned === true) return '已有成品';
  if (entry.parentOwned === false) return '未拥有成品';
  return '状态未知';
}

export function buildDucatCandidates(entries, spec) {
  return (entries || []).filter((entry) => entry.catKey === 'part' && Number(entry.ducats) > 0 && Number(entry.count) > 0)
    .map((entry) => {
      const reserve = Math.min(Number(entry.count), reserveFor(entry, spec));
      const available = Math.max(0, Number(entry.count) - reserve);
      const unitPlat = Number.isFinite(Number(entry.unit)) && Number(entry.unit) > 0 ? Number(entry.unit) : null;
      return {
        ...entry,
        owned: Number(entry.count),
        reserve,
        reserveReason: reserveReason(entry, spec),
        available,
        ducatsEach: Number(entry.ducats),
        unitPlat,
        priceSource: unitPlat == null ? '暂无行情' : '近日成交均价',
        efficiency: unitPlat ? round1(Number(entry.ducats) / unitPlat) : null,
      };
    })
    .filter((entry) => entry.available > 0 && entry.unitPlat != null)
    .sort((a, b) => (b.efficiency ?? -1) - (a.efficiency ?? -1) || b.ducatsEach - a.ducatsEach || a.name.localeCompare(b.name, 'zh-CN'));
}

async function loadMarketCatalog() {
  const { staleCachedJson } = await import('./wfdata.mjs');
  const result = await staleCachedJson('ducat-market-catalog', { ttlMs: 60 * 60 * 1000, version: 1 }, async () => {
    const payload = await getJson(`${MARKET_BASE}/v2/items`, { Platform: 'pc', Crossplay: 'true', Language: 'zh-hans' });
    const catalog = {};
    for (const item of payload.data || []) {
      const english = item.i18n?.en?.name;
      if (!english) continue;
      catalog[compact(english)] = {
        slug: item.slug,
        zhName: item.i18n?.['zh-hans']?.name || null,
        thumb: item.i18n?.en?.thumb || null,
      };
    }
    if (!Object.keys(catalog).length) throw new Error('市场目录为空');
    return catalog;
  });
  return result.data;
}

function marketMeta(catalog, entry) {
  const key = compact(entry.englishName);
  return catalog[key]
    || catalog[`${key}blueprint`]
    || catalog[key.replace(/blueprint$/u, '')]
    || null;
}

async function liveLowestSell(meta, entry, quoteFetcher) {
  if (!meta?.slug) return null;
  if (quoteFetcher) {
    const quote = await quoteFetcher(meta.slug, entry);
    const value = Number(quote?.platinum ?? quote);
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  const payload = await getJson(`${MARKET_BASE}/v2/orders/item/${meta.slug}/top`, { Platform: 'pc', Crossplay: 'true' });
  const prices = (payload.data?.sell || [])
    .filter((order) => order.visible !== false)
    .map((order) => Number(order.platinum))
    .filter((value) => Number.isFinite(value) && value > 0);
  return prices.length ? Math.min(...prices) : null;
}

export async function refreshDucatPrices(candidates, options = {}) {
  const maxLive = Math.max(0, Number(options.maxLiveQuotes ?? DEFAULT_LIVE_QUOTES));
  if (!maxLive || !candidates.length) return candidates;
  let catalog;
  try { catalog = options.catalog || await loadMarketCatalog(); } catch { return candidates; }
  const pool = candidates.slice(0, maxLive);
  await mapLimit(pool, LIVE_PRICE_CONCURRENCY, async (entry) => {
    const meta = marketMeta(catalog, entry);
    if (!meta) return;
    try {
      const live = await liveLowestSell(meta, entry, options.quoteFetcher);
      if (live != null) {
        entry.unitPlat = round1(live);
        entry.priceSource = '当前在线最低卖单';
        entry.efficiency = round1(entry.ducatsEach / entry.unitPlat);
      }
      entry.marketSlug = meta.slug;
      entry.wmThumb = meta.thumb;
      if (meta.zhName) entry.marketZhName = meta.zhName;
    } catch { /* 单项行情失败沿用近日成交均价 */ }
  });
  candidates.sort((a, b) => (b.efficiency ?? -1) - (a.efficiency ?? -1) || b.ducatsEach - a.ducatsEach || a.name.localeCompare(b.name, 'zh-CN'));
  return candidates;
}

function selectionRows(candidates, quantities) {
  return candidates.map((entry, index) => ({ ...entry, exchangeQty: Number(quantities[index]) || 0 }))
    .filter((entry) => entry.exchangeQty > 0)
    .map((entry) => ({
      ...entry,
      totalDucats: entry.exchangeQty * entry.ducatsEach,
      totalPlat: round1(entry.exchangeQty * entry.unitPlat),
    }))
    .sort((a, b) => (b.efficiency ?? -1) - (a.efficiency ?? -1) || b.totalDucats - a.totalDucats);
}

export function optimizeDucatTarget(candidates, rawTarget) {
  const target = Math.max(1, Math.floor(Number(rawTarget) || 0));
  const totalAvailable = candidates.reduce((sum, entry) => sum + entry.available * entry.ducatsEach, 0);
  if (totalAvailable < target) {
    const quantities = candidates.map((entry) => entry.available);
    const rows = selectionRows(candidates, quantities);
    return { complete: false, target, totalDucats: totalAvailable, totalPlat: round1(rows.reduce((sum, row) => sum + row.totalPlat, 0)), rows };
  }

  const maxDucat = Math.max(...candidates.map((entry) => entry.ducatsEach));
  const maxSum = Math.min(totalAvailable, target + maxDucat - 1);
  const states = new Array(maxSum + 1).fill(null);
  states[0] = { cost: 0, types: 0, picks: new Array(candidates.length).fill(0) };
  for (let index = 0; index < candidates.length; index += 1) {
    const entry = candidates[index];
    const copies = Math.min(entry.available, Math.ceil(maxSum / entry.ducatsEach));
    for (let copy = 0; copy < copies; copy += 1) {
      for (let sum = maxSum - entry.ducatsEach; sum >= 0; sum -= 1) {
        const current = states[sum];
        if (!current) continue;
        const nextSum = sum + entry.ducatsEach;
        const nextCost = round1(current.cost + entry.unitPlat);
        const addsType = current.picks[index] === 0 ? 1 : 0;
        const existing = states[nextSum];
        if (existing && (existing.cost < nextCost || (existing.cost === nextCost && existing.types <= current.types + addsType))) continue;
        const picks = current.picks.slice();
        picks[index] += 1;
        states[nextSum] = { cost: nextCost, types: current.types + addsType, picks };
      }
    }
  }

  let best = null;
  let bestSum = 0;
  for (let sum = target; sum <= maxSum; sum += 1) {
    const state = states[sum];
    if (!state) continue;
    if (!best || state.cost < best.cost
      || (state.cost === best.cost && sum - target < bestSum - target)
      || (state.cost === best.cost && sum === bestSum && state.types < best.types)) {
      best = state;
      bestSum = sum;
    }
  }
  const rows = selectionRows(candidates, best?.picks || []);
  return { complete: Boolean(best), target, totalDucats: bestSum, totalPlat: round1(best?.cost || 0), rows };
}

export async function buildDucatPlan(entries, spec, options = {}) {
  const parsed = spec || parseDucatSpec('杜卡德');
  const candidates = await refreshDucatPrices(buildDucatCandidates(entries, parsed), options);
  const availableDucats = candidates.reduce((sum, entry) => sum + entry.available * entry.ducatsEach, 0);
  let result;
  if (parsed.mode === 'target') {
    result = optimizeDucatTarget(candidates, parsed.target);
  } else {
    const chosen = parsed.mode === 'clearance' ? candidates : candidates.slice(0, 12);
    const quantities = candidates.map((entry) => chosen.includes(entry) ? entry.available : 0);
    const rows = selectionRows(candidates, quantities);
    result = {
      complete: true,
      target: 0,
      totalDucats: rows.reduce((sum, row) => sum + row.totalDucats, 0),
      totalPlat: round1(rows.reduce((sum, row) => sum + row.totalPlat, 0)),
      rows,
    };
  }
  const reserveLabel = parsed.reserveSets != null ? `保留 ${parsed.reserveSets} 套`
    : parsed.reserveExplicit ? `每种保留 ${parsed.reserveCount} 个`
      : '智能保留：已有成品 0，其他 1 套';
  return {
    kind: 'ducat-plan',
    ok: true,
    mode: parsed.mode,
    target: parsed.target,
    clearance: parsed.clearance,
    reserveCount: parsed.reserveCount,
    reserveSets: parsed.reserveSets,
    reserveExplicit: parsed.reserveExplicit,
    reserveLabel,
    candidates: candidates.length,
    availableDucats,
    complete: result.complete,
    totalDucats: result.totalDucats,
    totalPlat: result.totalPlat,
    shortfall: parsed.target > 0 ? Math.max(0, parsed.target - result.totalDucats) : 0,
    rows: result.rows,
    fetchedAt: new Date().toISOString(),
    syncedAt: options.syncedAt || null,
  };
}

export function formatDucatPlan(data) {
  if (!data.rows.length) return `当前没有符合“${data.reserveLabel}”条件、且带可靠行情的多余 Prime 部件。`;
  const title = data.mode === 'target' ? `目标 ${data.target} 杜卡德` : data.mode === 'clearance' ? '安全清仓' : '兑换推荐';
  const lines = [`【杜卡德兑换方案】${title}｜${data.reserveLabel}`];
  for (const row of data.rows.slice(0, 15)) {
    lines.push(`${row.name}｜库存 ${row.owned} 留 ${row.reserve} 换 ${row.exchangeQty}｜+${row.totalDucats}杜｜约损失 ${row.totalPlat}p｜${row.priceSource}`);
  }
  lines.push(`合计 +${data.totalDucats} 杜卡德，预计白金机会成本 ${data.totalPlat}p。`);
  if (!data.complete) lines.push(`安全库存不足，距离目标还差 ${data.shortfall} 杜卡德。`);
  return lines.join('\n');
}
