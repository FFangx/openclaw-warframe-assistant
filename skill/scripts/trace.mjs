#!/usr/bin/env node

// R17 第一片：代表性交互链「裂缝 九重天」的最小本地脱敏端到端 trace。
//
// 边界（与总纲一致，只做这一条代表链）：
// - 只接「裂缝 九重天」这一个规范命令（isRepresentativeChain 精确门），其余命令不落盘；
// - 事件信封只允许 TRACE_ENVELOPE_FIELDS 这 12 个字段（traceId/triggerType/commandId/
//   privacyScopeHash/stage/startedAt/durationMs/source/freshness/resultCategory/
//   retryCount/contentHash），sanitizeEnvelope 白名单序列化，任何额外字段一律丢弃；
// - 永不写入：QQ target/发送者/用户原话/查询文本、个人快照、订单/卖家身份、完整工具结果、
//   URL、响应体、堆栈。隐私范围只以 privacyScopeHash(sha256('public'|'personal') 前 16 位) 呈现；
// - 容量有界（maxBytes/maxTraces/每 trace 阶段数/单行字节），压缩走临时文件 rename 原子写；
// - 全部写入失败一律 fail-open（返回 false，绝不向调用方抛错），文件缺失/损坏不影响主业务。
//
// 阶段接缝（等价稳定名）：received（QQ 入口）→ route（插件注册表门）→ authorization（身份门）→
// facts（世界状态 evidence/health，复用 _envelope/_dataSource/_dataStale/_cachedAt/_composite）→
// decision（查询判定）→ render（卡片）→ delivery（QQ 直投适配器结果）。
// 插件（received/route/authorization/delivery）与 shortcuts.mjs 子进程（facts/decision/render）
// 通过 WARFRAME_TRACE_ID/WARFRAME_TRACE_STORE/WARFRAME_TRACE_TRIGGER 环境变量串起同一 traceId。

import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TRACE_ENVELOPE_FIELDS = Object.freeze([
  'traceId', 'triggerType', 'commandId', 'privacyScopeHash', 'stage',
  'startedAt', 'durationMs', 'source', 'freshness', 'resultCategory',
  'retryCount', 'contentHash',
]);

export const TRACE_STAGES = Object.freeze([
  'received', 'route', 'authorization', 'facts', 'decision', 'render', 'delivery',
]);

export const MAX_TRACE_LINE_BYTES = 4096;
export const DEFAULT_MAX_BYTES = 256 * 1024;
export const DEFAULT_MAX_TRACES = 128;
export const DEFAULT_MAX_STAGES_PER_TRACE = 16;
const LOCK_STALE_MS = 5000;

// —— 代表链门 ——
// 与 command-registry.cjs 的 normalizeCommandText 同一套归一（NFKC/去头斜杠/空白折叠），
// 保证插件 raw content 与注册表解析后的 text 判定一致。
export function normalizeTraceText(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/^\//u, '').replace(/[\u3000\s]+/gu, ' ');
}

export function isRepresentativeChain(value) {
  return normalizeTraceText(value) === '裂缝 九重天';
}

export function newTraceId() {
  return randomUUID();
}

export function privacyScopeHash(scope = 'public') {
  return createHash('sha256').update(String(scope || 'public')).digest('hex').slice(0, 16);
}

// —— 信封白名单 ——
function cleanToken(value, maxLength) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, '').trim();
  return text ? text.slice(0, maxLength) : '';
}

function cleanInt(value, { min = 0, max = 3_600_000, fallback = 0 } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function cleanHash(value, maxLength = 64) {
  const text = String(value ?? '').trim().toLowerCase();
  return /^[a-f0-9]+$/u.test(text) ? text.slice(0, maxLength) : '';
}

export function sanitizeEnvelope(input, now = Date.now()) {
  if (!input || typeof input !== 'object') return null;
  const traceId = cleanToken(input.traceId, 64);
  const stage = String(input.stage || '').trim();
  if (!traceId || !TRACE_STAGES.includes(stage)) return null;
  const startedAtValue = String(input.startedAt || '').trim();
  const startedAt = Number.isFinite(Date.parse(startedAtValue)) ? startedAtValue : new Date(now).toISOString();
  return {
    traceId,
    triggerType: cleanToken(input.triggerType, 64) || 'unknown',
    commandId: cleanToken(input.commandId, 64) || 'unknown',
    privacyScopeHash: cleanHash(input.privacyScopeHash, 16),
    stage,
    startedAt,
    durationMs: cleanInt(input.durationMs),
    source: cleanToken(input.source, 64) || 'unknown',
    freshness: cleanToken(input.freshness, 32) || 'unknown',
    resultCategory: cleanToken(input.resultCategory, 64) || 'unknown',
    retryCount: cleanInt(input.retryCount, { max: 99 }),
    contentHash: cleanHash(input.contentHash, 64),
  };
}

// —— facts 阶段 evidence 复用（世界状态 evidence/health 字段 → 信封语义） ——
// 成功：source=裂缝字段提供者（_fieldProviders.fissures 优先，其次 _dataSource/_envelope.provider）；
// freshness 按 _dataStale/_cachedAt/_composite 映射（fresh / cache-hit / stale-cache / degraded）；
// contentHash 直接复用来源信封的 contentHash（官方/warframestat/Oracle 各自计算好的哈希）。
// 失败：只记通用来源名与诊断中的重试数，绝不把 URL/状态码主体/堆栈带进 trace。
export function worldstateEvidence(facts) {
  const state = facts?.state;
  if (state) {
    const source = state._fieldProviders?.fissures || state._dataSource || state._envelope?.provider || 'unknown';
    let freshness = 'fresh';
    if (state._dataStale === true) freshness = state._cachedAt ? 'stale-cache' : 'stale';
    else if (state._cachedAt) freshness = 'cache-hit';
    else if (state._composite) freshness = 'degraded';
    const contentHash = source === 'oracle.browse.wf'
      ? state._oracleEnvelope?.contentHash || ''
      : state._envelope?.contentHash || '';
    const resultCategory = state._composite || state._dataStale === true ? 'degraded' : 'ok';
    return { source, freshness, resultCategory, retryCount: 0, contentHash };
  }
  const diagnostic = facts?.error?.diagnostic;
  return {
    source: 'worldstate',
    freshness: 'unavailable',
    resultCategory: 'source_unavailable',
    retryCount: Math.max(0, Number(diagnostic?.attempts || 0) - 1),
    contentHash: '',
  };
}

export function decisionResultCategory(data) {
  if (!data) return 'unknown';
  if (data.ok) return data.personalized ? 'ok-personalized' : 'ok';
  if (data.error === 'source_unavailable') return 'source_unavailable';
  if (data.error === 'no_matches') return 'no_matches';
  return 'failed';
}

// 卡片内容指纹（只含公开字段 + personalized 布尔，不含 recommended 库存明细/时间戳）：
// 同一批裂缝渲染出稳定相等的内容哈希；卡片是否形成、是否有缓存语义都可据此判断。
export function fissureContentHash(data) {
  if (!data || data.kind !== 'fissure') return '';
  const rows = (items = []) => items.map((row) => [
    row.id, row.tier, row.mission, row.planet, row.node, Boolean(row.hard), Boolean(row.storm),
  ]);
  const payload = {
    kind: 'fissure', key: data.key || '', title: data.title || '',
    total: Number(data.total || 0),
    normal: rows(data.normal), hard: rows(data.hard),
    personalized: Boolean(data.personalized),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

// —— 容量有界、原子、fail-open 的本地 trace 存储（JSONL：每行一个信封） ——
// - 追加：单次 appendFile（O_APPEND），单行 ≤ MAX_TRACE_LINE_BYTES；
// - 压缩：行数/字节超限时读回全部行 → 按 traceId 分组保留最新 maxTraces 条、每 trace
//   最新 maxStagesPerTrace 个阶段 → 临时文件 + rename 原子替换；跨进程压缩用 5 秒陈旧
//   锁目录防互相覆盖，取不到锁就跳过本次压缩（容量暂时超出，下次追加再试）；
// - 任何 IO/解析异常都被吞掉并返回 false，绝不影响主业务。
export function createTraceStore(options = {}) {
  const filePath = String(options.filePath || '').trim();
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : DEFAULT_MAX_BYTES;
  const maxTraces = Number(options.maxTraces) > 0 ? Number(options.maxTraces) : DEFAULT_MAX_TRACES;
  const maxStagesPerTrace = Number(options.maxStagesPerTrace) > 0 ? Number(options.maxStagesPerTrace) : DEFAULT_MAX_STAGES_PER_TRACE;

  let writeQueue = Promise.resolve();
  const enqueue = (operation) => {
    const run = writeQueue.then(operation, operation);
    writeQueue = run.then(() => undefined, () => undefined);
    return run;
  };

  async function readTolerant() {
    const text = await readFile(filePath, 'utf8');
    const records = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (Buffer.byteLength(trimmed, 'utf8') > MAX_TRACE_LINE_BYTES * 4) continue;
      let parsed;
      try { parsed = JSON.parse(trimmed); } catch { continue; }
      const record = sanitizeEnvelope(parsed);
      if (record) records.push(record);
    }
    return records;
  }

  async function compact() {
    const lockPath = `${filePath}.lock`;
    try {
      await mkdir(lockPath);
    } catch {
      try {
        const existing = await stat(lockPath);
        if (Date.now() - existing.mtimeMs > LOCK_STALE_MS) {
          await rm(lockPath, { recursive: true, force: true });
          return compact();
        }
      } catch { /* stale lock already gone */ }
      return;
    }
    try {
      const records = await readTolerant();
      const groups = groupTraces(records);
      const kept = groups.slice(-maxTraces);
      let lines = [];
      for (const group of kept) {
        for (const record of group.stages.slice(-maxStagesPerTrace)) {
          lines.push(JSON.stringify(record));
        }
      }
      // maxTraces limits cardinality; maxBytes is a separate hard storage bound.
      // Drop oldest records until the serialized file fits. A deliberately tiny
      // maxBytes may retain no records, which is safer than unbounded growth.
      while (lines.length && Buffer.byteLength(`${lines.join('\n')}\n`, 'utf8') > maxBytes) {
        lines.shift();
      }
      const tempPath = `${filePath}.${process.pid}.tmp`;
      await writeFile(tempPath, `${lines.join('\n')}${lines.length ? '\n' : ''}`, 'utf8');
      await rename(tempPath, filePath);
    } finally {
      await rm(lockPath, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function maybeCompact() {
    try {
      const info = await stat(filePath);
      if (info.size <= maxBytes) return;
    } catch { return; }
    await compact();
  }

  async function append(input) {
    try {
      const record = sanitizeEnvelope(input);
      if (!record) return false;
      const line = JSON.stringify(record);
      if (Buffer.byteLength(line, 'utf8') > MAX_TRACE_LINE_BYTES) return false;
      await enqueue(async () => {
        if (!filePath) throw new Error('trace store path missing');
        await mkdir(path.dirname(filePath), { recursive: true }).catch(() => {});
        await appendFile(filePath, `${line}\n`, 'utf8');
        await maybeCompact();
      });
      return true;
    } catch {
      return false;
    }
  }

  async function read() {
    try {
      return await readTolerant();
    } catch {
      return [];
    }
  }

  return { path: filePath, maxBytes, maxTraces, maxStagesPerTrace, append, read };
}

// 按 traceId 分组：组内阶段按写入顺序；组按「最近活动」（最后一条记录的位置）升序，
// 供容量压缩优先保留最近仍在进行的 trace。
export function groupTraces(records) {
  const groups = new Map();
  const list = Array.isArray(records) ? records : [];
  for (let index = 0; index < list.length; index += 1) {
    const record = list[index];
    if (!record?.traceId) continue;
    let group = groups.get(record.traceId);
    if (!group) {
      group = { traceId: record.traceId, stages: [], lastIndex: index };
      groups.set(record.traceId, group);
    }
    group.stages.push({ ...record });
    group.lastIndex = index;
  }
  return [...groups.values()]
    .sort((left, right) => left.lastIndex - right.lastIndex)
    .map(({ traceId, stages }) => ({ traceId, stages }));
}

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.resolve(scriptsDir, '..');
// Source layout is <repo>/skill/scripts; managed runtime layout is
// <workspace>/skills/warframe-assistant/scripts.
const workspaceDir = path.basename(skillDir) === 'skill'
  ? path.resolve(skillDir, '..')
  : path.resolve(skillDir, '..', '..');
export const DEFAULT_TRACE_STORE_PATH = path.join(workspaceDir, '.cache', 'warframe-trace.jsonl');

// 只读 CLI（本地排障，零联网）：node scripts/trace.mjs read [--store <path>]
// 输出脱敏后的分组摘要：只含 12 个信封字段，绝不输出任何业务载荷。
async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = {};
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index].startsWith('--')) args[rest[index].slice(2)] = rest[index + 1] || true;
  }
  try {
    if (command === 'read') {
      const store = createTraceStore({ filePath: String(args.store || DEFAULT_TRACE_STORE_PATH) });
      const groups = groupTraces(await store.read());
      process.stdout.write(`${JSON.stringify({ path: store.path, maxTraces: store.maxTraces, traces: groups }, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify({ error: '用法：read [--store <path>]' })}\n`);
    process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: String(error?.message || error) })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
