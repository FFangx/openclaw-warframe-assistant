import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const STATE_VERSION = 1;

export function parseMarketCardPreferenceCommand(value) {
  const match = /^wm\s*卡片(?:\s+(开|关|状态))?$/iu.exec(String(value || '').trim());
  if (!match) return null;
  const action = match[1] || '状态';
  return { action, enabled: action === '开' ? true : action === '关' ? false : null };
}

export function marketCardPreferenceKey(accountId, senderId) {
  const account = String(accountId || '').trim().toLowerCase();
  const sender = String(senderId || '').trim().toLowerCase();
  if (!sender) return null;
  return createHash('sha256').update(`qqbot\0${account}\0${sender}`).digest('hex');
}

export function marketCardPreferencePath(source = process.env) {
  const root = String(source.OPENCLAW_STATE_DIR || '').trim() || path.join(os.homedir(), '.openclaw');
  return path.join(path.resolve(root), 'warframe-market-card-preferences.json');
}

async function readState(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    if (parsed?.version !== STATE_VERSION || !parsed?.players || typeof parsed.players !== 'object') {
      return { version: STATE_VERSION, players: {} };
    }
    const players = {};
    for (const [key, value] of Object.entries(parsed.players)) {
      if (/^[a-f0-9]{64}$/u.test(key) && value === true) players[key] = true;
    }
    return { version: STATE_VERSION, players };
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: STATE_VERSION, players: {} };
    throw error;
  }
}

export async function getMarketCardPreference({ accountId, senderId, filePath = marketCardPreferencePath() }) {
  const key = marketCardPreferenceKey(accountId, senderId);
  if (!key) return false;
  const state = await readState(filePath);
  return state.players[key] === true;
}

export async function setMarketCardPreference({ accountId, senderId, enabled, filePath = marketCardPreferencePath() }) {
  const key = marketCardPreferenceKey(accountId, senderId);
  if (!key) throw new Error('missing QQ sender identity');
  const state = await readState(filePath);
  if (enabled) state.players[key] = true;
  else delete state.players[key];
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, filePath);
  return Boolean(enabled);
}
