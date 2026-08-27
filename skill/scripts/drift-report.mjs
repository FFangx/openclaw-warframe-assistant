#!/usr/bin/env node

// drift-report.mjs — 数据源漂移监控（只读诊断，零凭据、零联网、零写入）。
//
// 面向「上游数据变了但代码/静态表还没跟上」的漂移检测。本模块全部为纯函数：
// 输入是调用方提供的合成 fixture 或本地文件，输出是统计 + 可审计键样本。
// 本模块禁止用于生产告警、cron、缓存写入或任何运行时改动；周报等热路径不依赖它。
//
// 覆盖面（第 6 项合同）：
//   1) 午夜电波挑战缺 requiredCount/路径译名/关键字段：统计 + 键样本；缺失不猜数字、
//      不自动核销（checkoffSafe=false 只表示「自动核销被保守禁用」，不是完成判定）。
//   2) 科研词缀与 1999 日历增益占位：统计 + 可审计键样本；绝不接收/输出个人分数。
//      科研词缀 Oracle 说明残留的 |val| 未解析占位符（官方源只给键无数值）也按说明漂移计，
//      样本 reason=unresolved-placeholder。
//   3) 商店装配结果内部名泄漏扫描：合成未知名必须落中文占位；当前静态中文表逐值扫描。
//   4) DE 官方 worldState 结构漂移：关键集合缺失/畸形 → cacheable=false（拒绝写可靠缓存）。
//   5) Market/worldstate 端点健康聚合：累计失败次数/类别/最近时间/退避状态；旧 v1 状态（无累计
//      计数）仅按端点覆盖最近状态（details.legacyState），由 legacyStateEndpoints 单独报告，
//      绝不把端点数冒充频率；只输出白名单字段，永不输出响应体、请求头、URL 或凭据。
//
// CLI（单次只读）：node drift-report.mjs health [--health <endpoint-health.v1.json>]
//   读取端点健康文件并输出脱敏聚合 JSON；source 只输出固定安全标签，不输出本机路径；
//   不写任何文件、不联网。

import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

import { FileEndpointHealthStore, readEndpointHealth } from './http-resilience.mjs';
import { ARCHIMEDEA_PLACEHOLDER_DESC, ARCHIMEDEA_PLACEHOLDER_NAME, ARCHIMEDEA_UNRESOLVED_DESC_ZH, CALENDAR_UPGRADE_PLACEHOLDER_ZH, calendarUpgradeEntry, hasCompleteArchimedeas, localizeArchimedeaModifier, nightwaveChallengeZh } from './weekly.mjs';

// —— 占位文案常量（与 weekly.mjs 热路径兜底串直接同源；测试锁定同步）——
export { ARCHIMEDEA_PLACEHOLDER_DESC, ARCHIMEDEA_PLACEHOLDER_NAME, ARCHIMEDEA_UNRESOLVED_DESC_ZH, CALENDAR_UPGRADE_PLACEHOLDER_ZH } from './weekly.mjs';
export const NIGHTWAVE_PLACEHOLDER_ZH = '本周挑战 ×1（译名待补）';
export const SHOP_NAME_PLACEHOLDER_ZH = '游戏内商品（名称待词典同步）';

const MAX_SAMPLE_KEYS = 20;
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/u;
const INTERNAL_PATH_RE = /\/Lotus\//u;
const INTERNAL_CLASS_SUFFIX = /(?:Blueprint|Generator|Manifest|StoreItem|Bundle|Pack|Item|Recipe)$/u;
const CAMEL_HUMP_RE = /[a-z][A-Z]/u;
// 官方保留英文（硬规则允许直出）的纯英文值白名单；扫描时这些值不算泄漏
const STATIC_ZH_ALLOWLIST = new Set([
  'Forma', 'Prime', 'Kuva', 'Umbra', 'Void', 'Endo',
  'Aura Forma', 'Omni Forma', 'Alad V',
]);

// ==== 1) 午夜电波挑战漂移 ====

// 与 weekly.mjs nightwaveChallengeKey 同口径：显式 key/path 尾段优先，否则 id 剥时间戳前缀
export function nightwaveKeyOf(challenge) {
  const explicit = String(challenge?.key || challenge?.path || '').split('/').pop();
  if (explicit) return explicit.toLowerCase();
  return String(challenge?.id || '').replace(/^\d+/u, '').toLowerCase();
}

// challenges = 规范化后的 activeChallenges [{id, isDaily, isElite}]；
// requiredByKey = ExportChallenges 尾段→requiredCount（weekly 自动核销同源）；
// resolveZh = (challenge) => 中文名（不传则不统计译名缺失）。
// 返回统计 + 键样本；绝不推断 requiredCount，绝不输出「完成/核销」判定。
export function analyzeNightwaveDrift(challenges = [], { requiredByKey = {}, resolveZh = null } = {}) {
  const report = {
    total: challenges.length,
    daily: 0,
    weekly: 0,
    elite: 0,
    missingRequired: { count: 0, keys: [] },
    missingZh: { count: 0, keys: [] },
    missingKeyFields: { count: 0, keys: [] },
    checkoffSafe: true,
    reasons: [],
  };
  for (const challenge of challenges) {
    const isDaily = Boolean(challenge?.isDaily);
    const isElite = Boolean(challenge?.isElite);
    if (isDaily) report.daily += 1;
    else {
      report.weekly += 1;
      if (isElite) report.elite += 1;
    }
    const key = nightwaveKeyOf(challenge);
    const hasKeyField = Boolean(challenge?.id || challenge?.path || challenge?.key);
    if (!hasKeyField) {
      report.missingKeyFields.count += 1;
      report.missingKeyFields.keys.push({ key: key || '(无路径/id)', isDaily, isElite });
      if (!isDaily) {
        report.checkoffSafe = false;
        report.reasons.push(`非每日挑战缺少路径/id 字段（${key || '未知'}）`);
      }
    }
    const required = Number(requiredByKey?.[key]) || 0;
    const hasRequired = required > 0;
    if (!hasRequired) {
      report.missingRequired.count += 1;
      report.missingRequired.keys.push({ key, isDaily, isElite });
      if (!isDaily) {
        report.checkoffSafe = false;
        report.reasons.push(`非每日挑战 ${key || '(无路径/id)'} 缺 requiredCount：不猜数量、不自动核销`);
      }
    }
    if (typeof resolveZh === 'function') {
      const zh = resolveZh(challenge);
      if (!zh || zh === NIGHTWAVE_PLACEHOLDER_ZH) {
        report.missingZh.count += 1;
        report.missingZh.keys.push({ key, isDaily, isElite });
      }
    }
  }
  report.missingRequired.keys = report.missingRequired.keys.slice(0, MAX_SAMPLE_KEYS);
  report.missingZh.keys = report.missingZh.keys.slice(0, MAX_SAMPLE_KEYS);
  report.missingKeyFields.keys = report.missingKeyFields.keys.slice(0, MAX_SAMPLE_KEYS);
  return report;
}

// ==== 2) 科研词缀 / 1999 日历增益占位漂移（不接收、不输出任何个人分数） ====

// entries = 规范化 archimedeas（typeKey 含 LAB/HEX）；localizeMod 默认复用 weekly.mjs
// 真实词缀本地化链（oracle 词典 → 尾段索引 → 静态表 → 占位）。
// 输出只含统计 + 键样本（kind/key/所在位置），无分数、无快照字段。
export function analyzeArchimedeaTranslationDrift(entries = [], {
  localizeMod = localizeArchimedeaModifier,
  oracleMap = null,
  oracleTailMap = null,
  staticZh = null,
} = {}) {
  const report = { total: 0, nameUntranslated: 0, descPlaceholder: 0, byKind: {}, samples: [] };
  const collect = (mods, kind, where) => {
    for (const mod of mods || []) {
      if (!mod || (!mod.key && !mod.name)) continue;
      report.total += 1;
      const result = localizeMod(mod, oracleMap, staticZh, { tailMap: oracleTailMap, kind });
      const nameUntranslated = !result?.name || result.name === ARCHIMEDEA_PLACEHOLDER_NAME;
      // 未解析占位符 = 用户可见说明仍是 |val| 一类参数占位（上游只给键无数值）或诚实缺数值提示：
      // 都算说明漂移，与「效果说明待补录」的通用占位分桶统计，样本带 reason 可审计。
      const unresolvedPlaceholder = result?.desc === ARCHIMEDEA_UNRESOLVED_DESC_ZH
        || /\|/u.test(String(result?.desc || ''));
      const descPlaceholder = !result?.desc
        || result.desc === ARCHIMEDEA_PLACEHOLDER_DESC
        || unresolvedPlaceholder;
      const bucket = report.byKind[kind] ??= { total: 0, nameUntranslated: 0, descPlaceholder: 0 };
      bucket.total += 1;
      if (nameUntranslated) {
        bucket.nameUntranslated += 1;
        report.nameUntranslated += 1;
      }
      if (descPlaceholder) {
        bucket.descPlaceholder += 1;
        report.descPlaceholder += 1;
      }
      if (nameUntranslated || descPlaceholder) {
        report.samples.push({
          kind, where, key: mod.key || null, name: mod.name || null,
          reason: nameUntranslated ? 'name' : unresolvedPlaceholder ? 'unresolved-placeholder' : 'desc-placeholder',
        });
      }
    }
  };
  for (const entry of entries || []) {
    const kindRaw = String(entry?.typeKey || entry?.type || '').replace(/\s+/gu, '');
    const kind = /HEX/u.test(kindRaw) ? 'HEX' : /LAB/u.test(kindRaw) ? 'LAB' : kindRaw || 'UNKNOWN';
    for (const mission of entry?.missions || []) {
      collect([mission?.deviation], kind, 'deviation');
      collect(mission?.risks, kind, 'risk');
    }
    collect(entry?.personalModifiers, kind, 'personal');
  }
  report.samples = report.samples.slice(0, MAX_SAMPLE_KEYS);
  return report;
}

// days = 规范化 1999 日历 days（event.type==='Override'，upgrade.title 必填、upgradePath 可选，
// 与 weekly.mjs 的 officialSafe 对位约定一致）；upgradeEntry 默认复用 weekly.mjs 真实链。
// 漂移判定区分「缺中文名」（nameMissing）与「有中文名但缺效果说明」（effectMissing）：
// 前者继续走 AI 查证闭环，后者是社区表/词典只补了名字的软漂移，报告里分开统计。
export function analyzeCalendarUpgradeDrift(days = [], {
  upgradeEntry = calendarUpgradeEntry,
  calendarStateZh = null,
  learnedEntries = null,
} = {}) {
  const report = {
    total: 0,
    nameMissing: 0,
    effectMissing: 0,
    untranslated: 0,
    staticPlaceholder: 0,
    samples: [],
  };
  for (const day of days || []) {
    for (const event of day?.events || []) {
      if (event?.type !== 'Override') continue;
      report.total += 1;
      const entry = upgradeEntry(event.upgrade || {}, event?.upgradePath || null, calendarStateZh, { learnedEntries }) || {};
      const nameMissing = !entry.name || entry.name === CALENDAR_UPGRADE_PLACEHOLDER_ZH;
      const effectMissing = !nameMissing && !entry.desc;
      const staticPh = String(entry.name || '').includes('占位说明') || String(entry.desc || '').includes('占位说明');
      if (nameMissing) {
        report.nameMissing += 1;
        report.untranslated += 1;
      }
      if (effectMissing) report.effectMissing += 1;
      if (staticPh) report.staticPlaceholder += 1;
      if (nameMissing || effectMissing || staticPh) {
        report.samples.push({
          day: day?.date || null,
          path: event.upgradePath || null,
          title: event.upgrade?.title || null,
          kind: nameMissing ? 'name' : effectMissing ? 'effect' : 'static-placeholder',
          name: entry.name || null,
          desc: entry.desc || null,
        });
      }
    }
  }
  report.samples = report.samples.slice(0, MAX_SAMPLE_KEYS);
  return report;
}

// ==== 3) 商店装配内部名泄漏扫描 ====

// 判定单条「显示名」是否泄漏内部名/路径尾段。合法英文保留项（战甲名、Prime 部件、
// Forma/Prime/Kuva 等官方保留词、含中文的混写）不判泄漏。
export function shopNameLeakSeverity(name, storeItem = '') {
  const display = String(name || '');
  const tail = String(storeItem || '').split('/').pop();
  if (!display || display === SHOP_NAME_PLACEHOLDER_ZH) return null;
  if (display === String(storeItem || '') || INTERNAL_PATH_RE.test(display)) return 'path';
  if (display === tail) return 'tail';
  if (!CJK_RE.test(display)) {
    if (INTERNAL_CLASS_SUFFIX.test(display) && /[A-Z]/u.test(display)) return 'class-name';
    if (CAMEL_HUMP_RE.test(display)) return 'camel-case';
  }
  return null;
}

// rows = 装配结果行 [{name, storeItem}]；返回泄漏清单（含行号/严重级/键），clean=true 表示零泄漏。
export function scanShopAssemblyLeaks(rows = []) {
  const leaks = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const severity = shopNameLeakSeverity(row?.name, row?.storeItem);
    if (severity) {
      leaks.push({
        index,
        severity,
        name: row?.name,
        storeItem: row?.storeItem,
        tail: String(row?.storeItem || '').split('/').pop(),
      });
    }
  }
  return { total: rows.length, leaks, clean: leaks.length === 0 };
}

// tables = [{ label, entries: [[key, value]] }]；value 为字符串或 {name, desc}。
// 对「当前用户可见」的静态中文表逐值扫描（键是内部查找键，不扫）。
export function scanZhTableLeaks(tables = []) {
  const leaks = [];
  let total = 0;
  for (const table of tables) {
    for (const [key, value] of table.entries || []) {
      const values = typeof value === 'string'
        ? [value]
        : value && typeof value === 'object'
          ? [value.name, value.desc].filter(Boolean)
          : [];
      for (const text of values) {
        total += 1;
        const severity = shopNameLeakSeverity(text, key);
        if (severity && !STATIC_ZH_ALLOWLIST.has(String(text).trim())) {
          leaks.push({ table: table.label, key, value: text, severity });
        }
      }
    }
  }
  return { total, leaks, clean: leaks.length === 0 };
}

// ==== 4) DE 官方 worldState 结构漂移（拒绝写可靠缓存） ====

const OFFICIAL_RAW_COLLECTIONS = Object.freeze([
  'ActiveMissions', 'VoidStorms', 'Alerts', 'Invasions', 'Goals', 'Sorties', 'LiteSorties',
  'VoidTraders', 'Conquests', 'SyndicateMissions', 'EndlessXpSchedule', 'KnownCalendarSeasons',
]);

// 官方 worldState.php 原始响应：关键集合缺失/畸形或 Time 不可解析 → cacheable=false。
export function analyzeOfficialRawDrift(raw = {}) {
  const missing = [];
  const malformed = [];
  for (const field of OFFICIAL_RAW_COLLECTIONS) {
    if (!(field in raw)) missing.push(field);
    else if (!Array.isArray(raw[field])) malformed.push(field);
  }
  if (raw.SeasonInfo != null && typeof raw.SeasonInfo !== 'object') malformed.push('SeasonInfo');
  const timeOk = raw?.Time != null
    && (Number.isFinite(Number(raw.Time)) || Number.isFinite(Date.parse(String(raw.Time))));
  if (!timeOk) missing.push('Time');
  const cacheable = missing.length === 0 && malformed.length === 0;
  return {
    cacheable,
    missing,
    malformed,
    reason: cacheable ? null : (missing.length ? `缺失关键集合：${missing.join(', ')}` : `关键集合畸形：${malformed.join(', ')}`),
  };
}

// 规范化后的世界状态：镜像 assertOfficialWorldStateContract 的字段合同，并叠加
// weekly.mjs hasCompleteArchimedeas 的「可靠缓存」口径（LAB/HEX 各三关且未过期）。
export function analyzeOfficialNormalizedDrift(state = {}) {
  const arrayFields = ['fissures', 'alerts', 'invasions', 'events', 'voidTraders', 'syndicateMissions', 'archimedeas'];
  const malformed = arrayFields.filter((field) => !Array.isArray(state?.[field]));
  const missing = ['sortie', 'archonHunt', 'nightwave', 'duviriCycle', 'calendar'].filter((field) => !(field in state));
  if (state?.timestamp == null || !Number.isFinite(Date.parse(state.timestamp))) malformed.push('timestamp');
  const contractOk = malformed.length === 0 && missing.length === 0;
  const weeklyCacheable = hasCompleteArchimedeas(state?.archimedeas);
  return { contractOk, weeklyCacheable, cacheable: contractOk && weeklyCacheable, missing, malformed };
}

// ==== 5) Market/worldstate 端点健康聚合（白名单脱敏） ====

export const ENDPOINT_HEALTH_WHITELIST = Object.freeze([
  'consecutiveFailures', 'lastSuccessAt', 'lastFailureAt',
  'lastCategory', 'lastStatus', 'openedAt', 'openUntil',
  // 累计遥测（http-resilience.mjs 每次最终请求失败/新开熔断时递增；成功恢复时保留）
  'totalFailures', 'failureCategoryCounts', 'failureStatusCounts', 'circuitOpenCount',
]);

// 只保留白名单字段；恶意/意外混入的 url/headers/token/body 等一律丢弃。
export function sanitizeEndpointHealth(endpoints = {}) {
  const out = {};
  for (const [endpoint, state] of Object.entries(endpoints || {})) {
    if (!state || typeof state !== 'object') continue;
    const clean = {};
    for (const field of ENDPOINT_HEALTH_WHITELIST) {
      if (field in state) clean[field] = state[field];
    }
    out[endpoint] = clean;
  }
  return out;
}

// 聚合：每端点退避/最近状态 + 累计失败次数/类别/最近时间；输出不包含响应体、请求头、URL 或凭据。
// byCategory/byStatus 只累计各端点 failureCategoryCounts/failureStatusCounts（真实失败频率）；
// 旧 v1 状态（缺累计计数）不并入频率，仅按端点覆盖最近状态（details.legacyState=true），
// 由 legacyStateEndpoints 单独报告「旧状态覆盖情况」。
export function aggregateEndpointHealth(endpoints = {}, { now = Date.now() } = {}) {
  const sanitized = sanitizeEndpointHealth(endpoints);
  const byCategory = {};
  const byStatus = {};
  const details = [];
  let openCircuits = 0;
  let totalFailures = 0;
  let circuitOpenCount = 0;
  let legacyStateEndpoints = 0;
  let lastFailureAt = null;
  let lastSuccessAt = null;
  for (const [endpoint, state] of Object.entries(sanitized)) {
    const openUntil = Number(state.openUntil);
    const circuitOpen = Number.isFinite(openUntil) && openUntil > now;
    if (circuitOpen) openCircuits += 1;
    const hasCounters = 'totalFailures' in state && 'failureCategoryCounts' in state;
    if (!hasCounters) legacyStateEndpoints += 1;
    if (hasCounters) {
      totalFailures += Number(state.totalFailures) || 0;
      circuitOpenCount += Number(state.circuitOpenCount) || 0;
      for (const [category, count] of Object.entries(state.failureCategoryCounts || {})) {
        byCategory[category] = (byCategory[category] || 0) + (Number(count) || 0);
      }
      for (const [status, count] of Object.entries(state.failureStatusCounts || {})) {
        byStatus[status] = (byStatus[status] || 0) + (Number(count) || 0);
      }
    }
    const failure = Number(state.lastFailureAt);
    if (Number.isFinite(failure) && failure > 0 && (lastFailureAt === null || failure > lastFailureAt)) lastFailureAt = failure;
    const success = Number(state.lastSuccessAt);
    if (Number.isFinite(success) && success > 0 && (lastSuccessAt === null || success > lastSuccessAt)) lastSuccessAt = success;
    details.push({ endpoint, ...state, circuitOpen, backoffMs: circuitOpen ? openUntil - now : 0, legacyState: !hasCounters });
  }
  details.sort((a, b) => a.endpoint.localeCompare(b.endpoint));
  const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
  return {
    generatedAt: now,
    endpoints: details.length,
    openCircuits,
    totalFailures,
    circuitOpenCount,
    byCategory,
    byStatus,
    legacyStateEndpoints,
    lastFailureAt,
    lastFailureIso: iso(lastFailureAt),
    lastSuccessAt,
    lastSuccessIso: iso(lastSuccessAt),
    details,
  };
}

// ==== CLI（单次只读；其余漂移分析由测试以合成输入驱动） ====

function defaultHealthFile() {
  const base = process.env.WARFRAME_DATA_CACHE_DIR
    || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.cache', 'warframe-data');
  return path.join(base, 'endpoint-health.v1.json');
}

// CLI 输出中 source 的固定安全标签：绝不携带本机文件路径
export const HEALTH_SOURCE_LABEL = 'local';

function usage() {
  console.log([
    '数据源漂移监控（只读诊断：零联网、零写入、零凭据）',
    '',
    '用法：',
    '  node drift-report.mjs health [--health <endpoint-health.v1.json>]',
    '      读取 Market/worldstate 端点健康文件并输出脱敏聚合',
    '      （端点数/熔断中数/累计失败次数与类别/最近失败与成功时间/各端点退避状态）。',
    '      旧 v1 状态（无累计计数）按端点标记 legacyState 并计入 legacyStateEndpoints，',
    '      不并入累计失败次数；只输出白名单字段，不输出响应体、请求头、URL、',
    '      凭据或本机路径（source 仅为固定安全标签）。',
    '  node drift-report.mjs --help',
    '',
    '其余漂移分析（电波挑战/科研词缀/日历增益/商店泄漏/worldState 结构）为纯函数，',
    '由 drift-report.test.mjs 以合成输入覆盖；本 CLI 不联网、不写任何文件。',
  ].join('\n'));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    usage();
    return;
  }
  const [command] = args;
  if (command === 'health') {
    const flag = args.indexOf('--health');
    const file = flag >= 0 && args[flag + 1] ? path.resolve(args[flag + 1]) : defaultHealthFile();
    const health = await readEndpointHealth(new FileEndpointHealthStore(file));
    const aggregate = aggregateEndpointHealth(health, { now: Date.now() });
    console.log(JSON.stringify({ ok: true, command: 'health', source: HEALTH_SOURCE_LABEL, aggregate }, null, 2));
    return;
  }
  usage();
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(String(error?.message || error));
    process.exitCode = 1;
  });
}
