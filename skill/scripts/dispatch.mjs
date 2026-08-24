#!/usr/bin/env node

// 统一模板调度器：模型意图识别后的唯一执行口。
// 「AI 只做翻译官，判断全在脚本」——模型把用户话术归一成规范短命令交给这里，
// 本脚本复用各模块的确定性查询/渲染，返回 {handled, mediaUrl, text}；
// 个人数据命令必须同时提供 personal-allowed、匹配的 QQ 私聊 target 与 owner（与插件同一条门）。
//
// 用法：
//   node dispatch.mjs run "<规范命令>" [--personal-allowed true] [--target qqbot:c2c:<发送者>] [--owner <发送者>] [--card-dir <目录>]
//   node dispatch.mjs list        # 输出模板目录（机器可读）

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripDataUriReplacer } from './wfdata.mjs';
import {
  buildTemplateCatalog,
  isUserPrivateCommand,
  matchSubscriptionCommand,
  matchWeeklyCommand,
  matchWishlistCommand,
} from './command-registry.mjs';
import { executeWeeklyUseCase } from './weekly-usecase.mjs';
import { executePersonalUseCase } from './personal-usecase.mjs';
import { executePublicUseCase } from './public-usecase.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
// scripts → warframe-assistant → skills → workspace（与插件的路径解析保持同一根）
const workspaceDir = path.resolve(scriptsDir, '..', '..', '..');
const DEFAULT_SUBSCRIPTION_STATE = path.join(workspaceDir, 'state', 'warframe-subscriptions.json');
const DEFAULT_WEEKLY_STATE = path.join(workspaceDir, 'state', 'warframe-weekly.json');
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
    // Wishlist mutations require plugin-owned cron, gateway refresh, ordered
    // QQ delivery and immediate market inspection. Refuse a partial CLI write
    // instead of changing the ledger without completing those follow-up steps.
    return {
      handled: true,
      ok: false,
      kind: 'wishlist-orchestration-required',
      text: '愿望单必须从可信 QQ 会话执行；当前入口不会修改愿望单。',
    };
  }

  // 个人数据门：非用户私聊一律拒绝，不区分具体命令（与插件行为一致）
  if (isUserPrivateCommand(text)) {
    const target = String(options.target || '').trim().toLowerCase();
    const outcome = await executePersonalUseCase({
      source: 'dispatch-fallback',
      text,
      channel: String(options.channel || (/^qqbot:/u.test(target) ? 'qqbot' : '')).trim().toLowerCase(),
      target,
      actorId: options.owner,
      actorDisplayName: options.ownerName,
      personalAllowed,
      isGroup: options.isGroup === true || /^qqbot:group:/u.test(target),
      cardDir,
    }, {
      execute: async (command) => {
        const { runAlecaMessage } = await import('./alecaframe.mjs');
        return runAlecaMessage(command.text, { cardDir: command.cardDir });
      },
    });
    const result = outcome.result;
    if (result.handled !== false) return { handled: true, ok: result.ok !== false, kind: result.kind || result.command || outcome.commandId || 'account', commandId: outcome.commandId, mediaUrl: result.mediaUrl || null, text: result.text || '', followupText: result.followupText || null, ...evidenceMeta(result) };
    return { handled: false, reason: 'personal-unparsed' };
  }

  if (matchWeeklyCommand(text)) {
    const target = String(options.target || '').trim().toLowerCase();
    const outcome = await executeWeeklyUseCase({
      source: 'dispatch-fallback',
      text,
      channel: String(options.channel || (/^qqbot:/u.test(target) ? 'qqbot' : '')).trim().toLowerCase(),
      target,
      actorId: options.owner,
      actorDisplayName: options.ownerName,
      personalAllowed,
      isGroup: options.isGroup === true || /^qqbot:group:/u.test(target),
      cardDir,
      statePath: options.weeklyState || DEFAULT_WEEKLY_STATE,
    }, {
      manage: async (command) => {
        const { manageWeekly } = await import('./weekly.mjs');
        return manageWeekly(command.text, {
          target: command.target,
          ownerId: command.actorId,
          ownerName: command.actorDisplayName,
        }, command.statePath, command.cardDir);
      },
    });
    const result = outcome.result;
    return {
      handled: true,
      ok: result.ok !== false,
      kind: result.kind || 'weekly',
      mediaUrl: result.mediaUrl || null,
      text: result.text || '',
      ...evidenceMeta(result),
    };
  }

  // 订阅族：不代办（账本按真实 QQ 会话隔离），返回引导文案
  if (matchSubscriptionCommand(text)) {
    return { handled: true, ok: true, kind: 'subscription-guide', guideOnly: true, text: `订阅命令请直接发送给机器人（如「${text}」），由快捷通道处理，我这边不代设。` };
  }

  const target = String(options.target || '').trim().toLowerCase();
  const outcome = await executePublicUseCase({
    source: 'dispatch-fallback', text,
    channel: String(options.channel || (/^qqbot:/u.test(target) ? 'qqbot' : '')).trim().toLowerCase(),
    target, actorId: options.owner, personalAllowed,
    isGroup: options.isGroup === true || /^qqbot:group:/u.test(target), cardDir,
  }, {
    queryArbitration: async () => import('./subscriptions.mjs').then((m) => m.queryArbitration(options.subscriptionState || DEFAULT_SUBSCRIPTION_STATE, cardDir)),
    queryIntel: async (command) => import('./subscriptions.mjs').then((m) => m.queryIntel(command.intelType, cardDir, options.subscriptionState || DEFAULT_SUBSCRIPTION_STATE)),
    runPersonalTrader: async () => import('./alecaframe.mjs').then((m) => m.runAlecaMessage('奸商推荐', { cardDir })),
    runShortcut: async (command) => import('./shortcuts.mjs').then((m) => m.runShortcut(command.text, { cardDir, personalAllowed: command.personalAllowed })),
  });
  const result = outcome.result;
  if (result.handled) return {
    handled: true, ok: result.ok !== false, kind: result.kind || result.command || outcome.commandId,
    commandId: outcome.commandId,
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
        ownerName: args['owner-name'],
        channel: args.channel,
        isGroup: String(args['is-group']).toLowerCase() === 'true',
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
