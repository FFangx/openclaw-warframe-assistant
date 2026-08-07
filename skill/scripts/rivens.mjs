#!/usr/bin/env node

// rivens.mjs — 我的紫卡：快照指纹 × AlecaFrame 本机计算表（rivensV2.json）离线复算数值/区间/神卡标。
// 公式（2026-08-05 用户 Aklato Hera-vexido 截图黄金验证 4/4）：
//   显示% = baseValue×100 × omegaAtt(倾向) × traitMult(正负词条数系数) × (满级rank+1) × (1 + (2/9)×roll)，roll=Value/2^30
//   区间 = [×0.9, ×1.1] 档（即公式 lerp 的两端）
// 词条中文 = wm /v2/riven/attributes（gameRef=指纹 Tag，自带 zh-hans，缓存 7d）+ 静态补漏
// 参考价 = DE 官方周报 weeklyRivensPC.json（伪 JSON：无引号键+单引号+裸 NaN，正则修复后 parse，缓存 24h）
// 紫卡名重建 = buffs 按 Value 降序：前缀+前缀+…+末位后缀（Hera-vexido 实证）

import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { staleCachedJson } from './wfdata.mjs';
import { currency, documentShell, escapeHtml } from './warframe-cards.mjs';

// 未开封紫卡图标（AlecaFrame mod_riven.png 复制进 assets/）；缺失退无图
let RIVEN_MOD_ICON = null;
try { RIVEN_MOD_ICON = `data:image/png;base64,${readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'mod_riven.png')).toString('base64')}`; } catch { RIVEN_MOD_ICON = null; }

const FETCH_TIMEOUT_MS = 20_000;
const WM_ATTR_URL = 'https://api.warframe.market/v2/riven/attributes';
const DE_WEEKLY_URL = 'https://www-static.warframe.com/repos/weeklyRivensPC.json';

// wm 表缺口的静态补漏（2026-08-05 实测唯一 MISS）
const ATTR_ZH_OVERRIDE = Object.freeze({ WeaponMeleeDamageMod: '近战伤害' });
// wm 中文名里的语境修正：Fire Rate 对近战武器=攻击速度（wm 名合并两义）
const POLARITY_ZH = Object.freeze({ AP_ATTACK: 'Madurai（V）', AP_DEFENSE: 'Vazarin（D）', AP_TACTIC: 'Naramon（—）' });
// 未开封紫卡类型中文（veiledName → 中文；官方词典对紫卡用「裂罅 Mod」体系）
const VEILED_ZH = Object.freeze({
  'Rifle Riven Mod': '步枪裂罅 Mod', 'Shotgun Riven Mod': '霰弹枪裂罅 Mod', 'Pistol Riven Mod': '手枪裂罅 Mod',
  'Melee Riven Mod': '近战裂罅 Mod', 'Zaw Riven Mod': 'Zaw 裂罅 Mod', 'Kitgun Riven Mod': 'Kitgun 裂罅 Mod',
  'Archgun Riven Mod': 'Archgun 裂罅 Mod', 'Sentinel Weapon Riven Mod': '守护武器裂罅 Mod', 'Companion Weapon Riven Mod': '同伴武器裂罅 Mod',
});

// ==== 数据加载（全部可注入打桩） ====

const defaultAlecaDir = () => process.env.ALECAFRAME_DATA_DIR || path.join(process.env.LOCALAPPDATA || '', 'AlecaFrame');

// AlecaFrame 本机计算表（本地缺失走 CDN 兑底）；读不到返回 null（数值/区间/神卡全降级，仍显示词条）
export async function loadRivenTable(alecaDir = defaultAlecaDir()) {
  const { readAlecaJson } = await import('./wfdata.mjs');
  return readAlecaJson('custom/rivensV2.json', { alecaDir });
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  return response.json();
}

// 词条 Tag → 中文名；失败返回空表（卡片退回表内英文 shortString）
let attrZhPromise = null;
export function getRivenAttrZh() {
  attrZhPromise ??= (async () => {
    try {
      // v2：缓存 version 2（v1 存的是英文——wm v2 不带 Language 头只回 en）
      const result = await staleCachedJson('riven-attr-zh', { ttlMs: 7 * 24 * 3600 * 1000, version: 2 }, async () => {
        // ⚠ wm v2 的 i18n 只回 Language 头指定的语言，缺头=纯英文
        const response = await fetch(WM_ATTR_URL, { headers: { 'User-Agent': 'Mozilla/5.0', Language: 'zh-hans' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!response.ok) throw new Error(`wm attributes HTTP ${response.status}`);
        const attrs = (await response.json()).data || [];
        const map = {};
        for (const attr of attrs) {
          const zh = attr?.i18n?.['zh-hans']?.name || attr?.i18n?.en?.name;
          if (attr?.gameRef && zh) map[attr.gameRef] = zh;
        }
        if (!Object.keys(map).length) throw new Error('riven 词条表为空');
        return map;
      });
      return { ...result.data, ...ATTR_ZH_OVERRIDE };
    } catch {
      return { ...ATTR_ZH_OVERRIDE };
    }
  })();
  return attrZhPromise;
}

// DE 官方周报：伪 JSON（无引号键/单引号/裸 NaN）修复后解析；失败返回空索引
// 索引键 = `${武器英文名小写}#${rerolled?1:0}`；未开封均价键 = `veiled#${itemType}`
let weeklyStatsPromise = null;
export function getWeeklyRivenStats() {
  weeklyStatsPromise ??= (async () => {
    try {
      const result = await staleCachedJson('riven-weekly-de', { ttlMs: 24 * 3600 * 1000, version: 1 }, async () => {
        const response = await fetch(DE_WEEKLY_URL, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!response.ok) throw new Error(`DE weekly HTTP ${response.status}`);
        const text = await response.text();
        const fixed = text
          .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/gu, '$1"$2":')
          .replace(/'([^']*)'/gu, '"$1"')
          .replace(/\bNaN\b/gu, 'null');
        const rows = JSON.parse(fixed);
        const index = {};
        for (const row of rows) {
          const key = row.compatibility ? `${String(row.compatibility).toLowerCase()}#${row.rerolled ? 1 : 0}` : `veiled#${row.itemType}`;
          index[key] = { avg: row.avg, median: row.median, min: row.min, max: row.max, pop: row.pop };
        }
        if (!Object.keys(index).length) throw new Error('DE weekly 索引为空');
        return index;
      });
      return result.data;
    } catch {
      return {};
    }
  })();
  return weeklyStatsPromise;
}

// 未开封紫卡价格：wm 普通市场最低在线卖单（veiledName → slug 固定映射）；失败逐项降级 null
const VEILED_SLUG = Object.freeze({
  'Rifle Riven Mod': 'rifle_riven_mod_(veiled)', 'Shotgun Riven Mod': 'shotgun_riven_mod_(veiled)', 'Pistol Riven Mod': 'pistol_riven_mod_(veiled)',
  'Melee Riven Mod': 'melee_riven_mod_(veiled)', 'Zaw Riven Mod': 'zaw_riven_mod_(veiled)', 'Kitgun Riven Mod': 'kitgun_riven_mod_(veiled)',
  'Archgun Riven Mod': 'archgun_riven_mod_(veiled)', 'Companion Weapon Riven Mod': 'companion_weapon_riven_mod_(veiled)', 'Sentinel Weapon Riven Mod': 'companion_weapon_riven_mod_(veiled)',
});
export async function getVeiledPrices(names, fetcher = null) {
  const out = {};
  await Promise.all([...new Set(names)].map(async (name) => {
    const slug = VEILED_SLUG[name];
    if (!slug) return;
    try {
      const url = `https://api.warframe.market/v2/orders/item/${encodeURIComponent(slug)}/top`;
      const body = fetcher ? await fetcher(url) : await fetchJson(url);
      // ⚠ wm top 列表不按价格排序（已知坑），最低价用 Math.min
      const prices = (body?.data?.sell || []).map((o) => Number(o.platinum)).filter(Number.isFinite);
      if (prices.length) out[name] = Math.min(...prices);
    } catch { /* 单项失败不影响其余 */ }
  }));
  return out;
}

// 测试打桩：复位两个在线表单例
export function __resetRivensForTest({ attrZh, weeklyStats } = {}) {
  attrZhPromise = attrZh !== undefined ? Promise.resolve(attrZh) : null;
  weeklyStatsPromise = weeklyStats !== undefined ? Promise.resolve(weeklyStats) : null;
}

// ==== 计算核心（纯函数） ====

// 单词条复算：返回 { tag, zh?, value, min, max, rollPct, curse }；表缺词条返回 null 值段
export function appraiseAttr(tag, rawValue, { stats, omegaAtt, traitMult, rank }) {
  const st = stats?.[tag];
  if (!st || !Number.isFinite(omegaAtt) || !Number.isFinite(traitMult)) return { tag, value: null };
  const roll = rawValue / 0x40000000;
  // 区间=[base, base×11/9]：截图区间 12.8~15.7 = base 12.816 × [1, 11/9] 实证（不是 ±10%）
  const base = st.baseValue * 100 * omegaAtt * traitMult * (rank + 1);
  const ends = [base, base * (11 / 9)];
  return {
    tag,
    short: st.shortString,
    value: base * (1 + (2 / 9) * roll),
    min: Math.min(...ends),
    max: Math.max(...ends),
    rollPct: Math.round(roll * 100),
  };
}

// 指纹整卡复算：buffs/curses 全词条 + 满级口径（fusionLimit）
export function appraiseFingerprint(fp, itemType, table) {
  const typeData = table?.dataByRivenInternalID?.[itemType];
  const ws = fp?.compat ? table?.weaponStats?.[fp.compat] : null;
  const nBuffs = fp?.buffs?.length || 0;
  const nCurses = fp?.curses?.length || 0;
  const mod = table?.modifiersBasedOnTraitCount?.find((m) => m.goodModifiersCount === nBuffs && m.badModifiersCount === nCurses);
  const rank = typeData?.fusionLimit ?? 8;
  const ctx = (curse) => ({
    stats: typeData?.rivenStats,
    omegaAtt: ws?.omegaAtt,
    traitMult: curse ? mod?.badModifierMultiplier : mod?.goodModifierMultiplier,
    rank,
  });
  return {
    weaponEn: ws?.name || null,
    omegaAtt: ws?.omegaAtt ?? null,
    rank,
    buffs: (fp?.buffs || []).map((b) => appraiseAttr(b.Tag, b.Value, ctx(false))),
    curses: (fp?.curses || []).map((c) => ({ ...appraiseAttr(c.Tag, c.Value, ctx(true)), curse: true })),
  };
}

// 字母评级（本工具口径，页脚注明）：按洗练位置分档；负词条反转（毛病越轻评级越高）
// ⚠ AlecaFrame 的分档函数在 C# 插件里（4 观测点反推无唯一解），不逐字母对齐
export function gradeOf(rollPct, curse = false) {
  const p = curse ? 100 - rollPct : rollPct;
  const bands = [[92, 'S'], [70, 'A'], [42, 'B'], [18, 'C'], [6, 'D']];
  for (let i = 0; i < bands.length; i++) {
    if (p >= bands[i][0]) {
      const letter = bands[i][1];
      if (letter === 'S') return 'S';
      const hi = i === 0 ? 100 : bands[i - 1][0];
      const pos = (p - bands[i][0]) / (hi - bands[i][0]);
      return pos >= 0.67 ? `${letter}+` : pos < 0.33 ? `${letter}-` : letter;
    }
  }
  return 'F';
}

// 神卡判定（AlecaFrame 红星同款社区表）：某组 mandatory ⊆ buffs 且 buffs ⊆ mandatory∪optional，且负词条全在可接受列表
export function isGodRoll(fp, weaponStats) {
  const gr = weaponStats?.goodRolls;
  if (!gr) return false;
  const buffs = (fp?.buffs || []).map((b) => b.Tag);
  const curses = (fp?.curses || []).map((c) => c.Tag);
  const groupOk = (gr.goodAttrs || []).some((group) => (group.mandatory || []).every((m) => buffs.includes(m))
    && buffs.every((b) => (group.mandatory || []).includes(b) || (group.optional || []).includes(b)));
  return groupOk && curses.every((c) => (gr.acceptedBadAttrs || []).includes(c));
}

// 紫卡名重建：buffs 按 Value 降序 → 前缀…+末位后缀（Hera-vexido：hera+vexi+do 实证）；缺前后缀返回 null
export function rivenName(fp, itemType, table) {
  const stats = table?.dataByRivenInternalID?.[itemType]?.rivenStats;
  const buffs = [...(fp?.buffs || [])].sort((a, b) => b.Value - a.Value);
  if (!stats || buffs.length < 2) return null;
  const parts = buffs.map((b, i) => (i === buffs.length - 1 ? stats[b.Tag]?.suffixTag : stats[b.Tag]?.prefixTag));
  if (parts.some((p) => !p)) return null;
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  return buffs.length === 2 ? `${cap(parts[0])}${parts[1]}` : `${cap(parts[0])}-${parts.slice(1).join('')}`;
}

// ==== 装配 ====

export async function assembleRivens({ inventory, table, attrZh = {}, lang = null, veiledPrices = {} }) {
  const zhOf = (tag, fallback) => attrZh[tag] || fallback || tag;
  const weaponZh = (compat) => lang?.[compat]?.zh?.name || null;

  const unveiled = [];
  for (const u of inventory?.Upgrades || []) {
    if (!/\/Randomized\//u.test(u.ItemType || '')) continue;
    let fp;
    try { fp = JSON.parse(u.UpgradeFingerprint || '{}'); } catch { continue; }
    if (!fp.compat) {
      // Upgrades 里也可能有未开封（带 challenge 指纹）
      unveiled.push(null);
      continue;
    }
    const appraised = appraiseFingerprint(fp, u.ItemType, table);
    const ws = table?.weaponStats?.[fp.compat];
    unveiled.push({
      compat: fp.compat,
      weaponZh: weaponZh(fp.compat) || appraised.weaponEn || fp.compat.split('/').pop(),
      weaponEn: appraised.weaponEn,
      name: rivenName(fp, u.ItemType, table),
      polarity: POLARITY_ZH[fp.pol] || fp.pol || '?',
      rerolls: fp.rerolls || 0,
      mr: fp.lvlReq || 8,
      omegaAtt: appraised.omegaAtt,
      rank: appraised.rank,
      god: isGodRoll(fp, ws),
      attrs: [...appraised.buffs, ...appraised.curses].map((attr) => ({
        ...attr,
        zh: zhOf(attr.tag, attr.short),
        grade: attr.value === null ? null : gradeOf(attr.rollPct, Boolean(attr.curse)),
      })),
    });
  }
  const opened = unveiled.filter(Boolean);

  // 未开封：RawUpgrades（纯计数）+ Upgrades 带 challenge 的
  const veiled = [];
  for (const u of inventory?.RawUpgrades || []) {
    if (!/\/Randomized\//u.test(u.ItemType || '')) continue;
    const meta = table?.dataByRivenInternalID?.[u.ItemType];
    const en = meta?.veiledName || u.ItemType.split('/').pop();
    veiled.push({ zh: VEILED_ZH[en] || en, en, count: u.ItemCount || 1, challenge: null, price: veiledPrices[en] ?? null });
  }
  for (const u of inventory?.Upgrades || []) {
    if (!/\/Randomized\//u.test(u.ItemType || '')) continue;
    let fp;
    try { fp = JSON.parse(u.UpgradeFingerprint || '{}'); } catch { continue; }
    if (fp.compat || !fp.challenge) continue;
    const meta = table?.dataByRivenInternalID?.[u.ItemType];
    const en = meta?.veiledName || u.ItemType.split('/').pop();
    veiled.push({
      zh: VEILED_ZH[en] || en, en, count: 1,
      challenge: { progress: fp.challenge.Progress || 0, required: fp.challenge.Required || 0 },
      price: veiledPrices[en] ?? null,
    });
  }

  // 排序：神卡在前，然后按洗练次数降序（投入多的排前面）
  opened.sort((a, b) => (b.god - a.god) || (b.rerolls - a.rerolls));
  return { opened, veiled, tableLoaded: Boolean(table) };
}

// ==== 卡片 ====
const C = { text: '#f3f5f7', sub: '#aeb9c4', dim: '#8f9aa6', green: '#67dfb8', gold: '#f0c765', cyan: '#72ded3', purple: '#c98add', red: '#e8837b' };

function rivenIcon() {
  // 头图标用官方紫卡符号素材（与未开封行同源，2026-08-06 用户点名）；缺素材退手绘 SVG
  if (RIVEN_MOD_ICON) return `<div class="brand-icon" style="display:grid;place-items:center"><img src="${RIVEN_MOD_ICON}" width="40" height="40" style="object-fit:contain"></div>`;
  return `<div class="brand-icon"><svg viewBox="0 0 24 24" fill="none" stroke="#c98add" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l7 4v8l-7 4-7-4V6z"/><path d="M12 8v4l3 2"/></svg></div>`;
}

const fmtVal = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;

// 等级色：S/A 金、B 绿、C 青、D/F 灰
const gradeColor = (grade) => /^S|^A/u.test(grade) ? C.gold : /^B/u.test(grade) ? C.green : /^C/u.test(grade) ? C.cyan : C.dim;

// 词条行：中文名 + 数值 + 等级徽章 + 区间迷你条（游标=roll 位置）
// 等级用固定宽徽章：裸文字居中时 S/B- 字符数不同视觉发歪（用户实锤）
function attrRow(attr) {
  const color = attr.curse ? C.red : C.green;
  if (attr.value === null) {
    return `<div style="height:26px;display:flex;align-items:center;gap:8px;padding-left:12px">
      <span style="font-size:12px;color:${C.sub}">${escapeHtml(attr.zh)}</span><span style="font-size:11px;color:${C.dim}">（数值表缺失）</span></div>`;
  }
  const pct = Math.max(0, Math.min(100, attr.rollPct));
  const gc = gradeColor(attr.grade);
  return `<div style="height:26px;display:grid;grid-template-columns:142px 70px 34px 1fr 96px;align-items:center;gap:8px;padding-left:12px">
    <span style="font-size:12.5px;color:${C.text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(attr.zh)}</span>
    <span style="font-size:13px;font-weight:900;color:${color};font-variant-numeric:tabular-nums;text-align:right">${fmtVal(attr.value)}</span>
    <span style="width:30px;height:18px;line-height:18px;border-radius:5px;font-size:11px;font-weight:900;color:${gc};border:1px solid ${gc};text-align:center;justify-self:center">${escapeHtml(attr.grade || '')}</span>
    <div style="position:relative;height:6px;background:rgba(255,255,255,.10);border-radius:3px;overflow:hidden">
      <div style="position:absolute;left:0;top:0;bottom:0;width:${pct}%;background:${color};opacity:.65"></div></div>
    <span style="font-size:10.5px;color:${C.dim};font-variant-numeric:tabular-nums;white-space:nowrap">${fmtVal(attr.min)} ~ ${fmtVal(attr.max)}</span></div>`;
}

export function buildRivenListCard(data, fetchedAt = new Date().toISOString()) {
  const blocks = data.opened.map((riven, index) => {
    const attrRows = riven.attrs.map(attrRow).join('');
    const chips = [
      riven.name ? `<span style="color:${C.purple};font-weight:800">${escapeHtml(riven.name)}</span>` : '',
      `极性 ${escapeHtml(riven.polarity)}`,
      `MR ${riven.mr}`,
      `洗练 ×${riven.rerolls}`,
      riven.omegaAtt ? `倾向 ×${riven.omegaAtt.toFixed(2)}` : '',
    ].filter(Boolean).join('<span style="color:#49535e">｜</span>');
    return `<div style="padding:10px 16px;border-bottom:1px solid rgba(176,123,55,.30);background:${index % 2 ? 'rgba(255,255,255,.035)' : 'rgba(255,255,255,.014)'}">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="width:26px;height:20px;line-height:20px;border-radius:6px;font-size:12px;font-weight:900;color:#131722;background:${C.gold};text-align:center;flex:0 0 auto">${index + 1}</span>
        ${riven.iconDataUri ? `<img src="${riven.iconDataUri}" style="width:38px;height:38px;object-fit:contain;flex:0 0 auto">` : ''}
        <span style="font-size:15px;font-weight:900;color:${C.text}">${escapeHtml(riven.weaponZh)}</span>
        ${riven.god ? `<span style="padding:1px 7px;border-radius:6px;font-size:11px;font-weight:900;color:#131722;background:${C.gold}">★ 神卡词条</span>` : ''}</div>
      <div style="margin-top:2px;font-size:11px;color:${C.sub}">${chips}</div>
      <div style="margin-top:6px">${attrRows}</div></div>`;
  }).join('');

  const veiledRows = data.veiled.map((v) => `<div style="height:34px;display:flex;align-items:center;gap:10px;padding:0 16px;border-bottom:1px solid rgba(176,123,55,.2)">
      ${RIVEN_MOD_ICON ? `<img src="${RIVEN_MOD_ICON}" style="width:24px;height:24px;object-fit:contain;flex:0 0 auto">` : ''}
      <span style="font-size:13px;color:${C.text}">${escapeHtml(v.zh)}</span>
      ${v.count > 1 ? `<span style="font-size:12px;color:${C.sub}">×${v.count}</span>` : ''}
      ${v.challenge ? `<span style="font-size:11.5px;color:${C.cyan}">开封挑战 ${v.challenge.progress}/${v.challenge.required}</span>` : `<span style="font-size:11.5px;color:${C.dim}">未接挑战</span>`}
      ${v.price != null ? `<span style="margin-left:auto;font-size:11px;color:${C.dim}">在售最低 </span>${currency('plat', v.price, { size: 12 })}` : ''}</div>`).join('');

  // 高度：块头 30（有图 40）+ chips 18 + 词条行 26×n + padding 20
  const blocksH = data.opened.reduce((sum, riven) => sum + (riven.iconDataUri ? 40 : 30) + 18 + riven.attrs.length * 26 + 22, 0);
  const veiledH = data.veiled.length ? 30 + data.veiled.length * 34 : 0;
  const height = 84 + 30 + blocksH + veiledH + 40 + (data.tableLoaded ? 0 : 24);
  const content = `<div class="card"><div class="header">${rivenIcon()}<div><div class="kicker">我的紫卡 · ${data.opened.length + data.veiled.reduce((n, v) => n + v.count, 0)} 张</div><div class="title">已开封 ${data.opened.length} · 未开封 ${data.veiled.reduce((n, v) => n + v.count, 0)}</div></div>
    <div class="header-meta"><strong>数值=满级口径</strong><span>条=洗练区间位置</span></div></div>
    <div class="section"><span class="section-badge" style="background:${C.purple}">紫卡</span>★=社区神卡词条表命中 · 等级=洗练位置分档（负词条越轻越高）<small>本工具口径，与 AlecaFrame 分档略有差异</small></div>
    ${data.tableLoaded ? '' : `<div style="padding:4px 16px;font-size:12px;color:${C.red}">⚠ 本机计算表缺失（AlecaFrame 未安装/未同步），仅显示词条不算数值</div>`}
    ${blocks}
    ${data.veiled.length ? `<div style="padding:8px 16px 2px;font-size:12px;font-weight:800;color:${C.dim}">未开封</div>${veiledRows}` : ''}
    <div class="footer"><span>计算表:AlecaFrame 本机 · 词条名:warframe.market · 数值=满级口径</span><span>${escapeHtml(new Date(fetchedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }))}</span></div></div>`;
  // key=模板版本+内容哈希：洗卡/开封后立刻出新图，改模板后 v 号打散缓存
  const keySeed = 'rivens-v10|' + data.opened.map((r) => `${r.compat}:${r.attrs.map((a) => a.rollPct).join(',')}:${r.rerolls}:${r.iconDataUri ? 'i' : 'x'}`).join('|')
    + `|veiled:${data.veiled.map((v) => `${v.zh}x${v.count}:${v.challenge?.progress ?? '-'}:${v.price ?? '-'}`).join(',')}`;
  return { html: documentShell(content, height, 800), width: 800, height, key: `rivens-${createHash('sha1').update(keySeed).digest('hex').slice(0, 12)}` };
}

// ==== Phase2：单武器详情（wm 拍卖行情 + 相似度估价） ====

// wm riven 武器目录：gameRef(compat 路径)→{slug, zh}；缓存 7d，失败空表
let weaponDirPromise = null;
export function getRivenWeaponDir() {
  weaponDirPromise ??= (async () => {
    try {
      const result = await staleCachedJson('riven-weapon-dir', { ttlMs: 7 * 24 * 3600 * 1000, version: 2 }, async () => {
        const response = await fetch('https://api.warframe.market/v2/riven/weapons', { headers: { 'User-Agent': 'Mozilla/5.0', Language: 'zh-hans' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!response.ok) throw new Error(`wm riven weapons HTTP ${response.status}`);
        const list = (await response.json()).data || [];
        const map = {};
        for (const w of list) map[w.gameRef] = { slug: w.slug, zh: w.i18n?.['zh-hans']?.name || w.i18n?.en?.name || w.slug, disposition: w.disposition, thumb: w.i18n?.['zh-hans']?.thumb || w.i18n?.en?.thumb || null };
        if (!Object.keys(map).length) throw new Error('riven 武器目录为空');
        return map;
      });
      return result.data;
    } catch {
      return {};
    }
  })();
  return weaponDirPromise;
}

// wm 词条 slug 表（估价用 gameRef→slug）；复用 attrZh 的缓存周期
let attrSlugPromise = null;
export function getRivenAttrSlug() {
  attrSlugPromise ??= (async () => {
    try {
      const result = await staleCachedJson('riven-attr-slug', { ttlMs: 7 * 24 * 3600 * 1000, version: 1 }, async () => {
        const response = await fetch(WM_ATTR_URL, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!response.ok) throw new Error(`wm attributes HTTP ${response.status}`);
        const map = {};
        for (const attr of (await response.json()).data || []) if (attr?.gameRef && attr?.slug) map[attr.gameRef] = attr.slug;
        if (!Object.keys(map).length) throw new Error('词条 slug 表为空');
        return map;
      });
      return result.data;
    } catch {
      return {};
    }
  })();
  return attrSlugPromise;
}

// 同武器在售拍卖（不缓存：行情要新鲜；失败返回 null 由调用方降级）
export async function fetchRivenAuctions(weaponSlug, fetcher = null) {
  try {
    const url = `https://api.warframe.market/v1/auctions/search?type=riven&weapon_url_name=${encodeURIComponent(weaponSlug)}&sort_by=price_asc`;
    const body = fetcher ? await fetcher(url) : await (async () => {
      const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`auctions HTTP ${response.status}`);
      return response.json();
    })();
    const auctions = body?.payload?.auctions;
    return Array.isArray(auctions) ? auctions : null;
  } catch {
    return null;
  }
}

const medianOf = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

// 相似度估价（纯函数）：三档 = 词条全同 / 正词条全同 / 共享≥2 正词条
// 估价实验结论（2026-08-05）：全同几乎恒 0，正全同 0~1 张且孤样本虚高，共享档才有样本量——
// 报「保守参考区间」= 共享档最低价 ~ 中位价，样本不足如实说
export function appraiseAgainstMarket(myPos, myNeg, auctions) {
  const enriched = (auctions || []).filter((a) => !a.closed && a.item).map((a) => ({
    price: a.buyout_price ?? a.starting_price,
    pos: new Set((a.item.attributes || []).filter((x) => x.positive).map((x) => x.url_name)),
    neg: new Set((a.item.attributes || []).filter((x) => !x.positive).map((x) => x.url_name)),
    rerolls: a.item.re_rolls || 0,
    online: a.owner?.status && a.owner.status !== 'offline',
  })).filter((a) => Number.isFinite(a.price) && a.price > 0);
  const mine = { pos: new Set(myPos), neg: new Set(myNeg) };
  const setEq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
  const shared = (a, b) => [...a].filter((x) => b.has(x)).length;
  const tiers = {
    exact: enriched.filter((a) => setEq(a.pos, mine.pos) && setEq(a.neg, mine.neg)),
    posSame: enriched.filter((a) => setEq(a.pos, mine.pos)),
    similar: enriched.filter((a) => shared(a.pos, mine.pos) >= Math.min(2, mine.pos.size || 1)),
  };
  const stat = (list) => list.length ? { n: list.length, low: Math.min(...list.map((x) => x.price)), median: medianOf(list.map((x) => x.price)) } : { n: 0, low: null, median: null };
  const best = tiers.posSame.length >= 3 ? tiers.posSame : tiers.similar;
  const bestStat = stat(best);
  // 相似卡面板（AlecaFrame Similar rivens 同款）：共享词条数降序 → 价格升序，取前 8
  const topSimilar = enriched
    .map((a) => ({ ...a, sharedCount: shared(a.pos, mine.pos) }))
    .filter((a) => a.sharedCount >= 1)
    .sort((x, y) => y.sharedCount - x.sharedCount || x.price - y.price)
    .slice(0, 8)
    .map((a) => ({
      price: a.price, rerolls: a.rerolls, online: a.online,
      attrs: [
        ...[...a.pos].map((slug) => ({ slug, positive: true, shared: mine.pos.has(slug) })),
        ...[...a.neg].map((slug) => ({ slug, positive: false, shared: mine.neg.has(slug) })),
      ],
    }));
  return {
    total: enriched.length,
    exact: stat(tiers.exact),
    posSame: stat(tiers.posSame),
    similar: stat(tiers.similar),
    // 保守估价：样本 <3 不给结论（挂价孤样本虚高，实验实证 300p 单张）
    estimate: bestStat.n >= 3 ? { low: bestStat.low, high: bestStat.median, basis: tiers.posSame.length >= 3 ? '正词条全同' : '共享词条' } : null,
    topSimilar,
  };
}

// 单武器/单张详情装配：序号（列表卡从上到下，商店序号同款交互）或 中英文武器名
export async function assembleRivenDetail(query, { inventory, table, attrZh = {}, lang = null, weaponDir = {}, attrSlug = {}, auctionFetcher = null }) {
  const all = await assembleRivens({ inventory, table, attrZh, lang });
  const norm = (s) => String(s || '').normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
  const q = norm(query);
  let mine;
  if (/^\d{1,2}$/u.test(q)) {
    // 序号直选：opened 排序与列表卡一致（同一 assembleRivens），1 起算
    const idx = Number(q) - 1;
    if (idx < 0 || idx >= all.opened.length) return { found: false, query, reason: `序号超出范围（已开封共 ${all.opened.length} 张）` };
    mine = [all.opened[idx]];
  } else {
    mine = all.opened.filter((r) => norm(r.weaponZh) === q || norm(r.weaponEn) === q
      || norm(r.weaponZh).includes(q) || norm(r.weaponEn || '').includes(q));
  }
  if (!mine.length) return { found: false, query };
  const compat = mine[0].compat;
  const dirEntry = weaponDir[compat] || null;
  // slug→中文：经 gameRef 中转（attrSlug: gameRef→slug，attrZh: gameRef→zh），相似卡词条显示用
  const slugZh = {};
  for (const [ref, slug] of Object.entries(attrSlug)) if (attrZh[ref]) slugZh[slug] = attrZh[ref];
  // 神卡词条参考（AlecaFrame Best attributes 同源社区表）：gameRef 翻中文
  const gr = table?.weaponStats?.[compat]?.goodRolls || null;
  const refZh = (ref) => attrZh[ref] || ref.replace(/^Weapon/u, '');
  const goodRolls = gr ? {
    groups: (gr.goodAttrs || []).map((group) => ({
      mandatory: (group.mandatory || []).map(refZh),
      optional: (group.optional || []).map(refZh),
    })),
    acceptedBad: (gr.acceptedBadAttrs || []).map(refZh),
  } : null;
  let market = null;
  if (dirEntry?.slug) {
    const auctions = await fetchRivenAuctions(dirEntry.slug, auctionFetcher);
    if (auctions) {
      // 每张卡各自算相似度（同武器多张时词条不同）
      market = mine.map((riven) => {
        const fp = { buffs: riven.attrs.filter((a) => !a.curse), curses: riven.attrs.filter((a) => a.curse) };
        const myPos = fp.buffs.map((b) => attrSlug[b.tag]).filter(Boolean);
        const myNeg = fp.curses.map((c) => attrSlug[c.tag]).filter(Boolean);
        return appraiseAgainstMarket(myPos, myNeg, auctions);
      });
    }
  }
  return { found: true, query, weaponZh: mine[0].weaponZh, weaponEn: mine[0].weaponEn, slug: dirEntry?.slug || null, thumb: dirEntry?.thumb || null, rivens: mine, market, goodRolls, slugZh };
}

// 详情卡：每张卡词条区 + 神卡词条参考 + 行情区 + 相似在售网格（AlecaFrame 详情页同款布局）
export function buildRivenDetailCard(data, fetchedAt = new Date().toISOString()) {
  const pill = (text, color, filled = false) => `<span style="display:inline-block;margin:2px 3px;padding:1px 8px;border-radius:6px;font-size:11px;font-weight:800;${filled ? `color:#131722;background:${color}` : `color:${color};border:1px solid ${color}`}">${escapeHtml(text)}</span>`;

  // 神卡词条参考板块（goodRolls 社区表翻中文）
  let goodRollsH = 0;
  let goodRollsBlock = '';
  if (data.goodRolls) {
    const groupRows = data.goodRolls.groups.map((group) => `<div style="display:flex;align-items:flex-start;gap:6px;padding:2px 0">
        <div style="flex:0 0 auto">${group.mandatory.map((name) => pill(name, C.purple, true)).join('')}</div>
        <div style="min-width:0">${group.optional.map((name) => pill(name, C.sub)).join('')}</div></div>`).join('');
    const badRow = data.goodRolls.acceptedBad.length ? `<div style="padding:2px 0"><span style="font-size:11px;color:${C.dim};margin-right:4px">可接受负词条</span>${data.goodRolls.acceptedBad.map((name) => pill(name, C.red)).join('')}</div>` : '';
    goodRollsH = 30 + data.goodRolls.groups.length * 30 + (badRow ? 28 : 0) + 12;
    goodRollsBlock = `<div style="padding:6px 16px 4px;border-bottom:1px solid rgba(176,123,55,.30)">
      <div style="font-size:12px;font-weight:800;color:${C.gold};margin-bottom:2px">神卡词条参考 <span style="font-weight:400;color:${C.dim}">紫=必带 · 灰=可选搭配 · 红=不减分的负词条（社区表）</span></div>
      ${groupRows}${badRow}</div>`;
  }

  const marketBlock = (m) => {
    if (!m) return `<div style="padding:6px 12px;font-size:12px;color:${C.dim}">行情拉取失败（wm 拍卖暂不可用）</div>`;
    // ⚠ currency() 返回 HTML，含图标的片段禁止再过 escapeHtml（会穿帮显示源码）
    const plat = (v) => currency('plat', v, { size: 11, weight: 800 });
    const tierLine = (label, s) => s.n ? `${escapeHtml(label)} ${s.n} 张 · 最低 ${plat(s.low)} · 中位 ${plat(s.median)}` : `${escapeHtml(label)} 无在售`;
    const est = m.estimate ? `<span style="color:${C.gold};font-weight:900">参考 </span>${currency('plat', `${m.estimate.low}~${m.estimate.high}`, { size: 13 })}<span style="color:${C.dim}">（${m.estimate.basis}，挂价口径）</span>` : `<span style="color:${C.dim}">相似样本不足，不给估价</span>`;
    return `<div style="padding:4px 12px 8px">
      <div style="font-size:12px;margin-bottom:2px">${est}</div>
      <div style="font-size:11px;color:${C.sub}">${tierLine('词条全同', m.exact)} ｜ ${tierLine('正词条全同', m.posSame)} ｜ ${tierLine('共享词条', m.similar)} ｜ 同武器在售 ${m.total}</div></div>`;
  };

  // 相似在售网格：4 列小卡；共享词条亮色，非共享压暗；负词条红
  const SIM_CARD_H = 128;
  const similarGrid = (m) => {
    const items = m?.topSimilar || [];
    if (!items.length) return { html: '', h: 0 };
    const zhOfSlug = (slug) => data.slugZh?.[slug] || slug.replace(/_/gu, ' ');
    const cards = items.map((item) => {
      const attrLines = item.attrs.map((attr) => {
        const color = attr.positive ? (attr.shared ? C.green : '#5d786d') : (attr.shared ? C.red : '#7a5a56');
        return `<div style="font-size:11px;line-height:15px;color:${color};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;${attr.shared ? 'font-weight:800' : ''}">${attr.positive ? '+' : '−'}${escapeHtml(zhOfSlug(attr.slug))}${attr.shared ? ' ✓' : ''}</div>`;
      }).join('');
      return `<div style="height:${SIM_CARD_H}px;border:1px solid rgba(201,138,221,.35);border-radius:8px;padding:6px 8px;background:rgba(201,138,221,.06);overflow:hidden">
        <div style="display:flex;align-items:center;margin-bottom:3px">
          ${currency('plat', item.price, { size: 12, color: C.gold })}
          <span style="margin-left:auto;font-size:10px;color:${C.dim}">洗${item.rerolls}${item.online ? ' · <span style="color:#67dfb8">在线</span>' : ''}</span></div>
        ${attrLines}</div>`;
    }).join('');
    const rows = Math.ceil(items.length / 4);
    return {
      html: `<div style="padding:6px 12px 10px">
        <div style="font-size:12px;font-weight:800;color:${C.purple};margin-bottom:4px">相似在售（共享词条数排序）<span style="font-weight:400;color:${C.dim}"> ✓=与我的卡同词条</span></div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px">${cards}</div></div>`,
      h: 30 + rows * (SIM_CARD_H + 8) + 10,
    };
  };

  let blocksH = 0;
  const blocks = data.rivens.map((riven, index) => {
    const m = Array.isArray(data.market) ? data.market[index] : null;
    const sim = similarGrid(m);
    blocksH += 30 + 18 + riven.attrs.length * 26 + 22 + 52 + sim.h;
    return `<div style="padding:10px 16px;border-bottom:1px solid rgba(176,123,55,.30);background:${index % 2 ? 'rgba(255,255,255,.035)' : 'rgba(255,255,255,.014)'}">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:15px;font-weight:900;color:${C.text}">${escapeHtml(riven.weaponZh)}</span>
        ${riven.name ? `<span style="font-size:13px;color:${C.purple};font-weight:800">${escapeHtml(riven.name)}</span>` : ''}
        ${riven.god ? `<span style="padding:1px 7px;border-radius:6px;font-size:11px;font-weight:900;color:#131722;background:${C.gold}">★ 神卡词条</span>` : ''}</div>
      <div style="margin-top:2px;font-size:11px;color:${C.sub}">极性 ${escapeHtml(riven.polarity)}｜MR ${riven.mr}｜洗练 ×${riven.rerolls}${riven.omegaAtt ? `｜倾向 ×${riven.omegaAtt.toFixed(2)}` : ''}</div>
      <div style="margin-top:6px">${riven.attrs.map(attrRow).join('')}</div>
      ${marketBlock(m)}${sim.html}</div>`;
  }).join('');

  const height = 128 + 30 + goodRollsH + blocksH + 40;
  // 头部改版（2026-08-06 用户拍板）：武器图横幅大盒（wm 武器图多为细长横图，方盒会显小）+武器名大标题；头高覆盖默认 84→128
  const headIcon = data.iconDataUri ? `<img src="${data.iconDataUri}" style="width:170px;height:96px;object-fit:contain;flex:0 0 auto">` : rivenIcon();
  const content = `<div class="card"><div class="header" style="height:128px;gap:18px">${headIcon}<div style="min-width:0"><div class="kicker">紫卡详情</div><div class="title" style="font-size:34px;line-height:44px">${escapeHtml(data.weaponZh)}</div></div>
    <div class="header-meta"><strong>估价=挂价口径</strong><span>成交价通常更低</span></div></div>
    <div class="section"><span class="section-badge" style="background:${C.purple}">行情</span>三档相似度：词条全同 / 正词条全同 / 共享≥2 正词条<small>样本 &lt;3 不给估价（孤样本虚高）</small></div>
    ${goodRollsBlock}
    ${blocks}
    <div class="footer"><span>行情:warframe.market 拍卖在售 · 神卡表:社区（44bananas）· 等级=本工具口径</span><span>${escapeHtml(new Date(fetchedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }))}</span></div></div>`;
  const keySeed = `riven-detail-v8|${data.slug}|${data.iconDataUri ? 'i' : 'x'}|${data.rivens.map((r) => r.attrs.map((a) => a.rollPct).join(',')).join('|')}|${String(fetchedAt).slice(0, 15)}`;
  return { html: documentShell(content, height, 800), width: 800, height, key: `riven-detail-${createHash('sha1').update(keySeed).digest('hex').slice(0, 12)}` };
}


// ==== CLI（探针）：node rivens.mjs [武器名] ====
async function main() {
  const { readSnapshot } = await import('./alecaframe.mjs');
  const { getLangTable } = await import('./wfdata.mjs');
  const { inventory, alecaDir } = await readSnapshot();
  const lang = await getLangTable({ alecaDir }).catch(() => null);
  const [table, attrZh] = await Promise.all([loadRivenTable(alecaDir), getRivenAttrZh()]);
  const data = await assembleRivens({ inventory, table, attrZh, lang });
  try {
    const prices = await getVeiledPrices(data.veiled.map((v) => v.en));
    for (const v of data.veiled) if (prices[v.en] != null) v.price = prices[v.en];
  } catch { /* 降级无价 */ }
  console.log(JSON.stringify(data.opened.map((r) => ({ w: r.weaponZh, name: r.name, god: r.god, attrs: r.attrs.map((a) => `${a.zh} ${a.value === null ? '?' : a.value.toFixed(1)}`) })), null, 1));
  console.log('veiled:', JSON.stringify(data.veiled));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
