#!/usr/bin/env node

// 奖励译名兜底层（2026-08-17）：别名归一 + 组件词 + 持久化学习词典。
//
// 背景：DE 官方世界状态的入侵奖励内部路径尾段（如 GrineerCombatKnifeHeatsink）拆词后
// 与 Market/官方词典里的英文显示名（Sheev Heatsink）对不上，整词查无即落「未收录奖励」。
// 本层把「世界状态名 → 词典名」的别名差异归一，并把查证过的译名持久化到本地学习词典，
// 保证下次刷新直接命中；全静态数据，不联网（联网词典仍由 Market/官方链路负责）。
//
// 词典文件：.cache/warframe-data/reward-zh-fallback.json
//   { "version": 1, "entries": { "sheev heatsink": { "zh": "希芙散热片", "source": "灰机wiki", "at": 1755... } } }
// 键一律为小写英文显示名；条目只补缺、绝不覆盖 Market/官方词典结果。
//
// 写入/出队契约（2026-08-22，修复 Codex 复核发现的「静默吞持久化失败仍出队」）：
//   · 热路径 learnReward 保持静默：失败绝不影响主流程（fire-and-forget）。
//   · learnRewardVerified / CLI learn 只有在确认「词典（含种子）已存在同键同译名」
//     （outcome=exists-same）或「本次原子落盘成功」（outcome=written）后才出 inbox
//     并返回 ok:true；写入失败、已有同键不同译名（outcome=conflict）、种子权威键
//     （outcome=seed）一律返回 ok:false 且 inbox 条目原样保留、绝不误出队，
//     错误信息写明安全处置方式（dismiss 或下轮重试）。

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 缓存目录延迟解析：模块 import 时不锁定目录，进程内任何时候设置
// WARFRAME_DATA_CACHE_DIR 都会在下次读写时生效（测试必须用临时目录隔离，
// 否则会把合成 fixture 写进真实运行时/仓库缓存目录，2026-08-21 实拍泄漏）。
const DEFAULT_DATA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.cache', 'warframe-data',
);
function dataDir() {
  return process.env.WARFRAME_DATA_CACHE_DIR || DEFAULT_DATA_DIR;
}
function learnFile() {
  return path.join(dataDir(), 'reward-zh-fallback.json');
}
function inboxFile() {
  return path.join(dataDir(), 'reward-zh-inbox.json');
}

// 世界状态显示名（拆词后，小写）→ 词典里的正式英文显示名；按出现顺序应用。
// 新增别名必须有据（灰机wiki 页面/官方词典），禁止凭猜测加泛词。
export const REWARD_ALIAS_PHRASES = Object.freeze([
  // 灰机wiki「希芙」条目：Sheev 的世界状态内部名是 GrineerCombatKnife
  ['grineer combat knife', 'sheev'],
  // DE 世界状态把希芙蓝图配方尾段写成 GrineerCombatKnifeSortieBlueprint（2026-08-19
  // 火卫一 Gulliver 入侵进攻方奖励实拍），Market 整词键是 Sheev Blueprint；夹在中间的
  // Sortie 是配方路径词，归一掉才能整词命中（灰机wiki「希芙蓝图」= Market Sheev Blueprint）
  ['sheev sortie blueprint', 'sheev blueprint'],
]);

// 学习词典种子（2026-08-17，灰机wiki「希芙」条目口径）
const SEED_ENTRIES = Object.freeze({
  sheev: { zh: '希芙', source: '灰机wiki' },
  'sheev blade': { zh: '希芙刀刃', source: '灰机wiki' },
  'sheev heatsink': { zh: '希芙散热片', source: '灰机wiki' },
  'sheev hilt': { zh: '希芙刀柄', source: '灰机wiki' },
  'sheev blueprint': { zh: '希芙蓝图', source: '灰机wiki' },
});

async function readLearned() {
  try {
    const raw = JSON.parse(await readFile(learnFile(), 'utf8'));
    return raw && typeof raw === 'object' && raw.entries ? raw.entries : {};
  } catch {
    return {};
  }
}

// 原子落盘：先写同目录临时文件再 rename，崩溃/中断不会留下半个 JSON；
// 多个进程并发读改写时至少保证文件内容永远完整（跨进程丢失更新属可接受边界）。
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
  learnedPromise ??= (async () => {
    // 种子是灰机wiki 人工校订的权威条目：学习文件只补缺，绝不覆盖种子。
    const entries = { ...(await readLearned()), ...SEED_ENTRIES };
    return entries;
  })();
  return learnedPromise;
}

// 返回 Map<小写英文显示名, 中文名>（含种子 + 已学习条目）
export async function getLearnedRewardTranslations() {
  const entries = await loadLearned();
  return new Map(Object.entries(entries).map(([english, entry]) => [english, entry.zh]));
}

// 持久化串行队列：热路径 learn 与 verified learn 共用，避免读改写交错丢更新。
let persistQueue = Promise.resolve();
function enqueuePersist(task) {
  const run = persistQueue.then(task);
  persistQueue = run.catch(() => {});
  return run;
}

// 内部持久化原语（串行队列内执行；写入失败直接抛出，由调用方决定吞错还是报错）：
//   { status: 'written' }            → 本次原子落盘成功（新条目）
//   { status: 'exists-same' }        → 词典（含种子）已存在同键同译名，无需写入
//   { status: 'conflict', existingZh } → 词典已有同键不同译名，绝不覆盖
//   { status: 'seed', existingZh }     → 种子权威键且译名不一致，绝不覆盖
async function persistLearnedEntryInner(key, name, source) {
  const entries = await readLearned();
  const existing = entries[key];
  if (existing) {
    if (existing.zh === name) return { status: 'exists-same', existingZh: existing.zh };
    return { status: 'conflict', existingZh: existing.zh };
  }
  const seed = SEED_ENTRIES[key];
  if (seed) {
    if (seed.zh === name) return { status: 'exists-same', existingZh: seed.zh };
    return { status: 'seed', existingZh: seed.zh };
  }
  entries[key] = { zh: name, source, at: Date.now() };
  await atomicWriteJson(learnFile(), { version: 1, entries });
  return { status: 'written', existingZh: null };
}

// 热路径：把组合译名写进学习词典（有据可查的整词结果）；已有条目与种子键不覆盖。
// 失败静默不影响主流程（返回的 Promise 永不 reject）。
export function learnReward(english, zh, source = '灰机wiki') {
  const key = normalizeKey(english);
  const name = String(zh || '').trim();
  if (!key || !name || /[A-Za-z]{2,}/u.test(name)) return persistQueue;
  return enqueuePersist(async () => {
    try {
      await persistLearnedEntryInner(key, name, source);
    } catch { /* 学习失败不影响主流程 */ }
  });
}

// 对已拆词的显示名做别名归一（小写输出）
export function applyRewardAliases(value) {
  const raw = String(value ?? '').normalize('NFKC').replace(/[\u3000\s]+/gu, ' ').trim().toLowerCase();
  if (!raw) return '';
  let out = raw;
  for (const [internal, official] of REWARD_ALIAS_PHRASES) out = out.replaceAll(internal, official);
  return out;
}

// 把学习词典合并进调用方翻译表（只补缺，返回补入条数）
export async function mergeLearnedRewards(target) {
  const learned = await getLearnedRewardTranslations();
  let added = 0;
  for (const [english, zh] of learned) {
    if (!target.has(english)) {
      target.set(english, zh);
      added += 1;
    }
  }
  return added;
}

// ————————————————————————————————————————————————————————————————
// 未收录奖励 inbox（AI 查证闭环，2026-08-19）
//
// 全链查无落「未收录奖励」时，把原始内部名排队进 inbox 文件；每日 AI 定时任务
// 读取后用 Market/灰机wiki 查证：有依据的 learn 回填学习词典，查无实据的 dismiss
// 保持诚实占位。词典仍只补缺、不覆盖 Market/官方结果，卡片上永远是有据的译名。
// inbox 读写全部经同一串行队列 + 临时文件 rename 原子落盘（防竞态复活与半写损坏）。
//
// 文件：.cache/warframe-data/reward-zh-inbox.json
//   { "version": 1, "items": { "<小写英文显示名>": { "firstAt": ms, "lastAt": ms, "count": n } } }
// ————————————————————————————————————————————————————————————————

const INBOX_MAX_ITEMS = 100;

function normalizeKey(value) {
  return String(value || '').normalize('NFKC').replace(/[\u3000\s]+/gu, ' ').trim().toLowerCase();
}

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

// inbox 全部读改写操作串行化：入队/出队/清空共用同一条队列，
// 保证「先入队后 dismiss」不会因写回顺序被排队中的写入复活条目。
let inboxQueue = Promise.resolve();
function enqueueInbox(task) {
  const run = inboxQueue.then(task);
  inboxQueue = run.catch(() => {});
  return run;
}

// 记录一个待查证名（异步静默；只收含英文的名，中文/空值不入队，重复只累计计数）
export function queuePendingReward(rawName) {
  const key = normalizeKey(rawName);
  if (!key || !/[a-z]{2,}/u.test(key)) return inboxQueue;
  return enqueueInbox(async () => {
    try {
      const items = await readInboxItems();
      if (!items[key] && Object.keys(items).length >= INBOX_MAX_ITEMS) {
        // 满员且是新名：清掉最久未见的一条再收
        const oldest = Object.entries(items).sort((left, right) => (left[1].lastAt || 0) - (right[1].lastAt || 0))[0];
        if (oldest) delete items[oldest[0]];
      }
      const previous = items[key] || {};
      items[key] = { firstAt: previous.firstAt ?? Date.now(), lastAt: Date.now(), count: (previous.count || 0) + 1 };
      await writeInboxItems(items);
    } catch { /* inbox 不可用不影响主流程 */ }
  });
}

// 当前待查证清单（最近出现优先）
export async function readPendingRewards() {
  const items = await readInboxItems();
  return Object.entries(items)
    .map(([english, meta]) => ({ english, ...meta }))
    .sort((left, right) => (right.lastAt || 0) - (left.lastAt || 0));
}

// 从 inbox 移除一条（learn 成功后或查无实据 dismiss）；与入队共用串行队列
export async function removePendingReward(english) {
  const key = normalizeKey(english);
  return enqueueInbox(async () => {
    const items = await readInboxItems();
    if (!items[key]) return false;
    delete items[key];
    await writeInboxItems(items);
    return true;
  });
}

// 测试/排障用：清空 inbox（串行队列保证先落盘排队中的写入再清）
export async function clearPendingRewards() {
  return enqueueInbox(async () => {
    await writeInboxItems({});
  });
}

// 查证回填入口（供 AI 定时任务/CLI 调用）：只有确认落盘后才出 inbox，绝不先出队后写。
// 返回契约（ok:false 时 inbox 条目一律保留未出队，绝不误丢）：
//   ok:true  outcome='written'     本次原子落盘成功，已出队
//   ok:true  outcome='exists-same' 词典（含种子）已存在同键同译名，幂等确认，已出队
//   ok:false outcome='conflict'    词典已有同键不同译名（existingZh），绝不覆盖；
//                                  现有译名有据则 dismiss 该键，认为有误则人工修正词典文件后重试
//   ok:false outcome='seed'        种子权威键（existingZh），绝不覆盖；同一物品请 dismiss 该键
//   ok:false error 含「写入失败」  原子落盘异常，条目保留，下轮重试，勿 dismiss
export async function learnRewardVerified(english, zh, source = '灰机wiki') {
  const key = normalizeKey(english);
  const name = String(zh || '').trim();
  if (!key || !name) return { ok: false, error: 'english 与 zh 均不能为空' };
  if (/[A-Za-z]{2,}/u.test(name)) return { ok: false, error: '译名必须为纯中文，禁止夹带英文' };
  let result;
  try {
    result = await enqueuePersist(() => persistLearnedEntryInner(key, name, source));
  } catch (error) {
    return {
      ok: false, english: key, zh: name,
      error: `学习词典写入失败，inbox 条目保留未出队，请下轮重试：${String(error?.message || error)}`,
    };
  }
  const { status, existingZh } = result;
  if (status === 'conflict') {
    return {
      ok: false, outcome: status, existingZh, english: key, zh: name, removedFromInbox: false,
      error: `学习词典已有同键不同译名「${existingZh}」，learn 只补缺绝不覆盖；inbox 条目保留未出队。安全处置：现有译名有据请 dismiss 该键，认为有误请人工修正词典文件后重试`,
    };
  }
  if (status === 'seed') {
    return {
      ok: false, outcome: status, existingZh, english: key, zh: name, removedFromInbox: false,
      error: `「${key}」是种子权威条目（译名「${existingZh}」），learn 不可覆盖；inbox 条目保留未出队。安全处置：同一物品请 dismiss 该键`,
    };
  }
  // written / exists-same：已确认词典存在同键同译名或本次原子落盘成功，才允许出队
  const removed = await removePendingReward(key);
  return { ok: true, outcome: status, english: key, zh: name, source, removedFromInbox: removed };
}

// 测试/调用方等待持久化队列落盘
export function flushRewardQueues() {
  return Promise.all([persistQueue, inboxQueue]);
}

// CLI：AI 查证闭环的读写入口（node reward-zh-fallback.mjs <inbox|learn|dismiss>）
//   inbox  → 输出待查证清单 JSON
//   learn  → --english <小写英文名> --zh <纯中文名> [--source <灰机wiki|Warframe.Market>]
//            返回契约与 learnRewardVerified 相同（ok:false 退出码 1，inbox 条目保留未出队）
//   dismiss→ --english <小写英文名> [--reason <说明>]
function parseCliArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const value = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true;
      args[key] = value;
    }
  }
  return args;
}

async function runCli([command, ...rest]) {
  const args = parseCliArgs(rest);
  if (command === 'inbox') {
    const items = await readPendingRewards();
    return { ok: true, count: items.length, items: items.map((item) => ({
      english: item.english,
      count: item.count,
      firstAt: new Date(item.firstAt).toISOString(),
      lastAt: new Date(item.lastAt).toISOString(),
    })) };
  }
  if (command === 'learn') {
    return await learnRewardVerified(args.english, args.zh, String(args.source || '灰机wiki'));
  }
  if (command === 'dismiss') {
    const removed = await removePendingReward(args.english);
    return { ok: true, removed, english: normalizeKey(args.english), reason: String(args.reason || '') || null };
  }
  return { ok: false, error: '用法：node reward-zh-fallback.mjs <inbox|learn|dismiss> [--english X --zh Y --source S --reason R]' };
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
