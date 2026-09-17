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
  if (hit?.order) {
    const order = hit.order || {};
    const item = wish.itemName || wish.slug || wish.zhName || '';
    const rank = order.rank == null ? '' : ` (rank ${order.rank})`;
    const total = Number.isFinite(Number(order.platinum)) ? Number(order.platinum) : Number(order.unitPrice || 0);
    const whisper = String(hit.contactTemplate || result.contactTemplate || `/w ${order.seller || ''} Hi! I want to buy: "${item}${rank}" for ${total} platinum. (warframe.market)`).trim();
    rows.push({ buttons: [
      whisper ? commandButton('wish-contact', '联系卖家', whisper, false) : null,
      callback(options, 'query', wish, '查询当前价格', 'wish-query'),
    ].filter(Boolean) });
  } else {
    rows.push({ buttons: [callback(options, 'query', wish, '查询当前价格', 'wish-query')] });
  }
  if (result?.command === 'bought') rows.push({ buttons: [callback(options, 'undo_bought', wish, '撤销已购', 'wish-undo-bought')] });
  else if (result?.command === 'cancel') rows.push({ buttons: [callback(options, 'undo_cancel', wish, '撤销取消', 'wish-undo-cancel')] });
  else {
    rows.push({ buttons: [
      callback(options, 'bought', wish, '已购', 'wish-bought'),
      commandButton('wish-reprice', '改价', `改价 ${wish.id} `, true),
      callback(options, wish.status === 'paused' ? 'resume' : 'pause', wish, wish.status === 'paused' ? '继续' : '暂停', 'wish-toggle'),
    ].filter(Boolean) });
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
