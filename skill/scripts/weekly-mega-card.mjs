// 周常一图流 v2「周报级」卡片 —— 按 K3 设计规范实现（正式版，weekly.mjs 装配数据后调用）
// 规范要点：1000px 逻辑宽 / scale 2 输出、深色底 + 圆角卡、6 板块、
//           每项任务「条件 + 奖励 + 打卡」三件套、图标全 SVG、零外网依赖。
// 词缀/奖励/译名的静态映射在同目录 weekly-static.json，版本更新手改 JSON 即可。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currency } from './warframe-cards.mjs';

// 源力石官方图标（AlecaFrame 素材已复制进 assets/archon-shards）：色名→base64，缺失退回 SVG 菱形
const SHARD_ICON_DATA = {};
for (const color of ['red', 'yellow', 'blue', 'green', 'orange', 'purple']) {
  try { SHARD_ICON_DATA[color] = `data:image/webp;base64,${readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'archon-shards', `${color}.webp`)).toString('base64')}`; } catch { SHARD_ICON_DATA[color] = null; }
}

const W = 1000;          // 页面逻辑宽
const MX = 32;           // 页面左右外边距
const CW = W - MX * 2;   // 内容区宽 936
const GAP = 20;          // 卡片间距

// —— K3 色板 ——
const C = {
  bg: '#14161D', card: '#1D2029', cardBorder: '#2A2E3C',
  text: '#E8EAF0', sub: '#9AA0B4', dim: 'rgba(154,160,180,.62)',
  cyan: '#4FC3F7', green: '#57C98B',
  archon: '#E0513C', deep: '#9B7EDE', temporal: '#F0B429',
  routine: '#57C98B', circuit: '#C0C8D8', nightwave: '#4FC3F7', shop: '#E0763C',
};

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
  .replace(/"/gu, '&quot;').replace(/'/gu, '&#39;');

// —— 通用小组件 ——

// 打卡徽章：纯序号变色（绿=已完成、灰=待完成、暗灰斜线=已跳过）；编号即「完成/跳过 n」命令的编号
function checkinBadge(number, done, compact = false, skipped = false) {
  const numberChip = skipped
    ? `<span style="display:inline-grid;place-items:center;min-width:34px;height:34px;padding:0 6px;border-radius:10px;background:rgba(107,114,132,.25);border:2px dashed #565D6E;color:#6B7284;font-size:20px;font-weight:900">${number}</span>`
    : done
      ? `<span style="display:inline-grid;place-items:center;min-width:34px;height:34px;padding:0 6px;border-radius:10px;background:${C.green};color:#0F1116;font-size:20px;font-weight:900">${number}</span>`
      : `<span style="display:inline-grid;place-items:center;min-width:34px;height:34px;padding:0 6px;border-radius:10px;background:rgba(138,146,166,.14);border:2px solid #6B7284;color:#8A92A6;font-size:20px;font-weight:900">${number}</span>`;
  return `<span style="display:inline-flex;align-items:center;gap:9px;flex:0 0 auto">${numberChip}
    ${compact ? '' : `<span style="font-size:16px;font-weight:800;color:${skipped ? '#565D6E' : done ? C.green : '#8A92A6'}">${skipped ? '已跳过' : done ? '已完成' : '待完成'}</span>`}</span>`;
}

// 已完成/已跳过时只暗正文区，标题/徽章保持全亮（K3 评审：缩略图下要一眼分清哪项已清）
const dimIf = (done, html) => (done ? `<div style="opacity:.5">${html}</div>` : html);

// 板块大标题：左侧彩色竖条 + 40px 粗体 + 右侧胶囊副标（学深色版参考图）
function sectionHeader(title, accent, tag = '', trailing = '') {
  return `<div style="height:88px;padding:28px 0 16px;display:flex;align-items:flex-end;gap:16px">
    <div style="width:8px;height:40px;border-radius:4px;background:${accent}"></div>
    <div style="font-size:40px;line-height:44px;font-weight:900;letter-spacing:1px;color:${C.text}">${escapeHtml(title)}</div>
    ${tag ? `<div style="margin-bottom:5px;padding:5px 14px;border:2px solid ${accent};border-radius:999px;font-size:18px;font-weight:800;color:${accent}">${escapeHtml(tag)}</div>` : ''}
    <div style="margin-left:auto;margin-bottom:5px">${trailing}</div>
  </div>`;
}

// 圆角卡容器；done 时保留左缘绿条作「已清」标记，不再整卡降透明度
function card(inner, { height, width = '100%', accent = null, done = false, pad = 24 } = {}) {
  return `<div style="position:relative;width:${typeof width === 'number' ? `${width}px` : width};${height ? `height:${height}px;` : ''}padding:${pad}px;background:${C.card};border:1px solid ${done ? 'rgba(87,201,139,.5)' : C.cardBorder};border-radius:14px;${accent ? `box-shadow:inset 0 2px 0 ${accent};` : ''}overflow:hidden">
    ${done ? `<div style="position:absolute;left:0;top:0;bottom:0;width:4px;background:${C.green}"></div>` : ''}${inner}</div>`;
}

// 奖励行：统一「奖励」标签 + 条目（名称粗体）；窄卡可降字号防截断
function rewardLines(items, accent = C.cyan, size = 20) {
  return items.map((item) => `<div style="font-size:${size}px;line-height:${size + 8}px;color:${C.text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><span style="color:${accent};font-weight:900;margin-right:8px">◆</span>${escapeHtml(item)}</div>`).join('');
}

// —— 顶部横幅：纯 CSS/SVG 造势，不依赖官方素材 ——
function banner(data) {
  const H = 216;
  // 抽象几何花瓣（自绘线稿，仅示意科幻感，不复刻官方 Logo）
  const petals = `<svg width="360" height="216" viewBox="0 0 360 216" fill="none" style="position:absolute;right:-20px;top:0;opacity:.22">
    <g stroke="${C.cyan}" stroke-width="1.5">
      <path d="M180 30 L230 108 L180 186 L130 108 Z"/>
      <path d="M180 52 L212 108 L180 164 L148 108 Z" opacity=".7"/>
      <path d="M96 62 L142 108 L96 154 L72 108 Z" opacity=".55"/>
      <path d="M264 62 L288 108 L264 154 L218 108 Z" opacity=".55"/>
      <circle cx="180" cy="108" r="86" opacity=".35"/>
      <circle cx="180" cy="108" r="6" fill="${C.cyan}" stroke="none" opacity=".8"/>
    </g></svg>`;
  return `<div style="position:relative;height:${H}px;overflow:hidden;background:linear-gradient(112deg,#14161D 34%,#1E2A44 78%,rgba(79,195,247,.13) 100%)">
    <div style="position:absolute;inset:0;opacity:.05;background-image:linear-gradient(rgba(255,255,255,.5) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.5) 1px,transparent 1px);background-size:34px 34px"></div>
    ${petals}
    <div style="position:relative;padding:40px ${MX}px 0">
      <div style="font-size:20px;letter-spacing:6px;font-weight:800;color:${C.cyan}">星际战甲 · 周报</div>
      <div style="margin-top:8px;font-size:56px;line-height:64px;font-weight:900;letter-spacing:2px;color:${C.text}">本周轮换 <span style="color:${C.cyan}">一图流</span></div>
      <div style="margin-top:10px;font-size:22px;color:${C.sub}">${escapeHtml(data.dateRange)} <span style="margin:0 10px;color:${C.dim}">｜</span> 每周一 08:00 重置（北京时间）</div>
    </div></div>`;
}

// —— S0 速览区：倒计时环 + 打卡进度 + 1999 日历（钢铁商店已移入独立「商店」模板）——
function quickRow(data) {
  const H = 168;
  const tileW = Math.floor((CW - GAP) / 2);
  // 倒计时圆环：标签单独一行，环居中，避免窄列里文字竖排
  const ratio = Math.max(0, Math.min(1, data.resetRemainMs / (7 * 86400000)));
  const r = 46, circumference = 2 * Math.PI * r;
  const ring = `<div style="height:100%;display:flex;flex-direction:column;align-items:center">
    <div style="width:100%;font-size:15px;color:${C.sub};white-space:nowrap">距周重置 · 周一 08:00</div>
    <svg width="104" height="104" viewBox="0 0 104 104" style="margin-top:8px">
      <circle cx="52" cy="52" r="${r}" fill="none" stroke="#2A2E3C" stroke-width="8"/>
      <circle cx="52" cy="52" r="${r}" fill="none" stroke="${C.cyan}" stroke-width="8" stroke-linecap="round"
        stroke-dasharray="${(circumference * ratio).toFixed(1)} ${circumference.toFixed(1)}" transform="rotate(-90 52 52)"/>
      <text x="52" y="48" text-anchor="middle" font-size="24" font-weight="900" fill="${C.text}">${escapeHtml(data.resetBig)}</text>
      <text x="52" y="70" text-anchor="middle" font-size="14" fill="${C.sub}">${escapeHtml(data.resetSmall)}</text>
    </svg></div>`;
  const progressPct = data.taskTotal ? Math.round((data.taskDone / data.taskTotal) * 100) : 0;
  const progress = `<div style="display:flex;flex-direction:column;justify-content:center;height:100%">
    <div style="font-size:16px;color:${C.sub}">本周打卡进度${data.taskSkipped ? `<span style="color:${C.dim}"> · 跳过 ${data.taskSkipped}</span>` : ''}</div>
    <div style="margin-top:6px;font-size:44px;line-height:48px;font-weight:900;color:${C.text}">${data.taskDone}<span style="font-size:24px;color:${C.sub}">/${data.taskTotal}</span></div>
    <div style="margin-top:12px;height:8px;border-radius:4px;background:#2A2E3C"><i style="display:block;width:${progressPct}%;height:8px;border-radius:4px;background:${C.green}"></i></div></div>`;
  // 1999 日历 tile 已删（信息与 S7 日历区重复，2026-08-06 用户拍板 3 变 2）
  const tiles = [ring, progress]
    .map((inner) => card(inner, { height: H, width: tileW, pad: 20 }))
    .join('');
  return { html: `<div style="display:flex;gap:${GAP}px;margin-top:${GAP}px">${tiles}</div>`, h: H + GAP };
}

// —— S1 执刑官猎杀：3 列任务链 + 源力石奖励条 ——
function archonSection(data) {
  const stageH = 150, rewardH = 64;
  const colW = Math.floor((CW - GAP * 2) / 3);
  const stages = data.archon.missions.map((mission, index) => card(`
    <div style="font-size:15px;letter-spacing:3px;color:${C.dim};font-weight:800">阶段 ${['一', '二', '三'][index] || index + 1}</div>
    <div style="margin-top:10px;font-size:27px;font-weight:900;color:${C.text}">${escapeHtml(mission.typeZh)}</div>
    <div style="margin-top:8px;font-size:18px;color:${C.sub};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(mission.nodeZh)}</div>`,
  { height: stageH, width: colW, pad: 20, accent: C.archon })).join('');
  const reward = `<div style="margin-top:16px;height:${rewardH}px;display:flex;align-items:center;gap:14px;padding:0 24px;background:rgba(224,81,60,.12);border:1px solid rgba(224,81,60,.45);border-radius:14px">
    ${SHARD_ICON_DATA[data.archon.shardIcon] ? `<img src="${SHARD_ICON_DATA[data.archon.shardIcon]}" width="34" height="34" style="object-fit:contain">` : `<svg width="26" height="26" viewBox="0 0 26 26"><path d="M13 1 L24 13 L13 25 L2 13 Z" fill="${data.archon.shardColor}"/></svg>`}
    <span style="font-size:20px;color:${C.sub}">通关奖励</span>
    <span style="font-size:22px;font-weight:900;color:${data.archon.shardColor}">${escapeHtml(data.archon.shard)}</span>
    <span style="font-size:19px;color:${C.text}">×1</span>
    <span style="margin-left:auto;font-size:17px;color:${C.dim}">有几率为强化型</span></div>`;
  const html = sectionHeader('执刑官猎杀', C.archon, data.archon.bossZh, checkinBadge(data.archon.number, data.archon.done, false, data.archon.skipped))
    + dimIf(data.archon.done || data.archon.skipped, `<div style="display:flex;gap:${GAP}px">${stages}</div>${reward}`);
  return { html, h: 88 + stageH + 16 + rewardH };
}

// —— S2 科研双联：每个科研一张全宽详情卡，铺全变体/风险/个人词缀的效果描述 ——
function labsSection(data) {
  const modLine = (tag, tagColor, mod, height = 30) => `
    <div style="height:${height}px;display:flex;align-items:center;gap:10px;padding-left:44px">
      <span style="flex:0 0 auto;padding:2px 9px;border-radius:6px;font-size:14px;font-weight:800;color:${tagColor};border:1px solid ${tagColor}">${tag}</span>
      <span style="flex:0 0 auto;font-size:17px;font-weight:850;color:${C.text}">${escapeHtml(mod.name)}</span>
      <span style="font-size:16px;color:${C.sub};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(mod.desc)}</span></div>`;
  const blockH = 42 + 32 + 30 + 30 + 14;
  const personalRows = Math.max(...data.labs.map((lab) => lab.personal.length));
  const bodyH = 48 + 46 + blockH * 3 + 34 + personalRows * 30 + 36;
  const cards = data.labs.map((lab) => {
    const blocks = lab.missions.map((mission, index) => `
      <div style="margin-top:${index ? 14 : 0}px;border-bottom:1px solid #262A38;padding-bottom:0">
        <div style="height:42px;display:flex;align-items:center;gap:12px">
          <span style="flex:0 0 auto;display:grid;place-items:center;width:30px;height:30px;border-radius:8px;border:2px solid ${lab.accent};color:${lab.accent};font-size:15px;font-weight:900">${index + 1}</span>
          <span style="font-size:22px;font-weight:900;color:${C.text}">${escapeHtml(mission.typeZh)}</span>
          <span style="font-size:15px;color:${C.dim};padding:2px 10px;border-radius:6px;background:rgba(255,255,255,.05)">${escapeHtml(mission.factionZh)}</span></div>
        ${modLine('变体', lab.accent, mission.deviation, 32)}
        ${mission.risks.map((risk) => modLine(risk.hard ? '精英风险' : '风险', risk.hard ? C.archon : C.sub, risk)).join('')}
      </div>`).join('');
    const personal = lab.personal.map((mod) => `
      <div style="height:30px;display:flex;align-items:center;gap:10px">
        <span style="flex:0 0 auto;color:${lab.accent};font-weight:900">◆</span>
        <span style="flex:0 0 auto;font-size:17px;font-weight:850;color:${C.text}">${escapeHtml(mod.name)}</span>
        <span style="font-size:16px;color:${C.sub};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(mod.desc)}</span></div>`).join('');
    const inner = `
      <div style="height:46px;display:flex;align-items:flex-start;justify-content:space-between">
        <div style="display:flex;align-items:baseline;gap:14px"><div style="font-size:24px;font-weight:900;color:${C.text}">${escapeHtml(lab.title)}</div>
        <div style="font-size:16px;color:${C.sub}">${escapeHtml(lab.place)}</div></div>
        ${checkinBadge(lab.number, lab.done, false, lab.skipped)}</div>
      ${dimIf(lab.done || lab.skipped, `${blocks}
      <div style="height:34px;margin-top:0;display:flex;align-items:flex-end;font-size:15px;letter-spacing:2px;color:${C.dim};font-weight:800">本周个人词缀（精英难度 · 每人随机分配）</div>
      ${personal}
      <div style="height:36px;display:flex;align-items:flex-end;gap:10px">
        <span style="font-size:15px;letter-spacing:2px;color:${C.dim};font-weight:800">奖励</span>
        <span style="font-size:18px;font-weight:800;color:${C.text}">${escapeHtml(lab.rewardLine)}</span></div>`)}`;
    return card(inner, { height: bodyH, accent: lab.accent, done: lab.done });
  }).join(`<div style="height:${GAP}px"></div>`);
  const html = sectionHeader('每周科研', C.deep)
    + cards;
  return { html, h: 88 + bodyH * 2 + GAP };
}

// —— S3 每周固定功课：衰退室 / 沉沦之地×2 / 击溃合一众，2×2 同构小卡 ——
function routineSection(data) {
  const colW = Math.floor((CW - GAP) / 2);
  const condRows = Math.max(...data.routines.map((item) => item.conditions.length));
  const rewardRows = Math.max(...data.routines.map((item) => item.rewards.length));
  const bodyH = 46 + 12 + condRows * 30 + 18 + 28 + rewardRows * 28 + 20;
  const cards = data.routines.map((item) => card(`
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;height:46px">
      <div style="font-size:21px;font-weight:900;color:${C.text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(item.title)}</div>${checkinBadge(item.number, item.done, true, item.skipped)}</div>
    ${dimIf(item.done || item.skipped, `<div style="margin-top:2px">${item.conditions.map((line) => `<div style="font-size:17px;line-height:30px;color:${C.sub};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">· ${escapeHtml(line)}</div>`).join('')}</div>
    <div style="margin-top:14px;font-size:15px;letter-spacing:2px;color:${C.dim};font-weight:800">奖励</div>
    <div style="margin-top:4px">${rewardLines(item.rewards, item.accent, 17)}</div>`)}`,
  { height: bodyH, width: colW, accent: item.accent, done: item.done, pad: 20 })).join('');
  const rows = Math.ceil(data.routines.length / 2);
  const html = sectionHeader('每周固定功课', C.routine)
    + `<div style="display:flex;flex-wrap:wrap;gap:${GAP}px">${cards}</div>`;
  return { html, h: 88 + bodyH * rows + GAP * (rows - 1) };
}

// —— S4 无尽回廊：普通/钢铁各自独立打卡；战甲 chips（已有标）+ 灵化武器 + 奖励轨道进度条 ——
// 轨道数据来自快照 EndlessXP（无快照/过期时 track=null 隐藏，卡高自适应）
function circuitTrackBar(track, accent) {
  if (!track) return { html: '', h: 0 };
  const barW = CW - 48;
  // 节点按序号均匀分布（XP 间距不均，按比例摆标签会重叠）；填充长度按已达档数+档内插值
  const n = track.nodes.length;
  const seg = 1 / n;
  let fill = 0;
  for (let i = 0; i < n; i++) {
    const prev = i === 0 ? 0 : track.nodes[i - 1].xp;
    if (track.earn >= track.nodes[i].xp) fill = (i + 1) * seg;
    else if (track.earn > prev) { fill = i * seg + seg * ((track.earn - prev) / (track.nodes[i].xp - prev)); break; }
    else break;
  }
  const dots = track.nodes.map((node, i) => {
    const x = ((i + 1) * seg * barW).toFixed(0);
    const fillColor = node.claimed ? C.green : node.reached ? '#F0B429' : '#2A2E3C';
    const border = node.claimed || node.reached ? 'none' : '2px solid #565D6E';
    return `<div style="position:absolute;left:${x}px;top:-5px;width:18px;height:18px;margin-left:-9px;border-radius:50%;background:${fillColor};${border === 'none' ? '' : `border:${border};`}display:grid;place-items:center;font-size:11px;font-weight:900;color:#0F1116">${node.claimed ? '✓' : ''}</div>`;
  }).join('');
  // 奖励明细两列：每档 状态点 + XP + 奖励名
  const half = Math.ceil(n / 2);
  const cols = [track.nodes.slice(0, half), track.nodes.slice(half)];
  const colHtml = cols.map((col) => `<div style="flex:1;min-width:0">${col.map((node) => `
    <div style="height:30px;display:flex;align-items:center;gap:8px">
      <span style="flex:0 0 auto;width:12px;height:12px;border-radius:50%;background:${node.claimed ? C.green : node.reached ? '#F0B429' : 'transparent'};${node.claimed || node.reached ? '' : 'border:2px solid #565D6E;'}"></span>
      <span style="flex:0 0 52px;font-size:14px;color:${C.dim};font-variant-numeric:tabular-nums;text-align:right">${node.xp}</span>
      <span style="font-size:16px;color:${node.claimed ? C.dim : C.text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(node.name)}</span></div>`).join('')}</div>`).join('');
  const trackH = 30 + 22 + half * 30 + 10;
  const html = `
    <div style="margin-top:14px;position:relative;height:30px">
      <div style="position:absolute;left:0;right:0;top:0;height:8px;border-radius:4px;background:#2A2E3C"></div>
      <div style="position:absolute;left:0;top:0;width:${(fill * barW).toFixed(0)}px;height:8px;border-radius:4px;background:${accent}"></div>
      <div style="position:absolute;left:0;right:0;top:0;height:8px">${dots}</div>
      <div style="position:absolute;right:0;top:16px;font-size:14px;color:${C.sub}">阶层经验 ${track.earn}/${track.goal}</div></div>
    <div style="margin-top:8px;display:flex;gap:24px">${colHtml}</div>`;
  return { html, h: 14 + trackH };
}

function circuitSection(data) {
  const chip = (text, color, tag = '') => `<span style="display:inline-flex;align-items:center;gap:8px;height:44px;padding:0 18px;border-radius:10px;border:2px solid ${color};font-size:20px;font-weight:800;color:${C.text};background:rgba(255,255,255,.04)">${escapeHtml(text)}${tag ? `<span style="font-size:13px;font-weight:900;color:${C.green};border:1px solid ${C.green};border-radius:6px;padding:1px 6px">${tag}</span>` : ''}</span>`;
  const normal = data.circuit.normal;
  const steel = data.circuit.steel;
  const normalTrack = circuitTrackBar(normal.track, C.cyan);
  const steelTrack = circuitTrackBar(steel.track, C.circuit);
  // 已选=本周轨道 Choices 已锁定的武器；已有=库存拥有该具体战甲（普通≠Prime）
  const chosenWeapons = new Set((steel.track?.choices || []).map((name) => String(name).toLowerCase()));
  const bodyH = 24 * 2 + 34 + 52 + 20 + 34 + 52 + 18 + 40 + normalTrack.h + steelTrack.h;
  const inner = `
    <div style="display:flex;align-items:center;justify-content:space-between;height:34px">
      <div style="font-size:18px;letter-spacing:2px;color:${C.dim};font-weight:800">普通回廊 · 本周战甲（三选一）${normal.progress ? `<span style=\"margin-left:12px;letter-spacing:0;color:${C.green}\">${escapeHtml(normal.progress)}</span>` : ''}</div>${checkinBadge(normal.number, normal.done, false, normal.skipped)}</div>
    ${dimIf(normal.done || normal.skipped, `<div style="margin-top:8px;display:flex;gap:12px">${data.circuit.frames.map((frame) => chip(frame.name, C.cyan, frame.owned ? '已有' : '')).join('')}</div>${normalTrack.html}`)}
    <div style="margin-top:20px;height:34px;display:flex;align-items:center;justify-content:space-between">
      <div style="font-size:18px;letter-spacing:2px;color:${C.dim};font-weight:800">钢铁回廊 · 本周灵化武器（五选二）${steel.progress ? `<span style=\"margin-left:12px;letter-spacing:0;color:${C.green}\">${escapeHtml(steel.progress)}</span>` : ''}</div>${checkinBadge(steel.number, steel.done, false, steel.skipped)}</div>
    ${dimIf(steel.done || steel.skipped, `<div style="margin-top:0;display:flex;gap:12px;flex-wrap:wrap">${data.circuit.weapons.map((weapon) => chip(weapon.name, C.circuit, chosenWeapons.has(String(weapon.key).toLowerCase()) ? '已选' : '')).join('')}</div>${steelTrack.html}
    <div style="margin-top:18px;display:flex;align-items:center;gap:10px;height:40px">
      <span style="font-size:15px;letter-spacing:2px;color:${C.dim};font-weight:800">奖励</span>
      <span style="font-size:20px;font-weight:850;color:${C.text}">灵化创世适配器 ×1</span>
      <span style="font-size:17px;color:${C.dim}">进度满后可继续选择下一把武器</span></div>`)}`;
  const bothDone = (normal.done || normal.skipped) && (steel.done || steel.skipped);
  const html = sectionHeader('无尽回廊', C.circuit)
    + card(inner, { height: bodyH, accent: C.circuit, done: bothDone });
  return { html, h: 88 + bodyH };
}

// —— S5 午夜电波：声望合计大字 + 赛季整宽进度条（回廊轨道样式）+ 周常/精英逐条中文（行级完成态）——
function nightwaveSection(data) {
  const rows = [...data.nightwave.weekly, ...data.nightwave.elite];
  const count = (label, value, color) => `<div style="flex:1;min-width:0"><div style="font-size:17px;color:${C.sub};white-space:nowrap">${label}</div><div style="margin-top:4px;font-size:30px;font-weight:900;color:${color};white-space:nowrap">${value}</div></div>`;
  const perItem = (value) => `${value}<span style="font-size:16px;font-weight:400;color:${C.sub}"> 声望/项</span>`;
  // 赛季总进度：整宽条（顶栏放不下第 4 格，2026-08-06 用户拍板下沉，样式对齐回廊轨道）
  // 等级=每 10000 声望一级（灰机 wiki 机制），条形填充=级内声望占比
  const seasonH = data.nightwave.season ? (data.nightwave.predict ? 100 : 74) : 0;
  const season = (() => {
    if (!data.nightwave.season) return '';
    const inLevel = data.nightwave.season.standing % 10000;
    const pct = Math.max(0, Math.min(100, (inLevel / 10000) * 100)).toFixed(1);
    // 奖励轨道满级 30（30 后每级转化为代币 ×15）
    const title = data.nightwave.season.title;
    const levelText = title >= 30
      ? `${title} 级<span style="font-size:16px;font-weight:400;color:${C.green}"> · 已满 30 级奖励轨道</span>`
      : `${title}<span style="font-size:17px;font-weight:700;color:${C.sub}">/30 级</span>`;
    const predictLine = data.nightwave.predict
      ? `<div style="margin-top:8px;font-size:16px;color:${C.dim}">📈 ${escapeHtml(data.nightwave.predict)}</div>`
      : '';
    return `<div style="margin-top:16px;height:${seasonH - 16}px">
      <div style="display:flex;align-items:baseline;gap:14px">
        <span style="font-size:15px;letter-spacing:2px;color:${C.dim};font-weight:800">赛季进度</span>
        <span style="font-size:24px;font-weight:900;color:${C.temporal}">${levelText}</span>
        <span style="font-size:16px;color:${C.sub};font-variant-numeric:tabular-nums">升级 ${inLevel.toLocaleString('en-US')}/10,000</span>
        <span style="margin-left:auto;font-size:16px;color:${C.sub};font-variant-numeric:tabular-nums">累计 ${data.nightwave.season.standing.toLocaleString('en-US')} 声望</span></div>
      <div style="margin-top:10px;height:8px;border-radius:4px;background:#2A2E3C"><i style="display:block;width:${pct}%;height:8px;border-radius:4px;background:${C.temporal}"></i></div>
      ${predictLine}</div>`;
  })();
  const bodyH = 24 * 2 + 84 + seasonH + 14 + rows.length * 46 + 34;
  // 行级三态：done=true ✓+压暗 / done=false 进度计数 / done=null（无快照）零装饰
  const rowState = (row) => row.done === true
    ? { deco: 'opacity:.48', tail: `<span style="margin-left:auto;flex:0 0 auto;font-size:16px;font-weight:900;color:${C.green}">✓ 已完成</span>` }
    : row.done === false
      ? { deco: '', tail: `<span style="margin-left:auto;flex:0 0 auto;font-size:16px;color:${C.sub};font-variant-numeric:tabular-nums">${row.cur}/${row.required}</span>` }
      : { deco: '', tail: '' };
  const inner = `
    <div style="display:flex;align-items:center;height:84px;background:rgba(79,195,247,.07);border:1px solid rgba(79,195,247,.3);border-radius:12px;padding:0 24px;gap:12px">
      ${count(`周常挑战 ×${data.nightwave.weekly.length}`, perItem(data.nightwave.weeklyStanding), C.cyan)}
      ${count(`精英挑战 ×${data.nightwave.elite.length}`, perItem(data.nightwave.eliteStanding), C.deep)}
      ${count(`本周合计`, `${data.nightwave.totalStanding}`, C.green)}
      <div style="align-self:center">${checkinBadge(data.nightwave.number, data.nightwave.done, false, data.nightwave.skipped)}</div></div>
    ${season}
    ${dimIf(data.nightwave.done || data.nightwave.skipped, `<div style="margin-top:14px">
      ${rows.map((row) => { const st = rowState(row); return `<div style="height:46px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #262A38;${st.deco}">
        <span style="flex:0 0 auto;padding:3px 10px;border-radius:6px;font-size:15px;font-weight:800;${row.elite ? `color:${C.deep};border:1px solid ${C.deep}` : `color:${C.cyan};border:1px solid ${C.cyan}`}">${row.elite ? '精英' : '周常'}</span>
        <span style="font-size:20px;color:${C.text};font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(row.zh)}</span>
        <span style="flex:0 0 auto;font-size:18px;color:${C.sub};font-variant-numeric:tabular-nums;margin-left:6px">${row.standing} 声望</span>
        ${st.tail}</div>`; }).join('')}</div>
    <div style="margin-top:10px;height:24px;font-size:16px;color:${C.dim}">另有每日挑战 ×${data.nightwave.dailyCount}（每项 ${data.nightwave.dailyStanding} 声望，每天轮换）</div>`)}`;
  const html = sectionHeader('午夜电波', C.nightwave, data.nightwave.progress ? `已完成 ${data.nightwave.progress.replace(/^周挑战\s*/u, '')}` : '周常挑战')
    + card(inner, { accent: C.nightwave, done: data.nightwave.done, height: bodyH });
  return { html, h: 88 + bodyH };
}

// —— S6 轮换商店板块已移入独立「商店」模板（vendor-shop-card.mjs，2026-08-05）——

// —— S7 1999 日历：整宽，大奖/挑战/增益按日期顺序混排；v5 接快照进度三态（完成✓暗/当前高亮/未来常规） ——
function calendarSection(data) {
  const schedule = data.calendar.schedule || [];
  const rowH = (day) => day.type === 'prize' ? 48 : day.type === 'todo' ? day.lines.length * 40 : 34 + day.lines.length * 34;
  const scheduleH = schedule.reduce((sum, day) => sum + rowH(day), 0);
  const bodyH = 24 * 2 + scheduleH + 14 + 30;
  const typeMeta = { prize: { color: C.temporal, tag: '大奖' }, todo: { color: C.green, tag: '挑战' }, override: { color: C.cyan, tag: '增益三选一' } };
  // 三态装饰：完成=整行压暗+绿✓；当前=金底高亮+「当前」徽；无快照进度时 state 空串零装饰
  const deco = (day) => day.state === 'done'
    ? { row: 'opacity:.48', tag: `<span style="flex:0 0 auto;font-size:15px;font-weight:900;color:${C.green}">✓</span>` }
    : day.state === 'current'
      ? { row: 'background:rgba(240,180,41,.10);border-radius:8px', tag: `<span style="flex:0 0 auto;padding:2px 8px;border-radius:6px;font-size:13px;font-weight:900;color:#131722;background:${C.temporal}">当前</span>` }
      : { row: '', tag: '' };
  const rows = schedule.map((day) => {
    const meta = typeMeta[day.type];
    const state = deco(day);
    if (day.type === 'prize') {
      return `<div style="height:48px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #262A38;${state.row}">
        <span style="flex:0 0 72px;font-size:18px;font-weight:900;color:${meta.color};font-variant-numeric:tabular-nums">${escapeHtml(day.dateZh)}</span>
        <span style="flex:0 0 auto;padding:2px 8px;border-radius:6px;font-size:13px;font-weight:800;color:${meta.color};border:1px solid ${meta.color}">${meta.tag}</span>${state.tag}
        <span style="font-size:18px;color:${C.text};font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(day.lines[0])}</span></div>`;
    }
    if (day.type === 'todo') {
      return day.lines.map((line) => `<div style="height:40px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #262A38;${state.row}">
        <span style="flex:0 0 72px;font-size:17px;font-weight:900;color:${meta.color};font-variant-numeric:tabular-nums">${escapeHtml(day.dateZh)}</span>
        <span style="flex:0 0 auto;padding:2px 8px;border-radius:6px;font-size:13px;font-weight:800;color:${meta.color};border:1px solid ${meta.color}">${meta.tag}</span>${state.tag}
        <span style="font-size:17px;color:${C.text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(line)}</span></div>`).join('');
    }
    return `<div style="height:34px;display:flex;align-items:center;gap:12px;${state.row}">
        <span style="flex:0 0 72px;font-size:17px;font-weight:900;color:${meta.color};font-variant-numeric:tabular-nums">${escapeHtml(day.dateZh)}</span>
        <span style="flex:0 0 auto;padding:2px 8px;border-radius:6px;font-size:13px;font-weight:800;color:${meta.color};border:1px solid ${meta.color}">${meta.tag}</span>${state.tag}</div>`
      // override 行是 {text, chosen} 对象：已选项亮金★，同日其余选项再压暗一档
      + day.lines.map((line) => {
        const text = typeof line === 'string' ? line : line.text;
        const chosen = typeof line === 'object' && line.chosen;
        const dimStyle = day.state === 'done' ? (chosen ? 'opacity:.78' : 'opacity:.38') : '';
        const mark = chosen ? `<span style="flex:0 0 auto;padding:1px 7px;border-radius:6px;font-size:12px;font-weight:900;color:#131722;background:${C.temporal}">已选</span>` : '';
        return `<div style="height:34px;display:flex;align-items:center;gap:8px;padding-left:84px;border-bottom:1px solid #262A38;${dimStyle}">
        <span style="color:${chosen ? C.temporal : meta.color};font-weight:900">${chosen ? '★' : '◇'}</span>
        <span style="font-size:16px;color:${chosen ? C.text : C.sub};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(text)}</span>${mark}</div>`;
      }).join('');
  }).join('');
  const progress = data.calendar.progress;
  const upgradeNote = progress?.upgradeCount ? `；今年已选增益 ×${progress.upgradeCount}` : '';
  const inner = `${rows}
    <div style="margin-top:14px;font-size:16px;color:${C.dim}">日期为游戏内 1999 赛季历，随赛季依次推进；增益三选一当日生效${upgradeNote}</div>`;
  const headerMeta = progress ? `节点 ${progress.doneCount}/${progress.totalCount} · 大奖日 ×${data.calendar.prizeDayCount}` : `大奖日 ×${data.calendar.prizeDayCount}`;
  const html = sectionHeader('1999 日历', C.temporal, headerMeta, checkinBadge(data.calendar.number, data.calendar.done, false, data.calendar.skipped))
    + card(dimIf(data.calendar.done || data.calendar.skipped, inner), { height: bodyH, accent: C.temporal, done: data.calendar.done });
  return { html, h: 88 + bodyH };
}

// —— 页面组装 ——
export function buildWeeklyMegaCard(data) {
  const sections = [quickRow(data), archonSection(data), labsSection(data), routineSection(data), circuitSection(data), nightwaveSection(data), calendarSection(data)];
  const footerH = 76;
  const height = 216 + sections.reduce((sum, section) => sum + section.h, 0) + footerH + 28;
  const footer = `<div style="height:${footerH}px;margin-top:28px;display:flex;align-items:center;justify-content:space-between;padding:0 ${MX}px;border-top:1px solid ${C.cardBorder}">
    <span style="font-size:16px;color:${C.dim}">数据：公共世界状态 · 完成度：本地记录${data.autoNote ? ` · ${escapeHtml(data.autoNote)}` : ''} · 生成于 ${escapeHtml(data.generatedAt)}</span>
    <span style="font-size:16px;color:${C.sub};font-weight:700">打卡：完成 1 3｜撤销 3｜跳过 5｜取消跳过 5｜清空周常</span></div>`;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0}html,body{width:${W}px;background:${C.bg}}
    body{font-family:"Microsoft YaHei UI","Microsoft YaHei",Arial,sans-serif;color:${C.text};height:${height}px;overflow:hidden}
  </style></head><body>
    ${banner(data)}
    <div style="padding:0 ${MX}px">${sections.map((section) => section.html).join('')}</div>
    ${footer}
  </body></html>`;
  const keySeed = `weekly-mega-v9|${data.weekStart}|${data.taskDone}|${data.taskSkipped || 0}|${data.generatedAt}`;
  return { html, width: W, height, scale: 2, key: `weekly-mega-${createHash('sha1').update(keySeed).digest('hex').slice(0, 12)}` };
}
