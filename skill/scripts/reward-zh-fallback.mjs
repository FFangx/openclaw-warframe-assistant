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
import { fileURLToPath } from 'node:url';

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
