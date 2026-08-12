import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { directIntelType, isPersonalAccountCommand, isShortcut, isSubscriptionCommand } from './routing.mjs';

const execFileAsync = promisify(execFile);
const pluginDir = path.dirname(fileURLToPath(import.meta.url));
const shortcutScript = path.resolve(pluginDir, '..', '..', '..', 'skills', 'warframe-assistant', 'scripts', 'shortcuts.mjs');
const dispatchScript = path.resolve(pluginDir, '..', '..', '..', 'skills', 'warframe-assistant', 'scripts', 'dispatch.mjs');
const lookupScript = path.resolve(pluginDir, '..', '..', '..', 'skills', 'warframe-assistant', 'scripts', 'lookup.mjs');
const subscriptionScript = path.resolve(pluginDir, '..', '..', '..', 'skills', 'warframe-assistant', 'scripts', 'subscriptions.mjs');
const dropsScript = path.resolve(pluginDir, '..', '..', '..', 'skills', 'warframe-assistant', 'scripts', 'drops.mjs');
const weeklyScript = path.resolve(pluginDir, '..', '..', '..', 'skills', 'warframe-assistant', 'scripts', 'weekly.mjs');
const alecaScript = path.resolve(pluginDir, '..', '..', '..', 'skills', 'warframe-assistant', 'scripts', 'alecaframe.mjs');
const subscriptionState = path.resolve(pluginDir, '..', '..', '..', 'state', 'warframe-subscriptions.json');
const dropsState = path.resolve(pluginDir, '..', '..', '..', 'state', 'warframe-drops.json');
const weeklyState = path.resolve(pluginDir, '..', '..', '..', 'state', 'warframe-weekly.json');
const cardDir = path.resolve(pluginDir, '..', '..', '..', '.cache', 'warframe-cards');
const subscriptionCardDir = path.resolve(pluginDir, '..', '..', '..', 'media', 'qqbot', 'warframe-cards');

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

async function ensureSubscriptionCron(api: any, target: string): Promise<void> {
  const existing = await findSubscriptionCrons(api, target);
  if (existing.length) {
    for (const job of existing) {
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
    '--command-argv', JSON.stringify(['node', subscriptionScript, 'monitor', '--state', subscriptionState, '--target', target, '--card-dir', subscriptionCardDir]),
    '--output-max-bytes', '16384',
    '--timeout-seconds', '45',
    '--announce', '--channel', 'qqbot', '--to', target,
    '--best-effort-deliver', '--json',
  ]);
}

async function removeSubscriptionCron(api: any, target: string): Promise<void> {
  const existing = await findSubscriptionCrons(api, target);
  for (const job of existing) await runOpenclawCron(['rm', String(job.id)]);
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
  // 主人身份优先读插件配置；allowFrom 可能是 ["*"]（任何人可对话），通配符不能当主人凭证
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

async function handleFastCommand(api: any, event: any): Promise<any | undefined> {
  if (!isQQChannel(event.channel) || (!isShortcut(event.content) && !isSubscriptionCommand(event.content))) return;
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
      // 掉落订阅属于个人数据：只有主人私聊才允许创建，由脚本侧据此拒绝
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
    // 主人私聊发「虚空商人/奸商」→ 购物建议版（到货时货单×库存×余额；未到货脚本内部回退查询卡）；
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

const warframeToolSchema = {
  type: 'object',
  properties: {
    operation: {
      type: 'string',
      enum: ['command', 'lookup', 'subscription'],
      description: 'command=生成既有查询/个人/周常卡；lookup=查底层白名单资料；subscription=管理当前 QQ 用户的订阅。',
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

function decorateToolResult(result: any, mediaDelivered = false): any {
  const mediaUrl = String(result?.mediaUrl || '').trim();
  if (!mediaUrl) return result;
  if (mediaDelivered) {
    return {
      ...result,
      mediaDelivered: true,
      presentation: '卡片已经由工具直接发送到当前 QQ 会话。最终回复只需简短解释，不要再输出 <qqimg>、MEDIA: 或重复发送图片。',
    };
  }
  return {
    ...result,
    presentation: `卡片已生成。最终回复必须原样包含 <qqimg>${mediaUrl}</qqimg>，再按用户问题简短解释；不要声称没有数据。`,
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
  return {
    name: 'warframe_assistant',
    label: 'Warframe Assistant',
    description: [
      '处理所有 Warframe/星际战甲事实查询与操作。凡用户在问实时状态、价格、遗物、裂缝、掉落、配方、商人、库存、紫卡、周报/周常或订阅，都应先调用本工具，不要凭模型记忆回答。',
      'operation=command 时 query 必须是现有规范命令，例如：wm 物品、遗物 Axi A22、裂缝、赏金、仲裁、警报、入侵、活动、突击、钢铁侵袭、虚空商人、哪里买 物品、我的库存 物品、我的遗物 代号、我的紫卡 武器、周报、完成 深层科研、开遗物、精炼推荐、杜卡德推荐、奸商推荐、商店、本周好货、轮换日历。',
      'operation=lookup 用于不适合卡片的底层资料，query 格式只能是：worldstate 板块、vendor 商人、dict 词、drops 关键词、recipe 名字、bounties、sp-incursions、item /Lotus/...。问某武器灵化安装材料时直接用 recipe <武器名>灵化之源，不要逐步试探多个查询。',
      'operation=subscription 用于用户明确要求新增、取消、暂停、恢复或列出订阅，query 使用规范订阅命令。个人数据和写操作会由可信会话身份强制鉴权。可为一个复合问题多次调用。',
    ].join(' '),
    parameters: warframeToolSchema,
    async execute(_toolCallId: string, raw: any) {
      const operation = String(raw?.operation || '').trim();
      const query = String(raw?.query || '').normalize('NFKC').trim();
      if (!query || query.length > 300) return jsonToolResult({ ok: false, error: 'query 不能为空且最多 300 字。' });

      if (operation === 'command') {
        if (/^(?:周常|当前周常|周常清单|周常列表|本周周常|周报|周常帮助|清空周常|完成\s|撤销\s|跳过\s|取消跳过\s)/u.test(query) && !personalAllowed) {
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
        return jsonToolResult(decorateToolResult(result, mediaDelivered));
      }

      if (operation === 'lookup') {
        const match = query.match(/^(worldstate|vendor|dict|drops|recipe|bounties|sp-incursions|item)(?:\s+([\s\S]+))?$/u);
        if (!match) return jsonToolResult({ ok: false, error: 'lookup 只允许 worldstate/vendor/dict/drops/recipe/bounties/sp-incursions/item。' });
        if (match[1] === 'item' && !String(match[2] || '').trim().startsWith('/Lotus/')) {
          return jsonToolResult({ ok: false, error: 'item 只接受 /Lotus/... 路径。' });
        }
        const args = [match[1], ...(match[2] ? [match[2].trim()] : [])];
        return jsonToolResult(await runJsonScript(lookupScript, args));
      }

      if (operation === 'subscription') {
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
        return jsonToolResult({ ...result, ...(cronWarning ? { warning: cronWarning } : {}) });
      }

      return jsonToolResult({ ok: false, error: 'operation 必须是 command、lookup 或 subscription。' });
    },
  };
}

export default definePluginEntry({
  id: 'warframe-fast-commands',
  name: 'Warframe Fast Commands',
  description: 'Read-only Warframe market, relic, fissure, local account snapshot and persistent subscription commands for QQ.',
  register(api) {
    api.registerTool((ctx) => createWarframeTool(api, ctx), { name: 'warframe_assistant' });
    // 长期会话可能仍保留旧版“直接 exec 脚本”的上下文。阻止模型绕过注册工具，
    // 让它收到明确错误后改调 warframe_assistant；插件自己的 execFile 不经过此钩子。
    api.on('before_tool_call', async (event) => {
      if (event.toolName !== 'exec') return;
      const command = String(event.params?.command || '');
      if (!/warframe-assistant[\\/].*scripts[\\/](?:dispatch|shortcuts|lookup|subscriptions|weekly|alecaframe|warframe)\.mjs/iu.test(command)) return;
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
        const reply = await handleFastCommand(api, {
          channel: 'qqbot',
          content,
          conversationId: ctx.conversationId,
          senderId: event.senderId || ctx.senderId,
          senderName: event.senderName || ctx.channelContext?.sender?.name,
          senderUsername: event.senderUsername || ctx.channelContext?.sender?.username,
          isGroup: Boolean(event.isGroup || agentContextIsGroup(ctx)),
          messageId: event.replyToId || ctx.replyToId,
        });
        if (!reply) throw new Error('matched command produced no reply');
        await sendDirectQQReply(api, event, ctx, reply);
        api.logger.info(`Warframe short command delivered before model: ${content.trim()}`);
        return { handled: true };
      } catch (error) {
        api.logger.error(`Warframe hard gate failed closed: ${String(error)}`);
        return { handled: true, text: 'Warframe 模板生成或发送失败，请稍后重试。' };
      }
    }, { priority: 2000, timeoutMs: 50_000 });

    api.on('inbound_claim', async (event) => {
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
      const reply = await handleFastCommand(api, {
        channel: 'qqbot',
        content,
        conversationId: ctx.channelId || ctx.chatId,
        senderId: ctx.senderId,
        senderName: ctx.channelContext?.sender?.name,
        senderUsername: ctx.channelContext?.sender?.username,
        isGroup: agentContextIsGroup(ctx),
      });
      api.logger.info(`Warframe short command hard-intercepted before model: ${content.trim()}`);
      return { handled: true, reply: reply || { text: 'Warframe 快捷命令未能生成结果。', isError: true }, reason: 'warframe-fast-command' };
    }, { priority: 1000, timeoutMs: 50_000 });
  },
});
