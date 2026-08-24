import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { commandToolSummary, directIntelType, isArbitrationShortcut, isPersonalAccountCommand, isShortcut, isSubscriptionCommand, isWeeklyCommand, isWishlistCommand } from './routing.mjs';
import { buildEvidenceEnvelope, STATE_ASSERTION_POLICY } from './evidence.mjs';
import { classifyNaturalWarframeQuery, DYNAMIC_QUERY_POLICY } from './intent-policy.mjs';
import { createContextBridge } from './context-bridge.mjs';
import { executeWishlistUseCase, wishlistNeedsImmediateInspection } from './wishlist-usecase.mjs';

const execFileAsync = promisify(execFile);
const pluginDir = path.dirname(fileURLToPath(import.meta.url));
const shortcutScript = path.resolve(pluginDir, '..', '..', '..', 'skills', 'warframe-assistant', 'scripts', 'shortcuts.mjs');
const dispatchScript = path.resolve(pluginDir, '..', '..', '..', 'skills', 'warframe-assistant', 'scripts', 'dispatch.mjs');
const lookupScript = path.resolve(pluginDir, '..', '..', '..', 'skills', 'warframe-assistant', 'scripts', 'lookup.mjs');
const subscriptionScript = path.resolve(pluginDir, '..', '..', '..', 'skills', 'warframe-assistant', 'scripts', 'subscriptions.mjs');
const wishlistScript = path.resolve(pluginDir, '..', '..', '..', 'skills', 'warframe-assistant', 'scripts', 'wishlist.mjs');
const dropsScript = path.resolve(pluginDir, '..', '..', '..', 'skills', 'warframe-assistant', 'scripts', 'drops.mjs');
const weeklyScript = path.resolve(pluginDir, '..', '..', '..', 'skills', 'warframe-assistant', 'scripts', 'weekly.mjs');
const alecaScript = path.resolve(pluginDir, '..', '..', '..', 'skills', 'warframe-assistant', 'scripts', 'alecaframe.mjs');
const subscriptionState = path.resolve(pluginDir, '..', '..', '..', 'state', 'warframe-subscriptions.json');
const wishlistState = path.resolve(pluginDir, '..', '..', '..', 'state', 'warframe-wishlist.json');
const dropsState = path.resolve(pluginDir, '..', '..', '..', 'state', 'warframe-drops.json');
const weeklyState = path.resolve(pluginDir, '..', '..', '..', 'state', 'warframe-weekly.json');
const cardDir = path.resolve(pluginDir, '..', '..', '..', '.cache', 'warframe-cards');
const subscriptionCardDir = path.resolve(pluginDir, '..', '..', '..', 'media', 'qqbot', 'warframe-cards');
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

function subscriptionDeclarationKey(target: string): string {
  return `warframe-assistant:subscriptions:qq:${createHash('sha1').update(target.toLowerCase()).digest('hex').slice(0, 16)}`;
}

function dropsDeclarationKey(target: string): string {
  return `warframe-assistant:drops:qq:${createHash('sha1').update(target.toLowerCase()).digest('hex').slice(0, 16)}`;
}

function wishlistDeclarationKey(target: string): string {
  return `warframe-assistant:wishlist:qq:${createHash('sha1').update(target.toLowerCase()).digest('hex').slice(0, 16)}`;
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

// WebSocket 命中由 gateway_start 的单例连接负责；每个 QQ target 只保留
// 一个低频 item-top 校准任务，避免 cron 为每个目标再开全局订单流。
async function ensureWishlistCron(api: any, target: string): Promise<void> {
  const existing = await findCronsByKey(api, wishlistDeclarationKey(target));
  const commandArgv = ['node', wishlistScript, 'deliver', '--state', wishlistState, '--target', target, '--card-dir', subscriptionCardDir];
  if (existing.length) {
    for (const job of existing) {
      const currentArgv = Array.isArray(job?.payload?.argv) ? job.payload.argv : [];
      if (JSON.stringify(currentArgv) !== JSON.stringify(commandArgv)
        || job?.delivery?.mode === 'announce'
        || Number(job?.payload?.timeoutSeconds) !== 90) {
        await runOpenclawCron([
          'edit', String(job.id), '--command-argv', JSON.stringify(commandArgv),
          '--timeout-seconds', '90', '--no-deliver', '--clear-channel', '--clear-to', '--no-best-effort-deliver',
        ]);
      }
      if (job.enabled === false) await runOpenclawCron(['enable', String(job.id)]);
    }
    return;
  }
  await runOpenclawCron([
    'add', '--name', 'Warframe 愿望单校准',
    '--description', `每 10 分钟按 item top 校准当前 QQ 会话愿望单：${target}`,
    '--declaration-key', wishlistDeclarationKey(target), '--every', '10m', '--session', 'isolated',
    '--command-argv', JSON.stringify(commandArgv), '--output-max-bytes', '16384', '--timeout-seconds', '90',
    '--no-deliver', '--json',
  ]);
}

async function removeWishlistCron(api: any, target: string): Promise<void> {
  const existing = await findCronsByKey(api, wishlistDeclarationKey(target));
  for (const job of existing) await runOpenclawCron(['rm', String(job.id)]);
}

type WishlistGatewayState = {
  stopped: boolean;
  socket: any;
  itemIds: Set<string>;
  refreshTimer: any;
  reconnectTimer: any;
  reconnectMs: number;
  liveQueue: Promise<void>;
};

let wishlistGateway: WishlistGatewayState | null = null;
let wishlistGatewayRefresh: (() => Promise<void>) | null = null;

async function sendWishlistGatewayResult(api: any, result: any): Promise<void> {
  const target = String(result?.target || '').trim();
  if (!target) return;
  const adapter = await api.runtime.channel.outbound.loadAdapter('qqbot');
  if (!adapter) return;
  const common = { cfg: api.config, to: target, mediaLocalRoots: [subscriptionCardDir, cardDir] };
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
      render: false,
    });
    const hits = Array.isArray(result?.data?.hits) ? result.data.hits : [];
    if (!hits.length) return { ok: true, hitCount: 0, marketCards: 0, deliveries: [] };
    const shortcuts = await import(pathToFileURL(shortcutScript).href);
    const uniqueWishes = [...new Map(hits.map((hit: any) => [String(hit?.wishId || hit?.wish?.id || ''), hit?.wish])).values()].filter(Boolean);
    let marketCards = 0;
    const deliveries = [];
    for (const wish of uniqueWishes as any[]) {
      const market = await shortcuts.runShortcut(wishlistMarketCommand(wish), { cardDir: subscriptionCardDir });
      const qualifying = (market?.data?.sell || []).filter((order: any) => {
        const perTrade = Math.max(1, Number(order?.perTrade) || 1);
        return Number(order?.platinum) / perTrade <= Number(wish.maxPrice);
      });
      if (!market?.ok || !market?.mediaUrl || !qualifying.length) continue;
      const contact = String(market?.data?.contactTemplate || '').trim();
      const text = [
        `当前已有 ${qualifying.length} 条卖单符合愿望 ${String(wish.id || '')}（≤${Number(wish.maxPrice)}p），直接给你最新市场行情。愿望仍会继续监控。`,
        contact,
      ].filter(Boolean).join('\n');
      deliveries.push({ target, mediaUrl: market.mediaUrl, text });
      marketCards += 1;
    }
    return { ok: true, hitCount: hits.length, marketCards, deliveries };
  } catch (error) {
    // The wish is already durable and the singleton websocket remains active.
    // The 10-minute calibration cron will retry current listings later.
    api.logger.warn?.(`Warframe wishlist immediate calibration failed: ${String(error)}`);
    return { ok: false, hitCount: 0, marketCards: 0 };
  }
}

async function syncWishlistCronAction(api: any, target: string, action: string): Promise<void> {
  if (action === 'ensure') await ensureWishlistCron(api, target);
  else if (action === 'remove') await removeWishlistCron(api, target);
}

async function runWishlistCommandUseCase(api: any, request: any, enqueuePrimary: (result: any) => Promise<any>): Promise<any> {
  return executeWishlistUseCase(request, {
    manage: (command: any) => runJsonScript(wishlistScript, [
      'manage', '--state', wishlistState, '--message', command.text,
      '--target', command.target, '--owner', command.actorId,
      '--owner-name', command.actorDisplayName, '--card-dir', command.cardDir || cardDir,
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
// not spawn a script, render a card, or touch QQ delivery.
async function startWishlistGateway(api: any): Promise<void> {
  if (wishlistGateway && !wishlistGateway.stopped) return;
  const state: WishlistGatewayState = {
    stopped: false, socket: null, itemIds: new Set(), refreshTimer: null, reconnectTimer: null, reconnectMs: 1000, liveQueue: Promise.resolve(),
  };
  wishlistGateway = state;
  const wishlistModule = async (): Promise<any> => import(pathToFileURL(wishlistScript).href);
  let connect: () => void;
  const refresh = async (): Promise<void> => {
    if (state.stopped) return;
    try {
      const ledger = await (await wishlistModule()).readWishlistLedger(wishlistState);
      state.itemIds = new Set((ledger.wishes || []).filter((wish: any) => wish.status === 'active' && wish.enabled).map((wish: any) => String(wish.itemId || '').trim()).filter(Boolean));
      if (!state.itemIds.size && state.socket) {
        try { state.socket.close(); } catch { /* ignore */ }
      } else if (state.itemIds.size && !state.socket && !state.reconnectTimer) {
        connect();
      }
    } catch (error) {
      api.logger.warn?.(`Warframe wishlist gateway ledger refresh failed: ${String(error)}`);
    }
  };
  wishlistGatewayRefresh = refresh;
  const scheduleReconnect = (): void => {
    if (state.stopped || !state.itemIds.size || state.reconnectTimer) return;
    const wait = state.reconnectMs;
    state.reconnectMs = Math.min(60_000, state.reconnectMs * 2);
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      connect();
    }, wait);
  };
  connect = (): void => {
    if (state.stopped || !state.itemIds.size || state.socket) return;
    const WebSocketImpl = (globalThis as any).WebSocket;
    if (typeof WebSocketImpl !== 'function') {
      api.logger.warn?.('Warframe wishlist gateway unavailable: Node WebSocket is missing');
      scheduleReconnect();
      return;
    }
    try {
      const socket = new WebSocketImpl('wss://ws.warframe.market/socket', 'wfm');
      state.socket = socket;
      socket.onopen = () => {
        state.reconnectMs = 1000;
        socket.send(JSON.stringify({ route: '@wfm|cmd/subscribe/newOrders', id: `wishlist-gateway-${Date.now().toString(36)}`, payload: { platform: 'pc', crossplay: true } }));
      };
      socket.onmessage = (event: any) => {
        state.liveQueue = state.liveQueue.then(async () => {
        let payload: any;
        try { payload = JSON.parse(String(event?.data || '')); } catch { return; }
        if (payload?.route !== '@wfm|event/subscriptions/newOrder') return;
        const order = payload.payload || payload.order || payload;
        const itemId = String(order?.itemId || order?.item?.id || '').trim();
        if (!itemId || !state.itemIds.has(itemId)) return;
        try {
          const results = await (await wishlistModule()).processWishlistLiveOrder(order, wishlistState, subscriptionCardDir);
          for (const result of results || []) await sendWishlistGatewayResult(api, result);
        } catch (error) {
          api.logger.error(`Warframe wishlist live order failed: ${String(error)}`);
        }
        }).catch((error) => api.logger.error(`Warframe wishlist live queue failed: ${String(error)}`));
      };
      socket.onerror = () => { try { socket.close(); } catch { /* ignore */ } };
      socket.onclose = () => {
        if (state.socket === socket) state.socket = null;
        scheduleReconnect();
      };
    } catch (error) {
      state.socket = null;
      api.logger.warn?.(`Warframe wishlist gateway connect failed: ${String(error)}`);
      scheduleReconnect();
    }
  };
  await refresh();
  state.refreshTimer = setInterval(refresh, 30_000);
}

async function stopWishlistGateway(): Promise<void> {
  const state = wishlistGateway;
  if (!state) return;
  state.stopped = true;
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  try { state.socket?.close?.(); } catch { /* ignore */ }
  state.socket = null;
  wishlistGateway = null;
  wishlistGatewayRefresh = null;
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

function messageText(value: any): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => messageText(item?.text || item?.content || '')).join(' ');
  return messageText(value?.content || value?.text || '');
}

function hasWarframeContext(prompt: string, messages: any[]): boolean {
  const recent = [prompt, ...messages.slice(-8).map(messageText)].join(' ');
  return /(?:Warframe|星际战甲|赏金|悬赏|遗物|裂缝|仲裁|尖刃弹头|Bladed Rounds|Prime|杜卡德|虚空商人|AlecaFrame|WFInfo)/iu.test(recent);
}

async function handleFastCommand(api: any, event: any): Promise<any | undefined> {
  if (!isQQChannel(event.channel) || (!isShortcut(event.content) && !isSubscriptionCommand(event.content))) return;
  // Wishlist owns delivery ordering (primary feedback before immediate market
  // follow-up), so every ingress hook routes it through the shared use case.
  if (isWishlistCommand(event.content)) return;
  try {
    if (isPersonalAccountCommand(event.content)) {
      if (event.isGroup || !isExactOwner(api, event.senderId)) {
        api.logger.info(`Warframe personal command denied: isGroup=${Boolean(event.isGroup)}`);
        return {
          text: '个人账号数据只允许用户本人在 QQ 私聊中查询。',
          replyToId: event.messageId,
          isError: true,
        };
      }
      const { stdout } = await execFileAsync(process.execPath, [alecaScript, 'parse', event.content], {
        timeout: 60_000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
        env: { ...process.env, WARFRAME_CARD_DIR: cardDir },
      });
      const result = JSON.parse(stdout);
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
      if (!target || !ownerId) throw new Error('missing QQ target or sender id');
      // 掉落订阅属于个人数据：只有用户私聊才允许创建，由脚本侧据此拒绝
      const personalAllowed = !event.isGroup && isExactOwner(api, event.senderId);
      const { stdout } = await execFileAsync(process.execPath, [
        subscriptionScript, 'manage', '--state', subscriptionState,
        '--message', event.content, '--target', target, '--owner', ownerId,
        '--owner-name', String(event.senderName || event.senderUsername || ownerId),
        '--personal-allowed', personalAllowed ? 'true' : 'false',
      ], {
        timeout: 15_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
      });
      const result = JSON.parse(stdout);
      let cronWarning = '';
      try {
        if (result.cronAction === 'ensure') await ensureSubscriptionCron(api, target);
        else if (result.cronAction === 'remove') await removeSubscriptionCron(api, target);
        if (result.dropsCronAction === 'ensure') await ensureDropsCron(api, target);
        else if (result.dropsCronAction === 'remove') await removeDropsCron(api, target);
      } catch (error) {
        api.logger.error(`Warframe subscription cron sync failed: ${String(error)}`);
        cronWarning = '\n⚠️ 订阅已保存，但后台任务同步失败；请稍后重试或联系管理员。';
      }
      return {
        text: `${result.text || '订阅设置已更新。'}${cronWarning}`,
        replyToId: event.messageId,
        isError: result.ok === false || Boolean(cronWarning),
      };
    }
    if (isWeeklyCommand(event.content)) {
      if (event.isGroup || !isExactOwner(api, event.senderId)) {
        api.logger.info(`Warframe weekly command denied: isGroup=${Boolean(event.isGroup)}`);
        return {
          text: '周常数据只允许用户本人在 QQ 私聊中查询或修改。',
          replyToId: event.messageId,
          isError: true,
        };
      }
      const target = qqTarget(event);
      const ownerId = String(event.senderId || '').trim().toLowerCase();
      if (!target || !ownerId) throw new Error('missing QQ target or sender id');
      const { stdout } = await execFileAsync(process.execPath, [
        weeklyScript, 'manage', '--state', weeklyState,
        '--message', event.content, '--target', target, '--owner', ownerId,
        '--owner-name', String(event.senderName || event.senderUsername || ownerId),
        '--card-dir', cardDir,
      ], {
        timeout: 45_000,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
        encoding: 'utf8',
      });
      const result = JSON.parse(stdout);
      return {
        text: result.text || '周常状态已更新。',
        ...(result.mediaUrl ? { mediaUrl: result.mediaUrl, trustedLocalMedia: true } : {}),
        replyToId: event.messageId,
        isError: result.ok === false,
        raw: result,
      };
    }
    const intelType = directIntelType(event.content);
    // 用户私聊发「虚空商人/奸商」→ 购物建议版（到货时货单×库存×余额；未到货脚本内部回退查询卡）；
    // 其他来源纯公开查询卡（2026-08-06 用户拍板方案 A）
    const personalOk = !event.isGroup && isExactOwner(api, event.senderId);
    const argv = isArbitrationShortcut(event.content)
      ? [subscriptionScript, 'query-arbitration', '--state', subscriptionState, '--card-dir', cardDir]
      : intelType === 'trader' && personalOk
        ? [alecaScript, 'parse', '奸商推荐']
        : intelType
          ? [subscriptionScript, 'query-intel', '--type', intelType, '--state', subscriptionState, '--card-dir', cardDir]
          : [shortcutScript, 'parse', event.content];
    const { stdout } = await execFileAsync(process.execPath, argv, {
      timeout: 45_000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
      encoding: 'utf8',
      // WARFRAME_PERSONAL_OK：公开命令的私聊增强门（如悬赏索引附声望列），脚本侧据此读快照
      env: { ...process.env, WARFRAME_CARD_DIR: cardDir, WARFRAME_PERSONAL_OK: personalOk ? '1' : '' },
    });
    const result = JSON.parse(stdout);
    return {
      text: result.followupText || result.text || '查询完成，但没有可显示的结果。',
      ...(result.mediaUrl ? { mediaUrl: result.mediaUrl, trustedLocalMedia: true } : {}),
      replyToId: event.messageId,
      isError: result.ok === false,
      raw: result,
    };
  } catch (error) {
    api.logger.error(`Warframe shortcut failed: ${String(error)}`);
    return {
      text: 'Warframe 查询暂时失败，请稍后重试。',
      replyToId: event.messageId,
      isError: true,
    };
  }
}

async function sendDirectQQReply(api: any, event: any, ctx: any, reply: any): Promise<void> {
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
  if (reply.mediaUrl) {
    if (!adapter.sendMedia) throw new Error('QQ outbound adapter cannot send media');
    const followup = /^\/w\s+/iu.test(String(reply.text || '').trim()) ? String(reply.text).trim() : '';
    result = await adapter.sendMedia({
      ...common,
      text: followup,
      mediaUrl: reply.mediaUrl,
    });
  } else {
    if (!adapter.sendText) throw new Error('QQ outbound adapter cannot send text');
    result = await adapter.sendText({
      ...common,
      text: String(reply.text || 'Warframe 快捷命令未能生成结果。'),
    });
  }
  if (result?.error) throw new Error(`QQ delivery failed: ${String(result.error)}`);
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
    channel: 'qqbot',
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

async function runJsonScript(script: string, args: string[], timeoutMs = 60_000): Promise<any> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [script, ...args], {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
      env: { ...process.env, WARFRAME_CARD_DIR: cardDir },
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
        if (isWeeklyCommand(query) && !personalAllowed) {
          return jsonToolResult({ ok: false, error: '周报和周常核销只允许用户本人在 QQ 私聊中操作。' });
        }
        const result = await runJsonScript(dispatchScript, [
          'run', query,
          '--personal-allowed', personalAllowed ? 'true' : 'false',
          '--target', target || 'model:public',
          '--owner', sender || 'anonymous',
          '--card-dir', cardDir,
        ]);
        const mediaUrl = String(result?.mediaUrl || '').trim();
        const mediaDelivered = mediaUrl ? await sendToolMedia(api, ctx, mediaUrl) : false;
        rememberShortCommandContext({}, ctx, result, personalAllowed);
        return jsonToolResult(decorateToolResult(result, mediaDelivered, operation, query));
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
        if (channel && channel !== 'qqbot') return jsonToolResult({ ok: false, error: '订阅写操作只允许从 QQ 会话发起。' });
        if (!target || !sender) return jsonToolResult({ ok: false, error: '当前会话缺少可信 QQ 身份，不能修改订阅。' });
        const result = await runJsonScript(subscriptionScript, [
          'manage', '--state', subscriptionState,
          '--message', query, '--target', target, '--owner', sender,
          '--owner-name', sender,
          '--personal-allowed', personalAllowed ? 'true' : 'false',
        ], 15_000);
        let cronWarning = '';
        try {
          if (result.cronAction === 'ensure') await ensureSubscriptionCron(api, target);
          else if (result.cronAction === 'remove') await removeSubscriptionCron(api, target);
          if (result.dropsCronAction === 'ensure') await ensureDropsCron(api, target);
          else if (result.dropsCronAction === 'remove') await removeDropsCron(api, target);
        } catch (error) {
          cronWarning = `；定时任务同步失败：${String(error)}`;
        }
        return jsonToolResult(decorateToolResult({ ...result, ...(cronWarning ? { warning: cronWarning } : {}) }, false, operation, query));
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
    api.registerTool((ctx) => createWarframeTool(api, ctx), { name: 'warframe_assistant' });
    api.on('gateway_start', async () => {
      await startWishlistGateway(api);
    });
    api.on('gateway_stop', async () => {
      await stopWishlistGateway();
    });
    // 对时效/订阅故障问句做每轮确定性约束。只注入“必须走哪类工具”，
    // 物品和参数仍由模型从自然语言提取，避免退化成关键词命令表。
    api.on('before_prompt_build', async (event, ctx) => {
      const contexts = [];
      const intent = classifyNaturalWarframeQuery(event.prompt);
      if (intent.requiredOperation && hasWarframeContext(event.prompt, event.messages || [])) {
        contexts.push(`[Warframe 动态查询门禁] 本轮问题属于订阅历史/漏提醒诊断。必须先调用 warframe_assistant operation=${intent.requiredOperation}，query 只传用户关注的物品或订阅条件；若还问当前轮，再追加对应 operation=command 当前查询。禁止用 lookup drops、静态 wiki 或模型记忆替代。`);
      }
      const key = contextBridgeKey(event, ctx);
      const bridged = key ? shortCommandContext.consumePrompt(key) : '';
      if (bridged) contexts.push(bridged);
      if (contexts.length) return { prependContext: contexts.join('\n') };
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
      // 非严格命令不在 ingress 猜意图，完整放行给模型调用 warframe_assistant。
      if (!isShortcut(content) && !isSubscriptionCommand(content)) return;
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
        if (isWishlistCommand(content)) {
          await runWishlistIngressUseCase(api, ingressEvent, ctx, 'before_dispatch');
          api.logger.info(`Warframe wishlist delivered before model: ${content.trim()}`);
          return { handled: true };
        }
        const reply = await handleFastCommand(api, {
          ...ingressEvent,
        });
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
      if (!isShortcut(content) && !isSubscriptionCommand(content)) return;
      api.logger.info(
        `Warframe before_agent_reply matched: channel=${String(channel || 'unknown')} command=${content.trim()}`,
      );
      const ingressEvent = {
        channel: 'qqbot',
        content,
        conversationId: ctx.channelId || ctx.chatId,
        senderId: ctx.senderId,
        senderName: ctx.channelContext?.sender?.name,
        senderUsername: ctx.channelContext?.sender?.username,
        isGroup: agentContextIsGroup(ctx),
      };
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
