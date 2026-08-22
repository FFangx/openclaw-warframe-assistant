import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_STATE_DIR = process.env.WARFRAME_DATA_CACHE_DIR
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.cache', 'warframe-data');
const DEFAULT_STATE_FILE = path.join(DEFAULT_STATE_DIR, 'endpoint-health.v1.json');
const fileWriteQueues = new Map();

// 持久化健康状态（endpoint-health.v1.json）字段白名单：
//   当前状态   consecutiveFailures / lastSuccessAt / lastFailureAt / lastCategory / lastStatus / openedAt / openUntil
//   累计遥测   totalFailures / failureCategoryCounts / failureStatusCounts / circuitOpenCount
// 累计遥测在每次最终请求失败时 +1（类别/HTTP 状态分别累计），每次新打开熔断 circuitOpenCount +1；
// 成功恢复只清当前连续失败/开路状态，累计计数保留。旧 v1 文件缺累计字段仍可读（按 0 起步）。
// 绝不记录 URL、响应体、请求头或凭据。

export class EndpointRequestError extends Error {
  constructor(message, diagnostic, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'EndpointRequestError';
    this.diagnostic = diagnostic;
  }
}

export class FileEndpointHealthStore {
  constructor(file = DEFAULT_STATE_FILE) {
    this.file = file;
  }

  async read() {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      return parsed?.version === 1 && parsed.endpoints && typeof parsed.endpoints === 'object'
        ? parsed.endpoints : {};
    } catch {
      return {};
    }
  }

  async write(endpoints) {
    const directory = path.dirname(this.file);
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(this.file, JSON.stringify({ version: 1, updatedAt: Date.now(), endpoints }), 'utf8');
    } catch {
      // Health telemetry must never break a read-only query.
    }
  }

  async writeEndpoint(endpoint, state) {
    const previous = fileWriteQueues.get(this.file) || Promise.resolve();
    const queued = previous.then(async () => {
      const endpoints = await this.read();
      endpoints[endpoint] = state;
      await this.write(endpoints);
    });
    fileWriteQueues.set(this.file, queued.catch(() => {}));
    await queued;
  }
}

export class MemoryEndpointHealthStore {
  constructor(initial = {}) {
    this.endpoints = structuredClone(initial);
  }

  async read() {
    return structuredClone(this.endpoints);
  }

  async write(endpoints) {
    this.endpoints = structuredClone(endpoints);
  }


  async writeEndpoint(endpoint, state) {
    this.endpoints[endpoint] = structuredClone(state);
  }
}

async function writeEndpoint(healthStore, endpoint, state, states) {
  states[endpoint] = state;
  if (typeof healthStore.writeEndpoint === 'function') await healthStore.writeEndpoint(endpoint, state);
  else await healthStore.write(states);
}

function retryAfterMs(response) {
  const raw = response?.headers?.get?.('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function categoryFor(error) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || error?.code === 'ABORT_ERR') return 'timeout';
  if (error instanceof SyntaxError) return 'bad_response';
  return 'network';
}

function retryableCategory(category) {
  return ['timeout', 'network', 'rate_limited', 'server_error', 'bad_response'].includes(category);
}

function cooldownFor({ category, status, consecutiveFailures, retryAfter, baseOpenMs, maxOpenMs, forbiddenOpenMs }) {
  if (status === 403) return forbiddenOpenMs;
  if (category === 'rate_limited' && Number.isFinite(retryAfter)) return Math.min(maxOpenMs, Math.max(baseOpenMs, retryAfter));
  return Math.min(maxOpenMs, baseOpenMs * (2 ** Math.max(0, consecutiveFailures - 1)));
}

export async function resilientJsonRequest(url, options = {}) {
  const {
    endpoint,
    headers = {},
    timeoutMs = 8_000,
    maxAttempts = 2,
    failureThreshold = 2,
    baseOpenMs = 30_000,
    maxOpenMs = 5 * 60_000,
    forbiddenOpenMs = 15 * 60_000,
    fetchImpl = fetch,
    healthStore = new FileEndpointHealthStore(),
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;
  if (!endpoint) throw new Error('resilientJsonRequest requires endpoint');

  const states = await healthStore.read();
  const previous = states[endpoint] || {};
  const currentMs = now();
  if (Number(previous.openUntil) > currentMs) {
    throw new EndpointRequestError(`endpoint circuit open: ${endpoint}`, {
      endpoint, category: 'circuit_open', retryable: true, attempts: 0,
      openedAt: previous.openedAt || null, openUntil: previous.openUntil,
      lastFailureAt: previous.lastFailureAt || null, lastStatus: previous.lastStatus ?? null,
      lastCategory: previous.lastCategory || null,
    });
  }

  let last = null;
  let attemptsUsed = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attemptsUsed = attempt;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: 'application/json', ...headers },
        signal: controller.signal,
      });
      if (!response.ok) {
        const status = response.status;
        if (status === 404) {
          // 确定性否定（数据缺失）：不重试、不计连续失败、不开熔断——
          // 否则一批 Baro 货单里的 404 商品会把整个端点组短路，连累有数据的商品。
          // 仍记累计遥测（totalFailures/404 计数），供 drift-report 诊断。
          const notFound = {
            consecutiveFailures: 0,
            lastSuccessAt: previous.lastSuccessAt || null,
            lastFailureAt: now(),
            lastCategory: 'not_found',
            lastStatus: 404,
            openUntil: null, openedAt: null,
            totalFailures: Number(previous.totalFailures || 0) + 1,
            failureCategoryCounts: {
              ...(previous.failureCategoryCounts || {}),
              not_found: Number(previous.failureCategoryCounts?.not_found || 0) + 1,
            },
            failureStatusCounts: {
              ...(previous.failureStatusCounts || {}),
              '404': Number(previous.failureStatusCounts?.['404'] || 0) + 1,
            },
            circuitOpenCount: Number(previous.circuitOpenCount || 0),
          };
          await writeEndpoint(healthStore, endpoint, notFound, states);
          throw new EndpointRequestError(`endpoint request failed: ${endpoint} (not_found)`, {
            endpoint, category: 'not_found', retryable: false, attempts: 1, status: 404,
          });
        }
        const category = status === 429 ? 'rate_limited' : status >= 500 ? 'server_error' : 'http_error';
        last = { category, status, retryAfter: retryAfterMs(response), cause: null };
      } else {
        try {
          const data = await response.json();
          const healthy = {
            consecutiveFailures: 0, lastSuccessAt: now(), lastFailureAt: previous.lastFailureAt || null,
            lastCategory: null, lastStatus: null, openUntil: null, openedAt: null,
            // 成功恢复：只清当前连续失败/开路状态，累计遥测保留
            totalFailures: Number(previous.totalFailures || 0),
            failureCategoryCounts: { ...(previous.failureCategoryCounts || {}) },
            failureStatusCounts: { ...(previous.failureStatusCounts || {}) },
            circuitOpenCount: Number(previous.circuitOpenCount || 0),
          };
          await writeEndpoint(healthStore, endpoint, healthy, states);
          return data;
        } catch (error) {
          last = { category: 'bad_response', status: response.status, retryAfter: null, cause: error };
        }
      }
    } catch (error) {
      // 404 已在分支内写入健康并定论（not_found），直接上抛，不再按 network 循环
      if (error instanceof EndpointRequestError) throw error;
      last = { category: categoryFor(error), status: null, retryAfter: null, cause: error };
    } finally {
      clearTimeout(timer);
    }

    const canRetry = retryableCategory(last.category) && attempt < maxAttempts;
    if (!canRetry) break;
    const delay = Number.isFinite(last.retryAfter)
      ? Math.min(2_000, Math.max(0, last.retryAfter))
      : 250 * attempt;
    await sleep(delay);
  }

  const failedAt = now();
  const consecutiveFailures = Number(previous.consecutiveFailures || 0) + 1;
  const shouldOpen = last.status === 403 || last.category === 'rate_limited' || consecutiveFailures >= failureThreshold;
  const openMs = shouldOpen ? cooldownFor({
    ...last, consecutiveFailures, baseOpenMs, maxOpenMs, forbiddenOpenMs,
  }) : 0;
  const failureCategoryCounts = { ...(previous.failureCategoryCounts || {}) };
  failureCategoryCounts[last.category] = (failureCategoryCounts[last.category] || 0) + 1;
  const failureStatusCounts = { ...(previous.failureStatusCounts || {}) };
  if (last.status != null) {
    const statusKey = String(last.status);
    failureStatusCounts[statusKey] = (failureStatusCounts[statusKey] || 0) + 1;
  }
  const failed = {
    consecutiveFailures,
    lastSuccessAt: previous.lastSuccessAt || null,
    lastFailureAt: failedAt,
    lastCategory: last.category,
    lastStatus: last.status,
    openedAt: shouldOpen ? failedAt : null,
    openUntil: shouldOpen ? failedAt + openMs : null,
    // 累计遥测：每次最终请求失败 totalFailures/类别/HTTP 状态各 +1；每次新打开熔断 circuitOpenCount +1
    totalFailures: Number(previous.totalFailures || 0) + 1,
    failureCategoryCounts,
    failureStatusCounts,
    circuitOpenCount: Number(previous.circuitOpenCount || 0) + (shouldOpen ? 1 : 0),
  };
  await writeEndpoint(healthStore, endpoint, failed, states);
  throw new EndpointRequestError(`endpoint request failed: ${endpoint} (${last.category})`, {
    endpoint, category: last.category, retryable: retryableCategory(last.category), attempts: attemptsUsed,
    status: last.status, retryAfterMs: last.retryAfter, openedAt: failed.openedAt,
    openUntil: failed.openUntil, lastFailureAt: failedAt,
  }, last.cause);
}

export async function readEndpointHealth(healthStore = new FileEndpointHealthStore()) {
  return healthStore.read();
}
