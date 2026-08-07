#!/usr/bin/env node

// 环境自检（doctor）：逐项探测运行环境，输出功能矩阵——哪些功能全量可用、哪些降级、哪些不可用。
// 面向开源部署场景：新用户装完先跑一遍 `node doctor.mjs`，按矩阵补齐缺件。
// 只读探测，不改任何状态；网络探测各 8s 超时，全部失败也能跑完出报告。
//
// 检查分层：
//   [必需]   Node 版本 / 缓存目录可写 / 卡片目录可写
//   [渲染]   Chrome 或 Edge（headless 截图）；sharp（PNG 压缩，可选加分项）
//   [数据源] warframestat / browse.wf / oracle / warframe.market / 官方 worldState / AlecaFrame CDN
//   [本地]   AlecaFrame cachedData 词典与目录 json / lastData.dat 账号快照（个人功能）
//   [集成]   OpenClaw CLI（订阅 cron 管理）
//
// 退出码：0=核心功能可用（公开查询+卡片渲染），1=核心功能有缺件

import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROBE_TIMEOUT_MS = 8_000;

const results = [];
function record(section, name, status, note = '') {
  results.push({ section, name, status, note });
  const mark = { ok: '✅', warn: '⚠️', fail: '❌' }[status];
  console.log(`${mark} [${section}] ${name}${note ? ` — ${note}` : ''}`);
}

async function probeUrl(url) {
  try {
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Range: 'bytes=0-64' }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return response.ok || response.status === 206 ? { ok: true, status: response.status } : { ok: false, status: response.status };
  } catch (error) {
    return { ok: false, status: String(error?.cause?.code || error?.name || error?.message || error).slice(0, 60) };
  }
}

// ---------- [必需] ----------
const nodeMajor = Number(process.versions.node.split('.')[0]);
record('必需', `Node ${process.versions.node}`, nodeMajor >= 20 ? 'ok' : 'fail', nodeMajor >= 20 ? '' : '需要 Node 20+（内置 fetch/AbortSignal.timeout）');

async function checkWritable(label, dir) {
  try {
    await mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.doctor-probe-${Date.now()}`);
    await writeFile(probe, 'ok');
    await rm(probe, { force: true });
    record('必需', label, 'ok', dir);
    return true;
  } catch (error) {
    record('必需', label, 'fail', `${dir} 不可写（${String(error?.code || error?.message)}）`);
    return false;
  }
}
const cacheDir = process.env.WARFRAME_DATA_CACHE_DIR || path.resolve(here, '..', '..', '..', '.cache', 'warframe-data');
const cardDir = process.env.WARFRAME_CARD_DIR || path.resolve(here, '..', '..', '..', '.cache', 'warframe-cards');
const cacheOk = await checkWritable('数据缓存目录', cacheDir);
const cardOk = await checkWritable('卡片输出目录', cardDir);

// ---------- [渲染] ----------
let browserOk = false;
try {
  const { findBrowser } = await import(pathToFileURL(path.join(here, 'warframe-cards.mjs')).href);
  const browser = await findBrowser();
  browserOk = Boolean(browser);
  record('渲染', 'Chrome/Edge（headless 截图）', browserOk ? 'ok' : 'fail', browser || '未找到；装 Chrome/Edge，或设 WARFRAME_BROWSER 指向浏览器 exe');
} catch (error) {
  record('渲染', 'Chrome/Edge（headless 截图）', 'fail', `探测失败：${String(error?.message).slice(0, 80)}`);
}
const sharp = await import('sharp').then((m) => m.default).catch(() => null);
record('渲染', 'sharp（PNG 压缩）', sharp ? 'ok' : 'warn', sharp ? '' : '缺失不影响功能，卡片体积大 3~4 倍；skill 目录 npm i sharp 可装');

// ---------- [数据源] ----------
const sources = [
  ['warframestat（世界状态/掉落表）', 'https://api.warframestat.us/pc?only=timestamp'],
  ['browse.wf（官方导出/词典）', 'https://browse.wf/warframe-public-export-plus/dict.zh.json'],
  ['oracle.browse.wf（活动词典/赏金轮换）', 'https://oracle.browse.wf/min'],
  ['warframe.market（查价）', 'https://api.warframe.market/v2/items'],
  ['官方 worldState', 'https://api.warframe.com/cdn/worldState.php'],
  ['AlecaFrame CDN（词典目录兜底）', 'https://cdn.alecaframe.com/warframeData/json/Warframes.json'],
  ['relics.run（库存估值行情）', 'https://relics.run/'],
];
let sourceOkCount = 0;
for (const [label, url] of sources) {
  const probe = await probeUrl(url);
  if (probe.ok) sourceOkCount += 1;
  record('数据源', label, probe.ok ? 'ok' : 'warn', probe.ok ? '' : `不可达（${probe.status}）；对应功能降级或用缓存`);
}

// ---------- [本地 AlecaFrame] ----------
const alecaDir = process.env.ALECAFRAME_DATA_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'AlecaFrame');
let localDict = false;
let snapshotOk = false;
try {
  const lang = JSON.parse(await readFile(path.join(alecaDir, 'cachedData', 'json', 'lang.json'), 'utf8'));
  localDict = Object.keys(lang).length > 1000;
} catch { /* 无本地词典 */ }
record('本地', 'AlecaFrame 词典（lang.json）', localDict ? 'ok' : 'warn', localDict ? alecaDir : '缺失；公开功能自动走在线词典兜底（首次联网重建，约 2MB）');
try {
  await access(path.join(alecaDir, 'lastData.dat'));
  snapshotOk = true;
} catch { /* 无快照 */ }
record('本地', 'AlecaFrame 账号快照（lastData.dat）', snapshotOk ? 'ok' : 'warn', snapshotOk ? '' : '缺失；个人功能（库存/掉落/紫卡/周报打卡）不可用。装 AlecaFrame 并过一次游戏加载点即生成');

// 词典层端到端：实际走一次 getLangTable（本地或在线兜底）
let dictKeys = 0;
try {
  const { getLangTable } = await import(pathToFileURL(path.join(here, 'wfdata.mjs')).href);
  dictKeys = Object.keys(await getLangTable()).length;
} catch { /* 全挂 */ }
record('本地', '词典层端到端（本地→在线兜底）', dictKeys > 1000 ? 'ok' : 'fail', dictKeys > 1000 ? `${dictKeys} 条` : '本地与在线源均不可用，卡片译名将退英文');

// ---------- [集成 OpenClaw] ----------
const cliPath = process.env.OPENCLAW_CLI_PATH || path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'openclaw', 'openclaw.mjs');
let cliOk = false;
try { await access(cliPath); cliOk = true; } catch { /* 缺 CLI */ }
record('集成', 'OpenClaw CLI', cliOk ? 'ok' : 'warn', cliOk ? cliPath : '未找到；订阅 cron 自动管理不可用（查询功能不受影响），可设 OPENCLAW_CLI_PATH');

// ---------- 功能矩阵 ----------
const coreOk = nodeMajor >= 20 && cacheOk && cardOk && browserOk;
const dictOk = dictKeys > 1000;
console.log('\n════════ 功能矩阵 ════════');
const matrix = [
  ['世界状态查询（裂缝/仲裁/突击/赏金…）', coreOk && sourceOkCount >= 2 ? (dictOk ? '✅ 全量' : '⚠️ 可用（译名退英文）') : '❌'],
  ['warframe.market 查价', coreOk ? '✅（wm 不可达时用缓存快照）' : '❌'],
  ['裂缝/精炼推荐', coreOk && dictOk ? '✅' : coreOk ? '⚠️ 需词典（本地或在线兜底任一）' : '❌'],
  ['配方/词典查询', dictOk ? '✅' : '❌ 需词典'],
  ['个人功能（库存/掉落/紫卡/周报打卡/奸商购物）', snapshotOk ? '✅' : '❌ 需 AlecaFrame 快照'],
  ['订阅推送（cron）', cliOk ? '✅' : '⚠️ 需 OpenClaw CLI'],
  ['卡片渲染', browserOk ? (sharp ? '✅（含压缩）' : '⚠️ 无压缩') : '❌ 需 Chrome/Edge'],
];
for (const [feature, status] of matrix) console.log(`  ${status}  ${feature}`);

const failCount = results.filter((r) => r.status === 'fail').length;
console.log(`\n${failCount === 0 ? '核心环境完备。' : `有 ${failCount} 项硬缺件，见上方 ❌。`}`);
process.exit(coreOk ? 0 : 1);
