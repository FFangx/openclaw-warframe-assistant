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

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DATA_DIR = process.env.WARFRAME_DATA_CACHE_DIR
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.cache', 'warframe-data');
const LEARN_FILE = path.join(DATA_DIR, 'reward-zh-fallback.json');

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
    const raw = JSON.parse(await readFile(LEARN_FILE, 'utf8'));
    return raw && typeof raw === 'object' && raw.entries ? raw.entries : {};
  } catch {
    return {};
  }
}

let learnedPromise = null;
async function loadLearned() {
  learnedPromise ??= (async () => {
    const entries = { ...SEED_ENTRIES };
    try {
      Object.assign(entries, await readLearned());
    } catch { /* 首次/损坏按种子 */ }
    return entries;
  })();
  return learnedPromise;
}

// 返回 Map<小写英文显示名, 中文名>（含种子 + 已学习条目）
export async function getLearnedRewardTranslations() {
  const entries = await loadLearned();
  return new Map(Object.entries(entries).map(([english, entry]) => [english, entry.zh]));
}

let persistQueue = Promise.resolve();
// 把组合译名写进学习词典（有据可查的整词结果）；已有条目不覆盖，失败静默不影响主流程。
export function learnReward(english, zh, source = '灰机wiki') {
  const key = String(english || '').normalize('NFKC').replace(/[\u3000\s]+/gu, ' ').trim().toLowerCase();
  const name = String(zh || '').trim();
  if (!key || !name || /[A-Za-z]{2,}/u.test(name)) return persistQueue;
  persistQueue = persistQueue.then(async () => {
    try {
      const entries = await readLearned();
      if (!entries[key]) {
        entries[key] = { zh: name, source, at: Date.now() };
        await mkdir(DATA_DIR, { recursive: true });
        await writeFile(LEARN_FILE, JSON.stringify({ version: 1, entries }, null, 2), 'utf8');
      }
    } catch { /* 学习失败不影响主流程 */ }
  }).catch(() => {});
  return persistQueue;
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
//
// 文件：.cache/warframe-data/reward-zh-inbox.json
//   { "version": 1, "items": { "<小写英文显示名>": { "firstAt": ms, "lastAt": ms, "count": n } } }
// ————————————————————————————————————————————————————————————————

const INBOX_FILE = path.join(DATA_DIR, 'reward-zh-inbox.json');
const INBOX_MAX_ITEMS = 100;

function normalizeKey(value) {
  return String(value || '').normalize('NFKC').replace(/[\u3000\s]+/gu, ' ').trim().toLowerCase();
}

async function readInboxItems() {
  try {
    const raw = JSON.parse(await readFile(INBOX_FILE, 'utf8'));
    return raw && typeof raw === 'object' && raw.items ? raw.items : {};
  } catch {
    return {};
  }
}

async function writeInboxItems(items) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(INBOX_FILE, JSON.stringify({ version: 1, items }, null, 2), 'utf8');
}

let inboxQueue = Promise.resolve();
// 记录一个待查证名（异步静默；只收含英文的名，中文/空值不入队，重复只累计计数）
export function queuePendingReward(rawName) {
  const key = normalizeKey(rawName);
  if (!key || !/[a-z]{2,}/u.test(key)) return inboxQueue;
  inboxQueue = inboxQueue.then(async () => {
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
  }).catch(() => {});
  return inboxQueue;
}

// 当前待查证清单（最近出现优先）
export async function readPendingRewards() {
  const items = await readInboxItems();
  return Object.entries(items)
    .map(([english, meta]) => ({ english, ...meta }))
    .sort((left, right) => (right.lastAt || 0) - (left.lastAt || 0));
}

// 从 inbox 移除一条（learn 成功后或查无实据 dismiss）
export async function removePendingReward(english) {
  const key = normalizeKey(english);
  const items = await readInboxItems();
  if (!items[key]) return false;
  delete items[key];
  await writeInboxItems(items);
  return true;
}

// 测试/排障用：清空 inbox（先等排队中的写入落盘再清，避免竞态）
export async function clearPendingRewards() {
  await inboxQueue.catch(() => {});
  await writeInboxItems({});
}

// 查证回填入口（供 AI 定时任务调用）：写学习词典 + 出 inbox；译名必须纯中文
export async function learnRewardVerified(english, zh, source = '灰机wiki') {
  const key = normalizeKey(english);
  const name = String(zh || '').trim();
  if (!key || !name) return { ok: false, error: 'english 与 zh 均不能为空' };
  if (/[A-Za-z]{2,}/u.test(name)) return { ok: false, error: '译名必须为纯中文，禁止夹带英文' };
  await learnReward(key, name, source);
  const removed = await removePendingReward(key);
  return { ok: true, english: key, zh: name, source, removedFromInbox: removed };
}

// 测试/调用方等待持久化队列落盘
export function flushRewardQueues() {
  return Promise.all([persistQueue, inboxQueue]);
}

// CLI：AI 查证闭环的读写入口（node reward-zh-fallback.mjs <inbox|learn|dismiss>）
//   inbox  → 输出待查证清单 JSON
//   learn  → --english <小写英文名> --zh <纯中文名> [--source <灰机wiki|Warframe.Market>]
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
