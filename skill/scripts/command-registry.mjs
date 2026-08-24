#!/usr/bin/env node

// R1：所有面向用户的命令元数据与入口匹配定义的唯一来源。
// 运行时扩展通过 source/runtime 路径加载本文件；不要在路由、帮助或工具说明中
// 重新维护同一组命令正则、权限和示例。

const freeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
};

const command = (value) => freeze(value);

export const COMMAND_REGISTRY_SCHEMA_VERSION = 1;

export const COMMAND_REGISTRY = freeze([
  command({
    commandId: 'help',
    canonicalSyntax: '帮助',
    aliases: ['help', '菜单', '功能', '功能列表', '命令列表', '使用说明', '说明书', '怎么用'],
    argumentSchema: { type: 'none' },
    privacyScope: 'public',
    fastPath: true,
    modelCallable: true,
    executor: 'shortcuts.runShortcut',
    helpSection: '查价 · warframe.market',
    helpTitle: '功能总览',
    helpSummary: '查看全部公开、用户私聊和订阅入口',
    helpExamples: ['帮助'],
    nextActions: [],
    matchers: [
      { routes: ['shortcut-parser', 'shortcut-gate'], kind: 'exact', pattern: '(?:帮助|help|菜单|功能|功能列表|命令列表|使用说明|说明书|怎么用)' },
    ],
  }),
  command({
    commandId: 'market',
    canonicalSyntax: 'wm <物品> [满级|N级]',
    aliases: ['wm'],
    argumentSchema: { type: 'string', required: true, rank: 'optional' },
    privacyScope: 'public',
    fastPath: true,
    modelCallable: true,
    executor: 'shortcuts.runShortcut',
    helpSection: '查价 · warframe.market',
    helpTitle: '查价',
    helpSummary: '最低卖单·买单·90天行情',
    helpExamples: ['wm 悟空p', 'wm 赋能充沛 满级', '悟空p多少钱'],
    nextActions: [],
    matchers: [
      { routes: ['shortcut-parser', 'shortcut-gate'], kind: 'regex', pattern: '^wm(?![a-z])\\s*(?<query>[\\s\\S]*)$', flags: 'iu' },
    ],
  }),
  command({
    commandId: 'relic',
    canonicalSyntax: '遗物 <纪元编号或物品>',
    aliases: ['遗物'],
    argumentSchema: { type: 'string', required: true },
    privacyScope: 'public',
    fastPath: true,
    modelCallable: true,
    executor: 'shortcuts.runShortcut',
    helpSection: '遗物 & 裂缝',
    helpTitle: '遗物',
    helpSummary: '正查奖励与价格，反查物品来源',
    helpExamples: ['遗物 前x1', '遗物 战刃'],
    nextActions: ['获取 <物品>'],
    matchers: [
      { routes: ['shortcut-parser'], kind: 'startsWith', pattern: '遗物', capture: 'query' },
      { routes: ['shortcut-gate'], kind: 'prefix', pattern: '遗物' },
    ],
  }),
  command({
    commandId: 'relic-farm',
    canonicalSyntax: '获取 <Prime部件>',
    aliases: ['获取'],
    argumentSchema: { type: 'string', required: true },
    privacyScope: 'public',
    fastPath: true,
    modelCallable: true,
    executor: 'shortcuts.runShortcut',
    helpSection: '遗物 & 裂缝',
    helpTitle: '获取',
    helpSummary: '库存优先·当前赏金·常驻掉点获取路线',
    helpExamples: ['获取 Prime部件'],
    nextActions: ['wm <物品>', '遗物 <物品>'],
    matchers: [
      { routes: ['shortcut-parser', 'shortcut-gate'], kind: 'prefix', pattern: '获取' },
    ],
  }),
  command({
    commandId: 'fissure',
    canonicalSyntax: '裂缝 [筛选]',
    aliases: ['裂缝推荐', '推荐裂缝', '虚空裂缝', '钢铁裂缝', '普通裂缝', '全能裂缝', '安魂裂缝'],
    argumentSchema: { type: 'string', required: false, filters: true },
    privacyScope: 'public',
    fastPath: true,
    modelCallable: true,
    executor: 'shortcuts.runShortcut',
    helpSection: '遗物 & 裂缝',
    helpTitle: '裂缝',
    helpSummary: '全部普通/钢铁任务与筛选；用户私聊逐任务配库存遗物',
    helpExamples: ['裂缝 [筛选]'],
    nextActions: ['开遗物'],
    matchers: [
      { routes: ['shortcut-parser', 'shortcut-gate'], kind: 'regex', pattern: '^(?:裂缝推荐|推荐裂缝)(?:\\s+(?<query>[\\s\\S]*))?$', flags: 'iu' },
      { routes: ['shortcut-parser', 'shortcut-gate'], kind: 'regex', pattern: '^(?<filter>钢铁|普通|全能|安魂)(?:虚空)?裂缝(?:\\s+(?<query>[\\s\\S]*))?$', flags: 'iu', queryGroups: ['filter', 'query'] },
      { routes: ['shortcut-parser', 'shortcut-gate'], kind: 'regex', pattern: '^(?:虚空)?裂缝(?:\\s+(?<query>[\\s\\S]*))?$', flags: 'iu' },
    ],
  }),
  command({
    commandId: 'arbitration',
    canonicalSyntax: '仲裁',
    aliases: ['当前仲裁'],
    argumentSchema: { type: 'none' },
    privacyScope: 'public',
    fastPath: true,
    modelCallable: true,
    executor: 'subscriptions.queryArbitration',
    helpSection: '世界状态',
    helpTitle: '仲裁',
    helpSummary: '当前仲裁任务',
    helpExamples: ['仲裁'],
    nextActions: [],
    matchers: [
      { routes: ['arbitration', 'shortcut-gate'], kind: 'exact', pattern: '(?:仲裁|当前仲裁)' },
    ],
  }),
  command({
    commandId: 'alert',
    canonicalSyntax: '警报',
    aliases: ['当前警报'],
    argumentSchema: { type: 'none' },
    privacyScope: 'public',
    fastPath: true,
    modelCallable: true,
    executor: 'subscriptions.queryIntel(alert)',
    helpSection: '世界状态',
    helpTitle: '警报',
    helpSummary: '当前警报',
    helpExamples: ['警报'],
    nextActions: [],
    intelType: 'alert',
    matchers: [
      { routes: ['intel', 'shortcut-gate'], kind: 'exact', pattern: '(?:警报|当前警报)' },
    ],
  }),
  command({
    commandId: 'invasion',
    canonicalSyntax: '入侵',
    aliases: ['当前入侵'],
    argumentSchema: { type: 'none' },
    privacyScope: 'public',
    fastPath: true,
    modelCallable: true,
    executor: 'subscriptions.queryIntel(invasion)',
    helpSection: '世界状态',
    helpTitle: '入侵',
    helpSummary: '当前入侵与稀有奖励',
    helpExamples: ['入侵'],
    nextActions: [],
    intelType: 'invasion',
    matchers: [
      { routes: ['intel', 'shortcut-gate'], kind: 'exact', pattern: '(?:入侵|当前入侵)' },
    ],
  }),
  command({
    commandId: 'event',
    canonicalSyntax: '活动',
    aliases: ['当前活动'],
    argumentSchema: { type: 'none' },
    privacyScope: 'public',
    fastPath: true,
    modelCallable: true,
    executor: 'subscriptions.queryIntel(event)',
    helpSection: '世界状态',
    helpTitle: '活动',
    helpSummary: '当前特殊活动',
    helpExamples: ['活动'],
    nextActions: [],
    intelType: 'event',
    matchers: [
      { routes: ['intel', 'shortcut-gate'], kind: 'exact', pattern: '(?:活动|当前活动)' },
    ],
  }),
  command({
    commandId: 'sortie',
    canonicalSyntax: '突击',
    aliases: ['当前突击', '今日突击'],
    argumentSchema: { type: 'none' },
    privacyScope: 'public',
    fastPath: true,
    modelCallable: true,
    executor: 'subscriptions.queryIntel(sortie)',
    helpSection: '世界状态',
    helpTitle: '突击',
    helpSummary: '今日三段任务与词缀',
    helpExamples: ['突击'],
    nextActions: [],
    intelType: 'sortie',
    matchers: [
      { routes: ['intel', 'shortcut-gate'], kind: 'exact', pattern: '(?:突击|当前突击|今日突击)' },
    ],
  }),
  command({
    commandId: 'incursion',
    canonicalSyntax: '钢铁侵袭',
    aliases: ['钢铁之路侵袭', '今日钢铁侵袭', '侵袭'],
    argumentSchema: { type: 'none' },
    privacyScope: 'public',
    fastPath: true,
    modelCallable: true,
    executor: 'subscriptions.queryIntel(incursion)',
    helpSection: '世界状态',
    helpTitle: '钢铁侵袭',
    helpSummary: '今日六节点钢铁精华任务',
    helpExamples: ['钢铁侵袭'],
    nextActions: [],
    intelType: 'incursion',
    matchers: [
      { routes: ['intel', 'shortcut-gate'], kind: 'exact', pattern: '(?:钢铁侵袭|钢铁之路侵袭|今日钢铁侵袭|侵袭)' },
    ],
  }),
  command({
    commandId: 'bounty',
    canonicalSyntax: '赏金 [地点|物品]',
    aliases: ['悬赏', '赏金'],
    argumentSchema: { type: 'string', required: false },
    privacyScope: 'public',
    fastPath: true,
    modelCallable: true,
    executor: 'shortcuts.runShortcut',
    helpSection: '世界状态',
    helpTitle: '赏金',
    helpSummary: '六区索引、单区奖池和当前奖励反查',
    helpExamples: ['赏金 火卫二'],
    nextActions: [],
    matchers: [
      { routes: ['shortcut-parser', 'shortcut-gate'], kind: 'regex', pattern: '^(?:悬赏|赏金)(?:\\s+(?<query>[\\s\\S]*))?$', flags: 'iu' },
    ],
  }),
  command({
    commandId: 'trader',
    canonicalSyntax: '虚空商人',
    aliases: ['奸商', '当前虚空商人'],
    argumentSchema: { type: 'none' },
    privacyScope: 'public',
    fastPath: true,
    modelCallable: true,
    executor: 'subscriptions.queryIntel(trader)',
    helpSection: '世界状态',
    helpTitle: '虚空商人',
    helpSummary: '到离时间与公开货单；用户私聊可进入购物建议',
    helpExamples: ['虚空商人'],
    nextActions: [],
    intelType: 'trader',
    matchers: [
      { routes: ['intel', 'shortcut-gate'], kind: 'exact', pattern: '(?:虚空商人|奸商|当前虚空商人)' },
    ],
  }),
  command({
    commandId: 'weekly',
    canonicalSyntax: '周常｜完成 <编号|名称>｜撤销 <编号|名称>｜跳过 <编号|名称>｜清空周常',
    aliases: ['周常', '周报', '当前周常', '周常清单', '周常列表', '本周周常', '周常帮助', '清空周常'],
    argumentSchema: { type: 'string', required: false, mutations: true },
    privacyScope: 'userPrivate',
    fastPath: true,
    modelCallable: true,
    executor: 'weekly.manage',
    helpSection: '周常',
    helpTitle: '周常',
    helpSummary: '本周清单与打卡；只在用户私聊中操作',
    helpExamples: ['周常', '完成 1 3 / 撤销 2', '跳过 5 / 取消跳过 5'],
    nextActions: [],
    matchers: [
      { routes: ['weekly', 'shortcut-gate'], kind: 'exact', pattern: '(?:周常|当前周常|周常清单|周常列表|本周周常|周报|周常帮助|清空周常)' },
      { routes: ['weekly', 'shortcut-gate'], kind: 'regex', pattern: '^(?:完成|撤销|跳过|取消跳过)\\s+\\S.*$', flags: 'u' },
    ],
  }),
  command({
    commandId: 'account',
    canonicalSyntax: '我的账号｜我的库存 <物品>｜我的遗物 <代号>｜我的赋能 <名称>',
    aliases: ['我的账号', '我的库存', '我的遗物', '我的赋能', '账号周常'],
    argumentSchema: { type: 'string', required: false, snapshot: true },
    privacyScope: 'userPrivate',
    fastPath: true,
    modelCallable: true,
    executor: 'alecaframe.runAlecaMessage',
    helpSection: '我的账号',
    helpTitle: '账号',
    helpSummary: '账号、库存、遗物、赋能和紫卡快照只读查询',
    helpExamples: ['我的账号 / 我的库存 X', '我的遗物 前N11 / 账号周常'],
    nextActions: [],
    matchers: [
      { routes: ['user-account', 'shortcut-gate'], kind: 'exact', pattern: '(?:我的账号|账号状态|我的状态|账号周常|我的周常状态|周常同步状态|刷新账号|刷新库存)' },
      { routes: ['user-account', 'shortcut-gate'], kind: 'regex', pattern: '^(?:我的遗物|我的赋能|我的库存)(?:\\s+.*)?$', flags: 'u' },
      { routes: ['user-account'], kind: 'regex', pattern: '^我(?:有多少|有).+(?:吗|么|？|\\?)?$', flags: 'u' },
    ],
  }),
  command({
    commandId: 'recommend',
    canonicalSyntax: '开遗物 [商品名|未入库|已入库] [白金|杜卡德] [钢铁] [速刷|舒适|收益] [单人]',
    aliases: ['遗物推荐', '开什么遗物', '开什么'],
    argumentSchema: { type: 'string', required: false, snapshot: true },
    privacyScope: 'userPrivate',
    fastPath: true,
    modelCallable: true,
    executor: 'alecaframe.runAlecaMessage',
    helpSection: '遗物 & 裂缝',
    helpTitle: '开遗物',
    helpSummary: '按库存、目标和队伍偏好推荐遗物；可同步 WFInfo',
    helpExamples: ['开遗物 [条件] 🔒', '开遗物 商品名 🔒'],
    nextActions: [],
    matchers: [
      { routes: ['user-account', 'shortcut-gate'], kind: 'regex', pattern: '^(?:开遗物|遗物推荐|开什么遗物|开什么)(?:\\s+.*)?$', flags: 'u' },
    ],
  }),
  command({
    commandId: 'refine',
    canonicalSyntax: '精炼推荐 [单人]',
    aliases: ['遗物精炼', '值得精炼', '精炼什么'],
    argumentSchema: { type: 'string', required: false, snapshot: true },
    privacyScope: 'userPrivate',
    fastPath: true,
    modelCallable: true,
    executor: 'alecaframe.runAlecaMessage',
    helpSection: '遗物 & 裂缝',
    helpTitle: '精炼推荐',
    helpSummary: '哪些遗物值得花光体；可切换单人口径',
    helpExamples: ['精炼推荐 🔒'],
    nextActions: [],
    matchers: [
      { routes: ['user-account', 'shortcut-gate'], kind: 'regex', pattern: '^(?:精炼推荐|遗物精炼|值得精炼|精炼什么)(?:\\s+\\S+){0,2}$', flags: 'u' },
    ],
  }),
  command({
    commandId: 'ducat-plan',
    canonicalSyntax: '杜卡德 [目标|清仓] [保留N|保留N套]',
    aliases: ['杜卡德推荐', '杜卡德兑换'],
    argumentSchema: { type: 'string', required: false, snapshot: true },
    privacyScope: 'userPrivate',
    fastPath: true,
    modelCallable: true,
    executor: 'alecaframe.runAlecaMessage',
    helpSection: '我的账号',
    helpTitle: '杜卡德',
    helpSummary: '按持有状态生成兑换和保留方案',
    helpExamples: ['杜卡德 / 杜卡德 600'],
    nextActions: [],
    matchers: [
      { routes: ['user-account', 'shortcut-gate'], kind: 'regex', pattern: '^(?:杜卡德|杜卡德推荐|杜卡德兑换)(?:\\s+.*)?$', flags: 'u' },
    ],
  }),
  command({
    commandId: 'trader-shopping',
    canonicalSyntax: '奸商推荐',
    aliases: ['奸商买什么', '奸商购物', '虚空商人推荐', '虚空商人买什么'],
    argumentSchema: { type: 'none', snapshot: true },
    privacyScope: 'userPrivate',
    fastPath: true,
    modelCallable: true,
    executor: 'alecaframe.runAlecaMessage',
    helpSection: '世界状态',
    helpTitle: '奸商推荐',
    helpSummary: '货单×库存×余额购物建议',
    helpExamples: ['奸商推荐 🔒'],
    nextActions: [],
    matchers: [
      { routes: ['user-account', 'shortcut-gate'], kind: 'exact', pattern: '(?:奸商推荐|奸商买什么|奸商购物|虚空商人推荐|虚空商人买什么)' },
    ],
  }),
  command({
    commandId: 'shop',
    canonicalSyntax: '商店 [序号|商人名]',
    aliases: ['商店'],
    argumentSchema: { type: 'string', required: false, snapshot: true },
    privacyScope: 'userPrivate',
    fastPath: true,
    modelCallable: true,
    executor: 'alecaframe.runAlecaMessage',
    helpSection: '商店',
    helpTitle: '商店',
    helpSummary: '九家总览、单家货单和已购标记',
    helpExamples: ['商店 🔒', '商店 1 / 商店 泰辛'],
    nextActions: [],
    matchers: [
      { routes: ['user-account', 'shortcut-gate'], kind: 'regex', pattern: '^商店(?:\\s+\\S+)?$', flags: 'u' },
    ],
  }),
  command({
    commandId: 'weekly-deals',
    canonicalSyntax: '本周好货',
    aliases: ['好货', '好货清单'],
    argumentSchema: { type: 'none', snapshot: true },
    privacyScope: 'userPrivate',
    fastPath: true,
    modelCallable: true,
    executor: 'alecaframe.runAlecaMessage',
    helpSection: '商店',
    helpTitle: '本周好货',
    helpSummary: '泰辛/圣言者周货与瓦奇娅复刻精选',
    helpExamples: ['本周好货 🔒'],
    nextActions: [],
    matchers: [
      { routes: ['user-account', 'shortcut-gate'], kind: 'exact', pattern: '(?:本周好货|好货|好货清单)' },
    ],
  }),
  command({
    commandId: 'rotation-calendar',
    canonicalSyntax: '轮换日历',
    aliases: ['排期', '日历', '未来轮换'],
    argumentSchema: { type: 'none', snapshot: true },
    privacyScope: 'userPrivate',
    fastPath: true,
    modelCallable: true,
    executor: 'alecaframe.runAlecaMessage',
    helpSection: '商店',
    helpTitle: '轮换日历',
    helpSummary: '未来 8 周回廊、泰辛和瓦奇娅排期',
    helpExamples: ['轮换日历 🔒'],
    nextActions: [],
    matchers: [
      { routes: ['user-account', 'shortcut-gate'], kind: 'exact', pattern: '(?:轮换日历|排期|日历|未来轮换)' },
    ],
  }),
  command({
    commandId: 'rivens',
    canonicalSyntax: '我的紫卡｜紫卡 [序号|武器]',
    aliases: ['我的紫卡', '紫卡列表', '紫卡'],
    argumentSchema: { type: 'string', required: false, snapshot: true },
    privacyScope: 'userPrivate',
    fastPath: true,
    modelCallable: true,
    executor: 'alecaframe.runAlecaMessage',
    helpSection: '我的账号',
    helpTitle: '紫卡',
    helpSummary: '词条等级、神卡判定和行情估价',
    helpExamples: ['我的紫卡 / 紫卡 3'],
    nextActions: [],
    matchers: [
      { routes: ['user-account', 'shortcut-gate'], kind: 'regex', pattern: '^(?:我的紫卡|紫卡列表|紫卡)(?:\\s+\\S+)*$', flags: 'u' },
    ],
  }),
  command({
    commandId: 'where-to-buy',
    canonicalSyntax: '购买 <物品>',
    aliases: ['购买'],
    argumentSchema: { type: 'string', required: true },
    privacyScope: 'public',
    fastPath: true,
    modelCallable: true,
    executor: 'shortcuts.runShortcut',
    helpSection: '商店',
    helpTitle: '购买',
    helpSummary: '反查全商人货源；自然语言买/换问法统一到这里',
    helpExamples: ['购买 裂罅破解器'],
    nextActions: ['wm <物品>'],
    matchers: [
      { routes: ['shortcut-parser', 'shortcut-gate'], kind: 'prefix', pattern: '购买' },
    ],
  }),
  command({
    commandId: 'subscription',
    canonicalSyntax: '订阅 <类型|条件>',
    aliases: ['订阅', '提醒', '我的订阅', '取消订阅', '暂停订阅', '恢复订阅', '订阅帮助', '提醒帮助'],
    argumentSchema: { type: 'string', required: true, mutation: true },
    privacyScope: 'session',
    fastPath: true,
    modelCallable: true,
    executor: 'subscriptions.manage',
    helpSection: '订阅提醒',
    helpTitle: '订阅',
    helpSummary: '13 类事件、商品上架和轮换提醒；由 QQ 会话保存',
    helpExamples: ['订阅 裂缝 钢铁 生存', '我的订阅', '暂停/恢复/取消订阅 <编号>'],
    nextActions: [],
    guideOnly: true,
    matchers: [
      { routes: ['subscription'], kind: 'regex', pattern: '^(?:订阅|提醒|我的订阅|订阅列表|我的提醒|取消订阅|取消提醒|暂停订阅|暂停提醒|恢复订阅|恢复提醒|订阅帮助|提醒帮助)(?:\\s*.*)?$', flags: 'u' },
    ],
  }),
  command({
    commandId: 'wishlist',
    canonicalSyntax: '愿望 <物品> <价格>｜愿望单｜改价/暂停/继续/已购/取消 <短编号>',
    aliases: ['愿望', '愿望单', '我的愿望单', '愿望列表', '蹲价', '盯价', '订阅愿望'],
    argumentSchema: { type: 'string', required: true, mutation: true, sessionScoped: true },
    privacyScope: 'session',
    fastPath: true,
    modelCallable: true,
    executor: 'wishlist.manage',
    helpSection: '愿望单 · 市场盯价',
    helpTitle: '愿望单',
    helpSummary: '现有合价单立即出市场卡；之后秒级提醒',
    helpExamples: ['愿望 商品 价格', '愿望单 / 已购 W3K7', '改价/暂停/继续/已购/取消 <短编号>'],
    nextActions: [],
    matchers: [
      { routes: ['wishlist', 'shortcut-gate'], kind: 'exact', pattern: '(?:愿望单|我的愿望单|愿望列表)' },
      { routes: ['wishlist', 'shortcut-gate'], kind: 'regex', pattern: '^(?:愿望|蹲价|盯价|订阅愿望)\\s+.+\\s+(?:≤|<=|不高于|最高|至多)?\\s*\\d+(?:\\.\\d+)?$', flags: 'u' },
      { routes: ['wishlist', 'shortcut-gate'], kind: 'regex', pattern: '^(?:愿望\\s*)?(?:已购|买到|改价|暂停|继续|恢复|取消)(?:\\s+|$).+', flags: 'u' },
    ],
  }),
]);

const COMMAND_BY_ID = new Map(COMMAND_REGISTRY.map((entry) => [entry.commandId, entry]));

export function normalizeCommandText(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/^\/?/u, '').replace(/[\u3000\s]+/gu, ' ');
}

function matcherPattern(matcher) {
  const flags = matcher.flags || 'u';
  if (matcher.kind === 'exact') return new RegExp(`^${matcher.pattern}$`, flags);
  if (matcher.kind === 'prefix') return new RegExp(`^${matcher.pattern}(?:\\s+(?<query>[\\s\\S]*)|$)`, flags);
  if (matcher.kind === 'startsWith') return new RegExp(`^${matcher.pattern}(?<query>[\\s\\S]*)$`, flags);
  return new RegExp(matcher.pattern, flags);
}

function matcherHasRoute(matcher, route) {
  return Array.isArray(matcher.routes) && matcher.routes.includes(route);
}

export function getCommand(commandId) {
  return COMMAND_BY_ID.get(commandId) || null;
}

export function matchCommandText(value, route, commandId = null) {
  const text = normalizeCommandText(value);
  const entries = commandId ? [getCommand(commandId)].filter(Boolean) : COMMAND_REGISTRY;
  for (const entry of entries) {
    for (const matcher of entry.matchers || []) {
      if (!matcherHasRoute(matcher, route)) continue;
      const match = matcherPattern(matcher).exec(text);
      if (match) {
        const queryGroups = matcher.queryGroups || ['query'];
        const query = queryGroups.map((name) => match.groups?.[name]).filter(Boolean).join(' ').trim();
        return { commandId: entry.commandId, entry, matcher, query, text };
      }
    }
  }
  return null;
}

export function matchesRegistryRoute(value, route) {
  return Boolean(matchCommandText(value, route));
}

const CONTEXTUAL_PERSONAL_QUERY = /^(?:我有|我的库存|我的遗物).*(?:这些|那些|它们|上面(?:这些|那些)?|刚才(?:这些|那些)?)/u;

export function isUserPrivateCommand(value) {
  const text = normalizeCommandText(value);
  if (CONTEXTUAL_PERSONAL_QUERY.test(text)) return false;
  return Boolean(matchCommandText(text, 'user-account'));
}

export function matchWeeklyCommand(value) {
  return matchCommandText(value, 'weekly');
}

export function matchWishlistCommand(value) {
  return matchCommandText(value, 'wishlist');
}

export function matchSubscriptionCommand(value) {
  return matchCommandText(value, 'subscription');
}

export function matchIntelCommand(value) {
  return matchCommandText(value, 'intel');
}

export function directIntelType(value) {
  return matchIntelCommand(value)?.entry?.intelType || null;
}

export function matchArbitrationCommand(value) {
  return matchCommandText(value, 'arbitration');
}

export function buildTemplateCatalog() {
  return COMMAND_REGISTRY.map((entry) => ({
    kind: entry.commandId,
    commandId: entry.commandId,
    example: entry.canonicalSyntax,
    personal: entry.privacyScope === 'userPrivate',
    privacyScope: entry.privacyScope,
    fastPath: entry.fastPath,
    modelCallable: entry.modelCallable,
    executor: entry.executor,
    intents: entry.helpSummary,
    guideOnly: Boolean(entry.guideOnly),
  }));
}

export function buildHelpSections() {
  const sections = [];
  const byTitle = new Map();
  for (const entry of COMMAND_REGISTRY) {
    if (!entry.helpSection || !entry.helpExamples?.length) continue;
    let section = byTitle.get(entry.helpSection);
    if (!section) {
      section = [entry.helpSection, []];
      byTitle.set(entry.helpSection, section);
      sections.push(section);
    }
    for (const example of entry.helpExamples) {
      section[1].push({
        commandId: entry.commandId,
        title: entry.helpTitle,
        command: example,
        description: entry.helpSummary,
        privacyScope: entry.privacyScope,
      });
    }
  }
  return sections;
}

export function buildToolCommandSummary() {
  return COMMAND_REGISTRY
    .filter((entry) => entry.modelCallable && !entry.guideOnly)
    .map((entry) => entry.canonicalSyntax)
    .join('、');
}

export function registryContractErrors() {
  const errors = [];
  const seen = new Set();
  for (const entry of COMMAND_REGISTRY) {
    for (const field of ['commandId', 'canonicalSyntax', 'argumentSchema', 'privacyScope', 'executor', 'helpTitle', 'helpSummary']) {
      if (!entry[field]) errors.push(`${entry.commandId || '<missing>'}.${field} is required`);
    }
    if (seen.has(entry.commandId)) errors.push(`duplicate commandId: ${entry.commandId}`);
    seen.add(entry.commandId);
    if (!Array.isArray(entry.aliases) || entry.aliases.length === 0) errors.push(`${entry.commandId}.aliases must be non-empty`);
    if (!Array.isArray(entry.helpExamples) || entry.helpExamples.length === 0) errors.push(`${entry.commandId}.helpExamples must be non-empty`);
    if (!Array.isArray(entry.nextActions)) errors.push(`${entry.commandId}.nextActions must be an array`);
    if (!Array.isArray(entry.matchers)) errors.push(`${entry.commandId}.matchers must be an array`);
    if (!['public', 'session', 'userPrivate'].includes(entry.privacyScope)) errors.push(`${entry.commandId}.privacyScope is invalid`);
    if (typeof entry.fastPath !== 'boolean') errors.push(`${entry.commandId}.fastPath must be boolean`);
    if (typeof entry.modelCallable !== 'boolean') errors.push(`${entry.commandId}.modelCallable must be boolean`);
    for (const matcher of entry.matchers || []) {
      try { matcherPattern(matcher); } catch (error) { errors.push(`${entry.commandId} matcher invalid: ${String(error?.message || error)}`); }
    }
  }
  return errors;
}
