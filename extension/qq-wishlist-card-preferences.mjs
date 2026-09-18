import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

// 愿望卡总开关（私聊 `愿望卡 开/关/状态`）：控制愿望相关的富卡片
// （命中、跟踪、状态反馈）是合并成一条消息，还是按兼容方式分开发送。
//
// 与 wmCard 偏好的区别：默认值是「开」。愿望命中卡的一体化是既定产品行为，
// 这个开关是玩家级回滚/降级杠杆，而不是新格式的可选装饰；因此缺失键
// （新玩家、旧文件、刚升级）一律按一体卡处理，只有显式写入 false 才拆分。
const STATE_VERSION = 1;
export const DEFAULT_WISHLIST_CARD_MERGED = true;
export const WISHLIST_CARD_PREFERENCE_FILE = 'warframe-wishlist-card-preferences.json';

export function parseWishlistCardPreferenceCommand(value) {
  const match = /^愿望(?:卡片?|通知卡)(?:\s+(开|关|状态))?$/iu.exec(String(value || '').trim());
  if (!match) return null;
  const action = match[1] || '状态';
  return { action, merged: action === '开' ? true : action === '关' ? false : null };
}

// 只保存「QQ 账号域 + senderId」的 SHA-256 摘要，不落盘原始 QQ 标识。
export function wishlistCardPreferenceKey(accountId, senderId) {
  const account = String(accountId || '').trim().toLowerCase();
  const sender = String(senderId || '').trim().toLowerCase();
  if (!sender) return null;
  return createHash('sha256').update(`qqbot\0${account}\0${sender}`).digest('hex');
}

export function wishlistCardPreferencePath(statePath) {
  return path.join(path.dirname(path.resolve(String(statePath || 'warframe-wishlist.json'))), WISHLIST_CARD_PREFERENCE_FILE);
}

async function readState(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    if (parsed?.version !== STATE_VERSION || !parsed?.players || typeof parsed.players !== 'object') {
      return { version: STATE_VERSION, players: {} };
    }
    const players = {};
    for (const [key, value] of Object.entries(parsed.players)) {
      if (/^[a-f0-9]{64}$/u.test(key) && typeof value === 'boolean') players[key] = value;
    }
    return { version: STATE_VERSION, players };
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: STATE_VERSION, players: {} };
    // 损坏文件必须显式失败：调用方按兼容拆分处理，绝不猜成「已开启」。
    throw error;
  }
}

export async function getWishlistCardMerged({
  accountId, senderId, statePath = null, filePath = null,
}) {
  const key = wishlistCardPreferenceKey(accountId, senderId);
  if (!key) return DEFAULT_WISHLIST_CARD_MERGED;
  const state = await readState(filePath || wishlistCardPreferencePath(statePath));
  return Object.hasOwn(state.players, key) ? state.players[key] : DEFAULT_WISHLIST_CARD_MERGED;
}

export async function setWishlistCardMerged({
  accountId, senderId, merged, statePath = null, filePath = null,
}) {
  const key = wishlistCardPreferenceKey(accountId, senderId);
  if (!key) throw new Error('missing QQ sender identity');
  const target = filePath || wishlistCardPreferencePath(statePath);
  const state = await readState(target);
  state.players[key] = Boolean(merged);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, target);
  return Boolean(merged);
}
