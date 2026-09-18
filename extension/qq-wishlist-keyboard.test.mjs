import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWishlistKeyboard, sendWishlistCard, sendWishlistKeyboard, sendWishlistKeyboardWithFallback } from './qq-wishlist-keyboard.mjs';
import { createWishlistInteractionStore } from './qq-wishlist-interactions.mjs';

const wish = { id: 'W3K7', zhName: '物品 A', itemName: 'Item A', maxPrice: 20, rankMode: 'exact', rank: 0, status: 'active', updatedAt: '2026-09-17T10:00:00.000Z' };
const hitResult = () => ({ kind: 'wishlist', hits: [{ wish, order: { seller: 'seller', platinum: 18, unitPrice: 18, rank: 0 } }] });

function fakeSender(overrides = {}) {
  const calls = [];
  const messageApi = {
    tokenManager: { getAccessToken: async () => 'token' },
    client: { request: async (...args) => { calls.push({ kind: 'markdown', args }); return { id: 'rich-1' }; } },
    sendMessage: async (_scope, _target, text, _creds, extra) => { calls.push({ kind: 'text', text, keyboard: extra?.inlineKeyboard }); return { id: 'text-1' }; },
    ...overrides,
  };
  return {
    calls,
    loadSender: async () => ({ version: 'test', getMessageApi: () => messageApi }),
  };
}

function cardOptions(sender, overrides = {}) {
  return {
    result: hitResult(),
    target: 'qqbot:c2c:opaque-user',
    content: '愿望单命中：当前最低价卖单。',
    mediaUrl: new URL(import.meta.url),
    uploadImage: async () => ({ url: 'https://private.example/wishlist.png?signature=temporary' }),
    cfg: { channels: { qqbot: { appId: 'app', clientSecret: 'secret' } } },
    loadSender: sender.loadSender,
    ...overrides,
  };
}

test('hit keyboard avoids the redundant contact action and keeps five management actions', () => {
  const keyboard = buildWishlistKeyboard({ kind: 'wishlist', hits: [{ wish, order: { seller: 'seller', platinum: 18, unitPrice: 18, rank: 0 } }] }, { accountId: 'default', senderId: 'user-a' });
  const labels = keyboard.content.rows.flatMap((row) => row.buttons.map((button) => button.render_data.label));
  assert.deepEqual(labels, ['查询当前价格', '已购', '改价', '暂停', '取消愿望']);
  assert.equal(labels.length, 5, 'QQ 命中卡必须保持五个按钮');
  assert.equal(labels.includes('联系卖家'), false, '/w 文案已经提供联系信息');
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

test('default delivery merges image, text and keyboard into one message', async () => {
  const sender = fakeSender();
  const media = [];
  const result = await sendWishlistCard(cardOptions(sender, { sendMedia: async (url) => { media.push(url); } }));
  assert.equal(result.sent, true);
  assert.equal(result.mode, 'rich');
  assert.equal(result.imageSent, true);
  assert.equal(sender.calls.length, 1);
  assert.equal(sender.calls[0].kind, 'markdown');
  assert.equal(sender.calls[0].args[3].msg_type, 2);
  assert.match(sender.calls[0].args[3].markdown.content, /!\[Warframe Wishlist\]\(https:\/\/private\.example/u);
  assert.equal(sender.calls[0].args[3].keyboard.content.rows.flatMap((row) => row.buttons).length, 5);
  assert.deepEqual(media, [], '合并可用时不再单独补图');
});

test('turning the switch off sends the actionable bubble first and the image second', async () => {
  const sender = fakeSender();
  const media = [];
  const result = await sendWishlistCard(cardOptions(sender, {
    merged: false,
    sendMedia: async (url) => { media.push(url); },
  }));
  assert.equal(result.sent, true);
  assert.equal(result.mode, 'split');
  assert.equal(result.imageSent, true);
  // 按钮气泡先发：图片失败也不会重复已经成功的那一条
  assert.equal(sender.calls.length, 1);
  assert.equal(sender.calls[0].kind, 'text');
  assert.equal(sender.calls[0].keyboard.content.rows.flatMap((row) => row.buttons).length, 5);
  assert.equal(media.length, 1);
});

test('split delivery keeps the delivered bubble when the image fails', async () => {
  const sender = fakeSender();
  const result = await sendWishlistCard(cardOptions(sender, {
    merged: false,
    sendMedia: async () => { throw new Error('media upload failed'); },
  }));
  assert.equal(result.sent, true);
  assert.equal(result.mode, 'split');
  assert.equal(result.degraded, true);
  assert.equal(result.imageSent, false);
  assert.equal(sender.calls.length, 1, '图片失败不回滚也不重发按钮气泡');
});

test('no image and no keyboard renderer still deliver one actionable bubble', async () => {
  const sender = fakeSender();
  const media = [];
  const result = await sendWishlistCard(cardOptions(sender, { mediaUrl: null, sendMedia: async (url) => { media.push(url); } }));
  assert.equal(result.sent, true);
  assert.equal(result.mode, 'text-keyboard');
  assert.equal(result.imageSent, false);
  assert.equal(sender.calls.length, 1);
  assert.deepEqual(media, []);
});
