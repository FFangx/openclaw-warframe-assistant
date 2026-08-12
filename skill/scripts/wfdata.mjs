#!/usr/bin/env node

// browse.wf 系在线参考数据（2026-08-04 数据源盘点后接入）：
// 1) 挑战译名映射：ExportChallenges(语言键) × dict.en/dict.zh → 英文标题→官方中文标题
//    覆盖午夜电波 + 1999 日历全部挑战，实测本周 10/10 + 6/6 全中——终结逐周手工补表
// 2) 活动名映射：oracle.browse.wf/dicts en×zh（227 条 worldstate 专用语言键：三伏天/恶狼狩猎等）
// 3) 仲裁场地评级：supplemental-data/arbyTiers.js（社区 S~F 评级）
// 统一约定：磁盘缓存 + 网络失败静默降级（返回空 Map/空对象），调用方自带静态表兜底。

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FETCH_TIMEOUT_MS = 20_000;
// 持久缓存目录（%TEMP% 会被系统清理，兼底层必须活得久）：scripts → … → workspace/.cache/warframe-data
// WARFRAME_DATA_CACHE_DIR 供测试隔离，生产不设
const DATA_CACHE_DIR = process.env.WARFRAME_DATA_CACHE_DIR
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.cache', 'warframe-data');
const CHALLENGE_URL = 'https://browse.wf/warframe-public-export-plus/ExportChallenges.json';
const DICT_EN_URL = 'https://browse.wf/warframe-public-export-plus/dict.en.json';
const DICT_ZH_URL = 'https://browse.wf/warframe-public-export-plus/dict.zh.json';
const ORACLE_DICT_EN_URL = 'https://oracle.browse.wf/dicts/en.json';
const ORACLE_DICT_ZH_URL = 'https://oracle.browse.wf/dicts/zh.json';
const ARBY_TIERS_URL = 'https://browse.wf/supplemental-data/arbyTiers.js';

const CHALLENGE_CACHE = path.join(DATA_CACHE_DIR, 'challenge-zh.json');
const EVENT_CACHE = path.join(DATA_CACHE_DIR, 'event-zh.json');
const ORACLE_CONQUEST_CACHE = path.join(DATA_CACHE_DIR, 'oracle-conquest-zh.json');
const OFFICIAL_TEXT_CACHE = path.join(DATA_CACHE_DIR, 'official-text-zh.json');
const ARBY_CACHE = path.join(DATA_CACHE_DIR, 'arby-tiers.json');
const BOUNTY_CACHE = path.join(DATA_CACHE_DIR, 'bounty-zh.json');
const CALENDAR_CHALLENGE_CACHE = path.join(DATA_CACHE_DIR, 'calendar-challenge.json');
const SEASON_REQUIRED_CACHE = path.join(DATA_CACHE_DIR, 'season-challenge-required.json');
// 词典是静态文件、挑战池版本更新才变：7 天足够新鲜且把 10MB 级下载摊薄
const CHALLENGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EVENT_TTL_MS = 24 * 60 * 60 * 1000;
const ARBY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BOUNTY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CALENDAR_CHALLENGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  return response.json();
}

// 缓存的是「构建好的小映射」而不是原始词典（dict.zh 3.5 万条只在重建时拉一次）
async function cachedBuild(cachePath, ttlMs, version, builder) {
  const result = await staleCachedJson(path.basename(cachePath, '.json'), { ttlMs, version }, builder);
  return result.data;
}

// —— 通用双层缓存：新鲜用 TTL，刷新失败时退回陈旧快照（stale:true + cachedAt 供调用方标注） ——
export async function staleCachedJson(name, { ttlMs, version = 1 }, fetcher) {
  const file = path.join(DATA_CACHE_DIR, `${name}.json`);
  let cached = null;
  try { cached = JSON.parse(await readFile(file, 'utf8')); } catch { /* 无缓存 */ }
  if (cached?.v === version && Date.now() - cached.at < ttlMs) return { data: cached.data, stale: false, cachedAt: cached.at };
  try {
    const data = await fetcher();
    await mkdir(DATA_CACHE_DIR, { recursive: true });
    await writeFile(file, JSON.stringify({ at: Date.now(), v: version, data }), 'utf8').catch(() => {});
    return { data, stale: false, cachedAt: Date.now() };
  } catch (error) {
    if (cached?.v === version) return { data: cached.data, stale: true, cachedAt: cached.at };
    throw error;
  }
}

// 忽略 TTL 直读快照（离线兜底专用）；无缓存返回 null
export async function readCachedData(name, version = 1) {
  try {
    const cached = JSON.parse(await readFile(path.join(DATA_CACHE_DIR, `${name}.json`), 'utf8'));
    if (cached?.v === version) return { data: cached.data, cachedAt: cached.at };
  } catch { /* 无缓存 */ }
  return null;
}

// —— 价格记忆：每次成功查价顺手记一笔，wm 挂掉时回放「上次见过的价」 ——
const PRICE_MEMORY_FILE = path.join(DATA_CACHE_DIR, 'price-memory.json');
const PRICE_MEMORY_CAP = 800;
const priceKey = (slug, rank) => `${slug}#${rank ?? '-'}`;

export async function rememberPrice(slug, rank, platinum) {
  if (!slug || !Number.isFinite(Number(platinum))) return;
  try {
    let memory = {};
    try { memory = JSON.parse(await readFile(PRICE_MEMORY_FILE, 'utf8')); } catch { /* 首次 */ }
    memory[priceKey(slug, rank)] = { p: Number(platinum), at: Date.now() };
    const entries = Object.entries(memory);
    if (entries.length > PRICE_MEMORY_CAP) {
      memory = Object.fromEntries(entries.sort((a, b) => b[1].at - a[1].at).slice(0, PRICE_MEMORY_CAP));
    }
    await mkdir(DATA_CACHE_DIR, { recursive: true });
    await writeFile(PRICE_MEMORY_FILE, JSON.stringify(memory), 'utf8');
  } catch { /* 记忆失败不影响主流程 */ }
}

export async function recallPrice(slug, rank) {
  try {
    const memory = JSON.parse(await readFile(PRICE_MEMORY_FILE, 'utf8'));
    const hit = memory[priceKey(slug, rank)];
    return hit ? { platinum: hit.p, at: hit.at } : null;
  } catch {
    return null;
  }
}

// —— 物品图片缓存：下载一次落盘（文件名自带内容哈希，无 TTL），之后离线可用；任何失败返回 null 让卡片无图降级 ——
const IMAGE_CACHE_DIR = path.join(DATA_CACHE_DIR, 'item-images');
export async function imageDataUri(url) {
  if (!url) return null;
  const name = String(url).split('/').at(-1).split('?')[0].replace(/[^\w.-]/gu, '_').slice(-80);
  if (!name) return null;
  const file = path.join(IMAGE_CACHE_DIR, name);
  let buffer = null;
  try { buffer = await readFile(file); } catch { /* 未缓存 */ }
  if (!buffer) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) return null;
      buffer = Buffer.from(await response.arrayBuffer());
      await mkdir(IMAGE_CACHE_DIR, { recursive: true });
      await writeFile(file, buffer).catch(() => {});
    } catch { return null; }
  }
  const mime = /\.jpe?g$/iu.test(name) ? 'image/jpeg' : /\.webp$/iu.test(name) ? 'image/webp' : 'image/png';
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

// —— stdout JSON replacer：内嵌图 base64 只服务渲染，出口序列化时剥掉，
// 否则单区悬赏这类多图 data 会撑爆插件 execFile 的 maxBuffer（2026-08-06 真实事故）——
export function stripDataUriReplacer(key, value) {
  if (typeof value === 'string' && value.length > 256 && value.startsWith('data:image')) return '[inline-image]';
  return value;
}

// —— 游戏原图（browse.wf 直 serve 的 DE 纹理，与 wm 素材同源同风格）：uniqueName → 物品 JSON.icon → 图 base64 ——
// icon 路径基本不变，落盘 memo 免重复两跳；查无 icon 记 null 防反复打接口，网络失败不记（下次再试）
const GAME_ICON_MEMO_FILE = path.join(DATA_CACHE_DIR, 'game-icon-paths.json');
export async function gameIconDataUri(uniqueName) {
  if (!uniqueName || !String(uniqueName).startsWith('/Lotus/')) return null;
  let memo = {};
  try { memo = JSON.parse(await readFile(GAME_ICON_MEMO_FILE, 'utf8')); } catch { /* 首次 */ }
  let icon = memo[uniqueName];
  if (icon === undefined) {
    try {
      const response = await fetch(`https://browse.wf${uniqueName}`, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      const data = response.ok ? await response.json().catch(() => null) : null;
      icon = data?.icon || null;
      memo[uniqueName] = icon;
      await mkdir(DATA_CACHE_DIR, { recursive: true });
      await writeFile(GAME_ICON_MEMO_FILE, JSON.stringify(memo), 'utf8').catch(() => {});
    } catch { return null; }
  }
  return icon ? imageDataUri(`https://browse.wf${icon}`) : null;
}

// Prime 战甲蓝图对象本身没有 icon，游戏图挂在 resultType 成品组件上；
// Warframe.Market 缩略图又常用整甲立绘。这三类部件因此显式复用游戏的通用 Prime 部件原图。
const PRIME_FRAME_PART_ICONS = Object.freeze({
  chassis: '/Lotus/Interface/Icons/StoreIcons/Resources/CraftingComponents/GenericWarframePrimeChassis.png',
  neuroptics: '/Lotus/Interface/Icons/StoreIcons/Resources/CraftingComponents/GenericWarframePrimeHelmet.png',
  systems: '/Lotus/Interface/Icons/StoreIcons/Resources/CraftingComponents/GenericWarframePrimeSystem.png',
});

export function primeWarframePartIconPath(uniqueName, englishName = '') {
  const unique = String(uniqueName || '');
  const name = String(englishName || '');
  const haystack = `${unique} ${name}`;
  const primeFrameRecipe = /\/WarframeRecipes\//iu.test(unique) && /Prime/iu.test(unique);
  const primeFrameName = /\bPrime\s+(?:Chassis|Neuroptics|Systems?)(?:\s+Blueprint)?\b/iu.test(name);
  if (!primeFrameRecipe && !primeFrameName) return null;
  if (/Chassis/iu.test(haystack)) return PRIME_FRAME_PART_ICONS.chassis;
  if (/(?:Helmet|Neuroptics)/iu.test(haystack)) return PRIME_FRAME_PART_ICONS.neuroptics;
  if (/Systems?/iu.test(haystack)) return PRIME_FRAME_PART_ICONS.systems;
  return null;
}

export async function primeWarframePartIconDataUri(uniqueName, englishName = '') {
  const icon = primeWarframePartIconPath(uniqueName, englishName);
  return icon ? imageDataUri(`https://browse.wf${icon}`) : null;
}

// ==== AlecaFrame 本地数据统一入口（2026-08-07 开源迁移：6 处重复解析器收敛 + 无 AlecaFrame 在线兜底） ====
// 本地 cachedData 优先（快、离线可用）；读不到时在线兜底，公开功能不再依赖装 AlecaFrame：
//   - 目录 json（Relics/Warframes/Mods…/rivensV2）→ cdn.alecaframe.com（AlecaFrame 自己的分发源，同构零转换）
//   - lang.json → warframestat items?language=zh 重建同构表（2026-08-07 全量对账 16687/16687 与本地一致）

export function resolveAlecaDir() {
  return process.env.ALECAFRAME_DATA_DIR
    || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'AlecaFrame');
}

const ALECA_CDN = 'https://cdn.alecaframe.com/warframeData';
// CDN 上的相对路径与本地 cachedData 相同：json/Relics.json、custom/rivensV2.json
const ALECA_JSON_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// WARFRAME_OFFLINE=1 禁止词典/目录在线兑底（测试确定性 + doctor 断网态验证）
const offlineMode = () => process.env.WARFRAME_OFFLINE === '1';

// 目录 json：本地 → CDN 兑底（staleCachedJson 缓存 7d，失败退陈旧）→ null（调用方自带降级）
export async function readAlecaJson(relPath, { alecaDir } = {}) {
  try {
    return JSON.parse(await readFile(path.join(alecaDir || resolveAlecaDir(), 'cachedData', ...String(relPath).split('/')), 'utf8'));
  } catch { /* 本地缺失，走在线兑底 */ }
  if (offlineMode()) return null;
  try {
    const cacheName = `aleca-${String(relPath).replace(/[^\w.-]/gu, '_').replace(/\.json$/iu, '')}`;
    const { data } = await staleCachedJson(cacheName, { ttlMs: ALECA_JSON_TTL_MS, version: 1 }, () => fetchJson(`${ALECA_CDN}/${relPath}`));
    return data;
  } catch {
    return null;
  }
}

// lang 表（uniqueName → {zh:{name}}，与本地 lang.json 同构）：本地 → AlecaFrame CDN → warframestat 重建 → 空表
// 按目录键缓存（测试注入不同 alecaDir 不串表）；13MB 文件进程内每目录只解析一次；在线重建落盘 7d
const LANG_TTL_MS = 7 * 24 * 60 * 60 * 1000;
let langTablePromises = new Map();
let langTableStub;
export function getLangTable({ alecaDir } = {}) {
  if (langTableStub !== undefined) return Promise.resolve(langTableStub);
  const dir = alecaDir || resolveAlecaDir();
  if (!langTablePromises.has(dir)) {
    langTablePromises.set(dir, (async () => {
      try {
        return JSON.parse(await readFile(path.join(dir, 'cachedData', 'json', 'lang.json'), 'utf8'));
      } catch { /* 本地缺失 */ }
      if (offlineMode()) return {};
      try {
        const { data } = await staleCachedJson('lang-zh-rebuilt', { ttlMs: LANG_TTL_MS, version: 2 }, async () => {
          try {
            const table = await fetchJson(`${ALECA_CDN}/json/lang.json`);
            if (table && Object.keys(table).length >= 1000) return table;
          } catch { /* warframestat legacy fallback below */ }
          const items = await fetchJson('https://api.warframestat.us/items?language=zh&only=uniqueName,name');
          const table = {};
          for (const item of Array.isArray(items) ? items : []) {
            if (item?.uniqueName && item?.name) table[item.uniqueName] = { zh: { name: item.name } };
          }
          if (Object.keys(table).length < 1000) throw new Error('lang 重建表过小');
          return table;
        });
        return data;
      } catch {
        return {};
      }
    })());
  }
  return langTablePromises.get(dir);
}

const normTitle = (value) => String(value ?? '').normalize('NFKC').trim().toLowerCase();

// —— 挑战译名：Map<英文标题(小写), 官方中文标题>；失败返回空 Map ——
let challengeZhPromise = null;
export function getChallengeZhMap() {
  challengeZhPromise ??= (async () => {
    try {
      const entries = await cachedBuild(CHALLENGE_CACHE, CHALLENGE_TTL_MS, 1, async () => {
        const [challenges, en, zh] = await Promise.all([fetchJson(CHALLENGE_URL), fetchJson(DICT_EN_URL), fetchJson(DICT_ZH_URL)]);
        const pairs = [];
        for (const meta of Object.values(challenges)) {
          const english = en[meta?.name];
          const chinese = zh[meta?.name];
          // 官方未翻译时 zh 值=英文原文，存了也无害（等于查无）
          if (english && chinese && english !== chinese) pairs.push([normTitle(english), chinese]);
        }
        if (!pairs.length) throw new Error('挑战译名映射为空');
        return pairs;
      });
      return new Map(entries);
    } catch {
      return new Map();
    }
  })();
  return challengeZhPromise;
}

// —— 活动名：Map<英文原文, 官方中文>（大小写原样，worldstate 活动名本就规整）——
let eventZhPromise = null;
export function getOracleEventMap() {
  eventZhPromise ??= (async () => {
    try {
      const entries = await cachedBuild(EVENT_CACHE, EVENT_TTL_MS, 1, async () => {
        const [en, zh] = await Promise.all([fetchJson(ORACLE_DICT_EN_URL), fetchJson(ORACLE_DICT_ZH_URL)]);
        const pairs = [];
        for (const [key, english] of Object.entries(en)) {
          const chinese = zh[key];
          if (english && chinese && english !== chinese) pairs.push([String(english).trim(), chinese]);
        }
        if (!pairs.length) throw new Error('oracle 活动词典为空');
        return pairs;
      });
      return new Map(entries);
    } catch {
      return new Map();
    }
  })();
  return eventZhPromise;
}

// —— 科研词缀：Map<英文显示名, [{ name, desc, descEn, key }]> ——
// warframestat 的科研对象只给英文显示名/说明，不给 /Lotus/ 语言键；Oracle 词典保留同一显示名
// 对应的正式简中名称与相邻 _Desc 键。按显示名建索引，并保留重名候选供调用方按英文说明判别。
let oracleConquestPromise = null;
export function getOracleConquestMap() {
  oracleConquestPromise ??= (async () => {
    try {
      const entries = await cachedBuild(ORACLE_CONQUEST_CACHE, EVENT_TTL_MS, 1, async () => {
        const [en, zh] = await Promise.all([fetchJson(ORACLE_DICT_EN_URL), fetchJson(ORACLE_DICT_ZH_URL)]);
        const grouped = new Map();
        for (const [key, english] of Object.entries(en)) {
          if (!key.startsWith('/Lotus/Language/Conquest/') || key.endsWith('_Desc')) continue;
          const chinese = zh[key];
          if (!english || !chinese || english === chinese) continue;
          const descKey = `${key}_Desc`;
          const candidate = {
            key,
            name: chinese,
            descEn: en[descKey] || '',
            desc: zh[descKey] && zh[descKey] !== en[descKey] ? zh[descKey] : '',
          };
          const name = String(english).trim();
          grouped.set(name, [...(grouped.get(name) || []), candidate]);
        }
        if (!grouped.size) throw new Error('Oracle 科研词缀映射为空');
        return [...grouped.entries()];
      });
      return new Map(entries);
    } catch {
      return new Map();
    }
  })();
  return oracleConquestPromise;
}

// —— Public Export 完整文本词典：Map<规范化英文原文, 官方简中> ——
// 用于 worldstate 只返回英文显示名、但不返回语言键的短文本（如灵化武器轮换）。
let officialTextPromise = null;
export function getOfficialTextMap() {
  officialTextPromise ??= (async () => {
    try {
      const entries = await cachedBuild(OFFICIAL_TEXT_CACHE, CHALLENGE_TTL_MS, 1, async () => {
        const [en, zh] = await Promise.all([fetchJson(DICT_EN_URL), fetchJson(DICT_ZH_URL)]);
        const map = new Map();
        for (const [key, english] of Object.entries(en)) {
          const chinese = zh[key];
          if (!english || !chinese || english === chinese) continue;
          const normalized = normTitle(english);
          if (normalized && !map.has(normalized)) map.set(normalized, chinese);
        }
        if (!map.size) throw new Error('Public Export 文本词典为空');
        return [...map.entries()];
      });
      return new Map(entries);
    } catch {
      return new Map();
    }
  })();
  return officialTextPromise;
}

// —— 仲裁场地评级：{ SolNode450: 'S', ... }；失败返回空对象 ——
let arbyTiersPromise = null;
export function getArbyTiers() {
  arbyTiersPromise ??= (async () => {
    try {
      return await cachedBuild(ARBY_CACHE, ARBY_TTL_MS, 1, async () => {
        const response = await fetch(ARBY_TIERS_URL, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!response.ok) throw new Error(`arbyTiers HTTP ${response.status}`);
        const text = await response.text();
        const tiers = {};
        for (const match of text.matchAll(/(\w+)\s*:\s*"([SABCDF][+-]?)"/gu)) tiers[match[1]] = match[2];
        if (!Object.keys(tiers).length) throw new Error('arbyTiers 解析为空');
        return tiers;
      });
    } catch {
      return {};
    }
  })();
  return arbyTiersPromise;
}

// —— 悬赏译名三合一（一个缓存文件）；jobs/challenges/items 三个普通对象；失败返回空表 ——
// jobs: 语言键尾段(小写，去 Title/Name 后缀) → 官方中文任务名（OstronJobs/SolarisJobs/Narmer/DeimosBounty 全族）
// challenges: 挑战完整路径 → 官方中文名（Zariman/EntratiLab/Hex 赏金板用）
// items: 英文显示名(小写) → 官方中文（dict.en 值反查 dict.zh，只收短名称条目）
let bountyZhPromise = null;
export function getBountyZhMaps() {
  bountyZhPromise ??= (async () => {
    try {
      return await cachedBuild(BOUNTY_CACHE, BOUNTY_TTL_MS, 3, async () => {
        const [challengesRaw, en, zh, regions] = await Promise.all([
          fetchJson(CHALLENGE_URL), fetchJson(DICT_EN_URL), fetchJson(DICT_ZH_URL),
          fetchJson('https://browse.wf/warframe-public-export-plus/ExportRegions.json').catch(() => ({})),
        ]);
        const jobs = {};
        const items = {};
        for (const [key, chinese] of Object.entries(zh)) {
          if (typeof chinese !== 'string' || !chinese) continue;
          // 任务名键族：…Jobs/…Title、InfestedMicroplanet/DeimosBounty…Name、Narmer 悬赏 Title
          const tailMatch = key.match(/\/Lotus\/Language\/[^/]+\/([A-Za-z0-9]+?)(Title|Name)$/u);
          if (tailMatch && /(?:Jobs\/|Bounty|Narmer)/u.test(key)) {
            const tail = tailMatch[1].toLowerCase();
            if (!jobs[tail]) jobs[tail] = chinese;
          }
          // 物品名反查：英文短名→中文；排除描述条目，同名冲突保留首个
          const english = en[key];
          if (english && english !== chinese && english.length <= 48 && !/Desc$/u.test(key) && !english.includes('|')) {
            const enKey = String(english).normalize('NFKC').trim().toLowerCase();
            if (!items[enKey]) items[enKey] = chinese;
          }
        }
        const challenges = {};
        // 挑战详情（名/描述/要求量）：扎里曼/实验室/Hex 挂板卡用，描述翻不到退英文再退空
        const challengeDetails = {};
        for (const [challengePath, meta] of Object.entries(challengesRaw)) {
          const chinese = zh[meta?.name];
          if (chinese && chinese !== en[meta?.name]) challenges[challengePath] = chinese;
          challengeDetails[challengePath] = {
            zh: chinese || en[meta?.name] || null,
            desc: zh[meta?.description] || en[meta?.description] || null,
            required: Number(meta?.requiredCount) || 0,
          };
        }
        // 节点名：SolNodeXXX → { name, planet, mission }（ExportRegions × dict.zh，与钢铁侵袭同源）
        const nodes = {};
        for (const [code, region] of Object.entries(regions)) {
          if (!region?.name) continue;
          nodes[code] = {
            name: zh[region.name] || region.name,
            planet: region.systemName ? (zh[region.systemName] || region.systemName) : '',
            mission: region.missionName ? (zh[region.missionName] || region.missionName) : '',
            faction: region.faction || '',
          };
        }
        if (!Object.keys(jobs).length) throw new Error('悬赏任务译名为空');
        return { jobs, challenges, challengeDetails, nodes, items };
      });
    } catch {
      return { jobs: {}, challenges: {}, challengeDetails: {}, nodes: {}, items: {} };
    }
  })();
  return bountyZhPromise;
}

// —— 1999 日历挑战：快照 ActivatedChallenges 键尾(小写) → { zh: 官方中文名, required: 要求量 }；失败返回空对象 ——
// 用途：周报日历区把「净化感染 64/250」这类进度对齐到挑战行（进度计数在快照 ChallengeProgress）
let calendarChallengePromise = null;
export function getCalendarChallengeMap() {
  calendarChallengePromise ??= (async () => {
    try {
      return await cachedBuild(CALENDAR_CHALLENGE_CACHE, CALENDAR_CHALLENGE_TTL_MS, 2, async () => {
        const [challenges, en, zh] = await Promise.all([fetchJson(CHALLENGE_URL), fetchJson(DICT_EN_URL), fetchJson(DICT_ZH_URL)]);
        const map = {};
        for (const [challengePath, meta] of Object.entries(challenges)) {
          const tail = challengePath.match(/\/Calendar1999\/([A-Za-z0-9]+)$/u)?.[1];
          if (!tail) continue;
          map[tail.toLowerCase()] = {
            zh: zh[meta?.name] || en[meta?.name] || null,
            desc: zh[meta?.description] || en[meta?.description] || null,
            required: Number(meta?.requiredCount) || 0,
          };
        }
        if (!Object.keys(map).length) throw new Error('日历挑战映射为空');
        return map;
      });
    } catch {
      return {};
    }
  })();
  return calendarChallengePromise;
}

// —— 电波挑战完成量：路径尾段(小写) → requiredCount；失败返回空对象 ——
// 用途：周报电波自动核销——SeasonChallengeHistory 只记「激活」，完成必须 ChallengeProgress.Progress 对 requiredCount
let seasonRequiredPromise = null;
export function getSeasonChallengeRequired() {
  seasonRequiredPromise ??= (async () => {
    try {
      return await cachedBuild(SEASON_REQUIRED_CACHE, CHALLENGE_TTL_MS, 1, async () => {
        const challenges = await fetchJson(CHALLENGE_URL);
        const map = {};
        for (const [challengePath, meta] of Object.entries(challenges)) {
          const tail = challengePath.match(/\/Seasons\/[^/]+\/([A-Za-z0-9]+)$/u)?.[1];
          if (!tail) continue;
          map[tail.toLowerCase()] = Number(meta?.requiredCount) || 0;
        }
        if (!Object.keys(map).length) throw new Error('电波挑战完成量映射为空');
        return map;
      });
    } catch {
      return {};
    }
  })();
  return seasonRequiredPromise;
}

// —— 遗物掉落来源反查：遗物基名（"Lith G1"）→ top 掉点 [{place, chance}]（按概率降序，最多 5 条） ——
// 数据=WFCD drop-data 5 张表（任务轮次/特殊目标/三开放世界悬赏）；一次重建缓存 7 天，全遗物零逐条请求。
// 已入库遗物天然无掉点（查无返回空数组），调用方按「已入库」文案处理。
const RELIC_SOURCES_CACHE = path.join(DATA_CACHE_DIR, 'relic-sources.json');
const RELIC_SOURCES_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DROP_DATA_BASE = 'https://drops.warframestat.us/data';
const DROP_DATA_GITHUB = 'https://raw.githubusercontent.com/WFCD/warframe-drop-data/gh-pages/data';
// 掉点地名翻译：星球/开放世界用官方中文，节点名保留英文（项目惯例）
const DROP_PLANET_ZH = {
  Mercury: '水星', Venus: '金星', Earth: '地球', Mars: '火星', Phobos: '火卫一', Deimos: '火卫二',
  Ceres: '谷神星', Jupiter: '木星', Europa: '欧罗巴', Saturn: '土星', Uranus: '天王星', Neptune: '海王星',
  Pluto: '冥王星', Sedna: '赛德娜', Eris: '阋神星', Void: '虚空', 'Kuva Fortress': '赤毒要塞', Lua: '月球',
  Zariman: '扎里曼', 'Höllvania': '霍瓦尼亚', Duviri: '双衍王境',
};
const DROP_MODE_ZH = {
  Survival: '生存', Defense: '防御', Excavation: '挖掘', Interception: '拦截', Capture: '捕获',
  Exterminate: '歼灭', Sabotage: '破坏', Rescue: '救援', Spy: '间谍', 'Mobile Defense': '移动防御',
  Disruption: '中断', Rush: '突袭', Assault: '强袭', 'Infested Salvage': '感染回收', Arena: '竞技场',
  Defection: '叛逃', Hijack: '劫持', Skirmish: '前哨战', Volatile: '反应堆破坏', Orphix: 'Orphix',
  Caches: '缓存箱', 'Pursuit (Archwing)': '追击', 'Assassination': '刺杀', Alchemy: '元素转换',
  Netracells: '衰退室', 'Sanctum Bounty': '圣所悬赏', Hive: '感染巢穴', 'Faceoff': '对峙',
};
const DROP_TRANSIENT_ZH = {
  Arbitrations: '仲裁', 'Derelict Vault': '遗迹宝库', 'Nightmare Mode Rewards': '梦魇任务',
  'Kuva Siphon': '赤毒虹吸器', 'Kuva Flood': '赤毒洪流', 'Granum Void': '格拉纳姆虚空',
  'Extended Granum Void': '格拉纳姆虚空（加时）', 'Nightmare Granum Void': '格拉纳姆虚空（梦魇）',
  Razorback: '利刃豺狼', 'Fomorian Sabotage': '巨人战舰破坏',
};
const DROP_BOUNTY_ZH = { cetusBountyRewards: '希图斯悬赏', solarisBountyRewards: '福尔图娜悬赏', deimosRewards: '殁世幽都悬赏' };
let relicSourcesPromise = null;
export function getRelicSources() {
  relicSourcesPromise ??= (async () => {
    try {
      return await cachedBuild(RELIC_SOURCES_CACHE, RELIC_SOURCES_TTL_MS, 2, async () => {
        const fetchDropData = async (name) => {
          try { return await fetchJson(`${DROP_DATA_BASE}/${name}.json`); }
          catch {
            const githubUrl = `${DROP_DATA_GITHUB}/${name}.json`;
            try { return await fetchJson(githubUrl); }
            catch {
              const [{ execFile }, { promisify }] = await Promise.all([import('node:child_process'), import('node:util')]);
              const powershell = process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe';
              const script = `$ProgressPreference='SilentlyContinue'; (Invoke-WebRequest -UseBasicParsing '${githubUrl}' -TimeoutSec 45).Content`;
              const { stdout } = await promisify(execFile)(powershell, ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 55_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
              return JSON.parse(stdout);
            }
          }
        };
        const [missions, transients, cetus, solaris, deimos] = await Promise.all([
          fetchDropData('missionRewards'),
          fetchDropData('transientRewards'),
          fetchDropData('cetusBountyRewards'),
          fetchDropData('solarisBountyRewards'),
          fetchDropData('deimosRewards'),
        ]);
        const map = {};
        // 奖励名 "Lith G1 Relic"（悬赏可能带精炼尾缀）→ 基名键；同表同地多轮次只留最高概率
        const put = (itemName, place, chance) => {
          const relic = String(itemName || '').match(/^(Lith|Meso|Neo|Axi|Requiem)\s+(\w+)\s+Relic(?:\s+\((?:Exceptional|Flawless|Radiant)\))?$/u);
          if (!relic || !Number.isFinite(Number(chance))) return;
          const key = `${relic[1]} ${relic[2]}`;
          (map[key] ??= []).push({ place, chance: Number(chance) });
        };
        for (const [planet, nodes] of Object.entries(missions?.missionRewards || {})) {
          for (const [node, detail] of Object.entries(nodes || {})) {
            // 节点名本身就是模式名时（霍瓦尼亚 Legacyte Harvest）不重复括注
            const modeZh = DROP_MODE_ZH[detail?.gameMode] || detail?.gameMode || '';
            const modeNote = modeZh && !String(node).includes(String(detail?.gameMode || '')) ? `（${modeZh}）` : '';
            const placeBase = `${DROP_PLANET_ZH[planet] || planet} ${node}${modeNote}`;
            const rewards = detail?.rewards;
            if (Array.isArray(rewards)) {
              for (const reward of rewards) put(reward.itemName, placeBase, reward.chance);
            } else {
              for (const [rotation, list] of Object.entries(rewards || {})) {
                for (const reward of list || []) put(reward.itemName, `${placeBase}轮次${rotation}`, reward.chance);
              }
            }
          }
        }
        for (const entry of transients?.transientRewards || []) {
          const zh = DROP_TRANSIENT_ZH[entry?.objectiveName];
          if (!zh) continue; // 虚空风暴等与裂缝语境重复的目标不进来源榜
          for (const reward of entry?.rewards || []) put(reward.itemName, zh, reward.chance);
        }
        for (const [table, zhPrefix] of Object.entries(DROP_BOUNTY_ZH)) {
          const source = { cetusBountyRewards: cetus, solarisBountyRewards: solaris, deimosRewards: deimos }[table];
          for (const entry of source?.[table] || []) {
            const level = String(entry?.bountyLevel || '').match(/Level\s+(\d+)\s*-\s*(\d+)/u);
            const place = `${zhPrefix}${level ? ` Lv${level[1]}-${level[2]}` : ''}`;
            for (const list of Object.values(entry?.rewards || {})) {
              for (const reward of list || []) put(reward.itemName, place, reward.chance);
            }
          }
        }
        // 每遗物：同地去重取最高概率 → 概率降序留 top5
        const compactMap = {};
        for (const [key, rows] of Object.entries(map)) {
          const byPlace = new Map();
          for (const row of rows) {
            const current = byPlace.get(row.place);
            if (!current || row.chance > current.chance) byPlace.set(row.place, row);
          }
          compactMap[key] = [...byPlace.values()].sort((a, b) => b.chance - a.chance).slice(0, 5)
            .map((row) => ({ place: row.place, chance: Math.round(row.chance * 100) / 100 }));
        }
        if (!Object.keys(compactMap).length) throw new Error('遗物来源索引为空');
        return compactMap;
      });
    } catch {
      return {};
    }
  })();
  return relicSourcesPromise;
}

// —— wm 全商品价格索引（库存分类估值用）：英文名(compact) → { p0: 0级/无档 wa_price, pMax: 满级档 wa_price } ——
// 源=relics.run 每日 wm 价格 dump（3800+ 商品，含赋能/MOD/遗物/部件，按 mod_rank 分档）；
// 当天文件常 404（未生成），从今天往前回退最多 3 天；缓存 24h，全类别估值一个请求。
const PRICE_INDEX_CACHE = path.join(DATA_CACHE_DIR, 'market-price-index.json');
const PRICE_INDEX_TTL_MS = 24 * 60 * 60 * 1000;
let priceIndexPromise = null;
export function getMarketPriceIndex() {
  priceIndexPromise ??= (async () => {
    try {
      return await cachedBuild(PRICE_INDEX_CACHE, PRICE_INDEX_TTL_MS, 4, async () => {
        let dump = null;
        for (let back = 0; back < 3 && !dump; back += 1) {
          const day = new Date(Date.now() - back * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
          try { dump = await fetchJson(`https://relics.run/history/price_history_${day}.json`); } catch { dump = null; }
        }
        if (!dump) throw new Error('relics.run 价格 dump 近 3 天均不可用');
        const index = {};
        for (const [name, rows] of Object.entries(dump)) {
          const key = String(name).normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, '');
          if (!key || !Array.isArray(rows)) continue;
          const entry = index[key] ??= {};
          // 🔴 每物品×档位有三类行（order_type: closed=真实成交 / sell=挂单 / buy=收购）——
          // 不过滤会被 buy 收购价覆盖（充沛满级 64.5 vs 实际成交 132 实锤）。
          // 口径=closed 成交加权均价（真实、保守）；无成交的冷门物品退 sell 挂价
          const pick = (rank) => {
            const ofRank = rows.filter((row) => (Number(row?.mod_rank) > 0) === rank);
            const closed = ofRank.find((item) => item.order_type === 'closed');
            const row = closed || ofRank.find((item) => item.order_type === 'sell');
            const price = Number(row?.wa_price ?? row?.avg_price);
            return Number.isFinite(price) ? {
              price: Math.round(price * 10) / 10,
              maxRank: Number(row?.mod_rank) || 0,
              basis: closed ? 'closed' : 'sell',
            } : null;
          };
          const base = pick(false);
          const max = pick(true);
          if (base) { entry.p0 = base.price; entry.p0Basis = base.basis; }
          if (max) { entry.pMax = max.price; entry.pMaxBasis = max.basis; entry.maxRank = max.maxRank; }
        }
        if (!Object.keys(index).length) throw new Error('价格索引为空');
        return index;
      });
    } catch {
      return {};
    }
  })();
  return priceIndexPromise;
}

// 测试打桩：注入预置结果并复位单例
export function __resetWfdataForTest({ challengeMap, eventMap, oracleConquestMap, officialTextMap, arbyTiers, bountyZh, calendarChallenges, seasonRequired, relicSources, priceIndex, langTable } = {}) {
  langTablePromises = new Map();
  langTableStub = langTable;
  challengeZhPromise = challengeMap !== undefined ? Promise.resolve(challengeMap) : null;
  eventZhPromise = eventMap !== undefined ? Promise.resolve(eventMap) : null;
  oracleConquestPromise = oracleConquestMap !== undefined ? Promise.resolve(oracleConquestMap) : null;
  officialTextPromise = officialTextMap !== undefined ? Promise.resolve(officialTextMap) : null;
  arbyTiersPromise = arbyTiers !== undefined ? Promise.resolve(arbyTiers) : null;
  bountyZhPromise = bountyZh !== undefined ? Promise.resolve(bountyZh) : null;
  calendarChallengePromise = calendarChallenges !== undefined ? Promise.resolve(calendarChallenges) : null;
  seasonRequiredPromise = seasonRequired !== undefined ? Promise.resolve(seasonRequired) : null;
  relicSourcesPromise = relicSources !== undefined ? Promise.resolve(relicSources) : null;
  priceIndexPromise = priceIndex !== undefined ? Promise.resolve(priceIndex) : null;
}
