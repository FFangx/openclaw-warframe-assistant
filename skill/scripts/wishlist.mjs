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
import { createSubscriptionsMailer, deliverMonitorResult } from './subscriptions.mjs';
import { createOutbox, targetKeyOf } from './notification-outbox.mjs';
import { OUTBOX_FILE_NAME, ROUTING_FAMILIES } from './notification-routing-contract.mjs';

const MARKET_BASE = 'https://api.warframe.market';
const WS_URL = 'wss://ws.warframe.market/socket';
const WS_PROTOCOL = 'wfm';
const WS_ROUTE = '@wfm|cmd/subscribe/newOrders';
const WS_EVENT_ROUTE = '@wfm|event/subscriptions/newOrder';
const PLATFORM = 'pc';
const CROSSPLAY = true;
export const REST_INTERVAL_MS = 10 * 60 * 1000;
export const TRACKING_WINDOW_MS = 60 * 60 * 1000;
export const TRACKING_CONFIRM_MS = 2 * 1000;
// 愿望命中通知的保守业务 TTL（R3 第四片）：市场快照 10 分钟就过期，
// 逾期不盲发；Outbox 对每条记录再按默认 TTL（48h）封顶，10 分钟生效的
// 是业务过期（expiresAt），不影响掉落/世界状态/周报的既有 TTL 行为。
const WISHLIST_TTL_MS = 10 * 60 * 1000;
// 愿望通知 Outbox 业务键前缀（路由合同统一维护，与 worldstate:/weekly:/drops:/legacy: 平级）
export const WISHLIST_KEY_PREFIX = ROUTING_FAMILIES.wishlist.prefix;
export const WISHLIST_OUTBOX_FILE_NAME = OUTBOX_FILE_NAME;
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
  return { version: 2, updatedAt: null, wishes: [], trackedOrders: [], calibration: { lastRestAt: null, lastError: null } };
}

function normalizeTrackedOrder(value) {
  const track = value && typeof value === 'object' ? value : {};
  const startedAt = asIso(track.startedAt);
  return {
    wishId: normalize(track.wishId).toUpperCase(),
    target: normalizeId(track.target),
    ownerId: normalizeId(track.ownerId),
    itemId: normalize(track.itemId),
    slug: normalize(track.slug),
    orderId: normalize(track.orderId),
    orderIdentity: normalize(track.orderIdentity),
    initialPrice: Number.isFinite(Number(track.initialPrice)) ? Number(track.initialPrice) : null,
    currentPrice: Number.isFinite(Number(track.currentPrice)) ? Number(track.currentPrice) : null,
    startedAt,
    lastConfirmedAt: track.lastConfirmedAt ? asIso(track.lastConfirmedAt) : startedAt,
    expiresAt: track.expiresAt ? asIso(track.expiresAt) : new Date(Date.parse(startedAt) + TRACKING_WINDOW_MS).toISOString(),
    nextCheckAt: track.nextCheckAt ? asIso(track.nextCheckAt) : new Date(Date.parse(startedAt) + trackingDelayMs(0)).toISOString(),
    missingSince: track.missingSince ? asIso(track.missingSince) : null,
    lastErrorAt: track.lastErrorAt ? asIso(track.lastErrorAt) : null,
  };
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
    version: 2,
    updatedAt: input.updatedAt ? asIso(input.updatedAt) : null,
    wishes: Array.isArray(input.wishes) ? input.wishes.map(normalizeWish).filter((wish) => wish.id && wish.itemId && wish.ownerId && wish.target) : [],
    trackedOrders: Array.isArray(input.trackedOrders)
      ? input.trackedOrders.map(normalizeTrackedOrder).filter((track) => track.wishId && track.orderId && track.target && track.ownerId && track.itemId)
      : [],
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

  const actionMatch = text.match(/^(?:愿望\s*)?(撤销已购|撤销取消|已购|买到|改价|暂停|继续|恢复|取消)(?:\s+|$)(.*)$/u);
  if (actionMatch) {
    const actionMap = { 撤销已购: 'undo_bought', 撤销取消: 'undo_cancel', 已购: 'bought', 买到: 'bought', 改价: 'reprice', 暂停: 'pause', 继续: 'resume', 恢复: 'resume', 取消: 'cancel' };
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

function resolveWishSelector(wishes, selector) {
  const value = normalize(selector).replace(/^#/u, '').toUpperCase();
  if (!value) return { wish: null, candidates: [] };
  const exact = wishes.find((wish) => wish.id === value);
  if (exact) return { wish: exact, candidates: [exact] };
  const prefixes = wishes.filter((wish) => wish.id.startsWith(value));
  if (prefixes.length === 1) return { wish: prefixes[0], candidates: prefixes };
  if (prefixes.length > 1) return { wish: null, candidates: prefixes };
  if (/^\d+$/u.test(value)) {
    const wish = wishes[Number(value) - 1] || null;
    return { wish, candidates: wish ? [wish] : [] };
  }
  const itemMatches = wishes.filter((wish) => wishItemName(wish).toLowerCase() === value.toLowerCase() || wish.slug.toLowerCase() === value.toLowerCase());
  return { wish: itemMatches.length === 1 ? itemMatches[0] : null, candidates: itemMatches };
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
  return `${updated ? '愿望单已更新' : '愿望单已建立'}：${wishItemName(wish)}${wishRankText(wish)} ≤ ${formatPrice(wish.maxPrice)}p。发现符合条件的新卖单后立即通知。`;
}

function actionText(action, wish) {
  const name = wishItemName(wish);
  if (action === 'bought') return `已记录 ${name} 已购入。5 分钟内可以撤销。`;
  if (action === 'reprice') return `已将 ${name} 的价格上限改为 ${formatPrice(wish.maxPrice)}p，继续监控。`;
  if (action === 'pause') return `已暂停 ${name}。需要时可直接点“继续”。`;
  if (action === 'resume') return `已恢复 ${name} 监控，价格上限 ${formatPrice(wish.maxPrice)}p。`;
  if (action === 'undo_bought') return `已撤销 ${name} 的“已购”状态，并恢复监控。`;
  if (action === 'undo_cancel') return `已撤销取消 ${name}，并恢复监控。`;
  return `已取消 ${name} 愿望。历史记录已保留，5 分钟内可以撤销。`;
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
  const ack = ids.length === 1 ? `按钮不可用时可发送「已购 ${ids[0]}」。` : `按钮不可用时可按愿望单中的备用编号操作。`;
  const headline = hits.length === 1
    ? (hits[0]?.event === 'lower' ? '愿望单命中：发现更低卖单，已切换跟踪。' : '愿望单命中：当前最低价卖单。')
    : `愿望单有 ${hits.length} 项命中当前最低价卖单。`;
  return `${headline}\n已开始持续确认卖单状态，最长 1 小时。\n${hits.map(whisperTextForHit).join('\n')}\n${ack}`;
}

// ---------- 愿望命中通知 Outbox（R3 第四片：REST 校准 deliver + Gateway 实时命中） ----------
// 与掉落/世界状态/周报共用同一状态文件（业务键前缀不同，按 targetKey 过滤）。

// Outbox 默认路径：与愿望状态同目录（warframe-delivery-outbox.json，路由合同共享文件名），与其余切片一致
export function defaultOutboxPath(statePath) {
  return path.join(path.dirname(String(statePath)), WISHLIST_OUTBOX_FILE_NAME);
}

// 命中 → 稳定「orderIdentity × 命中 wishId 集合」对（集合语义：顺序无关、同单去重）。
// 同一订单命中多个愿望聚合为一对；REST 批量校准可能含多对。
export function wishlistHitsToPairs(hits) {
  const byOrder = new Map();
  for (const hit of hits || []) {
    const identity = orderIdentity(hit?.order || {});
    if (!identity) continue;
    if (!byOrder.has(identity)) byOrder.set(identity, []);
    if (hit?.wishId) byOrder.get(identity).push(String(hit.wishId));
  }
  return [...byOrder.entries()].map(([orderIdentityValue, wishIds]) => ({
    orderIdentity: orderIdentityValue,
    wishIds: [...new Set(wishIds)].sort(),
  }));
}

// 业务幂等键：脱敏 targetKey + 稳定「orderIdentity × 命中 wishId」集合的 SHA-256 语义。
// 原始 target/seller/owner/order/wish id 只进入摘要，绝不出现在 businessKey 原文；
// REST 校准与 WS 实时对同一完整 orderIdentity+wish 通知集合产生同一键，双源自动去重
// （Outbox tombstone 兜底；账本 seen 在 wishlist 锁内提交）。
export function wishlistHitBusinessKey(target, pairs) {
  const stable = (pairs || [])
    .map((pair) => ({
      order: String(pair?.orderIdentity || ''),
      wishes: [...new Set((pair?.wishIds || []).map((id) => String(id || '').trim()).filter(Boolean))].sort(),
    }))
    .filter((pair) => pair.order)
    .sort((a, b) => a.order.localeCompare(b.order) || JSON.stringify(a.wishes).localeCompare(JSON.stringify(b.wishes)));
  const digest = createHash('sha256').update(JSON.stringify(stable)).digest('hex');
  return `${WISHLIST_KEY_PREFIX}${targetKeyOf(target)}:${digest}`;
}

// 命中通知 → Outbox parts：媒体卡（渲染失败降级文字）+ 主文字（含 Market 私聊模板）。
// 卖家名只存在这些瞬时 payload（pending 补投临时保留），终态由 Outbox 擦除。
async function buildWishlistHitPayload(hits, cardDir, options = {}) {
  const detectedAt = new Date().toISOString();
  const card = buildWishlistHitCard({ hits, detectedAt });
  const mediaUrl = await renderCard(card, cardDir, options);
  const text = hitNotificationText(hits);
  if (options.richPayload) return { mediaUrl, text, parts: [{ kind: 'rich', value: JSON.stringify({ mediaUrl, text, hits }) }] };
  if (mediaUrl) return { mediaUrl, text, parts: [{ kind: 'media', value: mediaUrl }, { kind: 'text', value: text }] };
  return { mediaUrl: null, text, parts: [{ kind: 'text', value: text }] };
}

function wishIdentityKey(itemId, rankMode, rank, maxRank) {
  return `${normalize(itemId)}|${rankMode || 'any'}|${rank == null ? '' : rank}|${maxRank == null ? '' : maxRank}`;
}

/** Manage a single user command. All writes are local ledger writes only. */
export async function manageWishlist(message, context = {}, statePath = DEFAULT_STATE, options = {}) {
  const identity = contextIdentity(context);
  if (!identity.target || !identity.ownerId) return { ok: false, kind: 'wishlist', error: '缺少可信 QQ 会话身份，不能修改愿望单。', text: '缺少可信 QQ 会话身份，不能修改愿望单。' };
  if (!/^qqbot:c2c:/u.test(identity.target)) return { ok: false, kind: 'wishlist', error: 'private_only', text: '愿望单只允许在 QQ 私聊中使用。' };
  const parsed = parseWishlistCommand(message);
  if (parsed.kind === 'invalid' || parsed.error) return { ok: false, kind: 'wishlist', error: parsed.error, text: parsed.error };

  return withWishlistLock(statePath, async () => {
    const ledger = await readWishlistLedger(statePath);
    const local = ownerWishes(ledger, identity);
    const nowMs = typeof options.now === 'function' ? Number(options.now()) : Date.now();
    const now = new Date(nowMs).toISOString();
    if (parsed.kind === 'summary') {
      const card = buildWishlistSummaryCard({ wishes: local, updatedAt: now });
      const mediaUrl = await renderCard(card, options.cardDir, options);
      const visible = local.filter((wish) => !['cancelled', 'bought'].includes(wish.status));
      const text = visible.length
        ? `当前愿望单 ${visible.length} 项：${visible.map((wish) => `${wish.id} ${wishItemName(wish)}≤${formatPrice(wish.maxPrice)}p`).join('；')}`
        : '当前没有监控中的愿望。发送「愿望 商品 价格」开始。';
      return { ok: true, kind: 'wishlist', command: 'summary', text, mediaUrl, ...(mediaUrl ? { trustedLocalMedia: true } : {}), wishes: visible, cronAction: activeWishCount(ledger, identity.target) ? 'ensure' : 'remove' };
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
          ledger.trackedOrders = ledger.trackedOrders.filter((track) => track.wishId !== wish.id);
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
        ? `愿望单已保存：${changed.map((wish) => `${wishItemName(wish)}${wishRankText(wish)} ≤ ${formatPrice(wish.maxPrice)}p`).join('；')}。发现符合条件的新卖单后立即通知。`
        : resultTextForCreate(changed[0], createdFlags[0]);
      return { ok: true, kind: 'wishlist', command: parsed.kind, text, mediaUrl, ...(mediaUrl ? { trustedLocalMedia: true } : {}), wish: changed[0], wishes: changed, cronAction: 'ensure' };
    }

    const resolvedWish = resolveWishSelector(local, parsed.selector);
    const wish = resolvedWish.wish;
    if (!wish && resolvedWish.candidates.length > 1) {
      return {
        ok: false, kind: 'wishlist', error: 'ambiguous_selector', candidates: resolvedWish.candidates,
        text: `「${parsed.selector}」对应多个愿望：${resolvedWish.candidates.map((entry) => `${wishItemName(entry)}${wishRankText(entry)}（${entry.id}）`).join('、')}。请选择具体一项。`,
      };
    }
    if (!wish) return { ok: false, kind: 'wishlist', error: 'not_found', text: `没有找到愿望「${parsed.selector || '—'}」。发送「愿望单」查看。` };
    if (options.expectedUpdatedAt && asIso(options.expectedUpdatedAt) !== wish.updatedAt) {
      return { ok: false, kind: 'wishlist', error: 'stale_action', text: '这条愿望刚刚发生过变化，旧按钮已失效。请重新打开愿望单。' };
    }
    if (parsed.action === 'reprice') {
      if (['bought', 'cancelled'].includes(wish.status)) return { ok: false, kind: 'wishlist', error: 'invalid_state', text: '这项愿望已经结束，请重新建立愿望。' };
      if (!Number.isFinite(parsed.price) || parsed.price <= 0 || parsed.price > 900000) return { ok: false, kind: 'wishlist', error: 'invalid_price', text: '价格需要是 1～900000 之间的白金数。' };
      wish.maxPrice = parsed.price;
      wish.status = 'active'; wish.enabled = true; wish.initialized = false;
      wish.seenOrderIds = []; wish.updatedAt = now;
    } else if (parsed.action === 'bought') {
      if (!['active', 'paused'].includes(wish.status)) return { ok: false, kind: 'wishlist', error: 'invalid_state', text: '这项愿望已经结束，请重新打开愿望单。' };
      wish.status = 'bought'; wish.enabled = false; wish.boughtAt = now; wish.updatedAt = now;
    } else if (parsed.action === 'pause') {
      if (wish.status !== 'active') return { ok: false, kind: 'wishlist', error: 'invalid_state', text: '这项愿望当前不能暂停，请重新打开愿望单。' };
      wish.status = 'paused'; wish.enabled = false; wish.updatedAt = now;
    } else if (parsed.action === 'resume') {
      if (wish.status !== 'paused') return { ok: false, kind: 'wishlist', error: 'invalid_state', text: '只有已暂停的愿望可以继续；已购或已取消的愿望请重新建立。' };
      wish.status = 'active'; wish.enabled = true; wish.initialized = false;
      wish.seenOrderIds = []; wish.updatedAt = now;
    } else if (parsed.action === 'cancel') {
      if (!['active', 'paused'].includes(wish.status)) return { ok: false, kind: 'wishlist', error: 'invalid_state', text: '这项愿望已经结束，请重新打开愿望单。' };
      wish.status = 'cancelled'; wish.enabled = false; wish.updatedAt = now;
    } else if (parsed.action === 'undo_bought' || parsed.action === 'undo_cancel') {
      const expectedStatus = parsed.action === 'undo_bought' ? 'bought' : 'cancelled';
      if (wish.status !== expectedStatus) return { ok: false, kind: 'wishlist', error: 'stale_action', text: '这项愿望的状态已经变化，无法再撤销。请重新打开愿望单。' };
      if (nowMs - Date.parse(wish.updatedAt) > 5 * 60 * 1000) return { ok: false, kind: 'wishlist', error: 'undo_expired', text: '撤销窗口已超过 5 分钟；如需继续，请重新建立愿望。' };
      wish.status = 'active'; wish.enabled = true; wish.initialized = false;
      wish.seenOrderIds = []; wish.boughtAt = null; wish.updatedAt = now;
    }
    if (['bought', 'pause', 'cancel', 'reprice', 'resume', 'undo_bought', 'undo_cancel'].includes(parsed.action)) {
      ledger.trackedOrders = ledger.trackedOrders.filter((track) => track.wishId !== wish.id);
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
  const updatedAt = order.updatedAt || order.updated_at || createdAt || null;
  return {
    id: normalize(order.id), itemId, type, platinum: Number.isFinite(platinum) ? platinum : null,
    perTrade: safePerTrade, unitPrice: Number.isFinite(platinum) ? platinum / safePerTrade : null,
    quantity: order.quantity == null ? null : Number(order.quantity), rank: order.rank == null ? null : Number(order.rank),
    visible: order.visible !== false, seller: seller || '未知玩家', status: normalize(order.user?.status || order.status || 'unknown'),
    createdAt: createdAt ? asIso(createdAt) : null, updatedAt: updatedAt ? asIso(updatedAt) : null,
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

function sellerStatusPriority(status) {
  return ({ ingame: 0, 'in-game': 0, online: 1, invisible: 2, offline: 3, unavailable: 4 })[normalize(status).toLowerCase()] ?? 5;
}

export function compareWishlistOrders(left, right) {
  const a = orderPayload(left);
  const b = orderPayload(right);
  return (Number(a.unitPrice) - Number(b.unitPrice))
    || (sellerStatusPriority(a.status) - sellerStatusPriority(b.status))
    || ((Date.parse(b.updatedAt || b.createdAt || '') || 0) - (Date.parse(a.updatedAt || a.createdAt || '') || 0))
    || a.id.localeCompare(b.id);
}

export function lowestWishlistOrder(wish, orders) {
  return (Array.isArray(orders) ? orders : []).map(orderPayload).filter((order) => matchesWishlistOrder(wish, order)).sort(compareWishlistOrders)[0] || null;
}

export function trackingDelayMs(ageMs) {
  if (ageMs < 5 * 60 * 1000) return 10 * 1000;
  if (ageMs < 30 * 60 * 1000) return 30 * 1000;
  return 2 * 60 * 1000;
}

function trackForHit(wish, order, now) {
  const normalized = orderPayload(order);
  const stamp = asIso(now);
  return normalizeTrackedOrder({
    wishId: wish.id, target: wish.target, ownerId: wish.ownerId,
    itemId: wish.itemId, slug: wish.slug,
    orderId: normalized.id, orderIdentity: orderIdentity(normalized),
    initialPrice: normalized.unitPrice, currentPrice: normalized.unitPrice,
    startedAt: stamp, lastConfirmedAt: stamp,
    expiresAt: new Date(Date.parse(stamp) + TRACKING_WINDOW_MS).toISOString(),
    nextCheckAt: new Date(Date.parse(stamp) + trackingDelayMs(0)).toISOString(),
  });
}

function setTrackedOrder(ledger, wish, order, now) {
  ledger.trackedOrders = ledger.trackedOrders.filter((track) => track.wishId !== wish.id);
  ledger.trackedOrders.push(trackForHit(wish, order, now));
}

/** Apply a batch and return transient hits; seller names are never persisted. */
export function applyWishlistOrders(ledgerInput, orders, { source = 'ws', now = new Date().toISOString(), target = '', ownerId = '', notifyInitial = false } = {}) {
  const ledger = normalizeLedger(ledgerInput);
  const hits = [];
  const list = Array.isArray(orders) ? orders : [];
  for (const wish of ledger.wishes) {
    if (!/^qqbot:c2c:/u.test(wish.target)) continue;
    if (target && wish.target !== normalizeId(target)) continue;
    if (ownerId && wish.ownerId !== normalizeId(ownerId)) continue;
    if (wish.status !== 'active' || !wish.enabled) continue;
    const relevant = list.map(orderPayload).filter((order) => order.itemId === wish.itemId);
    const candidate = lowestWishlistOrder(wish, relevant);
    const currentTrack = ledger.trackedOrders.find((track) => track.wishId === wish.id) || null;
    if (source === 'ws' && relevant.length) wish.initialized = true;
    if (source === 'rest' && !wish.initialized) {
      for (const order of relevant) {
        const id = orderIdentity(order);
        wish.seenOrderIds.push(id);
      }
      if (notifyInitial && candidate) {
        wish.lastMatchAt = asIso(now);
        hits.push({ event: 'hit', wishId: wish.id, wish: { id: wish.id, itemId: wish.itemId, itemName: wish.itemName, zhName: wish.zhName, slug: wish.slug, maxPrice: wish.maxPrice, rank: wish.rank, rankMode: wish.rankMode, maxRank: wish.maxRank, ownerName: wish.ownerName, status: wish.status, updatedAt: asIso(now) }, order: candidate });
        setTrackedOrder(ledger, wish, candidate, now);
      }
      wish.seenOrderIds = [...new Set(wish.seenOrderIds)].slice(-MAX_SEEN_PER_WISH);
      wish.initialized = true;
      wish.updatedAt = asIso(now);
      continue;
    }
    const candidateIdentity = candidate ? orderIdentity(candidate) : '';
    const candidateSeen = candidateIdentity && wish.seenOrderIds.includes(candidateIdentity);
    for (const order of relevant) {
      const id = orderIdentity(order);
      if (!wish.seenOrderIds.includes(id)) wish.seenOrderIds.push(id);
    }
    const trackedPrice = Number(currentTrack?.currentPrice);
    const candidatePrice = Number(candidate?.unitPrice);
    const shouldReplace = candidate && currentTrack && candidate.id !== currentTrack.orderId && Number.isFinite(candidatePrice)
      && (!Number.isFinite(trackedPrice) || candidatePrice < trackedPrice);
    const shouldStart = candidate && !currentTrack && !candidateSeen;
    if (shouldStart || shouldReplace) {
      wish.lastMatchAt = asIso(now);
      hits.push({ event: shouldReplace ? 'lower' : 'hit', wishId: wish.id, wish: { id: wish.id, itemId: wish.itemId, itemName: wish.itemName, zhName: wish.zhName, slug: wish.slug, maxPrice: wish.maxPrice, rank: wish.rank, rankMode: wish.rankMode, maxRank: wish.maxRank, ownerName: wish.ownerName, status: wish.status, updatedAt: asIso(now) }, order: candidate });
      setTrackedOrder(ledger, wish, candidate, now);
    }
    wish.seenOrderIds = [...new Set(wish.seenOrderIds)].slice(-MAX_SEEN_PER_WISH);
    wish.updatedAt = asIso(now);
  }
  return { ledger, hits };
}

function activeItemIds(ledger, target, ownerId = '') {
  return new Set(ledger.wishes.filter((wish) => /^qqbot:c2c:/u.test(wish.target) && wish.target === target && (!ownerId || wish.ownerId === ownerId) && wish.status === 'active' && wish.enabled).map((wish) => wish.itemId));
}

export async function fetchTopOrdersForItem(wish, fetchImpl) {
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

export async function fetchWishlistOrderById(track, fetchImpl = globalThis.fetch, wish = null) {
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node 运行时没有可用的 fetch。');
  const response = await fetchImpl(`${MARKET_BASE}/v2/order/${encodeURIComponent(track.orderId)}`, {
    method: 'GET',
    headers: {
      Platform: wish?.platform || PLATFORM, Crossplay: String(wish?.crossplay !== false), Language: 'zh-hans', Accept: 'application/json',
      'User-Agent': 'OpenClaw-Warframe-Assistant/1.1.6 (+https://github.com/FFangx/openclaw-warframe-assistant)',
    },
    signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(8_000) : undefined,
  });
  if (response?.status === 404) return null;
  if (!response?.ok) throw new Error(`Warframe.Market order HTTP ${response?.status || 'error'}`);
  const payload = await response.json();
  const order = payload?.data || payload?.payload || payload;
  return order?.id ? orderPayload(order) : null;
}

function trackingEvent(type, wish, track, order = null, replacement = null) {
  return {
    type, target: track.target, ownerId: track.ownerId, wishId: wish.id,
    wish: { ...wish }, track: { ...track },
    ...(order ? { order: orderPayload(order) } : {}),
    ...(replacement ? { replacement: orderPayload(replacement) } : {}),
  };
}

/**
 * Reconcile due hit targets. A missing order is never announced from a failed
 * request: the first successful absence schedules one exact recheck two
 * seconds later, and only the second successful absence can close the track.
 */
export async function runDueWishlistTracking(statePath = DEFAULT_STATE, options = {}) {
  const nowMs = typeof options.now === 'function' ? Number(options.now()) : Date.now();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const fetchExact = options.fetchOrder || ((track, wish) => fetchWishlistOrderById(track, fetchImpl, wish));
  const fetchTop = options.fetchTop || ((wish) => fetchTopOrdersForItem(wish, fetchImpl));
  let lastRequestStart = 0;
  const throttle = async () => {
    if (options.fetchOrder || options.fetchTop) return;
    const wait = Math.max(0, 400 - (Date.now() - lastRequestStart));
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestStart = Date.now();
  };
  const snapshot = await readWishlistLedger(statePath);
  const due = snapshot.trackedOrders.filter((track) => Date.parse(track.nextCheckAt) <= nowMs || Date.parse(track.expiresAt) <= nowMs);
  const observations = [];
  for (const track of due) {
    const wish = snapshot.wishes.find((entry) => entry.id === track.wishId);
    if (!wish || wish.status !== 'active' || !wish.enabled || !/^qqbot:c2c:/u.test(wish.target)) {
      observations.push({ track, wish, inactive: true });
      continue;
    }
    if (Date.parse(track.expiresAt) <= nowMs) {
      observations.push({ track, wish, expired: true });
      continue;
    }
    try {
      await throttle();
      const exact = await fetchExact(track, wish);
      let topOrders = [];
      let topError = null;
      if (exact || track.missingSince) {
        try { await throttle(); topOrders = await fetchTop(wish); } catch (error) { topError = String(error?.message || error); }
      }
      observations.push({ track, wish, exact, topOrders, topError });
    } catch (error) {
      observations.push({ track, wish, error: String(error?.message || error) });
    }
  }

  return withWishlistLock(statePath, async () => {
    const ledger = await readWishlistLedger(statePath);
    const events = [];
    const recordEvent = async (event) => {
      if (typeof options.enqueueEvent === 'function') await options.enqueueEvent(event);
      events.push(event);
    };
    for (const observed of observations) {
      const index = ledger.trackedOrders.findIndex((entry) => entry.wishId === observed.track.wishId && entry.orderId === observed.track.orderId && entry.startedAt === observed.track.startedAt);
      if (index < 0) continue;
      const track = ledger.trackedOrders[index];
      const wish = ledger.wishes.find((entry) => entry.id === track.wishId);
      if (!wish || observed.inactive) {
        ledger.trackedOrders.splice(index, 1);
        continue;
      }
      if (observed.expired) {
        const unknown = Boolean(track.lastErrorAt && Date.parse(track.lastErrorAt) >= Date.parse(track.lastConfirmedAt));
        await recordEvent(trackingEvent(unknown ? 'expired_unknown' : 'expired', wish, track));
        ledger.trackedOrders.splice(index, 1);
        continue;
      }
      if (observed.error) {
        track.lastErrorAt = new Date(nowMs).toISOString();
        track.nextCheckAt = new Date(Math.min(Date.parse(track.expiresAt), nowMs + trackingDelayMs(nowMs - Date.parse(track.startedAt)))).toISOString();
        continue;
      }
      const exact = observed.exact ? orderPayload(observed.exact) : null;
      if (!exact || !exact.visible || !/^(?:sell|sellorder|sell_order)$/u.test(exact.type)) {
        if (!track.missingSince) {
          track.missingSince = new Date(nowMs).toISOString();
          track.nextCheckAt = new Date(nowMs + TRACKING_CONFIRM_MS).toISOString();
          continue;
        }
        const replacement = lowestWishlistOrder(wish, observed.topOrders || []);
        await recordEvent(trackingEvent(replacement ? 'removed_replaced' : 'removed', wish, track, null, replacement));
        ledger.trackedOrders.splice(index, 1);
        if (replacement) {
          const replacementIdentity = orderIdentity(replacement);
          if (!wish.seenOrderIds.includes(replacementIdentity)) wish.seenOrderIds.push(replacementIdentity);
          ledger.trackedOrders.push(trackForHit(wish, replacement, new Date(nowMs).toISOString()));
        }
        continue;
      }

      const lower = lowestWishlistOrder(wish, observed.topOrders || []);
      if (lower && lower.id !== track.orderId && Number(lower.unitPrice) < Number(exact.unitPrice)) {
        await recordEvent(trackingEvent('lower', wish, track, exact, lower));
        ledger.trackedOrders.splice(index, 1);
        const identity = orderIdentity(lower);
        if (!wish.seenOrderIds.includes(identity)) wish.seenOrderIds.push(identity);
        ledger.trackedOrders.push(trackForHit(wish, lower, new Date(nowMs).toISOString()));
        continue;
      }
      if (!matchesWishlistOrder(wish, exact)) {
        await recordEvent(trackingEvent('price_exceeded', wish, track, exact));
        ledger.trackedOrders.splice(index, 1);
        continue;
      }
      if (Number(exact.unitPrice) !== Number(track.currentPrice)) {
        await recordEvent(trackingEvent(Number(exact.unitPrice) < Number(track.currentPrice) ? 'price_down' : 'price_up', wish, track, exact));
        track.currentPrice = exact.unitPrice;
      }
      track.orderIdentity = orderIdentity(exact);
      track.lastConfirmedAt = new Date(nowMs).toISOString();
      track.lastErrorAt = null;
      track.missingSince = null;
      track.nextCheckAt = new Date(Math.min(Date.parse(track.expiresAt), nowMs + trackingDelayMs(nowMs - Date.parse(track.startedAt)))).toISOString();
    }
    await writeWishlistLedger(statePath, ledger);
    return { ok: true, checked: observations.length, events };
  });
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
// options: { ownerId?, forceRest?, restIntervalMs?, skipRest?, skipWebSocket?, fetchOrders?, restIncompleteError?,
//            fetchImpl?, render?, renderCard?, WebSocketImpl?, wsDurationMs?,
//            outbox?, mailer?, now? }
// 前几项为 monitor/calibrate/gateway_start 兼容路径（输出与行为不变）；后三项是
// R3 第四片的 deliver 生产链注入：只有传入 outbox（且非 dry-run）才启用事务链
// （先补投欠账 → 命中先原子入队 → 提交 seen/calibration 账本 → 锁外逐 part 投递）。
export async function monitorWishlist(targetValue, statePath = DEFAULT_STATE, cardDir = null, dryRun = false, options = {}) {
  const target = normalizeId(targetValue);
  const outbox = options.outbox || null;
  const useOutbox = Boolean(outbox) && !dryRun;
  const mailer = typeof options.mailer === 'function' ? options.mailer : null;
  const nowMs = typeof options.now === 'function' ? options.now() : Date.now();
  let ledger = await readWishlistLedger(statePath);
  const ownerId = normalizeId(options.ownerId || options.owner || '');
  const active = ledger.wishes.filter((wish) => /^qqbot:c2c:/u.test(wish.target) && wish.target === target && (!ownerId || wish.ownerId === ownerId) && wish.status === 'active' && wish.enabled);
  // 1) 先补投欠账（R3 第四片）：账本已提交但投递失败（或入队后进程被杀）的 pending，
  //    即使 REST 未到点/无新命中也会先补投；keyPrefix 限定只投本链业务键，
  //    不代投世界状态/周报/掉落记录（它们由各自的 deliver cron 负责）。
  //    mailer 缺省（如 QQ outbound 暂时不可用）时跳过补投与即时投递，但仍执行
  //    下方 REST 校准与 Outbox 入队（欠账留盘下轮补投），绝不把未投递伪装成已投递。
  let flushSummary = null;
  if (useOutbox && mailer) {
    flushSummary = await outbox.deliverPending({ target, mailer, keyPrefix: WISHLIST_KEY_PREFIX });
  }
  if (!active.length) {
    return { output: 'NO_REPLY\n', data: useOutbox
      ? { ok: true, reason: 'no_wishes', outbox: true, delivery: flushSummary }
      : { ok: true, reason: 'no_wishes' } };
  }
  const targetCalibration = ledger.calibration.targets?.[target] || {};
  const due = options.forceRest || !targetCalibration.lastRestAt || (nowMs - Date.parse(targetCalibration.lastRestAt) >= (options.restIntervalMs ?? REST_INTERVAL_MS));
  let hits = [];
  let restError = null;
  let deferredDelivery = null;
  let hitBusinessKey = null;
  const restIncompleteError = String(options.restIncompleteError || '').trim() || null;
  if (due && options.skipRest !== true) {
    try {
      const orders = options.fetchOrders
        ? await options.fetchOrders(active, options.fetchImpl || globalThis.fetch)
        : await fetchTopOrdersForWishes(active, options.fetchImpl || globalThis.fetch);
      if (useOutbox) {
        // —— Outbox 事务链（R3 第四片）：命中结果确定后先原子入队（含渲染 payload），
        // 再提交 seen/calibration 账本，再在 wishlist 锁外逐 part 投递。
        // 入队失败则整段抛错、seen 不提交（下轮同业务键重试）；
        // 入队成功但账本写失败，下轮同业务键命中去重，不会重复入队。
        const transaction = await withWishlistLock(statePath, async () => {
          // Reload under the lock: a live gateway event may have updated seen
          // IDs while the item-top HTTP request was in flight.
          const latest = await readWishlistLedger(statePath);
          const applied = applyWishlistOrders(latest, orders, { source: 'rest', now: new Date(nowMs).toISOString(), target, ownerId, notifyInitial: true });
          const stamp = new Date(nowMs).toISOString();
          const previousLastRestAt = latest.calibration.targets?.[target]?.lastRestAt || null;
          const calibrationLastRestAt = restIncompleteError ? previousLastRestAt : stamp;
          applied.ledger.calibration = {
            ...applied.ledger.calibration,
            lastRestAt: restIncompleteError ? (latest.calibration.lastRestAt || null) : stamp,
            lastError: restIncompleteError,
            targets: { ...(applied.ledger.calibration.targets || {}), [target]: { lastRestAt: calibrationLastRestAt, lastError: restIncompleteError } },
          };
          let deferred = null;
          let businessKey = null;
          if (applied.hits.length) {
            const payload = await buildWishlistHitPayload(applied.hits, cardDir, options);
            businessKey = wishlistHitBusinessKey(target, wishlistHitsToPairs(applied.hits));
            const enqueued = await outbox.enqueue({
              businessKey, target,
              parts: payload.parts,
              createdAt: new Date(nowMs).toISOString(),
              expiresAt: new Date(nowMs + WISHLIST_TTL_MS).toISOString(),
              redactOnTerminal: true,
            });
            // 去重命中但记录仍 pending（上次入队后账本写失败被恢复）时同样立即补投
            if (enqueued.created || enqueued.entry?.status === 'pending') deferred = enqueued.entry.id;
          }
          // 全部入队成功（或无命中）才一次性提交校准/seen 账本；
          // 任一 enqueue 抛错都不会写账本（绝不吞掉会吞提醒的 seen 状态）。
          await writeWishlistLedger(statePath, applied.ledger);
          return { applied, deferred, businessKey };
        });
        hits.push(...transaction.applied.hits);
        ledger = transaction.applied.ledger;
        deferredDelivery = transaction.deferred;
        hitBusinessKey = transaction.businessKey;
        if (restIncompleteError) restError = restIncompleteError;
      } else {
        const calibrated = await withWishlistLock(statePath, async () => {
          // Reload under the lock: a live gateway event may have updated seen
          // IDs while the item-top HTTP request was in flight.
          const latest = await readWishlistLedger(statePath);
          const applied = applyWishlistOrders(latest, orders, { source: 'rest', now: new Date(nowMs).toISOString(), target, ownerId, notifyInitial: true });
          const stamp = new Date(nowMs).toISOString();
          const previousLastRestAt = latest.calibration.targets?.[target]?.lastRestAt || null;
          const calibrationLastRestAt = restIncompleteError ? previousLastRestAt : stamp;
          applied.ledger.calibration = {
            ...applied.ledger.calibration,
            lastRestAt: restIncompleteError ? (latest.calibration.lastRestAt || null) : stamp,
            lastError: restIncompleteError,
            targets: { ...(applied.ledger.calibration.targets || {}), [target]: { lastRestAt: calibrationLastRestAt, lastError: restIncompleteError } },
          };
          await writeWishlistLedger(statePath, applied.ledger);
          return applied;
        });
        hits.push(...calibrated.hits);
        ledger = calibrated.ledger;
        if (restIncompleteError) restError = restIncompleteError;
      }
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
  // 兼容路径的 WS：只有 monitor/calibrate/gateway_start 使用（不经 Outbox——
  // 要求 7：只有生产 deliver 与 extension live gateway 用 Outbox）。
  const itemIds = activeItemIds(ledger, target, ownerId);
  if (!useOutbox && !dryRun && options.skipWebSocket !== true) {
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
  if (useOutbox) {
    const emptyDelivery = { attempted: 0, sentParts: 0, failedParts: 0, deliveredIds: [], pendingIds: [], expiredIds: [] };
    const delivery = { ...emptyDelivery, ...(flushSummary || {}) };
    if (deferredDelivery && mailer) {
      const summary = await outbox.deliverPending({ target, mailer, ids: [deferredDelivery] });
      delivery.attempted += summary.attempted;
      delivery.sentParts += summary.sentParts;
      delivery.failedParts += summary.failedParts;
      delivery.deliveredIds.push(...summary.deliveredIds);
      delivery.pendingIds.push(...summary.pendingIds);
      delivery.expiredIds.push(...summary.expiredIds);
    }
    return {
      output: 'NO_REPLY\n',
      data: {
        ok: true, hitCount: hits.length, outbox: true,
        ...(hits.length ? { hits } : {}),
        ...(restError ? { restError } : {}),
        ...(hitBusinessKey ? { businessKey: hitBusinessKey } : {}),
        ...(!due ? { reason: 'not_due' } : {}),
        delivered: delivery.sentParts > 0 ? 'direct' : 'queued',
        delivery,
      },
    };
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
// QQ targets. 生产路径（注入 options.outbox）：先为所有命中 target 原子入队
// （每个目标独立业务键与投递状态），全部入队成功才一次性提交 wishlist ledger，
// 再在 wishlist 锁外由调用方（Gateway extension）注入 QQ outbound mailer 让
// Outbox 逐 part 持久化结果；任一目标入队失败则不提交 seen（下轮 REST 校准
// 用同一业务键恢复）。无 outbox 时保持旧行为（先记账、返回可直投结果）。
// seller 数据只存在于瞬时 payload（Outbox pending 的 redactOnTerminal 终态擦除），
// 永不写入 wishlist ledger。
export async function processWishlistLiveOrder(order, statePath = DEFAULT_STATE, cardDir = null, options = {}) {
  const normalizedOrders = (Array.isArray(order) ? order : [order]).map(orderPayload).filter((entry) => entry.itemId);
  if (!normalizedOrders.length) return [];
  const itemIds = new Set(normalizedOrders.map((entry) => entry.itemId));
  const outbox = options.outbox || null;
  const useOutbox = Boolean(outbox);
  const nowMs = typeof options.now === 'function' ? options.now() : Date.now();
  const transaction = await withWishlistLock(statePath, async () => {
    const ledger = await readWishlistLedger(statePath);
    const relevant = ledger.wishes.some((wish) => itemIds.has(wish.itemId) && /^qqbot:c2c:/u.test(wish.target) && wish.status === 'active' && wish.enabled);
    if (!relevant) return { applied: null, byTarget: new Map(), entries: [] };
    const applied = applyWishlistOrders(ledger, normalizedOrders, { source: 'ws', now: new Date(nowMs).toISOString() });
    const byTarget = new Map();
    for (const hit of applied.hits) {
      const target = ledger.wishes.find((wish) => wish.id === hit.wishId)?.target;
      if (!target) continue;
      if (!byTarget.has(target)) byTarget.set(target, []);
      byTarget.get(target).push(hit);
    }
    if (useOutbox) {
      // —— Outbox 事务链（R3 第四片）：所有目标的入队成功后才能一次提交 ledger ——
      const entries = [];
      if (applied.hits.length) {
        for (const [target, targetHits] of byTarget) {
          const payload = await buildWishlistHitPayload(targetHits, cardDir, options);
          const businessKey = wishlistHitBusinessKey(target, wishlistHitsToPairs(targetHits));
          const enqueued = await outbox.enqueue({
            businessKey, target,
            parts: payload.parts,
            createdAt: new Date(nowMs).toISOString(),
            expiresAt: new Date(nowMs + WISHLIST_TTL_MS).toISOString(),
            redactOnTerminal: true,
          });
          entries.push({ target, businessKey, entryId: enqueued.entry?.id || null, hitCount: targetHits.length });
        }
      }
      // 任一 enqueue 抛错会跳过这行：ledger 不提交，绝不会吞掉会吞提醒的 seen 状态
      await writeWishlistLedger(statePath, applied.ledger);
      return { applied, byTarget, entries };
    }
    await writeWishlistLedger(statePath, applied.ledger);
    return { applied, byTarget, entries: null };
  });
  if (useOutbox) {
    return (transaction.entries || []).map((entry) => ({
      ...entry,
      outbox: true,
      data: { ok: true, hitCount: entry.hitCount, hits: transaction.byTarget.get(entry.target) || [] },
    }));
  }
  const results = [];
  for (const [target, hits] of transaction.byTarget) {
    const detectedAt = new Date(nowMs).toISOString();
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
    }, statePath, {
      cardDir: args['card-dir'] ? path.resolve(String(args['card-dir'])) : null,
      expectedUpdatedAt: args['expected-updated-at'] || '',
    }));
    return;
  }
  if (command === 'monitor' || command === 'calibrate' || command === 'gateway_start') {
    // 兼容输出路径：不经 Outbox（只有生产 deliver 与 extension live gateway 用 Outbox）
    const result = await monitorWishlist(target, statePath, args['card-dir'] ? path.resolve(String(args['card-dir'])) : null, String(args['dry-run']).toLowerCase() === 'true', {
      ownerId: normalizeId(args.owner),
      skipWebSocket: command !== 'gateway_start',
    });
    process.stdout.write(result.output);
    return;
  }
  if (command === 'deliver') {
    // 生产校准链（R3 第四片）：先补投欠账 → 命中先原子入 Outbox → 提交 wishlist 账本
    // → 锁外逐 part 投递（Outbox 自带跨进程锁，避免与 Gateway 进程互相覆盖）。
    const dryRun = String(args['dry-run']).toLowerCase() === 'true';
    const outboxPath = args['outbox-path'] ? path.resolve(String(args['outbox-path'])) : defaultOutboxPath(statePath);
    const outbox = dryRun ? null : createOutbox({ filePath: outboxPath });
    const result = await monitorWishlist(target, statePath, args['card-dir'] ? path.resolve(String(args['card-dir'])) : null, dryRun, {
      ownerId: normalizeId(args.owner),
      skipWebSocket: true,
      ...(outbox ? { outbox, mailer: createSubscriptionsMailer(target) } : {}),
    });
    if (dryRun) {
      process.stdout.write(result.output);
      return;
    }
    if (result.data?.outbox) {
      const total = Number(result.data?.delivery?.sentParts || 0);
      process.stdout.write(total > 0 ? `DIRECT_DELIVERED:${total}\n` : 'NO_REPLY\n');
      return;
    }
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
