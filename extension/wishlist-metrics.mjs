// R4 愿望实时监控审计指标（第二切片）。
//
// 只记时间/时长/计数/类别，**永不写 target、order、wish、seller、QQ 标识**：
// API 只接受脱敏事件（at/durationMs/latencyMs/ok/类别），错误先经
// classifyMarketError 归类为固定类别（原始错误文本可能含 URL 或端点名，不落盘）。
//
// 独立于愿望账本与 Outbox（不改变任何用户状态语义）：单独文件
// `state/warframe-wishlist-metrics.json`，原子写、有界窗口、跨实例可读。
// 覆盖：断线时长（recover 时记录）、订单发现延迟（REST/WS 命中入队 - 上游订单时间）、
// QQ 投递延迟（Outbox 入队 → delivered）、扫描/保护计数与 Market 可用性诚实状态。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const METRICS_SCHEMA_VERSION = 1;
const MAX_RECENT = 50;

/** 把 Market/网络错误归类为脱敏类别（消息可能含端点/URL，绝不原文记录）。 */
export function classifyMarketError(error) {
  const message = String(error?.message || error || '');
  const status = message.match(/HTTP\s*(\d{3})/u);
  if (status) {
    const code = Number(status[1]);
    if (code === 429) return 'http_429';
    if (code >= 500) return 'http_5xx';
    return `http_${code}`;
  }
  if (/(?:timeout|timed out|abort(?:ed)?)/iu.test(message)) return 'network_timeout';
  if (/(?:ECONN|socket|fetch|network|ENOTFOUND|EAI_AGAIN|unavailable)/iu.test(message)) return 'network';
  if (/(?:JSON|parse|unexpected end|Unexpected token)/iu.test(message)) return 'bad_response';
  return 'unknown';
}

function emptyStore() {
  return {
    schemaVersion: METRICS_SCHEMA_VERSION,
    updatedAt: null,
    disconnect: { count: 0, totalMs: 0, maxMs: 0, lastMs: null },
    discovery: { count: 0, totalMs: 0, maxMs: 0, lastMs: null, unknownSource: 0 },
    delivery: { count: 0, totalMs: 0, maxMs: 0, lastMs: null },
    protection: { entries: 0, exits: 0 },
    scans: { count: 0, failed: 0, lastOk: null, lastErrorCategory: null, lastRunAt: null, lastDurationMs: null, lastFailedGroups: 0 },
    market: { available: null, since: null, lastErrorCategory: null, consecutiveFailures: 0 },
    recent: [],
  };
}

function pushRecent(store, event) {
  store.recent.push(event);
  if (store.recent.length > MAX_RECENT) store.recent.splice(0, store.recent.length - MAX_RECENT);
}

export function createWishlistMetrics(options = {}) {
  const filePath = options.filePath ? path.resolve(String(options.filePath)) : null;
  const memory = options.memory === true;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  let store = null;
  let queue = Promise.resolve();
  const serialized = (operation) => {
    const run = queue.then(operation, operation);
    queue = run.then(() => undefined, () => undefined);
    return run;
  };

  async function load() {
    if (store) return store;
    if (memory || !filePath) { store = emptyStore(); return store; }
    let raw;
    try {
      raw = JSON.parse(await readFile(filePath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') { store = emptyStore(); return store; }
      throw new Error(`愿望监控指标文件损坏（${filePath}）：${String(error?.message || error)}`);
    }
    store = { ...emptyStore(), ...(raw && typeof raw === 'object' ? raw : {}) };
    return store;
  }

  async function persist() {
    store.updatedAt = new Date(now()).toISOString();
    if (memory || !filePath) return;
    await mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(store)}\n`, 'utf8');
    await rename(tempPath, filePath);
  }

  const mutate = (fn) => serialized(async () => {
    await load();
    fn(store);
    await persist();
    return snapshotSync();
  });

  function snapshotSync() {
    return JSON.parse(JSON.stringify(store));
  }

  function recordDisconnected({ at } = {}) {
    return mutate((s) => {
      s.disconnect.count += 1;
      pushRecent(s, { type: 'disconnect', at: at ? String(at) : new Date(now()).toISOString() });
    });
  }

  function recordRecovered({ at, durationMs } = {}) {
    return mutate((s) => {
      const ms = Number(durationMs) || 0;
      s.disconnect.totalMs += ms;
      s.disconnect.maxMs = Math.max(s.disconnect.maxMs, ms);
      s.disconnect.lastMs = ms;
      pushRecent(s, { type: 'disconnect_duration', at: at ? String(at) : new Date(now()).toISOString(), durationMs: ms });
    });
  }

  function recordDiscovery({ at, latencyMs, sourceKnown = true } = {}) {
    return mutate((s) => {
      const numeric = latencyMs == null ? NaN : Number(latencyMs);
      const ms = Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
      s.discovery.count += 1;
      if (ms != null) {
        s.discovery.totalMs += ms;
        s.discovery.maxMs = Math.max(s.discovery.maxMs, ms);
        s.discovery.lastMs = ms;
      } else if (sourceKnown === false) {
        s.discovery.unknownSource += 1;
      }
      pushRecent(s, {
        type: 'discovery_latency',
        at: at ? String(at) : new Date(now()).toISOString(),
        latencyMs: ms,
        sourceKnown: sourceKnown === true,
      });
    });
  }

  function recordDelivery({ at, latencyMs } = {}) {
    return mutate((s) => {
      const numeric = latencyMs == null ? NaN : Number(latencyMs);
      const ms = Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
      if (ms == null) return;
      s.delivery.count += 1;
      s.delivery.totalMs += ms;
      s.delivery.maxMs = Math.max(s.delivery.maxMs, ms);
      s.delivery.lastMs = ms;
      pushRecent(s, { type: 'delivery_latency', at: at ? String(at) : new Date(now()).toISOString(), latencyMs: ms });
    });
  }

  function recordProtectionEvent(kind, at) {
    return mutate((s) => {
      if (kind === 'protection-enter') s.protection.entries += 1;
      else if (kind === 'protection-exit') s.protection.exits += 1;
      pushRecent(s, { type: String(kind), at: at ? String(at) : new Date(now()).toISOString() });
    });
  }

  /**
   * 记录一次扫描结果并更新 Market 可用性（诚实：全组失败才是完全不可用，
   * 部分失败保持 available 但记下失败类别）。
   * @param {{at?, ok, durationMs?, groups?, fetched?, failedGroups?, error?, scope?}} input
   */
  function recordScan(input = {}) {
    return mutate((s) => {
      const at = input.at ? String(input.at) : new Date(now()).toISOString();
      const ok = Boolean(input.ok);
      const failedGroups = Number(input.failedGroups) || 0;
      const groups = Number(input.groups) || 0;
      const category = input.error ? classifyMarketError(input.error) : null;
      s.scans.count += 1;
      if (!ok) s.scans.failed += 1;
      s.scans.lastOk = ok;
      s.scans.lastRunAt = at;
      s.scans.lastDurationMs = Number.isFinite(Number(input.durationMs)) ? Number(input.durationMs) : null;
      s.scans.lastFailedGroups = failedGroups;
      if (category) s.scans.lastErrorCategory = category;
      // Market 完全不可用：有组且全组失败；否则视为可用（部分失败也如实记录）
      if (groups > 0 && failedGroups >= groups) {
        s.market.available = false;
        s.market.since = at;
        s.market.lastErrorCategory = category || 'unknown';
        s.market.consecutiveFailures += 1;
      } else if (groups > 0) {
        s.market.available = true;
        s.market.since = at;
        s.market.consecutiveFailures = 0;
      }
      pushRecent(s, {
        type: 'scan',
        at,
        ok,
        scope: String(input.scope || ''),
        durationMs: s.scans.lastDurationMs,
        failedGroups,
        errorCategory: category,
      });
    });
  }

  function markMarketUnavailable({ at, error } = {}) {
    return mutate((s) => {
      const stamp = at ? String(at) : new Date(now()).toISOString();
      s.market.available = false;
      s.market.since = stamp;
      s.market.lastErrorCategory = error ? classifyMarketError(error) : 'unknown';
      s.market.consecutiveFailures += 1;
      pushRecent(s, { type: 'market_unavailable', at: stamp, errorCategory: s.market.lastErrorCategory });
    });
  }

  async function snapshot() {
    return serialized(async () => { await load(); return snapshotSync(); });
  }

  return {
    filePath,
    recordDisconnected,
    recordRecovered,
    recordDiscovery,
    recordDelivery,
    recordProtectionEvent,
    recordScan,
    markMarketUnavailable,
    snapshot,
  };
}
