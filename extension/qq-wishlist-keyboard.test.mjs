import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWishlistKeyboard, sendWishlistKeyboard, sendWishlistKeyboardWithFallback } from './qq-wishlist-keyboard.mjs';
import { createWishlistInteractionStore } from './qq-wishlist-interactions.mjs';

const wish = { id: 'W3K7', zhName: '物品 A', itemName: 'Item A', maxPrice: 20, rankMode: 'exact', rank: 0, status: 'active', updatedAt: '2026-09-17T10:00:00.000Z' };

test('hit keyboard keeps contact, exact-price query and management actions in one message', () => {
  const keyboard = buildWishlistKeyboard({ kind: 'wishlist', hits: [{ wish, order: { seller: 'seller', platinum: 18, unitPrice: 18, rank: 0 } }] }, { accountId: 'default', senderId: 'user-a' });
  const labels = keyboard.content.rows.flatMap((row) => row.buttons.map((button) => button.render_data.label));
  assert.deepEqual(labels, ['联系卖家', '查询当前价格', '已购', '改价', '暂停']);
  assert.equal(labels.length, 5, 'QQ 命中卡不得加入第六个按钮');
  assert.equal(keyboard.content.rows[0].buttons[0].action.enter, false);
});

test('hit card uses the same one-request Markdown image, text and keyboard contract as wm', async () => {
  const requests = [];
  const messageApi = {
    tokenManager: { getAccessToken: async () => 'token' },
    client: { request: async (...args) => { requests.push(args); return { id: 'wish-rich-1' }; } },
  };
  const result = await sendWishlistKeyboard({
    result: { kind: 'wishlist', hits: [{ wish, order: { seller: 'seller', platinum: 18, unitPrice: 18, rank: 0 } }] },
    target: 'qqbot:c2c:opaque-user',
    content: '愿望单命中：当前最低价卖单。',
    mediaUrl: new URL(import.meta.url),
    uploadImage: async () => ({ url: 'https://private.example/wishlist.png?signature=temporary' }),
    cfg: { channels: { qqbot: { appId: 'app', clientSecret: 'secret' } } },
    loadSender: async () => ({ version: 'test', getMessageApi: () => messageApi }),
  });
  assert.equal(result.sent, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0][3].msg_type, 2);
  assert.match(requests[0][3].markdown.content, /^!\[Warframe Wishlist\]\(https:\/\/private\.example\/wishlist\.png\?signature=temporary\)/u);
  assert.match(requests[0][3].markdown.content, /愿望单命中：当前最低价卖单。$/u);
  assert.equal(requests[0][3].keyboard.content.rows.flatMap((row) => row.buttons).length, 5);
});

test('rich failure degrades to one text-and-keyboard bubble without a split media send', async () => {
  const calls = [];
  const messageApi = {
    tokenManager: { getAccessToken: async () => 'token' },
    client: { request: async () => { calls.push('rich-rejected'); throw new Error('provider rejected'); } },
    sendMessage: async (_scope, _target, text, _creds, extra) => {
      calls.push({ text, keyboard: extra.inlineKeyboard });
      return { id: 'wish-text-1' };
    },
  };
  const result = await sendWishlistKeyboardWithFallback({
    result: { kind: 'wishlist', hits: [{ wish, order: { seller: 'seller', platinum: 18, unitPrice: 18, rank: 0 } }] },
    target: 'qqbot:c2c:opaque-user', content: '命中', mediaUrl: new URL(import.meta.url),
    uploadImage: async () => ({ url: 'https://private.example/wishlist.png' }),
    cfg: { channels: { qqbot: { appId: 'app', clientSecret: 'secret' } } },
    loadSender: async () => ({ version: 'test', getMessageApi: () => messageApi }),
  });
  assert.equal(result.sent, true);
  assert.equal(result.degraded, true);
  assert.equal(result.mode, 'text-keyboard');
  assert.deepEqual(calls.map((entry) => typeof entry === 'string' ? entry : entry.text), ['rich-rejected', '命中']);
  assert.equal(calls[1].keyboard.content.rows.flatMap((row) => row.buttons).length, 5);
});

test('management panel still exposes cancel while keeping five total actions', () => {
  const keyboard = buildWishlistKeyboard({ command: 'select', wish }, { accountId: 'default', senderId: 'user-a' });
  const labels = keyboard.content.rows.flatMap((row) => row.buttons.map((button) => button.render_data.label));
  assert.deepEqual(labels, ['查询当前价格', '已购', '改价', '暂停', '取消愿望']);
});

test('summary uses item labels while backend callback retains the stable wish id', () => {
  const keyboard = buildWishlistKeyboard({ command: 'summary', wishes: [wish] }, { accountId: 'default', senderId: 'user-a' });
  assert.equal(keyboard.content.rows[0].buttons[0].render_data.label, '物品 A 等级 0');
  assert.equal(keyboard.content.rows[0].buttons[0].render_data.label.includes('W3K7'), false);
});

test('wishlist callbacks are actor-bound, overlap-safe and undo expires after five minutes', () => {
  let now = 0;
  const store = createWishlistInteractionStore({ now: () => now, token: () => 'token' });
  const data = store.register({ accountId: 'default', senderId: 'a', action: 'undo_bought', wishId: 'W3K7', expectedUpdatedAt: wish.updatedAt });
  assert.equal(store.acquire(data, { accountId: 'default', senderId: 'b' }).reason, 'actor-mismatch');
  assert.equal(store.acquire(data, { accountId: 'default', senderId: 'a' }).ok, true);
  assert.equal(store.acquire(data, { accountId: 'default', senderId: 'a' }).reason, 'busy');
  store.release(data, { accountId: 'default', senderId: 'a' });
  now = 5 * 60_000;
  assert.equal(store.acquire(data, { accountId: 'default', senderId: 'a' }).reason, 'expired');
});
