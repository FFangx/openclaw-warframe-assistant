import { createHash } from 'node:crypto';
import { currency, documentShell, escapeHtml } from './warframe-cards.mjs';

const STATUS = Object.freeze({
  active: { text: '监控中', color: '#75dcca' },
  paused: { text: '已暂停', color: '#f0c765' },
  bought: { text: '已购入', color: '#8ab4f8' },
  cancelled: { text: '已取消', color: '#8995a1' },
});

function localTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未知时间';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

function statusBadge(status) {
  const value = STATUS[status] || STATUS.active;
  return `<span style="display:inline-flex;align-items:center;height:20px;padding:0 7px;border:1px solid ${value.color};border-radius:5px;color:${value.color};font-size:10px;font-weight:850;white-space:nowrap">${escapeHtml(value.text)}</span>`;
}

function shortId(value) {
  return String(value || '').trim().toUpperCase() || '----';
}

function itemLabel(item) {
  return item?.zhName || item?.itemName || item?.name || item?.slug || '未知商品';
}

function rankLabel(item) {
  if (item?.rankMode === 'max') return ' · 满级';
  if (item?.rankMode === 'exact' && item?.rank != null) return ` · 等级${item.rank}`;
  return '';
}

function sellerStatusLabel(status) {
  const normalized = String(status || '').trim().toLowerCase();
  return ({
    ingame: '游戏中',
    'in-game': '游戏中',
    online: '在线',
    offline: '离线',
    invisible: '隐身',
    unavailable: '不可用',
    unknown: '状态未知',
  })[normalized] || (normalized ? String(status) : '状态未知');
}

function baseCard(kind, title, kicker, meta, body, footer, height, keySeed) {
  const headerIcon = kind === 'hit'
    ? '<div class="brand-icon"><svg viewBox="0 0 24 24" fill="none" stroke="#f0c765" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h16"/><path d="M12 4v16"/><circle cx="12" cy="12" r="8"/><path d="m8.5 12 2.2 2.2 4.8-5"/></svg></div>'
    : kind === 'summary'
      ? '<div class="brand-icon"><svg viewBox="0 0 24 24" fill="none" stroke="#75dcca" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg></div>'
      : '<div class="brand-icon"><svg viewBox="0 0 24 24" fill="none" stroke="#8ab4f8" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 20h16"/></svg></div>';
  const content = `<div class="card"><div class="header">${headerIcon}<div style="min-width:0"><div class="kicker">${escapeHtml(kicker)}</div><div class="title">${escapeHtml(title)}</div></div><div class="header-meta">${meta || ''}</div></div>${body}<div class="footer">${footer}</div></div>`;
  return {
    html: documentShell(content, height, 600),
    width: 600,
    height,
    key: `wishlist-${kind}-${createHash('sha1').update(keySeed).digest('hex').slice(0, 12)}`,
  };
}

function wishSummaryRow(wish, index) {
  const status = wish.status || (wish.enabled === false ? 'paused' : 'active');
  const item = itemLabel(wish);
  return `<div style="position:relative;z-index:1;min-height:70px;display:grid;grid-template-columns:48px minmax(0,1fr) auto;gap:10px;align-items:center;padding:9px 16px;border-bottom:1px solid rgba(127,140,153,.32);background:${index % 2 ? 'rgba(255,255,255,.035)' : 'rgba(255,255,255,.014)'}">
    <div style="width:38px;height:30px;display:grid;place-items:center;border-radius:7px;background:rgba(117,220,202,.13);color:#75dcca;font-size:11px;font-weight:900;letter-spacing:.6px">${escapeHtml(shortId(wish.id))}</div>
    <div style="min-width:0"><div style="font-size:15px;font-weight:830;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(item)}${escapeHtml(rankLabel(wish))}</div><div style="margin-top:4px;font-size:10px;color:#8f9aa6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">阈值 ${currency('plat', Number(wish.maxPrice) || 0, { size: 10, weight: 850 })} · ${status === 'active' ? '实时监听新卖单' : '可随时继续监控'}</div></div>
    <div style="text-align:right">${statusBadge(status)}<div style="margin-top:4px;font-size:9px;color:#7f8b97">${escapeHtml(localTime(wish.updatedAt || wish.createdAt))}</div></div>
  </div>`;
}

function subscriptionLine(data) {
  const wish = data.wish || data;
  return `<div class="section"><span class="section-badge">${escapeHtml(shortId(wish.id))}</span><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(itemLabel(wish))}${escapeHtml(rankLabel(wish))}</span><small>≤ ${currency('plat', Number(wish.maxPrice) || 0, { size: 10, weight: 850 })}</small></div>
    <div style="position:relative;z-index:1;height:84px;display:flex;flex-direction:column;justify-content:center;padding:0 18px;background:rgba(255,255,255,.018)"><div style="font-size:15px;font-weight:800;color:${STATUS[wish.status || 'active']?.color || '#75dcca'}">${escapeHtml(data.message || '愿望单已更新')}</div><div style="margin-top:7px;font-size:11px;color:#9ca7b1">${escapeHtml(data.detail || '发现符合条件的新卖单后立即通知')}</div></div>`;
}

/** Template 1: create/update/pause/continue feedback. */
export function buildWishlistSubscriptionCard(data = {}) {
  const wish = data.wish || data.wishes?.[0] || data;
  const status = wish.status || (wish.enabled === false ? 'paused' : 'active');
  const action = data.actionText || (data.created ? '愿望单已建立' : '愿望单已更新');
  const detail = data.detail || (status === 'active' ? '发现符合条件的新卖单后立即通知' : `需要时发送「继续 ${shortId(wish.id)}」恢复监控`);
  const wishes = Array.isArray(data.wishes) && data.wishes.length ? data.wishes : [wish];
  const row = wishes.map((entry, index) => subscriptionLine({ ...data, wish: entry, message: index === 0 ? action : '愿望单已同步', detail: index === 0 ? detail : '发现符合条件的新卖单后立即通知' })).join('');
  const height = 84 + wishes.length * (30 + 84) + 34;
  const footer = `<span>来源：Warframe.Market 实时订单</span><span>${statusBadge(status)}</span>`;
  return baseCard('subscription', '愿望单已保存', '愿望单 · 设置反馈', `<strong>${escapeHtml(localTime(data.updatedAt || wish.updatedAt || new Date().toISOString()))}</strong><span>${wishes.length} 项 · 只读市场监控</span>`, row, footer, height, `v3|${action}|${wishes.map((entry) => `${entry.id}|${itemLabel(entry)}|${entry.maxPrice}|${entry.status}`).join('|')}`);
}

/** Template 2: the explicit no-argument `愿望单` summary. */
export function buildWishlistSummaryCard(data = {}) {
  const wishes = Array.isArray(data.wishes) ? data.wishes : [];
  const shown = wishes.filter((wish) => !['cancelled', 'bought'].includes(wish.status)).slice(0, 14);
  const body = shown.length
    ? `<div class="section"><span class="section-badge">${shown.length}</span>当前愿望 <small>短编号可用于改价、暂停、继续、已购、取消</small></div>${shown.map(wishSummaryRow).join('')}`
    : `<div class="section"><span class="section-badge">0</span>当前愿望</div><div style="position:relative;z-index:1;height:90px;display:grid;place-items:center;color:#8995a1;font-size:14px">还没有愿望。发送「愿望 商品 价格」开始监控。</div>`;
  const height = 84 + (shown.length ? 30 + shown.length * 70 : 30 + 90) + 34;
  const footer = `<span>WebSocket 秒级命中 · REST 低频校准</span><span>${shown.length ? `显示 ${shown.length}${wishes.length > shown.length ? `/${wishes.length}` : ''}` : '仅保留本地设置'}</span>`;
  return baseCard('summary', '我的愿望单', '愿望单 · 汇总', `<strong>${shown.length} 项</strong><span>${escapeHtml(localTime(data.updatedAt || new Date().toISOString()))}</span>`, body, footer, height, `v3|${shown.map((wish) => `${wish.id}|${itemLabel(wish)}|${wish.maxPrice}|${wish.status}`).join('|')}`);
}

function hitRow(hit, index) {
  const order = hit.order || hit;
  const name = itemLabel(hit.wish || hit);
  const price = Number(order.unitPrice ?? (Number(order.platinum) / Math.max(1, Number(order.perTrade) || 1)));
  const maxPrice = Number(hit.wish?.maxPrice);
  const seller = order.seller || order.user?.ingameName || '未知玩家';
  const sellerStatus = sellerStatusLabel(order.status);
  const quantity = order.quantity == null ? '—' : `×${order.quantity}`;
  const owner = String(hit.wish?.ownerName || '').trim();
  const ownerText = owner && !/^[a-z0-9_-]{20,}$/iu.test(owner) ? ` · 订阅者 ${escapeHtml(owner)}` : '';
  return `<div style="position:relative;z-index:1;height:90px;display:grid;grid-template-columns:32px minmax(0,1fr) 134px;gap:10px;align-items:center;padding:8px 16px;border-bottom:1px solid rgba(240,199,101,.34);background:${index % 2 ? 'rgba(255,255,255,.035)' : 'rgba(255,255,255,.014)'}">
    <div style="width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:rgba(240,199,101,.16);color:#f0c765;font-size:12px;font-weight:900">${index + 1}</div>
    <div style="min-width:0"><div style="font-size:14px;font-weight:830;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(name)} <span style="font-size:10px;color:#8f9aa6;font-weight:650">${escapeHtml(quantity)}</span></div><div style="margin-top:4px;font-size:10px;color:#9ca7b1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">卖家 ${escapeHtml(seller)} · 状态 ${escapeHtml(sellerStatus)}${order.rank != null ? ` · 等级 ${escapeHtml(order.rank)}` : ''}${ownerText}</div><div style="margin-top:5px;font-size:9px;color:#8ab4f8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">私聊模板见图片下方</div></div>
    <div style="text-align:right"><div style="font-size:16px;font-weight:900;color:#f0c765">${currency('plat', Number.isFinite(price) ? price : 0, { size: 12, weight: 900 })}<span style="font-size:9px;color:#9ca7b1;font-weight:650"> /件</span></div><div style="margin-top:3px;font-size:10px;color:#8f9aa6">上限 ${Number.isFinite(maxPrice) ? `${escapeHtml(maxPrice)}p` : '—'}</div><div style="margin-top:3px;font-size:10px;color:#8f9aa6">${escapeHtml(shortId(hit.wish?.id || hit.wishId))}</div></div>
  </div>`;
}

/** Template 3: a hit notification. It intentionally never marks the wish bought. */
export function buildWishlistHitCard(data = {}) {
  const hits = Array.isArray(data.hits) ? data.hits : [];
  const shown = hits.slice(0, 12);
  const body = `<div class="section"><span class="section-badge">命中 ${hits.length}</span>符合价格条件的新卖单 <small>${escapeHtml(localTime(data.detectedAt || new Date().toISOString()))}</small></div>${shown.length ? shown.map(hitRow).join('') : '<div style="position:relative;z-index:1;height:72px;display:grid;place-items:center;color:#8995a1;font-size:13px">暂无新命中</div>'}`;
  const ids = shown.map((hit) => shortId(hit.wish?.id || hit.wishId));
  const command = ids.length === 1
    ? `已成功购入发送「已购 ${ids[0]}」，否则无需回复继续监控`
    : `已成功购入分别发送「已购 ${ids.join('」「已购 ')}」，否则无需回复继续监控`;
  const hint = `<div style="position:relative;z-index:1;min-height:52px;padding:11px 16px;display:flex;align-items:center;background:rgba(240,199,101,.10);border-top:1px solid rgba(240,199,101,.36);border-bottom:1px solid rgba(240,199,101,.36);color:#f3d88b;font-size:12px;font-weight:800;line-height:17px">${escapeHtml(command)}</div>`;
  const height = 84 + 30 + Math.max(shown.length, 1) * 90 + 52 + 34;
  const footer = `<span>命中后不会自动核销 · 订单仅用于本次提醒</span><span>${hits.length > shown.length ? `显示 ${shown.length}/${hits.length}` : '实时监听'}</span>`;
  return baseCard('hit', '发现符合条件的卖单', '愿望单 · 命中推送', `<strong style="color:#f0c765">${hits.length} 条</strong><span>请手动确认购买</span>`, `${body}${hint}`, footer, height, `v3|${data.detectedAt}|${shown.map((hit) => `${hit.wishId || hit.wish?.id}|${hit.order?.id || hit.orderId}|${hit.order?.unitPrice ?? hit.order?.platinum}`).join('|')}`);
}

export function buildWishlistCard(data = {}) {
  if (data.template === 'hit' || data.hits) return buildWishlistHitCard(data);
  if (data.template === 'summary' || data.wishes) return buildWishlistSummaryCard(data);
  return buildWishlistSubscriptionCard(data);
}
