#!/usr/bin/env node

// 1999 日历增益译名兜底层（2026-08-27）：未知路径/缺效果 inbox + AI 查证学习词典。
//
// 背景：DE 官方语言键与公开导出不含 1999 日历增益名（/Lotus/Upgrades/Calendar/* 在
// dict.en/dict.zh、lang.json、ExportUpgrades 全部查无），周报已接入社区维护状态中文表
// （KingPrimes/DataSource + 内置补充表）。但新赛季推出的新增益路径（如 PunchToPrimary、
// CompanionsBuffNearbyPlayer）在社区表收录前会落「新增日历增益（上游尚未提供中文说明）」。
// 本层把全链查无的未知路径排队进日历专属 inbox，由每日 AI 定时任务用灰机wiki「1999日历」页
// 六人组覆写表查证（用户核验的中文源），有据的 learn 回填学习词典（双语名 + 效果 + 来源），
// 查无实据的 dismiss。词典只补缺、绝不覆盖静态/社区结果，卡片上永远是有据的译名。
//
// 词典文件：.cache/warframe-data/calendar-upgrade-zh.json
//   { "version": 1, "entries": { "<path-lower>": { "name": "...", "desc": "...", "source": "...", "at": ms } } }
// 键一律为完整路径小写（与 weekly.mjs calendarUpgradeEntry 的学习词典查询同键）。
//
// 写入/出队契约（与 reward-zh-fallback.mjs 同款 2026-08-22 修复口径）：
//   · 热路径 queuePendingCalendarUpgrade 保持静默：失败绝不影响主流程（fire-and-forget）。
//   · learnCalendarUpgradeVerified / CLI learn 只有在确认「词典（含种子）已存在同键同译名」
//     （outcome=exists-same）或「本次原子落盘成功」（outcome=written|updated）后才出 inbox
//     并返回 ok:true；写入失败、已有同键不同译名（outcome=conflict）、种子权威键
//     （outcome=seed）、静态/社区已覆盖（outcome=covered）一律返回 ok:false 且 inbox 条目
//     原样保留、绝不误出队，错误信息写明安全处置方式（dismiss 或下轮重试）。
//
// 持久化并发（复用 reward-zh-fallback 的成熟 pattern）：临时文件 rename 原子落盘；
// 入队/出队/清空共用同一条串行队列，先入队后 dismiss 不会复活条目；
// 多进程并发时最坏是丢失一次更新，文件不会损坏。

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CALENDAR_STATE_SUPPLEMENT } from './wfdata.mjs';

// 缓存目录延迟解析：模块 import 时不锁定目录（测试必须先用临时目录隔离，2026-08-21 教训）。
const DEFAULT_DATA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.cache', 'warframe-data',
);
function dataDir() {
  return process.env.WARFRAME_DATA_CACHE_DIR || DEFAULT_DATA_DIR;
}
function learnFile() {
  return path.join(dataDir(), 'calendar-upgrade-zh.json');
}
function inboxFile() {
  return path.join(dataDir(), 'calendar-upgrade-inbox.json');
}

function normalizeKey(value) {
  return String(value || '').normalize('NFKC').replace(/[\u3000\s]+/gu, ' ').trim().toLowerCase();
}

function normalizeEntryText(value) {
  return String(value || '').normalize('NFKC').replace(/[\u3000\s]+/gu, ' ').trim();
}

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/u;

// —— 种子权威条目：weekly-static.json 的日历路径表（灰机wiki 1999日历 用户核验）——
// 学习文件只补缺，绝不覆盖种子；键 = 完整路径小写。
const STATIC_UPGRADE_PATHS = JSON.parse(readFileSync(new URL('./weekly-static.json', import.meta.url), 'utf8')).calendarUpgradeZhByPath || {};
export const CALENDAR_UPGRADE_SEEDS = Object.freeze(Object.fromEntries(
  Object.entries(STATIC_UPGRADE_PATHS).map(([upgradePath, value]) => {
    const entry = typeof value === 'string' ? { name: value, desc: '' } : value;
    return [normalizeKey(upgradePath), Object.freeze({ name: normalizeEntryText(entry.name), desc: normalizeEntryText(entry.desc || ''), source: '灰机wiki 1999日历（静态表）' })];
  }),
));

async function readLearned() {
  try {
    const raw = JSON.parse(await readFile(learnFile(), 'utf8'));
    return raw && typeof raw === 'object' && raw.entries ? raw.entries : {};
  } catch {
    return {};
  }
}

// 原子落盘：先写同目录临时文件再 rename，崩溃/中断不会留下半个 JSON（与 reward-zh 同款）。
async function atomicWriteJson(file, payload) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
  try {
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

let learnedPromise = null;
async function loadLearned() {
  learnedPromise ??= (async () => await readLearned())();
  return learnedPromise;
}

// 返回 Map<路径小写, {name, desc, source}>（仅学习词典，不含种子/静态/社区表）
export async function getLearnedCalendarUpgradeEntries() {
  const entries = await loadLearned();
  return new Map(Object.entries(entries).map(([key, entry]) => [key, {
    name: normalizeEntryText(entry.name || ''),
    desc: normalizeEntryText(entry.desc || ''),
    source: normalizeEntryText(entry.source || ''),
  }]));
}

// 持久化串行队列：热路径 learn 与 verified learn 共用，避免读改写交错丢更新。
let persistQueue = Promise.resolve();
function enqueuePersist(task) {
  const run = persistQueue.then(task);
  persistQueue = run.catch(() => {});
  return run;
}

function sameEntry(entry, name, desc) {
  return entry.name === name && (entry.desc || '') === desc;
}

// 内部持久化原语（串行队列内执行；写入失败直接抛出，由调用方决定吞错还是报错）：
//   { status: 'written' }            → 本次原子落盘成功（新条目）
//   { status: 'updated' }            → 同名条目补上缺失的效果说明（不是覆盖，是补缺）
//   { status: 'exists-same' }        → 词典已存在同键同译名，无需写入
//   { status: 'conflict', existing } → 词典已有同键不同译名/效果，绝不覆盖
//   { status: 'seed', existing }     → 种子权威键且不一致，绝不覆盖
async function persistLearnedEntryInner(key, name, desc, source) {
  const entries = await readLearned();
  const existing = entries[key];
  if (existing) {
    const existingEntry = { name: normalizeEntryText(existing.name || ''), desc: normalizeEntryText(existing.desc || '') };
    if (sameEntry(existingEntry, name, desc)) return { status: 'exists-same', existing: existingEntry };
    if (existingEntry.name === name && !existingEntry.desc && desc) {
      // 只补效果说明：效果缺失时允许完成条目（名称不变，不算覆盖）
      entries[key] = { name, desc, source, at: Date.now() };
      await atomicWriteJson(learnFile(), { version: 1, entries });
      return { status: 'updated', existing: existingEntry };
    }
    return { status: 'conflict', existing: existingEntry };
  }
  const seed = CALENDAR_UPGRADE_SEEDS[key];
  if (seed) {
    if (sameEntry(seed, name, desc)) return { status: 'exists-same', existing: seed };
    if (seed.name === name && !seed.desc && desc) {
      entries[key] = { name, desc, source, at: Date.now() };
      await atomicWriteJson(learnFile(), { version: 1, entries });
      return { status: 'updated', existing: seed };
    }
    return { status: 'seed', existing: seed };
  }
  entries[key] = { name, desc, source, at: Date.now() };
  await atomicWriteJson(learnFile(), { version: 1, entries });
  return { status: 'written', existing: null };
}

// 热路径：把全链查无的未知日历增益路径写进 inbox（异步静默，永不 reject）。
export function queuePendingCalendarUpgrade(upgradePath) {
  const key = normalizeKey(upgradePath);
  if (!key || !key.includes('/')) return inboxQueue;
  return enqueueInbox(async () => {
    try {
      const items = await readInboxItems();
      if (!items[key] && Object.keys(items).length >= INBOX_MAX_ITEMS) {
        const oldest = Object.entries(items).sort((left, right) => (left[1].lastAt || 0) - (right[1].lastAt || 0))[0];
        if (oldest) delete items[oldest[0]];
      }
      const previous = items[key] || {};
      items[key] = { firstAt: previous.firstAt ?? Date.now(), lastAt: Date.now(), count: (previous.count || 0) + 1 };
      await writeInboxItems(items);
    } catch { /* inbox 不可用不影响主流程 */ }
  });
}

function validateLearnInputs(key, name, desc) {
  if (!key || !name) return 'path 与 name 均不能为空';
  if (!/[a-z]/u.test(key) || !key.includes('/')) return 'path 必须是完整的 DE 内部路径';
  if (!CJK_RE.test(name) || /[A-Za-z]{2,}/u.test(name)) return '译名必须为纯中文，禁止夹带英文';
  // 效果说明允许暂缺（诚实：漂移分析记 effectMissing，后续同键 learn 可补缺 updated）；
  // 非空时必须为中文说明，官方简中保留的拉丁专名（Tenno/Prime 等）不作为英文参量
  if (!desc) return null;
  if (!CJK_RE.test(desc)) return '效果说明必须为中文说明';
  const latinLetters = (desc.match(/[A-Za-z]/gu) || []).length;
  const cjkChars = (desc.match(/[\u3400-\u4dbf\u4e00-\u9fff]/gu) || []).length;
  if (latinLetters > cjkChars) return '效果说明不允许以英文为主（官方简中保留的拉丁专名如 Tenno/Prime 除外）';
  return null;
}

// 查证回填入口（供 AI 定时任务/CLI 调用）：只有确认落盘后才出 inbox，绝不先出队后写。
// 返回契约（ok:false 时 inbox 条目一律保留未出队，绝不误丢）：
//   ok:true  outcome='written'     本次原子落盘成功，已出队
//   ok:true  outcome='updated'     同名条目补上缺失效果说明，已出队（补缺不是覆盖）
//   ok:true  outcome='exists-same' 词典（含种子）已存在同键同译名，幂等确认，已出队
//   ok:false outcome='conflict'    词典已有同键不同译名/效果（existingName/existingDesc），
//                                  绝不覆盖；现有有据则 dismiss 该键，认为有误则人工修正词典后重试
//   ok:false outcome='seed'        种子权威键（existingName/existingDesc），绝不覆盖；请 dismiss 该键
//   ok:false outcome='covered'     静态表或社区状态表已覆盖该路径（existingName/existingDesc，
//                                  字典优先级更低，写了也不会显示）；请 dismiss 该键
//   ok:false error 含「写入失败」  原子落盘异常，条目保留，下轮重试，勿 dismiss
// options.resolveCovered: async (key) => { via: 'seed'|'community', name, desc } | null
//   由 CLI 注入真实解析链（静态表 + 社区维护状态表）；不传时按种子键部分校验（纯库调用/测试）。
export async function learnCalendarUpgradeVerified(upgradePath, name, desc, source = '灰机wiki 1999日历', options = {}) {
  const key = normalizeKey(upgradePath);
  const cleanName = normalizeEntryText(name);
  const cleanDesc = normalizeEntryText(desc);
  const invalid = validateLearnInputs(key, cleanName, cleanDesc);
  if (invalid) return { ok: false, error: invalid };
  if (typeof options.resolveCovered === 'function') {
    let coverage = null;
    try { coverage = await options.resolveCovered(key); } catch { coverage = null; }
    if (coverage?.name) {
      // 已有名称但缺效果：必须先按“部分覆盖”处理，不能把空效果误判成完整命中。
      if (coverage.name === cleanName && !coverage.desc && cleanDesc) {
        // 继续进入学习词典持久化；渲染时只把该效果合并回同名静态/社区条目。
      } else if (coverage.name === cleanName && !coverage.desc && !cleanDesc) {
        return {
          ok: false, outcome: 'effect-missing', path: key, name: cleanName, desc: cleanDesc, removedFromInbox: false,
          existingName: coverage.name, existingDesc: '',
          error: `「${key}」已有中文名「${coverage.name}」但效果仍缺失；inbox 条目保留，查到有据效果后再 learn，勿 dismiss`,
        };
      } else if (sameEntry(coverage, cleanName, cleanDesc)) {
        const removed = await removePendingCalendarUpgrade(key);
        return { ok: true, outcome: 'exists-same', path: key, name: cleanName, desc: cleanDesc, source, removedFromInbox: removed };
      } else {
        return {
          ok: false, outcome: coverage.via === 'seed' ? 'seed' : 'covered',
          path: key, name: cleanName, desc: cleanDesc, removedFromInbox: false,
          existingName: coverage.name, existingDesc: coverage.desc,
          error: `「${key}」已由${coverage.via === 'seed' ? '静态权威表' : '社区维护状态表'}覆盖（译名「${coverage.name}」），learn 只补缺绝不覆盖；inbox 条目保留未出队。安全处置：现有译名有据请 dismiss 该键，认为有误请人工修正 weekly-static.json 或社区表后重试`,
        };
      }
    }
  }
  let result;
  try {
    result = await enqueuePersist(() => persistLearnedEntryInner(key, cleanName, cleanDesc, source));
  } catch (error) {
    return {
      ok: false, path: key, name: cleanName, desc: cleanDesc,
      error: `学习词典写入失败，inbox 条目保留未出队，请下轮重试：${String(error?.message || error)}`,
    };
  }
  const { status, existing } = result;
  if (status === 'conflict') {
    return {
      ok: false, outcome: status, path: key, name: cleanName, desc: cleanDesc, removedFromInbox: false,
      existingName: existing.name, existingDesc: existing.desc,
      error: `学习词典已有同键不同译名「${existing.name}」，learn 只补缺绝不覆盖；inbox 条目保留未出队。安全处置：现有译名有据请 dismiss 该键，认为有误请人工修正词典文件后重试`,
    };
  }
  if (status === 'seed') {
    return {
      ok: false, outcome: status, path: key, name: cleanName, desc: cleanDesc, removedFromInbox: false,
      existingName: existing.name, existingDesc: existing.desc,
      error: `「${key}」是种子权威条目（译名「${existing.name}」），learn 不可覆盖；inbox 条目保留未出队。安全处置：同一增益请 dismiss 该键`,
    };
  }
  // written / updated / exists-same：已确认词典存在同键同译名或本次原子落盘成功，才允许出队
  const removed = await removePendingCalendarUpgrade(key);
  return { ok: true, outcome: status, path: key, name: cleanName, desc: cleanDesc, source, removedFromInbox: removed };
}

// 测试/调用方等待持久化队列落盘
export function flushCalendarQueues() {
  return Promise.all([persistQueue, inboxQueue]);
}

// ————————————————————————————————————————————————————————————————
// 未收录名称/效果日历增益 inbox（AI 查证闭环，2026-08-27）
//
// 全链查无落「新增日历增益（上游尚未提供中文说明）」时，把原始路径排队进 inbox 文件；
// 每日 AI 定时任务读取后用灰机wiki「1999日历」页查证：有依据的 learn 回填学习词典
// （中文名 + 效果 + 来源），查无实据的 dismiss 保持诚实占位。
//
// 文件：.cache/warframe-data/calendar-upgrade-inbox.json
//   { "version": 1, "items": { "<路径小写>": { "firstAt": ms, "lastAt": ms, "count": n } } }
// ————————————————————————————————————————————————————————————————

const INBOX_MAX_ITEMS = 100;

async function readInboxItems() {
  try {
    const raw = JSON.parse(await readFile(inboxFile(), 'utf8'));
    return raw && typeof raw === 'object' && raw.items ? raw.items : {};
  } catch {
    return {};
  }
}

async function writeInboxItems(items) {
  await atomicWriteJson(inboxFile(), { version: 1, items });
}

// inbox 全部读改写操作串行化：入队/出队/清空共用同一条队列，防复活条目。
let inboxQueue = Promise.resolve();
function enqueueInbox(task) {
  const run = inboxQueue.then(task);
  inboxQueue = run.catch(() => {});
  return run;
}

// 当前待查证清单（最近出现优先）
export async function readPendingCalendarUpgrades() {
  const items = await readInboxItems();
  return Object.entries(items)
    .map(([upgradePath, meta]) => ({ path: upgradePath, ...meta }))
    .sort((left, right) => (right.lastAt || 0) - (left.lastAt || 0));
}

// 从 inbox 移除一条（learn 成功后或查无实据 dismiss）；与入队共用串行队列
export async function removePendingCalendarUpgrade(upgradePath) {
  const key = normalizeKey(upgradePath);
  return enqueueInbox(async () => {
    const items = await readInboxItems();
    if (!items[key]) return false;
    delete items[key];
    await writeInboxItems(items);
    return true;
  });
}

// 测试/排障用：清空 inbox（串行队列保证先落盘排队中的写入再清）
export async function clearPendingCalendarUpgrades() {
  return enqueueInbox(async () => {
    await writeInboxItems({});
  });
}

// CLI：AI 查证闭环的读写入口（node calendar-upgrade-fallback.mjs <inbox|learn|dismiss>）
//   inbox   → 输出待查证清单 JSON
//   learn   → --path <完整路径> --name <纯中文名> --desc <中文效果> [--source <依据>]
//             返回契约与 learnCalendarUpgradeVerified 相同（ok:false 退出码 1，inbox 保留未出队）
//   dismiss → --path <完整路径> [--reason <说明>]
function parseCliArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      // 空字符串也是合法值（--desc '' 表示「效果暂缺，只学名字」）
      const value = argv[index + 1] !== undefined && !argv[index + 1].startsWith('--') ? argv[++index] : true;
      args[key] = value;
    }
  }
  return args;
}

// 真实解析链（静态种子 + 社区维护状态中文表）覆盖检查：CLI learn 用它判断该路径是否已被覆盖。
// 社区表只读本地缓存与内置补充表（与 wfdata.getCalendarStateZhMap 同口径、零联网零重试，
// 保证离线/CI 下行为确定）：缓存存在且 7 天 TTL 内由周报渲染写入，无缓存时退回内置补充表。
async function readCommunityStateRows() {
  const rows = [];
  try {
    const raw = JSON.parse(await readFile(path.join(dataDir(), 'calendar-state-zh.json'), 'utf8'));
    if (Array.isArray(raw?.data)) rows.push(...raw.data);
  } catch { /* 无缓存或损坏：仅补充表 */ }
  for (const entry of CALENDAR_STATE_SUPPLEMENT) {
    if (entry?.uniqueName && !rows.some((row) => row?.[0] === entry.uniqueName)) rows.push([entry.uniqueName, { name: entry.name, description: entry.description || '' }]);
  }
  return rows;
}

// 返回 { via: 'seed'|'community', name, desc } | null（查无覆盖）
export async function resolveCalendarCoverage(upgradePath) {
  const key = normalizeKey(upgradePath);
  const seed = CALENDAR_UPGRADE_SEEDS[key];
  if (seed) return { via: 'seed', name: seed.name, desc: seed.desc };
  const byPath = new Map();
  const byTail = new Map();
  for (const [uniqueName, meta] of await readCommunityStateRows()) {
    if (!uniqueName || !meta?.name) continue;
    byPath.set(normalizeKey(uniqueName), { name: normalizeEntryText(meta.name), desc: normalizeEntryText(meta.description || '') });
    const tail = String(uniqueName).split('/').pop().toLowerCase();
    if (tail && !byTail.has(tail)) byTail.set(tail, byPath.get(normalizeKey(uniqueName)));
  }
  const hit = byPath.get(key) || byTail.get(String(key).split('/').pop().toLowerCase());
  return hit ? { via: 'community', ...hit } : null;
}

async function runCli([command, ...rest]) {
  const args = parseCliArgs(rest);
  if (command === 'inbox') {
    const items = await readPendingCalendarUpgrades();
    return { ok: true, count: items.length, items: items.map((item) => ({
      path: item.path,
      count: item.count,
      firstAt: new Date(item.firstAt).toISOString(),
      lastAt: new Date(item.lastAt).toISOString(),
    })) };
  }
  if (command === 'learn') {
    return await learnCalendarUpgradeVerified(args.path, args.name, args.desc, String(args.source || '灰机wiki 1999日历'), { resolveCovered: resolveCalendarCoverage });
  }
  if (command === 'dismiss') {
    const removed = await removePendingCalendarUpgrade(args.path);
    return { ok: true, removed, path: normalizeKey(args.path), reason: String(args.reason || '') || null };
  }
  return { ok: false, error: '用法：node calendar-upgrade-fallback.mjs <inbox|learn|dismiss> [--path X --name N --desc D --source S --reason R]' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.ok === false ? 1 : 0;
  }).catch((error) => {
    process.stdout.write(`${JSON.stringify({ ok: false, error: String(error?.message || error) }, null, 2)}\n`);
    process.exitCode = 1;
  });
}
