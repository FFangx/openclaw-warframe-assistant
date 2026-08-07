#!/usr/bin/env node

// 统一模板调度器：模型意图识别后的唯一执行口。
// 「AI 只做翻译官，判断全在脚本」——模型把用户话术归一成规范短命令交给这里，
// 本脚本复用各模块的确定性查询/渲染，返回 {handled, mediaUrl, text}；
// 个人数据命令必须显式 --personal-allowed true 才放行（与插件同一条门）。
//
// 用法：
//   node dispatch.mjs run "<规范命令>" [--personal-allowed true] [--target <会话>] [--owner <发送者>] [--card-dir <目录>]
//   node dispatch.mjs list        # 输出模板目录（机器可读）

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripDataUriReplacer } from './wfdata.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
// scripts → warframe-assistant → skills → workspace（与插件的路径解析保持同一根）
const workspaceDir = path.resolve(scriptsDir, '..', '..', '..');
const DEFAULT_SUBSCRIPTION_STATE = path.join(workspaceDir, 'state', 'warframe-subscriptions.json');
const DEFAULT_WEEKLY_STATE = path.join(workspaceDir, 'state', 'warframe-weekly.json');
const DEFAULT_CARD_DIR = path.join(workspaceDir, '.cache', 'warframe-cards');

// 模板目录：kind / 规范命令样例 / 个人数据与否——SKILL 的意图表与此对齐
export const TEMPLATE_CATALOG = Object.freeze([
  { kind: 'help', example: '帮助', personal: false, intents: '功能/命令/怎么用/你能干什么' },
  { kind: 'market', example: 'wm 悟空p [满级|N级]', personal: false, intents: '问价/多少钱/市价' },
  { kind: 'relic', example: '遗物 前x1｜遗物 战刃', personal: false, intents: '遗物正查/某物哪里出' },
  { kind: 'fissure', example: '裂缝 [钢铁|普通|全能|安魂|任务词|推荐]', personal: false, intents: '现在有什么裂缝' },
  { kind: 'arbitration', example: '仲裁', personal: false, intents: '当前仲裁' },
  { kind: 'alert', example: '警报', personal: false, intents: '当前警报' },
  { kind: 'invasion', example: '入侵', personal: false, intents: '入侵/稀有入侵奖励' },
  { kind: 'event', example: '活动', personal: false, intents: '特殊活动' },
  { kind: 'sortie', example: '突击', personal: false, intents: '今日突击/词缀' },
  { kind: 'incursion', example: '钢铁侵袭', personal: false, intents: '今日钢铁侵袭六节点/钢铁精华哪里刷' },
  { kind: 'bounty', example: '赏金｜赏金 地球｜赏金 实验室｜赏金 阿耶精华（「悬赏」同义）', personal: false, intents: '赏金六区索引/单区全奖池/挑战难度/哪个赏金出某物' },
  { kind: 'trader', example: '虚空商人', personal: false, intents: '奸商在哪/什么时候来' },
  { kind: 'weekly', example: '周常｜完成 1 3｜撤销 2｜跳过 5｜取消跳过 全部｜清空周常', personal: true, intents: '周常清单/打卡' },
  { kind: 'account', example: '我的账号｜我的库存 X｜我的遗物 前N11｜我的赋能 X｜账号周常', personal: true, intents: '个人账号快照' },
  { kind: 'recommend', example: '裂缝推荐 [白金|杜卡德] [速刷|舒适|收益] [单人]', personal: true, intents: '开什么遗物划算/想速刷/想挂机/想要附加收益' },
  { kind: 'refine', example: '精炼推荐 [杜卡德|单人]', personal: true, intents: '哪些遗物值得精炼' },
  { kind: 'ducat-plan', example: '杜卡德｜杜卡德 600｜杜卡德 清仓 保留1', personal: true, intents: '哪些 Prime 部件适合兑换/按目标生成最低白金损失方案' },
  { kind: 'trader-shopping', example: '奸商推荐', personal: true, intents: '奸商买什么' },
  { kind: 'shop', example: '商店｜商店 泰辛｜商店 瓦奇娅', personal: true, intents: '商店总览/某商人卖什么/本周精选/已购' },
  { kind: 'weekly-deals', example: '本周好货', personal: true, intents: '这周商店有什么值得买/好货清单（泰辛/圣言者必抢与周货+瓦奇娅复刻）' },
  { kind: 'rotation-calendar', example: '轮换日历', personal: true, intents: '未来几周回廊战甲/灵化武器/泰辛精选/瓦奇娅复刻排期' },
  { kind: 'rivens', example: '我的紫卡｜紫卡 拉托双枪', personal: true, intents: '紫卡列表/词条数值与等级/神卡判定/单武器行情估价' },
  { kind: 'where-to-buy', example: '哪里买 裂罅破解器', personal: false, intents: '某物品哪里买/在哪换/哪个商人卖' },
  // 订阅族需要真实会话/发送者标识做账本隔离，模型路径不代办：引导用户发规范命令由插件接管
  { kind: 'subscription', example: '订阅 裂缝 钢铁 生存（引导用户自己发送）', personal: false, intents: '设提醒/订阅', guideOnly: true },
]);

const normalize = (value) => String(value ?? '').normalize('NFKC').trim().replace(/^\//u, '').replace(/[\u3000\s]+/gu, ' ');

// 与插件 isPersonalAccountCommand 同一套判定（改动要双侧同步）
function isPersonalCommand(text) {
  return /^(?:我的账号|账号状态|我的状态|账号周常|我的周常状态|周常同步状态|刷新账号|刷新库存)$/u.test(text)
    || /^(?:裂缝推荐|推荐裂缝|开什么遗物|开什么)(?:\s+\S+){0,3}$/u.test(text)
    || /^(?:精炼推荐|遗物精炼|值得精炼|精炼什么)(?:\s+\S+){0,2}$/u.test(text)
    || /^(?:杜卡德|杜卡德推荐|杜卡德兑换)(?:\s+.*)?$/u.test(text)
    || /^(?:奸商推荐|奸商买什么|奸商购物|虚空商人推荐|虚空商人买什么)$/u.test(text)
    // 商店卡的已购标注读快照 → 个人通道（快照读失败脚本内部降级，不影响出卡）
    || /^商店(?:\s+\S+)?$/u.test(text)
    || /^(?:本周好货|好货|好货清单)$/u.test(text)
    || /^(?:轮换日历|排期|日历|未来轮换)$/u.test(text)
    || /^(?:我的紫卡|紫卡列表|紫卡)(?:\s+\S+)*$/u.test(text)
    || /^(?:我的遗物|我的赋能|我的库存)(?:\s+.*)?$/u.test(text)
    // 与插件同步：决策类复合问句不当库存查询
    || (/^我(?:有多少|有).+(?:吗|么|？|\?)?$/u.test(text) && !/卖|推荐|建议|该不该|要不要|值不值|留着|出手/u.test(text));
}

function isWeeklyCommand(text) {
  return /^(?:周常|当前周常|周常清单|周常列表|本周周常|周报|周常帮助|清空周常)$/u.test(text)
    || /^(?:完成|撤销|跳过|取消跳过)\s+\S.*$/u.test(text);
}

function directIntelType(text) {
  if (/^(?:警报|当前警报)$/u.test(text)) return 'alert';
  if (/^(?:入侵|当前入侵)$/u.test(text)) return 'invasion';
  if (/^(?:活动|当前活动)$/u.test(text)) return 'event';
  if (/^(?:虚空商人|奸商|当前虚空商人)$/u.test(text)) return 'trader';
  if (/^(?:突击|当前突击|今日突击)$/u.test(text)) return 'sortie';
  if (/^(?:钢铁侵袭|钢铁之路侵袭|今日钢铁侵袭|侵袭)$/u.test(text)) return 'incursion';
  return null;
}

export async function dispatchCommand(message, options = {}) {
  const text = normalize(message);
  if (!text) return { handled: false, reason: 'empty' };
  const cardDir = options.cardDir || process.env.WARFRAME_CARD_DIR || DEFAULT_CARD_DIR;
  const personalAllowed = options.personalAllowed === true || options.personalAllowed === 'true';

  // 个人数据门：非主人私聊一律拒绝，不区分具体命令（与插件行为一致）
  if (isPersonalCommand(text)) {
    if (!personalAllowed) {
      return { handled: true, ok: false, kind: 'personal-denied', text: '这是个人账号命令，只在用户本人私聊里可用。' };
    }
    const { runAlecaMessage } = await import('./alecaframe.mjs');
    const result = await runAlecaMessage(text, { cardDir });
    if (result.handled) return { handled: true, ok: result.ok !== false, kind: result.command || 'account', mediaUrl: result.mediaUrl || null, text: result.text || '', followupText: result.followupText || null };
    return { handled: false, reason: 'personal-unparsed' };
  }

  if (isWeeklyCommand(text)) {
    const { manageWeekly } = await import('./weekly.mjs');
    const context = { target: options.target || 'model:fallback', ownerId: options.owner || 'owner', ownerName: options.ownerName || '' };
    const result = await manageWeekly(text, context, options.weeklyState || DEFAULT_WEEKLY_STATE, cardDir);
    return { handled: true, ok: result.ok !== false, kind: 'weekly', mediaUrl: result.mediaUrl || null, text: result.text || '' };
  }

  if (/^(?:仲裁|当前仲裁)$/u.test(text)) {
    const { queryArbitration } = await import('./subscriptions.mjs');
    const result = await queryArbitration(options.subscriptionState || DEFAULT_SUBSCRIPTION_STATE, cardDir);
    return { handled: true, ok: result.ok !== false, kind: 'arbitration', mediaUrl: result.mediaUrl || null, text: result.text || '' };
  }

  const intelType = directIntelType(text);
  if (intelType) {
    // 与插件同步：主人私聊的「虚空商人」走购物建议版（未到货 alecaframe 内部回退查询卡）
    if (intelType === 'trader' && personalAllowed) {
      const { runAlecaMessage } = await import('./alecaframe.mjs');
      const result = await runAlecaMessage('奸商推荐', { cardDir });
      if (result.handled) return { handled: true, ok: result.ok !== false, kind: 'trader-shopping', mediaUrl: result.mediaUrl || null, text: result.text || '', followupText: result.followupText || null };
    }
    const { queryIntel } = await import('./subscriptions.mjs');
    const result = await queryIntel(intelType, cardDir, options.subscriptionState || DEFAULT_SUBSCRIPTION_STATE);
    return { handled: true, ok: result.ok !== false, kind: intelType, mediaUrl: result.mediaUrl || null, text: result.text || '' };
  }

  // 订阅族：不代办（账本按真实 QQ 会话隔离），返回引导文案
  if (/^(?:订阅|提醒|取消订阅|暂停订阅|恢复订阅|我的订阅)(?:\s|$)/u.test(text)) {
    return { handled: true, ok: true, kind: 'subscription-guide', guideOnly: true, text: `订阅命令请直接发送给机器人（如「${text}」），由快捷通道处理，我这边不代设。` };
  }

  // wm / 遗物 / 裂缝 / 帮助 / 悬赏（悬赏索引在主人私聊时附声望列，env 与插件同一契约）
  if (personalAllowed) process.env.WARFRAME_PERSONAL_OK = '1';
  const { runShortcut } = await import('./shortcuts.mjs');
  const result = await runShortcut(text, { cardDir });
  if (result.handled) return { handled: true, ok: result.ok !== false, kind: result.command, mediaUrl: result.mediaUrl || null, text: result.text || '', followupText: result.followupText || null };

  return { handled: false, reason: 'no-template' };
}

function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) result._.push(token);
    else {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next != null && !next.startsWith('--')) { result[key] = next; index += 1; }
      else result[key] = true;
    }
  }
  return result;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  try {
    if (command === 'list') {
      process.stdout.write(`${JSON.stringify(TEMPLATE_CATALOG, null, 2)}\n`);
      return;
    }
    if (command === 'run') {
      const result = await dispatchCommand(args._.join(' '), {
        personalAllowed: args['personal-allowed'],
        target: args.target,
        owner: args.owner,
        cardDir: args['card-dir'],
      });
      process.stdout.write(`${JSON.stringify(result, stripDataUriReplacer)}\n`);
      if (result.handled === false) process.exitCode = 2;
      return;
    }
    process.stdout.write(`${JSON.stringify({ handled: false, error: '用法：run "<规范命令>" [--personal-allowed true] [--target t] [--owner o]｜list' })}\n`);
    process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ handled: true, ok: false, error: String(error?.message || error), text: '查询暂时失败，请稍后重试。' })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
