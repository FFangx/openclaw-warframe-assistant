#!/usr/bin/env node

// rotation-calendar.mjs — 轮换日历：未来 8 周的回廊战甲/灵化武器 + 泰辛精选 + 瓦奇娅复刻档期。
// 数据链：browse.wf typestripped/live.js（回廊 11 周表/武器 9 周表，语言键）× dict.zh/dict.en（官方译名+英文显示名）
//       + vendor-shop teshinWeekInfo（8 周表）+ 官方 worldState PrimeVaultTraders.ScheduleInfo（54 期含未来）。
// 「已有」标链：语言键 → dict.en 英文显示名 → Warframes.json uniqByName → uniqueName → 快照 Suits 精确比对。
// 订阅侧 resolveRotationTarget：名字 → 最近未来时刻（一次性订阅 meta.at）。

import { pathToFileURL } from 'node:url';
import { staleCachedJson } from './wfdata.mjs';
import { documentShell, escapeHtml } from './warframe-cards.mjs';

const LIVE_JS_URL = 'https://browse.wf/typestripped/live.js';
const DICT_ZH_URL = 'https://browse.wf/warframe-public-export-plus/dict.zh.json';
const DICT_EN_URL = 'https://browse.wf/warframe-public-export-plus/dict.en.json';
const FETCH_TIMEOUT_MS = 20_000;

// 回廊周表锚点（live.js EPOCH，2026-08-05 实测本周 idx=85 与游戏一致）
export const CIRCUIT_EPOCH_MS = 1_734_307_200_000;
const WEEK_MS = 604_800_000;

// 泰辛 8 周表中文名（tail 顺序=vendor-shop TESHIN_ROTATION；内部名无官方词条，静态表）
const TESHIN_ZH = Object.freeze({
  UmbraFormaBlueprint: 'Umbra Forma 蓝图', Kuva: '5 万赤毒', RawModularPistolRandomMod: 'Kitgun 紫卡', Forma: '3 个 Forma',
  RawModularMeleeRandomMod: 'Zaw 紫卡', EvergreenLoginRewardFusionBundle: '3 万内融核心', RawRifleRandomMod: '步枪紫卡', RawShotgunRandomMod: '霰弹枪紫卡',
});

async function fetchAny(url, kind = 'json') {
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  return kind === 'text' ? response.text() : response.json();
}

// live.js 源码抽表：const frameChoices = [ ["key",...], ... ];
function extractChoices(source, name) {
  const match = source.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`, 'u'));
  if (!match) throw new Error(`live.js 缺 ${name} 表`);
  const groups = [...match[1].matchAll(/\[([^\]]*)\]/gu)].map((group) => [...group[1].matchAll(/"([^"]+)"/gu)].map((key) => key[1]));
  if (!groups.length) throw new Error(`${name} 表解析为空`);
  return groups;
}

// —— 轮换表（缓存 7d，失败退陈旧）：{ frames:[[{zh,en}×3]×11], weapons:[[{zh,en}×5]×9] } ——
let tablesPromise = null;
export function getRotationTables() {
  tablesPromise ??= (async () => {
    const result = await staleCachedJson('rotation-tables', { ttlMs: 7 * 24 * 3600_000, version: 1 }, async () => {
      const [live, zh, en] = await Promise.all([fetchAny(LIVE_JS_URL, 'text'), fetchAny(DICT_ZH_URL), fetchAny(DICT_EN_URL)]);
      const translate = (groups) => groups.map((group) => group.map((key) => ({ zh: zh[key] || key.split('/').pop(), en: en[key] || '' })));
      return { frames: translate(extractChoices(live, 'frameChoices')), weapons: translate(extractChoices(live, 'weaponChoices')) };
    });
    return result.data;
  })();
  return tablesPromise;
}

export function __resetRotationTablesForTest(tables) {
  tablesPromise = tables !== undefined ? Promise.resolve(tables) : null;
}

// 瓦奇娅排期解析：官方 ScheduleInfo → [{expiryMs, startMs?, names:[英文名], hidden}]（升序，含当期）
export function parseVarziaSchedule(worldState, now = Date.now()) {
  const vault = worldState?.PrimeVaultTraders?.[0];
  const entries = (vault?.ScheduleInfo || []).map((entry) => ({
    expiryMs: Number(entry.Expiry?.$date?.$numberLong) || 0,
    hidden: (Number(entry.PreviewHiddenUntil?.$date?.$numberLong) || 0) > now,
    item: String(entry.FeaturedItem || ''),
  })).filter((entry) => entry.expiryMs > now).sort((a, b) => a.expiryMs - b.expiryMs);
  return entries.map((entry, index) => {
    const pack = entry.item.match(/MPV(\w+?)Prime(Dual|Single)Pack$/u);
    const names = pack ? pack[1].split(/(?=[A-Z])/u).filter(Boolean) : [];
    return {
      // 档期 = 上一期 expiry 起、本期 expiry 止
      startMs: index === 0 ? null : entries[index - 1].expiryMs,
      expiryMs: entry.expiryMs,
      hidden: entry.hidden,
      names,
      label: entry.hidden || !names.length ? '未公布' : `${names.join('+')} Prime 复刻`,
    };
  });
}

// ==== 装配：未来 N 周日历 ====
// inventory/names 可空（降级无「已有」标）；worldState 可空（瓦奇娅列显示获取失败）
export async function buildRotationCalendar({ weeks = 8, inventory = null, names = null, worldState = null, now = Date.now() } = {}) {
  const tables = await getRotationTables();
  const suitSet = new Set((inventory?.Suits || []).map((suit) => suit.ItemType));
  const owned = (enName) => Boolean(enName && names?.uniqByName && suitSet.size && suitSet.has(names.uniqByName.get(enName)));
  const varzia = worldState ? parseVarziaSchedule(worldState, now) : [];
  const currentWeek = Math.trunc((now - CIRCUIT_EPOCH_MS) / WEEK_MS);
  const rows = [];
  for (let offset = 0; offset < weeks; offset += 1) {
    const week = currentWeek + offset;
    const startMs = CIRCUIT_EPOCH_MS + week * WEEK_MS;
    const endMs = startMs + WEEK_MS;
    // 泰辛表锚点不同（2025-01-06），按同一周起点换算
    const teshinWeek = Math.trunc((startMs - 1_736_121_600_000) / WEEK_MS);
    const teshinTail = ['UmbraFormaBlueprint', 'Kuva', 'RawModularPistolRandomMod', 'Forma', 'RawModularMeleeRandomMod', 'EvergreenLoginRewardFusionBundle', 'RawRifleRandomMod', 'RawShotgunRandomMod'][((teshinWeek % 8) + 8) % 8];
    // 该周内换期的瓦奇娅档期（新一期在本周开卖）
    const varziaChange = varzia.find((entry) => entry.startMs != null && entry.startMs >= startMs && entry.startMs < endMs);
    rows.push({
      week, startMs, endMs, current: offset === 0,
      frames: tables.frames[((week % tables.frames.length) + tables.frames.length) % tables.frames.length].map((frame) => ({ ...frame, owned: owned(frame.en) })),
      weapons: tables.weapons[((week % tables.weapons.length) + tables.weapons.length) % tables.weapons.length],
      teshin: TESHIN_ZH[teshinTail] || teshinTail,
      varzia: varziaChange ? { label: varziaChange.label, atMs: varziaChange.startMs, hidden: varziaChange.hidden } : null,
    });
  }
  // 当期瓦奇娅（头部注释用）
  const varziaCurrent = varzia[0] ? { label: varzia[0].label, expiryMs: varzia[0].expiryMs } : null;
  return { rows, varziaCurrent, generatedAt: now };
}

// ==== 订阅解析：名字 → 最近未来出现（一次性订阅用） ====
const compact = (value) => String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/[\s·]+/gu, '');

export async function resolveRotationTarget(query, { worldState = null, now = Date.now(), horizonWeeks = 12 } = {}) {
  const q = compact(query);
  if (!q || q.length < 2) return null;
  const tables = await getRotationTables();
  const currentWeek = Math.trunc((now - CIRCUIT_EPOCH_MS) / WEEK_MS);
  // ① 回廊战甲/武器：未来 horizonWeeks 周逐周找（跳过本周=已在进行，从下周起蹲）
  for (let offset = 0; offset < horizonWeeks; offset += 1) {
    const week = currentWeek + offset;
    const startMs = CIRCUIT_EPOCH_MS + week * WEEK_MS;
    const frames = tables.frames[((week % tables.frames.length) + tables.frames.length) % tables.frames.length];
    const weapons = tables.weapons[((week % tables.weapons.length) + tables.weapons.length) % tables.weapons.length];
    const frameHit = frames.find((frame) => compact(frame.zh) === q || compact(frame.en) === q);
    if (frameHit) return { source: 'circuit-frame', label: `${frameHit.zh} 进入无尽回廊（普通）`, atMs: startMs, current: offset === 0 };
    const weaponHit = weapons.find((weapon) => compact(weapon.zh) === q || compact(weapon.en) === q);
    if (weaponHit) return { source: 'circuit-weapon', label: `${weaponHit.zh} 进入无尽回廊（钢铁·灵化）`, atMs: startMs, current: offset === 0 };
  }
  // ② 泰辛 8 周表
  const teshinEntries = Object.entries(TESHIN_ZH);
  const teshinHit = teshinEntries.findIndex(([, zh]) => compact(zh).includes(q));
  if (teshinHit >= 0) {
    const teshinWeekNow = Math.trunc((now - 1_736_121_600_000) / WEEK_MS);
    for (let offset = 0; offset < 8; offset += 1) {
      if (((teshinWeekNow + offset) % 8 + 8) % 8 === teshinHit) {
        return { source: 'teshin', label: `${teshinEntries[teshinHit][1]} 上架泰辛精选`, atMs: 1_736_121_600_000 + (teshinWeekNow + offset) * WEEK_MS, current: offset === 0 };
      }
    }
  }
  // ③ 瓦奇娅复刻（英文战甲名匹配包名）
  for (const entry of parseVarziaSchedule(worldState, now)) {
    if (entry.hidden || !entry.names.length) continue;
    if (entry.names.some((name) => compact(name) === q || q === compact(`${name}prime`))) {
      // startMs=null 表示当期正在售
      return { source: 'varzia', label: `${entry.label}（瓦奇娅）`, atMs: entry.startMs ?? now, current: entry.startMs == null };
    }
  }
  return null;
}

// ==== 卡片 ====
const C = { text: '#f3f5f7', sub: '#aeb9c4', dim: '#8f9aa6', green: '#67dfb8', gold: '#f0c765', cyan: '#72ded3', purple: '#c98add' };

function calendarIcon() {
  return `<div class="brand-icon"><svg viewBox="0 0 24 24" fill="none" stroke="#f0c765" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/></svg></div>`;
}

function mmdd(ms) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' }).format(new Date(ms));
}

export function buildRotationCalendarCard(data, fetchedAt = new Date().toISOString()) {
  const rowH = 64;
  const anyIcon = data.rows.some((row) => row.frames.some((frame) => frame.iconDataUri));
  const rows = data.rows.map((row, index) => {
    const frames = row.frames.map((frame) => {
      const icon = frame.iconDataUri ? `<img src="${frame.iconDataUri}" style="width:24px;height:24px;object-fit:contain;vertical-align:-7px;margin-right:2px">` : '';
      return frame.owned
        ? `<span style="color:${C.dim};white-space:nowrap">${icon}${escapeHtml(frame.zh)}<span style="color:${C.green};font-size:10px">✓</span></span>`
        : `<span style="color:${C.text};font-weight:700;white-space:nowrap">${icon}${escapeHtml(frame.zh)}</span>`;
    }).join('<span style="color:#49535e"> · </span>');
    const weapons = row.weapons.map((weapon) => escapeHtml(weapon.zh)).join(' · ');
    return `<div style="height:${rowH}px;display:grid;grid-template-columns:64px minmax(0,1fr) 150px;align-items:center;gap:10px;padding:0 16px;border-bottom:1px solid rgba(176,123,55,.30);background:${row.current ? 'rgba(240,199,101,.07)' : index % 2 ? 'rgba(255,255,255,.035)' : 'rgba(255,255,255,.014)'}">
      <div><div style="font-size:15px;font-weight:900;color:${row.current ? C.gold : C.cyan};font-variant-numeric:tabular-nums">${escapeHtml(mmdd(row.startMs))}</div><div style="font-size:10px;color:${C.dim}">${row.current ? '本周' : `第 ${index + 1} 周后`}</div></div>
      <div style="min-width:0">
        <div style="font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${frames}</div>
        <div style="margin-top:4px;font-size:11px;color:${C.dim};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">灵化：${weapons}</div>
        ${row.varzia ? `<div style="margin-top:3px;font-size:11px;color:${row.varzia.hidden ? C.dim : C.purple};font-weight:700">🔄 ${escapeHtml(mmdd(row.varzia.atMs))} 瓦奇娅换期：${escapeHtml(row.varzia.label)}</div>` : ''}</div>
      <div style="text-align:right;font-size:12px;color:${C.gold};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(row.teshin)}</div></div>`;
  }).join('');
  // varzia 行会撑高：有换期的行加 14px
  const extraH = data.rows.filter((row) => row.varzia).length * 14;
  const height = 84 + 30 + data.rows.length * rowH + extraH + 32;
  const content = `<div class="card"><div class="header">${calendarIcon()}<div><div class="kicker">轮换日历 · 未来 ${data.rows.length} 周</div><div class="title">回廊 / 泰辛 / 瓦奇娅</div></div><div class="header-meta">${data.varziaCurrent ? `<strong>瓦奇娅当期：${escapeHtml(data.varziaCurrent.label)}</strong><span>${escapeHtml(mmdd(data.varziaCurrent.expiryMs))} 换期</span>` : ''}</div></div>
    <div class="section"><span class="section-badge" style="background:${C.cyan}">周一轮换</span>左=回廊战甲（✓已有）与灵化武器 · 右=泰辛精选<small>「订阅 轮换 名字」到期提醒一次</small></div>
    ${rows}<div class="footer"><span>回廊/泰辛：社区排期表 · 瓦奇娅：官方排期</span><span>${escapeHtml(new Date(fetchedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }))}</span></div></div>`;
  return { html: documentShell(content, height), width: 600, height, key: `rotation-calendar2-${anyIcon ? 'i' : 'x'}-${String(fetchedAt).slice(0, 13)}` };
}

// ==== CLI（探针/测试）：node rotation-calendar.mjs [名字] ====
async function main() {
  const query = process.argv.slice(2).join(' ').trim();
  const { loadOfficialWorldState } = await import('./vendor-shop.mjs');
  const worldState = await loadOfficialWorldState().catch(() => null);
  if (query) {
    console.log(JSON.stringify(await resolveRotationTarget(query, { worldState }), null, 1));
    return;
  }
  const calendar = await buildRotationCalendar({ worldState });
  console.log(JSON.stringify(calendar.rows.map((row) => ({ start: new Date(row.startMs).toISOString().slice(0, 10), frames: row.frames.map((f) => f.zh).join('·'), teshin: row.teshin, varzia: row.varzia?.label || null })), null, 1));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
