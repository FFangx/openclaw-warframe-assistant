#!/usr/bin/env node

// vendor-shop-card.mjs — 商店三张卡：总览 / 单商人详情 / 哪里买反查 + 订阅上架提醒。
// 数据全部来自 vendor-shop.mjs 的装配输出，本文件只管画；样式复用 warframe-cards 的 documentShell 体系。
// 已购状态视觉约定：✅绿=已购买（oid 对齐唯一解）；「已购 M 件」计数=对齐多解/真轮换的诚实降级。

import { currency, documentShell, escapeHtml } from './warframe-cards.mjs';

const C = { text: '#f3f5f7', sub: '#aeb9c4', dim: '#8f9aa6', green: '#67dfb8', gold: '#f0c765', cyan: '#72ded3', purple: '#c98add', blue: '#9bb6d3' };

function countdownMs(ms) {
  const remaining = Math.max(0, ms - Date.now());
  const days = Math.floor(remaining / 86400000);
  const hours = Math.floor((remaining % 86400000) / 3600000);
  const minutes = Math.floor((remaining % 3600000) / 60000);
  if (days > 0) return `${days}天${hours}时`;
  return hours > 0 ? `${hours}时${String(minutes).padStart(2, '0')}分` : `${minutes}分`;
}

function localDateTime(ms) {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '未知';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

function shopIcon() {
  return `<div class="brand-icon"><svg viewBox="0 0 24 24" fill="none" stroke="#f0c765" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7l1.5-4h13L20 7"/><path d="M4 7h16v3a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7z"/><path d="M6 13v8h12v-8"/><path d="M10 21v-5h4v5"/></svg></div>`;
}

// 价格串：有官方图标货币用 currency()（返回 HTML 禁二次转义），其余「N× 中文名」文字
// ⚠ 输出含 HTML，调用侧不得再 escapeHtml
function priceHtml(prices, size = 14) {
  if (!prices?.length) return `<span style="color:${C.dim}">—</span>`;
  return prices.map((price) => price.kind
    ? currency(price.kind, price.count, { size })
    : `<span style="white-space:nowrap;color:${C.sub}"><b style="color:${C.text};font-variant-numeric:tabular-nums">${escapeHtml(price.count.toLocaleString('zh-CN'))}</b>× ${escapeHtml(price.label)}</span>`).join('<span style="color:#49535e"> + </span>');
}

function markBadge(mark) {
  if (mark === 'bought') return `<span style="flex:0 0 auto;padding:2px 8px;border-radius:5px;font-size:11px;font-weight:800;color:#14181d;background:${C.green}">已购买</span>`;
  return '';
}

function syndicateNote(syndicate) {
  if (!syndicate) return '';
  const parts = [];
  if (syndicate.minRank != null) parts.push(`集团等级≥${syndicate.minRank}`);
  if (syndicate.standing != null) parts.push(`声望 ${Number(syndicate.standing).toLocaleString('zh-CN')}`);
  return parts.length ? ` · ${parts.join(' · ')}` : '';
}

// —— 商品行（详情卡/反查卡共用骨架）——
function itemRow(row, { showExpiry = false, withIcon = false } = {}) {
  const notes = [];
  if (row.limit) notes.push(`限购 ${row.limit}`);
  if (row.probability != null) notes.push(`每期 ${Math.round(row.probability * 100)}% 上架`);
  if (showExpiry && row.expiry) notes.push(`${countdownMs(row.expiry)} 后轮换`);
  const noteText = notes.join(' · ') + syndicateNote(row.syndicate);
  // 图列：任一行有图就全列留位，查无留空 div 对齐（奸商卡同款）
  const iconCell = withIcon
    ? (row.iconDataUri ? `<img src="${row.iconDataUri}" style="flex:0 0 30px;width:30px;height:30px;object-fit:contain">` : '<div style="flex:0 0 30px"></div>')
    : '';
  return `<div style="min-height:38px;display:flex;align-items:center;gap:10px;padding:4px 16px;border-bottom:1px solid rgba(176,123,55,.24)">
    ${iconCell}${row.featured ? `<span style="flex:0 0 auto;color:${C.gold};font-weight:900">★</span>` : ''}${markBadge(row.mark)}
    <span style="font-size:15px;font-weight:700;color:${row.mark === 'bought' ? C.dim : C.text};min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(row.name)}${row.quantity ? ` ×${row.quantity}` : ''}</span>
    ${noteText ? `<span style="flex:0 0 auto;font-size:11px;color:${C.dim};white-space:nowrap">${escapeHtml(noteText)}</span>` : ''}
    <span style="margin-left:auto;flex:0 0 auto;font-size:14px">${priceHtml(row.prices)}</span></div>`;
}

function sectionBar(label, color, note = '') {
  return `<div class="section"><span class="section-badge" style="background:${color}">${escapeHtml(label)}</span>${note ? escapeHtml(note) : ''}<small></small></div>`;
}

// ==== ① 商店总览卡 ====
export function buildShopOverviewCard(overview, fetchedAt = new Date().toISOString()) {
  const rowH = 74;
  const rows = overview.rows.map((row, index) => {
    const boughtText = row.bought
      ? `已购 ${row.bought.total} 件${row.bought.names?.length ? `（${row.bought.names.join('、')}${row.bought.total > row.bought.names.length ? '…' : ''}）` : ''}`
      : '';
    return `<div style="height:${rowH}px;display:grid;grid-template-columns:30px minmax(0,1fr) 120px;align-items:center;padding:0 16px;border-bottom:1px solid rgba(176,123,55,.30);background:${index % 2 ? 'rgba(255,255,255,.035)' : 'rgba(255,255,255,.014)'}">
      <div style="font-size:18px;font-weight:900;color:${C.gold};font-variant-numeric:tabular-nums">${index + 1}</div>
      <div style="min-width:0">
        <div style="display:flex;align-items:center;gap:8px">
          <b style="font-size:17px;white-space:nowrap;flex:0 0 auto">${escapeHtml(row.zhName)}</b>
          <span class="pill" style="color:${row.badge === '随机轮换' ? C.purple : row.badge === '固定货单' ? C.dim : C.cyan};font-size:10px;height:19px;flex:0 0 auto;white-space:nowrap">${escapeHtml(row.badge)}</span>
          ${boughtText ? `<span style="font-size:12px;color:${C.green};font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(boughtText)}</span>` : ''}</div>
        <div style="margin-top:5px;font-size:12px;color:${C.dim};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(row.summary)}</div></div>
      <div style="text-align:right">${row.expiryMs
        ? `<div style="font-size:17px;font-weight:900;color:${C.cyan};font-variant-numeric:tabular-nums">${escapeHtml(countdownMs(row.expiryMs))}</div><div style="font-size:10px;color:${C.dim}">距下次轮换</div>`
        : `<div style="font-size:12px;color:${C.dim}">—</div>`}</div></div>`;
  }).join('');
  const height = 84 + overview.rows.length * rowH + 32;
  const content = `<div class="card"><div class="header">${shopIcon()}<div><div class="kicker">商店 · 轮换与已购总览</div><div class="title">商店总览</div></div><div class="header-meta"><strong>「商店 序号」看详情</strong><span>「哪里买 物品名」反查</span></div></div>${rows}<div class="footer"><span>货单：官方导出数据 · 已购：本机快照</span><span>${escapeHtml(new Date(fetchedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }))}</span></div></div>`;
  return { html: documentShell(content, height), width: 600, height, key: `shop-overview-${String(fetchedAt).slice(0, 16)}` };
}

// ==== ② 单商人详情卡 ====
export function buildVendorDetailCard(detail, fetchedAt = new Date().toISOString()) {
  const sections = [];
  const meta = detail.meta || {};
  // 已购汇总行：unresolved>0 时诚实标注「其中 N 件无法定位到具体商品」
  const boughtBits = [];
  if (detail.boughtTotal) boughtBits.push(`本期已购 ${detail.boughtTotal} 件`);
  if (detail.unresolved) boughtBits.push(`其中 ${detail.unresolved} 件次无法定位到具体商品`);
  if (detail.evergreenBought) boughtBits.push(`常驻/限购商品已购 ${detail.evergreenBought} 件`);

  if (detail.kind === 'rotating') {
    sections.push({ bar: sectionBar('候选池', C.purple, `每期随机上架 · 本期货单以游戏内为准${detail.boughtTotal ? ` · 本期已购 ${detail.boughtTotal} 件` : ''}`), rows: detail.pool });
  } else {
    if (detail.rotating.length) sections.push({ bar: sectionBar('本期轮换', C.cyan, detail.nextRotationAt ? `${countdownMs(detail.nextRotationAt)} 后轮换（${localDateTime(detail.nextRotationAt)}）` : ''), rows: detail.rotating });
    if (detail.evergreen.length) sections.push({ bar: sectionBar('常驻', '#56616d', ''), rows: detail.evergreen });
  }
  const anyIcon = sections.some((section) => section.rows.some((row) => row.iconDataUri));

  const rowsHtml = sections.map((section) => section.bar + section.rows.map((row) => itemRow(row, { withIcon: anyIcon })).join('')).join('');
  const rowCount = sections.reduce((sum, section) => sum + section.rows.length, 0);
  const infoLines = [meta.location ? `位置：${meta.location}` : '', meta.currency ? `货币：${meta.currency}` : ''].filter(Boolean);
  const infoH = infoLines.length ? infoLines.length * 24 + 16 : 0;
  const boughtH = boughtBits.length ? 30 : 0;
  const height = 84 + infoH + boughtH + sections.length * 30 + rowCount * 38 + 32 + 12;
  const content = `<div class="card"><div class="header">${shopIcon()}<div><div class="kicker">商店 · ${escapeHtml(meta.faction || '商人详情')}</div><div class="title">${escapeHtml(detail.zhName)}</div></div><div class="header-meta">${detail.kind === 'rotating' ? `<span class="pill" style="color:${C.purple}">随机轮换</span>` : detail.kind === 'cyclic' ? `<span class="pill" style="color:${C.cyan}">周期轮换</span>` : `<span class="pill" style="color:${C.dim}">固定货单</span>`}</div></div>
    ${infoLines.length ? `<div style="padding:8px 16px;border-bottom:1px solid #3d454f">${infoLines.map((line) => `<div style="height:24px;display:flex;align-items:center;font-size:12px;color:${C.sub};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(line)}</div>`).join('')}</div>` : ''}
    ${boughtBits.length ? `<div style="height:30px;display:flex;align-items:center;padding:0 16px;font-size:13px;font-weight:800;color:${C.green};border-bottom:1px solid #3d454f">${escapeHtml(boughtBits.join(' · '))}</div>` : ''}
    ${rowsHtml}
    <div class="footer" style="margin-top:12px"><span>货单：官方导出数据 · 已购：本机快照</span><span>${escapeHtml(new Date(fetchedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }))}</span></div></div>`;
  return { html: documentShell(content, height), width: 600, height, key: `shop-detail3-${detail.key.split('/').pop()}-${anyIcon ? 'i' : 'x'}-${String(fetchedAt).slice(0, 16)}` };
}

// ==== ③ 瓦奇娅 / 达尔沃专属详情（结构不同单独画） ====
export function buildVarziaCard(varzia, fetchedAt = new Date().toISOString()) {
  const rowH = 34;
  const regal = varzia.current.filter((row) => row.regal > 0);
  const aya = varzia.current.filter((row) => !row.regal && row.aya > 0);
  const sections = [];
  if (regal.length) sections.push({ label: '御品阿耶精华区', color: '#e8b4c8', rows: regal.map((row) => ({ name: row.name, html: currency('regalAya', row.regal, { size: 14 }) })) });
  if (aya.length) sections.push({ label: '阿耶精华区', color: '#d8c9a3', rows: aya.map((row) => ({ name: row.name, html: currency('aya', row.aya, { size: 14 }) })) });
  const rowCount = sections.reduce((sum, section) => sum + section.rows.length, 0);
  const nextH = varzia.next?.featured ? 34 : 0;
  const height = 84 + 34 + sections.length * 30 + rowCount * rowH + nextH + 32;
  const rowsHtml = sections.map((section) => sectionBar(section.label, section.color)
    + section.rows.map((row) => `<div style="height:${rowH}px;display:flex;align-items:center;gap:10px;padding:0 16px;border-bottom:1px solid rgba(176,123,55,.24)">
      <span style="font-size:14px;color:${C.text};min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(row.name)}</span>
      <span style="margin-left:auto;font-size:14px">${row.html}</span></div>`).join('')).join('');
  const content = `<div class="card"><div class="header">${shopIcon()}<div><div class="kicker">商店 · Prime 重生</div><div class="title">禁卫瓦奇娅</div></div><div class="header-meta"><span class="pill" style="color:${C.gold}">剩 ${escapeHtml(countdownMs(varzia.expiryMs))}</span></div></div>
    <div style="height:34px;display:flex;align-items:center;padding:0 16px;font-size:12px;color:${C.dim};border-bottom:1px solid #3d454f">当期货单 ${varzia.current.length} 件 · ${escapeHtml(localDateTime(varzia.expiryMs))} 换期</div>
    ${rowsHtml}
    ${varzia.next?.featured ? `<div style="height:34px;display:flex;align-items:center;gap:8px;padding:0 16px;border-top:1px solid #3d454f"><span class="pill" style="color:${C.cyan};font-size:10px;height:19px">下期预告</span><span style="font-size:13px;color:${C.sub}">${escapeHtml(varzia.next.featured)}（官方排期）</span></div>` : ''}
    <div class="footer"><span>来源：官方世界状态（含未来排期）</span><span>${escapeHtml(new Date(fetchedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }))}</span></div></div>`;
  return { html: documentShell(content, height), width: 600, height, key: `shop-varzia-${String(fetchedAt).slice(0, 16)}` };
}

export function buildDarvoCard(darvo, fetchedAt = new Date().toISOString()) {
  const rowH = 64;
  const rows = darvo.deals.map((deal) => `<div style="height:${rowH}px;display:grid;grid-template-columns:minmax(0,1fr) 150px;align-items:center;padding:0 16px;border-bottom:1px solid rgba(176,123,55,.30)">
    <div style="min-width:0">
      <div style="display:flex;align-items:center;gap:8px"><b style="font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(deal.name)}</b><span class="pill" style="color:${C.gold};font-size:10px;height:19px">-${deal.discount}%</span></div>
      <div style="margin-top:4px;font-size:12px;color:${C.dim}">余量 ${Math.max(0, deal.total - deal.sold)}/${deal.total} · ${escapeHtml(countdownMs(deal.expiryMs))} 后轮换</div></div>
    <div style="text-align:right">${currency('plat', deal.salePrice, { size: 16 })}<div style="font-size:11px;color:${C.dim};text-decoration:line-through">原价 ${deal.originalPrice}</div></div></div>`).join('');
  const height = 84 + darvo.deals.length * rowH + 32;
  const content = `<div class="card"><div class="header">${shopIcon()}<div><div class="kicker">商店 · 市场每日特惠</div><div class="title">达尔沃特惠</div></div><div class="header-meta"><span class="pill" style="color:${C.gold}">实时余量</span></div></div>${rows}<div class="footer"><span>来源：官方世界状态</span><span>${escapeHtml(new Date(fetchedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }))}</span></div></div>`;
  return { html: documentShell(content, height), width: 600, height, key: `shop-darvo-${String(fetchedAt).slice(0, 16)}` };
}

// ==== ④ 哪里买反查卡 ====
export function buildWhereToBuyCard(result, fetchedAt = new Date().toISOString()) {
  const rowH = 62;
  const anyIcon = result.hits.some((hit) => hit.iconDataUri);
  const gridCols = anyIcon ? '48px minmax(0,1fr) 170px' : 'minmax(0,1fr) 170px';
  const iconCell = (hit) => anyIcon
    ? (hit.iconDataUri ? `<div style="display:grid;place-items:center"><img src="${hit.iconDataUri}" style="width:42px;height:42px;object-fit:contain"></div>` : '<div></div>')
    : '';
  const rows = result.hits.map((hit, index) => `<div style="height:${rowH}px;display:grid;grid-template-columns:${gridCols};align-items:center;padding:0 16px;border-bottom:1px solid rgba(176,123,55,.30);background:${index % 2 ? 'rgba(255,255,255,.035)' : 'rgba(255,255,255,.014)'}">
    ${iconCell(hit)}<div style="min-width:0">
      <div style="display:flex;align-items:center;gap:8px">
        <b style="font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(hit.itemName)}</b>
        <span class="pill" style="color:${hit.availability === '常驻' ? C.green : hit.kind === 'cyclic' ? C.cyan : C.purple};font-size:10px;height:19px">${escapeHtml(hit.availability)}</span></div>
      <div style="margin-top:4px;font-size:12px;color:${C.dim};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(hit.vendorZh)}${hit.location ? ` · ${escapeHtml(hit.location)}` : ''}${escapeHtml(syndicateNote(hit.syndicate))}</div></div>
    <div style="text-align:right;font-size:13px">${priceHtml(hit.prices, 13)}</div></div>`).join('');
  const height = 84 + Math.max(result.hits.length, 1) * rowH + 32;
  const empty = `<div style="height:${rowH}px;display:flex;align-items:center;justify-content:center;color:${C.dim};font-size:14px">没有商人出售「${escapeHtml(result.query)}」——可能来自掉落/合成，试试「遗物 ${escapeHtml(result.query)}」</div>`;
  const content = `<div class="card"><div class="header">${shopIcon()}<div><div class="kicker">商店 · 哪里买</div><div class="title">${escapeHtml(result.query)}</div></div><div class="header-meta"><strong>${result.total || 0} 个货源</strong><span>${result.total > result.hits.length ? `显示前 ${result.hits.length}` : '全部显示'}</span></div></div>${rows || empty}<div class="footer"><span>货单：官方导出数据 · 常驻优先排序</span><span>${escapeHtml(new Date(fetchedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }))}</span></div></div>`;
  return { html: documentShell(content, height), width: 600, height, key: `shop-where3-${result.query}-${anyIcon ? 'i' : 'x'}-${String(fetchedAt).slice(0, 16)}` };
}

// ==== ⑥ 本周好货卡（周一随周报推送；数据=buildWeeklyDeals） ====
export function buildWeeklyDealsCard(deals, fetchedAt = new Date().toISOString()) {
  const tierBadge = (tier) => tier === 'T0'
    ? `<span style="flex:0 0 auto;padding:2px 8px;border-radius:5px;font-size:11px;font-weight:900;color:#14181d;background:${C.gold}">必抢</span>`
    : `<span style="flex:0 0 auto;padding:2px 8px;border-radius:5px;font-size:11px;font-weight:800;color:${C.cyan};border:1px solid ${C.cyan}">周货</span>`;
  const dealRow = (row) => {
    const notes = [];
    if (row.tierNote) notes.push(row.tierNote);
    if (row.limit) notes.push(`限购 ${row.limit}`);
    return `<div style="min-height:40px;display:flex;align-items:center;gap:10px;padding:5px 16px;border-bottom:1px solid rgba(176,123,55,.24)">
      ${tierBadge(row.tier)}${row.featured ? `<span style="flex:0 0 auto;color:${C.gold};font-weight:900">★</span>` : ''}${markBadge(row.mark)}
      <span style="font-size:15px;font-weight:700;color:${row.mark === 'bought' ? C.dim : C.text};min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(row.name)}${row.quantity ? ` ×${Number(row.quantity).toLocaleString('zh-CN')}` : ''}</span>
      ${notes.length ? `<span style="flex:0 0 auto;font-size:11px;color:${C.dim};white-space:nowrap">${escapeHtml(notes.join(' · '))}</span>` : ''}
      <span style="margin-left:auto;flex:0 0 auto;font-size:14px">${priceHtml(row.prices)}</span></div>`;
  };
  let body = '';
  let rowCount = 0;
  let sectionCount = 0;
  for (const section of deals.sections || []) {
    const boughtNote = section.boughtTotal > 0 ? `本周已购 ${section.boughtTotal} 件` : '';
    const cd = section.nextRotationAt ? `${countdownMs(section.nextRotationAt)} 后轮换` : '';
    body += sectionBar(section.vendorZh, C.gold, [boughtNote, cd].filter(Boolean).join(' · '))
      + section.rows.map(dealRow).join('');
    rowCount += section.rows.length;
    sectionCount += 1;
  }
  if (deals.varzia) {
    body += sectionBar('禁卫瓦奇娅', C.purple, `${countdownMs(deals.varzia.expiryMs)} 后换期`)
      + `<div style="min-height:40px;display:flex;align-items:center;gap:10px;padding:5px 16px;border-bottom:1px solid rgba(176,123,55,.24)">
        <span style="font-size:15px;font-weight:700;color:${C.text};min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">当期复刻：${escapeHtml(deals.varzia.summary)} 等 ${deals.varzia.count} 件</span>
        ${deals.varzia.next ? `<span style="margin-left:auto;flex:0 0 auto;font-size:12px;color:${C.dim}">下期 ${escapeHtml(deals.varzia.next)}</span>` : ''}</div>`;
    rowCount += 1;
    sectionCount += 1;
  }
  // 高度按目检实测：header 86 + sectionBar 28/条 + 行 41/行 + hint 36 + footer 40（余量 10）
  const height = 96 + sectionCount * 28 + rowCount * 41 + 36 + 40;
  const content = `<div class="card"><div class="header">${shopIcon()}<div><div class="kicker">每周一刷新 · 限购重置</div><div class="title">本周好货</div></div><div class="header-meta">发「商店」看全商人总览</div></div>
    ${body}
    <div style="padding:10px 16px;font-size:12px;color:${C.dim}">💡 ${escapeHtml(deals.hint || '')}</div>
    <div class="footer"><span>来源：商店轮换复现 + 官方排期</span><span>价值分级为本工具口径</span></div></div>`;
  // key 掺内容特征：行数+已购数+瓦奇娅摘要长度——只看行数会吃陈旧缓存（v2 改摘要时踩过）
  const feat = `${rowCount}-${(deals.sections || []).reduce((s, x) => s + (x.boughtTotal || 0), 0)}-${(deals.varzia?.summary || '').length}`;
  return { html: documentShell(content, height), width: 600, height, key: `weekly-deals-v4-${feat}-${String(fetchedAt).slice(0, 13)}` };
}

// ==== ⑤ 订阅推送卡：商品上架 / 轮换前未购提醒 ====
export function buildVendorItemAlertCard(alert, fetchedAt = new Date().toISOString()) {
  const height = 246;
  const content = `<div class="card"><div class="header" style="height:70px">${shopIcon()}<div><div class="kicker">订阅命中 · 商店</div><div class="title" style="font-size:21px">${escapeHtml(alert.title)}</div></div><div class="header-meta"><span class="pill" style="color:${C.gold}">${escapeHtml(alert.vendorZh)}</span></div></div>
    <div class="alert-body" style="height:144px;padding:18px 20px 14px;display:grid;grid-template-columns:1fr 150px;gap:16px">
      <div><div style="display:flex;gap:7px;margin-bottom:11px"><span class="pill" style="color:${C.cyan}">${escapeHtml(alert.badge || '商店提醒')}</span></div>
        <div style="font-size:23px;font-weight:850;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(alert.itemName)}</div>
        <div style="font-size:11px;color:${C.dim};margin-top:6px">${escapeHtml(alert.note || '')}</div></div>
      <div style="border-left:1px solid #49535e;padding-left:16px;text-align:right;align-self:center">
        <div style="font-size:11px;color:${C.dim}">${escapeHtml(alert.rightLabel || '剩余时间')}</div>
        <div style="font-size:29px;line-height:40px;font-weight:900;font-variant-numeric:tabular-nums">${escapeHtml(alert.right || '')}</div></div></div>
    <div class="footer"><span>来源：商店轮换复现</span><span>订阅提醒 · 仅发送一次</span></div></div>`;
  return { html: documentShell(content, height), width: 600, height, key: `shop-alert-${alert.id || alert.itemName}-${String(fetchedAt).slice(0, 16)}` };
}
