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

const COMMAND_REGISTRY_SCHEMA_VERSION = 2;

// Help section ids and helpQuery values are stable keys. User-visible titles are
// also accepted as convenience aliases, while the overview always prints helpQuery.
const HELP_SECTION_REGISTRY = freeze([
  { id: 'basics', title: '基础使用', helpQuery: '基础', summary: '查看帮助入口和使用方式', aliases: ['基础', '入门', '使用'], order: 0 },
  { id: 'market', title: '查价 · warframe.market', helpQuery: '查价', summary: '市场查价、挂单与近期行情', aliases: ['查价', '市场', '行情'], order: 10 },
  { id: 'relics', title: '遗物 & 裂缝', helpQuery: '遗物', summary: '遗物奖励、来源、裂缝与开启建议', aliases: ['遗物', '裂缝', '遗物与裂缝', '遗物裂缝'], order: 20 },
  { id: 'worldstate', title: '世界状态', helpQuery: '世界状态', summary: '仲裁、警报、入侵、活动与每日轮换', aliases: ['情报'], order: 30 },
  { id: 'weekly', title: '周常', helpQuery: '周常', summary: '本周任务清单、完成与撤销记录', aliases: ['周报'], order: 40 },
  { id: 'shop', title: '商店', helpQuery: '商店', summary: '各类商店、好货、奸商建议与购买来源', aliases: ['商店命令'], order: 50 },
  { id: 'account', title: '我的账号', helpQuery: '账号', summary: '库存、遗物、赋能、紫卡与杜卡德规划', aliases: ['账号', '个人'], order: 60 },
  { id: 'subscription', title: '订阅提醒', helpQuery: '订阅', summary: '事件、商品、轮换和掉落提醒管理', aliases: ['订阅', '提醒'], order: 70 },
  { id: 'wishlist', title: '愿望单 · 市场盯价', helpQuery: '愿望单', summary: '目标价格盯盘与愿望状态管理', aliases: ['愿望单', '市场盯价'], order: 80 },
]);

const COMMAND_REGISTRY = freeze([
  command({
    commandId: 'help',
    canonicalSyntax: '帮助',
    aliases: ['help', '菜单', '功能', '功能列表', '命令列表', '使用说明', '说明书', '怎么用'],
    argumentSchema: { type: 'none' },
    privacyScope: 'public',
    fastPath: true,
    modelCallable: true,
    executor: 'shortcuts.runShortcut',
    helpSectionId: 'basics',
    helpTitle: '功能总览',
    helpSummary: '查看全部公开、用户私聊和订阅入口',
    helpExamples: ['帮助'],
    nextActions: [],
    matchers: [
      { routes: ['shortcut-parser', 'shortcut-gate'], kind: 'regex', pattern: '^(?:帮助|help|菜单|功能|功能列表|命令列表|使用说明|说明书|怎么用)(?:\\s+(?<query>[\\s\\S]+))?$', flags: 'iu' },
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
    helpSectionId: 'market',
    helpTitle: '查价',
    helpSummary: '最低卖单·买单·90天行情',
    helpExamples: [
      { command: 'wm 悟空p', description: '查看最低卖单、买单和 90 天行情' },
      { command: 'wm 赋能充沛 满级', description: '按赋能等级查询对应市场价格' },
      { command: '悟空p多少钱', description: '自然语言问价也会进入同一查价流程' },
    ],
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
    helpSectionId: 'relics',
    helpTitle: '遗物',
    helpSummary: '正查奖励与价格，反查物品来源',
    helpExamples: [
      { command: '遗物 前x1', description: '正查遗物奖励、价格、精炼期望与来源' },
      { command: '遗物 战刃', description: '反查物品由哪些遗物产出' },
    ],
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
    helpSectionId: 'relics',
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
    helpSectionId: 'relics',
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
    helpSectionId: 'worldstate',
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
    helpSectionId: 'worldstate',
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
    helpSectionId: 'worldstate',
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
    helpSectionId: 'worldstate',
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
    helpSectionId: 'worldstate',
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
    helpSectionId: 'worldstate',
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
    helpSectionId: 'worldstate',
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
    helpSectionId: 'worldstate',
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
    helpSectionId: 'weekly',
    helpTitle: '周常',
    helpSummary: '本周清单与打卡；只在用户私聊中操作',
    helpExamples: [
      { command: '周常', description: '查看本周任务清单和当前完成状态' },
      { command: '完成 1 3 / 撤销 2', description: '标记完成或撤销完成；仅用户私聊' },
      { command: '跳过 5 / 取消跳过 5', description: '隐藏暂不处理的任务或恢复显示' },
    ],
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
    helpSectionId: 'account',
    helpTitle: '账号',
    helpSummary: '账号、库存、遗物、赋能和紫卡快照只读查询',
    helpExamples: [
      { command: '我的账号 / 我的库存 X', description: '查看账号概览或按分类、物品检索库存' },
      { command: '我的遗物 前N11 / 账号周常', description: '查看个人遗物、赋能或账号周常快照' },
    ],
    nextActions: [],
    matchers: [
      { routes: ['user-account', 'shortcut-gate'], kind: 'exact', pattern: '(?:我的账号|账号状态|我的状态)', aleca: { query: 'none' } },
      { routes: ['user-account', 'shortcut-gate'], kind: 'exact', pattern: '(?:账号周常|我的周常状态|周常同步状态)', aleca: { command: 'weekly', query: 'none' } },
      { routes: ['user-account', 'shortcut-gate'], kind: 'exact', pattern: '(?:刷新账号|刷新库存)', aleca: { command: 'refresh-help', query: 'none' } },
      { routes: ['user-account', 'shortcut-gate'], kind: 'regex', pattern: '^我的遗物(?:\\s+|$)(?<query>.*)$', flags: 'u', aleca: { command: 'relic', query: 'capture' } },
      { routes: ['user-account', 'shortcut-gate'], kind: 'regex', pattern: '^我的赋能(?:\\s+|$)(?<query>.*)$', flags: 'u', aleca: { command: 'arcane', query: 'capture' } },
      { routes: ['user-account', 'shortcut-gate'], kind: 'regex', pattern: '^我的库存(?:\\s+|$)(?<query>.*)$', flags: 'u', aleca: { command: 'inventory', query: 'capture' } },
      { routes: ['user-account'], kind: 'regex', pattern: '^我(?:有多少个|有多少|有)(?<query>.+)$', flags: 'u', aleca: { command: 'inventory', query: 'ownedInventory' } },
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
    helpSectionId: 'relics',
    helpTitle: '开遗物',
    helpSummary: '按库存、目标和队伍偏好推荐遗物；可同步 WFInfo',
    helpExamples: [
      { command: '开遗物 [条件] 🔒', description: '按库存、目标、裂缝和队伍偏好推荐' },
      { command: '开遗物 商品名 🔒', description: '围绕当前奸商商品保本线规划' },
    ],
    nextActions: [],
    matchers: [
      { routes: ['user-account', 'shortcut-gate'], kind: 'regex', pattern: '^(?:开遗物|遗物推荐|开什么遗物|开什么)(?:\\s+(?<query>.*))?$', flags: 'u', aleca: { query: 'capture' } },
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
    helpSectionId: 'relics',
    helpTitle: '精炼推荐',
    helpSummary: '哪些遗物值得花光体；可切换单人口径',
    helpExamples: ['精炼推荐 🔒'],
    nextActions: [],
    matchers: [
      { routes: ['user-account', 'shortcut-gate'], kind: 'regex', pattern: '^(?:精炼推荐|遗物精炼|值得精炼|精炼什么)(?:\\s+(?<query>\\S+(?:\\s+\\S+)?))?$', flags: 'u', aleca: { query: 'capture' } },
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
    helpSectionId: 'account',
    helpTitle: '杜卡德',
    helpSummary: '按持有状态生成兑换和保留方案',
    helpExamples: ['杜卡德 / 杜卡德 600'],
    nextActions: [],
    matchers: [
      { routes: ['user-account', 'shortcut-gate'], kind: 'regex', pattern: '^(?:杜卡德|杜卡德推荐|杜卡德兑换)(?:\\s+.*)?$', flags: 'u', aleca: { query: 'fullText' } },
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
    helpSectionId: 'shop',
    helpTitle: '奸商推荐',
    helpSummary: '货单×库存×余额购物建议',
    helpExamples: ['奸商推荐 🔒'],
    nextActions: [],
    matchers: [
      { routes: ['user-account', 'shortcut-gate'], kind: 'exact', pattern: '(?:奸商推荐|奸商买什么|奸商购物|虚空商人推荐|虚空商人买什么)', aleca: { query: 'none' } },
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
    helpSectionId: 'shop',
    helpTitle: '商店',
    helpSummary: '九家总览、单家货单和已购标记',
    helpExamples: [
      { command: '商店 🔒', description: '查看全部支持商店与当前轮换概况' },
      { command: '商店 1 / 商店 泰辛', description: '按编号或名称展开单家货单' },
    ],
    nextActions: [],
    matchers: [
      { routes: ['user-account', 'shortcut-gate'], kind: 'regex', pattern: '^商店(?:\\s+(?<query>\\S+))?$', flags: 'u', aleca: { query: 'capture' } },
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
    helpSectionId: 'shop',
    helpTitle: '本周好货',
    helpSummary: '泰辛/圣言者周货与瓦奇娅复刻精选',
    helpExamples: ['本周好货 🔒'],
    nextActions: [],
    matchers: [
      { routes: ['user-account', 'shortcut-gate'], kind: 'exact', pattern: '(?:本周好货|好货|好货清单)', aleca: { query: 'none' } },
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
    helpSectionId: 'shop',
    helpTitle: '轮换日历',
    helpSummary: '未来 8 周回廊、泰辛和瓦奇娅排期',
    helpExamples: ['轮换日历 🔒'],
    nextActions: [],
    matchers: [
      { routes: ['user-account', 'shortcut-gate'], kind: 'exact', pattern: '(?:轮换日历|排期|日历|未来轮换)', aleca: { query: 'none' } },
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
    helpSectionId: 'account',
    helpTitle: '紫卡',
    helpSummary: '词条等级、神卡判定和行情估价',
    helpExamples: ['我的紫卡 / 紫卡 3'],
    nextActions: [],
    matchers: [
      { routes: ['user-account', 'shortcut-gate'], kind: 'exact', pattern: '(?:我的紫卡|紫卡列表|紫卡)', aleca: { query: 'none' } },
      { routes: ['user-account', 'shortcut-gate'], kind: 'regex', pattern: '^(?:我的紫卡|紫卡)\\s+(?<query>\\S.*)$', flags: 'u', aleca: { query: 'capture' } },
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
    helpSectionId: 'shop',
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
    helpSectionId: 'subscription',
    helpTitle: '订阅',
    helpSummary: '14 类事件、商品上架和轮换提醒；由 QQ 会话保存',
    helpExamples: [
      { command: '订阅 裂缝 [筛选]', description: '普通/钢铁裂缝；可筛任务、纪元、全能等' },
      { command: '订阅 仲裁 [任务词]', description: '仲裁轮换；“仲裁推荐”只推 S/A 好场地' },
      { command: '订阅 警报/入侵/活动 [词]', description: '按奖励或事件词筛选；不带词则订阅全部' },
      { command: '订阅 突击/钢铁侵袭 [词]', description: '每日刷新后推送，可按任务或星球筛选' },
      { command: '订阅 赏金 <物品|任务词>', description: '赏金轮换命中目标时推送；必须带筛选词' },
      { command: '订阅 虚空商人/重要情报', description: '商人到离提醒；重要情报合并四类事件' },
      { command: '订阅 轮换/复刻 <名称>', description: '回廊、泰辛或瓦奇娅到点提醒一次' },
      { command: '订阅 周常', description: '每周刷新后推送周常清单与本周好货' },
      { command: '订阅 商店 [泰辛|圣言者]', description: '周货更新与轮换前未购提醒；仅用户私聊' },
      { command: '订阅 商品 <物品>', description: '可算上架预告或商人到货对账提醒' },
      { command: '订阅 掉落 [全部|物品]', description: '账号新增掉落提醒；仅用户私聊' },
      { command: '我的订阅', description: '查看当前会话内自己建立的全部订阅' },
      { command: '暂停/恢复/取消订阅 <编号|全部>', description: '编号以“我的订阅”当前列表为准' },
    ],
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
    helpSectionId: 'wishlist',
    helpTitle: '愿望单',
    helpSummary: '现有合价单立即出市场卡；之后秒级提醒',
    helpExamples: [
      { command: '愿望 商品 价格', description: '建立目标价；已有合价单时立即返回行情' },
      { command: '愿望单', description: '查看全部愿望、状态、目标价与短编号' },
      { command: '改价/暂停/继续 <短编号>', description: '调整目标价或暂时停用、恢复盯价' },
      { command: '已购/取消 <短编号>', description: '标记已购或删除愿望' },
    ],
    nextActions: [],
    matchers: [
      { routes: ['wishlist', 'shortcut-gate'], kind: 'exact', pattern: '(?:愿望单|我的愿望单|愿望列表)' },
      { routes: ['wishlist', 'shortcut-gate'], kind: 'regex', pattern: '^(?:愿望|蹲价|盯价|订阅愿望)\\s+.+\\s+(?:≤|<=|不高于|最高|至多)?\\s*\\d+(?:\\.\\d+)?$', flags: 'u' },
      { routes: ['wishlist', 'shortcut-gate'], kind: 'regex', pattern: '^(?:愿望\\s*)?(?:已购|买到|改价|暂停|继续|恢复|取消)(?:\\s+|$).+', flags: 'u' },
    ],
  }),
]);

const COMMAND_BY_ID = new Map(COMMAND_REGISTRY.map((entry) => [entry.commandId, entry]));
const HELP_SECTION_BY_ID = new Map(HELP_SECTION_REGISTRY.map((section) => [section.id, section]));

function normalizeCommandText(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/^\//u, '').replace(/[\u3000\s]+/gu, ' ');
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

function getCommand(commandId) {
  return COMMAND_BY_ID.get(commandId) || null;
}

function getHelpSection(sectionId) {
  return HELP_SECTION_BY_ID.get(String(sectionId || '')) || null;
}

function helpSectionTopicTokens(section) {
  return [...new Set([section.id, section.title, section.helpQuery, ...(section.aliases || [])]
    .map((value) => normalizeCommandText(value))
    .filter(Boolean))];
}

function commandTopicTokens(entry) {
  const canonicalHead = String(entry.canonicalSyntax || '').match(/^[^\s｜|[<]+/u)?.[0] || '';
  return [entry.commandId, entry.helpTitle, canonicalHead, ...(entry.aliases || [])]
    .map((value) => normalizeCommandText(value))
    .filter(Boolean);
}

function resolveHelpTopic(value) {
  const text = normalizeCommandText(value);
  if (!text) return { kind: 'main', sectionId: null, commandId: null, text };

  // Help has two levels only: the complete module directory and a module's
  // complete command list. Command aliases are convenience jumps to modules,
  // never a third single-command help page.
  for (const section of HELP_SECTION_REGISTRY) {
    if (helpSectionTopicTokens(section).includes(text)) {
      return { kind: 'section', sectionId: section.id, commandId: null, text };
    }
  }
  for (const entry of COMMAND_REGISTRY) {
    if (commandTopicTokens(entry).includes(text)) {
      return { kind: 'section', sectionId: entry.helpSectionId, commandId: null, text };
    }
  }
  return null;
}

function listHelpSections() {
  return [...HELP_SECTION_REGISTRY].sort((left, right) => left.order - right.order);
}

function matchCommandText(value, route, commandId = null) {
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

function matchesRegistryRoute(value, route) {
  return Boolean(matchCommandText(value, route));
}

const CONTEXTUAL_PERSONAL_QUERY = /^(?:我有|我的库存|我的遗物).*(?:这些|那些|它们|上面(?:这些|那些)?|刚才(?:这些|那些)?)/u;

function isUserPrivateCommand(value) {
  const text = normalizeCommandText(value);
  if (CONTEXTUAL_PERSONAL_QUERY.test(text)) return false;
  return Boolean(matchCommandText(text, 'user-account'));
}

function matchWeeklyCommand(value) {
  return matchCommandText(value, 'weekly');
}

function matchWishlistCommand(value) {
  return matchCommandText(value, 'wishlist');
}

function matchSubscriptionCommand(value) {
  return matchCommandText(value, 'subscription');
}

function matchIntelCommand(value) {
  return matchCommandText(value, 'intel');
}

function directIntelType(value) {
  return matchIntelCommand(value)?.entry?.intelType || null;
}

function matchArbitrationCommand(value) {
  return matchCommandText(value, 'arbitration');
}

function buildTemplateCatalog() {
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

function buildHelpSections({ sectionId = null } = {}) {
  const sections = [];
  const selectedSections = listHelpSections().filter((section) => {
    if (sectionId && section.id !== sectionId) return false;
    return true;
  });
  for (const section of selectedSections) {
    const entries = COMMAND_REGISTRY.filter((entry) => entry.helpSectionId === section.id && entry.helpExamples?.length);
    if (!entries.length) continue;
    const commands = entries.flatMap((entry) => entry.helpExamples.map((example) => ({
      commandId: entry.commandId,
      title: entry.helpTitle,
      command: typeof example === 'string' ? example : example.command,
      description: typeof example === 'string' ? entry.helpSummary : example.description,
      privacyScope: entry.privacyScope,
    })));
    sections.push({ id: section.id, title: section.title, commands });
  }
  return sections;
}

function buildToolCommandSummary() {
  return COMMAND_REGISTRY
    .filter((entry) => entry.modelCallable && !entry.guideOnly)
    .map((entry) => entry.canonicalSyntax)
    .join('、');
}

function registryContractErrors() {
  const errors = [];
  const alecaQueryModes = new Set(['none', 'capture', 'fullText', 'ownedInventory']);
  const seen = new Set();
  const sectionIds = new Set();
  const sectionTopics = new Map();
  for (const section of HELP_SECTION_REGISTRY) {
    if (!section || !/^[a-z][a-z0-9-]+$/u.test(String(section.id || ''))) errors.push('help section id is invalid');
    if (sectionIds.has(section.id)) errors.push(`duplicate help section id: ${section.id}`);
    sectionIds.add(section.id);
    if (!section.title) errors.push(`${section.id || '<missing>'}.title is required`);
    if (!section.helpQuery) errors.push(`${section.id || '<missing>'}.helpQuery is required`);
    if (!section.summary) errors.push(`${section.id || '<missing>'}.summary is required`);
    if (!Array.isArray(section.aliases) || section.aliases.length === 0) errors.push(`${section.id}.aliases must be non-empty`);
    const sectionAliases = new Set();
    for (const alias of section.aliases || []) {
      const normalized = normalizeCommandText(alias);
      if (!normalized) errors.push(`${section.id}.aliases must not contain empty values`);
      if (sectionAliases.has(normalized)) errors.push(`duplicate help section alias: ${section.id}.${normalized}`);
      sectionAliases.add(normalized);
    }
    if (!Number.isFinite(section.order)) errors.push(`${section.id}.order must be numeric`);
    const localTopics = new Set();
    for (const topic of helpSectionTopicTokens(section)) {
      if (localTopics.has(topic)) errors.push(`duplicate help topic in section ${section.id}: ${topic}`);
      localTopics.add(topic);
      const previous = sectionTopics.get(topic);
      if (previous && previous !== section.id) errors.push(`help topic belongs to multiple sections: ${topic}`);
      sectionTopics.set(topic, section.id);
    }
  }
  const commandTopics = new Map();
  for (const entry of COMMAND_REGISTRY) {
    for (const field of ['commandId', 'canonicalSyntax', 'argumentSchema', 'privacyScope', 'executor', 'helpSectionId', 'helpTitle', 'helpSummary']) {
      if (!entry[field]) errors.push(`${entry.commandId || '<missing>'}.${field} is required`);
    }
    if (entry.helpSectionId && !sectionIds.has(entry.helpSectionId)) errors.push(`${entry.commandId}.helpSectionId is unknown: ${entry.helpSectionId}`);
    if (seen.has(entry.commandId)) errors.push(`duplicate commandId: ${entry.commandId}`);
    seen.add(entry.commandId);
    if (!Array.isArray(entry.aliases) || entry.aliases.length === 0) errors.push(`${entry.commandId}.aliases must be non-empty`);
    const aliases = new Set();
    for (const alias of entry.aliases || []) {
      const normalized = normalizeCommandText(alias);
      if (!normalized) errors.push(`${entry.commandId}.aliases must not contain empty values`);
      if (aliases.has(normalized)) errors.push(`duplicate command alias: ${entry.commandId}.${normalized}`);
      aliases.add(normalized);
    }
    if (!Array.isArray(entry.helpExamples) || entry.helpExamples.length === 0) errors.push(`${entry.commandId}.helpExamples must be non-empty`);
    for (const example of entry.helpExamples || []) {
      if (typeof example === 'string') {
        if (!normalizeCommandText(example)) errors.push(`${entry.commandId}.helpExamples must not contain empty strings`);
      } else if (!example || typeof example !== 'object' || !normalizeCommandText(example.command) || !normalizeCommandText(example.description)) {
        errors.push(`${entry.commandId}.helpExamples object requires command and description`);
      }
    }
    if (!Array.isArray(entry.nextActions)) errors.push(`${entry.commandId}.nextActions must be an array`);
    if (!Array.isArray(entry.matchers)) errors.push(`${entry.commandId}.matchers must be an array`);
    if (!['public', 'session', 'userPrivate'].includes(entry.privacyScope)) errors.push(`${entry.commandId}.privacyScope is invalid`);
    if (typeof entry.fastPath !== 'boolean') errors.push(`${entry.commandId}.fastPath must be boolean`);
    if (typeof entry.modelCallable !== 'boolean') errors.push(`${entry.commandId}.modelCallable must be boolean`);
    for (const topic of commandTopicTokens(entry)) {
      const previous = commandTopics.get(topic);
      if (previous && previous !== entry.commandId) errors.push(`command topic belongs to multiple commands: ${topic}`);
      const sectionOwner = sectionTopics.get(topic);
      if (sectionOwner && sectionOwner !== entry.helpSectionId) errors.push(`command topic resolves to a different help section: ${entry.commandId}.${topic} -> ${sectionOwner}`);
      commandTopics.set(topic, entry.commandId);
    }
    for (const matcher of entry.matchers || []) {
      try { matcherPattern(matcher); } catch (error) { errors.push(`${entry.commandId} matcher invalid: ${String(error?.message || error)}`); }
      if (matcherHasRoute(matcher, 'user-account')) {
        if (entry.executor !== 'alecaframe.runAlecaMessage') errors.push(`${entry.commandId} user-account matcher requires alecaframe executor`);
        if (matcher.aleca?.command !== undefined && !normalizeCommandText(matcher.aleca.command)) errors.push(`${entry.commandId} user-account matcher has invalid aleca.command`);
        if (!alecaQueryModes.has(matcher.aleca?.query)) errors.push(`${entry.commandId} user-account matcher has invalid aleca.query`);
        if (['capture', 'ownedInventory'].includes(matcher.aleca?.query) && !String(matcher.pattern).includes('(?<query>')) {
          errors.push(`${entry.commandId} user-account matcher must expose a named query capture`);
        }
      } else if (matcher.aleca) {
        errors.push(`${entry.commandId} non-user-account matcher must not declare aleca metadata`);
      }
    }
  }
  for (const section of HELP_SECTION_REGISTRY) {
    if (!COMMAND_REGISTRY.some((entry) => entry.helpSectionId === section.id)) errors.push(`help section has no commands: ${section.id}`);
  }
  return errors;
}

module.exports = {
  COMMAND_REGISTRY_SCHEMA_VERSION,
  HELP_SECTION_REGISTRY,
  COMMAND_REGISTRY,
  normalizeCommandText,
  getCommand,
  getHelpSection,
  resolveHelpTopic,
  listHelpSections,
  matchCommandText,
  matchesRegistryRoute,
  isUserPrivateCommand,
  matchWeeklyCommand,
  matchWishlistCommand,
  matchSubscriptionCommand,
  matchIntelCommand,
  directIntelType,
  matchArbitrationCommand,
  buildTemplateCatalog,
  buildHelpSections,
  buildToolCommandSummary,
  registryContractErrors,
};
