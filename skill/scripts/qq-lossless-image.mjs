import { readFile } from 'node:fs/promises';
import path from 'node:path';

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const API_BASE = 'https://api.sgroup.qq.com';
const REQUEST_TIMEOUT_MS = 120_000;

export function parseQQMediaTarget(target) {
  const match = String(target || '').trim().match(/^qqbot:(c2c|group):(.+)$/iu);
  if (!match) throw new Error('lossless QQ image delivery only supports c2c/group targets');
  return { scope: match[1].toLowerCase(), id: match[2] };
}

export function resolveQQCredentials(config, accountId = '') {
  const qqbot = config?.channels?.qqbot || {};
  const account = accountId && qqbot.accounts?.[accountId]
    ? qqbot.accounts[accountId]
    : qqbot.accounts?.default || qqbot;
  const appId = String(account?.appId || '').trim();
  const clientSecret = String(account?.clientSecret || '').trim();
  if (!appId || !clientSecret) throw new Error('QQ Bot credentials are unavailable');
  return { appId, clientSecret };
}

function configPath() {
  if (process.env.OPENCLAW_CONFIG_PATH) return path.resolve(process.env.OPENCLAW_CONFIG_PATH);
  const stateDir = process.env.OPENCLAW_STATE_DIR
    ? path.resolve(process.env.OPENCLAW_STATE_DIR)
    : path.join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw');
  return path.join(stateDir, 'openclaw.json');
}

async function readRuntimeConfig() {
  return JSON.parse(await readFile(configPath(), 'utf8'));
}

async function postJson(url, body, { token = null, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'openclaw-warframe-assistant/1',
        ...(token ? { Authorization: `QQBot ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
    if (!response.ok) {
      const detail = data?.message || data?.msg || `HTTP ${response.status}`;
      throw new Error(`QQ lossless image delivery failed: ${detail}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// QQ 当前会把“上传 file_info → 再发 msg_type=7”的主动长图压成约 2048px 高。
// 让 /files 在上传完成时直接发出图片，跳过第二次消息请求；被动命令回复仍走插件原链路。
export async function sendQQLosslessLocalImage(target, mediaPath, options = {}) {
  const { scope, id } = parseQQMediaTarget(target);
  const config = options.config || await readRuntimeConfig();
  const credentials = resolveQQCredentials(config, options.accountId);
  const access = await postJson(TOKEN_URL, credentials, { fetchImpl: options.fetchImpl });
  if (!access?.access_token) throw new Error('QQ access token response is invalid');
  const fileData = (await readFile(path.resolve(mediaPath))).toString('base64');
  const resource = scope === 'c2c' ? 'users' : 'groups';
  return postJson(`${API_BASE}/v2/${resource}/${encodeURIComponent(id)}/files`, {
    file_type: 1,
    file_data: fileData,
    srv_send_msg: true,
  }, { token: access.access_token, fetchImpl: options.fetchImpl });
}
