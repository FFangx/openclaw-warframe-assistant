import os from 'node:os';
import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const QQBOT_PACKAGE_PREFIX = 'openclaw-qqbot-';

function shortenLabel(value, max = 10) {
  const chars = [...String(value || '')];
  return chars.length <= max ? chars.join('') : `${chars.slice(0, Math.max(1, max - 1)).join('')}…`;
}

function commandButton(id, label, data, enter) {
  return {
    id,
    render_data: { label: shortenLabel(label), visited_label: shortenLabel(label), style: 0 },
    action: {
      type: 2,
      permission: { type: 2 },
      data: String(data),
      enter: Boolean(enter),
      unsupport_tips: '请升级 QQ 后重试',
    },
  };
}

export function buildMarketKeyboard(data) {
  if (!data?.ok || data.kind !== 'market' || data.viewMode === 'trend') return null;
  const whispers = Array.isArray(data.contactTemplates) ? data.contactTemplates.filter(Boolean).slice(0, 5) : [];
  const sellerButtons = whispers.slice(1).map((whisper, index) => commandButton(
    `wm-seller-${index + 2}`,
    `${index + 2}号卖家`,
    whisper,
    false,
  ));
  const query = String(data.marketQuery || data.item?.zhName || data.item?.name || '').trim();
  if (!query) return null;
  const rows = [];
  if (sellerButtons.length) rows.push({ buttons: sellerButtons });
  rows.push({ buttons: [commandButton('wm-trend', `走势 ${data.item?.zhName || data.item?.name || ''}`, `wm ${query} 走势`, true)] });
  return { content: { rows } };
}

function qqbotConfig(cfg, accountId) {
  const root = cfg?.channels?.qqbot || {};
  const selected = accountId && accountId !== 'default' ? root.accounts?.[accountId] : root.accounts?.default;
  const merged = { ...root, ...(selected || {}) };
  const appId = typeof merged.appId === 'string' ? merged.appId.trim() : '';
  const clientSecret = typeof merged.clientSecret === 'string' ? merged.clientSecret.trim() : '';
  if (!appId || !clientSecret) throw new Error('QQBot inline keyboard credentials are unavailable');
  return { appId, clientSecret };
}

async function loadNativeSender(openclawHome) {
  const base = path.join(openclawHome, 'npm', 'projects');
  const projects = (await readdir(base, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(QQBOT_PACKAGE_PREFIX))
    .map((entry) => entry.name)
    .sort();
  for (const project of projects) {
    const packageRoot = path.join(base, project, 'node_modules', '@openclaw', 'qqbot');
    try {
      const pkg = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
      if (pkg.name !== '@openclaw/qqbot') continue;
      const files = await readdir(path.join(packageRoot, 'dist'));
      const sender = files.find((name) => /^sender-[\w-]+\.js$/u.test(name));
      if (!sender) continue;
      const loaded = await import(pathToFileURL(path.join(packageRoot, 'dist', sender)).href);
      if (typeof loaded.c === 'function') return { getMessageApi: loaded.c, version: pkg.version };
    } catch { /* try the next managed QQBot installation */ }
  }
  throw new Error('QQBot native inline keyboard sender is unavailable');
}

export async function sendMarketKeyboard(options) {
  const keyboard = buildMarketKeyboard(options.data);
  if (!keyboard) return { sent: false, reason: 'not-applicable' };
  const match = String(options.target || '').match(/^qqbot:c2c:([^:]+)$/iu);
  if (!match) return { sent: false, reason: 'not-c2c' };
  const creds = qqbotConfig(options.cfg, options.accountId);
  const configuredHome = options.openclawHome || process.env.OPENCLAW_HOME || os.homedir();
  const stateDir = path.basename(configuredHome).toLowerCase() === '.openclaw'
    ? configuredHome
    : path.join(configuredHome, '.openclaw');
  const sender = options.loadSender ? await options.loadSender() : await loadNativeSender(stateDir);
  const messageApi = sender.getMessageApi(creds.appId);
  const result = await messageApi.sendMessage('c2c', match[1], '可选操作', creds, {
    ...(options.replyToId ? { msgId: String(options.replyToId) } : {}),
    inlineKeyboard: keyboard,
  });
  return { sent: true, messageId: result?.id || result?.message_id || '', version: sender.version || '' };
}
