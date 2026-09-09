#!/usr/bin/env node

// R12 第一纵向切片：fissure（裂缝）与 recommend（开遗物）两命令的
// 结构化请求协议 CommandRequest {commandId, args, source, privacyScope}。
//
// 边界（与总纲一致，只做这两条命令的最小切片）：
// - 命令在共享 public-usecase/personal-usecase 里经唯一命令注册表匹配一次后，
//   用「现有参数解析器」一次性建立 args：
//     fissure   -> shortcuts.mjs 的 parseFissureFilters（现有裂缝筛选结构化结果）
//     recommend -> recommend.mjs 的 parseRecommendCommand（含失败/冲突结果）
// - CommandRequest 只含 4 个字段；任何额外字段（QQ target、sender、原始用户全文、
//   快照、完整工具结果）都会被校验直接拒绝；
// - 入口 -> 子进程通过环境变量 WARFRAME_COMMAND_REQUEST 传递
//   {schemaVersion, commandId, args, source, privacyScope}：解码端做
//   schema/体积/commandId/privacyScope 校验，非法或超限直接失败，绝不静默回退重解析；
// - 未覆盖命令（其余 24 个）不建立请求，保持原有行为；
// - Decision：本模块只产出「筛选理解 + 候选 + 结论等级 + 证据引用」四类内容；
//   候选投影只携带渲染所需、非业务判断的展示事实（中文标签/时间戳/推荐摘要），
//   卡片与文字 Presentation 只消费该 Decision（+纯展示 facts），不再从旧 data
//   独立推导筛选、候选顺序、结论等级或缺价/陈旧证据语义。
//
// 安全边界（硬规则）：
// - 拒绝未知顶层键（防走私 target/sender/raw text/快照/工具结果）；
// - args 按命令白名单逐字段类型校验；体积上限 8 KiB；
// - 校验错误只抛通用错误串，绝不把入参原文带进错误 message。

import { createRequire } from 'node:module';
import {
  FISSURE_PREFERENCES,
  FISSURE_SCOPES,
  FISSURE_TIERS,
  RELIC_VAULT_FILTERS,
} from './recommend.mjs';

const { getCommand } = createRequire(import.meta.url)('./command-registry.cjs');

export const COMMAND_REQUEST_SCHEMA_VERSION = 1;
export const MAX_COMMAND_REQUEST_BYTES = 8192;
export const SLICED_COMMAND_IDS = Object.freeze(['fissure', 'recommend']);

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;
const ALLOWED_SOURCES = new Set([
  'before_dispatch', 'inbound_claim', 'before_agent_reply',
  'fast-command', 'tool-command', 'tool-subscription', 'dispatch-fallback',
]);

// 每个已切片命令的 args 允许键（严格白名单；fissure 键与 parseFissureFilters 输出一致）
const FISSURE_ARGS_KEYS = Object.freeze(['query', 'hardOnly', 'normalOnly', 'speedOnly', 'stormOnly', 'era', 'missions']);
const RECOMMEND_ARGS_KEYS = Object.freeze([
  'ok', 'mode', 'squad', 'preference', 'vaultFilter', 'fissureScope', 'tierFilter',
  'traderTarget', 'understanding', 'unsupported', 'issues', 'userError',
]);

function fail(message) {
  throw new Error(`invalid command request: ${message}`);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanSource(value) {
  const source = String(value ?? '').trim();
  return ALLOWED_SOURCES.has(source) ? source : null;
}

function assertExactKeys(value, allowed, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object`);
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail(`${label} has an unknown field`);
}

function assertCleanText(value, max, label, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || value.length > max || CONTROL_CHARS.test(value)) fail(`${label} is invalid`);
}

function assertFissureArgs(args) {
  assertExactKeys(args, FISSURE_ARGS_KEYS, 'fissure args');
  const { query, hardOnly, normalOnly, speedOnly, stormOnly, era, missions } = args;
  assertCleanText(query, 256, 'fissure args.query');
  for (const flag of [hardOnly, normalOnly, speedOnly, stormOnly]) {
    if (typeof flag !== 'boolean') fail('fissure args filter flag must be boolean');
  }
  assertCleanText(era, 32, 'fissure args.era', true);
  if (!Array.isArray(missions) || missions.length > 16 || !missions.every((mission) => typeof mission === 'string' && mission.length > 0 && mission.length <= 64 && !CONTROL_CHARS.test(mission))) {
    fail('fissure args.missions is invalid');
  }
}

function keySet(values) {
  return new Set(values);
}

function assertRecommendArgs(args) {
  assertExactKeys(args, RECOMMEND_ARGS_KEYS, 'recommend args');
  if (typeof args.ok !== 'boolean') fail('recommend args.ok must be boolean');
  assertExactKeys(args.understanding, ['mode', 'squad', 'preference', 'vaultFilter', 'fissureScope', 'tierFilter', 'itemTarget', 'traderAuto'], 'recommend understanding');
  if (!['plat', 'ducat'].includes(args.understanding.mode)
    || !Number.isInteger(args.understanding.squad) || args.understanding.squad < 1 || args.understanding.squad > 4
    || !keySet(Object.keys(FISSURE_PREFERENCES)).has(args.understanding.preference)
    || !keySet(Object.keys(RELIC_VAULT_FILTERS)).has(args.understanding.vaultFilter)
    || !keySet(Object.keys(FISSURE_SCOPES)).has(args.understanding.fissureScope)
    || !keySet(Object.keys(FISSURE_TIERS)).has(args.understanding.tierFilter)
    || typeof args.understanding.traderAuto !== 'boolean') fail('recommend understanding is invalid');
  if (args.understanding.itemTarget !== null) {
    assertExactKeys(args.understanding.itemTarget, ['query', 'explicit'], 'recommend understanding.itemTarget');
    assertCleanText(args.understanding.itemTarget.query, 128, 'recommend understanding.itemTarget.query');
    if (typeof args.understanding.itemTarget.explicit !== 'boolean') fail('recommend understanding.itemTarget is invalid');
  }
  if (args.ok) {
    if (!['plat', 'ducat'].includes(args.mode)) fail('recommend args.mode is invalid');
    const squad = Number(args.squad);
    if (!Number.isInteger(squad) || squad < 1 || squad > 4) fail('recommend args.squad is invalid');
    if (!keySet(Object.keys(FISSURE_PREFERENCES)).has(args.preference)) fail('recommend args.preference is invalid');
    if (!keySet(Object.keys(RELIC_VAULT_FILTERS)).has(args.vaultFilter)) fail('recommend args.vaultFilter is invalid');
    if (!keySet(Object.keys(FISSURE_SCOPES)).has(args.fissureScope)) fail('recommend args.fissureScope is invalid');
    if (!keySet(Object.keys(FISSURE_TIERS)).has(args.tierFilter)) fail('recommend args.tierFilter is invalid');
    const target = args.traderTarget;
    const targetNeedsExplicit = ['trader', 'item'].includes(target?.type);
    assertExactKeys(target, targetNeedsExplicit ? ['type', 'query', 'explicit'] : ['type', 'query'], 'recommend args.traderTarget');
    if (!['none', 'ordinary', 'trader', 'item'].includes(target.type)
      || typeof target.query !== 'string' || target.query.length > 128 || CONTROL_CHARS.test(target.query)
      || (targetNeedsExplicit && typeof target.explicit !== 'boolean')) {
      fail('recommend args.traderTarget is invalid');
    }
  } else {
    if (!Array.isArray(args.unsupported) || args.unsupported.length > 16 || !args.unsupported.every((token) => typeof token === 'string' && token.length > 0 && token.length <= 64 && !CONTROL_CHARS.test(token))) {
      fail('recommend args.unsupported is invalid');
    }
    if (!Array.isArray(args.issues) || args.issues.length > 16 || !args.issues.every((issue) => isPlainObject(issue)
      && Object.keys(issue).every((key) => ['token', 'reason'].includes(key))
      && typeof issue.token === 'string' && issue.token.length <= 64 && !CONTROL_CHARS.test(issue.token)
      && typeof issue.reason === 'string' && issue.reason.length <= 64 && !CONTROL_CHARS.test(issue.reason))) {
      fail('recommend args.issues is invalid');
    }
    assertExactKeys(args.userError, ['code', 'category', 'retryable', 'nextSteps'], 'recommend userError');
    assertCleanText(args.userError.code, 64, 'recommend userError.code');
    assertCleanText(args.userError.category, 64, 'recommend userError.category');
    if (typeof args.userError.retryable !== 'boolean'
      || !Array.isArray(args.userError.nextSteps) || args.userError.nextSteps.length > 8
      || !args.userError.nextSteps.every((step) => typeof step === 'string' && step.length <= 128 && !CONTROL_CHARS.test(step))) {
      fail('recommend args.userError is invalid');
    }
  }
}

/**
 * 校验一个 CommandRequest。合法时原样返回；非法时抛通用错误（不含入参原文）。
 * 未知顶层键一律拒绝：CommandRequest 只允许 {commandId, args, source, privacyScope}。
 */
export function assertCommandRequest(value) {
  if (!isPlainObject(value)) fail('request must be an object');
  const keys = Object.keys(value);
  if (keys.length !== 4 || !['commandId', 'args', 'source', 'privacyScope'].every((key) => keys.includes(key))) {
    fail('request must contain exactly commandId/args/source/privacyScope');
  }
  const { commandId, args, source, privacyScope } = value;
  if (typeof commandId !== 'string' || !SLICED_COMMAND_IDS.includes(commandId) || !getCommand(commandId)) {
    fail('commandId is unknown or not in the R12 slice');
  }
  const clean = cleanSource(source);
  if (!clean) fail('source is invalid');
  if (privacyScope !== getCommand(commandId)?.privacyScope) fail('privacyScope does not match the command registry');
  if (commandId === 'fissure') assertFissureArgs(args);
  else assertRecommendArgs(args);
  if (Buffer.byteLength(JSON.stringify({ commandId, args, source, privacyScope }), 'utf8') > MAX_COMMAND_REQUEST_BYTES) {
    fail('request exceeds byte budget');
  }
  return { commandId, args, source: clean, privacyScope };
}

/** 把已校验请求编码为子进程环境变量负载（附带 schemaVersion）。 */
export function encodeCommandRequest(request) {
  const validated = assertCommandRequest(request);
  const payload = { ...validated, schemaVersion: COMMAND_REQUEST_SCHEMA_VERSION };
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_COMMAND_REQUEST_BYTES) fail('encoded request exceeds byte budget');
  return encoded;
}

/** 解码并校验环境变量负载；缺失/空返回 null；非法直接抛错（不静默回退）。 */
export function decodeCommandRequestString(rawValue) {
  if (rawValue == null || String(rawValue).trim() === '') return null;
  if (Buffer.byteLength(String(rawValue), 'utf8') > MAX_COMMAND_REQUEST_BYTES) fail('payload exceeds byte budget');
  let parsed;
  try {
    parsed = JSON.parse(String(rawValue));
  } catch {
    fail('payload is not valid JSON');
  }
  if (!isPlainObject(parsed)) fail('payload must be an object');
  if (parsed.schemaVersion !== COMMAND_REQUEST_SCHEMA_VERSION) fail('schemaVersion is unsupported');
  const { schemaVersion, ...rest } = parsed;
  return assertCommandRequest(rest);
}

/**
 * 在共享用例里建立 CommandRequest：只对已切片命令解析 args（现有解析器调用一次；
 * 其余命令返回 null 保持原行为）。matched 来自命令注册表匹配结果。
 */
export async function buildCommandRequest({ matched, source }) {
  const commandId = matched?.commandId;
  if (!commandId || !SLICED_COMMAND_IDS.includes(commandId)) return null;
  let args = null;
  if (commandId === 'fissure') {
    const { parseFissureFilters } = await import('./shortcuts.mjs');
    args = parseFissureFilters(matched.query || '');
  } else {
    const { parseRecommendCommand } = await import('./recommend.mjs');
    args = parseRecommendCommand(matched.query || '');
  }
  const request = {
    commandId,
    args,
    source,
    privacyScope: getCommand(commandId).privacyScope,
  };
  return assertCommandRequest(request);
}

/**
 * 公开裂缝卡的私聊库存增强不是第二条用户命令。它只能从已校验的 fissure args
 * 确定性派生 recommend 请求，不能重新解析用户原文。任务类型/普通筛选没有等价的
 * recommend 参数时返回 null，让公开裂缝结果诚实降级而不是猜测。
 */
export function deriveRecommendRequestFromFissure(request) {
  const fissure = assertCommandRequest(request);
  if (fissure.commandId !== 'fissure') fail('derivation requires fissure');
  const filters = fissure.args;
  if (filters.normalOnly || filters.missions.length) return null;
  const fissureScope = filters.stormOnly ? 'storm' : filters.hardOnly ? 'steel' : 'all';
  const tierFilter = filters.era || 'all';
  const preference = filters.speedOnly ? 'speed' : 'balanced';
  const args = {
    ok: true,
    mode: 'plat',
    squad: 4,
    preference,
    vaultFilter: 'all',
    fissureScope,
    tierFilter,
    traderTarget: { type: 'none', query: '' },
    understanding: {
      mode: 'plat', squad: 4, preference, vaultFilter: 'all', fissureScope, tierFilter,
      itemTarget: null, traderAuto: false,
    },
  };
  return assertCommandRequest({
    commandId: 'recommend', args, source: fissure.source,
    privacyScope: getCommand('recommend').privacyScope,
  });
}

// —— Decision（筛选理解/候选/结论等级/证据引用）——
// 候选投影只允许携带「渲染所需、非业务判断」的展示事实（中文标签、时间戳、推荐摘要），
// 不携带完整原始工具结果、库存原文或任何个人标识。

function fissureRecommendationProjection(rec) {
  if (!rec || typeof rec !== 'object') return null;
  return {
    relic: {
      base: String(rec.relic?.base ?? ''),
      zh: String(rec.relic?.zh ?? ''),
      count: Number(rec.relic?.count) || 0,
      vaulted: Boolean(rec.relic?.vaulted),
    },
    expectedValue: rec.expectedValue ?? null,
    expectedDucats: rec.expectedDucats ?? null,
    refineZh: rec.refineZh || null,
    targetEconomy: rec.targetEconomy
      ? {
          expectedDucats: rec.targetEconomy.expectedDucats ?? null,
          expectedPlat: rec.targetEconomy.expectedPlat ?? null,
        }
      : null,
    valuation: rec.valuation
      ? { priceReliable: rec.valuation.priceReliable ?? null }
      : null,
  };
}

function fissureCandidate(row, includeRecommendation = false) {
  const recommendation = includeRecommendation ? fissureRecommendationProjection(row?.recommendation) : null;
  return {
    id: String(row?.id || ''),
    tier: String(row?.tier || ''),
    missionType: String(row?.missionType || ''),
    mission: String(row?.mission || row?.missionType || ''),
    node: String(row?.node || ''),
    planet: String(row?.planet || ''),
    faction: String(row?.faction || ''),
    hard: Boolean(row?.hard),
    storm: Boolean(row?.storm),
    tags: (Array.isArray(row?.tags) ? row.tags : [])
      .map((tag) => ({ key: String(tag?.key ?? ''), zh: String(tag?.zh ?? '') })),
    expiry: row?.expiry ?? null,
    hasRecommendation: Boolean(recommendation),
    priceReliable: recommendation?.valuation?.priceReliable ?? null,
    recommendation,
  };
}

/**
 * fissure 判定：understanding=结构化筛选（args），candidates=筛选后的裂缝票，
 * conclusion=confirmed（新鲜直接证据）/ inferred（缓存/降级/个人增强）/ insufficient（无证据或无结果）。
 * evidence.facts 只带来源/范围/新鲜度/内容哈希，不带裂缝之外的载荷。
 */
export function buildFissureDecision({ filters, rows, evidence, scope = 'public', ok = true }) {
  const freshness = evidence?.freshness || 'unknown';
  const includeRecommendation = scope === 'personal';
  return {
    commandId: 'fissure',
    scope,
    understanding: filters || null,
    candidates: (Array.isArray(rows) ? rows : []).map((row) => fissureCandidate(row, includeRecommendation)),
    conclusion: !ok ? 'insufficient'
      : (scope === 'personal' || !['fresh', 'cache-hit'].includes(freshness)) ? 'inferred'
        : 'confirmed',
    evidence: {
      facts: {
        source: evidence?.source || 'unknown',
        scope: 'worldstate',
        freshness,
        fetchedAt: evidence?.fetchedAt || null,
        contentHash: evidence?.contentHash || null,
      },
    },
  };
}

function recommendCandidate(row, kind = 'route') {
  return {
    id: String(row?.id || ''),
    kind,
    relicBase: String(row?.relic?.base || ''),
    relicZh: String(row?.relic?.zh || ''),
    count: Number(row?.relic?.count) || 0,
    relicVaulted: Boolean(row?.relic?.vaulted),
    tier: String(row?.tier || ''),
    missionZh: String(row?.missionZh || ''),
    node: String(row?.node || ''),
    planet: String(row?.planet || ''),
    hard: Boolean(row?.hard),
    storm: Boolean(row?.storm),
    tags: (Array.isArray(row?.tags) ? row.tags : [])
      .map((tag) => ({ key: String(tag?.key ?? ''), zh: String(tag?.zh ?? '') })),
    expiry: row?.expiry ?? null,
    expectedValue: row?.expectedValue ?? null,
    expectedDucats: row?.expectedDucats ?? null,
    priceReliable: row?.valuation?.priceReliable ?? null,
    refineZh: row?.refineZh || null,
    targetEconomy: row?.targetEconomy
      ? {
          expectedDucats: row.targetEconomy.expectedDucats ?? null,
          expectedPlat: row.targetEconomy.expectedPlat ?? null,
          efficiency: row.targetEconomy.efficiency ?? null,
          expectedRuns: row.targetEconomy.expectedRuns ?? null,
          opportunityPlat: row.targetEconomy.opportunityPlat ?? null,
        }
      : null,
    topReward: row?.topReward
      ? { zhName: String(row.topReward.zhName ?? ''), price: row.topReward.price ?? null }
      : null,
    topDucat: row?.topDucat
      ? { zhName: String(row.topDucat.zhName ?? ''), ducats: row.topDucat.ducats ?? null }
      : null,
    sources: (Array.isArray(row?.sources) ? row.sources : [])
      .map((source) => ({ place: String(source?.place ?? ''), chance: Number(source?.chance) || 0 })),
  };
}

/**
 * recommend 判定：understanding=参数理解回显（结构化），candidates=推荐候选摘要
 * （含「建议获取」候选，kind='acquire'；不含库存原文之外的任何个人标识），
 * conclusion=confirmed（新鲜可靠估值）/ inferred（离线快照/部分缺价兜底）/
 * insufficient（解析失败或业务失败）。
 * evidence 引用 recommendFissures 附带的决策证据（worldState/priceTable/localDb）。
 */
export function buildRecommendDecision({ parsed, data, scope = 'userPrivate' }) {
  // 结构化优先：data.understanding 是格式化回显字符串，不是筛选理解本体。
  const structured = isPlainObject(parsed?.understanding) ? parsed.understanding
    : isPlainObject(data?.understanding) ? data.understanding
      : null;
  const understanding = structured || null;
  const routeCandidates = (Array.isArray(data?.rows) ? data.rows : [])
    .map((row) => recommendCandidate(row, 'route'));
  const acquireCandidates = (Array.isArray(data?.acquireRows) ? data.acquireRows : [])
    .map((row) => recommendCandidate(row, 'acquire'));
  const candidates = [...routeCandidates, ...acquireCandidates];
  const hasIncompletePrice = Number(data?.valuationIncompleteCount) > 0
    || candidates.some((candidate) => candidate.priceReliable === false);
  const conclusion = !data?.ok ? 'insufficient'
    : (data.degraded || data.priceStaleAt || hasIncompletePrice) ? 'inferred'
      : 'confirmed';
  const evidence = data?.decisionEvidence || {};
  return {
    commandId: 'recommend',
    scope,
    understanding,
    candidates,
    conclusion,
    evidence: {
      worldState: evidence.worldState || null,
      priceTable: evidence.priceTable || null,
      localDb: evidence.localDb || null,
    },
  };
}
