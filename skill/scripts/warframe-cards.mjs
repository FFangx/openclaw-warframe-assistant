import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ERA = {
  Lith: { zh: '古纪', color: '#c39a55' },
  Meso: { zh: '前纪', color: '#66c58f' },
  Neo: { zh: '中纪', color: '#e89a4c' },
  Axi: { zh: '后纪', color: '#e06161' },
  Requiem: { zh: '安魂', color: '#c14956' },
  Omnia: { zh: '全能', color: '#57a1ff' },
};
const PLANET_ZH = {
  Mercury: '水星', Venus: '金星', Earth: '地球', Lua: '月球', Mars: '火星', Deimos: '火卫二',
  Phobos: '火卫一', Ceres: '谷神星', Jupiter: '木星', Europa: '欧罗巴', Saturn: '土星',
  Uranus: '天王星', Neptune: '海王星', Pluto: '冥王星', Eris: '阋神星', Sedna: '赛德娜',
  Void: '虚空', Zariman: '扎里曼', 'Kuva Fortress': '赤毒要塞', Duviri: '双衍王境',
};

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
  .replace(/"/gu, '&quot;').replace(/'/gu, '&#39;');
export { escapeHtml };

// 货币图标：官方素材（assets/currency，与 AlecaFrame 同源）base64 内嵌，零外部引用；
// 素材缺失时退回纯文字单位，卡片不至于渲染失败
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const ASSET_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'currency');
const CURRENCY_DATA = {};
for (const [kind, file] of [['ducat', 'ducats.png'], ['plat', 'platinum.png'], ['credit', 'credits.png'],
  ['aya', 'aya.webp'], ['regalAya', 'regalAya.webp'], ['steelEssence', 'SteelEssence.webp'], ['endo', 'endo.png'], ['riftPlasm', 'riftPlasm.png']]) {
  const mime = file.endsWith('.webp') ? 'image/webp' : 'image/png';
  try { CURRENCY_DATA[kind] = `data:${mime};base64,${readFileSync(path.join(ASSET_DIR, file)).toString('base64')}`; } catch { CURRENCY_DATA[kind] = null; }
}
// 官方译名：Aya=阿耶精华、Regal Aya=御品阿耶精华（灰机 wiki 2026-08-04 用户指正）
const CURRENCY_FALLBACK_TEXT = { ducat: '杜', plat: 'p', credit: '银', aya: ' 阿耶精华', regalAya: ' 御品阿耶精华', steelEssence: ' 钢铁精华', endo: ' 内融核心', riftPlasm: ' 裂罅碎块' };

// icon+数字行内组合；数字颜色默认跟货币色系
// inline-flex 居中：旧版 vertical-align 负偏移在小字号下 icon 与数字高低不齐（紫卡卡用户实锤）
const CURRENCY_COLOR = { ducat: '#f0c765', plat: '#cfe4f0', credit: '#8ab8ec', aya: '#d8c9a3', regalAya: '#e8b4c8', steelEssence: '#c96a4a', endo: '#8fd3e8', riftPlasm: '#c98add' };
export function currency(kind, value, { size = 13, color, weight = 900 } = {}) {
  const text = typeof value === 'number' ? value.toLocaleString('zh-CN') : String(value);
  const icon = CURRENCY_DATA[kind]
    ? `<img src="${CURRENCY_DATA[kind]}" width="${size}" height="${size}" style="flex:0 0 auto">`
    : '';
  const unit = icon ? '' : ` ${CURRENCY_FALLBACK_TEXT[kind]}`;
  return `<span style="display:inline-flex;align-items:center;gap:3px;vertical-align:middle;white-space:nowrap">${icon}<span style="color:${color || CURRENCY_COLOR[kind]};font-weight:${weight};font-variant-numeric:tabular-nums">${escapeHtml(text)}${unit}</span></span>`;
}

function localTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未知';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

// 奸商到离横跨多天，时间必须带日期（「离开 21:00」没日期会误导）
function localDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未知';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

function countdown(value) {
  const milliseconds = Math.max(0, Date.parse(value) - Date.now());
  const totalSeconds = Math.floor(milliseconds / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  // 超过一天的倒计时用天/时表达，39:59:59 这种大时数可读性差
  if (days > 0) return `${days}天${hours}时`;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

// 截止类时间：24 小时内显示时刻，更远显示剩余天数，避免「05:50 截止」被误读成今天
function deadlineText(value) {
  const remainingMs = Date.parse(value) - Date.now();
  if (!Number.isFinite(remainingMs)) return '未知';
  if (remainingMs > 24 * 60 * 60 * 1000) return `${Math.floor(remainingMs / 86400000)} 天后`;
  return localTime(value);
}

function sourceLabel(value) {
  const source = String(value || '').toLowerCase();
  if (source.includes('browse.wf') && source.includes('warframestat')) return '世界状态＋仲裁排期';
  if (source.includes('browse.wf')) return '仲裁排期';
  if (source.includes('market')) return '星际战甲市场';
  if (source.includes('wfcd')) return '遗物资料';
  return '世界状态';
}

// 世界状态类型图标（游戏同款徽记，源=WFCD genesis-assets，2026-08-06 用户拍板上卡）：缺素材退回 SVG/色块字
export const WORLDSTATE_ICON_DATA = {};
for (const name of ['alert', 'arbitration', 'fissure', 'invasion', 'sortie', 'incursion', 'event', 'baro', 'darvo', 'syndicate']) {
  try { WORLDSTATE_ICON_DATA[name] = `data:image/png;base64,${readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'worldstate', `${name}.png`)).toString('base64')}`; } catch { WORLDSTATE_ICON_DATA[name] = null; }
}

function headerIcon(kind) {
  // 类型专属徽记优先；无对应素材的 kind（target/weekly/radar/relic）走原 SVG
  if (WORLDSTATE_ICON_DATA[kind]) {
    return `<div class="brand-icon"><img src="${WORLDSTATE_ICON_DATA[kind]}" style="max-width:34px;max-height:34px;object-fit:contain"></div>`;
  }
  if (kind === 'fissure') {
    return `<div class="brand-icon"><svg viewBox="0 0 24 24" fill="none" stroke="#4fc3f7" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12,2 20,12 12,22 4,12"/><polyline points="12,5 10,10 13,14 11,19"/></svg></div>`;
  }
  if (kind === 'target') {
    return `<div class="brand-icon"><svg viewBox="0 0 24 24" fill="none" stroke="#f5c451" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="7"/><line x1="12" y1="1.5" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22.5"/><line x1="1.5" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22.5" y2="12"/><circle cx="12" cy="12" r="1.5" fill="#f5c451" stroke="none"/></svg></div>`;
  }
  if (kind === 'weekly') {
    return `<div class="brand-icon"><svg viewBox="0 0 24 24" fill="none" stroke="#75dcca" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="17" rx="2"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="3" y1="9" x2="21" y2="9"/><polyline points="7,15 10,18 17,12"/></svg></div>`;
  }
  return `<div class="brand-icon"><svg viewBox="0 0 24 24" fill="none" stroke="#8ab4f8" stroke-width="2.5" stroke-linecap="round"><circle cx="6" cy="18" r="2" fill="#8ab4f8" stroke="none"/><path d="M6 12a6 6 0 0 1 6 6"/><path d="M6 6a12 12 0 0 1 12 12"/><line x1="7.5" y1="16.5" x2="16" y2="8"/></svg></div>`;
}

export function documentShell(content, height, width = 600) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:#111419}
  body{font-family:"Microsoft YaHei UI","Microsoft YaHei",Arial,sans-serif;color:#f3f5f7}
  .card{position:relative;width:${width}px;height:${height}px;overflow:hidden;background:radial-gradient(circle at 84% -15%,rgba(92,139,180,.16),transparent 42%),linear-gradient(145deg,#20242a 0%,#171b20 58%,#1d2026 100%);border:1px solid #3c434c}
  .card:after{content:"";position:absolute;inset:0;pointer-events:none;opacity:.035;background-image:linear-gradient(rgba(255,255,255,.35) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.35) 1px,transparent 1px);background-size:28px 28px}
  .header,.section,.f-row,.footer,.alert-body,.intel-row{position:relative;z-index:1}
  .header{height:84px;padding:15px 20px 13px;display:flex;align-items:center;border-bottom:1px solid #59636f;background:linear-gradient(90deg,rgba(28,34,40,.98),rgba(25,29,35,.82))}
  .brand-icon{width:38px;height:38px;margin-right:12px;display:grid;place-items:center;flex:0 0 38px}.brand-icon svg{width:30px;height:30px;overflow:visible}.brand-icon *{vector-effect:non-scaling-stroke}
  .kicker{font-size:11px;line-height:14px;letter-spacing:1.5px;color:#72ded3;font-weight:800}.title{font-size:25px;line-height:31px;font-weight:850;letter-spacing:.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .header-meta{margin-left:auto;text-align:right}.header-meta strong{display:block;font-size:13px;color:#dfe6ec}.header-meta span{font-size:11px;color:#8f9aa6}
  .section{height:30px;padding:6px 14px 5px;display:flex;align-items:center;background:#293039;border-bottom:1px solid #48525d;font-size:12px;font-weight:800;color:#dce3e8}.section-badge{padding:2px 7px;margin-right:7px;border-radius:4px;background:#56616d;color:#fff}.section small{margin-left:auto;color:#8f9aa6;font-weight:500}
  .f-row{height:62px;display:grid;grid-template-columns:46px 110px minmax(0,1fr) 108px;align-items:center;padding:0 14px;border-bottom:1px solid rgba(176,123,55,.42);background:rgba(255,255,255,.014)}.f-row:nth-child(odd){background:rgba(255,255,255,.035)}
  .era{width:34px;height:34px;border-radius:7px;display:grid;place-items:center;color:#13171b;font-size:11px;font-weight:900;line-height:11px;text-align:center}.era small{display:block;font-size:8px}.mission{font-size:15px;font-weight:800}.mission small{display:block;margin-top:2px;font-size:9px;font-weight:600;color:#8f9aa6}
  .place{min-width:0}.place strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:16px}.place span{display:block;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:#8f9aa6}
  .time{text-align:right;font-size:17px;font-weight:850;font-variant-numeric:tabular-nums;color:#eef1f4}.time small{display:block;font-size:9px;color:#7f8b97;font-weight:600;letter-spacing:.5px}.time.urgent{color:#ff6d78}
  .footer{height:32px;padding:8px 13px;display:flex;justify-content:space-between;border-top:1px solid #3d454f;color:#85919d;font-size:10px}.pill{display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:5px;font-size:11px;font-weight:800;border:1px solid currentColor;background:rgba(255,255,255,.04)}
  </style></head><body>${content}</body></html>`;
}

// 纪元遗物图标（对齐沃沃裂缝卡设计）：本地资产 base64 内嵌；全能无官方遗物实体，用虚空光体（精炼资源）图标代指（2026-08-06 用户拍板）
export const RELIC_ICON_DATA = {};
for (const [tier, file] of [['Lith', 'lith.png'], ['Meso', 'meso.png'], ['Neo', 'neo.png'], ['Axi', 'axi.png'], ['Requiem', 'requiem.png'], ['Omnia', 'omnia.webp']]) {
  const mime = file.endsWith('.webp') ? 'image/webp' : 'image/png';
  try { RELIC_ICON_DATA[tier] = `data:${mime};base64,${readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'relics', file)).toString('base64')}`; } catch { RELIC_ICON_DATA[tier] = null; }
}
try { RELIC_ICON_DATA.Vanguard = `data:image/webp;base64,${readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'currency', 'aya.webp')).toString('base64')}`; } catch { RELIC_ICON_DATA.Vanguard = null; }

function fissureRow(item, data) {
  const era = ERA[item.tier] || { zh: '未知纪元', color: '#8995a1' };
  const remainingMs = Date.parse(item.expiry) - Date.now();
  const urgent = remainingMs > 0 && remainingMs < 15 * 60 * 1000;
  const eraCell = RELIC_ICON_DATA[item.tier]
    ? `<div style="width:38px;text-align:center"><img src="${RELIC_ICON_DATA[item.tier]}" width="30" height="30" style="object-fit:contain"><div style="font-size:9px;font-weight:800;color:${era.color};line-height:9px">${escapeHtml(era.zh)}</div></div>`
    : `<div class="era" style="background:${era.color}">${escapeHtml(era.zh)}</div>`;
  const tagColors = { speed: '#57c98b', comfort: '#8ab8ec', endless: '#c39ae8', bonus: '#f0c765' };
  const tags = (item.tags || []).map((tag) => `<span style="display:inline-flex;align-items:center;height:16px;padding:0 5px;margin-right:4px;border:1px solid ${tagColors[tag.key] || '#8f9aa6'};border-radius:4px;color:${tagColors[tag.key] || '#8f9aa6'};font-size:9px;font-weight:800">${escapeHtml(tag.zh)}</span>`).join('');
  const rec = item.recommendation;
  const recValue = !rec ? ''
    : rec.targetEconomy
      ? ` · 期望 ${currency('ducat', rec.targetEconomy.expectedDucats || 0, { size: 9 })} / ${currency('plat', rec.targetEconomy.expectedPlat || 0, { size: 9 })}`
      : data.recommendationModeZh === '杜卡德'
        ? ` · 期望 ${currency('ducat', rec.expectedDucats || 0, { size: 9 })}`
        : ` · 期望 ${currency('plat', rec.expectedValue || 0, { size: 9 })}`;
  const recText = rec?.relic
    ? `<b style="color:#75dcca">推荐 ${escapeHtml(rec.relic.zh)} ×${escapeHtml(rec.relic.count)}</b> · <b style="color:${rec.relic.vaulted ? '#d7a46d' : '#8ee3ad'}">${rec.relic.vaulted ? '已入库' : '未入库'}</b>${recValue}${rec.refineZh ? ` · <b style="color:#e8a5c0">${escapeHtml(rec.refineZh)}</b>` : ''}`
    : '<span style="color:#7f8b97">未匹配库存遗物</span>';
  return `<div class="f-row">${eraCell}<div class="mission">${escapeHtml(item.mission)}<small>${item.hard ? '钢铁' : '普通'} · ${escapeHtml(item.faction)}</small></div><div class="place"><strong>${escapeHtml(item.planet)} · ${escapeHtml(item.node)}</strong><span>${tags}${data.personalized ? recText : ''}</span></div><div class="time${urgent ? ' urgent' : ''}">${escapeHtml(countdown(item.expiry))}<small>${urgent ? '即将结束' : '剩余时间'}</small></div></div>`;
}

export function buildFissureQueryCard(data) {
  const sections = [];
  if (data.normal?.length) sections.push({ label: '普通', color: '#56616d', rows: data.normal, total: data.normalTotal ?? data.normal.length });
  if (data.hard?.length) sections.push({ label: '钢铁', color: '#536f8f', rows: data.hard, total: data.hardTotal ?? data.hard.length });
  const rowsCount = sections.reduce((sum, section) => sum + section.rows.length, 0);
  const height = 84 + sections.length * 30 + rowsCount * 62 + 32;
  const body = sections.map((section) => `<div class="section"><span class="section-badge" style="background:${section.color}">${section.label}</span>${section.label === '钢铁' ? '钢铁之路裂缝' : '普通虚空裂缝'}<small>${section.total} 条</small></div>${section.rows.map((row) => fissureRow(row, data)).join('')}`).join('');
  const shown = rowsCount;
  const total = sections.reduce((sum, section) => sum + section.total, 0);
  const content = `<div class="card"><div class="header">${headerIcon('fissure')}<div><div class="kicker">虚空裂缝 · 全任务雷达</div><div class="title">${escapeHtml(data.title || '当前虚空裂缝')}</div></div><div class="header-meta"><strong>${data.personalized ? `库存推荐 · ${escapeHtml(data.recommendationModeZh || '白金')}` : '公开任务'}</strong><span>${escapeHtml(localTime(data.fetchedAt))}</span></div></div>${body}<div class="footer"><span>普通/钢铁分区 · 速刷/舒适/长线/额外收益标签${data.personalized ? ' · 每条裂缝推荐一枚库存遗物 · 估值=可靠成交中位' : ''}</span><span>显示 ${shown}/${total}</span></div></div>`;
  const keySeed = `fissure|v6|${data.key || 'all'}|${data.personalized ? data.recommendationModeZh || 'personal' : 'public'}|${sections.flatMap((section) => section.rows).map((row) => `${row.id}:${row.recommendation?.relic?.base || ''}`).join('|')}`;
  return { html: documentShell(content, height, 800), width: 800, height, key: `fissure-${createHash('sha1').update(keySeed).digest('hex').slice(0, 12)}` };
}

export function buildFissureAlertCard(item, condition, fetchedAt = new Date().toISOString()) {
  const era = ERA[item.tier] || { zh: item.tier || '未知', color: '#57a1ff' };
  // 纪元徽标与查询卡统一：遗物实体图标+纪元色文字；无素材（全能）退纯 pill
  const eraBadge = RELIC_ICON_DATA[item.tier]
    ? `<span style="display:inline-flex;align-items:center;gap:5px"><img src="${RELIC_ICON_DATA[item.tier]}" width="24" height="24" style="object-fit:contain"><span class="pill" style="color:${era.color}">${escapeHtml(era.zh)}</span></span>`
    : `<span class="pill" style="color:${era.color}">${escapeHtml(era.zh)}</span>`;
  const height = 246;
  const content = `<div class="card"><div class="header" style="height:70px">${headerIcon(item.hard ? 'incursion' : 'fissure')}<div><div class="kicker">订阅命中 · ${item.hard ? '钢铁之路' : '虚空裂缝'}</div><div class="title" style="font-size:21px">${item.hard ? '钢铁虚空裂缝' : '虚空裂缝提醒'}</div></div><div class="header-meta">${item.recommended ? '<span class="pill" style="color:#f0c765">★ 推荐</span>' : ''}</div></div><div class="alert-body" style="height:144px;padding:18px 20px 14px;display:grid;grid-template-columns:1fr 150px;gap:16px"><div><div style="display:flex;align-items:center;gap:7px;margin-bottom:11px">${eraBadge}<span class="pill" style="color:#e98a79">${escapeHtml(item.mission)}</span>${item.hard ? '<span class="pill" style="color:#9bb6d3">钢铁</span>' : ''}</div><div style="font-size:25px;font-weight:850;white-space:nowrap">${escapeHtml(item.planet)} · ${escapeHtml(item.node)}</div><div style="font-size:11px;color:#8995a1;margin-top:6px">${escapeHtml(item.faction)} · 命中条件：${escapeHtml(condition)}</div></div><div style="border-left:1px solid #49535e;padding-left:16px;text-align:right;align-self:center"><div style="font-size:11px;color:#8995a1">剩余时间</div><div style="font-size:31px;line-height:42px;font-weight:900;font-variant-numeric:tabular-nums">${escapeHtml(countdown(item.expiry))}</div><div style="font-size:10px;color:#75dcca">仍在开放</div></div></div><div class="footer"><span>来源：世界状态</span><span>订阅提醒 · 仅发送一次</span></div></div>`;
  return { html: documentShell(content, height), width: 600, height, key: `fissure-alert3-${item.id || `${item.node}-${item.expiry}`}-${fetchedAt}` };
}

// 仲裁场地评级徽章（browse.wf 社区评级）：S 金 / A 绿 / 其余灰；无评级返回空串
function arbyTierPill(tier) {
  if (!tier) return '';
  const color = /^S/u.test(tier) ? '#f0c765' : /^A/u.test(tier) ? '#67dfb8' : '#8f9aa6';
  return `<span class="pill" style="color:${color}">场地 ${escapeHtml(tier)} 级</span>`;
}

export function buildArbitrationAlertCard(item, condition, fetchedAt = new Date().toISOString()) {
  const height = 246;
  const content = `<div class="card"><div class="header" style="height:70px">${headerIcon('arbitration')}<div><div class="kicker">订阅命中 · 仲裁</div><div class="title" style="font-size:21px">仲裁轮换提醒</div></div><div class="header-meta"><span class="pill" style="color:#f0a766">整点轮换</span></div></div><div class="alert-body" style="height:144px;padding:18px 20px 14px;display:grid;grid-template-columns:1fr 150px;gap:16px"><div><div style="display:flex;gap:7px;margin-bottom:11px"><span class="pill" style="color:#f0a766">仲裁</span><span class="pill" style="color:#e98a79">${escapeHtml(item.mission || '未知任务')}</span>${arbyTierPill(item.arbyTier)}</div><div style="font-size:25px;font-weight:850;white-space:nowrap">${escapeHtml(item.planet)} · ${escapeHtml(item.node)}</div><div style="font-size:11px;color:#8995a1;margin-top:6px">${escapeHtml(item.enemy || '当前轮换')} · 命中条件：${escapeHtml(condition)}</div></div><div style="border-left:1px solid #49535e;padding-left:16px;text-align:right;align-self:center"><div style="font-size:11px;color:#8995a1">剩余时间</div><div style="font-size:31px;line-height:42px;font-weight:900;font-variant-numeric:tabular-nums">${escapeHtml(countdown(item.expiry))}</div><div style="font-size:10px;color:#75dcca">下个整点轮换</div></div></div><div class="footer"><span>来源：${escapeHtml(sourceLabel(item.source))}</span><span>订阅提醒 · 仅发送一次</span></div></div>`;
  return { html: documentShell(content, height), width: 600, height, key: `arbitration-alert2-${item.id || `${item.node}-${item.expiry}`}-${fetchedAt}` };
}

// 「几点几分」补充倒计时：沪时区，当天/次日给「今天/明天」前缀，更远的直接给日期
function localDayHM(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const hm = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  const dayOf = (d) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' }).format(d);
  const day = dayOf(date);
  const prefix = day === dayOf(new Date()) ? '今天' : day === dayOf(new Date(Date.now() + 86_400_000)) ? '明天' : day;
  return `${prefix} ${hm}`;
}

export function buildArbitrationQueryCard(item, fetchedAt = new Date().toISOString()) {
  // 预告区（对齐沃沃）：下个仲裁 + 下个 S/A 高效场地；数据缺失时预告区整体不显示
  const nextRows = [];
  if (item.next) nextRows.push({ label: '下个仲裁', entry: item.next, color: '#aeb9c4' });
  if (item.nextTop) nextRows.push({ label: `下个高效（${item.nextTop.tier} 级）`, entry: item.nextTop, color: /^S/u.test(item.nextTop.tier) ? '#f0c765' : '#67dfb8' });
  const forecast = nextRows.length ? nextRows.map(({ label, entry, color }) => `
    <div style="height:44px;display:grid;grid-template-columns:150px minmax(0,1fr) 116px;align-items:center;padding:0 20px;border-top:1px solid rgba(176,123,55,.30)">
      <div style="font-size:12px;color:${color};font-weight:800">${escapeHtml(label)}</div>
      <div style="font-size:13px;color:#dfe6ec;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><b>${escapeHtml(entry.mission)}</b> · ${escapeHtml(entry.planet)} ${escapeHtml(entry.node)}${entry.tier ? ` <span style="color:${/^S/u.test(entry.tier) ? '#f0c765' : /^A/u.test(entry.tier) ? '#67dfb8' : '#8f9aa6'};font-weight:800">[${escapeHtml(entry.tier)}]</span>` : ''}</div>
      <div style="text-align:right"><div style="font-size:14px;font-weight:850;font-variant-numeric:tabular-nums;color:${color}">${escapeHtml(countdown(entry.activation))}后</div><div style="font-size:10px;color:#8f9aa6;font-variant-numeric:tabular-nums">${escapeHtml(localDayHM(entry.activation))}</div></div>
    </div>`).join('') : '';
  const height = 246 + nextRows.length * 44;
  const source = sourceLabel(item.source);
  const content = `<div class="card"><div class="header" style="height:70px">${headerIcon('arbitration')}<div><div class="kicker">仲裁 · 当前轮换</div><div class="title" style="font-size:21px">当前仲裁</div></div><div class="header-meta"><span class="pill" style="color:#f0a766">整点轮换</span></div></div><div class="alert-body" style="height:144px;padding:18px 20px 14px;display:grid;grid-template-columns:1fr 150px;gap:16px"><div><div style="display:flex;gap:7px;margin-bottom:11px"><span class="pill" style="color:#f0a766">仲裁</span><span class="pill" style="color:#e98a79">${escapeHtml(item.mission || '未知任务')}</span>${arbyTierPill(item.arbyTier)}</div><div style="font-size:25px;font-weight:850;white-space:nowrap">${escapeHtml(item.planet)} · ${escapeHtml(item.node)}</div><div style="font-size:11px;color:#8995a1;margin-top:6px">${escapeHtml(item.enemy || '当前轮换')} · 当前可用${item.arbyTier ? ' · 场地评级来自社区数据' : ''}</div></div><div style="border-left:1px solid #49535e;padding-left:16px;text-align:right;align-self:center"><div style="font-size:11px;color:#8995a1">剩余时间</div><div style="font-size:31px;line-height:42px;font-weight:900;font-variant-numeric:tabular-nums">${escapeHtml(countdown(item.expiry))}</div><div style="font-size:10px;color:#75dcca">${escapeHtml(localDayHM(item.expiry))} 轮换</div></div></div>${forecast}<div class="footer"><span>来源：${escapeHtml(source)}</span><span>${escapeHtml(localTime(fetchedAt))}</span></div></div>`;
  return { html: documentShell(content, height), width: 600, height, key: `arbitration-query4-${item.id || `${item.node}-${item.expiry}`}-${nextRows.length}-${fetchedAt}` };
}

// 今日突击：三段任务竖排（任务/节点/词缀）；查询与订阅推送共用，condition 仅推送时有
export function buildSortieCard(item, fetchedAt = new Date().toISOString(), condition = '') {
  const rowH = 64;
  const height = 70 + 44 + rowH * (item.variants?.length || 0) + 20 + 34;
  const localized = (node) => String(node || '未知节点').replace(/^(.*?)\s*\(([^)]+)\)$/u, (_, name, planet) => `${name}（${PLANET_ZH[planet] || planet}）`);
  const stages = (item.variants || []).map((variant, index) => `
    <div style="height:${rowH}px;display:grid;grid-template-columns:34px minmax(0,1fr);gap:12px;align-items:center;border-bottom:1px solid rgba(176,123,55,.30)">
      <div style="width:28px;height:28px;border-radius:8px;display:grid;place-items:center;border:1.5px solid #c98add;color:#c98add;font-size:14px;font-weight:900">${index + 1}</div>
      <div style="min-width:0">
        <div style="display:flex;align-items:baseline;gap:10px"><b style="font-size:16px">${escapeHtml(variant.mission)}</b><span style="font-size:13px;color:#aeb9c4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(localized(variant.node))}</span></div>
        <div style="margin-top:3px;font-size:12px;color:#e0b56a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(variant.modifier)}</div></div></div>`).join('');
  const content = `<div class="card"><div class="header" style="height:70px">${headerIcon('sortie')}<div><div class="kicker">${condition ? '订阅命中 · 突击' : '突击 · 每日轮换'}</div><div class="title" style="font-size:21px">今日突击</div></div><div class="header-meta"></div></div>
    <div style="padding:10px 20px 0;height:${44 + rowH * (item.variants?.length || 0)}px">
      <div style="height:34px;display:flex;align-items:center;gap:10px"><span class="pill" style="color:#c98add">${escapeHtml(item.faction || '未知阵营')}</span><span style="font-size:12px;color:#c98add;font-weight:800">首领 ${escapeHtml(item.boss || '未知')}</span><span style="font-size:12px;color:#8995a1">完成三段获得突击奖励</span><span style="margin-left:auto;font-size:13px;color:#75dcca;font-weight:800">剩余 ${escapeHtml(countdown(item.expiry))}</span></div>
      ${stages}</div>
    <div class="footer" style="margin-top:14px"><span>来源：世界状态</span><span>${condition ? escapeHtml(condition) : escapeHtml(localTime(fetchedAt))}</span></div></div>`;
  return { html: documentShell(content, height), width: 600, height, key: `sortie3-${item.id || item.expiry}-${condition ? 'push' : String(fetchedAt).slice(0, 16)}` };
}

// 今日钢铁侵袭：六节点竖排（任务/节点/阵营）；查询与订阅推送共用，condition 仅推送时有
export function buildIncursionCard(item, fetchedAt = new Date().toISOString(), condition = '') {
  const rowH = 52;
  const nodes = item.nodes || [];
  const height = 70 + 44 + rowH * nodes.length + 20 + 34;
  const rows = nodes.map((node, index) => `
    <div style="height:${rowH}px;display:grid;grid-template-columns:34px 150px minmax(0,1fr) 88px;gap:12px;align-items:center;border-bottom:1px solid rgba(176,123,55,.30)">
      <div style="width:28px;height:28px;border-radius:8px;display:grid;place-items:center;border:1.5px solid #9bb6d3;color:#9bb6d3;font-size:14px;font-weight:900">${index + 1}</div>
      <div style="white-space:nowrap"><b style="font-size:16px">${escapeHtml(node.mission)}</b>${node.levels ? `<span style="margin-left:6px;font-size:12px;color:#e0b56a;font-variant-numeric:tabular-nums">${escapeHtml(node.levels)}</span>` : ''}</div>
      <span style="font-size:13px;color:#aeb9c4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(node.planet)} · ${escapeHtml(node.node)}</span>
      <span style="text-align:right;font-size:12px;color:#8995a1;white-space:nowrap">${escapeHtml(node.faction)}</span>
    </div>`).join('');
  const content = `<div class="card"><div class="header" style="height:70px">${headerIcon('incursion')}<div><div class="kicker">${condition ? '订阅命中 · 钢铁侵袭' : '钢铁之路 · 每日侵袭'}</div><div class="title" style="font-size:21px">今日钢铁侵袭</div></div><div class="header-meta"><span class="pill" style="color:#9bb6d3">每节点 +5 钢铁精华</span></div></div>
    <div style="padding:10px 20px 0;height:${44 + rowH * nodes.length}px">
      <div style="height:34px;display:flex;align-items:center;gap:10px"><span class="pill" style="color:#9bb6d3">${nodes.length} 个节点</span><span style="font-size:12px;color:#8995a1">北京时间 08:00 轮换</span><span style="margin-left:auto;font-size:13px;color:#75dcca;font-weight:800">剩余 ${escapeHtml(countdown(item.expiry))}</span></div>
      ${rows}</div>
    <div class="footer" style="margin-top:14px"><span>来源：侵袭排期</span><span>${condition ? escapeHtml(condition) : escapeHtml(localTime(fetchedAt))}</span></div></div>`;
  return { html: documentShell(content, height), width: 600, height, key: `incursion3-${item.id || item.expiry}-${condition ? 'push' : String(fetchedAt).slice(0, 16)}` };
}

function intelPresentation(item) {
  const localizedNode = String(item.node || '未知节点').replace(/^(.*?)\s*\(([^)]+)\)$/u, (_, node, planet) => `${PLANET_ZH[planet] || planet} · ${node}`);
  const subscription = item.subscriptionDetail ? `订阅：${item.subscriptionDetail}` : '';
  if (item.type === 'fissure') return { mark: '裂', icon: RELIC_ICON_DATA[item.tier] || null, color: item.hard ? '#87a8c8' : '#66d6cc', title: item.hard ? '钢铁裂缝' : '虚空裂缝', place: `${item.planet || ''} · ${item.node || ''}`, desc: [item.mission, ERA[item.tier]?.zh || item.tier, subscription].filter(Boolean).join(' · '), right: countdown(item.expiry), sub: '剩余时间' };
  if (item.type === 'arbitration') return { mark: '仲', icon: WORLDSTATE_ICON_DATA.arbitration, color: '#f0a766', title: '仲裁轮换', place: `${item.planet || ''} · ${item.node || ''}`, desc: [item.mission, item.enemy, item.arbyTier ? `场地 ${item.arbyTier} 级` : '', subscription].filter(Boolean).join(' · '), right: countdown(item.expiry), sub: '剩余时间' };
  if (item.type === 'sortie') return { mark: '突', icon: WORLDSTATE_ICON_DATA.sortie, color: '#c98add', title: '今日突击', place: `${item.boss || '未知首领'}（${item.faction || '未知阵营'}）`, desc: [(item.variants || []).map((variant) => variant.mission).join(' → '), subscription].filter(Boolean).join(' · '), right: countdown(item.expiry), sub: '距每日刷新' };
  if (item.type === 'incursion') return { mark: '袭', icon: WORLDSTATE_ICON_DATA.incursion, color: '#9bb6d3', title: '钢铁侵袭', place: `今日 ${(item.nodes || []).length} 个侵袭节点`, desc: [(item.nodes || []).map((node) => node.mission).join(' · '), subscription].filter(Boolean).join(' · '), right: countdown(item.expiry), sub: '距每日刷新' };
  if (item.type === 'bounty') {
    const matched = String(item.matchedTarget || '').trim();
    return {
      mark: '赏', icon: WORLDSTATE_ICON_DATA.syndicate, color: '#d8c9a3', title: '赏金命中',
      place: [matched, item.placeZh].filter(Boolean).join(' · ') || item.jobZh || '赏金奖励',
      desc: [item.jobZh, `Lv ${(item.levels || []).join('-')}`, item.topReward ? `奖池代表奖励：${item.topReward}` : '', subscription].filter(Boolean).join(' · '),
      right: countdown(item.expiry), sub: '距奖池轮换',
    };
  }
  if (item.type === 'rotation') return { mark: '轮', color: '#c9b8dd', title: '轮换到点', place: item.label || '轮换提醒', desc: ['一次性提醒已自动取消', subscription].filter(Boolean).join(' · '), right: '已开始', sub: '本周/当期' };
  if (item.type === 'invasion') return { mark: '侵', icon: WORLDSTATE_ICON_DATA.invasion, color: '#edaa55', title: item.rare ? '稀有入侵' : '普通入侵', place: localizedNode, desc: [item.description || item.text, subscription].filter(Boolean).join(' · '), right: `${Math.max(0, Math.min(100, Math.round(Number(item.completion) || 0)))}%`, sub: '争夺进度', bar: Math.max(0, Math.min(100, Number(item.completion) || 0)) };
  if (item.type === 'alert') return { mark: '警', icon: WORLDSTATE_ICON_DATA.alert, color: '#f0c765', title: '新警报', place: localizedNode, desc: [item.mission, item.reward, subscription].filter(Boolean).join(' · '), right: deadlineText(item.expiry), sub: '截止时间' };
  if (item.type === 'trader') {
    const active = item.active !== false;
    return { mark: '商', icon: WORLDSTATE_ICON_DATA.baro, color: '#58d7cb', title: '虚空商人', place: item.location || '未知中继站', desc: [active ? '已抵达中继站' : '尚未抵达', subscription].filter(Boolean).join(' · '), right: countdown(active ? item.expiry : item.activation), sub: active ? '距离离开' : '距离到达' };
  }
  if (item.type === 'shop') return { mark: '店', color: '#f0c765', title: '商店周货', place: `${item.vendorZh || '商店'}：${item.itemName || '本期货单'}`, desc: [item.closing, subscription].filter(Boolean).join(' · '), right: countdown(item.expiry), sub: '距轮换' };
  if (item.type === 'vendor-item') return { mark: '货', color: '#f0c765', title: '商品上架', place: item.itemName || '订阅商品', desc: [item.vendorZh, item.note, subscription].filter(Boolean).join(' · '), right: countdown(item.expiry), sub: '货架剩余' };
  return { mark: '事', icon: WORLDSTATE_ICON_DATA.event, color: '#ff6d78', title: '特殊活动', place: item.description || '未命名活动', desc: [item.detail || '活动已经开始', subscription].filter(Boolean).join(' · '), right: deadlineText(item.expiry), sub: '截止时间' };
}

export function buildIntelCard(data) {
  const visible = data.items.slice(0, 5).map(intelPresentation);
  // 入侵专属：双舰建造进度窄条（游戏内入侵面板同款信息；constructionProgress 全局值非逐入侵）
  const construction = data.construction || null;
  const constructionBar = construction ? (() => {
    const seg = (label, pct, color) => {
      const clamped = Math.max(0, Math.min(100, Math.round(pct * 10) / 10));
      return `<div style="display:flex;align-items:center;gap:8px;min-width:0"><span style="flex:0 0 auto;font-size:11px;color:#aeb9c4">${escapeHtml(label)}</span><div style="flex:1;height:4px;background:#3b424b;border-radius:2px;min-width:60px"><i style="display:block;width:${clamped}%;height:4px;background:${color};border-radius:2px"></i></div><b style="flex:0 0 auto;font-size:12px;color:${color};font-variant-numeric:tabular-nums">${clamped}%</b></div>`;
    };
    return `<div style="height:34px;display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:center;padding:0 16px;border-bottom:1px solid rgba(176,123,55,.40);background:rgba(255,255,255,.02)">${seg('Grineer 巨人战舰', construction.fomorian, '#e98a79')}${seg('Corpus 利刃豺狼', construction.razorback, '#9bb6d3')}</div>`;
  })() : '';
  const height = 86 + (constructionBar ? 34 : 0) + Math.max(visible.length, 1) * 86 + 32;
  const rows = visible.map((item, index) => `<div class="intel-row" style="height:86px;display:grid;grid-template-columns:48px minmax(0,1fr) 104px;align-items:center;padding:10px 16px;border-bottom:1px solid rgba(176,123,55,.40);background:${index % 2 ? 'rgba(255,255,255,.035)' : 'rgba(255,255,255,.014)'}">${item.icon ? `<div style="width:34px;height:34px;display:grid;place-items:center"><img src="${item.icon}" width="32" height="32" style="object-fit:contain"></div>` : `<div style="width:34px;height:34px;border-radius:9px;display:grid;place-items:center;background:${item.color};color:#14181d;font-size:17px;font-weight:900">${item.mark}</div>`}<div style="min-width:0"><div style="display:flex;align-items:center;gap:8px"><b style="font-size:13px;color:${item.color}">${item.title}</b><span style="font-size:16px;font-weight:820;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(item.place)}</span></div><div style="font-size:11px;color:#8995a1;margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(item.desc)}</div>${item.bar != null ? `<div style="margin-top:7px;width:210px;height:3px;background:#3b424b;border-radius:2px"><i style="display:block;width:${item.bar}%;height:3px;background:${item.color};border-radius:2px"></i></div>` : ''}</div><div style="text-align:right"><div style="font-size:20px;font-weight:900;color:${item.color};font-variant-numeric:tabular-nums">${escapeHtml(item.right)}</div><div style="font-size:10px;color:#7f8b97;margin-top:2px">${item.sub}</div></div></div>`).join('');
  const empty = `<div style="height:86px;display:grid;place-items:center;border-bottom:1px solid rgba(176,123,55,.40);color:#8995a1;font-size:15px">${escapeHtml(data.emptyText || '当前没有可显示的情报')}</div>`;
  const content = `<div class="card"><div class="header" style="height:86px">${headerIcon('radar')}<div><div class="kicker">星际战甲情报 · 情报雷达</div><div class="title">${escapeHtml(data.title || `重要情报 · ${data.items.length} 条更新`)}</div></div><div class="header-meta"><strong style="color:#7adfd4">刚刚刷新</strong><span>${data.query ? '当前状态' : '仅推送新变化'}</span></div></div>${constructionBar}${rows || empty}<div class="footer"><span>来源：${escapeHtml(sourceLabel(data.source))}</span><span>${data.items.length > visible.length ? `显示 ${visible.length}/${data.items.length}` : escapeHtml(localTime(data.fetchedAt))}</span></div></div>`;
  const queryMinute = data.query ? String(data.fetchedAt || '').slice(0, 16) : '';
  const keySeed = `intel-v5|${data.title || ''}|${data.items.map((item) => item.id).join('|')}|${construction ? `c${construction.fomorian}-${construction.razorback}` : ''}|${queryMinute}`;
  return { html: documentShell(content, height), width: 600, height, key: `intel-${createHash('sha1').update(keySeed).digest('hex').slice(0, 12)}` };
}

export function buildWeeklyCard(data) {
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const completed = tasks.filter((task) => task.done).length;
  const height = 92 + tasks.length * 56 + 34;
  const reset = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(data.nextReset));
  const rows = tasks.map((task, index) => {
    const color = task.done ? '#67dfb8' : '#7f8b97';
    const background = index % 2 ? 'rgba(255,255,255,.035)' : 'rgba(255,255,255,.014)';
    return `<div class="weekly-row" style="position:relative;z-index:1;height:56px;display:grid;grid-template-columns:44px minmax(0,1fr) 76px;align-items:center;padding:0 16px;border-bottom:1px solid rgba(176,123,55,.38);background:${background}"><div style="width:28px;height:28px;border-radius:7px;display:grid;place-items:center;border:1px solid ${color};color:${color};font-size:13px;font-weight:900">${task.number}</div><div style="min-width:0"><div style="font-size:15px;font-weight:820;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:${task.done ? '#eef5f2' : '#f2f4f6'}">${escapeHtml(task.name)}</div><div style="margin-top:3px;font-size:10px;color:#8995a1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(task.detail || task.hint || '')}</div></div><div style="text-align:right;color:${color};font-size:14px;font-weight:850">${task.done ? '✓ 已完成' : '○ 待完成'}</div></div>`;
  }).join('');
  const progress = tasks.length ? Math.round((completed / tasks.length) * 100) : 0;
  const content = `<div class="card"><div class="header" style="height:92px">${headerIcon('weekly')}<div style="min-width:0"><div class="kicker">星际战甲 · 周常清单</div><div class="title" style="font-size:23px">${escapeHtml(data.ownerName || '玩家')} 的本周进度</div><div style="margin-top:5px;width:250px;height:4px;border-radius:3px;background:#39414a"><i style="display:block;width:${progress}%;height:4px;border-radius:3px;background:#67dfb8"></i></div></div><div class="header-meta"><strong style="font-size:20px;color:#75dcca">${completed}/${tasks.length}</strong><span>${escapeHtml(reset)} 重置</span></div></div>${rows}<div class="footer" style="height:34px"><span>${data.worldStateAvailable ? '轮换：公共世界状态 · 完成度：本地记录' : '轮换暂不可用 · 完成度：本地记录'}</span><span>完成 1 3｜撤销 3</span></div></div>`;
  const keySeed = `${data.ownerName}|${data.weekStart}|${tasks.map((task) => `${task.id}:${task.done}:${task.detail}`).join('|')}`;
  return { html: documentShell(content, height), width: 600, height, key: `weekly-${createHash('sha1').update(keySeed).digest('hex').slice(0, 12)}` };
}

// 周常一图流：每项任务自带本周轮换详情，800px 宽，2 倍分辨率渲染
export function buildWeeklyDetailCard(data) {
  const width = 800;
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const completed = tasks.filter((task) => task.done).length;
  const rowHeights = tasks.map((task) => 46 + (task.detailLines?.length || 0) * 24 + 12);
  const height = 100 + rowHeights.reduce((sum, value) => sum + value, 0) + 38;
  const reset = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(data.nextReset));
  const rows = tasks.map((task, index) => {
    const color = task.done ? '#67dfb8' : '#8f9aa6';
    const detail = (task.detailLines || []).map((line) => `<div style="font-size:13px;line-height:24px;color:#aeb9c4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(line)}</div>`).join('');
    return `<div style="position:relative;z-index:1;height:${rowHeights[index]}px;padding:8px 22px 4px;border-bottom:1px solid rgba(176,123,55,.38);background:${index % 2 ? 'rgba(255,255,255,.035)' : 'rgba(255,255,255,.014)'}"><div style="display:grid;grid-template-columns:40px minmax(0,1fr) 96px;align-items:center;height:38px"><div style="width:30px;height:30px;border-radius:8px;display:grid;place-items:center;border:1.5px solid ${color};color:${color};font-size:14px;font-weight:900">${task.number}</div><div style="font-size:17px;font-weight:850;color:${task.done ? '#eef5f2' : '#f2f4f6'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(task.name)}</div><div style="text-align:right;color:${color};font-size:14px;font-weight:850">${task.done ? '✓ 已完成' : '○ 待完成'}</div></div><div style="padding-left:40px">${detail}</div></div>`;
  }).join('');
  const progress = tasks.length ? Math.round((completed / tasks.length) * 100) : 0;
  const content = `<div class="card"><div class="header" style="height:100px">${headerIcon('weekly')}<div style="min-width:0"><div class="kicker">星际战甲 · 周常详细清单</div><div class="title" style="font-size:26px">本周周常 · 轮换与进度</div><div style="margin-top:6px;width:320px;height:5px;border-radius:3px;background:#39414a"><i style="display:block;width:${progress}%;height:5px;border-radius:3px;background:#67dfb8"></i></div></div><div class="header-meta"><strong style="font-size:22px;color:#75dcca">${completed}/${tasks.length}</strong><span>${escapeHtml(reset)} 重置</span></div></div>${rows}<div class="footer" style="height:38px;padding:11px 16px"><span>${data.worldStateAvailable ? '轮换：公共世界状态 · 完成度：本地记录' : '轮换暂不可用 · 完成度：本地记录'}</span><span>完成 1 3｜撤销 3｜清空周常</span></div></div>`;
  const keySeed = `${data.weekStart}|${tasks.map((task) => `${task.id}:${task.done}:${(task.detailLines || []).join(';')}`).join('|')}`;
  return { html: documentShell(content, height, width), width, height, scale: 2, key: `weekly-detail-${createHash('sha1').update(keySeed).digest('hex').slice(0, 12)}` };
}

// 玩家浮印头图（个人三卡：账号/库存/掉落）：有 glyph 用图，退回对应 SVG
function glyphOrIcon(glyphDataUri, fallbackKind) {
  if (glyphDataUri) return `<div class="brand-icon"><img src="${glyphDataUri}" style="width:36px;height:36px;border-radius:9px;object-fit:cover"></div>`;
  return headerIcon(fallbackKind);
}

export function buildAccountSnapshotCard(data) {
  const metrics = Array.isArray(data.metrics) ? data.metrics : [];
  const rows = [];
  for (let index = 0; index < metrics.length; index += 2) rows.push(metrics.slice(index, index + 2));
  const height = 92 + rows.length * 76 + 68;
  // 数值渲染三态：currencyKind=官方货币图标（用 CURRENCY_COLOR 配套色，禁二次转义）/ iconDataUri=商店货币（metric.color 贴图标主体色）/ 纯数字列交替色
  const metricValue = (metric, columnIndex) => {
    const fallback = columnIndex ? '#f0c765' : '#75dcca';
    if (metric.currencyKind) return currency(metric.currencyKind, metric.value, { size: 22, weight: 900 });
    if (metric.iconDataUri) return `<span style="display:inline-flex;align-items:center;gap:6px"><img src="${metric.iconDataUri}" width="26" height="26" style="object-fit:contain"><span style="color:${metric.color || fallback};font-weight:900;font-variant-numeric:tabular-nums">${escapeHtml(metric.value)}</span></span>`;
    return `<span style="color:${metric.color || fallback}">${escapeHtml(metric.value)}</span>`;
  };
  const body = rows.map((pair, rowIndex) => `<div style="position:relative;z-index:1;height:76px;display:grid;grid-template-columns:1fr 1fr;gap:0;border-bottom:1px solid rgba(176,123,55,.38);background:${rowIndex % 2 ? 'rgba(255,255,255,.035)' : 'rgba(255,255,255,.014)'}">${pair.map((metric, columnIndex) => `<div style="padding:14px 22px;${columnIndex ? 'border-left:1px solid #3d4650' : ''}"><div style="font-size:11px;color:#8d99a5">${escapeHtml(metric.label)}</div><div style="margin-top:4px;font-size:24px;font-weight:900;font-variant-numeric:tabular-nums">${metricValue(metric, columnIndex)}</div></div>`).join('')}${pair.length === 1 ? '<div></div>' : ''}</div>`).join('');
  const content = `<div class="card"><div class="header" style="height:92px">${glyphOrIcon(data.glyphDataUri, 'weekly')}<div><div class="kicker">个人数据 · 本机只读</div><div class="title" style="font-size:23px">${escapeHtml(data.title || '我的账号状态')}</div></div><div class="header-meta"><strong style="color:#75dcca">仅用户私聊</strong><span>账号快照</span></div></div>${body}<div style="position:relative;z-index:1;height:36px;padding:10px 16px;color:#aeb7bf;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(data.footnote || '')}</div><div class="footer"><span>来源：本机账号快照</span><span>${escapeHtml(localTime(data.syncedAt))}</span></div></div>`;
  const keySeed = `account-v3|${data.title}|${data.syncedAt}|${data.glyphDataUri ? 'g' : 'x'}|${metrics.map((metric) => `${metric.label}:${metric.value}:${metric.iconDataUri ? 'i' : 'x'}`).join('|')}`;
  return { html: documentShell(content, height), width: 600, height, key: `account-${createHash('sha1').update(keySeed).digest('hex').slice(0, 12)}` };
}

export function buildInventorySnapshotCard(data) {
  const rows = Array.isArray(data.rows) ? data.rows.slice(0, 15) : [];
  const height = 92 + Math.max(rows.length, 1) * 52 + 34;
  // 有任一行带图就全列留图位（查无留空 div 对齐，奸商卡同款）
  const anyIcon = rows.some((item) => item.iconDataUri);
  const iconCell = (item) => item.iconDataUri
    ? `<div style="display:grid;place-items:center"><img src="${item.iconDataUri}" style="width:36px;height:36px;object-fit:contain"></div>`
    : '<div></div>';
  // 价格列宽=最长内容宽（用户 2026-08-06 定稿）：整列贴右、列内左对齐——
  // 最长数字行右缘顶齐，其余行 icon 与它同一起点竖向成列。行是独立 grid 不共享列宽，JS 统一估算。
  // 估宽：tabular-nums 16px/900 数字≈9.3px/字符，中文≈16px；plat 行再加 icon 14+gap 3
  const textWidth = (text) => [...String(text ?? '')].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e7f ? 16 : 9.3), 0);
  const cellWidth = (item) => item.plat != null
    ? 14 + 3 + textWidth((item.plat >= 100 ? Math.round(item.plat) : item.plat).toLocaleString('zh-CN'))
    : textWidth(item.value);
  const valueColW = Math.min(130, Math.max(56, Math.ceil(Math.max(...rows.map(cellWidth), 0)) + 4));
  const gridCols = anyIcon ? `44px minmax(0,1fr) ${valueColW}px` : `minmax(0,1fr) ${valueColW}px`;
  // 右列内部左对齐：icon 钉在列首竖向成列，数字长短随意向右延伸（「对齐=列对齐」老教训）
  const valueCell = (item) => item.plat != null
    ? `<div style="font-size:16px;font-weight:900">${currency('plat', item.plat >= 100 ? Math.round(item.plat) : item.plat, { size: 14, color: '#75dcca' })}</div><div style="font-size:10px;color:#8995a1;margin-top:2px">${escapeHtml(item.value || '')}</div>`
    : `<span style="color:#75dcca;font-size:16px;font-weight:900;font-variant-numeric:tabular-nums">${escapeHtml(item.value)}</span>`;
  const body = rows.length ? rows.map((item, index) => `<div style="position:relative;z-index:1;height:52px;display:grid;grid-template-columns:${gridCols};align-items:center;padding:0 16px;border-bottom:1px solid rgba(176,123,55,.38);background:${index % 2 ? 'rgba(255,255,255,.035)' : 'rgba(255,255,255,.014)'}">${anyIcon ? iconCell(item) : ''}<div style="min-width:0;padding-right:8px"><div style="font-size:15px;font-weight:820;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(item.name)}</div><div style="margin-top:3px;font-size:10px;color:${item.detailColor || '#8995a1'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(item.detail || '')}</div></div><div style="text-align:left">${valueCell(item)}</div></div>`).join('') : '<div style="position:relative;z-index:1;height:52px;display:grid;place-items:center;color:#8995a1">没有找到本地记录</div>';
  const shown = rows.length;
  const total = Number(data.totalMatches) || shown;
  // header 右上：有总估值给白金 icon 数字，否则沿用「N 个」计数
  const headerStrong = data.totalPlat != null
    ? `${currency('plat', data.totalPlat, { size: 15, color: '#75dcca' })} <span style="font-size:11px;color:#8d99a5">估值</span>`
    : `${escapeHtml(data.totalCount || 0)} ${escapeHtml(data.countUnit || '个')}`;
  const content = `<div class="card"><div class="header" style="height:92px">${glyphOrIcon(data.glyphDataUri, 'weekly')}<div style="min-width:0"><div class="kicker">${escapeHtml(data.subtype || '个人库存')} · 本机只读</div><div class="title" style="font-size:23px">${escapeHtml(data.title || '我的库存')}</div></div><div class="header-meta"><strong style="color:#75dcca">${headerStrong}</strong><span>匹配 ${escapeHtml(total)} 项</span></div></div>${body}<div class="footer" style="height:34px"><span>来源：本机账号快照${data.totalPlat != null ? ' · 估值=可靠成交中位' : ''}</span><span>${total > shown ? `显示 ${shown}/${total}` : escapeHtml(localTime(data.syncedAt))}</span></div></div>`;
  const keySeed = `inv-v10|${data.title}|${data.syncedAt}|${data.glyphDataUri ? 'g' : 'x'}|${data.totalPlat ?? ''}|${rows.map((item) => `${item.name}:${item.value}:${item.plat ?? ''}:${item.detail}:${item.iconDataUri ? 'i' : 'x'}`).join('|')}`;
  return { html: documentShell(content, height), width: 600, height, key: `inventory-${createHash('sha1').update(keySeed).digest('hex').slice(0, 12)}` };
}

// 杜卡德兑换方案：库存安全余量 × 杜卡德固定值 × 白金机会成本
export function buildDucatPlanCard(data) {
  const allRows = Array.isArray(data.rows) ? data.rows : [];
  const rows = allRows.slice(0, 15);
  const rowH = 72;
  const height = 90 + 32 + Math.max(rows.length, 1) * rowH + 36;
  const modeTitle = data.mode === 'target' ? `目标 ${escapeHtml(data.target)} 杜卡德`
    : data.mode === 'clearance' ? '安全清仓方案' : '优先兑换推荐';
  const smartReserve = !data.reserveExplicit && data.reserveSets == null;
  const reserveMeta = `<span>${smartReserve ? '智能保留' : escapeHtml(data.reserveLabel)}</span>`;
  const headerMeta = data.mode === 'target'
    ? `<strong>${currency('ducat', data.target, { size: 14 })} 目标</strong>${reserveMeta}`
    : `<strong>${currency('ducat', data.totalDucats, { size: 14 })} 可兑换</strong>${reserveMeta}`;
  const sectionText = data.complete
    ? `本次 ${currency('ducat', data.totalDucats, { size: 12 })} · 白金机会成本约 ${currency('plat', data.totalPlat, { size: 12, color: '#75dcca' })}`
    : `可靠估值候选可换 ${currency('ducat', data.totalDucats, { size: 12 })} · <strong style="color:#e0513c">还差 ${currency('ducat', data.shortfall, { size: 12, color: '#e0513c', weight: 850 })}</strong>`;
  const body = rows.length ? rows.map((row, index) => {
    const iconCell = row.iconDataUri
      ? `<div style="width:40px;height:40px;border-radius:8px;display:grid;place-items:center;background:rgba(255,255,255,.07);overflow:hidden"><img src="${row.iconDataUri}" style="max-width:36px;max-height:36px;object-fit:contain"></div>`
      : '<div></div>';
    const basis = row.marketBasis === 'today' ? '今日中位' : '90日中位';
    const median = currency('plat', row.unitPlat, { size: 10, color: '#a9d7e4', weight: 760 });
    const dailyVolume = row.dailyVolume == null ? '日均—' : `日均 ${escapeHtml(row.dailyVolume)} 件`;
    const reserveTone = row.reserveState === 'owned'
      ? { color: '#75dcca', bg: 'rgba(117,220,202,.13)', border: 'rgba(117,220,202,.42)' }
      : row.reserveState === 'unowned'
        ? { color: '#f0c765', bg: 'rgba(240,199,101,.12)', border: 'rgba(240,199,101,.40)' }
        : { color: '#d9a66f', bg: 'rgba(217,166,111,.12)', border: 'rgba(217,166,111,.40)' };
    const reserveBadge = row.reserveReason
      ? `<span style="display:inline-block;margin-left:4px;padding:1px 5px;border:1px solid ${reserveTone.border};border-radius:4px;background:${reserveTone.bg};color:${reserveTone.color};font-weight:800">${escapeHtml(row.reserveReason)}</span>`
      : '';
    return `<div style="position:relative;z-index:1;height:${rowH}px;display:grid;grid-template-columns:46px minmax(0,1fr) 72px 126px;align-items:center;padding:0 16px;border-bottom:1px solid rgba(176,123,55,.40);background:${index % 2 ? 'rgba(255,255,255,.035)' : 'rgba(255,255,255,.014)'}">
      ${iconCell}
      <div style="min-width:0;padding-left:8px"><div style="font-size:14px;font-weight:830;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(row.name)}</div><div style="margin-top:3px;font-size:10px;color:#8995a1;white-space:nowrap">库存 ×${escapeHtml(row.owned)} · 保留 ×${escapeHtml(row.reserve)}${reserveBadge}</div><div style="margin-top:3px;font-size:9px;color:#7f8b97;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${basis}${row.marketStatsStale ? '（缓存）' : ''} ${median} · ${dailyVolume}</div></div>
      <div style="text-align:center"><div style="font-size:10px;color:#8995a1">兑换</div><div style="margin-top:3px;color:#75dcca;font-size:17px;font-weight:900;font-variant-numeric:tabular-nums">×${escapeHtml(row.exchangeQty)}</div></div>
      <div style="padding-left:8px"><div style="font-size:15px">${currency('ducat', `+${row.totalDucats}`, { size: 14 })}</div><div style="margin-top:3px;font-size:11px">${currency('plat', `−${row.totalPlat}`, { size: 11, color: '#a9d7e4', weight: 760 })}<span style="margin-left:4px;color:#6f7b86">机会成本</span></div></div>
    </div>`;
  }).join('') : '<div style="position:relative;z-index:1;height:62px;display:grid;place-items:center;color:#8995a1;font-size:13px">没有符合保留规则、且带可靠行情的多余 Prime 部件</div>';
  const shown = rows.length;
  const content = `<div class="card"><div class="header" style="height:90px">${glyphOrIcon(data.glyphDataUri, 'baro')}<div style="min-width:0"><div class="kicker">个人库存 · 安全模式</div><div class="title" style="font-size:23px">${modeTitle}</div></div><div class="header-meta">${headerMeta}</div></div>
    <div class="section"><span class="section-badge">${escapeHtml(shown)} 项</span>${sectionText}<small>机会成本=可靠成交中位</small></div>
    ${body}
    <div class="footer" style="height:36px;font-size:9px"><span>命令：杜卡德 600｜杜卡德 清仓｜杜卡德 清仓 保留1</span><span>${allRows.length > shown ? `显示 ${shown}/${allRows.length}` : escapeHtml(localTime(data.syncedAt || data.fetchedAt))}</span></div></div>`;
  // 名称来自会独立更新的 Aleca 游戏目录。缓存键必须包含名称，否则目录纠正译名后
  // 仍会复用同一物品路径对应的旧图片，造成“数量/图标正确、名称串到旧物品”的假象。
  const keySeed = `ducat-plan-v8|${data.mode}|${data.target}|${data.reserveLabel}|${data.syncedAt}|${allRows.map((row) => `${row.uniqueName}:${row.name}:${row.englishName || ''}:${row.exchangeQty}:${row.unitPlat}:${row.reserve}:${row.reserveState || ''}`).join('|')}`;
  return { html: documentShell(content, height), width: 600, height, key: `ducat-plan-${createHash('sha1').update(keySeed).digest('hex').slice(0, 12)}` };
}

// 掉落提醒卡：账号快照同步后新入库的物品，含数量与当前卖单价
// 开遗物卡：遗物双币期望与任务偏好分开展示，不把主观体验混进价值数字。
export function buildFissureRecommendCard(data) {
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const acquireRows = Array.isArray(data.acquireRows) ? data.acquireRows : [];
  const shownRelicCount = new Set(rows.map((row) => row.relic?.base).filter(Boolean)).size;
  const ducatMode = data.mode === 'ducat';
  const ducatGoal = ducatMode ? data.ducatGoal : null;
  const preference = data.preference || 'balanced';
  const preferenceZh = { balanced: '综合', speed: '速刷', comfort: '舒适', yield: '收益' }[preference] || '综合';
  const fissureScope = data.fissureScope || 'all';
  const fissureScopeZh = fissureScope === 'steel' ? '仅钢铁' : '全部裂缝';
  const vaultFilter = data.vaultFilter || 'all';
  const vaultFilterZh = { all: '全部遗物', unvaulted: '未入库', vaulted: '已入库' }[vaultFilter] || '全部遗物';
  const tagColors = { speed: '#57c98b', comfort: '#8ab8ec', endless: '#c39ae8', bonus: '#f0c765' };
  const rowH = 64;
  const acquireRowH = 62;
  const acquireH = ducatGoal ? 30 + Math.max(acquireRows.length, 1) * acquireRowH : 0;
  const height = 84 + 30 + Math.max(rows.length, 1) * rowH + acquireH + 32;
  const body = rows.map((row, index) => {
    const era = ERA[row.tier] || { zh: row.tierZh || '未知', color: '#8995a1' };
    const remainingMs = Date.parse(row.expiry) - Date.now();
    const urgent = remainingMs > 0 && remainingMs < 15 * 60 * 1000;
    // 纪元列与裂缝查询卡同款：遗物实体图标，无素材（全能）退彩色文字块
    const eraCell = RELIC_ICON_DATA[row.tier]
      ? `<div style="width:38px;text-align:center"><img src="${RELIC_ICON_DATA[row.tier]}" width="30" height="30" style="object-fit:contain"><div style="font-size:9px;font-weight:800;color:${era.color};line-height:9px">${escapeHtml(era.zh)}</div></div>`
      : `<div class="era" style="background:${era.color}">${escapeHtml(era.zh)}</div>`;
    const flags = [row.hard ? '<span style="color:#e0513c;font-weight:800">钢铁</span>' : '', row.storm ? '<span style="color:#57a1ff;font-weight:800">九重天</span>' : ''].filter(Boolean).join(' ');
    const tags = (row.tags || []).slice(0, 2).map((tag) => `<span style="display:inline-flex;align-items:center;height:16px;padding:0 5px;border:1px solid ${tagColors[tag.key] || '#8f9aa6'};border-radius:4px;color:${tagColors[tag.key] || '#8f9aa6'};font-size:9px;font-weight:800">${escapeHtml(tag.zh)}</span>`).join(' ');
    // 两种模式统一使用「重点奖励」；所有币值都走图标＋数字组件。
    const refineFixed = row.refineZh ? `<b style="color:#e8a5c0">建议${escapeHtml(row.refineZh)}</b>` : '';
    const vaultState = `<span style="color:${row.relic.vaulted ? '#d7a46d' : '#8ee3ad'};font-weight:800">${row.relic.vaulted ? '已入库' : '未入库'}</span>`;
    const rewardDetail = ducatMode
      ? ducatGoal
        ? `每局期望 ${currency('ducat', row.targetEconomy?.expectedDucats || 0, { size: 10 })} / ${currency('plat', row.targetEconomy?.expectedPlat || 0, { size: 10 })} · 效率 ${escapeHtml(row.targetEconomy?.efficiency ?? '—')} 杜/p`
        : `${escapeHtml(row.topDucat?.zhName || '—')} ${currency('ducat', row.topDucat?.ducats || 0, { size: 10 })}`
      : `${escapeHtml(row.topReward?.zhName || '—')} ${currency('plat', row.topReward?.price || 0, { size: 10 })}`;
    const value = ducatMode
      ? ducatGoal
        ? `<div style="font-size:16px">约 ${escapeHtml(row.targetEconomy?.expectedRuns ?? '—')} 局</div><div style="font-size:10px;color:#7f8b97">${refineFixed}${refineFixed ? ' · ' : ''}同类重复约 ${currency('plat', row.targetEconomy?.opportunityPlat ?? 0, { size: 9 })}</div>`
        : `<div style="font-size:16px">期望 ${currency('ducat', row.expectedDucats, { size: 14 })}</div><div style="font-size:10px;color:#7f8b97">${currency('plat', row.expectedValue, { size: 10 })}${refineFixed ? ` · ${refineFixed}` : ''}</div>`
      : `<div style="font-size:16px">期望 ${currency('plat', row.expectedValue, { size: 14 })}</div><div style="font-size:10px;color:#7f8b97">${currency('ducat', row.expectedDucats, { size: 10 })}${refineFixed ? ` · ${refineFixed}` : ''}</div>`;
    return `<div style="position:relative;z-index:1;height:${rowH}px;display:grid;grid-template-columns:30px 46px minmax(0,1fr) 180px 80px;align-items:center;padding:0 14px;border-bottom:1px solid rgba(176,123,55,.42);background:${index % 2 ? 'rgba(255,255,255,.035)' : 'rgba(255,255,255,.014)'}">
      <div style="font-size:17px;font-weight:900;color:${index < 3 ? '#f0c765' : '#8f9aa6'}">${index + 1}</div>
      ${eraCell}
      <div style="min-width:0"><div style="font-size:15px;font-weight:820;display:flex;align-items:center;gap:5px;white-space:nowrap;overflow:hidden"><span style="overflow:hidden;text-overflow:ellipsis;color:#75dcca">${escapeHtml(row.relic.zh)} ×${escapeHtml(row.relic.count)}</span>${vaultState}</div>
        <div style="margin-top:3px;font-size:10px;color:#8f9aa6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">路线 ${escapeHtml(row.missionZh)} · ${escapeHtml(row.planet)} ${escapeHtml(row.node)} ${flags}${tags ? ` ${tags}` : ''}｜${rewardDetail}</div></div>
      <div style="text-align:right">${value}</div>
      <div class="time${urgent ? ' urgent' : ''}" style="text-align:right">${escapeHtml(countdown(row.expiry))}<small>${urgent ? '即将结束' : '剩余'}</small></div>
    </div>`;
  }).join('');
  const empty = `<div style="position:relative;z-index:1;height:64px;display:grid;place-items:center;color:#8995a1;font-size:14px">${ducatGoal ? '库存中暂无达到保本线且能立即开的遗物' : '当前没有能配上库存遗物的裂缝'}</div>`;
  const acquireBody = acquireRows.map((row, index) => {
    const sources = (row.sources || []).map((source) => `${escapeHtml(source.place)} ${escapeHtml(Math.round(Number(source.chance || 0) * 10) / 10)}%`).join(' · ');
    const refine = row.refineZh ? `建议${escapeHtml(row.refineZh)}` : '';
    return `<div style="position:relative;z-index:1;height:${acquireRowH}px;display:grid;grid-template-columns:30px 150px minmax(0,1fr) 150px;align-items:center;padding:0 14px;border-bottom:1px solid rgba(176,123,55,.42);background:${index % 2 ? 'rgba(255,255,255,.035)' : 'rgba(255,255,255,.014)'}">
      <div style="font-size:16px;font-weight:900;color:${index < 3 ? '#f0c765' : '#8f9aa6'}">${index + 1}</div>
      <div style="font-size:14px;font-weight:820;color:#75dcca">${escapeHtml(row.relic.zh)}</div>
      <div style="min-width:0"><div style="font-size:10px;color:#cfd6dc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${sources || '当前掉落表查无常规来源'}</div><div style="margin-top:3px;font-size:10px;color:#8f9aa6">每局期望 ${currency('ducat', row.targetEconomy?.expectedDucats || 0, { size: 9 })} / ${currency('plat', row.targetEconomy?.expectedPlat || 0, { size: 9 })} · 效率 ${escapeHtml(row.targetEconomy?.efficiency ?? '—')} 杜/p</div></div>
      <div style="text-align:right;font-size:14px;font-weight:800">约 ${escapeHtml(row.targetEconomy?.expectedRuns ?? '—')} 局<div style="font-size:9px;color:#8f9aa6">${refine} · 补齐约 ${currency('plat', row.targetEconomy?.opportunityPlat ?? 0, { size: 9 })}</div></div>
    </div>`;
  }).join('');
  const acquireEmpty = '<div style="position:relative;z-index:1;height:62px;display:grid;place-items:center;color:#8995a1;font-size:13px">暂无未拥有、当前可获取且达到保本线的遗物</div>';
  const requiemNote = data.requiem ? `安魂 ${data.requiem.fissures} 条 · 库存 ${data.requiem.relics}｜` : '';
  const modeZh = ducatMode ? '赚杜卡德' : '赚白金';
  const squadZh = ducatGoal ? '自己携带遗物' : ((data.squad ?? 4) > 1 ? `${data.squad ?? 4}人组队取最优` : '单人');
  const preferenceNote = preference === 'speed' ? '每枚优先匹配捕获/歼灭' : preference === 'comfort' ? '每枚优先匹配防御/生存' : preference === 'yield' ? '每枚优先匹配九重天→钢铁→无尽' : '遗物按期望收益；每枚最多两条路线';
  const title = ducatGoal ? `为「${escapeHtml(ducatGoal.name)}」开什么遗物` : ducatMode ? '现在换杜卡德开什么最赚' : '现在开什么遗物最值';
  const targetSummary = ducatGoal
    ? `对标 ${currency('ducat', ducatGoal.ducats, { size: 10 })} / ${currency('plat', ducatGoal.marketPlat, { size: 10 })} · 盈亏线 1p≈${escapeHtml(ducatGoal.ducatsPerPlat)}杜 · ${ducatGoal.marketBasis === 'today' ? '今日中位' : '90天中位'} · 日均 ${escapeHtml(ducatGoal.dailyVolume ?? '—')} · ${fissureScopeZh}`
    : `筛选：${fissureScopeZh} · ${vaultFilterZh} · 可切换白金/杜卡德＋速刷/舒适/收益 · 共 ${escapeHtml(data.totalFissures ?? 0)} 条裂缝`;
  const headerMeta = ducatGoal
    ? `<strong>还差 ${currency('ducat', ducatGoal.shortfall, { size: 14 })}</strong><span>余额 ${currency('ducat', ducatGoal.currentDucats, { size: 10 })} · ${escapeHtml(localTime(data.fetchedAt))}</span>`
    : `<strong>库存匹配 · 双币估值</strong><span>${escapeHtml(localTime(data.fetchedAt))} 估值</span>`;
  const targetCosts = ducatGoal
    ? `奸商 ${currency('credit', ducatGoal.credits, { size: 9, weight: 700 })} · 市场税 ${ducatGoal.tradingTax != null ? currency('credit', ducatGoal.tradingTax, { size: 9, weight: 700 }) : '未知'}`
    : '钢铁 +1 精华 · 九重天有额外结算';
  const content = `<div class="card"><div class="header">${headerIcon('fissure')}<div style="min-width:0"><div class="kicker">开遗物 · ${ducatGoal ? '奸商对标' : modeZh} · ${fissureScopeZh} · ${preferenceZh} · ${vaultFilterZh}</div><div class="title">${title}</div></div><div class="header-meta">${headerMeta}</div></div>
    <div class="section"><span class="section-badge">${ducatGoal ? '立即可开' : `TOP ${rows.length}`}</span>${ducatGoal ? `展示 ${escapeHtml(shownRelicCount)}/${escapeHtml(data.matchedRelicCount ?? shownRelicCount)} 种估算过线候选 · 每种最多 2 条路线` : `可立即开 ${escapeHtml(data.matchedRelicCount ?? 0)} 种 · 每种最多 2 条路线`}<small>${targetSummary}</small></div>
    ${body || empty}
    ${ducatGoal ? `<div class="section"><span class="section-badge">建议获取</span>未拥有且当前可刷 · 最多 3 种<small>列出概率最高的常规来源</small></div>${acquireBody || acquireEmpty}` : ''}
    <div class="footer" style="font-size:9px"><span>${requiemNote}${ducatGoal ? `${squadZh}·按推荐精炼·开局前只估自己遗物·WFInfo 按实际四选一守保本线` : `完整·${squadZh}${ducatMode ? '·按毛杜卡德期望' : '·价格优先今日中位，样本不足取90日'}`}｜${preferenceNote}</span><span>${targetCosts}</span></div></div>`;
  const keySeed = `recommend|v16|w800|${data.mode}|${fissureScope}|${preference}|${vaultFilter}|${ducatGoal?.uniqueName || ''}|${ducatGoal?.marketPlat || ''}|${data.squad ?? 4}|${rows.map((row) => `${row.id}:${row.relic.base}:${row.relic.vaulted ? 'v' : 'u'}:${row.targetEconomy?.expectedDucats ?? row.expectedValue ?? ''}:${row.targetEconomy?.opportunityPlat ?? ''}:${row.refineZh ?? ''}:${(row.tags || []).map((tag) => tag.key).join(',')}`).join('|')}|${acquireRows.map((row) => `${row.relic.base}:${row.targetEconomy?.expectedDucats ?? ''}:${row.refineZh ?? ''}`).join('|')}`;
  return { html: documentShell(content, height, 800), width: 800, height, key: `fissure-recommend-${createHash('sha1').update(keySeed).digest('hex').slice(0, 12)}` };
}

// 精炼推荐卡：库存全扫按「光辉 vs 完整的期望增益」排序（数据来自 recommend.mjs recommendRefinement）
export function buildRefineRecommendCard(data) {
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const ducatMode = data.mode === 'ducat';
  const rowH = 64;
  // 榜外参考行：TOP 榜按增益排序天然被光辉档霸屏，示例让无瑕/不精炼档可见
  const examples = data.examples || {};
  const exampleLine = (examples.flawless?.length || examples.intact?.length)
    ? `<div style="position:relative;z-index:1;height:50px;display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:center;padding:0 14px;font-size:10px;line-height:15px;color:#8f9aa6;border-bottom:1px solid rgba(176,123,55,.42)">
        <div>${examples.flawless?.length ? `无瑕档代表<br><b style="color:#75dcca">${escapeHtml(examples.flawless.join('、'))}</b>` : ''}</div>
        <div>${examples.intact?.length ? `完整档代表（直接开）<br><b style="color:#aab4bd">${escapeHtml(examples.intact.join('、'))}</b>` : ''}</div>
      </div>`
    : '';
  const exampleH = exampleLine ? 50 : 0;
  const height = 84 + 30 + Math.max(rows.length, 1) * rowH + exampleH + 32;
  const suggestColor = { Radiant: '#f0c765', Flawless: '#75dcca', Intact: '#8f9aa6' };
  const body = rows.map((row, index) => {
    const gain = ducatMode ? row.suggest.gainDucats : row.suggest.gainPlat;
    const gainText = ducatMode ? `+${escapeHtml(gain)} 杜` : `+${escapeHtml(gain)}p`;
    const color = suggestColor[row.suggest.key] || '#8f9aa6';
    const vaultState = `<span style="margin-left:5px;color:${row.vaulted ? '#d7a46d' : '#8ee3ad'};font-size:10px;font-weight:800">${row.vaulted ? '已入库' : '未入库'}</span>`;
    const value = `<div style="font-size:16px;font-weight:900;color:${color}">${escapeHtml(row.suggest.zh)}</div><div style="font-size:10px;color:#7f8b97">增益 ${gainText}/100光体</div>`;
    const tiersText = ducatMode
      ? `完整 ${escapeHtml(Math.round(row.intact.ducats))}杜 → 光辉 ${escapeHtml(Math.round(row.radiant.ducats))}杜`
      : `完整 ${escapeHtml(row.intact.plat)}p → 光辉 ${escapeHtml(row.radiant.plat)}p`;
    return `<div style="position:relative;z-index:1;height:${rowH}px;display:grid;grid-template-columns:30px minmax(0,1fr) 190px 110px;align-items:center;padding:0 14px;border-bottom:1px solid rgba(176,123,55,.42);background:${index % 2 ? 'rgba(255,255,255,.035)' : 'rgba(255,255,255,.014)'}">
      <div style="font-size:17px;font-weight:900;color:${index < 3 ? '#f0c765' : '#8f9aa6'}">${index + 1}</div>
      <div style="min-width:0"><div style="font-size:15px;font-weight:820;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><b style="color:#75dcca">${escapeHtml(row.zh)}</b> ×${escapeHtml(row.count)}${vaultState}</div>
        <div style="margin-top:3px;font-size:11px;color:#8f9aa6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">稀有奖 ${escapeHtml(row.topRare?.zhName || '—')}${row.topRare?.price ? ` <b style="color:#f0c765">${escapeHtml(Math.round(row.topRare.price * 10) / 10)}p</b> · ${row.topRare.marketBasis === 'today' ? '今日' : '90日'}·日均${escapeHtml(row.topRare.dailyVolume ?? '—')}` : ''}</div></div>
      <div style="text-align:right;font-size:12px;color:#aab4bd;font-variant-numeric:tabular-nums">${tiersText}</div>
      <div style="text-align:right">${value}</div>
    </div>`;
  }).join('');
  const empty = '<div style="position:relative;z-index:1;height:64px;display:grid;place-items:center;color:#8995a1;font-size:14px">本地没有遗物库存记录</div>';
  const squadZh = (data.squad ?? 4) > 1 ? `${data.squad ?? 4}人组队取最优` : '单人';
  const dist = data.distribution || {};
  const content = `<div class="card"><div class="header">${headerIcon('relic')}<div style="min-width:0"><div class="kicker">精炼推荐 · ${ducatMode ? '杜卡德' : '白金'}口径</div><div class="title">哪些遗物值得花光体</div></div><div class="header-meta"><strong>${squadZh}</strong><span>${escapeHtml(localTime(data.fetchedAt))} 估值</span></div></div>
    <div class="section"><span class="section-badge">TOP ${rows.length}</span>全库 ${escapeHtml(data.totalOwned ?? 0)} 种：光辉 ${escapeHtml(dist.radiant ?? '—')} · 无瑕 ${escapeHtml(dist.flawless ?? '—')} · 完整 ${escapeHtml(dist.intact ?? '—')}<small>切换：精炼推荐 单人｜精炼推荐 杜卡德</small></div>
    ${body || empty}
    ${exampleLine}
    <div class="footer"><span>增益 = 光辉相对完整的期望提升（100 光体）· 优良每光体收益≈无瑕，不单列档</span><span>估值=可靠成交中位</span></div></div>`;
  const keySeed = `refine|v4|${data.mode}|${data.squad ?? 4}|${rows.map((row) => `${row.base}:${row.vaulted ? 'v' : 'u'}:${row.intact?.plat ?? ''}:${row.radiant?.plat ?? ''}:${row.topRare?.price ?? ''}:${row.topRare?.marketBasis ?? ''}`).join('|')}`;
  return { html: documentShell(content, height), width: 600, height, key: `refine-recommend-${createHash('sha1').update(keySeed).digest('hex').slice(0, 12)}` };
}

export function buildDropsAlertCard(data) {
  const drops = Array.isArray(data.drops) ? data.drops : [];
  const total = Number(data.total) || drops.length;
  const height = 86 + Math.max(drops.length, 1) * 62 + 34;
  const markOf = (drop) => drop.isRelic ? { text: '遗', color: '#d7a46d' }
    : drop.isPrime ? { text: 'P', color: '#f0c765' }
    : drop.isArcane ? { text: '赋', color: '#75dcca' }
      : drop.isMod ? { text: '模', color: '#b48ce8' }
        : { text: '物', color: '#8ab4f8' };
  const rows = drops.map((drop, index) => {
    const mark = markOf(drop);
    // 有官方插画用图，无图退字母块；插画背景压淡避免白底图刺眼
    const iconBox = drop.iconDataUri
      ? `<div style="width:40px;height:40px;border-radius:8px;display:grid;place-items:center;background:rgba(255,255,255,.07);overflow:hidden"><img src="${drop.iconDataUri}" style="max-width:36px;max-height:36px;object-fit:contain"></div>`
      : `<div style="width:32px;height:32px;border-radius:8px;display:grid;place-items:center;background:${mark.color};color:#14181d;font-size:15px;font-weight:900">${mark.text}</div>`;
    const estimateBasis = drop.platinum == null ? ''
      : drop.marketBasis === 'daily-closed' ? '近期成交均价'
        : `${drop.marketBasis === 'today' ? '今日中位' : '90日中位'} · 日均 ${drop.dailyVolume ?? '—'} 笔交易${drop.marketStatsStale ? ' · 缓存' : ''}`;
    const detailParts = [drop.isRelic ? (drop.vaulted ? '已入库' : '未入库') : '', drop.rarityZh, drop.condition, estimateBasis].filter(Boolean);
    const priceText = drop.platinum != null ? currency('plat', drop.platinum, { size: 11, weight: 800 }) : (drop.tradable ? '暂无可靠估值' : '不可交易');
    // 杜卡德优先占副行（Prime 部件固定价值比浮动市价更可靠），市价退到同行拼接
    const valueParts = [drop.ducats != null ? currency('ducat', drop.ducats * (Number(drop.gained) || 1), { size: 11, weight: 800 }) : '', priceText].filter(Boolean).join(' · ');
    return `<div style="position:relative;z-index:1;height:62px;display:grid;grid-template-columns:46px minmax(0,1fr) 158px;align-items:center;padding:0 16px;border-bottom:1px solid rgba(176,123,55,.40);background:${index % 2 ? 'rgba(255,255,255,.035)' : 'rgba(255,255,255,.014)'}">${iconBox}<div style="min-width:0;padding-left:6px"><div style="font-size:15px;font-weight:820;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(drop.displayName)}</div><div style="margin-top:3px;font-size:10px;color:#8995a1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(detailParts.join(' · '))}</div></div><div style="text-align:right"><div style="font-size:17px;font-weight:900;color:#75dcca;font-variant-numeric:tabular-nums">×${escapeHtml(drop.gained)}</div><div style="margin-top:2px;font-size:10px;color:${drop.ducats != null || drop.platinum != null ? '#f0c765' : '#7f8b97'};white-space:nowrap">${valueParts}</div></div></div>`;
  }).join('');
  const empty = '<div style="position:relative;z-index:1;height:62px;display:grid;place-items:center;color:#8995a1;font-size:14px">没有可显示的新掉落</div>';
  const totalDucats = Number(data.totalDucats) || 0;
  const hasDailyFallback = drops.some((drop) => drop.marketBasis === 'daily-closed');
  const estimateNote = hasDailyFallback ? '估值=成交中位；故障时用近期成交均价' : '估值=可靠成交中位';
  const content = `<div class="card"><div class="header" style="height:86px">${glyphOrIcon(data.glyphDataUri, 'target')}<div style="min-width:0"><div class="kicker">个人掉落 · 本机只读</div><div class="title" style="font-size:23px">入库新掉落 · ${total} 项</div></div><div class="header-meta"><strong style="color:#75dcca">仅用户私聊</strong><span>${escapeHtml(localTime(data.syncedAt))} 同步</span></div></div>${rows || empty}<div class="footer" style="height:34px"><span>${totalDucats ? `本批共可换 <strong style="color:#f0c765">${totalDucats}</strong> 杜卡德 · ` : ''}来源：本机账号快照</span><span>${total > drops.length ? `显示 ${drops.length}/${total} · ` : ''}${estimateNote}</span></div></div>`;
  const keySeed = `drops-v9|${data.syncedAt}|${data.glyphDataUri ? 'g' : 'x'}|${drops.map((drop) => `${drop.uniqueName}:${drop.gained}:${drop.marketBasis || ''}:${drop.platinum ?? ''}:${drop.isRelic ? (drop.vaulted ? 'v' : 'u') : '-'}`).join('|')}`;
  return { html: documentShell(content, height), width: 600, height, key: `drops-${createHash('sha1').update(keySeed).digest('hex').slice(0, 12)}` };
}

export function buildTraderShoppingCard(data) {
  const allRows = Array.isArray(data.rows) ? data.rows : [];
  // 完整货单可能超过 30 件；卡片只保留前 16 个决策优先项，避免 QQ 中生成过长图片。
  const rows = allRows.slice(0, 16);
  const ADVICE_STYLE = {
    strong: { zh: '强烈买', color: '#f0c765' }, buy: { zh: '顺手买', color: '#75dcca' },
    cash: { zh: '省现金', color: '#8ab8ec' }, flip: { zh: '可倒卖', color: '#8ab4f8' },
    choice: { zh: '看需求', color: '#c99b62' }, need: { zh: '库存不足', color: '#a56b6b' }, market: { zh: '市场买', color: '#e07777' },
    exclusive: { zh: '独占', color: '#b48ce8' }, skip: { zh: '跳过', color: '#56616d' },
  };
  const rowH = 70;
  const height = 86 + 30 + Math.max(rows.length, 1) * rowH + 34;
  const body = rows.map((row, index) => {
    const advice = ADVICE_STYLE[row.advice?.tag] || ADVICE_STYLE.skip;
    const name = row.zhName || (row.tradable ? row.nameEn : (row.nameEn || '未收录物品'));
    const basis = row.marketBasis === 'today' ? '今日成交中位' : '90天成交中位';
    const priceText = !row.tradable ? '独占 · 无市场价'
      : row.platinum == null ? '暂无成交统计'
        : `${basis} ${currency('plat', row.platinum, { size: 10, weight: 800 })} · 90日均 ${escapeHtml(row.dailyVolume ?? 0)} 笔/天${row.marketStatsStale ? ' · 缓存' : ''}`;
    const routeText = row.ducatOpportunityPlat != null
      ? `补足 ${currency('ducat', row.ducatNeed, { size: 9, weight: 760 })}≈${currency('plat', row.ducatOpportunityPlat, { size: 9, weight: 760 })} · 奸商 ${currency('credit', row.credits, { size: 9, weight: 700 })} · 税 ${row.tradingTax != null ? currency('credit', row.tradingTax, { size: 9, weight: 700 }) : '未知'}`
      : row.ducatPlanShortfall
        ? `安全库存还差 ${currency('ducat', row.ducatPlanShortfall, { size: 9, weight: 760 })} · 市场行情仍可参考`
        : row.platinum != null && row.ratio != null
          ? `${currency('ducat', 1, { size: 9, weight: 760 })}=${currency('plat', row.ratio, { size: 9, weight: 760 })} · 奸商 ${currency('credit', row.credits, { size: 9, weight: 700 })}`
          : '';
    // 插画列：有图用图，查无（Baro 饰品类未收录）留空保持对齐
    const iconCell = row.iconDataUri
      ? `<div style="width:40px;height:40px;border-radius:8px;display:grid;place-items:center;background:rgba(255,255,255,.07);overflow:hidden"><img src="${row.iconDataUri}" style="max-width:36px;max-height:36px;object-fit:contain"></div>`
      : '<div></div>';
    return `<div style="position:relative;z-index:1;height:${rowH}px;display:grid;grid-template-columns:64px 46px minmax(0,1fr) 168px;align-items:center;padding:0 16px;border-bottom:1px solid rgba(176,123,55,.40);background:${index % 2 ? 'rgba(255,255,255,.035)' : 'rgba(255,255,255,.014)'}">
      <div style="width:54px;height:26px;border-radius:7px;display:grid;place-items:center;background:${advice.color};color:#14181d;font-size:12px;font-weight:900">${advice.zh}</div>
      ${iconCell}
      <div style="min-width:0;padding-left:10px"><div style="font-size:15px;font-weight:820;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(name)}${row.owned ? ' <span style="font-size:10px;color:#8f9aa6;font-weight:700">已有</span>' : ''}</div>
        <div style="margin-top:3px;font-size:10px;color:#8995a1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${priceText}</div>${routeText ? `<div style="margin-top:2px;font-size:9px;color:#788592;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${routeText}</div>` : ''}</div>
      <div style="text-align:left;padding-left:18px"><div style="font-size:16px">${currency('ducat', row.ducats, { size: 15 })}</div><div style="margin-top:3px;font-size:10px">${row.platSaving == null ? currency('credit', row.credits, { size: 10, weight: 700 }) : row.platSaving >= 0 ? `<span style="color:#75dcca">省 ${currency('plat', row.platSaving, { size: 10, color: '#75dcca', weight: 760 })}</span>` : `<span style="color:#e07777">多 ${currency('plat', Math.abs(row.platSaving), { size: 10, color: '#e07777', weight: 760 })}</span>`}</div></div>
    </div>`;
  }).join('');
  const empty = '<div style="position:relative;z-index:1;height:62px;display:grid;place-items:center;color:#8995a1;font-size:14px">奸商尚未到达，到货后再来问</div>';
  const balance = Number(data.ducatBalance) || 0;
  const want = Number(data.wantDucats) || 0;
  const affordText = data.arrived
    ? (data.affordable ? `推荐项合计 ${currency('ducat', want, { size: 12 })} · 余额够用` : `推荐项还差 ${currency('ducat', data.ducatShortfall || 0, { size: 12 })} · 发「杜卡德 ${escapeHtml(data.ducatShortfall || 0)}」`)
    : `预计 ${localDateTime(data.activation)} 到达`;
  const content = `<div class="card"><div class="header" style="height:86px">${headerIcon('baro')}<div style="min-width:0"><div class="kicker">奸商购物推荐 · 仅用户私聊</div><div class="title" style="font-size:23px">${escapeHtml(data.location || '虚空商人')}</div></div><div class="header-meta"><strong>余额 ${currency('ducat', balance, { size: 14 })}</strong><span>${escapeHtml(localTime(data.fetchedAt))}</span></div></div>
    <div class="section"><span class="section-badge">${rows.length}/${allRows.length} 件</span>奸商兑换路线 vs 玩家市场路线<small>${data.arrived ? `当前 ${currency('ducat', balance, { size: 10, weight: 760 })}${data.safeDucatAvailable != null ? ` · 安全库存最多 ${currency('ducat', `+${data.safeDucatAvailable}`, { size: 10, weight: 760 })}` : ''} · 各商品独立判断` : '未到货'}</small></div>
    ${body || empty}
    <div class="footer" style="height:34px"><span>${affordText}</span><span>MOD 按 0 级 · 成交中位价 · 仅供参考</span></div></div>`;
  const keySeed = `trader-shop7|${data.fetchedAt}|${allRows.map((row) => `${row.uniqueName}:${row.advice?.tag}:${row.platinum ?? ''}:${row.marketBasis ?? ''}:${row.dailyVolume ?? ''}:${row.ducatOpportunityPlat ?? ''}:${row.tradingTax ?? ''}`).join('|')}`;
  return { html: documentShell(content, height), width: 600, height, key: `trader-shop-${createHash('sha1').update(keySeed).digest('hex').slice(0, 12)}` };
}

// 导出供 doctor.mjs 自检（渲染链路可用性判定）
export async function findBrowser() {
  // WARFRAME_BROWSER 显式指定优先（非标准安装路径的用户）；其后按系统级/用户级常见路径探测
  const localAppData = process.env.LOCALAPPDATA || '';
  const candidates = [
    process.env.WARFRAME_BROWSER,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    localAppData ? path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* continue */ }
  }
  return null;
}

// 渲卡时顺手清 7 天前的旧卡：无 cron 零状态，掉落补投队列 TTL 48h < 7 天不会误删待投图
const CARD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export async function pruneOldCards(cardDir) {
  try {
    const cutoff = Date.now() - CARD_MAX_AGE_MS;
    for (const entry of await readdir(cardDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(?:png|html)$/u.test(entry.name)) continue;
      const full = path.join(cardDir, entry.name);
      const info = await stat(full).catch(() => null);
      if (info && info.mtimeMs < cutoff) await unlink(full).catch(() => {});
    }
  } catch { /* 清理失败不影响渲染 */ }
}

// PNG 调色板量化压缩：卡片是平面 UI 色块，实测 -66~-75% 体积肉眼无损；sharp 缺失时静默保持原图
let sharpPromise;
function loadSharp() {
  if (!sharpPromise) sharpPromise = import('sharp').then((m) => m.default).catch(() => null);
  return sharpPromise;
}
export async function compressCardPng(pngPath) {
  const sharp = await loadSharp();
  if (!sharp) return;
  try {
    // dither:0 必须显式关——抖动会把边框色调色板项撒进深色渐变背景形成红斑（2026-08-05 商店卡实锤），且关掉体积更小
    const buffer = await sharp(pngPath).png({ palette: true, quality: 80, effort: 5, dither: 0 }).toBuffer();
    if (buffer.length < (await stat(pngPath)).size) await writeFile(pngPath, buffer);
  } catch { /* 压缩失败保持原图，不影响发卡 */ }
}

export async function renderWarframeCard(card, cardDir) {
  if (!cardDir || !card) return null;
  const browser = await findBrowser();
  if (!browser) return null;
  const stem = card.key.replace(/[^a-z0-9_-]+/giu, '-').replace(/^-+|-+$/gu, '').toLowerCase().slice(0, 60) || 'warframe-card';
  const digest = createHash('sha256').update(card.key).digest('hex').slice(0, 10);
  const safeKey = `${stem}-${digest}`;
  await mkdir(cardDir, { recursive: true });
  await pruneOldCards(cardDir);
  const htmlPath = path.join(cardDir, `${safeKey}.html`);
  const pngPath = path.join(cardDir, `${safeKey}.png`);
  const profilePath = await mkdtemp(path.join(cardDir, '.chrome-'));
  await writeFile(htmlPath, card.html, 'utf8');
  try {
    await execFileAsync(browser, ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-default-browser-check', `--force-device-scale-factor=${card.scale || 2}`, `--user-data-dir=${profilePath}`, `--window-size=${card.width},${card.height}`, `--screenshot=${pngPath}`, pathToFileURL(htmlPath).href], { timeout: 20_000, windowsHide: true, maxBuffer: 1024 * 1024 });
    await access(pngPath);
    await compressCardPng(pngPath);
    return pngPath;
  } finally {
    await rm(profilePath, { recursive: true, force: true }).catch(() => {});
  }
}
