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
import {
  buildTemplateCatalog,
  directIntelType,
  isUserPrivateCommand,
  matchArbitrationCommand,
  matchSubscriptionCommand,
  matchWeeklyCommand,
  matchWishlistCommand,
} from './command-registry.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
// scripts → warframe-assistant → skills → workspace（与插件的路径解析保持同一根）
const workspaceDir = path.resolve(scriptsDir, '..', '..', '..');
const DEFAULT_SUBSCRIPTION_STATE = path.join(workspaceDir, 'state', 'warframe-subscriptions.json');
const DEFAULT_WEEKLY_STATE = path.join(workspaceDir, 'state', 'warframe-weekly.json');
const DEFAULT_WISHLIST_STATE = path.join(workspaceDir, 'state', 'warframe-wishlist.json');
const DEFAULT_CARD_DIR = path.join(workspaceDir, '.cache', 'warframe-cards');

// 模板目录由唯一命令注册表生成；保留旧字段兼容 `dispatch list` 的调用者。
export const TEMPLATE_CATALOG = Object.freeze(buildTemplateCatalog());

const normalize = (value) => String(value ?? '').normalize('NFKC').trim().replace(/^\//u, '').replace(/[\u3000\s]+/gu, ' ');

function evidenceMeta(result) {
  const data = result?.data || {};
  const fetchedAt = result?.fetchedAt || data?.fetchedAt || null;
  const sourceTimestamp = result?.sourceTimestamp || data?.sourceTimestamp || null;
  const expiry = result?.expiry || data?.expiry || null;
  const source = result?.source || data?.source || null;
  return {
    ...(fetchedAt ? { fetchedAt } : {}),
    ...(sourceTimestamp ? { sourceTimestamp } : {}),
    ...(expiry ? { expiry } : {}),
    ...(source ? { source } : {}),
  };
}

export async function dispatchCommand(message, options = {}) {
  const text = normalize(message);
  if (!text) return { handled: false, reason: 'empty' };
  const cardDir = options.cardDir || process.env.WARFRAME_CARD_DIR || DEFAULT_CARD_DIR;
  const personalAllowed = options.personalAllowed === true || options.personalAllowed === 'true';

  if (matchWishlistCommand(text)) {
    const target = String(options.target || '').trim().toLowerCase();
    const ownerId = String(options.owner || '').trim().toLowerCase();
    if (!target || !ownerId) return { handled: true, ok: false, kind: 'wishlist', text: '当前会话缺少可信 QQ 身份，不能修改愿望单。' };
    const { manageWishlist } = await import('./wishlist.mjs');
    const result = await manageWishlist(text, {
      target, ownerId, ownerName: options.ownerName || ownerId,
    }, options.wishlistState || DEFAULT_WISHLIST_STATE, { cardDir });
    return { handled: true, ok: result.ok !== false, kind: 'wishlist', mediaUrl: result.mediaUrl || null, text: result.text || '', ...evidenceMeta(result), ...(result.wish ? { wish: result.wish } : {}) };
  }

  // 个人数据门：非用户私聊一律拒绝，不区分具体命令（与插件行为一致）
  if (isUserPrivateCommand(text)) {
    if (!personalAllowed) {
      return { handled: true, ok: false, kind: 'personal-denied', text: '这是个人账号命令，只在用户本人私聊里可用。' };
    }
    const { runAlecaMessage } = await import('./alecaframe.mjs');
    const result = await runAlecaMessage(text, { cardDir });
    if (result.handled) return { handled: true, ok: result.ok !== false, kind: result.command || 'account', mediaUrl: result.mediaUrl || null, text: result.text || '', followupText: result.followupText || null, ...evidenceMeta(result) };
    return { handled: false, reason: 'personal-unparsed' };
  }

  if (matchWeeklyCommand(text)) {
    if (!personalAllowed) {
      return { handled: true, ok: false, kind: 'weekly-denied', text: '周常数据只允许用户本人在 QQ 私聊中查询或修改。' };
    }
    const { manageWeekly } = await import('./weekly.mjs');
    const context = { target: options.target || 'model:fallback', ownerId: options.owner || 'owner', ownerName: options.ownerName || '' };
    const result = await manageWeekly(text, context, options.weeklyState || DEFAULT_WEEKLY_STATE, cardDir);
    return { handled: true, ok: result.ok !== false, kind: 'weekly', mediaUrl: result.mediaUrl || null, text: result.text || '', ...evidenceMeta(result) };
  }

  if (matchArbitrationCommand(text)) {
    const { queryArbitration } = await import('./subscriptions.mjs');
    const result = await queryArbitration(options.subscriptionState || DEFAULT_SUBSCRIPTION_STATE, cardDir);
    return { handled: true, ok: result.ok !== false, kind: 'arbitration', mediaUrl: result.mediaUrl || null, text: result.text || '', ...evidenceMeta(result) };
  }

  const intelType = directIntelType(text);
  if (intelType) {
    // 与插件同步：用户私聊的「虚空商人」走购物建议版（未到货 alecaframe 内部回退查询卡）
    if (intelType === 'trader' && personalAllowed) {
      const { runAlecaMessage } = await import('./alecaframe.mjs');
      const result = await runAlecaMessage('奸商推荐', { cardDir });
      if (result.handled) return { handled: true, ok: result.ok !== false, kind: 'trader-shopping', mediaUrl: result.mediaUrl || null, text: result.text || '', followupText: result.followupText || null, ...evidenceMeta(result) };
    }
    const { queryIntel } = await import('./subscriptions.mjs');
    const result = await queryIntel(intelType, cardDir, options.subscriptionState || DEFAULT_SUBSCRIPTION_STATE);
    return { handled: true, ok: result.ok !== false, kind: intelType, mediaUrl: result.mediaUrl || null, text: result.text || '', ...evidenceMeta(result) };
  }

  // 订阅族：不代办（账本按真实 QQ 会话隔离），返回引导文案
  if (matchSubscriptionCommand(text)) {
    return { handled: true, ok: true, kind: 'subscription-guide', guideOnly: true, text: `订阅命令请直接发送给机器人（如「${text}」），由快捷通道处理，我这边不代设。` };
  }

  // wm / 遗物 / 获取 / 购买 / 裂缝 / 帮助 / 悬赏（悬赏索引在用户私聊时附声望列，env 与插件同一契约）
  if (personalAllowed) process.env.WARFRAME_PERSONAL_OK = '1';
  const { runShortcut } = await import('./shortcuts.mjs');
  const result = await runShortcut(text, { cardDir });
  if (result.handled) return {
    handled: true, ok: result.ok !== false, kind: result.command,
    query: result.query || '', mediaUrl: result.mediaUrl || null,
    text: result.text || '', followupText: result.followupText || null,
    ...evidenceMeta(result),
    ...(result.facts ? { facts: result.facts } : {}),
    ...(result.contextEnvelope ? { contextEnvelope: result.contextEnvelope } : {}),
  };

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
