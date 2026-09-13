#!/usr/bin/env node

// R15 第五片（最后一片）：AccountSnapshot v1 的本地 delta 账本。
//
// 职责只有一件事：把「上一次快照 → 这一次快照」的变化**生成一次**，落进助手自己的
// 状态文件，然后让 drops 与 weekly 从同一份事件流、按同一个 eventId 各自消费。
//
// 不变量（不要回退）：
//   1. 只用自己的状态文件（warframe-account-delta-ledger.json），绝不读/写 AlecaFrame
//      的 deltas.dat；schema 版本化，超前版本只读不动。
//   2. 首次入库只建基线不造事件；同一快照重复入库幂等（不产生事件、不改写文件）。
//   3. 持久化内容 = 最小脱敏基线（account-snapshot 的 ACCOUNT_DELTA_BASELINE_FIELDS）
//      + 有界事件 + 每消费者游标/确认状态。原始信封、完整快照、账号 oid、登录令牌、
//      文件路径、无关字段一律不落盘。
//   4. 事件数量 / 总体积 / 保留期三重上限；丢弃任何事件都要让消费者看到断档（gap），
//      不静默丢。
//   5. 写入原子（tmp + rename）；同进程串行 + 跨进程文件锁（含陈旧锁回收）；锁不可得
//      时返回降级结果而不是抛异常。
//   6. 文件损坏或 schema 超前：不落盘、不清空、不重建，返回 degraded 让业务诚实降级。
//   7. 事件只作触发/审计；consumer 各自独立确认，一个消费者不推进另一个的游标。

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ACCOUNT_DELTA_BASELINE_FIELDS,
  ACCOUNT_DELTA_QUANTITY_FIELDS,
  ACCOUNT_SNAPSHOT_SCHEMA_VERSION,
  ACCOUNT_SNAPSHOT_SOURCE,
  diffAccountSnapshots,
  projectDeltaBaseline,
} from './account-snapshot.mjs';

export const DELTA_LEDGER_SCHEMA_VERSION = 1;
export const DELTA_LEDGER_KIND = 'account-delta-ledger';
// 与 drops/weekly 状态文件同目录（助手自身状态目录 workspace/state）。
export const DELTA_LEDGER_FILE_NAME = 'warframe-account-delta-ledger.json';

// 消费者注册表：游标只能出现在这些键上，避免状态文件被任意键撑大。
export const DELTA_LEDGER_CONSUMERS = Object.freeze({ DROPS: 'drops', WEEKLY: 'weekly' });
const CONSUMER_IDS = Object.freeze(Object.values(DELTA_LEDGER_CONSUMERS));
const CONSUMER_SET = new Set(CONSUMER_IDS);
const BASELINE_FIELD_SET = new Set(ACCOUNT_DELTA_BASELINE_FIELDS);
const QUANTITY_FIELD_SET = new Set(ACCOUNT_DELTA_QUANTITY_FIELDS);
const LEDGER_KEYS = Object.freeze(['baseline', 'consumers', 'events', 'kind', 'lostSeq', 'nextSeq', 'schemaVersion', 'updatedAt']);
const EVENT_KEYS = Object.freeze([
  'asOf', 'at', 'change', 'changedMetrics', 'cycle', 'delta', 'entity', 'eventId', 'field',
  'from', 'fromAsOf', 'kind', 'seq', 'to',
]);

// —— 有界化上限（数量 / 体积 / 保留期）——
export const MAX_LEDGER_EVENTS = 512;
export const MAX_LEDGER_EVENTS_BYTES = 256 * 1024;
export const MAX_LEDGER_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// cron 最长运行 120 秒，超过两分钟的锁不可能再属于正常任务。持锁方每 20 秒心跳一次，
// 不会把自己的锁熬成“陈旧锁”。
export const DELTA_LEDGER_LOCK_STALE_MS = 2 * 60 * 1000;
const LOCK_HEARTBEAT_MS = 20 * 1000;
const LOCK_WAIT_MS = 25;
const LOCK_ATTEMPTS = 160;

// 降级原因（枚举，便于业务判断；不含任何事件/基线内容）
export const DELTA_LEDGER_DEGRADED = Object.freeze({
  CORRUPT: 'corrupt',
  FUTURE_SCHEMA: 'future_schema',
  UNREADABLE: 'unreadable',
  LOCKED: 'locked',
  INVALID_SNAPSHOT: 'invalid_snapshot',
});

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 生产默认路径：与 drops/weekly 状态文件同目录，和 Outbox 的派生方式保持一致。
export function defaultDeltaLedgerPath(statePath) {
  return path.join(path.dirname(String(statePath)), DELTA_LEDGER_FILE_NAME);
}

// clock 可注入：数字 / Date / ISO 字符串 / 返回前三者的函数都接受。
export function resolveLedgerClock(clock) {
  let source = clock;
  if (source === undefined || source === null) source = () => Date.now();
  const read = typeof source === 'function' ? source : () => source;
  return () => {
    const value = read();
    const ms = value instanceof Date ? value.getTime() : (typeof value === 'number' ? value : Date.parse(String(value)));
    return Number.isFinite(ms) ? ms : Date.now();
  };
}

function emptyLedgerState(nowMs) {
  return {
    schemaVersion: DELTA_LEDGER_SCHEMA_VERSION,
    kind: DELTA_LEDGER_KIND,
    updatedAt: new Date(nowMs).toISOString(),
    baseline: null,
    events: [],
    nextSeq: 1,
    lostSeq: 0,
    consumers: Object.fromEntries(CONSUMER_IDS.map((id) => [id, { cursor: 0, ackedAt: null }])),
  };
}

function hasExactKeys(value, keys) {
  return isPlainObject(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function validIsoOrNull(value) {
  return value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
}

function validJsonValue(value, depth = 0) {
  if (depth > 4) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 128 && value.every((item) => validJsonValue(item, depth + 1));
  if (!isPlainObject(value) || Object.keys(value).length > 16) return false;
  return Object.values(value).every((item) => validJsonValue(item, depth + 1));
}

function validLedgerEvent(event, previousSeq, head) {
  if (!hasExactKeys(event, EVENT_KEYS)) return false;
  if (!Number.isInteger(event.seq) || event.seq <= previousSeq || event.seq > head) return false;
  if (event.eventId !== `acct-delta-v1-${event.seq}`) return false;
  if (!['inventory-quantity', 'weekly-scalar', 'weekly-record'].includes(event.kind)) return false;
  if (typeof event.field !== 'string' || !event.field || !BASELINE_FIELD_SET.has(event.field.split('.')[0])) return false;
  if (event.kind === 'inventory-quantity' && !QUANTITY_FIELD_SET.has(event.field)) return false;
  if (typeof event.change !== 'string' || !event.change) return false;
  if (event.entity !== null && typeof event.entity !== 'string') return false;
  if (typeof event.cycle !== 'string' || !event.cycle) return false;
  if (!Array.isArray(event.changedMetrics) || !event.changedMetrics.every((item) => typeof item === 'string')) return false;
  if (!validIsoOrNull(event.asOf) || !validIsoOrNull(event.fromAsOf) || !validIsoOrNull(event.at) || event.at === null) return false;
  if (event.delta !== null && !Number.isFinite(event.delta)) return false;
  return validJsonValue(event.from) && validJsonValue(event.to);
}

function degradedResult(degraded, detail) {
  return { ok: false, degraded, detail: detail ?? null };
}

// 锁竞争是「稍后重试」而不是「崩溃」：用可识别的 code 区分，只把这一类转成降级结果，
// 磁盘/序列化等真实错误照旧抛出，不伪装成「状态正忙」。
export function ledgerBusyError(message = 'delta 账本状态正忙') {
  const error = new Error(message);
  error.code = 'LEDGER_BUSY';
  return error;
}

function degradedOfLoad(loaded) {
  if (loaded.status === 'future_schema') return degradedResult(DELTA_LEDGER_DEGRADED.FUTURE_SCHEMA, loaded.detail);
  if (loaded.status === 'unreadable') return degradedResult(DELTA_LEDGER_DEGRADED.UNREADABLE, loaded.detail);
  return degradedResult(DELTA_LEDGER_DEGRADED.CORRUPT, loaded.detail);
}

// —— 事件最小投影：只保留「生成 delta 的既有字段」，diff 的冗余 id 不再落盘 ——

function ledgerEventOf(event, seq, at) {
  return {
    seq,
    eventId: `acct-delta-v1-${seq}`,
    kind: String(event.kind ?? ''),
    field: String(event.field ?? ''),
    entity: event.entity == null ? null : String(event.entity),
    change: String(event.change ?? ''),
    from: event.from ?? null,
    to: event.to ?? null,
    delta: Number.isFinite(event.delta) ? Number(event.delta) : null,
    changedMetrics: Array.isArray(event.changedMetrics) ? event.changedMetrics.map((item) => String(item)) : [],
    cycle: String(event.cycle ?? 'none'),
    asOf: event.asOf ?? null,
    fromAsOf: event.fromAsOf ?? null,
    at,
  };
}

// 基线快照重建：账本里存的就是 projectDeltaBaseline 的输出，可直接当 diff 的 previous。
function baselineSnapshotOf(payload) {
  return {
    schemaVersion: ACCOUNT_SNAPSHOT_SCHEMA_VERSION,
    source: ACCOUNT_SNAPSHOT_SOURCE,
    asOf: payload?.asOf ?? null,
    asOfBasis: payload?.asOfBasis ?? null,
    inventory: isPlainObject(payload?.inventory) ? payload.inventory : {},
  };
}

// —— 有界化：保留期 → 条数 → 体积，全部从最旧开始丢；丢掉的最高序号记入 lostSeq ——

function pruneEvents(events, nowMs, limits) {
  const cutoff = nowMs - limits.ageMs;
  let start = 0;
  let lostSeq = 0;
  const expired = (event) => {
    const at = Date.parse(String(event?.at ?? ''));
    return Number.isFinite(at) && at < cutoff;
  };
  while (start < events.length && expired(events[start])) {
    lostSeq = Math.max(lostSeq, Number(events[start].seq) || 0);
    start += 1;
  }
  while (events.length - start > limits.events) {
    lostSeq = Math.max(lostSeq, Number(events[start].seq) || 0);
    start += 1;
  }
  let kept = events.slice(start);
  let bytes = JSON.stringify(kept).length;
  let offset = 0;
  while (offset < kept.length && bytes > limits.bytes) {
    bytes -= JSON.stringify(kept[offset]).length + 1;
    lostSeq = Math.max(lostSeq, Number(kept[offset].seq) || 0);
    offset += 1;
  }
  if (offset > 0) kept = kept.slice(offset);
  return { events: kept, lostSeq };
}

// —— 载入：损坏/超前一律“只读不动”，绝不静默清空 ——

async function loadLedgerFile(statePath) {
  let text;
  try {
    text = await readFile(statePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'missing' };
    return { status: 'unreadable', detail: String(error?.code || error?.message || error) };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: 'corrupt', detail: 'invalid_json' };
  }
  if (!isPlainObject(parsed)) return { status: 'corrupt', detail: 'not_object' };
  if (parsed.kind !== DELTA_LEDGER_KIND) return { status: 'corrupt', detail: 'unexpected_kind' };
  const version = Number(parsed.schemaVersion);
  if (!Number.isInteger(version) || version < 1) return { status: 'corrupt', detail: 'invalid_schema_version' };
  if (version > DELTA_LEDGER_SCHEMA_VERSION) return { status: 'future_schema', detail: `schemaVersion=${version}` };
  if (!hasExactKeys(parsed, LEDGER_KEYS)) return { status: 'corrupt', detail: 'unexpected_shape' };
  if (!validIsoOrNull(parsed.updatedAt) || parsed.updatedAt === null) return { status: 'corrupt', detail: 'invalid_updated_at' };
  if (!Array.isArray(parsed.events)) return { status: 'corrupt', detail: 'events_not_array' };
  const nextSeq = parsed.nextSeq;
  const lostSeq = parsed.lostSeq;
  if (!Number.isInteger(nextSeq) || nextSeq < 1) return { status: 'corrupt', detail: 'invalid_next_seq' };
  const head = nextSeq - 1;
  if (!Number.isInteger(lostSeq) || lostSeq < 0 || lostSeq > head) return { status: 'corrupt', detail: 'invalid_lost_seq' };
  let previousSeq = 0;
  for (const event of parsed.events) {
    if (!validLedgerEvent(event, previousSeq, head)) return { status: 'corrupt', detail: 'invalid_event' };
    previousSeq = event.seq;
  }
  if (!hasExactKeys(parsed.consumers, CONSUMER_IDS)) return { status: 'corrupt', detail: 'invalid_consumers' };
  const consumers = {};
  for (const id of CONSUMER_IDS) {
    const entry = parsed.consumers?.[id];
    if (!hasExactKeys(entry, ['ackedAt', 'cursor'])) return { status: 'corrupt', detail: `invalid_consumer:${id}` };
    const cursor = entry.cursor;
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > head || !validIsoOrNull(entry.ackedAt)) {
      return { status: 'corrupt', detail: `invalid_consumer:${id}` };
    }
    consumers[id] = {
      cursor,
      ackedAt: entry.ackedAt,
    };
  }
  if (!hasExactKeys(parsed.baseline, ['at', 'payload']) || !validIsoOrNull(parsed.baseline.at) || parsed.baseline.at === null) {
    return { status: 'corrupt', detail: 'invalid_baseline' };
  }
  let canonicalBaseline;
  try {
    canonicalBaseline = projectDeltaBaseline(parsed.baseline.payload);
  } catch {
    return { status: 'corrupt', detail: 'invalid_baseline_payload' };
  }
  if (JSON.stringify(canonicalBaseline) !== JSON.stringify(parsed.baseline.payload)) {
    return { status: 'corrupt', detail: 'noncanonical_baseline_payload' };
  }
  if (!Object.keys(canonicalBaseline.inventory).every((field) => BASELINE_FIELD_SET.has(field))) {
    return { status: 'corrupt', detail: 'unexpected_baseline_field' };
  }
  return {
    status: 'ok',
    state: {
      schemaVersion: DELTA_LEDGER_SCHEMA_VERSION,
      kind: DELTA_LEDGER_KIND,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
      baseline: parsed.baseline,
      events: parsed.events,
      nextSeq,
      lostSeq,
      consumers,
    },
  };
}

// —— 锁：同进程串行（模块级队列）+ 跨进程文件锁（wx + 陈旧回收 + 心跳 + 只删自己的锁）——

const inProcessQueues = new Map();

function serializeOn(statePath, operation) {
  const key = String(statePath);
  const previous = inProcessQueues.get(key) || Promise.resolve();
  const run = previous.then(operation, operation);
  inProcessQueues.set(key, run.then(() => undefined, () => undefined));
  return run;
}

async function withFileLock(lockPath, operation, options) {
  const staleMs = Number.isFinite(options.lockStaleMs) ? options.lockStaleMs : DELTA_LEDGER_LOCK_STALE_MS;
  const attempts = Number.isFinite(options.lockAttempts) ? options.lockAttempts : LOCK_ATTEMPTS;
  const waitMs = Number.isFinite(options.lockWaitMs) ? options.lockWaitMs : LOCK_WAIT_MS;
  const lockToken = `${process.pid}:${randomUUID()}`;
  await mkdir(path.dirname(lockPath), { recursive: true });
  let handle = null;
  for (let attempt = 0; attempt < attempts && !handle; attempt += 1) {
    try {
      handle = await open(lockPath, 'wx');
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > staleMs) {
          // 陈旧锁（进程被强杀遗留）：回收后立即重试
          await unlink(lockPath).catch(() => {});
          continue;
        }
      } catch { /* 锁刚被释放，直接重试 */ }
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  if (!handle) throw ledgerBusyError();
  const heartbeat = setInterval(() => {
    const stamp = new Date();
    void utimes(lockPath, stamp, stamp).catch(() => {});
  }, LOCK_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    await handle.writeFile(`${lockToken}\n`, 'utf8');
    return await operation();
  } finally {
    clearInterval(heartbeat);
    await handle.close().catch(() => {});
    const owner = await readFile(lockPath, 'utf8').catch(() => '');
    if (owner.trim() === lockToken) await unlink(lockPath).catch(() => {});
  }
}

async function persistLedger(statePath, state, nowMs) {
  state.updatedAt = new Date(nowMs).toISOString();
  await mkdir(path.dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(state)}\n`, 'utf8');
    await rename(tempPath, statePath);
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}

function consumerEntries(state) {
  return CONSUMER_IDS.map((id) => ({
    id,
    cursor: state.consumers[id]?.cursor ?? 0,
    ackedAt: state.consumers[id]?.ackedAt ?? null,
  }));
}

/**
 * 创建账本实例。测试可注入 statePath / clock / lock；生产默认走助手状态目录。
 * @param {{ statePath?: string, clock?: unknown, now?: unknown, lock?: Function, lockStaleMs?: number }} [options]
 */
export function createDeltaLedger(options = {}) {
  const statePath = options.statePath ? path.resolve(String(options.statePath)) : null;
  if (!statePath) throw new Error('delta 账本需要 statePath');
  const now = resolveLedgerClock(options.clock ?? options.now);
  // 上限可注入（测试用极小值验证裁剪/断档）；生产默认取上面的常量。
  const limits = {
    events: MAX_LEDGER_EVENTS,
    bytes: MAX_LEDGER_EVENTS_BYTES,
    ageMs: MAX_LEDGER_EVENT_AGE_MS,
    ...(isPlainObject(options.limits) ? options.limits : {}),
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
      throw new Error(`delta 账本上限无效: ${name}`);
    }
  }
  // 注入的 lock 直接替代文件锁（测试用于模拟竞争/失败）；同进程串行始终生效。
  const lock = typeof options.lock === 'function'
    ? (operation) => options.lock(operation)
    : (operation) => withFileLock(`${statePath}.lock`, operation, options);

  async function exclusive(operation) {
    return serializeOn(statePath, async () => {
      try {
        return await lock(operation);
      } catch (error) {
        if (error?.code === 'LEDGER_BUSY') return degradedResult(DELTA_LEDGER_DEGRADED.LOCKED, String(error?.message || error));
        throw error;
      }
    });
  }

  /**
   * 把一次适配后的快照并入账本：更新基线 + 追加 delta 事件（首次只建基线）。
   * 幂等：与已存基线完全一致时不产生事件、不改写文件。
   */
  async function ingest(snapshot) {
    let projected;
    try {
      projected = projectDeltaBaseline(snapshot);
    } catch (error) {
      return degradedResult(DELTA_LEDGER_DEGRADED.INVALID_SNAPSHOT, String(error?.message || error));
    }
    const serialized = JSON.stringify(projected);
    return exclusive(async () => {
      const nowMs = now();
      const at = new Date(nowMs).toISOString();
      const loaded = await loadLedgerFile(statePath);
      if (loaded.status !== 'ok' && loaded.status !== 'missing') return degradedOfLoad(loaded);
      const state = loaded.status === 'ok' ? loaded.state : emptyLedgerState(nowMs);
      const baselineCreated = state.baseline === null;

      if (!baselineCreated && JSON.stringify(state.baseline.payload) === serialized) {
        // 同一快照重复入库：不造事件、不重写文件（保留期清理也只在实际写入时发生）。
        return {
          ok: true,
          unchanged: true,
          baselineCreated: false,
          appended: 0,
          dropped: 0,
          truncated: false,
          events: state.events.length,
          nextSeq: state.nextSeq,
          lostSeq: state.lostSeq,
          baselineAsOf: state.baseline.payload.asOf ?? null,
        };
      }

      let appended = 0;
      let dropped = 0;
      let truncated = false;
      if (baselineCreated) {
        state.events = [];
      } else {
        const diff = diffAccountSnapshots(baselineSnapshotOf(state.baseline.payload), projected, { limit: MAX_LEDGER_EVENTS });
        const startSeq = state.nextSeq;
        appended = diff.events.length;
        truncated = Boolean(diff.truncated);
        dropped = truncated ? Math.max(0, diff.totalEvents - appended) : 0;
        state.events = [
          ...state.events,
          ...diff.events.map((event, index) => ledgerEventOf(event, startSeq + index, at)),
        ];
        // 未落盘的尾部事件同样占用序号：消费者 ack 到 uptoSeq 就能越过断档，不会永久卡住。
        state.nextSeq = startSeq + Math.max(diff.totalEvents, appended);
        if (truncated) state.lostSeq = Math.max(state.lostSeq, state.nextSeq - 1);
      }
      state.baseline = { at, payload: projected };
      const pruned = pruneEvents(state.events, nowMs, limits);
      state.events = pruned.events;
      state.lostSeq = Math.max(state.lostSeq, pruned.lostSeq);
      await persistLedger(statePath, state, nowMs);
      return {
        ok: true,
        unchanged: false,
        baselineCreated,
        appended,
        dropped,
        truncated,
        events: state.events.length,
        nextSeq: state.nextSeq,
        lostSeq: state.lostSeq,
        baselineAsOf: projected.asOf ?? null,
      };
    });
  }

  /**
   * 读取该消费者尚未确认的事件（同一 eventId 供所有消费者共享）。
   * 两个固定消费者在首个基线建立时已同时注册，因此都会看到此后生成的同一批事件。
   */
  async function read(consumerId) {
    if (!CONSUMER_SET.has(consumerId)) return degradedResult(DELTA_LEDGER_DEGRADED.CORRUPT, `unknown_consumer:${consumerId}`);
    return exclusive(async () => {
      const nowMs = now();
      const loaded = await loadLedgerFile(statePath);
      if (loaded.status === 'missing') {
        return {
          ok: true, empty: true, initialized: false, consumerId, cursor: 0, uptoSeq: 0,
          gap: false, events: [], eventIds: [], baselinePresent: false, baselineAsOf: null,
        };
      }
      if (loaded.status !== 'ok') return degradedOfLoad(loaded);
      const state = loaded.state;
      const head = state.nextSeq - 1;
      const cursor = state.consumers[consumerId].cursor;
      const events = state.events.filter((event) => event.seq > cursor);
      return {
        ok: true,
        empty: false,
        initialized: false,
        consumerId,
        cursor,
        uptoSeq: head,
        gap: cursor < state.lostSeq,
        events,
        eventIds: events.map((event) => event.eventId),
        baselinePresent: state.baseline !== null,
        baselineAsOf: state.baseline?.payload?.asOf ?? null,
      };
    });
  }

  /** 处理成功后才推进游标：单调、只前不后、不会越过水位。 */
  async function ack(consumerId, uptoSeq) {
    if (!CONSUMER_SET.has(consumerId)) return degradedResult(DELTA_LEDGER_DEGRADED.CORRUPT, `unknown_consumer:${consumerId}`);
    const target = Number(uptoSeq);
    if (!Number.isFinite(target)) return { ok: false, degraded: DELTA_LEDGER_DEGRADED.CORRUPT, detail: 'invalid_cursor' };
    return exclusive(async () => {
      const nowMs = now();
      const loaded = await loadLedgerFile(statePath);
      if (loaded.status !== 'ok') return loaded.status === 'missing' ? { ok: true, cursor: 0, empty: true } : degradedOfLoad(loaded);
      const state = loaded.state;
      const head = state.nextSeq - 1;
      const current = state.consumers[consumerId]?.cursor ?? 0;
      const cursor = Math.max(current, Math.min(Math.floor(target), Math.max(head, 0)));
      state.consumers[consumerId] = { cursor, ackedAt: new Date(nowMs).toISOString() };
      const pruned = pruneEvents(state.events, nowMs, limits);
      state.events = pruned.events;
      state.lostSeq = Math.max(state.lostSeq, pruned.lostSeq);
      await persistLedger(statePath, state, nowMs);
      return { ok: true, consumerId, cursor, uptoSeq: head, lostSeq: state.lostSeq };
    });
  }

  /** 只读窥视（不加锁）：给每分钟 cron 的闸门用，判断「有没有本消费者未确认的事件」。 */
  async function peek(consumerId) {
    if (!CONSUMER_SET.has(consumerId)) return degradedResult(DELTA_LEDGER_DEGRADED.CORRUPT, `unknown_consumer:${consumerId}`);
    const loaded = await loadLedgerFile(statePath);
    if (loaded.status === 'missing') return { ok: true, empty: true, initialized: false, pending: 0, cursor: 0, gap: false };
    if (loaded.status !== 'ok') return degradedOfLoad(loaded);
    const state = loaded.state;
    const entry = state.consumers[consumerId] || null;
    const cursor = entry?.cursor ?? state.nextSeq - 1;
    return {
      ok: true,
      empty: false,
      initialized: entry !== null,
      pending: state.events.filter((event) => event.seq > cursor).length,
      cursor,
      gap: entry !== null && cursor < state.lostSeq,
    };
  }

  /** 只读状态：只含计数/游标，不含事件载荷与基线内容（不得进入模型上下文/QQ）。 */
  async function status() {
    const loaded = await loadLedgerFile(statePath);
    if (loaded.status === 'missing') {
      return { ok: true, empty: true, schemaVersion: DELTA_LEDGER_SCHEMA_VERSION, events: 0, nextSeq: 1, lostSeq: 0, consumers: consumerEntries(emptyLedgerState(now())) };
    }
    if (loaded.status !== 'ok') return degradedOfLoad(loaded);
    const state = loaded.state;
    return {
      ok: true,
      empty: false,
      schemaVersion: state.schemaVersion,
      updatedAt: state.updatedAt,
      events: state.events.length,
      nextSeq: state.nextSeq,
      lostSeq: state.lostSeq,
      baselinePresent: state.baseline !== null,
      baselineAsOf: state.baseline?.payload?.asOf ?? null,
      baselineFields: state.baseline ? Object.keys(state.baseline.payload.inventory || {}).sort() : [],
      consumers: consumerEntries(state),
    };
  }

  return { statePath, ingest, read, ack, peek, status };
}
