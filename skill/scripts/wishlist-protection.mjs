// R4 愿望单断线保护第二切片：全局 REST 保护工作原语。
//
// 本模块零网络、零 QQ、零真实账本/Outbox：只提供可注入、可确定性测试的
// 「全局合并 + 令牌桶 + 并发上限」编排——
// - groupActiveWishes / wishFetchGroupKey：按 itemId+rank/满级/任意档（与
//   wishlist.mjs fetchTopOrdersForWishes 的分组口径一致）把多用户/多 target
//   的活跃愿望合并成「每个市场请求只发一次」的组。
// - createTokenBucket：全局令牌桶（默认容量 1、每 400ms 补 1，保持请求起点
//   至少相隔 400ms，低于 Market 公开 3 req/s 上限）。consume() 在无令牌时阻塞排到补桶定时器——注入时钟/定时器后
//   测试可精确推进；绝不用「跳过这次」牺牲数据新鲜度。
// - createConcurrencyGate：全局并发上限（默认 2 个同时进行的 Market 请求）。
// - runCoalescedWishlistScan：恢复扫描与保护轮询共用的编排：先按组去重取单
//   份订单（每组一个 HTTP），再逐 target 交给注入的 monitorTarget 复用现有
//   per-target 匹配 + R3 Outbox 原子入队/账本提交链（与 10 分钟校准 cron、
//   实时 WS 命中共享业务键去重，语义不变）。全组失败时 monitorTarget 收到
//   allFailed=true，让调用方走「如实记 restError、不写新鲜 calibration」的
//   诚实降级；返回 marketAvailable 供 Gateway/指标如实报告 Market 整体不可用。

function defaultTimers() {
  return {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  };
}

/**
 * 愿望→全局合并组键。itemId 是 Gateway 内存索引与愿望的唯一商品键；
 * rankMode/rank/maxRank 决定订单过滤与 /top?rank= 请求参数，同档才算重复。
 */
export function wishFetchGroupKey(wish) {
  const itemId = String(wish?.itemId || '').trim();
  if (!itemId) return null;
  const rankMode = String(wish?.rankMode || 'any').trim();
  const rank = wish?.rank == null || wish?.rank === '' ? '' : String(Number(wish.rank));
  const maxRank = wish?.maxRank == null ? '' : String(Number(wish.maxRank));
  return `${itemId}|${rankMode}|${rank}|${maxRank}`;
}

/** 把活跃愿望按 (itemId, rank) 组键合并；返回 [{ key, wish, wishes }]（保持首次出现顺序）。 */
export function groupActiveWishes(wishes = []) {
  const byKey = new Map();
  for (const wish of wishes || []) {
    const key = wishFetchGroupKey(wish);
    if (!key || !String(wish?.slug || '').trim()) continue;
    if (!byKey.has(key)) byKey.set(key, { key, wish, wishes: [] });
    byKey.get(key).wishes.push(wish);
  }
  return [...byKey.values()];
}

/**
 * 全局令牌桶。consume() 立即消耗一个令牌；无令牌时挂起直到注入的定时器
 * 推进补桶（测试用假定时器精确驱动，生产用真实 setTimeout）。
 *
 * @param {object} [options]
 * @param {number} [options.capacity] 桶容量（默认 1，不允许启动瞬时突发）
 * @param {number} [options.refillMs] 每 refillMs 补一个令牌（默认 400）
 * @param {() => number} [options.now] 时钟（毫秒）
 * @param {object} [options.timers] { setTimeout, clearTimeout }（测试注入）
 */
export function createTokenBucket(options = {}) {
  const capacity = Math.max(1, Number.isFinite(options.capacity) ? Math.floor(options.capacity) : 1);
  const refillMs = Math.max(1, Number.isFinite(options.refillMs) ? Math.floor(options.refillMs) : 400);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const timers = options.timers || defaultTimers();
  let tokens = capacity;
  let lastRefillAt = now();
  let refillTimer = null;
  const waiters = [];

  function refill() {
    const current = now();
    const elapsed = current - lastRefillAt;
    if (elapsed >= refillMs) {
      tokens = Math.min(capacity, tokens + Math.floor(elapsed / refillMs));
      lastRefillAt = current - (elapsed % refillMs);
    }
    return tokens;
  }

  function wake() {
    refill();
    refillTimer = null;
    while (tokens >= 1 && waiters.length) {
      tokens -= 1;
      waiters.shift().resolve();
    }
    if (waiters.length) refillTimer = timers.setTimeout(wake, refillMs);
  }

  /** 取一个令牌；取不到就阻塞排队（由补桶定时器唤醒），绝不静默丢弃扫描工作量。 */
  function consume() {
    refill();
    if (tokens >= 1) {
      tokens -= 1;
      return Promise.resolve();
    }
    if (refillTimer == null) refillTimer = timers.setTimeout(wake, refillMs);
    return new Promise((resolve) => { waiters.push({ resolve }); });
  }

  function status() {
    refill();
    return { tokens, capacity, refillMs, waiting: waiters.length };
  }

  function dispose() {
    if (refillTimer != null) {
      timers.clearTimeout?.(refillTimer);
      refillTimer = null;
    }
  }

  return { consume, status, dispose };
}

/**
 * 全局并发上限：同一时刻最多 limit 个任务在跑，其余 FIFO 排队。
 * 用于保护 REST 请求的并发汇聚（断线/恢复/轮询不瞬时打满 Market）。
 */
export function createConcurrencyGate(options = {}) {
  const limit = Math.max(1, Number.isFinite(options.limit) ? Math.floor(options.limit) : 2);
  let running = 0;
  const queue = [];

  function pump() {
    while (running < limit && queue.length) {
      const task = queue.shift();
      running += 1;
      Promise.resolve()
        .then(() => task.fn())
        .then(
          (value) => { running -= 1; task.resolve(value); pump(); },
          (error) => { running -= 1; task.reject(error); pump(); },
        );
    }
  }

  function run(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      pump();
    });
  }

  function status() {
    return { limit, running, queued: queue.length };
  }

  return { run, status };
}

/**
 * 合并扫描编排（恢复扫描与保护轮询共用）：
 * 1) groupActiveWishes 合并跨 target 的相同 (itemId, rank) 请求；
 * 2) 每组合并一组只发一次：先取全局令牌（防止断线/恢复/轮询突发），再在
 *    全局并发上限内 fetchOne；失败组不阻断其余组（部分失败如实上报）；
 * 3) 逐 target 调 monitorTarget，传「该 target 需要的组的订单」与
 *    allFailed 标记——per-target 匹配、Outbox 幂等、原子入队/账本提交与
 *    10 分钟校准语义全部保持由调用方的 monitorTarget（monitorWishlist）承担。
 *
 * @returns {{ ok, reason?, targets, groups, fetched, failedGroups,
 *   marketAvailable, lastError, results }}
 */
export async function runCoalescedWishlistScan(options = {}) {
  const {
    wishes = [],
    fetchOne,
    tokenBucket,
    concurrency,
    monitorTarget,
    logger = {},
  } = options;
  if (typeof fetchOne !== 'function' || typeof monitorTarget !== 'function') {
    throw new Error('runCoalescedWishlistScan 需要注入 fetchOne 与 monitorTarget');
  }
  const groups = groupActiveWishes(wishes);
  if (!groups.length) {
    return { ok: true, reason: 'no_active_wishes', targets: 0, groups: 0, fetched: 0, failedGroups: 0, marketAvailable: null, lastError: null, results: [] };
  }
  const ordersByKey = new Map();
  const failedKeys = new Set();
  let failedGroups = 0;
  let lastError = null;
  await Promise.all(groups.map(async (group) => {
    try {
      if (tokenBucket) await tokenBucket.consume();
      const orders = concurrency
        ? await concurrency.run(() => fetchOne(group.wish))
        : await fetchOne(group.wish);
      ordersByKey.set(group.key, Array.isArray(orders) ? orders : []);
    } catch (error) {
      failedKeys.add(group.key);
      failedGroups += 1;
      lastError = String(error?.message || error);
      logger.warn?.(`Warframe wishlist protection group fetch failed: ${lastError}`);
    }
  }));
  const marketAvailable = failedGroups === 0 || failedGroups < groups.length;

  const byTarget = new Map();
  for (const wish of wishes) {
    const target = String(wish?.target || '').trim();
    if (!target) continue;
    if (!byTarget.has(target)) byTarget.set(target, []);
    byTarget.get(target).push(wish);
  }
  const results = [];
  let targets = 0;
  let monitorFailures = 0;
  for (const [target, targetWishes] of byTarget) {
    const targetKeys = new Set(targetWishes.map(wishFetchGroupKey).filter(Boolean));
    const allFailed = targetKeys.size > 0 && [...targetKeys].every((key) => !ordersByKey.has(key));
    const targetFailedKeys = [...targetKeys].filter((key) => failedKeys.has(key));
    const orders = [];
    for (const key of targetKeys) {
      if (ordersByKey.has(key)) orders.push(...ordersByKey.get(key));
    }
    let targetResult = null;
    try {
      targetResult = await monitorTarget(target, targetWishes, {
        orders,
        allFailed,
        hasFailures: targetFailedKeys.length > 0,
        failedKeys: targetFailedKeys,
      });
      targets += 1;
    } catch (error) {
      monitorFailures += 1;
      lastError = String(error?.message || error);
      logger.warn?.(`Warframe wishlist protection target monitor failed: ${lastError}`);
    }
    results.push(targetResult);
  }
  const ok = failedGroups === 0 && monitorFailures === 0 && groups.length > 0 && targets > 0;
  return {
    ok,
    targets,
    groups: groups.length,
    fetched: groups.length - failedGroups,
    failedGroups,
    marketAvailable:
      groups.length === 0 ? null : (failedGroups < groups.length ? true : false),
    lastError,
    results,
  };
}
