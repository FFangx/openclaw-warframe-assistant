#!/usr/bin/env node

// Warframe.Market wishlist monitor.
//
// The process is deliberately bounded: cron performs one small item-top REST
// calibration and exits. The long-lived websocket is owned by the plugin's
// gateway_start/gateway_stop hooks. It never logs in to Market and never
// performs a trade or chat action.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildWishlistHitCard, buildWishlistSubscriptionCard, buildWishlistSummaryCard } from './wishlist-card.mjs';
import { renderWarframeCard } from './warframe-cards.mjs';
import { fetchMarketItems, resolveMarketItem } from './shortcuts.mjs';
import { deliverMonitorResult } from './subscriptions.mjs';

const MARKET_BASE = 'https://api.warframe.market';
const WS_URL = 'wss://ws.warframe.market/socket';
const WS_PROTOCOL = 'wfm';
const WS_ROUTE = '@wfm|cmd/subscribe/newOrders';
const WS_EVENT_ROUTE = '@wfm|event/subscriptions/newOrder';
const PLATFORM = 'pc';
const CROSSPLAY = true;
const REST_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_WS_WINDOW_MS = 52 * 1000;
const DEFAULT_STATE = path.resolve(process.cwd(), 'warframe-wishlist.json');
const SHORT_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_SEEN_PER_WISH = 1000;
const normalize = (value) => String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ');
const normalizeId = (value) => normalize(value).toLowerCase();
const asIso = (value, fallback = new Date().toISOString()) => {
  const date = new Date(value || fallback);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
};

function emptyLedger() {
  return { version: 1, updatedAt: null, wishes: [], calibration: { lastRestAt: null, lastError: null } };
}

function normalizeWish(value) {
  const wish = value && typeof value === 'object' ? value : {};
  const status = ['active', 'paused', 'bought', 'cancelled'].includes(wish.status)
    ? wish.status : (wish.enabled === false ? 'paused' : 'active');
  const maxPrice = Number(wish.maxPrice);
  return {
    id: normalize(wish.id).toUpperCase(),
    target: normalizeId(wish.target),
    ownerId: normalizeId(wish.ownerId),
    ownerName: normalize(wish.ownerName),
    itemId: normalize(wish.itemId),
    slug: normalize(wish.slug),
    itemName: normalize(wish.itemName || wish.name),
    zhName: normalize(wish.zhName),
    maxPrice: Number.isFinite(maxPrice) && maxPrice > 0 ? maxPrice : 0,
    rank: wish.rank == null || wish.rank === '' ? null : (Number.isFinite(Number(wish.rank)) ? Number(wish.rank) : null),
    rankMode: ['exact', 'max', 'any'].includes(wish.rankMode) ? wish.rankMode : (wish.rank == null ? 'any' : 'exact'),
    maxRank: wish.maxRank == null ? null : (Number.isFinite(Number(wish.maxRank)) ? Number(wish.maxRank) : null),
    platform: normalize(wish.platform) || PLATFORM,
    crossplay: wish.crossplay !== false,
    enabled: status === 'active',
    status,
    initialized: Boolean(wish.initialized),
    createdAt: asIso(wish.createdAt),
    updatedAt: asIso(wish.updatedAt || wish.createdAt),
    boughtAt: wish.boughtAt ? asIso(wish.boughtAt) : null,
    lastMatchAt: wish.lastMatchAt ? asIso(wish.lastMatchAt) : null,
    seenOrderIds: Array.isArray(wish.seenOrderIds) ? [...new Set(wish.seenOrderIds.map((id) => normalize(id)).filter(Boolean))].slice(-MAX_SEEN_PER_WISH) : [],
  };
}

function normalizeLedger(value) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    version: 1,
    updatedAt: input.updatedAt ? asIso(input.updatedAt) : null,
    wishes: Array.isArray(input.wishes) ? input.wishes.map(normalizeWish).filter((wish) => wish.id && wish.itemId && wish.ownerId && wish.target) : [],
    calibration: {
      lastRestAt: input.calibration?.lastRestAt ? asIso(input.calibration.lastRestAt) : null,
      lastError: input.calibration?.lastError ? normalize(input.calibration.lastError).slice(0, 300) : null,
      targets: Object.fromEntries(Object.entries(input.calibration?.targets || {}).map(([target, value]) => [normalizeId(target), {
        lastRestAt: value?.lastRestAt ? asIso(value.lastRestAt) : null,
        lastError: value?.lastError ? normalize(value.lastError).slice(0, 300) : null,
      }])),
    },
  };
}

export async function readWishlistLedger(statePath = DEFAULT_STATE) {
  try {
    return normalizeLedger(JSON.parse(await readFile(statePath, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyLedger();
    throw error;
  }
}

async function writeWishlistLedger(statePath, ledger) {
  const normalized = normalizeLedger({ ...ledger, updatedAt: new Date().toISOString() });
  await mkdir(path.dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  await rename(tempPath, statePath);
  return normalized;
}

async function withWishlistLock(statePath, fn) {
  const lockPath = `${statePath}.lock`;
  await mkdir(path.dirname(statePath), { recursive: true });
  let handle;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      handle = await open(lockPath, 'wx');
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 + attempt * 25));
    }
  }
  if (!handle) throw new Error('愿望单状态正在被另一项操作更新，请稍后重试。');
  try {
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}

function base32ShortId(seed, used = new Set()) {
  let digest = createHash('sha256').update(seed).digest();
  for (let round = 0; round < 20; round += 1) {
    let id = 'W';
    for (let index = 0; index < 3; index += 1) id += SHORT_ID_ALPHABET[digest[(round * 3 + index) % digest.length] % SHORT_ID_ALPHABET.length];
    if (!used.has(id)) return id;
    digest = createHash('sha256').update(digest).digest();
  }
  return `W${Date.now().toString(36).slice(-3).toUpperCase()}`;
}

function wishItemName(wish) {
  return wish.zhName || wish.itemName || wish.slug || '未知商品';
}

function wishRankText(wish) {
  if (wish.rankMode === 'max') return ' · 满级';
  if (wish.rankMode === 'exact' && wish.rank != null) return ` · 等级${wish.rank}`;
  return '';
}

function formatPrice(value) {
  const number = Number(value);
  return Number.isInteger(number) ? String(number) : number.toFixed(2).replace(/0+$/u, '').replace(/\.$/u, '');
}

/** Parse the compact Chinese command surface without resolving a Market item. */
export function parseWishlistCommand(message) {
  const text = normalize(message).replace(/^\//u, '');
  if (!text) return { kind: 'invalid', error: '愿望单命令不能为空。' };
  if (/^(?:愿望单|我的愿望单|愿望列表)$/u.test(text)) return { kind: 'summary' };

  const actionMatch = text.match(/^(?:愿望\s*)?(已购|买到|改价|暂停|继续|恢复|取消)(?:\s+|$)(.*)$/u);
  if (actionMatch) {
    const actionMap = { 已购: 'bought', 买到: 'bought', 改价: 'reprice', 暂停: 'pause', 继续: 'resume', 恢复: 'resume', 取消: 'cancel' };
    const action = actionMap[actionMatch[1]];
    const rest = normalize(actionMatch[2]);
    if (!rest) return { kind: 'action', action, error: '请提供愿望短编号，例如「暂停 W3K7」。' };
    const numeric = rest.match(/(?:^|\s)(\d+(?:\.\d+)?)\s*$/u);
    let price = null;
    let selector = rest;
    if (action === 'reprice') {
      if (!numeric) return { kind: 'action', action, error: '改价需要价格，例如「改价 W3K7 12」。' };
      price = Number(numeric[1]);
      selector = normalize(rest.slice(0, numeric.index));
    } else if (numeric && /^\d+(?:\.\d+)?$/u.test(rest)) {
      selector = rest;
    }
    selector = selector.replace(/^#/u, '').trim();
    return { kind: 'action', action, selector, price };
  }

  const createPrefix = text.match(/^(?:愿望|蹲价|盯价|订阅愿望)(?:\s+)([\s\S]+)$/u);
  if (createPrefix && /[、,，;；]/u.test(createPrefix[1])) {
    const entries = createPrefix[1].split(/[、,，;；]+/u).map((part) => {
      const match = normalize(part).match(/^([\s\S]+?)\s*(?:<=?|不高于|最高|至多)?\s*(\d+(?:\.\d+)?)$/u);
      if (!match) return null;
      const itemQuery = normalize(match[1]).replace(/[≤<]\s*$/u, '').trim();
      const maxPrice = Number(match[2]);
      return itemQuery && Number.isFinite(maxPrice) && maxPrice > 0 && maxPrice <= 900000 ? { itemQuery, maxPrice } : null;
    });
    if (entries.length > 5) return { kind: 'createMany', error: '一次最多设置 5 个愿望。' };
    if (entries.length > 1 && entries.every(Boolean)) return { kind: 'createMany', entries };
    if (entries.length > 1) return { kind: 'createMany', error: '多商品命令的每一项都要写成「商品 价格」。' };
  }
  const createMatch = text.match(/^(?:愿望|蹲价|盯价|订阅愿望)(?:\s+)([\s\S]+?)\s*(?:<=?|不高于|最高|至多)?\s*(\d+(?:\.\d+)?)$/u);
  if (createMatch) {
    const itemQuery = normalize(createMatch[1]).replace(/[≤<]\s*$/u, '').trim();
    const maxPrice = Number(createMatch[2]);
    if (!itemQuery) return { kind: 'create', error: '请提供商品名称。' };
    if (!Number.isFinite(maxPrice) || maxPrice <= 0 || maxPrice > 900000) return { kind: 'create', error: '价格需要是 1～900000 之间的白金数。' };
    return { kind: 'create', itemQuery, maxPrice };
  }
  return { kind: 'invalid', error: '用法：愿望 商品 价格；愿望单；已购/改价/暂停/继续/取消 短编号。' };
}

function parseWishlistRankQuery(value) {
  let itemQuery = normalize(value);
  const max = itemQuery.match(/(?:满\s*(?:级|阶)|max(?:\s*rank)?)\s*$/iu);
  if (max) return { itemQuery: normalize(itemQuery.slice(0, max.index)), rankMode: 'max', rank: null, explicit: true };
  const exact = itemQuery.match(/(?:等级|rank|r)\s*[:：]?\s*(\d+)\s*(?:级|阶)?\s*$/iu)
    || itemQuery.match(/(\d+)\s*(?:级|阶)\s*$/u);
  if (exact) return { itemQuery: normalize(itemQuery.slice(0, exact.index)), rankMode: 'exact', rank: Number(exact[1]), explicit: true };
  // Warframe.Market's default for rankable items is rank 0. Keep that
  // behaviour so a no-suffix wish cannot be triggered by a max-rank listing.
  return { itemQuery, rankMode: 'exact', rank: 0, explicit: false };
}

function contextIdentity(context = {}) {
  return { target: normalizeId(context.target), ownerId: normalizeId(context.ownerId || context.owner), ownerName: normalize(context.ownerName) };
}

function ownerWishes(ledger, identity) {
  return ledger.wishes.filter((wish) => wish.target === identity.target && wish.ownerId === identity.ownerId);
}

function findWish(wishes, selector) {
  const value = normalize(selector).replace(/^#/u, '').toUpperCase();
  if (!value) return null;
  const exact = wishes.find((wish) => wish.id === value);
  if (exact) return exact;
  const prefixes = wishes.filter((wish) => wish.id.startsWith(value));
  if (prefixes.length === 1) return prefixes[0];
  if (prefixes.length > 1) return null;
  if (/^\d+$/u.test(value)) return wishes[Number(value) - 1] || null;
  return wishes.find((wish) => wishItemName(wish).toLowerCase() === value.toLowerCase() || wish.slug.toLowerCase() === value.toLowerCase()) || null;
}

function activeWishCount(ledger, target = '') {
  const scopedTarget = normalizeId(target);
  return ledger.wishes.filter((wish) => (!scopedTarget || wish.target === scopedTarget) && wish.status === 'active' && wish.enabled).length;
}

async function resolveWishlistItem(itemQuery, options = {}) {
  const items = options.items || (options.catalogFetcher || fetchMarketItems)(PLATFORM, CROSSPLAY);
  const catalog = await items;
  const resolved = (options.itemResolver || resolveMarketItem)(catalog, itemQuery);
  if (!resolved?.match) {
    return { ok: false, error: resolved?.candidates?.length ? 'ambiguous' : 'not_found', candidates: resolved?.candidates || [] };
  }
  return { ok: true, item: resolved.match };
}

async function fetchWishlistItemMetadata(slug, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node 运行时没有可用的 fetch。');
  const response = await fetchImpl(`${MARKET_BASE}/v2/item/${encodeURIComponent(slug)}`, {
    method: 'GET',
    headers: {
      Platform: PLATFORM, Crossplay: String(CROSSPLAY), Language: 'zh-hans', Accept: 'application/json',
      'User-Agent': 'OpenClaw-Warframe-Assistant/1.1.6 (+https://github.com/FFangx/openclaw-warframe-assistant)',
    },
    signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(8_000) : undefined,
  });
  if (!response?.ok) throw new Error(`Warframe.Market item HTTP ${response?.status || 'error'}`);
  const payload = await response.json();
  return payload?.data || payload || {};
}

async function prepareWishlistEntry(entry, options = {}) {
  const rankQuery = parseWishlistRankQuery(entry.itemQuery);
  const resolved = await resolveWishlistItem(rankQuery.itemQuery, options);
  if (!resolved.ok) {
    const candidateText = resolved.candidates?.length
      ? `：${resolved.candidates.slice(0, 6).map((item) => item.zhName || item.name || item.slug).join('、')}` : '。';
    return { ok: false, error: resolved.error, text: `${resolved.error === 'ambiguous' ? '商品名称不唯一' : '没有找到这个商品'}${candidateText}` };
  }
  const item = resolved.item;
  let maxRank = null;
  try {
    const metadata = await (options.fetchItemMetadata
      ? options.fetchItemMetadata(item.slug, options.fetchImpl || globalThis.fetch)
      : fetchWishlistItemMetadata(item.slug, options.fetchImpl || globalThis.fetch));
    maxRank = Number.isInteger(Number(metadata?.maxRank)) && Number(metadata.maxRank) >= 0 ? Number(metadata.maxRank) : null;
  } catch (error) {
    return { ok: false, error: 'market_metadata_unavailable', text: `暂时无法确认 ${item.zhName || item.name || item.slug} 的等级信息，请稍后重试。` };
  }
  if (rankQuery.explicit) {
    if (maxRank == null) return { ok: false, error: 'rank_not_supported', text: `${item.zhName || item.name || item.slug} 不支持等级筛选。` };
    if (rankQuery.rankMode === 'exact' && (rankQuery.rank < 0 || rankQuery.rank > maxRank)) return { ok: false, error: 'rank_out_of_range', text: `${item.zhName || item.name || item.slug} 最高为 ${maxRank} 级，不能监控 ${rankQuery.rank} 级。` };
  }
  const rankMode = rankQuery.explicit ? rankQuery.rankMode : (maxRank == null ? 'any' : 'exact');
  const rank = rankQuery.explicit ? rankQuery.rank : (maxRank == null ? null : 0);
  return { ok: true, item, maxRank, rankMode, rank };
}

async function renderCard(card, cardDir, options = {}) {
  if (options.render === false || !cardDir) return null;
  const renderer = options.renderCard || renderWarframeCard;
  try { return await renderer(card, cardDir); } catch { return null; }
}

function resultTextForCreate(wish, updated) {
  return `${updated ? '愿望单已更新' : '愿望单已建立'}：${wishItemName(wish)}${wishRankText(wish)} ≤ ${formatPrice(wish.maxPrice)}p（编号 ${wish.id}）。发现符合条件的新卖单后立即通知。`;
}

function actionText(action, wish) {
  const name = wishItemName(wish);
  if (action === 'bought') return `已记录 ${name}（${wish.id}）已购入；如需恢复同商品监控，请重新发送「愿望 ${name} ${formatPrice(wish.maxPrice)}」。`;
  if (action === 'reprice') return `已将 ${name}（${wish.id}）的价格上限改为 ${formatPrice(wish.maxPrice)}p，继续监控。`;
  if (action === 'pause') return `已暂停 ${name}（${wish.id}）。需要时发送「继续 ${wish.id}」恢复。`;
  if (action === 'resume') return `已恢复 ${name}（${wish.id}）监控，价格上限 ${formatPrice(wish.maxPrice)}p。`;
  return `已取消 ${name}（${wish.id}）愿望。历史记录已保留。`;
}

function whisperTextForHit(hit) {
  const order = hit.order || {};
  const wish = hit.wish || {};
  const seller = normalize(order.seller || order.user?.ingameName || '未知玩家');
  const item = normalize(wish.itemName || wish.slug || wish.zhName || '未知商品');
  const rank = order.rank == null ? '' : ` (rank ${order.rank})`;
  const total = Number.isFinite(Number(order.platinum)) ? Number(order.platinum) : Number(order.unitPrice || 0);
  return `/w ${seller} Hi! I want to buy: "${item}${rank}" for ${formatPrice(total)} platinum. (warframe.market)`;
}

function hitNotificationText(hits) {
  const ids = hits.map((hit) => hit.wishId).filter(Boolean);
  const ack = ids.length === 1
    ? `已成功购入发送「已购 ${ids[0]}」，否则无需回复继续监控。`
    : `已成功购入分别发送「已购 ${ids.join('」「已购 ')}」，否则无需回复继续监控。`;
  return `愿望单命中 ${hits.length} 条新卖单。\n${hits.map(whisperTextForHit).join('\n')}\n${ack}`;
}

function wishIdentityKey(itemId, rankMode, rank, maxRank) {
  return `${normalize(itemId)}|${rankMode || 'any'}|${rank == null ? '' : rank}|${maxRank == null ? '' : maxRank}`;
}

/** Manage a single user command. All writes are local ledger writes only. */
export async function manageWishlist(message, context = {}, statePath = DEFAULT_STATE, options = {}) {
  const identity = contextIdentity(context);
  if (!identity.target || !identity.ownerId) return { ok: false, kind: 'wishlist', error: '缺少可信 QQ 会话身份，不能修改愿望单。', text: '缺少可信 QQ 会话身份，不能修改愿望单。' };
  const parsed = parseWishlistCommand(message);
  if (parsed.kind === 'invalid' || parsed.error) return { ok: false, kind: 'wishlist', error: parsed.error, text: parsed.error };

  return withWishlistLock(statePath, async () => {
    const ledger = await readWishlistLedger(statePath);
    const local = ownerWishes(ledger, identity);
    const now = new Date().toISOString();
    if (parsed.kind === 'summary') {
      const card = buildWishlistSummaryCard({ wishes: local, updatedAt: now });
      const mediaUrl = await renderCard(card, options.cardDir, options);
      const visible = local.filter((wish) => !['cancelled', 'bought'].includes(wish.status));
      const text = visible.length
        ? `当前愿望单 ${visible.length} 项：${visible.map((wish) => `${wish.id} ${wishItemName(wish)}≤${formatPrice(wish.maxPrice)}p`).join('；')}`
        : '当前没有监控中的愿望。发送「愿望 商品 价格」开始。';
      return { ok: true, kind: 'wishlist', command: 'summary', text, mediaUrl, ...(mediaUrl ? { trustedLocalMedia: true } : {}), cronAction: activeWishCount(ledger, identity.target) ? 'ensure' : 'remove' };
    }

    if (parsed.kind === 'create' || parsed.kind === 'createMany') {
      const entries = parsed.kind === 'createMany' ? parsed.entries : [{ itemQuery: parsed.itemQuery, maxPrice: parsed.maxPrice }];
      if (entries.length > 5) return { ok: false, kind: 'wishlist', error: 'too_many', text: '一次最多设置 5 个愿望。' };
      // Resolve every item and rank before mutating the ledger. A failed
      // second item therefore cannot leave a half-created command behind.
      const prepared = [];
      for (const entry of entries) {
        const value = await prepareWishlistEntry(entry, options);
        if (!value.ok) return { ok: false, kind: 'wishlist', error: value.error, text: value.text };
        prepared.push({ ...value, maxPrice: entry.maxPrice, key: wishIdentityKey(value.item.id, value.rankMode, value.rank, value.maxRank) });
      }
      if (new Set(prepared.map((entry) => entry.key)).size !== prepared.length) return { ok: false, kind: 'wishlist', error: 'duplicate', text: '同一次命令里有重复的商品/等级愿望，请合并价格后再发送。' };
      // Quota and duplicate checks use the same target+owner scope as the
      // subsequent update lookup. A member can use the same item/rank in a
      // different group or private session without consuming this session's
      // ten-wish quota.
      const activeLocalWishes = local.filter((wish) => !['cancelled', 'bought'].includes(wish.status));
      const activeKeys = new Set(activeLocalWishes.map((wish) => wishIdentityKey(wish.itemId, wish.rankMode, wish.rank, wish.maxRank)));
      const newCount = prepared.filter((entry) => !activeKeys.has(entry.key)).length;
      if (activeLocalWishes.length + newCount > 10) return { ok: false, kind: 'wishlist', error: 'limit', text: '每个会话中的用户最多保留 10 个有效愿望，请先取消不需要的项目。' };

      const used = new Set(ledger.wishes.map((entry) => entry.id));
      const changed = [];
      const createdFlags = [];
      for (const entry of prepared) {
        const item = entry.item;
        let wish = local.find((candidate) => candidate.itemId === normalize(item.id)
          && wishIdentityKey(candidate.itemId, candidate.rankMode, candidate.rank, candidate.maxRank) === entry.key
          && !['cancelled', 'bought'].includes(candidate.status));
        const updated = Boolean(wish);
        if (wish) {
          wish.maxPrice = entry.maxPrice;
          wish.itemName = normalize(item.name);
          wish.zhName = normalize(item.zhName);
          wish.slug = normalize(item.slug);
          wish.rank = entry.rank; wish.rankMode = entry.rankMode; wish.maxRank = entry.maxRank;
          wish.status = 'active'; wish.enabled = true; wish.initialized = false;
          wish.seenOrderIds = []; wish.updatedAt = now;
        } else {
          wish = normalizeWish({
            id: base32ShortId(`${identity.ownerId}|${identity.target}|${item.id}|${entry.key}|${now}|${changed.length}`, used),
            target: identity.target, ownerId: identity.ownerId, ownerName: identity.ownerName,
            itemId: item.id, slug: item.slug, itemName: item.name, zhName: item.zhName,
            maxPrice: entry.maxPrice, platform: PLATFORM, crossplay: CROSSPLAY,
            rank: entry.rank, rankMode: entry.rankMode, maxRank: entry.maxRank,
            status: 'active', enabled: true, initialized: false, createdAt: now, updatedAt: now, seenOrderIds: [],
          });
          ledger.wishes.push(wish);
          used.add(wish.id);
        }
        changed.push(wish);
        createdFlags.push(!updated);
      }
      await writeWishlistLedger(statePath, ledger);
      const action = changed.length > 1 ? `已保存 ${changed.length} 个愿望` : (createdFlags[0] ? '愿望单已建立' : '愿望单已更新');
      const card = buildWishlistSubscriptionCard({ wishes: changed, wish: changed[0], created: createdFlags.some(Boolean), actionText: action, updatedAt: now });
      const mediaUrl = await renderCard(card, options.cardDir, options);
      const text = changed.length > 1
        ? `愿望单已保存：${changed.map((wish) => `${wishItemName(wish)}${wishRankText(wish)} ≤ ${formatPrice(wish.maxPrice)}p（${wish.id}）`).join('；')}。发现符合条件的新卖单后立即通知。`
        : resultTextForCreate(changed[0], createdFlags[0]);
      return { ok: true, kind: 'wishlist', command: parsed.kind, text, mediaUrl, ...(mediaUrl ? { trustedLocalMedia: true } : {}), wish: changed[0], wishes: changed, cronAction: 'ensure' };
    }

    const wish = findWish(local, parsed.selector);
    if (!wish) return { ok: false, kind: 'wishlist', error: 'not_found', text: `没有找到愿望编号「${parsed.selector || '—'}」。发送「愿望单」查看短编号。` };
    if (parsed.action === 'reprice') {
      if (!Number.isFinite(parsed.price) || parsed.price <= 0 || parsed.price > 900000) return { ok: false, kind: 'wishlist', error: 'invalid_price', text: '价格需要是 1～900000 之间的白金数。' };
      wish.maxPrice = parsed.price;
      wish.status = 'active'; wish.enabled = true; wish.initialized = false;
      wish.seenOrderIds = []; wish.updatedAt = now;
    } else if (parsed.action === 'bought') {
      wish.status = 'bought'; wish.enabled = false; wish.boughtAt = now; wish.updatedAt = now;
    } else if (parsed.action === 'pause') {
      wish.status = 'paused'; wish.enabled = false; wish.updatedAt = now;
    } else if (parsed.action === 'resume') {
      wish.status = 'active'; wish.enabled = true; wish.initialized = false;
      wish.seenOrderIds = []; wish.updatedAt = now;
    } else if (parsed.action === 'cancel') {
      wish.status = 'cancelled'; wish.enabled = false; wish.updatedAt = now;
    }
    await writeWishlistLedger(statePath, ledger);
    const card = buildWishlistSubscriptionCard({ wish, actionText: actionText(parsed.action, wish), detail: parsed.action === 'bought' ? '命中提醒不会自动核销；本条愿望已按你的确认标记为已购入。' : undefined, updatedAt: now });
    const mediaUrl = await renderCard(card, options.cardDir, options);
    return { ok: true, kind: 'wishlist', command: parsed.action, text: actionText(parsed.action, wish), mediaUrl, ...(mediaUrl ? { trustedLocalMedia: true } : {}), wish, cronAction: activeWishCount(ledger, identity.target) ? 'ensure' : 'remove' };
  });
}

function orderPayload(value) {
  const order = value?.order && typeof value.order === 'object' ? { ...value.order, ...value } : (value || {});
  const platinum = Number(order.platinum);
  const perTrade = Number(order.perTrade ?? order.per_trade ?? order.quantityPerTrade ?? 1);
  const safePerTrade = Number.isFinite(perTrade) && perTrade > 0 ? perTrade : 1;
  const itemId = normalize(order.itemId || order.item?.id || order.item?.itemId);
  const type = normalize(order.type || order.orderType || 'sell').toLowerCase();
  const seller = normalize(order.user?.ingameName || order.user?.ingame_name || order.ingameName || order.seller);
  const createdAt = order.createdAt || order.created_at || order.updatedAt || order.updated_at || null;
  return {
    id: normalize(order.id), itemId, type, platinum: Number.isFinite(platinum) ? platinum : null,
    perTrade: safePerTrade, unitPrice: Number.isFinite(platinum) ? platinum / safePerTrade : null,
    quantity: order.quantity == null ? null : Number(order.quantity), rank: order.rank == null ? null : Number(order.rank),
    visible: order.visible !== false, seller: seller || '未知玩家', status: normalize(order.user?.status || order.status || 'unknown'),
    createdAt: createdAt ? asIso(createdAt) : null,
  };
}

export function normalizeWishlistOrder(order) {
  return orderPayload(order);
}

export function orderIdentity(order) {
  const normalized = orderPayload(order);
  // Market may keep an order id while its seller edits the price. Include the
  // price/rank terms so a newly qualifying price is not hidden by the old one.
  if (normalized.id) return `${normalized.id}@${normalized.platinum}:${normalized.perTrade}:${normalized.rank ?? ''}`;
  return createHash('sha1').update(JSON.stringify([
    normalized.itemId, normalized.type, normalized.platinum, normalized.perTrade, normalized.quantity, normalized.createdAt,
  ])).digest('hex').slice(0, 24);
}

export function matchesWishlistOrder(wish, order) {
  const normalizedWish = normalizeWish(wish);
  const normalizedOrder = orderPayload(order);
  const rankMatches = normalizedWish.rankMode === 'any'
    || (normalizedWish.rankMode === 'exact' && (normalizedOrder.rank === normalizedWish.rank || (normalizedWish.rank === 0 && normalizedOrder.rank == null)))
    || (normalizedWish.rankMode === 'max' && normalizedWish.maxRank != null && normalizedOrder.rank === normalizedWish.maxRank);
  return normalizedWish.status === 'active' && normalizedWish.enabled
    && normalizedOrder.itemId === normalizedWish.itemId
    && /^(?:sell|sellorder|sell_order)$/u.test(normalizedOrder.type)
    && normalizedOrder.visible
    && rankMatches
    && Number.isFinite(normalizedOrder.unitPrice)
    && normalizedOrder.unitPrice <= normalizedWish.maxPrice;
}

/** Apply a batch and return transient hits; seller names are never persisted. */
export function applyWishlistOrders(ledgerInput, orders, { source = 'ws', now = new Date().toISOString(), target = '', ownerId = '', notifyInitial = false } = {}) {
  const ledger = normalizeLedger(ledgerInput);
  const hits = [];
  const list = Array.isArray(orders) ? orders : [];
  for (const wish of ledger.wishes) {
    if (target && wish.target !== normalizeId(target)) continue;
    if (ownerId && wish.ownerId !== normalizeId(ownerId)) continue;
    if (wish.status !== 'active' || !wish.enabled) continue;
    const relevant = list.map(orderPayload).filter((order) => order.itemId === wish.itemId);
    if (source === 'ws' && relevant.length) wish.initialized = true;
    if (source === 'rest' && !wish.initialized) {
      for (const order of relevant) {
        const id = orderIdentity(order);
        if (notifyInitial && !wish.seenOrderIds.includes(id) && matchesWishlistOrder(wish, order)) {
          wish.lastMatchAt = asIso(now);
          hits.push({ wishId: wish.id, wish: { id: wish.id, itemId: wish.itemId, itemName: wish.itemName, zhName: wish.zhName, slug: wish.slug, maxPrice: wish.maxPrice, rank: wish.rank, rankMode: wish.rankMode, maxRank: wish.maxRank, ownerName: wish.ownerName }, order });
        }
        wish.seenOrderIds.push(id);
      }
      wish.seenOrderIds = [...new Set(wish.seenOrderIds)].slice(-MAX_SEEN_PER_WISH);
      wish.initialized = true;
      wish.updatedAt = asIso(now);
      continue;
    }
    for (const order of relevant) {
      const id = orderIdentity(order);
      const seen = wish.seenOrderIds.includes(id);
      if (!seen) wish.seenOrderIds.push(id);
      if (!seen && matchesWishlistOrder(wish, order) && (source === 'ws' || source === 'rest')) {
        wish.lastMatchAt = asIso(now);
      hits.push({ wishId: wish.id, wish: { id: wish.id, itemId: wish.itemId, itemName: wish.itemName, zhName: wish.zhName, slug: wish.slug, maxPrice: wish.maxPrice, rank: wish.rank, rankMode: wish.rankMode, maxRank: wish.maxRank, ownerName: wish.ownerName }, order });
      }
    }
    wish.seenOrderIds = [...new Set(wish.seenOrderIds)].slice(-MAX_SEEN_PER_WISH);
    wish.updatedAt = asIso(now);
  }
  return { ledger, hits };
}

function activeItemIds(ledger, target, ownerId = '') {
  return new Set(ledger.wishes.filter((wish) => wish.target === target && (!ownerId || wish.ownerId === ownerId) && wish.status === 'active' && wish.enabled).map((wish) => wish.itemId));
}

async function fetchTopOrdersForItem(wish, fetchImpl) {
  const rank = wish.rankMode === 'exact' ? wish.rank : wish.rankMode === 'max' ? wish.maxRank : null;
  const rankQuery = Number.isInteger(rank) ? `?rank=${encodeURIComponent(rank)}` : '';
  const url = `${MARKET_BASE}/v2/orders/item/${encodeURIComponent(wish.slug)}\/top${rankQuery}`;
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Platform: wish.platform || PLATFORM, Crossplay: String(wish.crossplay !== false), Language: 'zh-hans',
      Accept: 'application/json',
      'User-Agent': 'OpenClaw-Warframe-Assistant/1.1.6 (+https://github.com/FFangx/openclaw-warframe-assistant)',
    },
    signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(8_000) : undefined,
  });
  if (!response?.ok) throw new Error(`Warframe.Market top orders HTTP ${response?.status || 'error'}`);
  const payload = await response.json();
  const data = payload?.data || payload?.payload || {};
  const sell = Array.isArray(data) ? data : (Array.isArray(data.sell) ? data.sell : []);
  return sell.map((order) => ({ ...order, itemId: order.itemId || wish.itemId, slug: order.slug || wish.slug }));
}

export async function fetchTopOrdersForWishes(wishes, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node 运行时没有可用的 fetch。');
  const unique = [...new Map((wishes || []).filter((wish) => wish?.slug).map((wish) => [`${wish.slug}|${wish.rankMode || 'any'}|${wish.rank ?? ''}|${wish.maxRank ?? ''}`, wish])).values()];
  // Warframe.Market documents a 3 req/s ceiling. Keep starts serialized with
  // a 400 ms gap; this is cheap at the normal 1–10 item wishlist size and
  // avoids a burst when a group has many wishes.
  const batches = [];
  let lastStart = 0;
  for (const wish of unique) {
    const wait = Math.max(0, 400 - (Date.now() - lastStart));
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    lastStart = Date.now();
    batches.push(await fetchTopOrdersForItem(wish, fetchImpl));
  }
  return batches.flat();
}

function wsAddListener(socket, event, listener) {
  if (typeof socket.addEventListener === 'function') socket.addEventListener(event, listener);
  else socket[`on${event}`] = listener;
}

function wsData(event) {
  const value = event?.data ?? event;
  if (typeof value === 'string') return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (ArrayBuffer.isView(value)) return new TextDecoder().decode(value);
  return String(value || '');
}

/** One bounded WFM websocket session. */
export async function subscribeToNewOrders({ WebSocketImpl = globalThis.WebSocket, durationMs = DEFAULT_WS_WINDOW_MS, onOrder, now = () => new Date().toISOString() } = {}) {
  if (durationMs <= 0) return { ok: true, count: 0, skipped: true };
  if (typeof WebSocketImpl !== 'function') return { ok: false, count: 0, error: '当前 Node 运行时没有 WebSocket。' };
  return new Promise((resolve) => {
    let socket;
    let settled = false;
    let count = 0;
    let timer;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { socket?.close?.(); } catch { /* ignore */ }
      resolve({ ok: !error, count, ...(error ? { error: String(error?.message || error) } : {}) });
    };
    try {
      socket = new WebSocketImpl(WS_URL, WS_PROTOCOL);
      wsAddListener(socket, 'open', () => {
        try {
          socket.send(JSON.stringify({ route: WS_ROUTE, id: `wishlist-${Date.now().toString(36)}`, payload: { platform: PLATFORM, crossplay: CROSSPLAY } }));
        } catch (error) { finish(error); }
      });
      wsAddListener(socket, 'message', async (event) => {
        try {
          const payload = JSON.parse(wsData(event));
          if (payload?.route !== WS_EVENT_ROUTE) return;
          count += 1;
          if (typeof onOrder === 'function') await onOrder(payload.payload || payload.order || payload, now());
        } catch { /* malformed public event: ignore and keep the bounded session */ }
      });
      wsAddListener(socket, 'error', (error) => finish(error instanceof Error ? error : new Error('WebSocket error')));
      wsAddListener(socket, 'close', () => finish());
      timer = setTimeout(() => finish(), durationMs);
    } catch (error) { finish(error); }
  });
}

function resultForHits(hits, now) {
  if (!hits.length) return { output: 'NO_REPLY\n', data: { ok: true, hitCount: 0 } };
  return { output: '', data: { ok: true, hitCount: hits.length, hits } };
}

/** Perform REST calibration + bounded websocket monitoring for one target. */
export async function monitorWishlist(targetValue, statePath = DEFAULT_STATE, cardDir = null, dryRun = false, options = {}) {
  const target = normalizeId(targetValue);
  let ledger = await readWishlistLedger(statePath);
  const ownerId = normalizeId(options.ownerId || options.owner || '');
  const active = ledger.wishes.filter((wish) => wish.target === target && (!ownerId || wish.ownerId === ownerId) && wish.status === 'active' && wish.enabled);
  if (!active.length) return { output: 'NO_REPLY\n', data: { ok: true, reason: 'no_wishes' } };
  const targetCalibration = ledger.calibration.targets?.[target] || {};
  const due = options.forceRest || !targetCalibration.lastRestAt || (Date.now() - Date.parse(targetCalibration.lastRestAt) >= (options.restIntervalMs ?? REST_INTERVAL_MS));
  let hits = [];
  let restError = null;
  if (due && options.skipRest !== true) {
    try {
      const orders = options.fetchOrders
        ? await options.fetchOrders(active, options.fetchImpl || globalThis.fetch)
        : await fetchTopOrdersForWishes(active, options.fetchImpl || globalThis.fetch);
      const calibrated = await withWishlistLock(statePath, async () => {
        // Reload under the lock: a live gateway event may have updated seen
        // IDs while the item-top HTTP request was in flight.
        const latest = await readWishlistLedger(statePath);
        const applied = applyWishlistOrders(latest, orders, { source: 'rest', now: new Date().toISOString(), target, ownerId, notifyInitial: true });
        const stamp = new Date().toISOString();
        applied.ledger.calibration = {
          ...applied.ledger.calibration,
          lastRestAt: stamp, lastError: null,
          targets: { ...(applied.ledger.calibration.targets || {}), [target]: { lastRestAt: stamp, lastError: null } },
        };
        await writeWishlistLedger(statePath, applied.ledger);
        return applied;
      });
      hits.push(...calibrated.hits);
      ledger = calibrated.ledger;
    } catch (error) {
      restError = String(error?.message || error);
      // The HTTP request may overlap a gateway event or a user command. Do
      // not write the stale snapshot captured before that request; reload
      // under the same lock and change calibration fields only.
      ledger = await withWishlistLock(statePath, async () => {
        const latest = await readWishlistLedger(statePath);
        const lastError = restError.slice(0, 300);
        const lastRestAt = latest.calibration.targets?.[target]?.lastRestAt || null;
        latest.calibration = {
          ...latest.calibration,
          lastError,
          targets: {
            ...(latest.calibration.targets || {}),
            [target]: { ...(latest.calibration.targets?.[target] || {}), lastRestAt, lastError },
          },
        };
        return writeWishlistLedger(statePath, latest);
      });
    }
  }
  const itemIds = activeItemIds(ledger, target, ownerId);
  if (!dryRun && options.skipWebSocket !== true) {
    await subscribeToNewOrders({
      WebSocketImpl: options.WebSocketImpl,
      durationMs: options.wsDurationMs ?? DEFAULT_WS_WINDOW_MS,
      now: () => new Date().toISOString(),
      onOrder: async (order) => {
        if (!itemIds.has(orderPayload(order).itemId)) return;
        const applied = await withWishlistLock(statePath, async () => {
          const latest = await readWishlistLedger(statePath);
          const next = applyWishlistOrders(latest, [order], { source: 'ws', now: new Date().toISOString(), target, ownerId });
          await writeWishlistLedger(statePath, next.ledger);
          return next;
        });
        ledger = applied.ledger;
        hits.push(...applied.hits);
      },
    });
  }
  if (!hits.length) return { output: 'NO_REPLY\n', data: { ok: true, hitCount: 0, ...(restError ? { restError } : {}) } };
  const card = buildWishlistHitCard({ hits, detectedAt: new Date().toISOString() });
  const mediaUrl = dryRun ? null : await renderCard(card, cardDir, options);
  const text = hitNotificationText(hits);
  const output = mediaUrl ? `MEDIA:${mediaUrl}\n${text}\n` : `${text}\n`;
  return { output, mediaUrl, text, data: { ok: true, hitCount: hits.length, hits, ...(restError ? { restError } : {}) } };
}

// Called by the gateway singleton only after it has filtered the event's
// itemId against the in-memory wishlist index. It groups one order back to
// QQ targets, writes only deduplication metadata, and keeps seller data in the
// transient card/result (never in the ledger).
export async function processWishlistLiveOrder(order, statePath = DEFAULT_STATE, cardDir = null, options = {}) {
  const normalized = orderPayload(order);
  if (!normalized.itemId) return [];
  const groupedHits = await withWishlistLock(statePath, async () => {
    const ledger = await readWishlistLedger(statePath);
    const relevant = ledger.wishes.some((wish) => wish.itemId === normalized.itemId && wish.status === 'active' && wish.enabled);
    if (!relevant) return new Map();
    const applied = applyWishlistOrders(ledger, [normalized], { source: 'ws', now: new Date().toISOString() });
    await writeWishlistLedger(statePath, applied.ledger);
    const byTarget = new Map();
    for (const hit of applied.hits) {
      const target = ledger.wishes.find((wish) => wish.id === hit.wishId)?.target;
      if (!target) continue;
      if (!byTarget.has(target)) byTarget.set(target, []);
      byTarget.get(target).push(hit);
    }
    return byTarget;
  });
  const results = [];
  for (const [target, hits] of groupedHits) {
    const detectedAt = new Date().toISOString();
    const card = buildWishlistHitCard({ hits, detectedAt });
    const mediaUrl = await renderCard(card, cardDir, options);
    const text = hitNotificationText(hits);
    results.push({ target, mediaUrl, text, output: mediaUrl ? `MEDIA:${mediaUrl}\n${text}\n` : `${text}\n`, data: { ok: true, hitCount: hits.length, hits } });
  }
  return results;
}

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value?.startsWith('--')) continue;
    const key = value.slice(2);
    result[key] = args[index + 1]?.startsWith('--') || args[index + 1] == null ? 'true' : args[++index];
  }
  return result;
}

function outputJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const statePath = path.resolve(String(args.state || DEFAULT_STATE));
  const target = normalizeId(args.target);
  if (command === 'manage') {
    outputJson(await manageWishlist(args.message, {
      target, ownerId: normalizeId(args.owner), ownerName: normalize(args['owner-name']),
      personalAllowed: String(args['personal-allowed']).toLowerCase() !== 'false',
    }, statePath, { cardDir: args['card-dir'] ? path.resolve(String(args['card-dir'])) : null }));
    return;
  }
  if (command === 'monitor' || command === 'calibrate' || command === 'deliver' || command === 'gateway_start') {
    const result = await monitorWishlist(target, statePath, args['card-dir'] ? path.resolve(String(args['card-dir'])) : null, String(args['dry-run']).toLowerCase() === 'true', {
      ownerId: normalizeId(args.owner),
      skipWebSocket: command !== 'gateway_start',
    });
    if (command === 'monitor' || command === 'calibrate' || command === 'gateway_start') { process.stdout.write(result.output); return; }
    let sent = 0;
    if (result.output.trim() !== 'NO_REPLY') sent = await deliverMonitorResult(result, target);
    process.stdout.write(sent > 0 ? `DIRECT_DELIVERED:${sent}\n` : 'NO_REPLY\n');
    return;
  }
  if (command === 'gateway_stop') { outputJson({ ok: true, stopped: true, bounded: true }); return; }
  outputJson({ ok: false, error: '用法：manage、monitor、calibrate、deliver、gateway_start 或 gateway_stop。' });
  process.exitCode = 1;
}

export { buildWishlistHitCard, buildWishlistSubscriptionCard, buildWishlistSummaryCard, orderPayload };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    if (process.argv[2] === 'monitor' || process.argv[2] === 'calibrate' || process.argv[2] === 'deliver' || process.argv[2] === 'gateway_start') process.stdout.write('NO_REPLY\n');
    else outputJson({ ok: false, error: String(error?.message || error) });
    process.exitCode = 1;
  });
}
