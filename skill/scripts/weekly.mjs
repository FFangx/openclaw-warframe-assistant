#!/usr/bin/env node

import { open, readFile, rename, unlink, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderWarframeCard } from './warframe-cards.mjs';
import { buildWeeklyMegaCard } from './weekly-mega-card.mjs';
import { readSnapshot } from './alecaframe.mjs';
import { getBountyZhMaps, getChallengeZhMap, getCalendarChallengeMap, getCalendarStateZhMap, getLangTable, getOfficialTextMap, getOracleConquestMap, getOracleConquestTailMap, getSeasonChallengeRequired, readAlecaJson, staleCachedJson, stripDataUriReplacer } from './wfdata.mjs';
import { loadWorldState } from './worldstate-source.mjs';
import { getLearnedCalendarUpgradeEntries, queuePendingCalendarUpgrade } from './calendar-upgrade-fallback.mjs';

// 静态参考表：奖励池/电波译名，以及 Oracle 词典暂不可用时的科研词缀兜底。
const staticData = JSON.parse(await readFile(new URL('./weekly-static.json', import.meta.url), 'utf8'));

const WORLD_STATE_URL = 'https://api.warframestat.us/pc';
const ARCHIMEDEA_URL = `${WORLD_STATE_URL}/archimedeas`;
const DEFAULT_STATE = path.resolve(process.cwd(), 'warframe-weekly.json');
const FETCH_TIMEOUT_MS = 20_000;
const WORLD_STATE_CACHE_TTL_MS = 5 * 60 * 1000;

const TASKS = Object.freeze([
  { id: 'archon', name: '执刑官猎杀', aliases: ['执刑官', '猎杀', 'archon'], hint: '每周三阶段猎杀' },
  { id: 'deep-archimedea', name: '深层科研', aliases: ['深层', '深层科研', '精英深层', 'eda'], hint: '深层／精英深层科研' },
  { id: 'temporal-archimedea', name: '时光科研', aliases: ['时光科研', '时间科研', '时间科研局', '时空科研', 'ta'], hint: '霍瓦尼亚每周科研任务' },
  { id: 'netracell', name: '衰退室', aliases: ['衰退室', 'netracell', 'netracells', '密室', '脉冲'], hint: '使用剩余的搜索脉冲' },
  // 编号=卡片从上到下顺序（用户 2026-08-04 定；2026-08-06 重排：kahl 提到 5，沉沦普通/钢铁 6/7 同排左右对照）
  // 回坑指南对账补的缺口：worldstate 无卡尔字段，纯手动打卡
  { id: 'kahl', name: '击溃合一众', aliases: ['卡尔', '击溃合一众', 'kahl', '卡尔驻军', '卡尔任务'], hint: '卡尔驻军周任务 · 声望与存货储备' },
  { id: 'descendia-normal', name: '沉沦之地（普通）', aliases: ['沉沦之地', '普通沉沦之地', '炼狱塔', '普通炼狱塔', 'descendia', '塔', '普通塔', '普通descendia'], hint: '普通难度 · 共 21 层' },
  { id: 'descendia-steel', name: '沉沦之地（钢铁）', aliases: ['钢铁沉沦之地', '钢铁炼狱塔', '钢铁塔', '钢铁descendia', '钢铁 descendia'], hint: '钢铁之路难度 · 共 21 层' },
  // 官方名「无尽回廊」（The Circuit，灰机 wiki 页名+词典实证）；「双衍回廊」是旧误名留作别名
  { id: 'circuit-normal', name: '无尽回廊（普通）', aliases: ['普通回廊', '回廊', '战甲回廊', '双衍回廊', 'circuit'], hint: '双衍王境周奖励 · 战甲三选一' },
  { id: 'circuit-steel', name: '无尽回廊（钢铁）', aliases: ['钢铁回廊', '灵化', '灵化回廊', '钢铁circuit'], hint: '灵化武器五选一' },
  { id: 'nightwave', name: '午夜电波周常', aliases: ['午夜电波', '电波', '夜波', 'nightwave'], hint: '本周挑战' },
  { id: 'calendar-1999', name: '1999 日历', aliases: ['1999', '日历', 'calendar', 'hex日历', '1999日历'], hint: '本周日历事件' },
]);

const ARCHON_ZH = Object.freeze({
  'Archon Amar': '执刑官欺谋狼主',
  'Archon Boreal': '执刑官诡文枭主',
  'Archon Nira': '执刑官混沌蛇主',
});

// 钢铁荣誉商店已移入独立「商店」模板（vendor-shop.mjs，2026-08-05）；周报不再展示轮换商店板块

const MISSION_ZH = Object.freeze({
  Spy: '间谍', Defense: '防御', Assassination: '刺杀', Survival: '生存', Disruption: '中断',
  Extermination: '歼灭', Exterminate: '歼灭', Capture: '捕获', Sabotage: '破坏', Rescue: '救援',
  'Mobile Defense': '移动防御', Interception: '拦截', Excavation: '挖掘', Alchemy: '炼金术',
  'Legacyte Harvest': '传承种收割',
  Skirmish: '前哨战', Volatile: '反应堆破坏', Corruption: '生存',
});

const PLANET_ZH = Object.freeze({
  Mercury: '水星', Venus: '金星', Earth: '地球', Lua: '月球', Mars: '火星', Deimos: '火卫二',
  Phobos: '火卫一', Ceres: '谷神星', Jupiter: '木星', Europa: '欧罗巴', Saturn: '土星',
  Uranus: '天王星', Neptune: '海王星', Pluto: '冥王星', Eris: '阃神星', Sedna: '赛德娜',
  Void: '虚空', Zariman: '扎里曼', 'Kuva Fortress': '赤毒要塞', Duviri: '双衍王境',
});

// 1999 日历大奖奖励中文（数量前缀单独处理）
const CALENDAR_REWARD_ZH = Object.freeze({
  'CalendarVosforPack': '荧尘储藏箱',
  'CalendarKuvaBundleLarge': '赤毒储藏箱',
  'CalendarArtifactPack': '赋能包',
  'CalendarMajorArtifactPack': '赋能双岚包',
  'UtilityUnlocker': '战甲特殊功能槽连接器',
  'CircuitSilverSteelPathFusionBundle': '内融核心包',
  'FormaAuraBlueprint': '全能 Forma 蓝图',
  'Riven': '裂罅 Mod',
  'Kuva': '赤毒',
  'Endo': '内融核心',
  'Amber Archon Shard': '琥珀执刑官源力石',
  // 官方词典：Crimson=深红、Azure=蔚蓝（曾误用绡红/蓝宝，2026-08-04 lang.json 实证修正）
  'Azure Archon Shard': '蔚蓝执刑官源力石',
  'Crimson Archon Shard': '深红执刑官源力石',
  'Orokin Reactor Blueprint': '奥罗金反应堆蓝图',
  'Orokin Catalyst Blueprint': '奥罗金催化剂蓝图',
  'Exilus Weapon Adapter Blueprint': '武器特殊功能槽连接器蓝图',
  'Exilus Warframe Adapter Blueprint': '战甲特殊功能槽连接器蓝图',
  // 官方词典：FormaAura = 全能 Forma（曾误译「光环」，2026-08-04 lang.json 实证修正；38.5 后 Aura/Omni 同物两代）
  'Aura Forma Blueprint': '全能 Forma 蓝图',
  'Aura Forma': '全能 Forma',
  'Omni Forma Blueprint': '全能 Forma 蓝图',
  'Omni Forma': '全能 Forma',
  'Forma Blueprint': 'Forma 蓝图',
  'Arcane Enhancements': '赋能包',
  'Arcane Enhancements: Double Pack': '赋能双岚包',
});

function cleanGameText(value) {
  return String(value || '').replace(/<[^>]+>/gu, '').replace(/\s+/gu, ' ').trim();
}

function officialTextZh(value, officialTextMap) {
  const translated = officialTextMap?.get?.(String(value || '').normalize('NFKC').trim().toLowerCase()) || null;
  return translated ? cleanGameText(translated) : null;
}

export function calendarRewardZh(value, storePath = null, names = null, officialTextMap = null, calendarStateZh = null) {
  const raw = String(value || '').trim();
  const byPath = storePath ? storeItemZh(storePath, names) : null;
  if (byPath) return cleanGameText(byPath);
  const byText = officialTextZh(raw, officialTextMap);
  if (byText) return byText;
  // 社区维护的日历状态中文表（KingPrimes/DataSource + 补充表）：按完整路径或尾段索引
  const stateTail = String(storePath || '').split('/').pop().toLowerCase();
  const stateHit = calendarStateZh?.byPath?.get?.(storePath) || calendarStateZh?.byTail?.get?.(stateTail);
  if (stateHit?.name) return cleanGameText(stateHit.name);
  if (CALENDAR_REWARD_ZH[raw]) return cleanGameText(CALENDAR_REWARD_ZH[raw]);
  const counted = raw.match(/^([\d,]+)\s*x?\s*(.+)$/iu);
  if (counted) {
    const base = officialTextZh(counted[2], officialTextMap) || CALENDAR_REWARD_ZH[counted[2].trim()];
    if (base) return `${counted[1]} ${base}`;
  }
  return /[A-Za-z]{2,}/u.test(raw) ? '游戏内奖励（名称待同步）' : raw;
}

// 英文挑战描述→中文：句式模板在 weekly-static.json descPatterns（无官方中文 API，2026-08-04 三路实测定案）；
// 电波与 1999 日历共用（Kill N X 句式同源），未命中返回 null 由调用方兜底
const descPatternCache = (staticData.descPatterns || []).map(([pattern, replacement]) => {
  try { return [new RegExp(pattern, 'iu'), replacement]; } catch { return null; }
}).filter(Boolean);
function translateDesc(desc) {
  const raw = String(desc || '').trim();
  if (!raw) return null;
  if (staticData.descZh?.[raw]) return staticData.descZh[raw];
  for (const [pattern, replacement] of descPatternCache) {
    const match = raw.match(pattern);
    if (match) return replacement.replace(/\$(\d)/gu, (_, index) => match[Number(index)] ?? '');
  }
  return null;
}

// 在线挑战译名映射（英文标题小写 → 官方中文，覆盖电波+日历全部挑战）：
// 渲染入口 await 一次装入；网络失败为空 Map，静态表/句式模板照常兜底
let onlineChallengeZh = new Map();
async function primeChallengeZh() {
  onlineChallengeZh = await getChallengeZhMap();
}
function challengeTitleZh(title) {
  return onlineChallengeZh.get(String(title ?? '').normalize('NFKC').trim().toLowerCase()) || null;
}

function nightwaveChallengeKey(challenge) {
  const explicit = String(challenge?.key || challenge?.path || '').split('/').pop();
  if (explicit) return explicit.toLowerCase();
  return String(challenge?.id || '').replace(/^\d+/u, '').toLowerCase();
}

function nightwaveChallengeZh(challenge, names = null) {
  const key = nightwaveChallengeKey(challenge);
  return staticData.nightwaveZh?.[challenge?.title]
    || challengeTitleZh(challenge?.title)
    || names?.nightwaveZhOf?.(key, Boolean(challenge?.isElite))
    || translateDesc(challenge?.desc)
    || '本周挑战 ×1（译名待补）';
}

// 1999 日历事件翻译：题名精确表优先 → 在线官方词典 → 描述模板兜底；增益效果句式自由只走精确表
function calendarChallengeZh(challenge) {
  return challengeTitleZh(challenge?.title) || staticData.calendarChallengeZh?.[challenge?.title] || translateDesc(challenge?.description) || '日历挑战（要求以游戏内为准）';
}

// —— 1999 日历增益中文名+效果（2026-08-27 起成对收录，不再只取名字丢效果）——
// 解析优先级：① 静态路径表（灰机wiki 1999日历 用户核验）→ ② 社区维护状态中文表（自动吸收，
// 行自带 {name, description}）→ ③ AI 查证学习词典（calendar-upgrade-fallback.mjs，只补缺口）
// → ④ 静态题名表（无路径时的兜底）→ 诚实占位。任何一层查无效果都不猜，效果留空由调用方决定是否展示。
export const CALENDAR_UPGRADE_PLACEHOLDER_ZH = '新增日历增益（上游尚未提供中文说明）';

function normalizeUpgradeEntry(value, source) {
  if (!value) return null;
  if (typeof value === 'string') {
    // 兼容旧字符串形式（"名称：效果"）：作为单一名称文本处理，不强行拆分
    return { name: cleanGameText(value), desc: '', source };
  }
  return {
    name: cleanGameText(value.name),
    desc: cleanGameText(value.desc || ''),
    source: cleanGameText(value.source || source || null),
  };
}

export function calendarUpgradeEntry(upgrade, upgradePath = null, calendarStateZh = null, options = {}) {
  const learnedKey = String(upgradePath || '').trim().toLowerCase();
  const learned = options.learnedEntries?.get?.(learnedKey);
  const mergeLearnedEffect = (entry) => {
    if (!entry || entry.desc || !learned?.desc || learned.name !== entry.name) return entry;
    return { ...entry, desc: cleanGameText(learned.desc), source: cleanGameText(`${entry.source || ''} + ${learned.source || '学习词典'}`) };
  };
  // ① 静态路径表：灰机wiki 1999日历 用户核验条目（name+desc+source 成对收录）
  const pathHit = staticData.calendarUpgradeZhByPath?.[upgradePath];
  if (pathHit) return mergeLearnedEffect(normalizeUpgradeEntry(pathHit, '灰机wiki 1999日历（静态表）'));
  // ② 社区维护的日历增益中文表：DE 官方语言键没有增益名，这里按路径/尾段自动吸收（含说明）
  const stateTail = String(upgradePath || '').split('/').pop().toLowerCase();
  const stateHit = calendarStateZh?.byPath?.get?.(upgradePath) || calendarStateZh?.byTail?.get?.(stateTail);
  if (stateHit?.name) {
    return mergeLearnedEffect({ name: cleanGameText(stateHit.name), desc: cleanGameText(stateHit.description || ''), source: '社区维护状态中文表' });
  }
  // ③ AI 查证学习词典：按完整路径小写键，双语名+效果+来源；只补缺口，绝不覆盖上面两层
  if (learned?.name) {
    return { name: cleanGameText(learned.name), desc: cleanGameText(learned.desc || ''), source: cleanGameText(learned.source || '学习词典') };
  }
  // ④ 静态题名表：DE 官方备份源只有英文题名时的兜底
  const titleHit = staticData.calendarUpgradeZh?.[upgrade?.title];
  if (titleHit) return normalizeUpgradeEntry(titleHit, '灰机wiki 1999日历（静态表）');
  return { name: CALENDAR_UPGRADE_PLACEHOLDER_ZH, desc: '', source: null };
}

export function calendarUpgradeZh(upgrade, upgradePath = null, calendarStateZh = null, learnedEntries = null) {
  const entry = calendarUpgradeEntry(upgrade, upgradePath, calendarStateZh, { learnedEntries });
  if (!entry.name || entry.name === CALENDAR_UPGRADE_PLACEHOLDER_ZH) return CALENDAR_UPGRADE_PLACEHOLDER_ZH;
  return entry.desc ? `${entry.name}：${entry.desc}` : entry.name;
}

// 渲染入口加载一次学习词典（失败静默降级空表，不影响主流程）
let learnedCalendarUpgradesPromise = null;
export function loadCalendarUpgradeLearned() {
  learnedCalendarUpgradesPromise ??= getLearnedCalendarUpgradeEntries().catch(() => new Map());
  return learnedCalendarUpgradesPromise;
}

function fillCalendarCount(text, required) {
  const count = Number(required) || 0;
  return cleanGameText(String(text || '').replace(/\|COUNT\|/giu, count > 0 ? String(count) : '指定数量'));
}

export function calendarChallengeLine(challenge, meta = null, progress = null) {
  const title = meta?.zh || calendarChallengeZh(challenge);
  const requirement = meta?.desc
    ? fillCalendarCount(meta.desc, meta.required)
    : translateDesc(challenge?.description);
  const base = requirement && requirement !== title ? `${title}：${requirement}` : title;
  return progress && Number(progress.required) > 0
    ? `${base}（${Math.min(Number(progress.cur) || 0, Number(progress.required))}/${Number(progress.required)}）`
    : base;
}

function normalize(value) {
  return String(value || '').normalize('NFKC').replace(/[，、,;；]+/gu, ' ').replace(/[\u3000\s]+/gu, ' ').trim();
}

function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) result._.push(token);
    else {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next != null && !next.startsWith('--')) { result[key] = next; index += 1; }
      else result[key] = true;
    }
  }
  return result;
}

function weekStart(date = new Date()) {
  const value = new Date(date);
  const daysSinceMonday = (value.getUTCDay() + 6) % 7;
  value.setUTCDate(value.getUTCDate() - daysSinceMonday);
  value.setUTCHours(0, 0, 0, 0);
  return value.toISOString();
}

function nextReset(date = new Date()) {
  const value = new Date(weekStart(date));
  value.setUTCDate(value.getUTCDate() + 7);
  return value.toISOString();
}

function emptyState() {
  return { version: 1, updatedAt: null, records: [], prefs: [], nightwaveSamples: [], conquestSamples: [] };
}

async function readState(statePath) {
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf8'));
    return {
      version: 1,
      updatedAt: parsed.updatedAt || null,
      records: Array.isArray(parsed.records) ? parsed.records : [],
      prefs: Array.isArray(parsed.prefs) ? parsed.prefs : [],
      nightwaveSamples: Array.isArray(parsed.nightwaveSamples) ? parsed.nightwaveSamples : [],
      // 科研分数周对齐历史：{ kind, weekStart, score, tokens, syncedAt, at }[]
      conquestSamples: Array.isArray(parsed.conquestSamples) ? parsed.conquestSamples : [],
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyState();
    throw error;
  }
}

async function writeState(statePath, state) {
  await mkdir(path.dirname(statePath), { recursive: true });
  state.updatedAt = new Date().toISOString();
  const temporary = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temporary, statePath);
}

async function withStateLock(statePath, operation) {
  await mkdir(path.dirname(statePath), { recursive: true });
  const lockPath = `${statePath}.lock`;
  let handle = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { handle = await open(lockPath, 'wx'); break; }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  if (!handle) throw new Error('周常状态正忙，请稍后重试。');
  try { return await operation(); }
  finally {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}

// 旧 id 到新 id 的映射：双衍回廊 2026-08-04 拆分，存量打卡/跳过记录归到钢铁回廊
const LEGACY_TASK_IDS = Object.freeze({ 'steel-circuit': 'circuit-steel' });
const migrateIds = (ids) => [...new Set((Array.isArray(ids) ? ids : []).map((id) => LEGACY_TASK_IDS[id] || id))];

function currentRecord(state, context) {
  const currentWeek = weekStart();
  const stored = state.records.find((item) => item.target === context.target && item.ownerId === context.ownerId);
  if (!stored || stored.weekStart !== currentWeek) {
    return {
      target: context.target,
      ownerId: context.ownerId,
      ownerName: context.ownerName || context.ownerId,
      weekStart: currentWeek,
      completed: [],
      dismissed: [],
      updatedAt: null,
    };
  }
  return { ...stored, completed: migrateIds(stored.completed), dismissed: migrateIds(stored.dismissed) };
}

// 跳过名单持久跨周（场景：战甲齐了就不再打普通回廊），存 prefs 不随周重置
function currentSkipped(state, context) {
  const stored = state.prefs.find((item) => item.target === context.target && item.ownerId === context.ownerId);
  return new Set(migrateIds(stored?.skipped));
}

function saveSkipped(state, context, skippedSet) {
  state.prefs = state.prefs.filter((item) => !(item.target === context.target && item.ownerId === context.ownerId));
  if (skippedSet.size) state.prefs.push({ target: context.target, ownerId: context.ownerId, skipped: [...skippedSet], updatedAt: new Date().toISOString() });
}

function saveRecord(state, record) {
  state.records = state.records.filter((item) => !(item.target === record.target && item.ownerId === record.ownerId));
  state.records.push({ ...record, updatedAt: new Date().toISOString() });
}

function resolveSelectors(raw) {
  const normalized = normalize(raw).toLowerCase();
  if (!normalized) return { selected: [], unknown: [] };
  const whole = TASKS.find((task) => task.id === normalized
    || task.name.toLowerCase() === normalized
    || task.aliases.some((alias) => alias.toLowerCase() === normalized));
  if (whole) return { selected: [whole.id], unknown: [] };
  const tokens = normalized.split(' ').filter(Boolean);
  const selected = new Set();
  const unknown = [];
  for (const token of tokens) {
    // 别名精确匹配优先：「1999」是日历别名，不能落进数字编号分支
    const exact = TASKS.find((task) => task.id === token || task.name.toLowerCase() === token || task.aliases.some((alias) => alias.toLowerCase() === token));
    if (exact) { selected.add(exact.id); continue; }
    if (/^\d+$/u.test(token)) {
      const index = Number(token) - 1;
      if (TASKS[index]) selected.add(TASKS[index].id);
      else unknown.push(token);
      continue;
    }
    const fuzzy = TASKS.find((task) => task.aliases.some((alias) => token.includes(alias.toLowerCase()) || alias.toLowerCase().includes(token)));
    if (fuzzy) selected.add(fuzzy.id);
    else unknown.push(token);
  }
  return { selected: [...selected], unknown };
}

const compactArchimedeaType = (entry) => String(entry?.typeKey || entry?.type || '').replace(/\s+/gu, '');

// 科研轮换是周报里占幅最大的动态区。顶层 worldstate 偶尔会成功返回但漏掉该字段，
// Cloudflare 也可能向 Node 客户端返回 403 HTML。只有两套本周科研都完整时才写入缓存，
// 防止“部分成功”覆盖上一次可靠数据。
export function hasCompleteArchimedeas(value, now = Date.now()) {
  if (!Array.isArray(value)) return false;
  const entries = ['LAB', 'HEX'].map((kind) => value.find((entry) => compactArchimedeaType(entry).includes(kind)));
  return entries.every((entry) => {
    if (!entry || !Array.isArray(entry.missions) || entry.missions.length < 3) return false;
    if (!Array.isArray(entry.personalModifiers) || entry.personalModifiers.length < 1) return false;
    const activation = Date.parse(entry.activation || '');
    const expiry = Date.parse(entry.expiry || '');
    return Number.isFinite(activation) && Number.isFinite(expiry) && activation <= now && expiry > now;
  });
}

async function fetchJsonWithRetry(url, attempts = 2) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      if (!contentType.includes('json')) throw new Error(`响应不是 JSON（${contentType || '未知类型'}）`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
    }
  }
  throw lastError || new Error('世界状态请求失败');
}

async function fetchCompleteWeeklyWorldState(seed = null) {
  const value = seed || await loadWorldState('pc');
  if (!hasCompleteArchimedeas(value?.archimedeas)) {
    const archimedeas = await fetchJsonWithRetry(ARCHIMEDEA_URL);
    if (!hasCompleteArchimedeas(archimedeas)) throw new Error('科研轮换字段不完整');
    value.archimedeas = archimedeas;
  }
  return value;
}

async function fetchWorldState(seed = null) {
  try {
    // 缓存按周分文件：周一重置后绝不误用上周科研；本周接口临时 403 时可退回本周最后一次可靠快照。
    const cacheName = `weekly-world-state-${weekStart().slice(0, 10)}`;
    const result = await staleCachedJson(cacheName, { ttlMs: WORLD_STATE_CACHE_TTL_MS, version: 1 }, () => fetchCompleteWeeklyWorldState(seed));
    if (!hasCompleteArchimedeas(result.data?.archimedeas)) throw new Error('本周科研缓存不可用');
    return { value: result.data, error: null, stale: result.stale, cachedAt: result.cachedAt };
  } catch (error) {
    return { value: null, error: String(error?.message || error), stale: false, cachedAt: null };
  }
}

// —— 自动打卡：AlecaFrame 快照 → 本周已完成项（快照过加载点才更新，最终一致而非实时）——
const msOf = (value) => {
  const raw = value?.$date?.$numberLong ?? value?.$date ?? value;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN;
  if (/^-?\d+$/u.test(String(raw ?? ''))) {
    const numeric = Number(raw);
    return Number.isFinite(numeric) ? numeric : NaN;
  }
  const parsed = Date.parse(String(raw ?? ''));
  return Number.isFinite(parsed) ? parsed : NaN;
};

// —— 科研分数周对齐（2026-08-18 实锤，修复跨周误核销）——
// 快照的 ConquestCacheScoreMission 是「客户端缓存的周总分」：周一重置后若玩家本周尚未
// 进入科研/打完任务，字段原样携带上周分数，仅凭 syncedAt ≥ 本周一无法区分「本周打过」与
// 「上周遗留」（实机：周一晚快照仍显示上周 21 分）。因此每次渲染把 (kind, weekStart,
// score[, tokens]) 记入状态 conquestSamples（同周去重取最新）。科研/衰退室共用的
// EntratiVaultCountResetDate 若已被服务端推进到精确的下一周界，可直接证明这些分数字段已经
// 完成本周重置；字段缺失、过期或周界错位时，继续要求「本周得分证据」：分数与上一周记录
// 不同 / 本周电波征服挑战完成 / HEX 奖励令牌与上周不同。无证据只显示诚实进度，绝不把
// 上周分数核销成本周完成。
function lastPreWeekConquestSample(samples, kind, now = Date.now()) {
  const currentWeek = weekStart(new Date(now));
  return (samples || [])
    .filter((sample) => sample.kind === kind && sample.weekStart && sample.weekStart < currentWeek)
    .sort((a, b) => Date.parse(String(a.at || a.syncedAt || '')) - Date.parse(String(b.at || b.syncedAt || '')))
    .at(-1) || null;
}

function conquestResetAligned(inventory, now = Date.now()) {
  const resetMs = msOf(inventory?.EntratiVaultCountResetDate);
  const expectedResetMs = Date.parse(nextReset(new Date(now)));
  return Number.isFinite(resetMs)
    && resetMs > now
    && Number.isFinite(expectedResetMs)
    && resetMs === expectedResetMs;
}

function conquestWeekEvidence(inventory, kind, history, nightwaveConquestDone, now = Date.now()) {
  if (nightwaveConquestDone) return 'nightwave';
  if (conquestResetAligned(inventory, now)) return 'reset-boundary';
  if (!history) return null;
  const score = Math.max(0, Number(inventory?.[`${kind}ConquestCacheScoreMission`]) || 0);
  if (score !== Number(history.score)) return 'score-change';
  if (kind === 'EchoesHex') {
    const tokens = JSON.stringify((inventory?.EchoesHexConquestBonusTokensGiven || []).map(Number));
    if (tokens !== JSON.stringify((history.tokens || []).map(Number))) return 'tokens';
  }
  return null;
}

// 本周电波征服挑战完成 = 本周活跃挑战里存在 CompleteConquest 类挑战且快照进度达标。
// 与本周活跃列表 join，周界天然正确；该挑战不在轮换时返回 false，不参与判定。
function nightwaveConquestDone(inventory, worldState, challengeRequired) {
  const challenges = (worldState?.nightwave?.activeChallenges || [])
    .filter((item) => !item.isDaily && /completeconquest/iu.test(String(item.id || '')));
  if (!challenges.length || !challengeRequired || !Object.keys(challengeRequired).length) return false;
  const progressByKey = new Map((inventory?.ChallengeProgress || []).map((item) => [String(item.Name || '').toLowerCase(), Number(item.Progress) || 0]));
  return challenges.some((item) => {
    const key = String(item.id).replace(/^\d+/u, '');
    const required = Number(challengeRequired[key]) || 0;
    return required > 0 && (progressByKey.get(key) ?? 0) >= required;
  });
}

// 纯函数便于打桩测试；worldState 缺失时跳过需要对账的项（执刑官/电波），其余判据只看快照自身周界
function evaluateAutoCheck(inventory, worldState, now = Date.now(), challengeRequired = null, syncedAt = null, options = {}) {
  const auto = {};      // taskId → true：判据确定的本周完成
  const progress = {};  // taskId → 进度文本（有进度不等于完成）
  if (!inventory) return { auto, progress };
  // 双衍回廊：EndlessXP 按 Category 分普通/钢铁；Expiry 过期 = 上周陈旧数据，不采信
  for (const [category, taskId] of [['EXC_NORMAL', 'circuit-normal'], ['EXC_HARD', 'circuit-steel']]) {
    const entry = (inventory.EndlessXP || []).find((item) => item.Category === category);
    if (!entry || !(msOf(entry.Expiry) > now)) continue;
    const goal = Math.max(0, ...(entry.PendingRewards || []).map((reward) => Number(reward.RequiredTotalXp) || 0));
    if (!goal) continue;
    const earned = Number(entry.Earn) || 0;
    progress[taskId] = `阶层经验 ${Math.min(earned, goal)}/${goal}`;
    if (earned >= goal) auto[taskId] = true;
  }
  // 衰退室：每周 5 次搜索脉冲，ResetDate 在未来才是本周计数
  if (msOf(inventory.EntratiVaultCountResetDate) > now) {
    const count = Number(inventory.EntratiVaultCountLastPeriod) || 0;
    progress.netracell = `本周 ${Math.min(count, 5)}/5 次`;
    if (count >= 5) auto.netracell = true;
  }
  // 沉沦之地：领奖到最后一层 checkpoint 即全清
  for (const [category, taskId] of [['DM_COH_NORMAL', 'descendia-normal'], ['DM_COH_HARD', 'descendia-steel']]) {
    const entry = (inventory.DescentRewards || []).find((item) => item.Category === category);
    if (!entry || !(msOf(entry.Expiry) > now)) continue;
    const top = Math.max(0, ...(entry.PendingRewards || []).map((reward) => Number(reward.FloorCheckpoint) || 0));
    if (!top) continue;
    const claimed = Number(entry.FloorClaimed) || 0;
    progress[taskId] = `已领 ${Math.min(claimed, top)}/${top} 层`;
    if (claimed >= top) auto[taskId] = true;
  }
  // 执刑官：领奖记录的 SortieId 与本周 archonHunt.id 一致才算本周完成（上周记录自然对不上）
  const sortieId = inventory.LastLiteSortieReward?.[0]?.SortieId?.$oid;
  if (sortieId && worldState?.archonHunt?.id && sortieId === worldState.archonHunt.id) auto.archon = true;
  // 电波：🔴 SeasonChallengeHistory 只记「激活过」不是「完成」（2026-08-06 用户实锤两条未做挑战在列）。
  // 完成判定=ChallengeProgress.Progress ≥ ExportChallenges.requiredCount（与日历同款 join）；
  // 映射缺失（网络挂）时宁不核销也不报进度，不用激活记录充数
  const challenges = (worldState?.nightwave?.activeChallenges || []).filter((item) => !item.isDaily);
  if (challenges.length && challengeRequired && Object.keys(challengeRequired).length) {
    const progressByKey = new Map((inventory.ChallengeProgress || []).map((item) => [String(item.Name || '').toLowerCase(), Number(item.Progress) || 0]));
    const hits = challenges.filter((item) => {
      const key = String(item.id).replace(/^\d+/u, '');
      const required = Number(challengeRequired[key]) || 0;
      return required > 0 && (progressByKey.get(key) ?? 0) >= required;
    }).length;
    progress.nightwave = `周挑战 ${hits}/${challenges.length}`;
    if (hits === challenges.length) auto.nightwave = true;
  }
  // 泰辛商店已移入独立「商店」模板，周常不再追踪购买状态（2026-08-05）
  // 卡尔周任务：WeekCount 锚点 2014-02-10（周一，实测 651=2026-08-03 周）对齐本周才采信，CompletedMission 为准
  const kahlWeek = Math.floor((now - Date.UTC(2014, 1, 10)) / 604_800_000);
  const kahlMission = ((inventory.Affiliations || []).find((item) => item.Tag === 'KahlSyndicate')?.WeeklyMissions || [])
    .find((item) => Number(item.WeekCount) === kahlWeek);
  if (kahlMission?.CompletedMission === true) auto.kahl = true;
  // 1999 日历：游戏内一个季节横跨约 3 个月，但现实轮换窗口仍是一周。
  // SeasonType + Iteration 对齐当前 worldstate 后，LastCompletedDayIdx 到达最后有效节点即可可靠核销。
  const calInfo = calendarSeasonProgress(inventory, worldState);
  if (calInfo) {
    progress['calendar-1999'] = `已推进 ${calInfo.doneCount}/${calInfo.totalCount} 节点`;
    if (calInfo.totalCount > 0 && calInfo.doneCount === calInfo.totalCount) auto['calendar-1999'] = true;
  }
  // 科研最佳分：基础 1 点 + 8 个个人/装备参数，每关最多 9 点；只完成
  // 两关最多 18 点。因此 >=19 能严格证明三关完整通关，低分只展示而不猜。
  // 分数字段按周重置，但仍要求快照本周同步，防止跨周沿用旧记录。
  const nwConquestDone = nightwaveConquestDone(inventory, worldState, challengeRequired);
  for (const [kind, taskId] of [['EntratiLab', 'deep-archimedea'], ['EchoesHex', 'temporal-archimedea']]) {
    const history = lastPreWeekConquestSample(options?.conquestSamples, kind, now);
    const evidence = conquestWeekEvidence(inventory, kind, history, nwConquestDone, now);
    const research = archimedeaResearchProgress(inventory, kind, now, syncedAt, { evidence, priorScore: history?.score ?? null });
    if (!research) continue;
    progress[taskId] = research.text;
    if (research.completed) auto[taskId] = true;
  }
  return { auto, progress };
}

export function archimedeaResearchProgress(inventory, kind, now = Date.now(), syncedAt = null, options = {}) {
  const syncedMs = Date.parse(String(syncedAt || ''));
  if (!Number.isFinite(syncedMs) || syncedMs < Date.parse(weekStart(new Date(now)))) return null;
  const score = Math.max(0, Number(inventory?.[`${kind}ConquestCacheScoreMission`]) || 0);
  const unlocked = Number(inventory?.[`${kind}ConquestUnlocked`]) > 0;
  if (!unlocked && score <= 0) return null;
  const evidence = options.evidence || null;
  const completed = Boolean(evidence) && score >= 19;
  let text;
  if (score >= 19) {
    text = completed
      ? `本周最佳 ${score} 研究点 · 三关已完成`
      : `快照显示 ${score} 研究点 · 尚未确认本周完成`;
  } else {
    text = `本周最佳 ${score} 研究点 · 尚不能确认三关全通`;
  }
  if (score >= 25) text += ' · 已达精英解锁线';
  else text += ` · 距精英解锁 ${25 - score} 点`;
  return { score, completed, evidence, eliteThresholdReached: score >= 25, text };
}

// —— 1999 日历赛季进度（语义 2026-08-05 用户三步实测定死） ——
// LastCompletedDayIdx=全类型最后完成节点（0 起算，索引即 worldstate days 数组序，-1=本赛季没做过）
// 周界校验：快照 SeasonType/Iteration 必须与 worldstate 当前赛季对齐，防隔赛季陈旧数据误标
function calendarSeasonProgress(inventory, worldState) {
  const sp = inventory?.CalendarProgress?.SeasonProgress;
  const days = Array.isArray(worldState?.calendar?.days) ? worldState.calendar.days : [];
  if (!sp || !days.length) return null;
  const seasonZh = String(worldState.calendar.season || '').toUpperCase();
  const snapSeason = String(sp.SeasonType || '').replace(/^CST_/u, '').toUpperCase();
  if (!seasonZh || snapSeason !== seasonZh) return null;
  const iteration = Number(worldState.calendar.yearIteration);
  if (Number.isFinite(iteration) && Number(inventory.CalendarProgress.Iteration) !== iteration) return null;
  const lastIdx = Number.isFinite(Number(sp.LastCompletedDayIdx)) ? Number(sp.LastCompletedDayIdx) : -1;
  // 进度口径只数有事件的节点（days 里有空事件日，指针却按数组位置计数）
  const active = days.map((day, idx) => ({ idx, has: (day.events || []).length > 0 })).filter((day) => day.has);
  const doneCount = active.filter((day) => day.idx <= lastIdx).length;
  // 挑战进度：ActivatedChallenges 含已完成项（实锤），完成判定必须拿 ChallengeProgress 对 requiredCount
  const progressByKey = new Map((inventory.ChallengeProgress || []).map((item) => [String(item.Name || '').toLowerCase(), Number(item.Progress) || 0]));
  const challenges = (sp.ActivatedChallenges || []).map((key) => ({ key: String(key).toLowerCase(), cur: progressByKey.get(String(key).toLowerCase()) ?? 0 }));
  const upgrades = (inventory.CalendarProgress.YearProgress?.Upgrades || []).map(String);
  return { lastIdx, doneCount, totalCount: active.length, challenges, upgrades, upgradeCount: upgrades.length };
}

// 官方 worldState 日历（路径版，与 WFCD 逐日逐事件同序，probe-calendar-align 实证 17/17）：
// 与 vendor-shop 共用 official-worldstate 磁盘缓存（同名同版本，15min TTL），零新增请求；失败返 null 降级不标
async function loadOfficialCalendarDays() {
  try {
    const result = await staleCachedJson('official-worldstate', { ttlMs: 15 * 60 * 1000, version: 1 }, async () => {
      const response = await fetch('https://api.warframe.com/cdn/worldState.php', { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`worldState.php HTTP ${response.status}`);
      return response.json();
    });
    return result.data?.KnownCalendarSeasons?.[0]?.Days || null;
  } catch {
    return null;
  }
}

// 已选增益标记：官方路径逐位对比「该日选择的那一条路径」；类型不符/缺数据一律 false
// ⚠ 不能用「交集 YearProgress.Upgrades」：它是全年累计，上赛季选过的增益本赛季重新上架会跨赛季误标（目检实锤）
function chosenFlags(officialEvents, count, pickPath) {
  return Array.from({ length: count }, (_, j) => {
    const event = officialEvents?.[j];
    return Boolean(pickPath && event && event.type === 'CET_UPGRADE' && event.upgrade === pickPath);
  });
}

// 读真实快照的包装；任何异常静默降级为「无自动数据」，手动打卡不受影响
async function autoCheckFromSnapshot(worldState, conquestSamples = []) {
  try {
    const { inventory, syncedAt } = await readSnapshot();
    // 电波完成量映射：网络失败返空对象，电波项自然跳过（宁不核销）
    const challengeRequired = worldState ? await getSeasonChallengeRequired() : null;
    const now = Date.now();
    const result = evaluateAutoCheck(inventory, worldState, now, challengeRequired, syncedAt, { conquestSamples });
    // 本轮科研分数样本：供以后各周判断「分数是否真的变过」
    const observations = collectConquestObservations(inventory, syncedAt, now);
    return { ...result, syncedAt, inventory, observations };
  } catch {
    return null;
  }
}

function collectConquestObservations(inventory, syncedAt, now) {
  if (!inventory) return [];
  const sampleWeek = weekStart(new Date(Date.parse(String(syncedAt)) || now));
  const at = new Date(now).toISOString();
  return [
    { kind: 'EntratiLab', weekStart: sampleWeek, score: Math.max(0, Number(inventory.EntratiLabConquestCacheScoreMission) || 0), syncedAt, at },
    { kind: 'EchoesHex', weekStart: sampleWeek, score: Math.max(0, Number(inventory.EchoesHexConquestCacheScoreMission) || 0), tokens: (inventory.EchoesHexConquestBonusTokensGiven || []).map(Number), syncedAt, at },
  ];
}

// 把本轮科研分数样本并进状态文件：同 (kind, weekStart) 只留最新一条，cap 80；失败静默
async function recordConquestObservations(statePath, observations) {
  if (!statePath || !Array.isArray(observations) || !observations.length) return;
  await withStateLock(statePath, async () => {
    const state = await readState(statePath);
    const byKey = new Map();
    for (const sample of [...(state.conquestSamples || []), ...observations]) {
      if (!sample?.kind || !sample?.weekStart) continue;
      byKey.set(`${sample.kind}:${sample.weekStart}`, sample);
    }
    state.conquestSamples = [...byKey.values()].sort((a, b) => Date.parse(String(a.at || '')) - Date.parse(String(b.at || ''))).slice(-80);
    await writeState(statePath, state);
  }).catch(() => {});
}

// 合并手动与自动：用户「撤销」过的项（dismissed）尊重用户判断，不再自动打上
function mergeAutoRecord(record, autoResult) {
  if (!autoResult) return { record, autoIds: [] };
  const dismissed = new Set(record.dismissed || []);
  const autoIds = Object.keys(autoResult.auto).filter((id) => !dismissed.has(id) && !record.completed.includes(id));
  if (!autoIds.length) return { record, autoIds };
  return { record: { ...record, completed: [...record.completed, ...autoIds] }, autoIds };
}

// 节点名保留英文、星球转中文："Ananke (Jupiter)" → "Ananke（木星）"
function localizeNode(value) {
  return String(value || '').replace(/^(.*?)\s*\(([^)]+)\)$/u, (_, node, planet) => `${node}（${PLANET_ZH[planet] || planet}）`);
}

// —— 官方目录名称表（lang.json + Warframes.json）：回廊奖励/瓦奇娅货单的 StoreItem 路径 → 中文名 ——
// 懒加载单例：只在渲染入口 await 一次；本地缺失时走 wfdata 在线兑底，全挂才降级空表
let nameTablesPromise = null;
let shopNameTablesPromise = null;
function loadNameTables({ includeShopCatalogs = false } = {}) {
  const existing = includeShopCatalogs ? shopNameTablesPromise : nameTablesPromise;
  if (existing) return existing;
  const promise = (async () => {
    // 悬赏/语言键映射始终加载：语言键尾段→官方中文是日历奖励等路径式名称的兜底链；
    // Warframes.json 始终加载（回廊战甲「已有」标记要用 uniqueName 精确比对）
    const catalogFiles = includeShopCatalogs
      ? ['Warframes.json', 'Primary.json', 'Secondary.json', 'Melee.json', 'Arch-Gun.json', 'Skins.json', 'Gear.json', 'Glyphs.json']
      : ['Warframes.json'];
    const [lang, maps, ...catalogResults] = await Promise.all([
      getLangTable().catch(() => ({})),
      getBountyZhMaps().catch(() => ({ items: {}, languageTails: {} })),
      ...catalogFiles.map((file) => readAlecaJson(`json/${file}`).catch(() => null)),
    ]);
    const catalogs = catalogResults.map((value) => Array.isArray(value) ? value : []);
    const frames = catalogs[0];
    const frameByTail = new Map();   // 内部名尾段（Berserker）→ 显示名（Valkyr）
    const uniqByName = new Map();    // 显示名 → uniqueName（已有判定用，普通≠Prime 精确比对）
    const nightwaveByTail = new Map(); // Weekly/WeeklyHard 路径尾段 → 官方简中挑战名
    const catalogZhByPath = new Map(); // 商品/配方实际路径 → 由目录父子关系恢复的官方中文名
    const catalogZhByTail = new Map(); // StoreItem 与目录路径有额外分段时，以唯一尾名桥接
    const ambiguousCatalogTails = new Set();
    const officialZh = (english) => maps?.items?.[String(english || '').normalize('NFKC').trim().toLowerCase()] || String(english || '').trim();
    const componentZh = Object.freeze({
      Blueprint: '蓝图', Chassis: '机体蓝图', Neuroptics: '头部神经光元蓝图', Systems: '系统蓝图',
      Barrel: '枪管', Receiver: '枪机', Stock: '枪托', Blade: '刀刃', Handle: '握柄', Grip: '握柄',
      'Upper Limb': '弓身上部', 'Lower Limb': '弓身下部', String: '弓弦', Hilt: '剑柄', Guard: '护手',
    });
    const putCatalogName = (uniqueName, zh) => {
      if (!uniqueName || !zh || catalogZhByPath.has(uniqueName)) return;
      catalogZhByPath.set(uniqueName, zh);
      const aliases = uniqueName.endsWith('Blueprint') ? [] : [
        `${uniqueName}Blueprint`,
        uniqueName.replace(/(?:Component|Item)$/u, 'Blueprint'),
      ];
      for (const alias of aliases) catalogZhByPath.set(alias, zh);
      for (const candidate of [uniqueName, ...aliases]) {
        const tail = candidate.split('/').pop().toLowerCase();
        if (ambiguousCatalogTails.has(tail)) continue;
        if (catalogZhByTail.has(tail) && catalogZhByTail.get(tail) !== zh) {
          catalogZhByTail.delete(tail);
          ambiguousCatalogTails.add(tail);
        } else {
          catalogZhByTail.set(tail, zh);
        }
      }
    };
    for (const frame of frames) {
      if (!frame?.uniqueName || !frame?.name) continue;
      frameByTail.set(frame.uniqueName.split('/').pop(), frame.name);
      frameByTail.set(frame.name, frame.name);
      uniqByName.set(frame.name, frame.uniqueName);
    }
    for (const catalog of catalogs) {
      for (const item of catalog) {
        if (!item?.uniqueName || !item?.name) continue;
        const parentZh = lang[item.uniqueName]?.zh?.name || officialZh(item.name);
        putCatalogName(item.uniqueName, parentZh);
        for (const component of item.components || []) {
          if (!component?.uniqueName || !component.uniqueName.includes('/Recipes/')) continue;
          const part = componentZh[component.name] || officialZh(component.name);
          putCatalogName(component.uniqueName, [parentZh, part].filter(Boolean).join(' '));
        }
      }
    }
    for (const [uniqueName, localized] of Object.entries(lang)) {
      const match = uniqueName.match(/\/Seasons\/(Weekly|WeeklyHard)\/([^/]+)$/u);
      const zh = localized?.zh?.name;
      if (!match || !zh) continue;
      nightwaveByTail.set(`${match[1].toLowerCase()}:${match[2].toLowerCase()}`, zh);
    }
    return {
      zhOf: (uniq) => lang[uniq]?.zh?.name || null,
      catalogZhOf: (uniq) => catalogZhByPath.get(uniq) || null,
      catalogTailZhOf: (tail) => catalogZhByTail.get(String(tail || '').toLowerCase()) || null,
      languageTailZhOf: (tail) => maps?.languageTails?.[String(tail || '').toLowerCase()] || null,
      nightwaveZhOf: (key, elite = false) => {
        const tail = String(key || '').toLowerCase();
        const group = elite ? 'weeklyhard' : 'weekly';
        const alternate = elite ? 'weekly' : 'weeklyhard';
        return nightwaveByTail.get(`${group}:${tail}`) || nightwaveByTail.get(`${alternate}:${tail}`) || null;
      },
      frameByTail,
      uniqByName,
    };
  })();
  if (includeShopCatalogs) shopNameTablesPromise = promise;
  else nameTablesPromise = promise;
  return promise;
}

// StoreItem 路径 → 中文名：静态表 → lang.json → 战甲部件蓝图拆解 → 基名+蓝图 → 安全占位
function storeItemZh(storeItem, names) {
  const base = String(storeItem || '').replace('/StoreItems', '');
  const tail = base.split('/').pop();
  const staticHit = staticData.rewardItemZh?.[tail] ?? staticData.rewardItemZh?.[base];
  if (staticHit) return staticHit;
  const direct = names?.zhOf?.(base);
  if (direct) return direct;
  const catalog = names?.catalogZhOf?.(base);
  if (catalog) return catalog;
  const catalogTail = names?.catalogTailZhOf?.(tail);
  if (catalogTail) return catalogTail;
  const languageKey = names?.languageTailZhOf?.(tail);
  if (languageKey) return languageKey;
  // 战甲部件蓝图：BerserkerHelmetBlueprint → Valkyr 头部神经光元蓝图（战甲名按硬规则保留英文）
  const recipe = tail.match(/^(\w+?)(Helmet|Chassis|Systems)?Blueprint$/u);
  if (recipe && base.includes('/WarframeRecipes/')) {
    const frameName = names?.frameByTail?.get(recipe[1]);
    const part = { Helmet: '头部神经光元蓝图', Chassis: '机体蓝图', Systems: '系统蓝图' }[recipe[2]] || '总蓝图';
    if (frameName) return `${frameName} ${part}`;
  }
  // 蓝图类：先查基物品名再拼「蓝图」（如 WeaponUtilityUnlockerBlueprint → 武器特殊功能槽连接器蓝图）
  if (tail.endsWith('Blueprint')) {
    const baseName = names?.zhOf?.(base.replace(/Blueprint$/u, '').replace('/Recipes/Components/', '/Items/MiscItems/'));
    if (baseName) return `${baseName}蓝图`;
  }
  return null;
}

function archimedeaLines(entry) {
  if (!entry?.missions?.length) return [];
  return [`本周任务：${entry.missions.map((mission) => MISSION_ZH[mission.missionType] || '未知任务').join(' → ')}`];
}

function taskRows(record, worldState, skipped = new Set(), progressMap = {}, resources = {}) {
  const completed = new Set(record.completed);
  const { names = null, officialDays = null, officialTextMap = null, calendarStateZh = null } = resources;
  // 深层=LAB（墓志之地），时光=HEX（霍瓦尼亚）；typeKey 带空格故用压缩匹配
  const archimedeas = Array.isArray(worldState?.archimedeas) ? worldState.archimedeas : [];
  const deepEntry = archimedeas.find((entry) => /LAB/u.test(String(entry.typeKey || entry.type || '').replace(/\s+/gu, '')));
  const temporalEntry = archimedeas.find((entry) => /HEX/u.test(String(entry.typeKey || entry.type || '').replace(/\s+/gu, '')));
  return TASKS.map((task, index) => {
    const detailLines = [];
    if (task.id === 'archon') {
      const hunt = worldState?.archonHunt;
      if (hunt?.boss) detailLines.push(`本周首领：${ARCHON_ZH[hunt.boss] || '执刑官'}`);
      if (hunt?.missions?.length) detailLines.push(`任务：${hunt.missions.map((mission) => `${MISSION_ZH[mission.type] || '未知'} ${localizeNode(mission.node)}`).join(' → ')}`);
    } else if (task.id === 'deep-archimedea') {
      detailLines.push(...archimedeaLines(deepEntry));
      if (!progressMap['deep-archimedea']) detailLines.push('周日前完成可拿满研究点数；精英难度另计');
    } else if (task.id === 'temporal-archimedea') {
      detailLines.push(...archimedeaLines(temporalEntry));
      if (!progressMap['temporal-archimedea']) detailLines.push('霍瓦尼亚每周科研任务');
    } else if (task.id === 'netracell') {
      detailLines.push('每周 5 次搜索脉冲；可与深层科研共享周奖励上限');
    } else if (task.id === 'descendia-normal') {
      detailLines.push('普通难度 · 共 21 层');
    } else if (task.id === 'descendia-steel') {
      detailLines.push('钢铁之路难度 · 共 21 层');
    } else if (task.id === 'circuit-normal') {
      const normal = worldState?.duviriCycle?.choices?.find((choice) => choice.category === 'normal')?.choices;
      // 战甲名按硬规则保留英文
      if (normal?.length) detailLines.push(`本周战甲：${normal.join(' / ')}`);
      detailLines.push('双衍王境回廊周奖励');
    } else if (task.id === 'circuit-steel') {
      detailLines.push('灵化武器五选一 · 灵化创世适配器');
    } else if (task.id === 'nightwave') {
      const challenges = Array.isArray(worldState?.nightwave?.activeChallenges) ? worldState.nightwave.activeChallenges : [];
      const weekly = challenges.filter((challenge) => !challenge.isDaily);
      const elite = weekly.filter((challenge) => challenge.isElite);
      if (challenges.length) detailLines.push(`本周挑战：周常 ${weekly.length - elite.length} 项 + 精英 ${elite.length} 项（另有每日 ${challenges.length - weekly.length} 项）`);
      else detailLines.push('本周挑战列表暂不可用');
    } else if (task.id === 'calendar-1999') {
      const days = Array.isArray(worldState?.calendar?.days) ? worldState.calendar.days : [];
      const events = days.flatMap((day) => day.events || []);
      const todos = events.filter((event) => event.type === 'To Do').length;
      const overrides = events.filter((event) => event.type === 'Override').length;
      const prizes = events.filter((event) => event.type === 'Big Prize!');
      if (events.length) {
        detailLines.push(`本周日程：挑战 ${todos} 项 · 增益选择 ${overrides} 次 · 大奖 ${prizes.length} 份`);
        const named = [];
        days.forEach((day, dayIndex) => (day.events || []).forEach((event, eventIndex) => {
          if (event.type !== 'Big Prize!') return;
          const storePath = officialDays?.[dayIndex]?.events?.[eventIndex]?.reward;
          named.push(calendarRewardZh(event.reward, storePath, names, officialTextMap, calendarStateZh));
        }));
        const uniqueNamed = [...new Set(named)].slice(0, 4);
        if (uniqueNamed.length) detailLines.push(`大奖举例：${uniqueNamed.join('、')}`);
      } else {
        detailLines.push('1999 日历数据暂不可用');
      }
    } else if (task.id === 'kahl') {
      detailLines.push('卡尔驻军周任务：声望 + 存货储备（兑换战甲槽位/赤毒兵器）');
    }
    if (!detailLines.length) detailLines.push(task.hint);
    if (progressMap[task.id]) detailLines.push(`游戏记录：${progressMap[task.id]}`);
    return { number: index + 1, ...task, detail: detailLines[0], detailLines, done: completed.has(task.id), skipped: skipped.has(task.id) };
  });
}

function helpText() {
  return [
    '星际战甲周常命令：',
    '周常（查看本周清单，也认「周常清单/周报」）',
    '完成 1 3 5（支持编号、中文名或别名）',
    '撤销 3｜撤销 执刑官（撤销后该项不再被自动核销，发「完成」可恢复）',
    '跳过 5｜跳过 普通回廊（长期跳过，不随周重置；提醒与进度不再算它）',
    '取消跳过 5｜取消跳过 全部',
    '清空周常',
    '回廊/衰退室/沉沦/电波/执刑官/1999 日历会按游戏记录自动核销（过一次加载点后生效）。',
    '每周一协调世界时 00:00 自动换周；群聊内每位 QQ 用户独立记录。',
  ].join('\n');
}

// —— 周报一图流数据装配：世界状态 + 本地打卡记录 → buildWeeklyMegaCard 入参 ——
// 卡上编号 = TASKS 数组序号，与「完成 N」命令一致
const taskNumber = (id) => TASKS.findIndex((task) => task.id === id) + 1;

// 无尽回廊进度轨道：EndlessXP.PendingRewards 十档 → {xp, nameZh, count, reached, claimed}
// Expiry 过期 = 上周陈旧数据（与 evaluateAutoCheck 同一判据），返回 null 隐藏轨道
function circuitTrack(inventory, category, names, now = Date.now()) {
  const entry = (inventory?.EndlessXP || []).find((item) => item.Category === category);
  if (!entry || !(msOf(entry.Expiry) > now)) return null;
  const earn = Number(entry.Earn) || 0;
  const claim = Number(entry.Claim) || 0;
  const nodes = (entry.PendingRewards || [])
    .map((reward) => {
      const xp = Number(reward.RequiredTotalXp) || 0;
      const items = (reward.Rewards || []).map((item) => {
        const zh = storeItemZh(item.StoreItem, names) || '游戏内奖励（名称待词典同步）';
        const count = Number(item.ItemCount) || 1;
        return count > 1 ? `${zh} ×${count}` : zh;
      });
      return { xp, name: items.join(' + ') || '奖励', reached: earn >= xp, claimed: claim >= xp };
    })
    .filter((node) => node.xp > 0)
    .sort((a, b) => a.xp - b.xp);
  if (!nodes.length) return null;
  const goal = nodes[nodes.length - 1].xp;
  return { earn: Math.min(earn, goal), goal, ratio: Math.max(0, Math.min(1, earn / goal)), nodes, choices: entry.Choices || [] };
}

// 轮换商店板块（泰辛/瓦奇娅/已购计数）已整体移入独立「商店」模板（vendor-shop.mjs，2026-08-05）

function normalizeOracleText(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/gu, ' ');
}

export function localizeArchimedeaModifier(mod, oracleMap = new Map(), fallbackMap = staticData.archimedeaZh, options = {}) {
  const { tailMap = null, kind = '' } = options;
  const fallback = fallbackMap?.[mod?.key]
    || fallbackMap?.[String(mod?.key || '').split(/[,\s]+/u).filter(Boolean)[0]];
  // 官方备用源只有路径尾段（key 即尾段）：Oracle 语言键尾段直查，LAB/HEX 前缀消歧重名
  const keyTail = String(mod?.key || '').split(/[,\s]+/u).map((part) => part.trim().toLowerCase()).filter(Boolean)[0] || '';
  if (tailMap && keyTail) {
    const tailCandidates = tailMap.get(keyTail) || [];
    const prefix = kind === 'HEX' ? /HexConquest/iu : kind === 'LAB' ? /LabConquest/iu : null;
    const preferKind = prefix ? tailCandidates.filter((candidate) => prefix.test(String(candidate.key || ''))) : [];
    const chosen = (preferKind.length ? preferKind : tailCandidates)[0] || null;
    if (chosen) {
      return { name: chosen.name, desc: chosen.desc || fallback?.desc || '效果说明待补录，请在游戏内查看' };
    }
  }
  // warframestat 路径：英文显示名 + 说明原文/数字判别重名候选
  const candidates = oracleMap?.get?.(String(mod?.name || '').trim()) || [];
  const targetDesc = normalizeOracleText(mod?.description);
  const targetNumbers = String(mod?.description || '').match(/\d+(?:\.\d+)?/gu) || [];
  const chosen = candidates.find((candidate) => normalizeOracleText(candidate.descEn) === targetDesc)
    || candidates.find((candidate) => {
      const numbers = String(candidate.descEn || '').match(/\d+(?:\.\d+)?/gu) || [];
      return targetNumbers.length > 0 && JSON.stringify(numbers) === JSON.stringify(targetNumbers);
    })
    || candidates[0];
  let oracleDesc = chosen?.desc || '';
  if (oracleDesc.includes('|') && targetNumbers.length) {
    let numberIndex = 0;
    oracleDesc = oracleDesc.replace(/\|[^|]+\|/gu, (placeholder) => targetNumbers[numberIndex++] || placeholder);
  }
  return {
    name: chosen?.name || fallback?.name || '新增科研词缀',
    desc: oracleDesc || fallback?.desc || '效果说明待补录，请在游戏内查看',
  };
}

function buildMegaData(record, worldState, skipped = new Set(), autoResult = null, autoIds = [], names = null, calMap = null, officialDays = null, seasonRequired = null, nwPredict = null, oracleConquestMap = null, officialTextMap = null, worldStateMeta = {}, oracleConquestTails = null, calendarStateZh = null, learnedCalendarUpgrades = null) {
  const done = new Set(record.completed);
  const autoProgress = autoResult?.progress || {};
  const inventory = autoResult?.inventory || null;
  // 卡片可见时间一律显式上海时区
  const snapshotZh = autoResult?.syncedAt
    ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(autoResult.syncedAt))
    : null;
  const now = new Date();
  const weekStartDate = new Date(record.weekStart);
  const nextResetDate = new Date(nextReset());
  const weekEndDate = new Date(nextResetDate.getTime() - 1);
  const fmtDay = (date) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric' }).format(date);
  const remainMs = Math.max(0, nextResetDate.getTime() - now.getTime());

  const shardMeta = staticData.archonShards[worldState?.archonHunt?.boss] || { boss: '执刑官', shard: '源力石', color: '#4FC3F7' };
  // 深层=LAB（墓志之地），时光=HEX（霍瓦尼亚）；typeKey 带空格故用压缩匹配
  const compact = (value) => String(value || '').replace(/\s+/gu, '');
  const archimedeas = Array.isArray(worldState?.archimedeas) ? worldState.archimedeas : [];
  const deepEntry = archimedeas.find((entry) => /LAB/u.test(compact(entry.typeKey || entry.type)));
  const hexEntry = archimedeas.find((entry) => /HEX/u.test(compact(entry.typeKey || entry.type)));
  // Oracle 世界状态词典自动吸收新科研词缀；官方备用源只有路径尾段时走尾段索引（LAB/HEX 消歧）。
  // 静态表只在离线或上游缺项时兜底。
  const labMissions = (entry) => {
    const kind = compact(entry?.typeKey || entry?.type);
    const modZh = (mod) => localizeArchimedeaModifier(mod, oracleConquestMap, staticData.archimedeaZh, { tailMap: oracleConquestTails, kind });
    return (entry?.missions || []).map((mission) => ({
      typeZh: MISSION_ZH[mission.missionType] || '未知任务',
      factionZh: staticData.factionZh[mission.faction] || '未知阵营',
      deviation: modZh(mission.deviation),
      risks: (mission.risks || []).map((risk) => ({ ...modZh(risk), hard: Boolean(risk.isHard) })),
    }));
  };
  const labPersonal = (entry) => {
    const kind = compact(entry?.typeKey || entry?.type);
    const modZh = (mod) => localizeArchimedeaModifier(mod, oracleConquestMap, staticData.archimedeaZh, { tailMap: oracleConquestTails, kind });
    return (entry?.personalModifiers || []).map(modZh);
  };

  const challenges = Array.isArray(worldState?.nightwave?.activeChallenges) ? worldState.nightwave.activeChallenges : [];
  const weeklyChallenges = challenges.filter((challenge) => !challenge.isDaily && !challenge.isElite);
  const eliteChallenges = challenges.filter((challenge) => challenge.isElite);
  const dailyChallenges = challenges.filter((challenge) => challenge.isDaily);
  const standing = staticData.nightwaveStanding;
  // 逐条完成态：ChallengeProgress × requiredCount（与 evaluateAutoCheck 同判据）；快照/映射缺失时 done=null 不标
  const nwProgressByKey = new Map(((inventory?.ChallengeProgress) || []).map((item) => [String(item.Name || '').toLowerCase(), Number(item.Progress) || 0]));
  const nwTrackable = Boolean(inventory && seasonRequired && Object.keys(seasonRequired).length);
  const challengeRow = (challenge, elite) => {
    const key = String(challenge.id).replace(/^\d+/u, '');
    const required = Number(seasonRequired?.[key]) || 0;
    const cur = Math.min(nwProgressByKey.get(key) ?? 0, required);
    return {
      zh: nightwaveChallengeZh(challenge, names),
      standing: elite ? standing.elite : standing.weekly,
      elite,
      done: nwTrackable && required > 0 ? cur >= required : null,
      cur: nwTrackable && required > 0 ? cur : null,
      required: nwTrackable && required > 0 ? required : null,
    };
  };
  // 赛季总进度：快照 Affiliations 里当前电波 syndicate（worldstate tag 去空格=快照 Tag，防历代残留条目）
  const nwTag = String(worldState?.nightwave?.tag || '').replace(/\s+/gu, '');
  const nwAffil = nwTag ? ((inventory?.Affiliations) || []).find((item) => String(item.Tag) === nwTag) : null;
  const nwSeason = nwAffil ? { standing: Number(nwAffil.Standing) || 0, title: Number(nwAffil.Title) || 0 } : null;

  const days = Array.isArray(worldState?.calendar?.days) ? worldState.calendar.days : [];
  const officialSafe = Array.isArray(officialDays) && officialDays.length === days.length ? officialDays : null;
  const events = days.flatMap((day) => day.events || []);
  const prizes = days
    .map((day, dayIndex) => ({
      date: new Date(day.date),
      rewards: (day.events || []).map((event, eventIndex) => ({ event, official: officialSafe?.[dayIndex]?.events?.[eventIndex] })).filter(({ event }) => event.type === 'Big Prize!'),
    }))
    .filter((day) => day.rewards.length)
    .map((day) => ({
      dateZh: `${day.date.getUTCMonth() + 1}月${day.date.getUTCDate()}日`,
      rewardsZh: day.rewards.map(({ event, official }) => calendarRewardZh(event.reward, official?.reward, names, officialTextMap, calendarStateZh)).join(' + '),
    }));
  // v4：日历整宽混排——大奖/挑战/增益按日期顺序各占一行（大奖不再单列在前）
  // v5：接快照进度——行态 done/current/future（按原始数组下标对齐 LastCompletedDayIdx），挑战行附计数
  const calInfo = calendarSeasonProgress(inventory, worldState);
  // 本赛季已选增益逐日对号：Upgrades 全年追加式，末 N 条=本赛季已完成的 N 个三选一日、顺序=日期序
  const doneOverrideCount = calInfo ? days.filter((day, idx) => idx <= calInfo.lastIdx && (day.events || []).some((event) => event.type === 'Override')).length : 0;
  const seasonPicks = doneOverrideCount > 0 ? calInfo.upgrades.slice(-doneOverrideCount) : [];
  let overrideSeen = 0;
  const calChallengeOf = (event) => {
    if (!calMap) return { meta: null, progress: null };
    const directKey = String(event.challenge?.key || '').toLowerCase();
    if (directKey && calMap[directKey]) {
      const meta = calMap[directKey];
      const active = calInfo?.challenges?.find((item) => item.key === directKey);
      return { meta, progress: active ? { cur: active.cur, required: meta.required } : null };
    }
    // worldstate 事件无路径键：先用官方中文标题缩小候选，再用英文说明里的数量区分 Easy/Medium/Hard。
    const zhTitle = challengeTitleZh(event.challenge?.title);
    const rawRequired = Number(String(event.challenge?.description || '').match(/[\d,]+/u)?.[0]?.replace(/,/gu, '')) || 0;
    const candidates = Object.entries(calMap).filter(([, meta]) => meta?.zh && meta.zh === zhTitle);
    const selected = candidates.find(([, meta]) => rawRequired > 0 && Number(meta.required) === rawRequired) || candidates[0] || [];
    const [key, meta] = selected;
    const active = calInfo?.challenges?.find((item) => item.key === key)
      || calInfo?.challenges?.find((item) => {
        const activeMeta = calMap[item.key];
        return activeMeta?.zh === zhTitle && (!rawRequired || Number(activeMeta.required) === rawRequired);
      });
    return {
      meta: meta || null,
      progress: active && meta ? { cur: active.cur, required: meta.required } : null,
    };
  };
  const schedule = days.map((day, dayIdx) => {
    const date = new Date(day.date);
    const dateZh = `${date.getUTCMonth() + 1}月${date.getUTCDate()}日`;
    const dayEvents = (day.events || []).map((event, eventIndex) => ({ event, official: officialSafe?.[dayIdx]?.events?.[eventIndex] }));
    const prizeRewards = dayEvents.filter(({ event }) => event.type === 'Big Prize!');
    const todos = dayEvents.filter(({ event }) => event.type === 'To Do');
    const overrides = dayEvents.filter(({ event }) => event.type === 'Override');
    const state = calInfo ? (dayIdx <= calInfo.lastIdx ? 'done' : 'pending') : '';
    if (prizeRewards.length) return { dateZh, state, type: 'prize', lines: [prizeRewards.map(({ event, official }) => calendarRewardZh(event.reward, official?.reward, names, officialTextMap, calendarStateZh)).join(' + ')] };
    if (todos.length) {
      return {
        dateZh, state, type: 'todo',
        lines: todos.map(({ event }) => {
          const resolved = calChallengeOf(event);
          return calendarChallengeLine(event.challenge, resolved.meta, state === 'pending' ? resolved.progress : null);
        }),
      };
    }
    if (overrides.length) {
      // 三选一已选标记：只标已完成日；第 k 个完成的三选一日 ↔ seasonPicks[k]（选择顺序=日期顺序）
      const pickPath = state === 'done' ? seasonPicks[overrideSeen++] : null;
      const flags = chosenFlags(officialSafe?.[dayIdx]?.events, overrides.length, pickPath);
      return {
        dateZh, state, type: 'override',
        lines: overrides.map(({ event, official }, j) => {
          const entry = calendarUpgradeEntry(event.upgrade, official?.upgrade, calendarStateZh, { learnedEntries: learnedCalendarUpgrades });
          // 名称或效果任一缺失都进入 AI 查证 inbox；学习词典只能补缺，不得覆盖已有名称。
          // 无官方完整路径时不猜路径，只保持诚实占位。
          if ((entry.name === CALENDAR_UPGRADE_PLACEHOLDER_ZH || !entry.desc) && official?.upgrade) queuePendingCalendarUpgrade(official.upgrade);
          return { ...entry, chosen: Boolean(flags[j]) };
        }),
      };
    }
    return null;
  }).filter(Boolean);
  // 第一个未完成节点 = 当前进行中
  const firstPending = schedule.find((day) => day.state === 'pending');
  if (firstPending) firstPending.state = 'current';

  const frames = worldState?.duviriCycle?.choices?.find((choice) => choice.category === 'normal')?.choices || [];
  const weaponKeys = worldState?.duviriCycle?.choices?.find((choice) => choice.category === 'hard')?.choices || [];
  // 已拥有战甲集合（uniqueName）：回廊战甲 chips 的「已有」标
  const suitSet = new Set((inventory?.Suits || []).map((suit) => suit.ItemType));

  return {
    weekStart: record.weekStart,
    worldStateAvailable: Boolean(worldState),
    worldStateStale: Boolean(worldStateMeta.stale),
    archimedeasAvailable: hasCompleteArchimedeas(worldState?.archimedeas),
    dateRange: `${fmtDay(weekStartDate)} – ${fmtDay(weekEndDate)}`,
    generatedAt: new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(now),
    resetRemainMs: remainMs,
    resetBig: `${Math.floor(remainMs / 86400000)}天`,
    resetSmall: `${Math.floor((remainMs % 86400000) / 3600000)} 小时`,
    // 进度分母排除跳过项：跳过不是没做，是不做
    taskDone: TASKS.filter((task) => done.has(task.id) && !skipped.has(task.id)).length,
    taskTotal: TASKS.length - skipped.size,
    taskSkipped: skipped.size,
    archon: {
      number: taskNumber('archon'), done: done.has('archon'), skipped: skipped.has('archon'),
      bossZh: shardMeta.boss, shard: shardMeta.shard, shardColor: shardMeta.color, shardIcon: shardMeta.icon || null,
      missions: (worldState?.archonHunt?.missions || []).map((mission) => ({ typeZh: MISSION_ZH[mission.type] || '未知任务', nodeZh: localizeNode(mission.node) })),
    },
    labs: [
      { number: taskNumber('deep-archimedea'), done: done.has('deep-archimedea'), skipped: skipped.has('deep-archimedea'), title: '深层科研', place: '墓志之地 · 死灵中枢', accent: '#9B7EDE', missions: labMissions(deepEntry), personal: labPersonal(deepEntry), progress: autoProgress['deep-archimedea'] || '', rewardLine: '按研究点数分档结算：赋能 · 稀有资源 · 源力石档位（精英难度档更高）' },
      { number: taskNumber('temporal-archimedea'), done: done.has('temporal-archimedea'), skipped: skipped.has('temporal-archimedea'), title: '时光科研', place: '霍瓦尼亚 · 1999', accent: '#F0B429', missions: labMissions(hexEntry), personal: labPersonal(hexEntry), progress: autoProgress['temporal-archimedea'] || '', rewardLine: '按研究点数分档结算：赋能 · 稀有资源 · 源力石档位（与深层独立结算）' },
    ],
    routines: [
      // 2×2 网格顺序=编号序：上排 衰退室｜击溃合一众，下排 沉沦普通（左）｜沉沦钢铁（右）（2026-08-06 用户拍板）
      { number: taskNumber('netracell'), done: done.has('netracell'), skipped: skipped.has('netracell'), title: '衰退室', accent: '#57C98B', conditions: [...staticData.conditions.netracell, ...(autoProgress.netracell ? [`游戏记录：${autoProgress.netracell}`] : [])], rewards: staticData.rewards.netracell },
      { number: taskNumber('kahl'), done: done.has('kahl'), skipped: skipped.has('kahl'), title: '击溃合一众', accent: '#C0845E', conditions: staticData.conditions.kahl || ['卡尔驻军周任务'], rewards: staticData.rewards.kahl || ['声望 · 存货储备'] },
      { number: taskNumber('descendia-normal'), done: done.has('descendia-normal'), skipped: skipped.has('descendia-normal'), title: '沉沦之地 · 普通', accent: '#4FC3F7', conditions: [...staticData.conditions['descendia-normal'], ...(autoProgress['descendia-normal'] ? [`游戏记录：${autoProgress['descendia-normal']}`] : [])], rewards: staticData.rewards['descendia-normal'] },
      { number: taskNumber('descendia-steel'), done: done.has('descendia-steel'), skipped: skipped.has('descendia-steel'), title: '沉沦之地 · 钢铁', accent: '#E0513C', conditions: [...staticData.conditions['descendia-steel'], ...(autoProgress['descendia-steel'] ? [`游戏记录：${autoProgress['descendia-steel']}`] : [])], rewards: staticData.rewards['descendia-steel'] },
    ],
    // 战甲名按硬规则保留英文；灵化武器用静态表映射官方中文名；普通/钢铁回廊各自独立打卡
    circuit: {
      // owned=拥有该具体战甲（AlecaFrame 绿勾语义：普通≠Prime，Suits uniqueName 精确比对）
      frames: frames.map((name) => ({ name, owned: Boolean(names?.uniqByName && suitSet?.has(names.uniqByName.get(name))) })),
      weapons: weaponKeys.map((key) => ({ key, name: officialTextZh(key, officialTextMap) || staticData.incarnonZh[key] || '灵化武器（名称待词典同步）' })),
      normal: {
        number: taskNumber('circuit-normal'), done: done.has('circuit-normal'), skipped: skipped.has('circuit-normal'),
        progress: autoProgress['circuit-normal'] || '', track: circuitTrack(inventory, 'EXC_NORMAL', names),
      },
      steel: {
        number: taskNumber('circuit-steel'), done: done.has('circuit-steel'), skipped: skipped.has('circuit-steel'),
        progress: autoProgress['circuit-steel'] || '', track: circuitTrack(inventory, 'EXC_HARD', names),
      },
    },
    nightwave: {
      number: taskNumber('nightwave'), done: done.has('nightwave'), skipped: skipped.has('nightwave'),
      weekly: weeklyChallenges.map((challenge) => challengeRow(challenge, false)),
      elite: eliteChallenges.map((challenge) => challengeRow(challenge, true)),
      dailyCount: dailyChallenges.length,
      dailyStanding: standing.daily, weeklyStanding: standing.weekly, eliteStanding: standing.elite,
      totalStanding: (weeklyChallenges.length * standing.weekly + eliteChallenges.length * standing.elite).toLocaleString('en-US'),
      season: nwSeason,
      predict: nwPredict,
      progress: autoProgress.nightwave || '',
    },
    kahl: { number: taskNumber('kahl'), done: done.has('kahl'), skipped: skipped.has('kahl') },
    calendar: {
      number: taskNumber('calendar-1999'), done: done.has('calendar-1999'), skipped: skipped.has('calendar-1999'),
      prizes,
      schedule,
      prizeDayCount: prizes.length,
      todoCount: events.filter((event) => event.type === 'To Do').length,
      overrideCount: days.filter((day) => (day.events || []).some((event) => event.type === 'Override')).length,
      // 快照进度（周界校验不过则为 null，卡面退回纯展示）
      progress: calInfo ? { doneCount: calInfo.doneCount, totalCount: calInfo.totalCount, upgradeCount: calInfo.upgradeCount } : null,
    },
    // 页脚标注：自动核销数量 + 快照时间，方便用户判断数据新鲜度
    autoNote: autoIds.length ? `${autoIds.length} 项由游戏记录自动核销（快照 ${snapshotZh || '—'}）` : (snapshotZh ? `游戏快照 ${snapshotZh}` : ''),
  };
}

// —— 电波赛季声望采样与满级预测（2026-08-06 用户 idea）——
// 快照只有累计值，历史速率靠自己积累：每次渲卡记一点（样本时间=快照 syncedAt），
// 按赛季 tag 隔离（换赛季旧样本作废）、同一 UTC 日只留最新一条，cap 60
const NW_MAX_TITLE = 30;
const NW_STANDING_PER_TITLE = 10000;
function recordNightwaveSample(state, tag, standing, sampleAt) {
  if (!tag || !Number.isFinite(standing) || !Number.isFinite(sampleAt)) return false;
  const day = new Date(sampleAt).toISOString().slice(0, 10);
  // 只挤掉「同赛季同日」旧条目；异赛季样本保留（预测按 tag 过滤，cap 自然淘汰）
  const kept = (state.nightwaveSamples || []).filter((item) => item.tag !== tag || item.day !== day);
  const next = [...kept, { tag, day, t: sampleAt, standing }].sort((a, b) => a.t - b.t).slice(-60);
  const before = JSON.stringify(state.nightwaveSamples || []);
  state.nightwaveSamples = next;
  return JSON.stringify(next) !== before;
}

// 预测文案：近期速率（距今 3~35 天最旧采样点差分）优先，样本不足退赛季平均；
// 已满级/速率非正/缺起点时返 null 不显示，宁缺不乱
function predictNightwaveText(samples, tag, standing, activationMs, expiryMs, now = Date.now()) {
  if (!Number.isFinite(standing) || standing >= NW_MAX_TITLE * NW_STANDING_PER_TITLE) return null;
  const goal = NW_MAX_TITLE * NW_STANDING_PER_TITLE;
  let rate = null;
  let basis = '';
  const mine = (samples || []).filter((item) => item.tag === tag && now - item.t >= 3 * 86400000 && now - item.t <= 35 * 86400000 && standing > item.standing);
  if (mine.length) {
    const oldest = mine[0];
    rate = (standing - oldest.standing) / (now - oldest.t);
    basis = '近期进度';
  } else if (Number.isFinite(activationMs) && now > activationMs && standing > 0) {
    rate = standing / (now - activationMs);
    basis = '赛季均速';
  }
  if (!rate || rate <= 0) return null;
  const etaMs = now + (goal - standing) / rate;
  if (Number.isFinite(expiryMs) && etaMs > expiryMs) {
    const shortfall = Math.max(0, Math.round(goal - standing - rate * (expiryMs - now)));
    return `按${basis}推算，赛季结束前约差 ${shortfall.toLocaleString('en-US')} 声望满级`;
  }
  const eta = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' }).format(new Date(etaMs));
  return `按${basis}推算，预计 ${eta} 满级奖励轨道`;
}

// 采样+预测一条龙：读当前电波声望→落一条采样→给预测文案；任何失败静默返 null（预测是锦上添花不许拖垮渲染）
async function sampleAndPredict(statePath, worldState, autoResult) {
  try {
    const nwTag = String(worldState?.nightwave?.tag || '').replace(/\s+/gu, '');
    const affil = nwTag ? ((autoResult?.inventory?.Affiliations) || []).find((item) => String(item.Tag) === nwTag) : null;
    if (!affil) return null;
    const standing = Number(affil.Standing) || 0;
    const sampleAt = Number.isFinite(Number(autoResult?.syncedAt)) ? Number(autoResult.syncedAt) : new Date(autoResult?.syncedAt || Date.now()).getTime();
    let samples = [];
    if (statePath) {
      samples = await withStateLock(statePath, async () => {
        const state = await readState(statePath);
        if (recordNightwaveSample(state, nwTag, standing, sampleAt)) await writeState(statePath, state);
        return state.nightwaveSamples;
      }).catch(() => []);
    }
    const activationMs = new Date(worldState?.nightwave?.activation || NaN).getTime();
    const expiryMs = new Date(worldState?.nightwave?.expiry || NaN).getTime();
    return predictNightwaveText(samples, nwTag, standing, activationMs, expiryMs);
  } catch {
    return null;
  }
}

async function renderResult(record, cardDir, actionText = '', skipped = new Set(), statePath = null) {
  const { value: worldState, error: worldStateError, stale: worldStateStale } = await fetchWorldState();
  // 先合并快照自动核销再渲染：手动记录与自动判定取并集，撤销过的项不再自动打上
  const state = statePath ? await readState(statePath).catch(() => emptyState()) : emptyState();
  const autoResult = await autoCheckFromSnapshot(worldState, state.conquestSamples);
  const { record: effective, autoIds } = mergeAutoRecord(record, autoResult);
  const [names, calMap, officialDays, seasonRequired, oracleConquestMap, officialTextMap, oracleConquestTails, calendarStateZh] = await Promise.all([loadNameTables(), getCalendarChallengeMap(), loadOfficialCalendarDays(), getSeasonChallengeRequired(), getOracleConquestMap(), getOfficialTextMap(), getOracleConquestTailMap(), getCalendarStateZhMap(), primeChallengeZh()]);
  const learnedCalendarUpgrades = await loadCalendarUpgradeLearned();
  const rows = taskRows(effective, worldState, skipped, autoResult?.progress || {}, { names, officialDays, officialTextMap, calendarStateZh });
  const nwPredict = await sampleAndPredict(statePath, worldState, autoResult);
  // 科研分数样本落盘：本次渲染后，同周同类只留最新一条（供下一周判断分数是否真的变过）
  await recordConquestObservations(statePath, autoResult?.observations);
  const card = buildWeeklyMegaCard(buildMegaData(effective, worldState, skipped, autoResult, autoIds, names, calMap, officialDays, seasonRequired, nwPredict, oracleConquestMap, officialTextMap, { stale: worldStateStale }, oracleConquestTails, calendarStateZh, learnedCalendarUpgrades));
  let mediaUrl = null;
  if (cardDir) mediaUrl = await renderWarframeCard(card, cardDir).catch(() => null);
  const active = rows.filter((item) => !item.skipped);
  const completedCount = active.filter((item) => item.done).length;
  const skipNote = skipped.size ? `（另跳过 ${skipped.size} 项）` : '';
  const autoNote = autoIds.length ? `其中 ${autoIds.length} 项由游戏记录自动核销。` : '';
  const status = `${actionText ? `${actionText}\n` : ''}本周已完成 ${completedCount}/${active.length}${skipNote}。${autoNote}`;
  return {
    ok: true,
    text: `${status}${worldStateError ? '\n⚠️ 世界状态暂不可用，已显示本地清单。' : worldStateStale ? '\nℹ️ 世界状态接口暂时异常，已使用本周可靠缓存。' : ''}`,
    ...(mediaUrl ? { mediaUrl } : {}),
    tasks: rows,
    autoChecked: autoIds,
    weekStart: record.weekStart,
    nextReset: nextReset(),
  };
}

async function manageWeekly(message, context, statePath, cardDir) {
  const text = normalize(message).replace(/^\//u, '');
  if (/^周常帮助$/u.test(text)) return { ok: true, text: helpText() };
  const action = text.match(/^(完成|撤销|跳过|取消跳过)\s+(.+)$/u);
  // 同义词一律等价「周常」：曾因「周常清单」不在白名单落进模型兼容路径，图被 agent 管线压糊
  if (/^(?:周常|当前周常|周常清单|周常列表|本周周常|周报)$/u.test(text)) {
    const state = await readState(statePath);
    return renderResult(currentRecord(state, context), cardDir, '', currentSkipped(state, context), statePath);
  }
  if (/^清空周常$/u.test(text)) {
    const { record, skipped } = await withStateLock(statePath, async () => {
      const state = await readState(statePath);
      const current = currentRecord(state, context);
      current.completed = [];
      saveRecord(state, current);
      await writeState(statePath, state);
      return { record: current, skipped: currentSkipped(state, context) };
    });
    return renderResult(record, cardDir, '已清空本周完成记录。', skipped, statePath);
  }
  if (action) {
    const verb = action[1];
    const resolved = verb === '取消跳过' && /^(?:全部|all)$/iu.test(normalize(action[2]).toLowerCase())
      ? { selected: ['*'], unknown: [] }
      : resolveSelectors(action[2]);
    if (!resolved.selected.length || resolved.unknown.length) {
      const suffix = resolved.unknown.length ? `无法识别：${resolved.unknown.join('、')}。` : '请提供编号或项目名。';
      return { ok: false, text: `${suffix}\n发送“周常帮助”查看用法。` };
    }
    const { record, skipped } = await withStateLock(statePath, async () => {
      const state = await readState(statePath);
      const current = currentRecord(state, context);
      const completed = new Set(current.completed);
      const dismissedSet = new Set(current.dismissed || []);
      const skippedSet = currentSkipped(state, context);
      for (const id of resolved.selected) {
        if (verb === '完成') { completed.add(id); skippedSet.delete(id); dismissedSet.delete(id); }
        // 撤销同时记入 dismissed：防止快照自动核销把用户刚撤掉的项又打回去
        else if (verb === '撤销') { completed.delete(id); dismissedSet.add(id); }
        else if (verb === '跳过') { skippedSet.add(id); completed.delete(id); }
        else if (verb === '取消跳过') { if (id === '*') skippedSet.clear(); else skippedSet.delete(id); }
      }
      current.completed = [...completed];
      current.dismissed = [...dismissedSet];
      saveRecord(state, current);
      saveSkipped(state, context, skippedSet);
      await writeState(statePath, state);
      return { record: current, skipped: skippedSet };
    });
    const labels = resolved.selected.map((id) => id === '*' ? '全部' : (TASKS.find((task) => task.id === id)?.name || id)).join('、');
    const verbText = verb === '完成' ? '已完成' : verb === '撤销' ? '已撤销' : verb === '跳过' ? '已跳过（长期生效，发「取消跳过 编号」恢复）' : '已取消跳过';
    return renderResult(record, cardDir, `${verbText}：${labels}`, skipped, statePath);
  }
  return { ok: false, text: helpText() };
}

// 供订阅监测在周刷新时推送：读指定用户的完成记录，用已拉好的世界状态渲染详细卡
async function renderWeeklyDetailCardFor(weeklyStatePath, context, worldState, cardDir) {
  const repaired = await fetchWorldState(worldState);
  const effectiveWorldState = repaired.value || worldState;
  const state = await readState(weeklyStatePath);
  const record = currentRecord(state, context);
  const skipped = currentSkipped(state, context);
  const autoResult = await autoCheckFromSnapshot(effectiveWorldState, state.conquestSamples);
  const { record: effective, autoIds } = mergeAutoRecord(record, autoResult);
  const [names, calMap, officialDays, seasonRequired, oracleConquestMap, officialTextMap, oracleConquestTails, calendarStateZh] = await Promise.all([loadNameTables(), getCalendarChallengeMap(), loadOfficialCalendarDays(), getSeasonChallengeRequired(), getOracleConquestMap(), getOfficialTextMap(), getOracleConquestTailMap(), getCalendarStateZhMap(), primeChallengeZh()]);
  const learnedCalendarUpgrades = await loadCalendarUpgradeLearned();
  const rows = taskRows(effective, effectiveWorldState, skipped, autoResult?.progress || {}, { names, officialDays, officialTextMap, calendarStateZh });
  const nwPredict = await sampleAndPredict(weeklyStatePath, effectiveWorldState, autoResult);
  await recordConquestObservations(weeklyStatePath, autoResult?.observations);
  const card = buildWeeklyMegaCard(buildMegaData(effective, effectiveWorldState, skipped, autoResult, autoIds, names, calMap, officialDays, seasonRequired, nwPredict, oracleConquestMap, officialTextMap, { stale: repaired.stale }, oracleConquestTails, calendarStateZh, learnedCalendarUpgrades));
  if (!cardDir) return { mediaUrl: null, rows };
  const mediaUrl = await renderWarframeCard(card, cardDir).catch(() => null);
  return { mediaUrl, rows };
}

// —— 周日提醒：只读本地打卡记录 + 订阅账本；提醒前拉一次本周世界状态 ——
// 使执刑官/电波也能按本周对账自动核销（每周一次、带 5 分钟缓存与失败降级）。
// 网络或缓存失败时退回保守模式：不传 worldState，执刑官/电波跳过自动判定，宁多提醒不漏提醒。
// cron 周日 20:00 北京时间触发；没有启用的周常订阅或全部完成时输出 NO_REPLY 不打扰
async function remindWeekly(weeklyStatePath, ledgerPath, target, options = {}) {
  let ledger;
  try { ledger = JSON.parse(await readFile(ledgerPath, 'utf8')); }
  catch { return { output: 'NO_REPLY\n', data: { ok: true, reason: 'no_ledger' } }; }
  const subs = (Array.isArray(ledger.subscriptions) ? ledger.subscriptions : [])
    .filter((item) => item.target === target && item.enabled && item.type === 'weekly');
  if (!subs.length) return { output: 'NO_REPLY\n', data: { ok: true, reason: 'no_weekly_subscription' } };

  const state = await readState(weeklyStatePath);
  // 提醒前先合并快照自动核销；世界状态拉取失败（或测试注入失败）时 worldState 为 null，
  // 执刑官/电波两项跳过自动判定，宁多提醒不漏提醒（绝不让对账失败吞掉整个提醒）。
  const fetchWorld = options.fetchWorldState || fetchWorldState;
  let fetched = null;
  try { fetched = await fetchWorld(); } catch { fetched = null; }
  const autoResult = await autoCheckFromSnapshot(fetched?.value || null, state.conquestSamples);
  await recordConquestObservations(weeklyStatePath, autoResult?.observations);
  const lines = [];
  for (const sub of subs) {
    const record = currentRecord(state, { target, ownerId: sub.ownerId, ownerName: sub.ownerName });
    const { record: effective } = mergeAutoRecord(record, autoResult);
    const completed = new Set(effective.completed);
    const skipped = currentSkipped(state, { target, ownerId: sub.ownerId });
    // 跳过项不参与提醒：已完成+已跳过覆盖全部时视同全部完成
    const pending = TASKS.filter((task) => !completed.has(task.id) && !skipped.has(task.id));
    if (!pending.length) continue;
    const activeTotal = TASKS.length - skipped.size;
    lines.push(`⏰ 周常收尾提醒：本周还剩 ${pending.length}/${activeTotal} 项未完成，明早 08:00 重置。`);
    lines.push(...pending.map((task) => `${TASKS.indexOf(task) + 1}. ${task.name}`));
    lines.push('回「完成 编号」打卡，回「周常」看完整清单。');
  }
  if (!lines.length) return { output: 'NO_REPLY\n', data: { ok: true, reason: 'all_done' } };
  return { output: `${lines.join('\n')}\n`, data: { ok: true, pending: true } };
}

function outputJson(value) {
  process.stdout.write(`${JSON.stringify(value, stripDataUriReplacer)}\n`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (command === 'remind') {
    const result = await remindWeekly(
      path.resolve(String(args.state || DEFAULT_STATE)),
      path.resolve(String(args.ledger || '')),
      normalize(args.target).toLowerCase(),
    );
    process.stdout.write(result.output);
    return;
  }
  if (command !== 'manage') {
    outputJson({ ok: false, error: '用法：manage --state <状态文件> --message <命令> --target <QQ目标> --owner <发送者>｜remind --state <状态文件> --ledger <订阅账本> --target <QQ目标>' });
    process.exitCode = 1;
    return;
  }
  outputJson(await manageWeekly(normalize(args.message), {
    target: normalize(args.target).toLowerCase(),
    ownerId: normalize(args.owner).toLowerCase(),
    ownerName: normalize(args['owner-name']) || normalize(args.owner).toLowerCase(),
  }, path.resolve(String(args.state || DEFAULT_STATE)), args['card-dir'] ? path.resolve(String(args['card-dir'])) : null));
}

export { TASKS, calendarSeasonProgress, challengeTitleZh, chosenFlags, evaluateAutoCheck, loadNameTables, manageWeekly, mergeAutoRecord, nextReset, nightwaveChallengeZh, predictNightwaveText, primeChallengeZh, recordNightwaveSample, remindWeekly, renderWeeklyDetailCardFor, resolveSelectors, storeItemZh, translateDesc, weekStart };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // remind 由 cron 直接投递，异常静默；manage 由插件解析 JSON，保留结构化错误
    if (process.argv[2] === 'remind') process.stdout.write('NO_REPLY\n');
    else outputJson({ ok: false, error: String(error?.message || error), stack: error?.stack || null });
    process.exitCode = 1;
  });
}
