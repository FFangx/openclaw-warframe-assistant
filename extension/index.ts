import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

const execFileAsync = promisify(execFile);
const pluginDir = path.dirname(fileURLToPath(import.meta.url));
const shortcutScript = path.resolve(pluginDir, '..', '..', '..', 'skills', 'warframe-assistant', 'scripts', 'shortcuts.mjs');
const subscriptionScript = path.resolve(pluginDir, '..', '..', '..', 'skills', 'warframe-assistant', 'scripts', 'subscriptions.mjs');
const dropsScript = path.resolve(pluginDir, '..', '..', '..', 'skills', 'warframe-assistant', 'scripts', 'drops.mjs');
const weeklyScript = path.resolve(pluginDir, '..', '..', '..', 'skills', 'warframe-assistant', 'scripts', 'weekly.mjs');
const alecaScript = path.resolve(pluginDir, '..', '..', '..', 'skills', 'warframe-assistant', 'scripts', 'alecaframe.mjs');
const subscriptionState = path.resolve(pluginDir, '..', '..', '..', 'state', 'warframe-subscriptions.json');
const dropsState = path.resolve(pluginDir, '..', '..', '..', 'state', 'warframe-drops.json');
const weeklyState = path.resolve(pluginDir, '..', '..', '..', 'state', 'warframe-weekly.json');
const cardDir = path.resolve(pluginDir, '..', '..', '..', '.cache', 'warframe-cards');
const subscriptionCardDir = path.resolve(pluginDir, '..', '..', '..', 'media', 'qqbot', 'warframe-cards');

function isShortcut(content: string): boolean {
  const text = String(content || '').normalize('NFKC').trim();
  return /^\/?wm(?![a-z])/iu.test(text)
    || /^\/?遗物(?:\s+|$)/u.test(text)
    || /^\/?(?:裂缝推荐|推荐裂缝)(?:\s+|$)/u.test(text)
    || /^\/?(?:(?:钢铁|普通|全能|安魂)(?:虚空)?|虚空)?裂缝(?:\s+|$)/iu.test(text)
    || /^\/?(?:帮助|help|菜单|功能|功能列表|命令列表|使用说明|说明书|怎么用)$/iu.test(text)
    // 哪里买：全商人反查（非个人）；「哪里买 X」与「X哪里买」两种句式
    || /^\/?哪里买(?:\s+|$)/u.test(text)
    || /^\/?.{1,20}(?:在|去)?哪(?:里|儿)?买[？?！!。.\s]*$/u.test(text)
    // 星球悬赏：总览/单区/奖励反查（公开数据）
    || /^\/?(?:悬赏|赏金)(?:\s+|$)/u.test(text)
    || isArbitrationShortcut(text)
    || isPersonalAccountCommand(text)
    || isWeeklyCommand(text)
    || Boolean(directIntelType(text));
}

function isPersonalAccountCommand(content: string): boolean {
  const text = String(content || '').normalize('NFKC').trim().replace(/^\//u, '');
  return /^(?:我的账号|账号状态|我的状态|账号周常|我的周常状态|周常同步状态|刷新账号|刷新库存)$/u.test(text)
    // 「开遗物」是遗物先行的个人库存推荐；「裂缝/裂缝推荐」走公开任务卡，主人私聊自动增强。
    || /^(?:开遗物|遗物推荐|开什么遗物|开什么)(?:\s+.*)?$/u.test(text)
    // 精炼推荐：库存全扫哪些遗物值得花光体（同属个人数据）
    || /^(?:精炼推荐|遗物精炼|值得精炼|精炼什么)(?:\s+\S+){0,2}$/u.test(text)
    // 杜卡德兑换：Prime 部件库存 × 当前行情，属于个人数据
    || /^(?:杜卡德|杜卡德推荐|杜卡德兑换)(?:\s+.*)?$/u.test(text)
    || /^(?:奸商推荐|奸商买什么|奸商购物|虚空商人推荐|虚空商人买什么)$/u.test(text)
    // 商店总览/详情：已购标注读快照 → 个人数据通道（与 dispatch.mjs isPersonalCommand 同步）
    || /^商店(?:\s+\S+)?$/u.test(text)
    // 本周好货直查（周一推送同款卡）：已购标读快照 → 个人数据通道
    || /^(?:本周好货|好货|好货清单)$/u.test(text)
    // 轮换日历：「已有」标读快照 → 个人数据通道
    || /^(?:轮换日历|排期|日历|未来轮换)$/u.test(text)
    // 我的紫卡：快照指纹离线复算 → 个人数据通道；带武器名=详情卡
    || /^(?:我的紫卡|紫卡列表|紫卡)(?:\s+\S+)*$/u.test(text)
    || /^(?:我的遗物|我的赋能|我的库存)(?:\s+.*)?$/u.test(text)
    // 「我有…」只拦纯数量问句；带卖/推荐/建议等决策词的复合问句放行给模型组合回答（曾把整句塞进库存查询 0 匹配）
    || (/^我(?:有多少|有).+(?:吗|么|？|\?)?$/u.test(text) && !/卖|推荐|建议|该不该|要不要|值不值|留着|出手/u.test(text));
}

function isWeeklyCommand(content: string): boolean {
  const text = String(content || '').normalize('NFKC').trim().replace(/^\//u, '');
  return /^(?:周常|当前周常|周常清单|周常列表|本周周常|周报|周常帮助|清空周常)$/u.test(text)
    || /^(?:完成|撤销|跳过|取消跳过)\s+\S.*$/u.test(text);
}

function isArbitrationShortcut(content: string): boolean {
  const text = String(content || '').normalize('NFKC').trim();
  return /^\/?(?:仲裁|当前仲裁)$/u.test(text);
}

function directIntelType(content: string): string | null {
  const text = String(content || '').normalize('NFKC').trim().replace(/^\//u, '');
  if (text === '警报' || text === '当前警报') return 'alert';
  if (text === '入侵' || text === '当前入侵') return 'invasion';
  if (text === '活动' || text === '当前活动') return 'event';
  if (text === '虚空商人' || text === '奸商' || text === '当前虚空商人') return 'trader';
  if (text === '突击' || text === '当前突击' || text === '今日突击') return 'sortie';
  if (text === '钢铁侵袭' || text === '钢铁之路侵袭' || text === '今日钢铁侵袭' || text === '侵袭') return 'incursion';
  return null;
}

function isSubscriptionCommand(content: string): boolean {
  const text = String(content || '').normalize('NFKC').trim().replace(/^\//u, '');
  return /^(?:订阅|提醒|我的订阅|订阅列表|我的提醒|取消订阅|取消提醒|暂停订阅|暂停提醒|恢复订阅|恢复提醒|订阅帮助|提醒帮助)(?:\s*.*)?$/u.test(text);
}

// 自然语言问价的便宜关键词门：只决定要不要花 45s 跑脚本，精确意图解析在脚本侧
function maybeNaturalPriceQuestion(content: string): boolean {
  const text = String(content || '').normalize('NFKC').trim();
  if (!text || text.length > 40) return false;
  return /(?:多少钱|什么价|啥价|价格|市价|值多少|卖多少|多少\s*(?:p|白金|铂金))/iu.test(text);
}

// 世界/个人状态类自然语言的便宜门；精确路由在 shortcuts.mjs route（零网络）
function maybeNaturalWorldQuestion(content: string): boolean {
  const text = String(content || '').normalize('NFKC').trim();
  if (!text || text.length > 40) return false;
  return /(?:值得开|开什么|开啥|怎么开遗物|如何开遗物|开遗物.{0,6}(?:合适|划算|好)|好裂缝|好遗物|好货|值得买|奸商|虚空商人|杜卡德|突击|侵袭|钢铁精华|悬赏|赏金|复刻|回廊|轮换|周常|这周|本周|哪里出|哪儿出|哪出|哪里掉|哪里刷|哪个遗物|功能|命令|怎么用|使用帮助|你能干|你会|你能做|本事|值得精炼|精炼什么|精炼啥|哪里买|哪儿买|哪买|在哪买|哪里换|商店|泰辛|瓦奇娅|圣言者|言录使|切片哥|璨璨珍宝|鸟三|达尔沃|特惠)/iu.test(text);
}

// 通用点评素材：把脚本结果浓缩成注入文本；各功能取自己最有信息量的字段
function buildGenericModelContext(kind: string, result: any): string {
  let facts = '';
  if (kind === 'trader' || kind === 'sortie' || kind === 'incursion') {
    facts = JSON.stringify({ 条目: result.items || [], 数据时间: result.fetchedAt });
  } else if (kind === 'weekly') {
    const tasks = Array.isArray(result.tasks) ? result.tasks : [];
    facts = JSON.stringify({
      已完成: tasks.filter((t: any) => t.done).map((t: any) => t.title || t.name),
      未完成: tasks.filter((t: any) => !t.done).map((t: any) => t.title || t.name),
      本周截止: result.nextReset,
    });
  } else {
    // recommend / relic-reverse：脚本 text 已是中文摘要，截断防 prompt 膨胀
    facts = String(result.text || '').slice(0, 1200);
  }
  const taskHint = kind === 'trader' ? '奸商在不在/还有多久来或走'
    : kind === 'trader-shopping' ? '哪几件最该买、杜卡德够不够'
    : kind === 'sortie' ? '今天三段难不难、哪段词缀要注意（如仅限武器/元素强化）'
    : kind === 'incursion' ? '今天六节点里哪几个任务最顺手好速刷（如捕获/歼灭）'
    : kind === 'bounty' ? '哪个赏金最值得跑（看顶奖概率与声望性价比）、快轮换了提醒一句'
    : kind === 'rotation-calendar' ? '未来几周里哪周最值得蹲（缺的战甲/好泰辛货/瓦奇娅换期），可提一句订阅轮换'
    : kind === 'weekly' ? '还剩哪几项没做、周日前还来得及吗'
    : kind === 'recommend' ? '现在开哪个最划算、大概能赚多少'
    : kind === 'refine' ? '哪几个遗物最值得花光体精炼、哪些直接开就行'
    : kind === 'shop' ? '本周精选值不值得买、哪家快轮换了该赶紧看'
    : kind === 'weekly-deals' ? '本周哪件最该抢（必抢档优先）、已购的不用再提'
    : kind === 'where-to-buy' ? '哪个货源最方便入手（常驻优先）、有没有声望/等级门槛'
    : kind === 'help' ? '一句话欢迎，点出两三个最常用玩法（如发「wm 物品名」问价、发「裂缝」看现况、「订阅 …」设提醒），提醒说人话提问也能识别'
    : '哪个遗物最好刷、是否已入库';
  return [
    '[Warframe 助手·本轮系统上下文]',
    '用户这句话已由确定性脚本处理：结果卡片图刚刚已经直接发送给用户，用户看得到图。',
    `卡片对应的数据（你唯一可用的数据来源，禁止另行检索或编造）：${facts}`,
    `你的任务：只依据上面这份数据，用一两句口语化中文给出重点或建议（例如：${taskHint}），不要复读整个清单。`,
    '硬性禁止：再发任何图片或 MEDIA: 标记；说「我帮你查一下」之类的过程话术；解释系统机制或道歉。直接给结论。',
  ].join('\n');
}

// 发图那轮暂存点评素材，同会话的 before_prompt_build 取走注入给模型；短 TTL 防串轮
const pendingModelContext = new Map<string, { context: string; expiresAt: number }>();
const PENDING_CONTEXT_TTL_MS = 120_000;

function pendingContextKey(ctx: any): string | null {
  const key = String(ctx?.sessionKey || ctx?.conversationId || '').trim().toLowerCase();
  return key || null;
}

function stashModelContext(key: string | null, context: string): void {
  const entry = { context, expiresAt: Date.now() + PENDING_CONTEXT_TTL_MS };
  if (key) pendingModelContext.set(key, entry);
  // dispatch 侧与 agent 侧的 sessionKey 来源不同，可能对不上；
  // 单主人低并发场景下用 * 兜底，实测日志确认精确键命中后可收紧
  pendingModelContext.set('*', entry);
}

function takeModelContext(key: string | null): string | null {
  const entry = (key ? pendingModelContext.get(key) : null) ?? pendingModelContext.get('*');
  if (!entry) return null;
  if (key) pendingModelContext.delete(key);
  pendingModelContext.delete('*');
  return entry.expiresAt >= Date.now() ? entry.context : null;
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

export default definePluginEntry({
  id: 'warframe-fast-commands',
  name: 'Warframe Fast Commands',
  description: 'Read-only Warframe market, relic, fissure, local account snapshot and persistent subscription commands for QQ.',
  register(api) {
    // This is the authoritative QQ ingress gate. It runs before agent/model
    // dispatch, sends the deterministic card through QQ's native outbound
    // adapter, and then consumes the turn so no LLM can replace the result.
    api.on('before_dispatch', async (event, ctx) => {
      const content = String(event.content || event.body || '');
      if (!isQQChannel(event.channel)) return;
      // 自然语言两段式：先发确定性卡片图，再把数据暂存给模型点评（不吞消息）；
      // 任何环节失败都静默放行走普通模型回复，宁可漏不可错发
      if (!isShortcut(content) && !isSubscriptionCommand(content)) {
        // 第一级：问价特化路径（带 90 天统计的浓缩素材）
        if (maybeNaturalPriceQuestion(content)) {
          try {
            const { stdout } = await execFileAsync(process.execPath, [shortcutScript, 'ask', content], {
              timeout: 45_000,
              windowsHide: true,
              maxBuffer: 2 * 1024 * 1024,
              encoding: 'utf8',
              env: { ...process.env, WARFRAME_CARD_DIR: cardDir },
            });
            const result = JSON.parse(stdout);
            if (!result?.handled || !result.mediaUrl) return;
            await sendDirectQQReply(api, event, ctx, {
              text: result.followupText || '',
              mediaUrl: result.mediaUrl,
              trustedLocalMedia: true,
              replyToId: event.replyToId || ctx.replyToId,
            });
            stashModelContext(pendingContextKey(ctx), String(result.modelContext || ''));
            api.logger.info(`Warframe natural price card sent, passing to model: ${content.trim()} (dispatchKey=${pendingContextKey(ctx) || 'none'})`);
          } catch (error) {
            api.logger.error(`Warframe natural price path failed open: ${String(error)}`);
          }
          return;
        }
        // 第二级：世界/个人状态意图 → 映射到既有短命令同款通道
        if (!maybeNaturalWorldQuestion(content)) return;
        try {
          const { stdout: routeOut } = await execFileAsync(process.execPath, [shortcutScript, 'route', content], {
            timeout: 10_000,
            windowsHide: true,
            maxBuffer: 256 * 1024,
            encoding: 'utf8',
          });
          const routed = JSON.parse(routeOut);
          if (!routed?.handled || !routed.command) return;
          const isGroup = Boolean(event.isGroup || agentContextIsGroup(ctx));
          // 个人类意图非主人私聊时静默放行，不发拒绝文字打扰对方
          if (routed.personal && (isGroup || !isExactOwner(api, event.senderId || ctx.senderId))) return;
          const reply = await handleFastCommand(api, {
            channel: 'qqbot',
            content: routed.command,
            conversationId: ctx.conversationId,
            senderId: event.senderId || ctx.senderId,
            senderName: event.senderName || ctx.channelContext?.sender?.name,
            senderUsername: event.senderUsername || ctx.channelContext?.sender?.username,
            isGroup,
            messageId: event.replyToId || ctx.replyToId,
          });
          // 只有真正出图才走两段式；无图/出错一律静默放行
          if (!reply || reply.isError || !reply.mediaUrl) return;
          await sendDirectQQReply(api, event, ctx, reply);
          stashModelContext(pendingContextKey(ctx), buildGenericModelContext(String(routed.kind), reply.raw || {}));
          api.logger.info(`Warframe natural intent '${String(routed.kind)}' → '${routed.command}' card sent, passing to model (dispatchKey=${pendingContextKey(ctx) || 'none'})`);
        } catch (error) {
          api.logger.error(`Warframe natural world path failed open: ${String(error)}`);
        }
        return;
      }
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

    // 自然语言问价第二段：图已直发，这里把行情数据和点评指令注入当轮 prompt
    api.on('before_prompt_build', async (_event, ctx) => {
      const context = takeModelContext(pendingContextKey(ctx));
      if (!context) return;
      api.logger.info(`Warframe natural price context injected into prompt (agentKey=${pendingContextKey(ctx) || 'none'})`);
      return { appendContext: context };
    }, { timeoutMs: 5_000 });

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
