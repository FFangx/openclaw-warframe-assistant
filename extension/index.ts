import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { commandToolSummary, isPersonalAccountCommand, isShortcut, isSubscriptionCommand, isWeeklyCommand, isWishlistCommand } from './routing.mjs';
import { buildEvidenceEnvelope, STATE_ASSERTION_POLICY } from './evidence.mjs';
import { classifyNaturalWarframeQuery, DYNAMIC_QUERY_POLICY } from './intent-policy.mjs';
import { composePromptContext } from './prompt-context.mjs';
import { createContextBridge } from './context-bridge.mjs';
// R17 第一片：代表链「裂缝 九重天」脱敏 trace（QQ 入口 received/authorization/delivery 三段）。
import { authorizationResultCategory, contentHashOfFile, createQqTraceContext, deliveryResultCategory, isTraceTarget, recordQqTraceStage } from './trace-bridge.mjs';
import { executeSubscriptionUseCase } from './subscription-usecase.mjs';
import { executeWishlistUseCase, wishlistNeedsImmediateInspection } from './wishlist-usecase.mjs';
import { createGatewayWishlistMailer } from './wishlist-gateway-mailer.mjs';
import { createWishlistGateway } from './wishlist-gateway.mjs';
import { createWishlistMetrics } from './wishlist-metrics.mjs';
import { sendMarketKeyboard } from './qq-market-keyboard.mjs';
import { sendWishlistCard } from './qq-wishlist-keyboard.mjs';
import { wishlistInteractions } from './qq-wishlist-interactions.mjs';
import { getMarketCardPreference, parseMarketCardPreferenceCommand, setMarketCardPreference } from './qq-market-card-preferences.mjs';
import { WISHLIST_CARD_PREFERENCE_FILE, getWishlistCardMerged, parseWishlistCardPreferenceCommand, setWishlistCardMerged } from './qq-wishlist-card-preferences.mjs';
import { marketTrendInteractions, QQ_MARKET_INTERACTION_BRIDGE } from './qq-market-trend-interactions.mjs';

const execFileAsync = promisify(execFile);
const pluginDir = path.dirname(fileURLToPath(import.meta.url));
const shortcutScript = path.resolve(pluginDir, '..', '..', '..', 'skills', 'warframe-assistant', 'scripts', 'shortcuts.mjs');
const lookupScript = path.resolve(pluginDir, '..', '..', '..', 'skills', 'warframe-assistant', 'scripts', 'lookup.mjs');
const subscriptionScript = path.resolve(pluginDir, '..', '..', '..', 'skills', 'warframe-assistant', 'scripts', 'subscriptions.mjs');
const wishlistScript = path.resolve(pluginDir, '..', '..', '..', 'skills', 'warframe-assistant', 'scripts', 'wishlist.mjs');
// R4 保护原语（合并分组/令牌桶/并发上限/合并扫描）位于 skill 树：与
// wishlist.mjs 同为受管内容，便于 skill 侧直接做真实 Outbox 集成测试。
const wishlistProtectionScript = path.resolve(pluginDir, '..', '..', '..', 'skills', 'warframe-assistant', 'scripts', 'wishlist-protection.mjs');
const dropsScript = path.resolve(pluginDir, '..', '..', '..', 'skills', 'warframe-assistant', 'scripts', 'drops.mjs');
const weeklyScript = path.resolve(pluginDir, '..', '..', '..', 'skills', 'warframe-assistant', 'scripts', 'weekly.mjs');
const weeklyUsecaseScript = path.resolve(pluginDir, '..', '..', '..', 'skills', 'warframe-assistant', 'scripts', 'weekly-usecase.mjs');
const alecaScript = path.resolve(pluginDir, '..', '..', '..', 'skills', 'warframe-assistant', 'scripts', 'alecaframe.mjs');
const personalUsecaseScript = path.resolve(pluginDir, '..', '..', '..', 'skills', 'warframe-assistant', 'scripts', 'personal-usecase.mjs');
const publicUsecaseScript = path.resolve(pluginDir, '..', '..', '..', 'skills', 'warframe-assistant', 'scripts', 'public-usecase.mjs');
const subscriptionState = path.resolve(pluginDir, '..', '..', '..', 'state', 'warframe-subscriptions.json');
const wishlistState = path.resolve(pluginDir, '..', '..', '..', 'state', 'warframe-wishlist.json');
// 愿望卡总开关（`愿望卡 开/关/状态`）：与愿望账本同目录，键只存账号域+sender 摘要
const wishlistCardPreferenceFile = path.resolve(path.dirname(wishlistState), WISHLIST_CARD_PREFERENCE_FILE);
const dropsState = path.resolve(pluginDir, '..', '..', '..', 'state', 'warframe-drops.json');
const weeklyState = path.resolve(pluginDir, '..', '..', '..', 'state', 'warframe-weekly.json');
// 愿望命中通知与掉落/世界状态/周报共用同一个 R3 通知 Outbox（业务键前缀区分）
const notificationOutboxScript = path.resolve(pluginDir, '..', '..', '..', 'skills', 'warframe-assistant', 'scripts', 'notification-outbox.mjs');
const cardDir = path.resolve(pluginDir, '..', '..', '..', '.cache', 'warframe-cards');
const subscriptionCardDir = path.resolve(pluginDir, '..', '..', '..', 'media', 'qqbot', 'warframe-cards');
// R17 第一片：代表链 trace 仓库（与 skill 侧默认路径一致，容量有界见 skill/scripts/trace.mjs）。
const traceStorePath = path.resolve(pluginDir, '..', '..', '..', '.cache', 'warframe-trace.jsonl');
const QQ_REPLY_TRACE = Symbol('warframe-qq-reply-trace');
const shortCommandContext = createContextBridge();

function contextBridgeKey(event: any = {}, ctx: any = {}): string | null {
  const session = String(ctx.sessionKey || event.sessionKey || ctx.conversationId || event.conversationId || ctx.channelId || ctx.chatId || '').trim().toLowerCase();
  const sender = String(ctx.requesterSenderId || event.senderId || ctx.senderId || ctx.channelContext?.sender?.id || '').trim().toLowerCase();
  const group = Boolean(event.isGroup || agentContextIsGroup(ctx));
  if (!session || (group && !sender)) return null;
  return `${session}|${sender || session}`;
}

function rememberShortCommandContext(event: any, ctx: any, result: any, personalAllowed = false): void {
  const envelope = result?.contextEnvelope;
  if (!envelope || (envelope.scope === 'personal' && !personalAllowed)) return;
  const key = contextBridgeKey(event, ctx);
  if (key) shortCommandContext.remember(key, envelope);
}

function qqTarget(event: { isGroup?: boolean; conversationId?: string; senderId?: string }): string | null {
  // QQ 事件里的 openid 大小写不稳定（实测同一用户出现过大写与小写），全链路统一小写
  const conversationId = String(event.conversationId || '').trim().toLowerCase();
  const senderId = String(event.senderId || '').trim().toLowerCase();
  if (event.isGroup && conversationId) return `qqbot:group:${conversationId}`;
  if (senderId) return `qqbot:c2c:${senderId}`;
  if (conversationId) return `qqbot:c2c:${conversationId}`;
  return null;
}

// 愿望卡图片端口：`sendWishlistCard` 的拆分模式用它补投单张图片；adapter 不支
// 持媒体时返回 undefined，调用方按无图片处理（按钮气泡仍然照发）。
function sendMediaFor(adapter: any, common: any): ((mediaUrl: string) => Promise<any>) | undefined {
  if (typeof adapter?.sendMedia !== 'function') return undefined;
  return (mediaUrl: string) => adapter.sendMedia({ ...common, text: '', mediaUrl });
}

function subscriptionDeclarationKey(target: string): string {
  return `warframe-assistant:subscriptions:qq:${createHash('sha1').update(target.toLowerCase()).digest('hex').slice(0, 16)}`;
}

function dropsDeclarationKey(target: string): string {
  return `warframe-assistant:drops:qq:${createHash('sha1').update(target.toLowerCase()).digest('hex').slice(0, 16)}`;
}

// 本地 workspace 插件无权直调 gateway.request（仅 bundled/trusted 可用），
// cron 增删查一律走 openclaw CLI 子进程
const openclawCli = process.env.OPENCLAW_CLI_PATH
  || path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'openclaw', 'openclaw.mjs');

async function runOpenclawCron(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [openclawCli, 'cron', ...args], {
    timeout: 20_000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    encoding: 'utf8',
  });
  return stdout;
}

function parseCliJson(stdout: string): any {
  // CLI 可能在 JSON 前输出配置警告，截取首个 JSON 起始符之后的部分
  const start = stdout.search(/[[{]/u);
  if (start < 0) throw new Error('openclaw cron output has no JSON');
  return JSON.parse(stdout.slice(start));
}

async function findCronsByKey(_api: any, declarationKey: string): Promise<any[]> {
  const payload = parseCliJson(await runOpenclawCron(['list', '--json']));
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : Array.isArray(payload) ? payload : [];
  return jobs.filter((job: any) => job?.declarationKey === declarationKey);
}

async function findSubscriptionCrons(api: any, target: string): Promise<any[]> {
  return findCronsByKey(api, subscriptionDeclarationKey(target));
}

async function subscriptionDeliveryAudit(api: any, target: string): Promise<any> {
  try {
    const jobs = await findSubscriptionCrons(api, target);
    const job = jobs[0];
    if (!job?.id) return { available: false, reason: 'monitor_job_not_found' };
    const payload = parseCliJson(await runOpenclawCron(['runs', '--id', String(job.id), '--limit', '200']));
    const entries = Array.isArray(payload?.entries) ? payload.entries : [];
    const notifications = entries.filter((entry: any) => {
      const summary = String(entry?.diagnostics?.summary || '').trim();
      return summary && summary !== 'NO_REPLY';
    });
    const latest = entries[0] || null;
    const lastNotification = notifications[0] || null;
    const directDelivered = /^DIRECT_DELIVERED:/u.test(String(lastNotification?.diagnostics?.summary || '').trim());
    return {
      available: true,
      monitorEnabled: job.enabled !== false,
      monitorStatus: job.status || job.lastRunStatus || null,
      consecutiveErrors: Number(job?.state?.consecutiveErrors || 0),
      lastRunAt: latest?.tsIso || (latest?.runAtMs ? new Date(latest.runAtMs).toISOString() : null),
      notificationRunsInWindow: notifications.length,
      lastNotificationRunAt: lastNotification?.tsIso || (lastNotification?.runAtMs ? new Date(lastNotification.runAtMs).toISOString() : null),
      lastNotificationDelivered: lastNotification ? (directDelivered || Boolean(lastNotification.delivered)) : null,
      lastNotificationDeliveryStatus: directDelivered ? 'direct' : (lastNotification?.deliveryStatus || null),
      historyLimit: entries.length,
    };
  } catch (error) {
    api.logger.error(`Warframe subscription delivery audit failed: ${String(error)}`);
    return { available: false, reason: 'cron_history_unavailable' };
  }
}

async function ensureSubscriptionCron(api: any, target: string): Promise<void> {
  const existing = await findSubscriptionCrons(api, target);
  const commandArgv = ['node', subscriptionScript, 'deliver', '--state', subscriptionState, '--target', target, '--card-dir', subscriptionCardDir];
  if (existing.length) {
    for (const job of existing) {
      const currentArgv = Array.isArray(job?.payload?.argv) ? job.payload.argv : [];
      if (JSON.stringify(currentArgv) !== JSON.stringify(commandArgv)
        || job?.delivery?.mode === 'announce'
        || Number(job?.payload?.timeoutSeconds) !== 120) {
        await runOpenclawCron([
          'edit', String(job.id),
          '--command-argv', JSON.stringify(commandArgv),
          '--timeout-seconds', '120',
          '--no-deliver', '--clear-channel', '--clear-to', '--no-best-effort-deliver',
        ]);
      }
      if (job.enabled === false) await runOpenclawCron(['enable', String(job.id)]);
    }
    return;
  }
  await runOpenclawCron([
    'add',
    '--name', 'Warframe 订阅监测',
    '--description', `按世界状态刷新边界监测当前 QQ 会话的 Warframe 订阅：${target}`,
    '--declaration-key', subscriptionDeclarationKey(target),
    '--every', '1m',
    '--session', 'isolated',
    '--command-argv', JSON.stringify(commandArgv),
    '--output-max-bytes', '16384',
    '--timeout-seconds', '120',
    '--no-deliver', '--json',
  ]);
}

async function removeSubscriptionCron(api: any, target: string): Promise<void> {
  const existing = await findSubscriptionCrons(api, target);
  for (const job of existing) await runOpenclawCron(['rm', String(job.id)]);
}

// 愿望单低频 REST 校准改由插件进程内的调度承担（见 runWishlistCalibrationTick）：
// 命中通知必须由 Gateway 侧投递，才能拿到 R2 Markdown 图片 URL、QQ 原生键盘和
// 交互回调桥接；独立 CLI cron 只能发媒体与纯文字，正是命中卡被拆成
// 「图片一条 + 文字一条且没有按钮」的根因。这里只保留退役逻辑，把旧版本按
// target 建立的 `Warframe 愿望单校准` 任务幂等清掉，不再建立任何 wishlist cron。
const WISHLIST_CRON_DECLARATION_PREFIX = 'warframe-assistant:wishlist:qq:';

async function findWishlistCrons(): Promise<any[]> {
  const payload = parseCliJson(await runOpenclawCron(['list', '--json']));
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : Array.isArray(payload) ? payload : [];
  return jobs.filter((job: any) => String(job?.declarationKey || '').startsWith(WISHLIST_CRON_DECLARATION_PREFIX));
}

// 返回实际删除的任务数。启动/升级路径不允许被 cron 维护拖垮：失败只记脱敏
// 警告（不含 QQ 标识），下一次管理动作或重启会重试同一次清理。
async function retireWishlistCrons(api: any, reason: string): Promise<number> {
  try {
    const jobs = await findWishlistCrons();
    let removed = 0;
    for (const job of jobs) {
      await runOpenclawCron(['rm', String(job.id)]);
      removed += 1;
    }
    if (removed) api.logger.info?.(`Warframe retired ${removed} legacy wishlist calibration cron job(s) (${reason})`);
    return removed;
  } catch (error) {
    api.logger.warn?.(`Warframe wishlist cron retirement failed (${reason}): ${String(error)}`);
    return 0;
  }
}

// 单例愿望 WebSocket 的健康状态机在 wishlist-gateway.mjs（可注入时钟/定时器/
// WebSocket，可单测）：未连接/连接中/健康/断线 + 断线起点/最近活动/恢复，
// 「断线后重新连接成功 → 恰好一次恢复扫描」的单飞触发，以及断开/静默流时的
// 20～30 秒保护轮询（恢复扫描与保护扫描共用同一单飞执行槽）。
let wishlistGateway: ReturnType<typeof createWishlistGateway> | null = null;
let wishlistGatewayRefresh: (() => Promise<void>) | null = null;
let wishlistTrackingTimer: ReturnType<typeof setInterval> | null = null;
let wishlistTrackingInFlight = false;
// C 切片：10 分钟低频 REST 校准由插件进程内的定时器承担（替代每个 target 一条
// CLI cron）。定时器只是「检查节拍」，真正的扫描频率仍由账本里每个 target 的
// lastRestAt 与 calibrationIntervalMs 决定，因此重启不会额外扫、也不会漏扫。
let wishlistCalibrationTimer: ReturnType<typeof setInterval> | null = null;
const WISHLIST_CALIBRATION_TICK_MS = 60_000;
// 恢复扫描、保护轮询与低频校准共用同一个执行槽：三者都在同一进程里，重复
// 并发只会白打 Market。恢复/保护扫描等待在飞的扫描结束后仍要执行（它们是对
// 断线/静默的响应），低频校准节拍撞上在飞扫描时直接跳过，下一分钟再来。
let wishlistScanInFlight = 0;
let wishlistScanTail: Promise<any> = Promise.resolve();

// —— R4 第二切片：全局保护 REST 限流/并发（进程级单例，恢复与保护共用）——
// 令牌桶默认容量 1/每 400ms 补 1（请求起点至少相隔 400ms，低于 Market
// 公开 3 req/s 上限），并发上限默认 2；
// 断线→重连→轮询的抖动不会瞬时打满 Market；配置见 CONFIG.md 的 wishlist 段。
let wishlistProtectionModule: any = null;
let wishlistProtectionBucket: any = null;
let wishlistProtectionConcurrency: any = null;
// 脱敏审计指标文件（独立于愿望账本/Outbox，不改变用户状态语义）
let wishlistMetrics: ReturnType<typeof createWishlistMetrics> | null = null;

async function wishlistProtectionModuleInstance(): Promise<any> {
  if (!wishlistProtectionModule) {
    wishlistProtectionModule = await import(pathToFileURL(wishlistProtectionScript).href);
  }
  return wishlistProtectionModule;
}

// 可调参数：plugins.config['warframe-fast-commands'].wishlist 段，全部带默认值
// 与钳制边界；staleAfterMs 是「连接健康但事件流静默」的保护阈值。
function wishlistGatewayTuning(api: any): any {
  const raw = api?.config?.plugins?.entries?.['warframe-fast-commands']?.config?.wishlist || {};
  const clamp = (value: unknown, fallback: number, min: number, max: number): number => {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  };
  const protectionMinMs = clamp(raw?.protectionMinMs, 20_000, 5_000, 60_000);
  return {
    staleAfterMs: clamp(raw?.staleAfterMs, 5 * 60_000, 30_000, 30 * 60_000),
    protectionMinMs,
    protectionMaxMs: Math.max(protectionMinMs, clamp(raw?.protectionMaxMs, 30_000, 5_000, 120_000)),
    rateCapacity: clamp(raw?.rateCapacity, 1, 1, 10),
    rateRefillMs: clamp(raw?.rateRefillMs, 400, 250, 30_000),
    concurrencyLimit: clamp(raw?.concurrencyLimit, 2, 1, 5),
    // 低频校准间隔（R4 目标的「十分钟」）：只影响插件内定时校准的到期判定，
    // 恢复/保护扫描是对断线/静默的即时响应，不受它影响。
    calibrationIntervalMs: clamp(raw?.calibrationIntervalMs, 10 * 60_000, 60_000, 60 * 60_000),
  };
}

function wishlistMetricsInstance(): ReturnType<typeof createWishlistMetrics> {
  if (!wishlistMetrics) {
    wishlistMetrics = createWishlistMetrics({
      filePath: path.resolve(path.dirname(wishlistState), 'warframe-wishlist-metrics.json'),
    });
  }
  return wishlistMetrics;
}

async function wishlistProtectionBucketInstance(api: any): Promise<any> {
  if (!wishlistProtectionBucket) {
    const tuning = wishlistGatewayTuning(api);
    const module = await wishlistProtectionModuleInstance();
    wishlistProtectionBucket = module.createTokenBucket({ capacity: tuning.rateCapacity, refillMs: tuning.rateRefillMs });
  }
  return wishlistProtectionBucket;
}

async function wishlistProtectionConcurrencyInstance(api: any): Promise<any> {
  if (!wishlistProtectionConcurrency) {
    const tuning = wishlistGatewayTuning(api);
    const module = await wishlistProtectionModuleInstance();
    wishlistProtectionConcurrency = module.createConcurrencyGate({ limit: tuning.concurrencyLimit });
  }
  return wishlistProtectionConcurrency;
}

// 指标 sink（网关脱敏事件 → 指标文件）：只透传时间/时长/计数/类别。
// 扫描完成事件只带数字 summary（组数/失败组数），用于诚实标记 Market 可用性。
async function forwardWishlistGatewayMetrics(event: any): Promise<void> {
  if (!event || typeof event !== 'object') return;
  const metrics = wishlistMetricsInstance();
  const at = String(event.at || '').trim();
  if (event.type === 'disconnect') {
    await metrics.recordDisconnected({ at });
  } else if (event.type === 'recover') {
    await metrics.recordRecovered({ at, durationMs: event.durationMs });
  } else if (event.type === 'protection-enter' || event.type === 'protection-exit') {
    await metrics.recordProtectionEvent(event.type, at);
  } else if (event.type === 'scan') {
    const summary = event.summary || null;
    await metrics.recordScan({
      at,
      ok: Boolean(event.ok),
      durationMs: event.durationMs,
      scope: String(event.scope || '').trim(),
      groups: Number(summary?.groups ?? 0),
      fetched: Number(summary?.fetched ?? 0),
      failedGroups: Number(summary?.failedGroups ?? 0),
      error: event.error || '',
    });
  }
}

// QQ 投递延迟（脱敏）：Outbox 入队 createdAt → deliveredAt；只发数字指标。
async function recordWishlistDeliveryLatency(metrics: any, outbox: any, deliveredIds: any[], logger: any): Promise<void> {
  try {
    const ids = (deliveredIds || []).map((value: any) => String(value)).filter(Boolean);
    if (!ids.length) return;
    const snapshot = await outbox.snapshot();
    const byId = new Map((snapshot?.entries || []).map((entry: any) => [String(entry.id), entry]));
    for (const id of ids) {
      const entry = byId.get(String(id));
      const createdMs = Date.parse(String(entry?.createdAt || ''));
      const deliveredMs = Date.parse(String(entry?.deliveredAt || ''));
      if (Number.isFinite(createdMs) && Number.isFinite(deliveredMs)) {
        await metrics.recordDelivery({ at: entry.deliveredAt, latencyMs: Math.max(0, deliveredMs - createdMs) });
      }
    }
  } catch (error) {
    logger?.warn?.(`Warframe wishlist delivery latency metrics failed: ${String(error)}`);
  }
}

// 订单发现延迟（脱敏）：命中入队提交时间 − 上游订单 createdAt（缺失时用事件接收时间）。
async function recordWishlistLatencyMetrics(api: any, metrics: any, monitorResult: any, outbox: any): Promise<void> {
  try {
    const data = monitorResult?.data || {};
    const committedAt = Date.now();
    for (const hit of Array.isArray(data.hits) ? data.hits : []) {
      const sourceAt = String(hit?.order?.createdAt || hit?.order?.created_at || '').trim();
      const sourceMs = sourceAt ? Date.parse(sourceAt) : NaN;
      await metrics.recordDiscovery({
        at: new Date(committedAt).toISOString(),
        latencyMs: Number.isFinite(sourceMs) ? Math.max(0, committedAt - sourceMs) : null,
        sourceKnown: Number.isFinite(sourceMs),
      });
    }
    await recordWishlistDeliveryLatency(metrics, outbox, data?.delivery?.deliveredIds || [], api.logger);
  } catch (error) {
    api.logger.warn?.(`Warframe wishlist latency metrics failed: ${String(error)}`);
  }
}

// —— 愿望命中通知 Outbox（R3 第四片）——
// Gateway 单例 WebSocket 的命中通知按「先入 Outbox → 提交 wishlist ledger →
// 锁外逐 part 投递」事务链走：WebSocket 一笔订单可能命中多个 QQ target，
// 每个 target 独立业务键与投递状态；注入的 QQ outbound mailer 让 Outbox 自己
// 逐 part 持久化结果，不在账本提交后再裸循环发送（下面 sendWishlistGatewayResult
// 只保留给「建立后立即行情卡」等交互用例顺序）。
let wishlistOutbox: any = null;
let wishlistRoutingContract: { keyPrefix: string; outboxFileName: string } | null = null;
async function wishlistRouting(): Promise<{ keyPrefix: string; outboxFileName: string }> {
  if (!wishlistRoutingContract) {
    const module = await import(pathToFileURL(wishlistScript).href);
    wishlistRoutingContract = {
      keyPrefix: String(module.WISHLIST_KEY_PREFIX),
      outboxFileName: String(module.WISHLIST_OUTBOX_FILE_NAME),
    };
  }
  return wishlistRoutingContract;
}
async function wishlistOutboxInstance(): Promise<any> {
  if (!wishlistOutbox) {
    const { createOutbox } = await import(pathToFileURL(notificationOutboxScript).href);
    const routing = await wishlistRouting();
    wishlistOutbox = createOutbox({ filePath: path.resolve(path.dirname(wishlistState), routing.outboxFileName) });
  }
  return wishlistOutbox;
}

// adapter 结果 → 固定脱敏类别（服务端明确接受/拒绝/异常；原始异常不落盘）
async function wishlistGatewayMailer(api: any, target: string): Promise<((part: any) => Promise<any>) | null> {
  const adapter = await api.runtime.channel.outbound.loadAdapter('qqbot');
  if (!adapter) return null;
  const sendMedia = sendMediaFor(adapter, { cfg: api.config, to: target, mediaLocalRoots: [subscriptionCardDir, cardDir] });
  return createGatewayWishlistMailer(adapter, target, {
    cfg: api.config, mediaLocalRoots: [subscriptionCardDir, cardDir],
    sendRich: async (payload: any) => {
      try {
        const merged = await wishlistMergedCardEnabled(api, { accountId: 'default', target });
        const sent = await sendWishlistCard({
          result: { kind: 'wishlist', command: payload.wish ? 'tracking' : 'hit', wish: payload.wish, hits: payload.hits || [] },
          cfg: api.config, accountId: 'default', target, mediaUrl: payload.mediaUrl, content: payload.text,
          merged, sendMedia,
        });
        if (sent.sent) {
          if (sent.degraded) api.logger.warn?.(`Warframe wishlist notification degraded (mode=${String(sent.mode || 'unknown')})`);
          return { messageId: sent.messageId || '' };
        }
      } catch { api.logger.warn?.('Warframe combined wishlist notification failed; using compatible delivery'); }
      return adapter.sendText?.({ cfg: api.config, to: target, text: `${payload.text || '愿望单状态已更新。'}\n按钮暂不可用，请发送「愿望单」进入管理。` });
    },
  });
}

// 恢复/投递指定 target 的愿望通知 pending（只投本链业务键前缀；Outbox 逐 part
// 持久化 + 跨进程锁：与 REST 校准 cron 并发也不会重复 send 或互相覆盖）。
// 投递成功即记录 QQ 投递延迟指标（脱敏：只记时长，不记 target/卖家/订单）。
async function flushWishlistTargetPending(api: any, target: string): Promise<void> {
  const mailer = await wishlistGatewayMailer(api, target);
  if (!mailer) {
    api.logger.warn?.('Warframe wishlist outbound adapter unavailable; pending stays for next event');
    return;
  }
  const outbox = await wishlistOutboxInstance();
  const routing = await wishlistRouting();
  const summary = await outbox.deliverPending({ target, mailer, keyPrefix: routing.keyPrefix });
  if (Number(summary?.sentParts || 0) > 0) {
    api.logger.info?.(`Warframe wishlist delivered pending parts: ${summary.sentParts}`);
  }
  await recordWishlistDeliveryLatency(wishlistMetricsInstance(), outbox, summary?.deliveredIds || [], api.logger);
}

// 启动时先恢复相关 target 的 pending（上次投递失败/进程被杀留下的欠账）
async function restoreWishlistPending(api: any): Promise<void> {
  try {
    const module = await import(pathToFileURL(wishlistScript).href);
    const ledger = await module.readWishlistLedger(wishlistState);
    const targets = [...new Set((ledger.wishes || [])
      .map((wish: any) => String(wish.target || '').trim().toLowerCase())
      .filter((target: string) => /^qqbot:c2c:/u.test(target)))];
    for (const target of targets) await flushWishlistTargetPending(api, target);
  } catch (error) {
    api.logger.warn?.(`Warframe wishlist pending restore failed: ${String(error)}`);
  }
}

async function sendWishlistGatewayResult(api: any, result: any): Promise<void> {
  const target = String(result?.target || '').trim();
  if (!target) return;
  const adapter = await api.runtime.channel.outbound.loadAdapter('qqbot');
  if (!adapter) return;
  const common = { cfg: api.config, to: target, mediaLocalRoots: [subscriptionCardDir, cardDir] };
  if (result.raw?.kind === 'wishlist') {
    try {
      const merged = await wishlistMergedCardEnabled(api, { accountId: 'default', target });
      const sent = await sendWishlistCard({
        result: result.raw, cfg: api.config, accountId: 'default', target, mediaUrl: result.mediaUrl, content: result.text,
        merged, sendMedia: sendMediaFor(adapter, common),
      });
      if (sent.sent) {
        if (sent.degraded) api.logger.warn?.(`Warframe wishlist follow-up degraded (mode=${String(sent.mode || 'unknown')})`);
        return;
      }
    } catch { api.logger.warn?.('Warframe combined wishlist follow-up failed; using compatible delivery'); }
  }
  if (result.raw?.kind === 'wishlist') {
    if (result.text && adapter.sendText) {
      const textResult = await adapter.sendText({ ...common, text: `${result.text}\n按钮暂不可用，请发送「愿望单」进入管理。` });
      if (textResult?.error) throw new Error(`QQ wishlist text delivery failed: ${String(textResult.error)}`);
    }
    return;
  }
  if (result.mediaUrl && adapter.sendMedia) {
    const mediaResult = await adapter.sendMedia({ ...common, text: '', mediaUrl: result.mediaUrl });
    if (mediaResult?.error) throw new Error(`QQ wishlist media delivery failed: ${String(mediaResult.error)}`);
  }
  if (result.text && adapter.sendText) {
    const textResult = await adapter.sendText({ ...common, text: result.text });
    if (textResult?.error) throw new Error(`QQ wishlist text delivery failed: ${String(textResult.error)}`);
  }
}

function wishlistMarketCommand(wish: any): string {
  const name = String(wish?.zhName || wish?.itemName || wish?.slug || '').trim();
  const rank = wish?.rankMode === 'max' ? ' 满级'
    : wish?.rankMode === 'exact' && wish?.rank != null ? ` 等级 ${Number(wish.rank)}` : '';
  return `wm ${name}${rank}`.trim();
}

async function inspectCurrentWishlistNow(api: any, target: string, manageResult: any): Promise<any> {
  try {
    const module = await import(pathToFileURL(wishlistScript).href);
    const result = await module.monitorWishlist(target, wishlistState, subscriptionCardDir, false, {
      forceRest: true,
      skipWebSocket: true,
      ownerId: String(manageResult?.wish?.ownerId || '').trim().toLowerCase(),
      render: true,
    });
    const hits = Array.isArray(result?.data?.hits) ? result.data.hits : [];
    if (!hits.length) return { ok: true, hitCount: 0, marketCards: 0, deliveries: [] };
    const deliveries = [{ target, mediaUrl: result.mediaUrl, text: result.text, raw: { kind: 'wishlist', hits } }];
    return { ok: true, hitCount: hits.length, marketCards: result.mediaUrl ? 1 : 0, deliveries };
  } catch (error) {
    // The wish is already durable and the singleton websocket remains active.
    // The 10-minute calibration cron will retry current listings later.
    api.logger.warn?.(`Warframe wishlist immediate calibration failed: ${String(error)}`);
    return { ok: false, hitCount: 0, marketCards: 0 };
  }
}

// 愿望单不再维护 CLI cron：两种动作都只做幂等退役。插件内低频校准按账本里的
// 活跃愿望自行判断是否该扫，新建/改价/恢复后的即时校准仍由愿望用例直接触发。
async function syncWishlistCronAction(api: any, _target: string, action: string): Promise<void> {
  await retireWishlistCrons(api, action);
}

async function runWishlistCommandUseCase(api: any, request: any, enqueuePrimary: (result: any) => Promise<any>): Promise<any> {
  return executeWishlistUseCase(request, {
    manage: (command: any) => runJsonScript(wishlistScript, [
      'manage', '--state', wishlistState, '--message', command.text,
      '--target', command.target, '--owner', command.actorId,
      '--owner-name', command.actorDisplayName, '--card-dir', command.cardDir || cardDir,
      ...(command.expectedUpdatedAt ? ['--expected-updated-at', command.expectedUpdatedAt] : []),
    ], 30_000),
    syncCron: (target: string, action: string) => syncWishlistCronAction(api, target, action),
    refreshGateway: async () => { await wishlistGatewayRefresh?.(); },
    enqueuePrimary,
    inspectCurrent: (target: string, result: any) => inspectCurrentWishlistNow(api, target, result),
    enqueueFollowups: async (deliveries: any[]) => {
      for (const delivery of deliveries) await sendWishlistGatewayResult(api, delivery);
    },
    log: (level: string, message: string, error: unknown) => {
      const output = `Warframe ${message}: ${String(error)}`;
      if (level === 'error') api.logger.error(output);
      else api.logger.warn?.(output);
    },
  });
}

// gateway_start owns exactly one public WFM subscription for the whole plugin.
// Its itemId index is refreshed from the local ledger, so unrelated events do
// not spawn a script, render a card, or touch QQ delivery. The connection
// lifecycle/health is owned by wishlist-gateway.mjs (injectable clock, timers
// and WebSocket); here we only provide the Market/QQ ports. R4 recovery scan:
// a successful reconnect after a real disconnect triggers exactly one scan per
// recovery cycle (single-flight inside the state machine); the first successful
// connection never scans. R4 protection polling: while disconnected or the
// event stream is stale beyond the configured threshold, the same coalesced
// REST scan runs every 20～30 s (shared single-flight slot with the recovery
// scan; global token bucket + concurrency ceiling avoid reconnect/flap bursts).
async function startWishlistGateway(api: any): Promise<void> {
  if (wishlistGateway && !wishlistGateway.status().stopped) return;
  const wishlistModule = await import(pathToFileURL(wishlistScript).href);
  const tuning = wishlistGatewayTuning(api);
  const gateway = createWishlistGateway({
    wsUrl: 'wss://ws.warframe.market/socket',
    wsProtocol: 'wfm',
    logger: api.logger,
    loadItemIds: async (): Promise<Set<string>> => {
      const ledger = await wishlistModule.readWishlistLedger(wishlistState);
      return new Set((ledger.wishes || [])
        .filter((wish: any) => wish.status === 'active' && wish.enabled && /^qqbot:c2c:/u.test(String(wish.target || '')))
        .map((wish: any) => String(wish.itemId || '').trim())
        .filter(Boolean));
    },
    onOpen: (socket: any) => {
      socket.send(JSON.stringify({
        route: '@wfm|cmd/subscribe/newOrders',
        id: `wishlist-gateway-${Date.now().toString(36)}`,
        payload: { platform: 'pc', crossplay: true },
      }));
    },
    onOrder: async (order: any, activityAtIso?: string) => {
      await handleWishlistLiveOrder(api, wishlistModule, order, activityAtIso || null);
    },
    recoveryScan: async () => { await runWishlistScanShared(api); },
    protectionScan: async () => { await runWishlistScanShared(api); },
    metricsSink: (event: any) => {
      void forwardWishlistGatewayMetrics(event);
    },
    staleAfterMs: tuning.staleAfterMs,
    protectionMinMs: tuning.protectionMinMs,
    protectionMaxMs: tuning.protectionMaxMs,
  });
  wishlistGateway = gateway;
  wishlistGatewayRefresh = () => gateway.refresh();
  // 升级迁移：清掉旧版本按 target 建立的 CLI 校准任务，命中卡必须由本进程投递
  await retireWishlistCrons(api, 'startup');
  // 启动先恢复相关 target 的 wishlist pending，再刷新索引并连接
  await restoreWishlistPending(api);
  await gateway.start();
  if (!wishlistTrackingTimer) {
    wishlistTrackingTimer = setInterval(() => { void runWishlistTrackingSweep(api, wishlistModule); }, 2_000);
    void runWishlistTrackingSweep(api, wishlistModule);
  }
  if (!wishlistCalibrationTimer) {
    wishlistCalibrationTimer = setInterval(() => { void runWishlistCalibrationTick(api); }, WISHLIST_CALIBRATION_TICK_MS);
  }
}

async function stopWishlistGateway(): Promise<void> {
  wishlistGateway?.stop();
  wishlistGateway = null;
  wishlistGatewayRefresh = null;
  if (wishlistTrackingTimer) clearInterval(wishlistTrackingTimer);
  wishlistTrackingTimer = null;
  if (wishlistCalibrationTimer) clearInterval(wishlistCalibrationTimer);
  wishlistCalibrationTimer = null;
}

function wishlistTrackingText(event: any): string {
  const name = String(event?.wish?.zhName || event?.wish?.itemName || '该商品');
  const oldPrice = Number(event?.track?.currentPrice);
  const nextPrice = Number(event?.replacement?.unitPrice ?? event?.order?.unitPrice);
  if (event.type === 'removed_replaced') return `${name} 的命中卖单已撤下；同时发现新的最低价 ${nextPrice}p，已切换并重新跟踪 1 小时。`;
  if (event.type === 'removed') return `${name} 的命中卖单经二次确认已从 Warframe.Market 撤下。`;
  if (event.type === 'lower') return `${name} 出现更低卖单：${oldPrice}p → ${Number(event.replacement?.unitPrice)}p，已切换跟踪。`;
  if (event.type === 'price_down' || event.type === 'price_up') return `${name} 的命中卖单改价：${oldPrice}p → ${nextPrice}p。`;
  if (event.type === 'price_exceeded') return `${name} 的命中卖单已涨到 ${nextPrice}p，超过愿望上限，已停止跟踪这张卖单；愿望本身继续有效。`;
  if (event.type === 'expired_unknown') return `${name} 的 1 小时跟踪已结束，但期间市场接口异常，无法确认卖单最终是否撤下。愿望本身继续有效。`;
  return `${name} 的命中卖单已持续存在 1 小时，本次跟踪结束；愿望本身继续有效。`;
}

async function runWishlistTrackingSweep(api: any, wishlistModule: any): Promise<void> {
  if (wishlistTrackingInFlight) return;
  wishlistTrackingInFlight = true;
  try {
    const outbox = await wishlistOutboxInstance();
    const routing = await wishlistRouting();
    const result = await wishlistModule.runDueWishlistTracking(wishlistState, {
      enqueueEvent: async (event: any) => {
        const replacementHits = event.replacement ? [{ wish: event.wish, order: event.replacement }] : [];
        const keyMaterial = [event.type, event.wishId, event.track?.orderId, event.track?.startedAt, event.order?.unitPrice, event.replacement?.id, event.replacement?.unitPrice];
        const businessKey = `${routing.keyPrefix}tracking:${createHash('sha256').update(JSON.stringify(keyMaterial)).digest('hex')}`;
        await outbox.enqueue({
          businessKey, target: event.target,
          parts: [{ kind: 'rich', value: JSON.stringify({ mediaUrl: null, text: wishlistTrackingText(event), hits: replacementHits, wish: event.wish }) }],
          expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), redactOnTerminal: true,
        });
      },
    });
    const targets = [...new Set((result.events || []).map((event: any) => String(event.target || '')).filter((target: string) => /^qqbot:c2c:/u.test(target)))];
    for (const target of targets) await flushWishlistTargetPending(api, target);
  } catch (error) {
    api.logger.warn?.(`Warframe wishlist tracking sweep failed: ${String(error)}`);
  } finally {
    wishlistTrackingInFlight = false;
  }
}

// 单例 WebSocket 的相关新订单 → R3 共享 Outbox 事务链（行情过滤由状态机
// 按 itemId 索引完成）：所有命中 target 全部入队成功后才一次性提交 wishlist
// ledger（目标间互不吞提醒），随后逐 target 由注入 mailer 让 Outbox 自己
// 逐 part 持久化投递结果——不在账本提交后再裸循环发送。
// 入队提交后记录订单发现延迟（脱敏：入队时间 − 上游订单 createdAt/WS 接收时间）。
async function handleWishlistLiveOrder(api: any, wishlistModule: any, order: any, activityAtIso: string | null): Promise<void> {
  try {
    const outbox = await wishlistOutboxInstance();
    const committedAt = Date.now();
    const normalized = wishlistModule.normalizeWishlistOrder(order);
    const ledger = await wishlistModule.readWishlistLedger(wishlistState);
    const relevant = (ledger.wishes || []).filter((wish: any) => wish.itemId === normalized.itemId && wish.status === 'active' && wish.enabled && /^qqbot:c2c:/u.test(String(wish.target || '')));
    if (!relevant.length) return;
    const orders = await wishlistModule.fetchTopOrdersForWishes(relevant, globalThis.fetch);
    const results = await wishlistModule.processWishlistLiveOrder(orders, wishlistState, subscriptionCardDir, { outbox, richPayload: true });
    for (const result of results || []) {
      if (result?.outbox === true && result.target) {
        await flushWishlistTargetPending(api, String(result.target));
      } else {
        api.logger.warn?.('Warframe wishlist live order result without outbox, skipped');
      }
    }
    const sourceAt = String(order?.createdAt || order?.created_at || activityAtIso || '').trim();
    const sourceMs = sourceAt ? Date.parse(sourceAt) : NaN;
    await wishlistMetricsInstance().recordDiscovery({
      at: new Date(committedAt).toISOString(),
      latencyMs: Number.isFinite(sourceMs) ? Math.max(0, committedAt - sourceMs) : null,
      sourceKnown: Number.isFinite(sourceMs),
    });
  } catch (error) {
    api.logger.error(`Warframe wishlist live order failed: ${String(error)}`);
  }
}

// R4 恢复/保护扫描 + 插件内低频校准——三个入口共用全局合并编排
// （runCoalescedWishlistScan）：先按去重后的 itemId+rank 把跨 target 的
// 相同 Market 请求合并为每组合并一次请求（全局令牌桶 + 并发上限），再逐
// target 复用现有 REST 校准 + R3 Outbox + 同业务键去重链——命中先原子入队
// 再提交 seen/calibration 账本；与实时 WS 命中共享同一业务键，不会重复提醒。
// 恢复扫描（断线后重连成功）与保护轮询（断线/静默窗口 20～30 秒节拍）是对
// 故障的即时响应，一律 forceRest；低频校准按每个 target 的 lastRestAt 到期
// 才扫，重启不会额外打 Market。QQ outbound 不可用时仍执行校准与入队（欠账
// 留在 Outbox，下轮补投），绝不把「未投递」伪装成已投递。Market 完全不可用
// 时抛出失败（网关留 lastScanError、下次恢复周期/保护轮询重试）并且 per-target
// 走 restError 分支：不写新鲜 calibration，诚实报告。
async function runWishlistRecoveryScan(api: any, options: { forceRest?: boolean } = {}): Promise<any> {
  const forceRest = options.forceRest !== false;
  const tuning = wishlistGatewayTuning(api);
  const module = await import(pathToFileURL(wishlistScript).href);
  const ledger = await module.readWishlistLedger(wishlistState);
  const active = (ledger.wishes || [])
    .filter((wish: any) => wish.status === 'active' && wish.enabled && /^qqbot:c2c:/u.test(String(wish.target || '')))
    .filter((wish: any) => String(wish.target || '').trim() && String(wish.itemId || '').trim() && String(wish.slug || '').trim());
  if (!active.length) {
    return { ok: true, reason: 'no_active_wishes', targets: 0, groups: 0, fetched: 0, failedGroups: 0, marketAvailable: null };
  }
  // 低频校准的到期门必须在任何 Market 请求之前：未到期就返回，绝不为「检查一下」
  // 按分钟打一次 /top。恢复/保护扫描是故障响应，一律跳过这道门（forceRest）。
  if (!forceRest) {
    const nowMs = Date.now();
    const due = active.some((wish: any) => {
      const lastRestAt = Date.parse(String(ledger.calibration?.targets?.[wish.target]?.lastRestAt || ''));
      return !Number.isFinite(lastRestAt) || nowMs - lastRestAt >= tuning.calibrationIntervalMs;
    });
    if (!due) return { ok: true, reason: 'not_due', targets: 0, groups: 0, fetched: 0, failedGroups: 0, marketAvailable: null };
  }
  const outbox = await wishlistOutboxInstance();
  const moduleProtection = await wishlistProtectionModuleInstance();
  const result = await moduleProtection.runCoalescedWishlistScan({
    wishes: active,
    tokenBucket: await wishlistProtectionBucketInstance(api),
    concurrency: await wishlistProtectionConcurrencyInstance(api),
    logger: api.logger,
    fetchOne: async (wish: any) => module.fetchTopOrdersForItem(wish, globalThis.fetch),
    monitorTarget: async (target: string, targetWishes: any[], info: any) => {
      const mailer = await wishlistGatewayMailer(api, target);
      const monitorResult = await module.monitorWishlist(target, wishlistState, subscriptionCardDir, false, {
        forceRest,
        restIntervalMs: tuning.calibrationIntervalMs,
        skipWebSocket: true,
        outbox,
        richPayload: true,
        ...(mailer ? { mailer } : {}),
        restIncompleteError: info?.hasFailures
          ? `Warframe.Market 保护扫描部分请求失败（${Number(info.failedKeys?.length) || 0} 组），未标记完整校准`
          : null,
        fetchOrders: async () => {
          // 该 target 所需组全部失败：走 monitorWishlist 的 restError 分支
          // （保留旧 lastRestAt、记录 lastError），绝不把不可用伪装成新鲜校准。
          if (info?.allFailed) throw new Error('Warframe.Market 完全不可用（保护扫描全组失败）');
          return info?.orders || [];
        },
      });
      await recordWishlistLatencyMetrics(api, wishlistMetricsInstance(), monitorResult, outbox);
      return monitorResult;
    },
  });
  // 诚实上报：Market 完全不可用 → 抛错让网关记录扫描失败（保护轮询会继续重试）；
  // 部分失败保留成功组的校准，失败组由指标与 lastError 如实记录。
  if (result.marketAvailable === false) {
    const message = `Warframe.Market 完全不可用（${result.failedGroups}/${result.groups} 组失败）`;
    api.logger.warn?.(`Warframe wishlist recovery scan: ${message}；保护轮询继续按 20～30 秒重试，不伪造新鲜校准`);
    const error: any = new Error(message);
    error.scanSummary = {
      groups: Number(result.groups) || 0,
      fetched: Number(result.fetched) || 0,
      failedGroups: Number(result.failedGroups) || 0,
    };
    throw error;
  }
  if (result.failedGroups > 0) {
    api.logger.warn?.(`Warframe wishlist recovery scan partial failure: ${result.failedGroups}/${result.groups} 组失败（其余组正常）`);
  }
  return result;
}

// 三处扫描入口的唯一执行槽：同一时刻只允许一个合并扫描在跑（都在这一个进程里，
// 并发只会白打 Market）。skipIfBusy 供低频校准节拍使用——撞上在飞扫描就跳过这
// 一拍；恢复/保护扫描是对断线/静默的响应，排队等待后仍要执行。等待只吞掉前一次
// 扫描的异常，本次扫描的错误照常抛给调用方（状态机记 lastScanError）。
async function runWishlistScanShared(api: any, options: { forceRest?: boolean; skipIfBusy?: boolean } = {}): Promise<any> {
  if (options.skipIfBusy && wishlistScanInFlight > 0) {
    return { ok: true, reason: 'scan_in_flight', skipped: true, targets: 0, groups: 0, fetched: 0, failedGroups: 0, marketAvailable: null };
  }
  wishlistScanInFlight += 1;
  const previous = wishlistScanTail;
  const run = (async () => {
    await previous;
    return runWishlistRecoveryScan(api, { forceRest: options.forceRest !== false });
  })();
  wishlistScanTail = run.then(() => {}, () => {});
  try {
    return await run;
  } finally {
    wishlistScanInFlight -= 1;
  }
}

// 低频校准节拍（默认每分钟检查一次）：是否真的请求 Market 由账本里每个 target
// 的 lastRestAt 与 calibrationIntervalMs 决定（`forceRest: false`），所以重启
// 不会额外扫描、也不会漏扫。Market 完全不可用时只记脱敏指标与警告，留
// scanSummary 的组数供指标和下一拍重试，绝不让定时器产生未处理异常。
async function runWishlistCalibrationTick(api: any): Promise<void> {
  const startedAt = Date.now();
  try {
    const result = await runWishlistScanShared(api, { forceRest: false, skipIfBusy: true });
    if (result?.skipped || ['no_active_wishes', 'scan_in_flight', 'not_due'].includes(String(result?.reason || ''))) return;
    await wishlistMetricsInstance().recordScan({
      at: new Date().toISOString(),
      ok: true,
      durationMs: Date.now() - startedAt,
      scope: 'calibration',
      groups: Number(result?.groups || 0),
      fetched: Number(result?.fetched || 0),
      failedGroups: Number(result?.failedGroups || 0),
      error: '',
    });
    if (Number(result?.failedGroups || 0) > 0) {
      api.logger.warn?.(`Warframe wishlist calibration partial failure: ${Number(result.failedGroups)}/${Number(result.groups)} 组失败（其余组正常）`);
    }
  } catch (error: any) {
    const summary = error?.scanSummary || {};
    try {
      await wishlistMetricsInstance().recordScan({
        at: new Date().toISOString(),
        ok: false,
        durationMs: Date.now() - startedAt,
        scope: 'calibration',
        groups: Number(summary.groups || 0),
        fetched: Number(summary.fetched || 0),
        failedGroups: Number(summary.failedGroups || 0),
        error: String(error?.message || error),
      });
    } catch { /* 指标失败不影响校准重试 */ }
    api.logger.warn?.(`Warframe wishlist calibration tick failed; retrying on next tick: ${String(error?.message || error)}`);
  }
}

// 掉落监测：每分钟只做本地 mtime 检查，快照变化才解密 diff，不联网轮询
async function ensureDropsCron(api: any, target: string): Promise<void> {
  const existing = await findCronsByKey(api, dropsDeclarationKey(target));
  if (existing.length) {
    for (const job of existing) {
      if (job.enabled === false) await runOpenclawCron(['enable', String(job.id)]);
    }
    return;
  }
  await runOpenclawCron([
    'add',
    '--name', 'Warframe 掉落监测',
    '--description', `监测本机账号快照新入库掉落并推送：${target}`,
    '--declaration-key', dropsDeclarationKey(target),
    '--every', '1m',
    '--session', 'isolated',
    '--command-argv', JSON.stringify(['node', dropsScript, 'monitor', '--state', dropsState, '--ledger', subscriptionState, '--target', target, '--card-dir', subscriptionCardDir]),
    '--output-max-bytes', '16384',
    '--timeout-seconds', '120',
    '--announce', '--channel', 'qqbot', '--to', target,
    '--best-effort-deliver', '--json',
  ]);
}

async function removeDropsCron(api: any, target: string): Promise<void> {
  const existing = await findCronsByKey(api, dropsDeclarationKey(target));
  for (const job of existing) await runOpenclawCron(['rm', String(job.id)]);
}

async function syncSubscriptionMonitors(api: any, target: string, actions: any): Promise<void> {
  if (actions.world === 'ensure') await ensureSubscriptionCron(api, target);
  else if (actions.world === 'remove') await removeSubscriptionCron(api, target);
  if (actions.drops === 'ensure') await ensureDropsCron(api, target);
  else if (actions.drops === 'remove') await removeDropsCron(api, target);
}

function isQQChannel(value: unknown): boolean {
  return String(value || '').trim().toLowerCase() === 'qqbot';
}

function isExactOwner(api: any, senderId: unknown): boolean {
  // openid 是 hex，大小写不稳定，比较一律归一化小写
  const sender = String(senderId || '').trim().toLowerCase();
  if (!sender) return false;
  // 用户身份优先读插件配置；allowFrom 可能是 ["*"]（任何人可对话），通配符不能当用户凭证
  const configured = String(api?.config?.plugins?.entries?.['warframe-fast-commands']?.config?.ownerOpenId || '').trim().toLowerCase();
  if (configured) return sender === configured;
  const allowed = api?.config?.channels?.qqbot?.allowFrom;
  if (!Array.isArray(allowed)) return false;
  return allowed.some((entry: unknown) => {
    const value = String(entry || '').trim();
    return value && value !== '*' && value === sender;
  });
}

function agentContextIsGroup(ctx: any): boolean {
  const chat = ctx?.channelContext?.chat || {};
  const hints = [ctx?.sessionKey, chat.type, chat.kind, chat.scope, chat.chatType].filter(Boolean).join(':').toLowerCase();
  return /(?:^|:)(?:group|guild|channel)(?::|$)/u.test(hints);
}

async function handleFastCommand(api: any, event: any, traceTrigger: string | null = null): Promise<any | undefined> {
  if (!isQQChannel(event.channel) || (!isShortcut(event.content) && !isSubscriptionCommand(event.content))) return;
  // Wishlist owns delivery ordering (primary feedback before immediate market
  // follow-up), so every ingress hook routes it through the shared use case.
  if (isWishlistCommand(event.content)) return;
  // R17 第一片：只为代表链「裂缝 九重天」开 trace；其余命令完全不埋点。
  const traceReceivedAt = Date.now();
  const trace = traceTrigger && (await isTraceTarget(String(event.content || '')))
    ? await createQqTraceContext({ storePath: traceStorePath, triggerType: traceTrigger })
    : null;
  try {
    if (isPersonalAccountCommand(event.content)) {
      const target = qqTarget(event);
      const ownerId = String(event.senderId || '').trim().toLowerCase();
      const outcome = await runPersonalCommandUseCase(api, {
        source: 'fast-command',
        text: event.content,
        channel: event.channel,
        target,
        actorId: ownerId,
        actorDisplayName: String(event.senderName || event.senderUsername || ownerId),
        personalAllowed: !event.isGroup && isExactOwner(api, event.senderId),
        isGroup: Boolean(event.isGroup),
        cardDir,
      });
      const result = outcome.result;
      return {
        text: result.followupText || result.text || '账号快照查询完成。',
        ...(result.mediaUrl ? { mediaUrl: result.mediaUrl, trustedLocalMedia: true } : {}),
        replyToId: event.messageId,
        isError: result.ok === false,
        raw: result,
      };
    }
    if (isSubscriptionCommand(event.content)) {
      const target = qqTarget(event);
      const ownerId = String(event.senderId || '').trim().toLowerCase();
      // 掉落订阅属于个人数据：只有用户私聊才允许创建，由脚本侧据此拒绝
      const personalAllowed = !event.isGroup && isExactOwner(api, event.senderId);
      const outcome = await runSubscriptionCommandUseCase(api, {
        source: 'fast-command',
        text: event.content,
        channel: event.channel,
        target,
        actorId: ownerId,
        actorDisplayName: String(event.senderName || event.senderUsername || ownerId),
        personalAllowed,
        isGroup: Boolean(event.isGroup),
      });
      const result = outcome.result;
      return {
        text: result.text || '订阅设置已更新。',
        replyToId: event.messageId,
        isError: result.ok === false || Boolean(result.warning),
        raw: result,
      };
    }
    if (isWeeklyCommand(event.content)) {
      const target = qqTarget(event);
      const ownerId = String(event.senderId || '').trim().toLowerCase();
      const outcome = await runWeeklyCommandUseCase(api, {
        source: 'fast-command',
        text: event.content,
        channel: event.channel,
        target,
        actorId: ownerId,
        actorDisplayName: String(event.senderName || event.senderUsername || ownerId),
        personalAllowed: !event.isGroup && isExactOwner(api, event.senderId),
        isGroup: Boolean(event.isGroup),
        cardDir,
      });
      const result = outcome.result;
      return {
        text: result.text || '周常状态已更新。',
        ...(result.mediaUrl ? { mediaUrl: result.mediaUrl, trustedLocalMedia: true } : {}),
        replyToId: event.messageId,
        isError: result.ok === false,
        raw: result,
      };
    }
    const target = qqTarget(event);
    const ownerId = String(event.senderId || '').trim().toLowerCase();
    const personalAllowed = !event.isGroup && isExactOwner(api, event.senderId);
    if (trace) {
      // 外层 registry gate 已完成真实路由，因此按实际处理顺序记录
      // received → route → authorization；子进程只补 facts 之后的阶段。
      await recordQqTraceStage(trace, {
        stage: 'received', startedAt: new Date(traceReceivedAt).toISOString(),
        durationMs: Date.now() - traceReceivedAt, source: 'qq-channel', freshness: 'local',
        resultCategory: 'received', retryCount: 0, contentHash: '', scope: 'public',
      });
      await recordQqTraceStage(trace, {
        stage: 'route', startedAt: new Date().toISOString(), durationMs: 0,
        source: 'command-registry', freshness: 'local', resultCategory: 'matched',
        retryCount: 0, contentHash: '', scope: 'public',
      });
      const authCategory = authorizationResultCategory(personalAllowed, event.isGroup);
      await recordQqTraceStage(trace, {
        stage: 'authorization', startedAt: new Date().toISOString(), durationMs: 0,
        source: 'local-policy', freshness: 'local', resultCategory: authCategory,
        retryCount: 0, contentHash: '',
        scope: personalAllowed && !event.isGroup ? 'personal' : 'public',
      });
    }
    const outcome = await runPublicCommandUseCase(api, {
      source: 'fast-command', text: event.content, channel: event.channel, target,
      actorId: ownerId, personalAllowed, isGroup: Boolean(event.isGroup), cardDir,
      ...(trace ? { trace: { storePath: trace.storePath, traceId: trace.traceId, triggerType: trace.triggerType } } : {}),
    });
    const result = outcome.result;
    return {
      text: result.followupText || result.text || '查询完成，但没有可显示的结果。',
      ...(result.mediaUrl ? { mediaUrl: result.mediaUrl, trustedLocalMedia: true } : {}),
      replyToId: event.messageId,
      isError: result.ok === false,
      raw: result,
      ...(trace ? { [QQ_REPLY_TRACE]: trace } : {}),
    };
  } catch (error) {
    api.logger.error(`Warframe shortcut failed: ${String(error)}`);
    return {
      text: 'Warframe 查询暂时失败，请稍后重试。',
      replyToId: event.messageId,
      isError: true,
      ...(trace ? { [QQ_REPLY_TRACE]: trace } : {}),
    };
  }
}

async function sendDirectQQReply(api: any, event: any, ctx: any, reply: any): Promise<void> {
  const trace = (reply as any)?.[QQ_REPLY_TRACE] || null;
  const deliveryStartedAt = Date.now();
  const recordDelivery = async (category: string): Promise<void> => {
    if (!trace) return;
    await recordQqTraceStage(trace, {
      stage: 'delivery', startedAt: new Date(deliveryStartedAt).toISOString(),
      durationMs: Date.now() - deliveryStartedAt, source: 'qqbot-adapter', freshness: 'local',
      resultCategory: category, retryCount: 0,
      contentHash: reply.mediaUrl ? await contentHashOfFile(reply.mediaUrl) : '',
    });
  };
  let adapterReady = false;
  let deliveryRecorded = false;
  try {
    const target = qqTarget({
      isGroup: event.isGroup,
      conversationId: ctx.conversationId,
      senderId: event.senderId || ctx.senderId,
    });
    if (!target) throw new Error('missing QQ outbound target');

    const adapter = await api.runtime.channel.outbound.loadAdapter('qqbot');
    if (!adapter) throw new Error('QQ outbound adapter is unavailable');

    const common = {
      cfg: api.config,
      to: target,
      accountId: ctx.accountId,
      replyToId: event.replyToId || ctx.replyToId,
      mediaLocalRoots: [cardDir, subscriptionCardDir],
    };

    let result: any;
    let needsSeparateMarketKeyboard = false;
    const isPrivateWishlist = !event.isGroup && reply?.raw?.kind === 'wishlist';
    if (reply.mediaUrl) {
      if (!adapter.sendMedia) throw new Error('QQ outbound adapter cannot send media');
      adapterReady = true;
      const followup = /^\/w\s+/iu.test(String(reply.text || '').trim()) ? String(reply.text).trim() : '';
      const isPrivateMarketQuote = !event.isGroup && reply?.raw?.data?.kind === 'market' && reply.raw.data.viewMode !== 'trend';
      let combinedMarketCardEnabled = false;
      if (isPrivateMarketQuote) {
        try {
          combinedMarketCardEnabled = await getMarketCardPreference({
            accountId: ctx.accountId,
            senderId: event.senderId || ctx.senderId,
          });
        } catch {
          api.logger.warn?.('Warframe market card preference read failed; using compatible delivery');
        }
      }
      if (isPrivateWishlist) {
        try {
          const merged = await wishlistMergedCardEnabled(api, {
            accountId: ctx.accountId,
            senderId: event.senderId || ctx.senderId,
          });
          const combined = await sendWishlistCard({
            result: reply.raw, cfg: api.config, accountId: ctx.accountId, target,
            replyToId: event.replyToId || ctx.replyToId, mediaUrl: reply.mediaUrl,
            content: String(reply.text || ''), merged, sendMedia: sendMediaFor(adapter, common),
          });
          if (!combined.sent) throw new Error('wishlist keyboard was not applicable');
          if (combined.degraded) api.logger.warn?.(`Warframe wishlist reply degraded (mode=${String(combined.mode || 'unknown')})`);
          result = { messageId: combined.messageId || 'accepted' };
        } catch {
          api.logger.warn?.('Warframe combined wishlist reply failed; falling back to one text bubble');
          result = await adapter.sendText({ ...common, text: `${String(reply.text || '愿望单状态已更新。')}\n按钮暂不可用，请发送「愿望单」进入管理。` });
        }
      } else if (isPrivateMarketQuote && combinedMarketCardEnabled) {
        try {
          const combined = await sendMarketKeyboard({
            data: reply.raw.data,
            cfg: api.config,
            accountId: ctx.accountId,
            target,
            replyToId: event.replyToId || ctx.replyToId,
            mediaUrl: reply.mediaUrl,
            content: followup,
          });
          if (!combined.sent) throw new Error('combined market reply was not applicable');
          result = { messageId: combined.messageId };
        } catch {
          api.logger.warn?.('Warframe combined market reply failed; falling back to compatible delivery');
          needsSeparateMarketKeyboard = true;
          result = await adapter.sendMedia({ ...common, text: followup, mediaUrl: reply.mediaUrl });
        }
      } else {
        needsSeparateMarketKeyboard = isPrivateMarketQuote;
        result = await adapter.sendMedia({ ...common, text: followup, mediaUrl: reply.mediaUrl });
      }
    } else {
      if (!adapter.sendText) throw new Error('QQ outbound adapter cannot send text');
      adapterReady = true;
      if (isPrivateWishlist) {
        try {
          const merged = await wishlistMergedCardEnabled(api, {
            accountId: ctx.accountId,
            senderId: event.senderId || ctx.senderId,
          });
          const combined = await sendWishlistCard({
            result: reply.raw, cfg: api.config, accountId: ctx.accountId, target,
            replyToId: event.replyToId || ctx.replyToId, content: String(reply.text || ''),
            merged, sendMedia: sendMediaFor(adapter, common),
          });
          if (!combined.sent) throw new Error('wishlist keyboard was not applicable');
          result = { messageId: combined.messageId || 'accepted' };
        } catch {
          api.logger.warn?.('Warframe wishlist keyboard delivery failed; primary text remains available');
          result = await adapter.sendText({ ...common, text: String(reply.text || 'Warframe 快捷命令未能生成结果。') });
        }
      } else result = await adapter.sendText({ ...common, text: String(reply.text || 'Warframe 快捷命令未能生成结果。') });
    }
    if (result?.error) {
      await recordDelivery(deliveryResultCategory(result));
      deliveryRecorded = true;
      throw new Error(`QQ delivery failed: ${String(result.error)}`);
    }
    if (needsSeparateMarketKeyboard) {
      try {
        await sendMarketKeyboard({
          data: reply.raw.data,
          cfg: api.config,
          accountId: ctx.accountId,
          target,
          replyToId: event.replyToId || ctx.replyToId,
        });
      } catch {
        api.logger.warn?.('Warframe market keyboard delivery failed; primary quote remains available');
      }
    }
    await recordDelivery(deliveryResultCategory(result));
    deliveryRecorded = true;
  } catch (error) {
    if (!deliveryRecorded) {
      await recordDelivery(adapterReady ? 'delivery-failed' : deliveryResultCategory(null, false));
    }
    throw error;
  }
}

async function marketCardPreferenceReply(api: any, event: any, ctx: any, command: any): Promise<any> {
  if (Boolean(event.isGroup || agentContextIsGroup(ctx))) {
    return { text: 'wm 卡片设置仅支持 QQ 私聊。', isError: true };
  }
  const identity = { accountId: ctx.accountId, senderId: event.senderId || ctx.senderId };
  let enabled: boolean;
  if (command.enabled === null) enabled = await getMarketCardPreference(identity);
  else enabled = await setMarketCardPreference({ ...identity, enabled: command.enabled });
  return {
    text: enabled
      ? 'wm 单条选项卡已开启。之后私聊查价会把图片、1号卖家和选项按钮合并在一条消息里。发送“wm卡片 关”可恢复。'
      : 'wm 单条选项卡已关闭。之后私聊查价会继续使用兼容的分开发送。发送“wm卡片 开”可启用。',
  };
}

// 愿望卡总开关的读取端：默认「一体卡」（见 qq-wishlist-card-preferences.mjs）。
// 偏好文件损坏、键缺失或没有可信发送者时按兼容拆分处理——拆分的按钮气泡同样
// 可操作，绝不会因为偏好问题让通知卡投不出去。
async function wishlistMergedCardEnabled(api: any, identity: { accountId?: string; senderId?: string; target?: string }): Promise<boolean> {
  const accountId = String(identity?.accountId || 'default').trim() || 'default';
  const senderId = String(identity?.senderId || String(identity?.target || '').match(/^qqbot:c2c:([^:]+)$/iu)?.[1] || '').trim();
  if (!senderId) return false;
  try {
    return await getWishlistCardMerged({ accountId, senderId, filePath: wishlistCardPreferenceFile });
  } catch {
    api?.logger?.warn?.('Warframe wishlist card preference read failed; using compatible split delivery');
    return false;
  }
}

async function wishlistCardPreferenceReply(api: any, event: any, ctx: any, command: any): Promise<any> {
  if (Boolean(event.isGroup || agentContextIsGroup(ctx))) {
    return { text: '愿望卡设置仅支持 QQ 私聊。', isError: true };
  }
  const identity = { accountId: ctx.accountId, senderId: event.senderId || ctx.senderId };
  let merged: boolean;
  if (command.merged === null) merged = await getWishlistCardMerged({ ...identity, filePath: wishlistCardPreferenceFile });
  else merged = await setWishlistCardMerged({ ...identity, merged: command.merged, filePath: wishlistCardPreferenceFile });
  const label = merged
    ? '一体卡：图片、文案和按钮合并在同一条消息里'
    : '分开发送：先发文本＋按钮，再补一张图片';
  if (command.merged === null) return { text: `愿望卡当前为${label}。发送“愿望卡 ${merged ? '关' : '开'}”可切换。` };
  return { text: `愿望卡已切换为${label}。${merged ? '发送“愿望卡 关”可改为分开发送。' : '发送“愿望卡 开”可恢复一体卡。'}` };
}

function installMarketTrendInteractionBridge(api: any): () => void {
  const bridge = ({ accountId, event, acknowledge }: any): boolean => {
    const senderId = String(event?.user_openid || '').trim().toLowerCase();
    const buttonData = event?.data?.resolved?.button_data;
    const identity = { accountId, senderId };
    const wishlistAction = wishlistInteractions.acquire(buttonData, identity);
    if (wishlistAction.matched) {
      void Promise.resolve(acknowledge(0)).catch(() => api.logger.warn?.('Warframe wishlist interaction ACK failed'));
      void (async () => {
        const ctx = { accountId, senderId, conversationId: senderId };
        const ingressEvent = { channel: 'qqbot', content: '', conversationId: senderId, senderId, isGroup: false };
        if (!wishlistAction.ok) {
          await sendDirectQQReply(api, ingressEvent, ctx, { text: wishlistAction.reason === 'actor-mismatch' ? '这个按钮不属于当前玩家。' : wishlistAction.reason === 'busy' ? '这个操作正在处理中，请稍候。' : '这个按钮已失效，请重新打开愿望单。', isError: true });
          return;
        }
        try {
          const module = await import(pathToFileURL(wishlistScript).href);
          const ledger = await module.readWishlistLedger(wishlistState);
          const wish = (ledger.wishes || []).find((entry: any) => entry.id === wishlistAction.wishId && entry.ownerId === senderId && entry.target === `qqbot:c2c:${senderId}`);
          if (!wish) throw new Error('wishlist item is unavailable');
          if (wishlistAction.action === 'query') {
            ingressEvent.content = wishlistMarketCommand(wish);
            const reply = await handleFastCommand(api, ingressEvent, 'qq-wishlist-interaction');
            if (!reply) throw new Error('wishlist market query produced no reply');
            await sendDirectQQReply(api, ingressEvent, ctx, reply);
            return;
          }
          if (wishlistAction.action === 'select') {
            await sendDirectQQReply(api, ingressEvent, ctx, {
              text: `${wish.zhName || wish.itemName} · 上限 ${wish.maxPrice}p`,
              raw: { ok: true, kind: 'wishlist', command: 'select', wish },
            });
            return;
          }
          const commandMap: Record<string, string> = {
            bought: '已购', pause: '暂停', resume: '继续', cancel: '取消',
            undo_bought: '撤销已购', undo_cancel: '撤销取消',
          };
          const verb = commandMap[wishlistAction.action];
          if (!verb) throw new Error('unknown wishlist interaction');
          ingressEvent.content = `${verb} ${wish.id}`;
          await runWishlistCommandUseCase(api, {
            source: 'qq-wishlist-interaction', text: ingressEvent.content, channel: 'qqbot',
            target: `qqbot:c2c:${senderId}`, actorId: senderId, actorDisplayName: senderId,
            isGroup: false, cardDir: subscriptionCardDir, expectedUpdatedAt: wishlistAction.expectedUpdatedAt,
          }, async (result: any) => {
            await sendDirectQQReply(api, ingressEvent, ctx, { text: result.text, ...(result.mediaUrl ? { mediaUrl: result.mediaUrl } : {}), raw: result, isError: result.ok === false });
            return { accepted: true, mediaDelivered: Boolean(result.mediaUrl) };
          });
        } finally {
          wishlistInteractions.release(buttonData, identity);
        }
      })().catch((error) => {
        api.logger.error(`Warframe wishlist interaction failed: ${String(error)}`);
      });
      return true;
    }
    const resolved = marketTrendInteractions.acquire(buttonData, identity);
    if (!resolved.matched) return false;
    void Promise.resolve(acknowledge(0)).catch(() => {
      api.logger.warn?.('Warframe market trend interaction ACK failed');
    });
    void (async () => {
      const ctx = { accountId, senderId, conversationId: senderId };
      const ingressEvent = {
        channel: 'qqbot', content: resolved.ok ? `wm ${resolved.query} 走势` : '',
        conversationId: senderId, senderId, isGroup: false,
      };
      if (!resolved.ok) {
        await sendDirectQQReply(api, ingressEvent, ctx, {
          text: resolved.reason === 'actor-mismatch'
            ? '这个走势按钮不属于当前玩家。'
            : resolved.reason === 'busy'
              ? '走势图正在生成，请稍候。'
              : '这个走势按钮已失效，请重新查价。',
          isError: true,
        });
        return;
      }
      try {
        const reply = await handleFastCommand(api, ingressEvent, 'qq-market-interaction');
        if (!reply) throw new Error('trend interaction produced no reply');
        await sendDirectQQReply(api, ingressEvent, ctx, reply);
      } finally {
        marketTrendInteractions.release(buttonData, identity);
      }
    })().catch((error) => {
      api.logger.error(`Warframe market trend interaction failed: ${String(error)}`);
    });
    return true;
  };
  (globalThis as any)[QQ_MARKET_INTERACTION_BRIDGE] = bridge;
  return () => {
    if ((globalThis as any)[QQ_MARKET_INTERACTION_BRIDGE] === bridge) delete (globalThis as any)[QQ_MARKET_INTERACTION_BRIDGE];
  };
}

async function runWishlistIngressUseCase(api: any, event: any, ctx: any, source: string): Promise<any> {
  const target = qqTarget({
    isGroup: event.isGroup,
    conversationId: ctx?.conversationId || event.conversationId,
    senderId: event.senderId || ctx?.senderId,
  });
  const actorId = String(event.senderId || ctx?.senderId || '').trim().toLowerCase();
  const outcome = await runWishlistCommandUseCase(api, {
    source,
    text: String(event.content || event.body || event.cleanedBody || ''),
    channel: String(event.channel || ctx?.messageProvider || ctx?.channel || '').trim().toLowerCase(),
    target,
    actorId,
    actorDisplayName: String(event.senderName || event.senderUsername || ctx?.channelContext?.sender?.name || actorId),
    isGroup: Boolean(event.isGroup || agentContextIsGroup(ctx)),
    cardDir: subscriptionCardDir,
  }, async (result: any) => {
    const warning = String(result?.warning || '').trim();
    await sendDirectQQReply(api, event, ctx, {
      text: result?.text || '愿望单已更新。',
      ...(result?.mediaUrl ? { mediaUrl: result.mediaUrl, trustedLocalMedia: true } : {}),
      replyToId: event.messageId,
      isError: result?.ok === false || Boolean(warning),
      raw: result,
    });
    if (warning) {
      await sendDirectQQReply(api, event, ctx, {
        text: `⚠️ ${warning}`,
        replyToId: event.messageId,
        isError: true,
      });
    }
    return { accepted: true, mediaDelivered: Boolean(result?.mediaUrl) };
  });
  if (!outcome.delivery.accepted) throw new Error(outcome.result?.text || 'wishlist primary delivery failed');
  return outcome;
}

const warframeToolSchema = {
  type: 'object',
  properties: {
    operation: {
      type: 'string',
      enum: ['command', 'lookup', 'subscription', 'subscription_diagnosis'],
      description: 'command=生成既有查询/愿望单/个人/周常卡；lookup=查底层白名单资料；subscription=管理订阅；subscription_diagnosis=查订阅检查、匹配和提醒审计。',
    },
    query: {
      type: 'string',
      minLength: 1,
      maxLength: 300,
      description: '提取并规范化后的命令。不要把解释、寒暄或整段用户原话塞进来。',
    },
  },
  required: ['operation', 'query'],
  additionalProperties: false,
};

function jsonToolResult(value: any): any {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    details: value,
  };
}

async function runJsonScript(script: string, args: string[], timeoutMs = 60_000, extraEnv: Record<string, string> = {}): Promise<any> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [script, ...args], {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
      env: { ...process.env, WARFRAME_CARD_DIR: cardDir, ...extraEnv },
    });
    return JSON.parse(stdout);
  } catch (error: any) {
    const stdout = String(error?.stdout || '').trim();
    if (stdout) {
      try { return JSON.parse(stdout); } catch { /* use sanitized error below */ }
    }
    return { ok: false, error: String(error?.message || error) };
  }
}

async function runSubscriptionCommandUseCase(api: any, request: any): Promise<any> {
  return executeSubscriptionUseCase(request, {
    manage: (command: any) => runJsonScript(subscriptionScript, [
      'manage', '--state', subscriptionState,
      '--message', command.text, '--target', command.target, '--owner', command.actorId,
      '--owner-name', command.actorDisplayName,
      '--personal-allowed', command.personalAllowed ? 'true' : 'false',
    ], 15_000),
    syncMonitors: (target: string, actions: any) => syncSubscriptionMonitors(api, target, actions),
    log: (_level: string, message: string, error: unknown) => {
      api.logger.error(`Warframe ${message}: ${String(error)}`);
    },
  });
}

async function runWeeklyCommandUseCase(api: any, request: any): Promise<any> {
  const { executeWeeklyUseCase } = await import(pathToFileURL(weeklyUsecaseScript).href);
  return executeWeeklyUseCase(request, {
    manage: (command: any) => runJsonScript(weeklyScript, [
      'manage', '--state', weeklyState,
      '--message', command.text, '--target', command.target, '--owner', command.actorId,
      '--owner-name', command.actorDisplayName, '--card-dir', command.cardDir || cardDir,
    ], 45_000),
    log: (_level: string, message: string, error: unknown) => {
      api.logger.error(`Warframe ${message}: ${String(error)}`);
    },
  });
}

async function runPersonalCommandUseCase(api: any, request: any): Promise<any> {
  const { executePersonalUseCase } = await import(pathToFileURL(personalUsecaseScript).href);
  return executePersonalUseCase(request, {
    execute: async (command: any) => {
      const env: Record<string, string> = {};
      if (command.request) {
        const { encodeCommandRequest } = await import(pathToFileURL(path.resolve(skillDir, 'scripts', 'command-request.mjs')).href);
        env.WARFRAME_COMMAND_REQUEST = encodeCommandRequest(command.request);
      }
      return runJsonScript(alecaScript, ['parse', command.text], 60_000, env);
    },
    log: (_level: string, message: string, error: unknown) => {
      api.logger.error(`Warframe ${message}: ${String(error)}`);
    },
  });
}

async function runPublicCommandUseCase(api: any, request: any): Promise<any> {
  const { executePublicUseCase } = await import(pathToFileURL(publicUsecaseScript).href);
  return executePublicUseCase(request, {
    queryArbitration: () => runJsonScript(subscriptionScript, ['query-arbitration', '--state', subscriptionState, '--card-dir', cardDir]),
    queryIntel: (command: any) => runJsonScript(subscriptionScript, ['query-intel', '--type', command.intelType, '--state', subscriptionState, '--card-dir', cardDir]),
    runPersonalTrader: () => runJsonScript(alecaScript, ['parse', '奸商推荐']),
    runShortcut: async (command: any) => runJsonScript(shortcutScript, ['parse', command.text], 60_000, {
      WARFRAME_PERSONAL_OK: command.personalAllowed ? '1' : '',
      ...(command.request ? {
        WARFRAME_COMMAND_REQUEST: (await import(pathToFileURL(path.resolve(skillDir, 'scripts', 'command-request.mjs')).href)).encodeCommandRequest(command.request),
      } : {}),
      ...(command.trace ? {
        WARFRAME_TRACE_STORE: command.trace.storePath,
        WARFRAME_TRACE_ID: command.trace.traceId,
        WARFRAME_TRACE_TRIGGER: command.trace.triggerType,
      } : {}),
    }),
    log: (_level: string, message: string, error: unknown) => api.logger.error(`Warframe ${message}: ${String(error)}`),
  });
}

function toolTarget(ctx: any): string | null {
  const sender = String(ctx?.requesterSenderId || '').trim().toLowerCase();
  const rawTo = String(ctx?.deliveryContext?.to || '').trim().toLowerCase();
  if (/^qqbot:(?:c2c|group):/u.test(rawTo)) return rawTo;
  if (toolIsGroup(ctx) && rawTo) return `qqbot:group:${rawTo}`;
  if (sender) return `qqbot:c2c:${sender}`;
  return null;
}

function toolIsGroup(ctx: any): boolean {
  const hints = [ctx?.messageChannel, ctx?.sessionKey, ctx?.deliveryContext?.to]
    .filter(Boolean).join(':').toLowerCase();
  return /(?:^|:)(?:group|guild|channel)(?::|$)/u.test(hints);
}

function decorateToolResult(result: any, mediaDelivered = false, operation = 'command', query = ''): any {
  const mediaUrl = String(result?.mediaUrl || '').trim();
  const evidence = buildEvidenceEnvelope(result, operation, query);
  const decorated = { ...result, evidence, answerPolicy: STATE_ASSERTION_POLICY };
  if (!mediaUrl) return decorated;
  if (mediaDelivered) {
    return {
      ...decorated,
      mediaDelivered: true,
      presentation: `卡片已经由工具直接发送到当前 QQ 会话。最终回复只需简短解释，不要再输出 <qqimg>、MEDIA: 或重复发送图片。${STATE_ASSERTION_POLICY}`,
    };
  }
  return {
    ...decorated,
    presentation: `卡片已生成。最终回复必须原样包含 <qqimg>${mediaUrl}</qqimg>，再按用户问题简短解释；不要声称没有数据。${STATE_ASSERTION_POLICY}`,
  };
}

async function sendToolMedia(api: any, ctx: any, mediaUrl: string): Promise<boolean> {
  const channel = String(ctx?.messageChannel || ctx?.deliveryContext?.channel || '').trim().toLowerCase();
  const target = toolTarget(ctx);
  if (channel !== 'qqbot' || !target || !mediaUrl) return false;
  try {
    const adapter = await api.runtime.channel.outbound.loadAdapter('qqbot');
    if (!adapter?.sendMedia) return false;
    const result = await adapter.sendMedia({
      cfg: ctx?.getRuntimeConfig?.() || ctx?.runtimeConfig || ctx?.config || api.config,
      to: target,
      accountId: ctx?.deliveryContext?.accountId || ctx?.agentAccountId,
      threadId: ctx?.deliveryContext?.threadId,
      text: '',
      mediaUrl,
      mediaLocalRoots: [cardDir, subscriptionCardDir],
    });
    if (result?.error) throw new Error(String(result.error));
    return true;
  } catch (error) {
    api.logger.error(`Warframe tool card direct delivery failed, falling back to model tag: ${String(error)}`);
    return false;
  }
}

function createWarframeTool(api: any, ctx: any): any {
  const sender = String(ctx?.requesterSenderId || '').trim().toLowerCase();
  const target = toolTarget(ctx);
  const channel = String(ctx?.messageChannel || ctx?.deliveryContext?.channel || '').trim().toLowerCase();
  const personalAllowed = channel === 'qqbot' && !toolIsGroup(ctx)
    && (ctx?.senderIsOwner === true || isExactOwner(api, sender));

  async function runWishlistToolUseCase(query: string, operation: string): Promise<any> {
    const outcome = await runWishlistCommandUseCase(api, {
      source: `tool-${operation}`,
      text: query,
      channel,
      target,
      actorId: sender,
      actorDisplayName: sender,
      isGroup: toolIsGroup(ctx),
      cardDir,
    }, async (result: any) => {
      const mediaUrl = String(result?.mediaUrl || '').trim();
      const mediaDelivered = mediaUrl ? await sendToolMedia(api, ctx, mediaUrl) : false;
      // The model fallback is returned only after this use case completes. If
      // an action needs an immediate market follow-up, require the primary card
      // to be accepted now so a follow-up can never overtake it.
      const accepted = wishlistNeedsImmediateInspection(result) ? mediaDelivered : true;
      return { accepted, mediaDelivered };
    });
    return jsonToolResult(decorateToolResult(
      outcome.result,
      outcome.delivery.mediaDelivered,
      operation,
      query,
    ));
  }

  async function runSubscriptionToolUseCase(query: string, operation: string): Promise<any> {
    const outcome = await runSubscriptionCommandUseCase(api, {
      source: `tool-${operation}`,
      text: query,
      channel,
      target,
      actorId: sender,
      actorDisplayName: sender,
      personalAllowed,
      isGroup: toolIsGroup(ctx),
    });
    // A legacy model may select operation=command, but the canonical evidence
    // scope remains the subscription ledger for every entry path.
    return jsonToolResult(decorateToolResult(outcome.result, false, 'subscription', query));
  }

  async function runWeeklyToolUseCase(query: string): Promise<any> {
    const outcome = await runWeeklyCommandUseCase(api, {
      source: 'tool-command',
      text: query,
      channel,
      target,
      actorId: sender,
      actorDisplayName: sender,
      personalAllowed,
      isGroup: toolIsGroup(ctx),
      cardDir,
    });
    const result = outcome.result;
    const mediaUrl = String(result?.mediaUrl || '').trim();
    const mediaDelivered = mediaUrl ? await sendToolMedia(api, ctx, mediaUrl) : false;
    return jsonToolResult(decorateToolResult(result, mediaDelivered, 'command', query));
  }

  async function runPersonalToolUseCase(query: string): Promise<any> {
    const outcome = await runPersonalCommandUseCase(api, {
      source: 'tool-command',
      text: query,
      channel,
      target,
      actorId: sender,
      actorDisplayName: sender,
      personalAllowed,
      isGroup: toolIsGroup(ctx),
      cardDir,
    });
    const result = outcome.result;
    const mediaUrl = String(result?.mediaUrl || '').trim();
    const mediaDelivered = mediaUrl ? await sendToolMedia(api, ctx, mediaUrl) : false;
    return jsonToolResult(decorateToolResult(result, mediaDelivered, 'command', query));
  }

  async function runPublicToolUseCase(query: string): Promise<any> {
    const outcome = await runPublicCommandUseCase(api, {
      source: 'tool-command', text: query, channel, target, actorId: sender,
      personalAllowed, isGroup: toolIsGroup(ctx), cardDir,
    });
    const result = outcome.result;
    const mediaUrl = String(result?.mediaUrl || '').trim();
    const mediaDelivered = mediaUrl ? await sendToolMedia(api, ctx, mediaUrl) : false;
    rememberShortCommandContext({}, ctx, result, personalAllowed);
    return jsonToolResult(decorateToolResult(result, mediaDelivered, 'command', query));
  }

  return {
    name: 'warframe_assistant',
    label: 'Warframe Assistant',
    description: [
      '处理所有 Warframe/星际战甲事实查询与操作。凡用户在问实时状态、价格、遗物、裂缝、掉落、配方、商人、库存、紫卡、周报/周常或订阅，都应先调用本工具，不要凭模型记忆回答。',
      `operation=command 时 query 必须是注册表中的规范命令（如：${commandToolSummary()}）。用户说“哪里刷/怎么刷/哪里买/在哪换”时，提取实体后改写为获取/购买规范命令。`,
      'operation=lookup 用于不适合卡片的底层资料，query 格式只能是：worldstate 板块、vendor 商人、dict 词、drops 关键词、recipe 名字、bounties、sp-incursions、item /Lotus/...。问某武器灵化安装材料时直接用 recipe <武器名>灵化之源，不要逐步试探多个查询。',
      'operation=subscription 用于用户明确要求新增、取消、暂停、恢复或列出订阅，query 使用规范订阅命令。个人数据和写操作会由可信会话身份强制鉴权。可为一个复合问题多次调用。',
      'operation=subscription_diagnosis 用于“为什么没提醒、上次提醒后又出现过吗、多久没轮换到、是不是漏推送”等历史/故障问题；query 只传物品或订阅条件。不得用静态 drops 查询替代。',
      DYNAMIC_QUERY_POLICY,
    ].join(' '),
    parameters: warframeToolSchema,
    async execute(_toolCallId: string, raw: any) {
      const operation = String(raw?.operation || '').trim();
      const query = String(raw?.query || '').normalize('NFKC').trim();
      if (!query || query.length > 300) return jsonToolResult({ ok: false, error: 'query 不能为空且最多 300 字。' });

      if (operation === 'command') {
        if (isWishlistCommand(query)) {
          return runWishlistToolUseCase(query, operation);
        }
        if (isSubscriptionCommand(query)) {
          return runSubscriptionToolUseCase(query, operation);
        }
        if (isWeeklyCommand(query)) {
          return runWeeklyToolUseCase(query);
        }
        if (isPersonalAccountCommand(query)) {
          return runPersonalToolUseCase(query);
        }
        return runPublicToolUseCase(query);
      }

      if (operation === 'lookup') {
        const match = query.match(/^(worldstate|vendor|dict|drops|recipe|bounties|sp-incursions|item)(?:\s+([\s\S]+))?$/u);
        if (!match) return jsonToolResult({ ok: false, error: 'lookup 只允许 worldstate/vendor/dict/drops/recipe/bounties/sp-incursions/item。' });
        if (match[1] === 'item' && !String(match[2] || '').trim().startsWith('/Lotus/')) {
          return jsonToolResult({ ok: false, error: 'item 只接受 /Lotus/... 路径。' });
        }
        const args = [match[1], ...(match[2] ? [match[2].trim()] : [])];
        return jsonToolResult(decorateToolResult(await runJsonScript(lookupScript, args), false, operation, query));
      }

      if (operation === 'subscription') {
        // 兼容旧模型仍把「愿望 商品 价格」标成 subscription；愿望单
        // 使用自己的 ledger 与单例 gateway，不进入世界状态订阅解析器。
        if (isWishlistCommand(query)) {
          return runWishlistToolUseCase(query, operation);
        }
        return runSubscriptionToolUseCase(query, operation);
      }

      if (operation === 'subscription_diagnosis') {
        if (channel && channel !== 'qqbot') return jsonToolResult({ ok: false, error: '订阅诊断只允许从 QQ 会话发起。' });
        if (!target || !sender) return jsonToolResult({ ok: false, error: '当前会话缺少可信 QQ 身份，不能查询订阅记录。' });
        const result = await runJsonScript(subscriptionScript, [
          'diagnose', '--state', subscriptionState,
          '--query', query, '--target', target, '--owner', sender,
        ], 15_000);
        const deliveryAudit = await subscriptionDeliveryAudit(api, target);
        return jsonToolResult(decorateToolResult({ ...result, deliveryAudit }, false, operation, query));
      }

      return jsonToolResult({ ok: false, error: 'operation 必须是 command、lookup、subscription 或 subscription_diagnosis。' });
    },
  };
}

export default definePluginEntry({
  id: 'warframe-fast-commands',
  name: 'Warframe Fast Commands',
  description: 'Read-only Warframe market, relic, fissure, local account snapshot and persistent subscription commands for QQ.',
  register(api) {
    const removeMarketTrendInteractionBridge = installMarketTrendInteractionBridge(api);
    api.registerTool((ctx) => createWarframeTool(api, ctx), { name: 'warframe_assistant' });
    api.on('gateway_start', async () => {
      await startWishlistGateway(api);
    });
    api.on('gateway_stop', async () => {
      removeMarketTrendInteractionBridge();
      await stopWishlistGateway();
    });
    // 对时效/订阅故障问句做每轮确定性约束。只注入“必须走哪类工具”，
    // 物品和参数仍由模型从自然语言提取，避免退化成关键词命令表。
    // R18 片：上下文合成边界（门禁文本 + 短命令指代桥接 + 字节上限与过期降级）
    // 全部收敛到 ./prompt-context.mjs 的纯函数，本钩子只做输入组装。
    api.on('before_prompt_build', async (event, ctx) => {
      const intent = classifyNaturalWarframeQuery(event.prompt);
      const key = contextBridgeKey(event, ctx);
      const composed = composePromptContext({
        intent,
        prompt: event.prompt,
        messages: event.messages || [],
        bridged: key ? shortCommandContext.consumePrompt(key) : '',
      });
      if (composed) return { prependContext: composed.prependContext };
    }, { priority: 1800 });
    // 长期会话可能仍保留旧版“直接 exec 脚本”的上下文。阻止模型绕过注册工具，
    // 让它收到明确错误后改调 warframe_assistant；插件自己的 execFile 不经过此钩子。
    api.on('before_tool_call', async (event) => {
      if (event.toolName !== 'exec') return;
      const command = String(event.params?.command || '');
      if (!/warframe-assistant[\\/].*scripts[\\/](?:dispatch|shortcuts|lookup|subscriptions|weekly|alecaframe|wishlist|warframe)\.mjs/iu.test(command)) return;
      return {
        block: true,
        blockReason: 'Warframe 查询脚本不得通过 exec 直接运行；请改用 warframe_assistant 结构化工具，以确保 QQ 卡片可靠投递和个人权限校验。',
      };
    }, { priority: 1900 });
    // This is the authoritative QQ ingress gate. It runs before agent/model
    // dispatch, sends the deterministic card through QQ's native outbound
    // adapter, and then consumes the turn so no LLM can replace the result.
    api.on('before_dispatch', async (event, ctx) => {
      const content = String(event.content || event.body || '');
      if (!isQQChannel(event.channel)) return;
      const marketCardCommand = parseMarketCardPreferenceCommand(content);
      const wishlistCardCommand = parseWishlistCardPreferenceCommand(content);
      // 非严格命令不在 ingress 猜意图，完整放行给模型调用 warframe_assistant。
      if (!marketCardCommand && !wishlistCardCommand && !isShortcut(content) && !isSubscriptionCommand(content)) return;
      api.logger.info(`Warframe before_dispatch matched: ${content.trim()}`);
      try {
        const ingressEvent = {
          channel: 'qqbot',
          content,
          conversationId: ctx.conversationId,
          senderId: event.senderId || ctx.senderId,
          senderName: event.senderName || ctx.channelContext?.sender?.name,
          senderUsername: event.senderUsername || ctx.channelContext?.sender?.username,
          isGroup: Boolean(event.isGroup || agentContextIsGroup(ctx)),
          messageId: event.replyToId || ctx.replyToId,
        };
        if (marketCardCommand) {
          const reply = await marketCardPreferenceReply(api, ingressEvent, ctx, marketCardCommand);
          await sendDirectQQReply(api, event, ctx, reply);
          api.logger.info('Warframe market card preference updated before model');
          return { handled: true };
        }
        if (wishlistCardCommand) {
          const reply = await wishlistCardPreferenceReply(api, ingressEvent, ctx, wishlistCardCommand);
          await sendDirectQQReply(api, event, ctx, reply);
          api.logger.info('Warframe wishlist card preference updated before model');
          return { handled: true };
        }
        if (isWishlistCommand(content)) {
          await runWishlistIngressUseCase(api, ingressEvent, ctx, 'before_dispatch');
          api.logger.info(`Warframe wishlist delivered before model: ${content.trim()}`);
          return { handled: true };
        }
        const reply = await handleFastCommand(api, {
          ...ingressEvent,
        }, 'qq-before-dispatch');
        if (!reply) throw new Error('matched command produced no reply');
        await sendDirectQQReply(api, event, ctx, reply);
        const personalAllowed = !Boolean(event.isGroup || agentContextIsGroup(ctx)) && isExactOwner(api, event.senderId || ctx.senderId);
        rememberShortCommandContext(event, ctx, reply.raw, personalAllowed);
        api.logger.info(`Warframe short command delivered before model: ${content.trim()}`);
        return { handled: true };
      } catch (error) {
        api.logger.error(`Warframe hard gate failed closed: ${String(error)}`);
        return { handled: true, text: 'Warframe 模板生成或发送失败，请稍后重试。' };
      }
    }, { priority: 2000, timeoutMs: 50_000 });

    api.on('inbound_claim', async (event) => {
      const marketCardCommand = isQQChannel(event.channel)
        ? parseMarketCardPreferenceCommand(event.content)
        : null;
      const wishlistCardCommand = isQQChannel(event.channel)
        ? parseWishlistCardPreferenceCommand(event.content)
        : null;
      if (marketCardCommand) {
        try {
          const reply = await marketCardPreferenceReply(api, event, event, marketCardCommand);
          return { handled: true, reply };
        } catch (error) {
          api.logger.error(`Warframe market card preference failed closed: ${String(error)}`);
          return { handled: true, reply: { text: 'wm 卡片设置暂时无法更新，请稍后重试。', isError: true } };
        }
      }
      if (wishlistCardCommand) {
        try {
          const reply = await wishlistCardPreferenceReply(api, event, event, wishlistCardCommand);
          return { handled: true, reply };
        } catch (error) {
          api.logger.error(`Warframe wishlist card preference failed closed: ${String(error)}`);
          return { handled: true, reply: { text: '愿望卡设置暂时无法更新，请稍后重试。', isError: true } };
        }
      }
      if (isQQChannel(event.channel) && isWishlistCommand(event.content)) {
        try {
          await runWishlistIngressUseCase(api, event, event, 'inbound_claim');
          api.logger.info(`Warframe wishlist claimed by inbound_claim: ${String(event.content || '').trim()}`);
          return { handled: true };
        } catch (error) {
          api.logger.error(`Warframe wishlist inbound_claim failed closed: ${String(error)}`);
          return { handled: true, reply: { text: 'Warframe 愿望单暂时无法更新，请稍后重试。', isError: true } };
        }
      }
      const reply = await handleFastCommand(api, event);
      if (!reply) return;
      api.logger.info(`Warframe short command claimed by inbound_claim: ${String(event.content || '').trim()}`);
      return { handled: true, reply };
    }, { priority: 100, timeoutMs: 50_000 });

    // Global conversations are not necessarily plugin-bound, so inbound_claim
    // may never run. Exact Warframe commands are intentionally channel-agnostic
    // here: some inbound adapters do not populate messageProvider/channel, and
    // letting those commands fall through would make the model improvise a text
    // response instead of returning the deterministic card.
    api.on('before_agent_reply', async (event, ctx) => {
      const channel = ctx.messageProvider || ctx.channel;
      const content = String(event.cleanedBody || '');
      const marketCardCommand = isQQChannel(channel) ? parseMarketCardPreferenceCommand(content) : null;
      const wishlistCardCommand = isQQChannel(channel) ? parseWishlistCardPreferenceCommand(content) : null;
      if (!marketCardCommand && !wishlistCardCommand && !isShortcut(content) && !isSubscriptionCommand(content)) return;
      api.logger.info(
        `Warframe before_agent_reply matched: channel=${String(channel || 'unknown')} command=${content.trim()}`,
      );
      const ingressEvent = {
        channel: String(channel || '').trim().toLowerCase(),
        content,
        conversationId: ctx.channelId || ctx.chatId,
        senderId: ctx.senderId,
        senderName: ctx.channelContext?.sender?.name,
        senderUsername: ctx.channelContext?.sender?.username,
        isGroup: agentContextIsGroup(ctx),
      };
      if (marketCardCommand) {
        try {
          const reply = await marketCardPreferenceReply(api, ingressEvent, ctx, marketCardCommand);
          return { handled: true, reply, reason: 'warframe-market-card-preference' };
        } catch (error) {
          api.logger.error(`Warframe market card preference before_agent_reply failed closed: ${String(error)}`);
          return { handled: true, reply: { text: 'wm 卡片设置暂时无法更新，请稍后重试。', isError: true }, reason: 'warframe-market-card-preference-error' };
        }
      }
      if (wishlistCardCommand) {
        try {
          const reply = await wishlistCardPreferenceReply(api, ingressEvent, ctx, wishlistCardCommand);
          return { handled: true, reply, reason: 'warframe-wishlist-card-preference' };
        } catch (error) {
          api.logger.error(`Warframe wishlist card preference before_agent_reply failed closed: ${String(error)}`);
          return { handled: true, reply: { text: '愿望卡设置暂时无法更新，请稍后重试。', isError: true }, reason: 'warframe-wishlist-card-preference-error' };
        }
      }
      if (isWishlistCommand(content)) {
        try {
          await runWishlistIngressUseCase(api, ingressEvent, ctx, 'before_agent_reply');
          api.logger.info(`Warframe wishlist hard-intercepted before model: ${content.trim()}`);
          return { handled: true, reason: 'warframe-wishlist-command' };
        } catch (error) {
          api.logger.error(`Warframe wishlist before_agent_reply failed closed: ${String(error)}`);
          return { handled: true, reply: { text: 'Warframe 愿望单暂时无法更新，请稍后重试。', isError: true }, reason: 'warframe-wishlist-command-error' };
        }
      }
      const reply = await handleFastCommand(api, {
        ...ingressEvent,
      });
      api.logger.info(`Warframe short command hard-intercepted before model: ${content.trim()}`);
      return { handled: true, reply: reply || { text: 'Warframe 快捷命令未能生成结果。', isError: true }, reason: 'warframe-fast-command' };
    }, { priority: 1000, timeoutMs: 50_000 });
  },
});
