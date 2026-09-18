import { callbackButton, commandButton, sendQQKeyboardMessage } from './qq-market-keyboard.mjs';
import { wishlistInteractions } from './qq-wishlist-interactions.mjs';

function callback(options, action, wish, label, id, payload = null) {
  const data = wishlistInteractions.register({
    accountId: options.accountId, senderId: options.senderId, action,
    wishId: wish.id, expectedUpdatedAt: wish.updatedAt, payload,
  });
  return data ? callbackButton(id, label, data) : null;
}

function rankSuffix(wish) {
  if (wish.rankMode === 'max') return ' 满级';
  if (wish.rankMode === 'exact' && wish.rank != null) return ` 等级 ${wish.rank}`;
  return '';
}

export function buildWishlistKeyboard(result, options = {}) {
  const wishes = Array.isArray(result?.wishes) ? result.wishes : result?.wish ? [result.wish] : [];
  const hit = Array.isArray(result?.hits) ? result.hits[0] : null;
  const wish = hit?.wish || wishes[0];
  if (result?.command === 'summary' && wishes.length) {
    const buttons = wishes.slice(0, 10).map((entry, index) => callback(options, 'select', entry, `${entry.zhName || entry.itemName}${rankSuffix(entry)}`, `wish-select-${index}`)).filter(Boolean);
    const rows = [];
    for (let index = 0; index < buttons.length; index += 2) rows.push({ buttons: buttons.slice(index, index + 2) });
    return { content: { rows } };
  }
  if (!wish) return null;
  const rows = [];
  rows.push({ buttons: [callback(options, 'query', wish, '查询当前价格', 'wish-query')] });
  if (result?.command === 'bought') rows.push({ buttons: [callback(options, 'undo_bought', wish, '撤销已购', 'wish-undo-bought')] });
  else if (result?.command === 'cancel') rows.push({ buttons: [callback(options, 'undo_cancel', wish, '撤销取消', 'wish-undo-cancel')] });
  else {
    rows.push({ buttons: [
      callback(options, 'bought', wish, '已购', 'wish-bought'),
      commandButton('wish-reprice', '改价', `改价 ${wish.id} `, true),
      callback(options, wish.status === 'paused' ? 'resume' : 'pause', wish, wish.status === 'paused' ? '继续' : '暂停', 'wish-toggle'),
    ].filter(Boolean) });
    // /w 已完整出现在命中文案中，不再重复提供“联系卖家”。命中卡与
    // 管理面板统一为五个操作，并保持 QQ 实机可稳定呈现的数量边界。
    rows.push({ buttons: [callback(options, 'cancel', wish, '取消愿望', 'wish-cancel')] });
  }
  return { content: { rows: rows.filter((row) => row.buttons.length) } };
}

export async function sendWishlistKeyboard(options) {
  const senderId = String(options.target || '').match(/^qqbot:c2c:([^:]+)$/iu)?.[1] || '';
  const keyboard = buildWishlistKeyboard(options.result, { accountId: options.accountId, senderId });
  if (!keyboard) return { sent: false, reason: 'not-applicable' };
  return sendQQKeyboardMessage({ ...options, keyboard });
}

export async function sendWishlistKeyboardWithFallback(options) {
  try {
    const primary = await sendWishlistKeyboard(options);
    if (primary.sent || !options.mediaUrl) {
      return { ...primary, mode: options.mediaUrl ? 'rich' : 'text-keyboard', degraded: false };
    }
  } catch (error) {
    if (!options.mediaUrl) throw error;
  }
  // 图片一体载荷不可用时仍只发一个“文本＋按钮”气泡。不要再退回普通
  // sendMedia，因为 QQ 会把图片和文字拆成两条并静默丢掉 keyboard。
  const fallback = await sendWishlistKeyboard({ ...options, mediaUrl: undefined });
  return { ...fallback, mode: 'text-keyboard', degraded: Boolean(fallback.sent) };
}

// 愿望卡投递的唯一分流点：`merged` 为真时走一体卡（Markdown 图片＋正文＋
// 键盘，同一条消息）；玩家用 `愿望卡 关` 关闭、偏好读取失败或没有图片时走
// 兼容拆分——先发「文本＋键盘」气泡（可操作的那一条），再补一张图片。
//
// 顺序与重试语义：拆分模式先投按钮，图片失败只降级不重发，因此任何一次
// 重试都不会重复已经成功的消息；一体模式失败时 `sendWishlistKeyboardWithFallback`
// 已经降级为单个「文本＋按钮」气泡，这里不再重复尝试。
// `sendMedia` 由调用方注入（需要 channel adapter），缺失时按无图片处理。
export async function sendWishlistCard(options) {
  const mediaUrl = String(options?.mediaUrl || '').trim();
  const mergedEnabled = options?.merged !== false;
  if (mediaUrl && mergedEnabled) {
    const merged = await sendWishlistKeyboardWithFallback({ ...options, mediaUrl });
    return {
      ...merged,
      mode: merged.sent ? (merged.degraded ? 'text-keyboard' : 'rich') : 'none',
      imageSent: Boolean(merged.sent) && !merged.degraded,
    };
  }
  const keyboard = await sendWishlistKeyboard({ ...options, mediaUrl: undefined });
  if (!keyboard.sent) return { ...keyboard, mode: 'none', imageSent: false };
  if (!mediaUrl || typeof options?.sendMedia !== 'function') {
    return { ...keyboard, mode: 'text-keyboard', imageSent: false };
  }
  try {
    await options.sendMedia(mediaUrl);
    return { ...keyboard, mode: 'split', imageSent: true };
  } catch {
    // 图片失败只降级：已投递的按钮气泡不回滚、不重发，通知本身已经可操作。
    return { ...keyboard, mode: 'split', degraded: true, imageSent: false };
  }
}
