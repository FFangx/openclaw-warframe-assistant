// Gateway 愿望单单例 WebSocket 健康状态机（整改 R4）。
//
// 把 extension/index.ts 里 gateway_start 拥有的单例 WebSocket 生命周期抽成
// 纯状态机：连接/断线/重连/健康、恢复后一次扫描与 20～30 秒 REST 保护轮询
// 全部由注入的副作用驱动，可以零网络、零 QQ、零真实账本地做故障注入测试。
//
// 设计契约（不要回退）：
// - 状态至少四态：not-connected（未连接）→ connecting（连接中）→
//   healthy（健康）→ unhealthy（断线/不健康）→ connecting ……
// - 记录断线起点 disconnectedSince、最近活动 lastActivityAt（连接成功与
//   收到任何消息都会刷新）与恢复 lastDisconnectedAt/lastRecoveredAt，
//   以及 disconnectCount/reconnectCount 计次。
// - 恢复扫描：只有「曾经健康 → 断线/不健康 → 重新连接成功」才触发一次
//   recoveryScan()；初次成功连接不扫；同一恢复周期内扫描为单飞（已排队或
//   进行中时不再触发），连接抖动不会并发重复；扫描失败留 lastError 等
//   下一次恢复周期重试。
// - 保护轮询（第二切片）：连接已断/构造失败（disconnectedSince 非空）或
//   连接健康但事件流超过 staleAfterMs 无任何消息时进入保护模式，按
//   [protectionMinMs, protectionMaxMs] 抖动间隔（默认 20～30 秒，jitter
//   注入、测试确定性）执行 protectionScan()（与恢复扫描共用同一单飞执行槽，
//   扫描插槽有占用时轮询跳过、恢复扫描在「真恢复」时仍是即时响应）；
//   连接恢复且事件流新鲜（任一消息刷新 lastActivityAt）即退出保护并取消
//   轮询定时器。无活跃愿望（索引空）视为主动关闭，不进入保护、不扫描。
//   首次保护扫描同样等一个抖动间隔：断线后重连通常由退避在 1～60 秒内完成，
//   保护轮询与恢复扫描不在同一点叠加打 Market（避免断线/恢复突发）。
// - 指标：metricsSink 收到脱敏事件（disconnect/recover 含断线时长/
//   protection-enter/protection-exit/scan），不含任何 target/order/标识。
// - 本模块零网络、零凭据、零账号访问、不引用 QQ adapter：WebSocket 构造、
//   时钟、定时器、账本索引加载、新订单处理、恢复扫描与保护扫描全部由
//   调用方注入。
// - 连接/重连决策只看注入的 itemIds 集合（loadItemIds 每次重读账本）；
//   itemIds 清空时为「主动关闭」，不算断线，不进入 unhealthy、不触发扫描。

export const GATEWAY_STATE = Object.freeze({
  NOT_CONNECTED: 'not-connected',
  CONNECTING: 'connecting',
  HEALTHY: 'healthy',
  UNHEALTHY: 'unhealthy',
});

function defaultTimers() {
  return {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id),
  };
}

/**
 * 创建单例愿望 WebSocket 健康状态机。
 *
 * @param {object} [options]
 * @param {string} [options.wsUrl] Market WebSocket 地址
 * @param {string} [options.wsProtocol] 子协议（'wfm'）
 * @param {string} [options.newOrderRoute] 新订单事件 route（其余消息只刷新
 *   lastActivityAt，不进入订单队列）
 * @param {Function} [options.WebSocketImpl] WebSocket 构造器（默认全局）
 * @param {Function} [options.loadItemIds] async () => Set<string> 活跃 itemId
 *   索引（每次刷新重读本地账本）
 * @param {Function} [options.onOpen] (socket) => void 连接成功后回调（生产用它
 *   发送订阅帧）
 * @param {Function} [options.onOrder] async (order, activityAtIso) => void 相关
 *   新订单回调（生产走 R3 Outbox 链）；串行排队且单条失败不阻断后续
 * @param {Function} [options.recoveryScan] async () => void 恢复扫描（生产复用
 *   REST 校准 + Outbox + 去重链）；单飞，同一恢复周期至多一次
 * @param {Function} [options.protectionScan] async () => void 保护轮询扫描
 *   （生产与恢复扫描共用同一合并 REST 编排）；与恢复扫描共享单飞执行槽
 * @param {Function} [options.now] () => number 时钟注入（毫秒）
 * @param {object} [options.timers] { setTimeout, clearTimeout, setInterval,
 *   clearInterval } 定时器注入（测试）
 * @param {object} [options.logger] { warn?, error?, info? }
 * @param {Function} [options.metricsSink] (event) => void 脱敏指标事件（测试
 *   注入收集器；内容只有时间/时长/计数/类别，无任何标识）
 * @param {number} [options.staleAfterMs] 事件流不新鲜阈值（默认 5 分钟；
 *   连接健康但超过该时长无任何消息 → 保护轮询）
 * @param {number} [options.protectionMinMs] 保护轮询间隔下限（默认 20_000）
 * @param {number} [options.protectionMaxMs] 保护轮询间隔上限（默认 30_000）
 * @param {Function} [options.jitter] () => number 抖动（默认 Math.random，
 *   取 [0,1]；测试注入固定值验证 20～30 秒界限）
 * @param {number} [options.reconnectBaseMs] 断线重连初始退避（默认 1000）
 * @param {number} [options.reconnectMaxMs] 断线重连退避上限（默认 60_000）
 * @param {number} [options.refreshIntervalMs] 账本索引刷新间隔（默认 30_000，
 *   仅刷新内存索引/连接意愿 + 保护阈值评估，不是断线保护轮询本身）
 */
export function createWishlistGateway(options = {}) {
  const {
    wsUrl = 'wss://ws.warframe.market/socket',
    wsProtocol = 'wfm',
    newOrderRoute = '@wfm|event/subscriptions/newOrder',
    WebSocketImpl,
    loadItemIds = async () => new Set(),
    onOpen = null,
    onOrder = null,
    recoveryScan = async () => {},
    protectionScan = null,
    now = () => Date.now(),
    timers,
    logger = {},
    metricsSink = null,
    staleAfterMs = 5 * 60_000,
    protectionMinMs = 20_000,
    protectionMaxMs = 30_000,
    jitter = Math.random,
    reconnectBaseMs = 1000,
    reconnectMaxMs = 60_000,
    refreshIntervalMs = 30_000,
  } = options;
  const timersImpl = timers || defaultTimers();
  const asIso = (ms) => new Date(ms).toISOString();
  const staleWindowMs = Number.isFinite(staleAfterMs) && staleAfterMs >= 0 ? staleAfterMs : 5 * 60_000;
  const pollMinMs = Math.max(0, Number.isFinite(protectionMinMs) ? protectionMinMs : 20_000);
  const pollMaxMs = Math.max(pollMinMs, Number.isFinite(protectionMaxMs) ? protectionMaxMs : 30_000);
  const jitterValue = () => {
    const value = Number(jitter());
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  };

  const state = {
    stopped: true,
    health: GATEWAY_STATE.NOT_CONNECTED,
    socket: null,
    itemIds: new Set(),
    refreshTimer: null,
    reconnectTimer: null,
    protectionTimer: null,
    reconnectMs: reconnectBaseMs,
    reconnectCount: 0,
    disconnectCount: 0,
    connectedAt: null,
    disconnectedSince: null,
    lastDisconnectedAt: null,
    lastActivityAt: null,
    lastRecoveredAt: null,
    pendingRecovery: false,
    intentionalClose: false,
    liveQueue: Promise.resolve(),
    recoveryScan: {
      running: false,
      lastStartedAt: null,
      lastCompletedAt: null,
      lastError: null,
      lastResult: null,
    },
    protection: {
      mode: 'live', // 'live' | 'protection'
      enteredAt: null,
      polls: 0,
      skippedInflight: 0,
      lastPollAt: null,
      lastScanStartedAt: null,
      lastScanCompletedAt: null,
      lastScanError: null,
    },
  };
  let scanPromise = null;

  function scheduleReconnect() {
    if (state.stopped || !state.itemIds.size || state.reconnectTimer) return;
    const wait = state.reconnectMs;
    state.reconnectMs = Math.min(reconnectMaxMs, state.reconnectMs * 2);
    state.reconnectTimer = timersImpl.setTimeout(() => {
      state.reconnectTimer = null;
      state.reconnectCount += 1;
      connect();
    }, wait);
  }

  function emitMetrics(event) {
    if (typeof metricsSink !== 'function') return;
    try {
      const output = metricsSink(event);
      if (output && typeof output.catch === 'function') {
        output.catch((error) => logger.warn?.(`Warframe wishlist metrics sink failed: ${String(error)}`));
      }
    } catch (error) {
      logger.warn?.(`Warframe wishlist metrics sink failed: ${String(error)}`);
    }
  }

  function lastActivityMs() {
    const value = state.lastActivityAt ? Date.parse(state.lastActivityAt) : NaN;
    return Number.isFinite(value) ? value : null;
  }

  // 事件流不新鲜：健康连接但超过 staleAfterMs 没有任何消息帧。
  // 未连接/连接中尚未成功 open 时由 disconnectedSince / 构造失败路径兜底。
  function isStale() {
    const activity = lastActivityMs();
    if (activity == null) return false;
    return now() - activity > staleWindowMs;
  }

  // 进入保护的两个条件：连接已断/构造失败（disconnectedSince 非空），或
  // 连接健康但事件流静止超过阈值。无活跃愿望视为主动关闭，永不进入保护。
  function shouldProtect() {
    if (state.stopped || !state.itemIds.size) return false;
    if (state.disconnectedSince != null) return true;
    return isStale();
  }

  // 恢复扫描与保护轮询共用同一个单飞执行槽（scanPromise）：连接抖动时
  // 正在进行的扫描不会被并发重复；保护轮询与恢复扫描也不会同时打 Market。
  function triggerScan(callback, scope) {
    if (state.stopped || typeof callback !== 'function') return;
    if (scanPromise) return; // 已排队/进行中：禁止并发重复扫描
    const startedAt = now();
    const startIso = asIso(startedAt);
    if (scope === 'recovery') {
      state.recoveryScan.running = true;
      state.recoveryScan.lastStartedAt = startIso;
    } else {
      state.protection.lastScanStartedAt = startIso;
    }
    scanPromise = Promise.resolve()
      .then(() => callback())
      .then((result) => {
        const endAt = now();
        const completedAt = asIso(endAt);
        if (scope === 'recovery') {
          state.recoveryScan.lastCompletedAt = completedAt;
          state.recoveryScan.lastResult = result;
          state.recoveryScan.lastError = null;
        } else {
          state.protection.lastScanCompletedAt = completedAt;
          state.protection.lastScanError = null;
        }
        const summary = result && typeof result === 'object' ? {
          ok: result.ok === true,
          groups: Number(result.groups) || 0,
          fetched: Number(result.fetched) || 0,
          failedGroups: Number(result.failedGroups) || 0,
        } : null;
        emitMetrics({ type: 'scan', scope, at: completedAt, durationMs: endAt - startedAt, ok: summary?.ok ?? true, summary });
      })
      .catch((error) => {
        const endAt = now();
        const failedAt = asIso(endAt);
        const message = String(error?.message || error);
        if (scope === 'recovery') {
          state.recoveryScan.lastError = message;
        } else {
          state.protection.lastScanError = message;
        }
        logger.warn?.(`Warframe wishlist ${scope} scan failed: ${message}`);
        const sourceSummary = error?.scanSummary;
        const summary = sourceSummary && typeof sourceSummary === 'object' ? {
          ok: false,
          groups: Number(sourceSummary.groups) || 0,
          fetched: Number(sourceSummary.fetched) || 0,
          failedGroups: Number(sourceSummary.failedGroups) || 0,
        } : null;
        emitMetrics({ type: 'scan', scope, at: failedAt, durationMs: endAt - startedAt, ok: false, error: message, summary });
      })
      .finally(() => {
        if (scope === 'recovery') state.recoveryScan.running = false;
        scanPromise = null;
      });
  }

  function triggerRecoveryScan() {
    triggerScan(recoveryScan, 'recovery');
  }

  // 保护轮询扫描：只在实际保护模式下执行；与恢复扫描共享单飞槽。
  function runProtectionScan() {
    if (state.stopped || state.protection.mode !== 'protection') return;
    state.protection.polls += 1;
    state.protection.lastPollAt = asIso(now());
    if (scanPromise) {
      state.protection.skippedInflight += 1;
      return;
    }
    triggerScan(protectionScan, 'protection');
  }

  function scheduleProtectionPoll() {
    if (state.stopped || state.protection.mode !== 'protection' || state.protectionTimer != null) return;
    const wait = Math.round(pollMinMs + jitterValue() * (pollMaxMs - pollMinMs));
    state.protectionTimer = timersImpl.setTimeout(() => {
      state.protectionTimer = null;
      if (state.stopped || state.protection.mode !== 'protection') return;
      runProtectionScan();
      scheduleProtectionPoll();
    }, wait);
  }

  function enterProtection() {
    state.protection.mode = 'protection';
    state.protection.enteredAt = asIso(now());
    emitMetrics({ type: 'protection-enter', at: state.protection.enteredAt });
    logger.info?.(`Warframe wishlist gateway entered protection polling at ${state.protection.enteredAt}`);
    // 首次扫描也等到 20～30 秒抖动间隔：断线后重连通常在 1～60 秒后退避内完成，
    // 恢复扫描才是对「真恢复」的即时响应；保护轮询负责断线窗口的持续覆盖，
    // 避免断线/重连/轮询三者在恢复瞬间叠加打 Market（需求 3：避免突发）。
    scheduleProtectionPoll();
  }

  function exitProtection() {
    if (state.protection.mode !== 'protection') return;
    state.protection.mode = 'live';
    state.protection.enteredAt = null;
    if (state.protectionTimer != null) {
      timersImpl.clearTimeout(state.protectionTimer);
      state.protectionTimer = null;
    }
    emitMetrics({ type: 'protection-exit', at: asIso(now()) });
    logger.info?.('Warframe wishlist gateway left protection polling (health restored)');
  }

  // 连接/断线/任意消息/索引刷新/启动后都调用：决定是否进入或退出保护轮询。
  function evaluateProtection() {
    if (state.stopped) return;
    if (shouldProtect()) {
      if (state.protection.mode !== 'protection') enterProtection();
    } else if (state.protection.mode === 'protection') {
      exitProtection();
    }
  }

  function connect() {
    if (state.stopped || !state.itemIds.size || state.socket) return;
    const Ctor = typeof WebSocketImpl === 'function' ? WebSocketImpl : globalThis.WebSocket;
    let socket;
    state.health = GATEWAY_STATE.CONNECTING;
    try {
      if (typeof Ctor !== 'function') throw new Error('Node WebSocket is missing');
      socket = new Ctor(wsUrl, wsProtocol);
    } catch (error) {
      if (state.stopped) return;
      if (state.disconnectedSince == null) state.disconnectedSince = asIso(now());
      state.health = GATEWAY_STATE.UNHEALTHY;
      logger.warn?.(`Warframe wishlist gateway connect failed: ${String(error?.message || error)}`);
      scheduleReconnect();
      evaluateProtection();
      return;
    }
    state.socket = socket;
    socket.onopen = () => handleOpen(socket);
    socket.onmessage = (event) => void handleMessage(socket, event);
    socket.onerror = () => { try { socket.close(); } catch { /* ignore */ } };
    socket.onclose = () => handleClose(socket);
  }

  function handleOpen(socket) {
    if (state.stopped || state.socket !== socket) return;
    // 某些实现/测试桩可能对同一 socket 重复派发 open；已经健康时必须幂等，
    // 既不重复订阅，也不改写恢复时间，更不能重复触发恢复扫描。
    if (state.health === GATEWAY_STATE.HEALTHY) return;
    const recovered = state.pendingRecovery;
    state.pendingRecovery = false;
    state.reconnectMs = reconnectBaseMs;
    state.connectedAt = asIso(now());
    state.lastActivityAt = state.connectedAt;
    if (state.disconnectedSince != null) {
      state.lastDisconnectedAt = state.disconnectedSince;
      state.lastRecoveredAt = state.connectedAt;
      const durationMs = Math.max(0, now() - Date.parse(state.disconnectedSince));
      state.disconnectedSince = null;
      emitMetrics({ type: 'recover', at: state.connectedAt, durationMs, disconnectedSince: state.lastDisconnectedAt });
    }
    state.health = GATEWAY_STATE.HEALTHY;
    // 连接恢复且事件流随 lastActivityAt 变新鲜：退出保护轮询（不取消下面
    // 即将触发的恢复扫描——那是「恢复后恰好一次」的独立职责）。
    evaluateProtection();
    try {
      if (typeof onOpen === 'function') onOpen(socket);
    } catch (error) {
      logger.warn?.(`Warframe wishlist gateway onOpen failed: ${String(error?.message || error)}`);
    }
    // 只有「曾经健康 → 断线 → 重新连接成功」才触发恢复扫描。
    // 初次成功连接、同一 socket 的重复 open 事件都不会再触发。
    if (recovered) {
      logger.info?.(`Warframe wishlist gateway recovered at ${state.connectedAt}; one recovery scan scheduled`);
      triggerRecoveryScan();
    }
  }

  function handleClose(socket) {
    if (state.socket !== socket) return;
    state.socket = null;
    const intentional = state.intentionalClose;
    state.intentionalClose = false;
    if (state.stopped || intentional) {
      state.health = GATEWAY_STATE.NOT_CONNECTED;
      evaluateProtection();
      return;
    }
    if (state.health === GATEWAY_STATE.HEALTHY) state.pendingRecovery = true;
    if (state.disconnectedSince == null) state.disconnectedSince = asIso(now());
    state.disconnectCount += 1;
    state.health = GATEWAY_STATE.UNHEALTHY;
    logger.info?.(`Warframe wishlist gateway disconnected (since ${state.disconnectedSince}, count ${state.disconnectCount})`);
    emitMetrics({ type: 'disconnect', at: state.disconnectedSince, count: state.disconnectCount });
    scheduleReconnect();
    evaluateProtection();
  }

  function handleMessage(socket, event) {
    if (state.socket !== socket) return;
    // 任何到达当前连接的帧都证明事件流仍有活动；即使载荷畸形，也先记录
    // 活跃时间，再安全丢弃不能解析的内容。
    state.lastActivityAt = asIso(now());
    evaluateProtection();
    let payload;
    try {
      payload = JSON.parse(String(event?.data ?? ''));
    } catch {
      return;
    }
    if (payload?.route !== newOrderRoute) return;
    const order = payload.payload || payload.order || payload;
    const itemId = String(order?.itemId || order?.item?.id || '').trim();
    if (!itemId || !state.itemIds.has(itemId)) return;
    state.liveQueue = state.liveQueue
      .then(() => (typeof onOrder === 'function' ? onOrder(order, state.lastActivityAt) : Promise.resolve()))
      .catch((error) => logger.error?.(`Warframe wishlist live order failed: ${String(error)}`));
  }

  async function refresh() {
    if (state.stopped) return;
    let ids;
    try {
      ids = await loadItemIds();
    } catch (error) {
      logger.warn?.(`Warframe wishlist gateway ledger refresh failed: ${String(error)}`);
      return;
    }
    const list = ids instanceof Set ? [...ids] : Array.isArray(ids) ? ids : [];
    state.itemIds = new Set(list.map((id) => String(id).trim()).filter(Boolean));
    if (!state.itemIds.size && state.socket) {
      // 索引清空 = 主动关闭订阅；不算断线，不进入 unhealthy、不触发扫描
      state.intentionalClose = true;
      try {
        state.socket.close();
      } catch { /* ignore */ }
    } else if (state.itemIds.size && !state.socket && !state.reconnectTimer) {
      connect();
    }
    // 每次索引刷新重估保护模式：清空索引即退出保护；长时间停滞则由 30 秒
    // 刷新节拍兜底评估（无需对每个消息帧做额外定时）。
    evaluateProtection();
  }

  async function start() {
    if (!state.stopped) return status();
    state.stopped = false;
    await refresh();
    if (state.refreshTimer == null) {
      state.refreshTimer = timersImpl.setInterval(() => { void refresh(); }, refreshIntervalMs);
    }
    return status();
  }

  function stop() {
    if (state.stopped) return;
    state.stopped = true;
    if (state.refreshTimer != null) {
      timersImpl.clearInterval(state.refreshTimer);
      state.refreshTimer = null;
    }
    if (state.reconnectTimer != null) {
      timersImpl.clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    if (state.protectionTimer != null) {
      timersImpl.clearTimeout(state.protectionTimer);
      state.protectionTimer = null;
    }
    state.protection.mode = 'live';
    state.protection.enteredAt = null;
    state.disconnectedSince = null;
    const socket = state.socket;
    state.socket = null;
    state.pendingRecovery = false;
    state.intentionalClose = false;
    state.health = GATEWAY_STATE.NOT_CONNECTED;
    try { socket?.close?.(); } catch { /* ignore */ }
  }

  function status() {
    return {
      stopped: state.stopped,
      health: state.health,
      socketOpen: Boolean(state.socket),
      itemCount: state.itemIds.size,
      connectedAt: state.connectedAt,
      disconnectedSince: state.disconnectedSince,
      lastDisconnectedAt: state.lastDisconnectedAt,
      lastActivityAt: state.lastActivityAt,
      lastRecoveredAt: state.lastRecoveredAt,
      disconnectCount: state.disconnectCount,
      reconnectCount: state.reconnectCount,
      reconnectMs: state.reconnectMs,
      recoveryScan: { ...state.recoveryScan },
      protection: { ...state.protection },
      staleAfterMs: staleWindowMs,
      protectionMinMs: pollMinMs,
      protectionMaxMs: pollMaxMs,
    };
  }

  return { start, stop, refresh, status };
}
