import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWishlistKeyboard } from './qq-wishlist-keyboard.mjs';
import { createWishlistInteractionStore } from './qq-wishlist-interactions.mjs';

const wish = { id: 'W3K7', zhName: '物品 A', itemName: 'Item A', maxPrice: 20, rankMode: 'exact', rank: 0, status: 'active', updatedAt: '2026-09-17T10:00:00.000Z' };

test('hit keyboard keeps contact, exact-price query and management actions in one message', () => {
  const keyboard = buildWishlistKeyboard({ kind: 'wishlist', hits: [{ wish, order: { seller: 'seller', platinum: 18, unitPrice: 18, rank: 0 } }] }, { accountId: 'default', senderId: 'user-a' });
  const labels = keyboard.content.rows.flatMap((row) => row.buttons.map((button) => button.render_data.label));
  assert.deepEqual(labels, ['联系卖家', '查询当前价格', '已购', '改价', '暂停', '取消愿望']);
  assert.equal(keyboard.content.rows[0].buttons[0].action.enter, false);
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
