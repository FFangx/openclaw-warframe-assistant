#!/usr/bin/env node

// bounty-card.mjs — 星球悬赏三张卡：总览 / 单区详情（奖励池展开）/ 奖励反查。
// 数据来自 bounties.mjs 装配输出，本文件只管画；样式复用 warframe-cards documentShell。

import { documentShell, escapeHtml } from './warframe-cards.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 集团徽记（genesis-assets sigils，键=place.key/board.key）；缺素材（实验室 Cavia）退通用图标
const SIGIL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'syndicates');
const SIGIL_DATA = {};
for (const key of ['cetus', 'fortuna', 'deimos', 'ZarimanSyndicate', 'HexSyndicate']) {
  try { SIGIL_DATA[key] = `data:image/png;base64,${readFileSync(path.join(SIGIL_DIR, `${key}.png`)).toString('base64')}`; } catch { SIGIL_DATA[key] = null; }
}

const C = { text: '#f3f5f7', sub: '#aeb9c4', dim: '#8f9aa6', green: '#67dfb8', gold: '#f0c765', cyan: '#72ded3', purple: '#c98add' };
const RARITY_COLOR = { Legendary: '#c98add', Rare: '#f0c765', Uncommon: '#9bb6d3', Common: '#8f9aa6' };
const RARITY_ZH = { Legendary: '传说', Rare: '稀有', Uncommon: '罕见', Common: '常见' };
// 敌人等级着色：低绿→高红（按下限分档）
const levelColor = (lo) => lo < 60 ? '#67dfb8' : lo < 90 ? '#9bb6d3' : lo < 110 ? '#f0c765' : '#ff6d78';

function countdownMs(ms) {
  const remaining = Math.max(0, ms - Date.now());
  const hours = Math.floor(remaining / 3600000);
  const minutes = Math.floor((remaining % 3600000) / 60000);
  return hours > 0 ? `${hours}时${String(minutes).padStart(2, '0')}分` : `${minutes}分`;
}

function bountyIcon(sigilKey = null) {
  if (sigilKey && SIGIL_DATA[sigilKey]) {
    return `<div class="brand-icon" style="display:grid;place-items:center"><img src="${SIGIL_DATA[sigilKey]}" width="44" height="44" style="object-fit:contain"></div>`;
  }
  return `<div class="brand-icon"><svg viewBox="0 0 24 24" fill="none" stroke="#f0c765" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/></svg></div>`;
}

function sectionBar(label, color, note = '') {
  return `<div class="section"><span class="section-badge" style="background:${color}">${escapeHtml(label)}</span>${note ? escapeHtml(note) : ''}<small></small></div>`;
}

// 任务行（总览用，40px）：任务名 + 等级/声望 + 顶奖
function jobRow(job, standingUnit) {
  const topText = job.top ? `${job.top.zh} ${job.top.chance}%` : '—';
  return `<div style="height:40px;display:grid;grid-template-columns:minmax(0,1fr) 210px;align-items:center;gap:8px;padding:0 16px;border-bottom:1px solid rgba(176,123,55,.24)">
    <div style="min-width:0;display:flex;align-items:center;gap:8px">
      ${job.isVault ? `<span class="pill" style="color:${C.purple};font-size:10px;height:18px;flex:0 0 auto">隔离库</span>` : ''}
      <span style="font-size:14px;font-weight:700;color:${C.text};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(job.zhTitle)}</span>
      <span style="flex:0 0 auto;font-size:11px;color:${C.dim};white-space:nowrap">Lv ${job.levels.join('-')}${job.totalStanding ? ` · ${job.totalStanding.toLocaleString('zh-CN')} ${standingUnit}` : ''}</span></div>
    <div style="text-align:right;font-size:12px;color:${RARITY_COLOR[job.top?.rarity] || C.dim};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(topText)}</div></div>`;
}

// ==== ① 索引卡：每区一行，细节全部分卡看（总览已拆，2026-08-06 用户拍板） ====
export function buildBountyIndexCard(data, fetchedAt = new Date().toISOString()) {
  const rowH = 56;
  const expiryMs = Date.parse(data.expiry);
  // 六区 expiry 实测恒同（同一个 2.5h 轮换钟）：与全局一致的行不重复显示倒计时，只在个别区偶发不同时才显示
  const rightOf = (expiry) => {
    const ms = Date.parse(expiry);
    if (!Number.isFinite(ms)) return '';
    return Number.isFinite(expiryMs) && Math.abs(ms - expiryMs) < 60_000 ? '' : countdownMs(ms);
  };
  const placeRows = data.places.map((place) => ({
    zh: place.zh, cmd: place.zh, planet: place.planet,
    summary: `${place.jobs.length} 个赏金 · 顶奖 ${[...new Set(place.jobs.map((job) => job.top?.zh).filter(Boolean))].slice(0, 3).join('、')}…`,
    right: rightOf(place.expiry),
    standing: place.standing || null,
  }));
  const boardRows = data.boards.map((board) => {
    const levelRange = board.nodes.filter((node) => node.levels).map((node) => node.levels);
    return {
      zh: board.zh, cmd: board.zh === '解剖圣所' ? '实验室' : board.zh, planet: board.planet,
      summary: `${board.nodes.length} 个挑战${levelRange.length ? ` · Lv ${levelRange[0][0]}~${levelRange.at(-1)[1]}` : ''}`,
      right: rightOf(board.expiry),
      standing: board.standing || null,
    };
  });
  // 声望列（仅用户私聊挂载 standing）：总声望+今日余量；与偶发倒计时共用右列
  const anyStanding = [...placeRows, ...boardRows].some((row) => row.standing);
  const anyRight = anyStanding || [...placeRows, ...boardRows].some((row) => row.right);
  const rightCell = (row) => {
    if (row.standing) {
      const daily = row.standing.daily != null ? `<div style="font-size:10px;color:${C.dim}">今日余量 ${row.standing.daily.toLocaleString('zh-CN')}</div>` : '';
      return `<div style="font-size:14px;font-weight:900;color:${C.green};font-variant-numeric:tabular-nums">${row.standing.standing.toLocaleString('zh-CN')}</div><div style="font-size:10px;color:${C.dim}">声望 · 等级 ${row.standing.title}</div>${daily}`;
    }
    return row.right ? `<div style="font-size:15px;font-weight:900;color:${C.cyan};font-variant-numeric:tabular-nums">${escapeHtml(row.right)}</div><div style="font-size:10px;color:${C.dim}">距轮换</div>` : '';
  };
  const rows = [...placeRows, ...boardRows].map((row, index) => `<div style="height:${rowH}px;display:grid;grid-template-columns:minmax(0,1fr)${anyRight ? ' 130px' : ''};align-items:center;padding:0 16px;border-bottom:1px solid rgba(176,123,55,.30);background:${index % 2 ? 'rgba(255,255,255,.035)' : 'rgba(255,255,255,.014)'}">
    <div style="min-width:0">
      <div style="display:flex;align-items:center;gap:8px">
        <b style="font-size:15px;white-space:nowrap">${escapeHtml(row.zh)}</b>
        <span style="flex:0 0 auto;font-size:11px;color:${C.dim}">${escapeHtml(row.planet)}</span>
        <span style="flex:0 0 auto;font-size:11px;color:${C.gold};font-weight:700">赏金 ${escapeHtml(row.cmd)}</span></div>
      <div style="margin-top:4px;font-size:12px;color:${C.dim};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(row.summary)}</div></div>
    ${anyRight ? `<div style="text-align:right">${rightCell(row)}</div>` : ''}</div>`).join('');
  const height = 84 + (placeRows.length + boardRows.length) * rowH + 32;
  const content = `<div class="card"><div class="header">${bountyIcon()}<div><div class="kicker">星球赏金 · 六区索引</div><div class="title">赏金总目录</div></div><div class="header-meta">${Number.isFinite(expiryMs) ? `<strong>${escapeHtml(countdownMs(expiryMs))} 后六区同时轮换</strong>` : ''}<span>发金色命令看全奖池</span></div></div>${rows}<div class="footer"><span>另可「赏金 物品名」反查哪个赏金出${anyStanding ? ' · 声望来自本机快照' : ''}</span><span>${escapeHtml(new Date(fetchedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }))}</span></div></div>`;
  return { html: documentShell(content, height), width: 600, height, key: `bounty-index4-${anyStanding ? 's' : anyRight ? 'r' : 'x'}-${String(fetchedAt).slice(0, 16)}` };
}

// ==== ② 单区详情卡：每任务奖池全展开（按物品合并，各阶段概率全列） ====
export function buildBountyPlaceCard(place, expiry, fetchedAt = new Date().toISOString()) {
  const anyIcon = place.jobs.some((job) => (job.rewardGroups || []).some((group) => group.iconDataUri));
  const sections = place.jobs.map((job) => {
    const groups = job.rewardGroups || [];
    const rows = groups.map((group) => {
      // 概率串：≤3 个逐阶段全列；更多（纳默池同物品 8 条）压缩成范围防溢出
      const chanceText = group.chances.length <= 3
        ? group.chances.map((chance) => `${chance}%`).join(' / ')
        : `${Math.min(...group.chances)}%~${Math.max(...group.chances)}% ×${group.chances.length}`;
      return `<div style="height:30px;display:flex;align-items:center;gap:8px;padding:0 16px 0 28px;border-bottom:1px solid rgba(176,123,55,.18)">
      <span style="flex:0 0 40px;font-size:11px;font-weight:800;color:${RARITY_COLOR[group.rarity] || C.dim}">${escapeHtml(RARITY_ZH[group.rarity] || group.rarity)}</span>
      ${anyIcon ? (group.iconDataUri ? `<img src="${group.iconDataUri}" style="flex:0 0 24px;width:24px;height:24px;object-fit:contain">` : '<div style="flex:0 0 24px"></div>') : ''}
      <span style="font-size:13px;color:${C.text};min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(group.zh)}</span>
      <span style="margin-left:auto;flex:0 0 auto;font-size:12px;color:${C.sub};font-variant-numeric:tabular-nums">${escapeHtml(chanceText)}</span></div>`;
    });
    return { header: jobRow(job, place.standingUnit), rows };
  });
  const bodyH = sections.reduce((sum, section) => sum + 40 + section.rows.length * 30, 0);
  const height = 84 + 34 + bodyH + 32;
  const expiryMs = Date.parse(expiry);
  const content = `<div class="card"><div class="header">${bountyIcon(place.key)}<div><div class="kicker">星球赏金 · ${escapeHtml(place.planet)}</div><div class="title">${escapeHtml(place.zh)}赏金</div></div><div class="header-meta">${Number.isFinite(expiryMs) ? `<strong>${escapeHtml(countdownMs(expiryMs))} 后轮换</strong>` : ''}<span>${escapeHtml(place.npc)} 发布</span></div></div>
    <div style="height:34px;display:flex;align-items:center;padding:0 16px;font-size:12px;color:${C.dim};border-bottom:1px solid #3d454f">共 ${place.jobs.length} 个赏金 · 奖池全部展开 · 概率按任务阶段从低到高全列</div>
    ${sections.map((section) => section.header + section.rows.join('')).join('')}
    <div class="footer"><span>任务/奖励：官方世界状态</span><span>${escapeHtml(new Date(fetchedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }))}</span></div></div>`;
  return { html: documentShell(content, height), width: 600, height, key: `bounty-place7-${place.key}-${anyIcon ? 'i' : 'x'}-${String(fetchedAt).slice(0, 16)}` };
}

// ==== ④ 挑战板详情卡：扎里曼/实验室/1999 每节点挑战 + 难度 + 描述（任务好不好做一眼看完） ====
export function buildBountyBoardCard(board, fetchedAt = new Date().toISOString()) {
  const rowH = 58;
  const rows = board.nodes.map((node, index) => `<div style="height:${rowH}px;display:grid;grid-template-columns:64px minmax(0,1fr) 150px;align-items:center;gap:8px;padding:0 16px;border-bottom:1px solid rgba(176,123,55,.30);background:${index % 2 ? 'rgba(255,255,255,.035)' : 'rgba(255,255,255,.014)'}">
    <div style="text-align:center">${node.levels ? `<div style="font-size:14px;font-weight:900;color:${levelColor(node.levels[0])};font-variant-numeric:tabular-nums">${node.levels[0]}-${node.levels[1]}</div><div style="font-size:9px;color:${C.dim}">敌人等级</div>` : `<span style="font-size:11px;color:${C.dim}">T${node.tier}</span>`}</div>
    <div style="min-width:0">
      <div style="display:flex;align-items:center;gap:8px">
        <b style="font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(node.challengeZh)}</b>
        ${node.ally ? `<span class="pill" style="color:${C.cyan};font-size:10px;height:18px;flex:0 0 auto">同伴 ${escapeHtml(node.ally)}</span>` : ''}</div>
      ${node.desc ? `<div style="margin-top:3px;font-size:11px;color:${C.dim};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(node.desc)}</div>` : ''}</div>
    <div style="text-align:right;font-size:12px;color:${C.sub};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(node.nodeMission || '')}${node.nodeName && node.nodeName !== node.node ? `<div style="font-size:10px;color:${C.dim}">${escapeHtml(node.nodeName)}</div>` : ''}</div></div>`).join('');
  const height = 84 + 34 + board.nodes.length * rowH + 32;
  const expiryMs = Date.parse(board.expiry);
  const content = `<div class="card"><div class="header">${bountyIcon(board.key)}<div><div class="kicker">赏金挑战板 · ${escapeHtml(board.planet)}</div><div class="title">${escapeHtml(board.zh)}赏金</div></div><div class="header-meta">${Number.isFinite(expiryMs) ? `<strong>${escapeHtml(countdownMs(expiryMs))} 后轮换</strong>` : ''}<span>${escapeHtml(board.npc)} 发布</span></div></div>
    <div style="height:34px;display:flex;align-items:center;padding:0 16px;font-size:12px;color:${C.dim};border-bottom:1px solid #3d454f">共 ${board.nodes.length} 个挑战 · 按档位从低到高排列 · 奖池固定不随轮换</div>
    ${rows}
    <div class="footer"><span>挑战：oracle 轮换数据 · 等级：官方固定档位表</span><span>${escapeHtml(new Date(fetchedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }))}</span></div></div>`;
  return { html: documentShell(content, height), width: 600, height, key: `bounty-board4-${board.key}-${String(fetchedAt).slice(0, 16)}` };
}

// ==== ⑤ 奖励反查卡：物品 → 哪些悬赏出 ====
export function buildBountyReverseCard(result, fetchedAt = new Date().toISOString()) {
  const rowH = 56;
  const anyIcon = result.hits.some((hit) => hit.iconDataUri);
  const gridCols = anyIcon ? '46px minmax(0,1fr) 120px' : 'minmax(0,1fr) 120px';
  const iconCell = (hit) => anyIcon
    ? (hit.iconDataUri ? `<div style="display:grid;place-items:center"><img src="${hit.iconDataUri}" style="width:40px;height:40px;object-fit:contain"></div>` : '<div></div>')
    : '';
  const rows = result.hits.map((hit, index) => `<div style="height:${rowH}px;display:grid;grid-template-columns:${gridCols};align-items:center;padding:0 16px;border-bottom:1px solid rgba(176,123,55,.30);background:${index % 2 ? 'rgba(255,255,255,.035)' : 'rgba(255,255,255,.014)'}">
    ${iconCell(hit)}<div style="min-width:0">
      <div style="display:flex;align-items:center;gap:8px">
        <b style="font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(hit.jobZh)}</b>
        ${hit.isVault ? `<span class="pill" style="color:${C.purple};font-size:10px;height:18px">隔离库</span>` : ''}
        <span style="flex:0 0 auto;font-size:11px;color:${C.dim}">Lv ${hit.levels.join('-')}</span></div>
      <div style="margin-top:4px;font-size:12px;color:${C.dim};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(hit.placeZh)} · ${escapeHtml(hit.npc)} · ${escapeHtml(hit.rewardZh)}</div></div>
    <div style="text-align:right"><div style="font-size:17px;font-weight:900;color:${RARITY_COLOR[hit.rarity] || C.text};font-variant-numeric:tabular-nums">${hit.chance}%</div><div style="font-size:10px;color:${C.dim}">${escapeHtml(RARITY_ZH[hit.rarity] || '')}</div></div></div>`).join('');
  const height = 84 + Math.max(result.hits.length, 1) * rowH + 32;
  const empty = `<div style="height:${rowH}px;display:flex;align-items:center;justify-content:center;color:${C.dim};font-size:14px">本轮赏金没有「${escapeHtml(result.query)}」——奖池 2.5 小时轮换，可「订阅 赏金 ${escapeHtml(result.query)}」蹲下轮</div>`;
  const expiryMs = Date.parse(result.expiry);
  const content = `<div class="card"><div class="header">${bountyIcon()}<div><div class="kicker">星球赏金 · 奖励反查</div><div class="title">${escapeHtml(result.query)}</div></div><div class="header-meta"><strong>${result.total || 0} 个赏金在出</strong>${Number.isFinite(expiryMs) ? `<span>${escapeHtml(countdownMs(expiryMs))} 后轮换</span>` : ''}</div></div>${rows || empty}<div class="footer"><span>概率为奖池标注值 · 按概率降序</span><span>${escapeHtml(new Date(fetchedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }))}</span></div></div>`;
  return { html: documentShell(content, height), width: 600, height, key: `bounty-where5-${result.query}-${anyIcon ? 'i' : 'x'}-${String(fetchedAt).slice(0, 16)}` };
}
