import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_WISHLIST_CARD_MERGED,
  getWishlistCardMerged,
  parseWishlistCardPreferenceCommand,
  setWishlistCardMerged,
  wishlistCardPreferenceKey,
  wishlistCardPreferencePath,
} from './qq-wishlist-card-preferences.mjs';

test('parses only exact wishlist card preference commands', () => {
  assert.deepEqual(parseWishlistCardPreferenceCommand('愿望卡 开'), { action: '开', merged: true });
  assert.deepEqual(parseWishlistCardPreferenceCommand('愿望卡 关'), { action: '关', merged: false });
  assert.deepEqual(parseWishlistCardPreferenceCommand('愿望卡'), { action: '状态', merged: null });
  assert.deepEqual(parseWishlistCardPreferenceCommand('愿望卡片 状态'), { action: '状态', merged: null });
  assert.deepEqual(parseWishlistCardPreferenceCommand('愿望通知卡 关'), { action: '关', merged: false });
  assert.equal(parseWishlistCardPreferenceCommand('愿望卡 悟空p'), null);
  assert.equal(parseWishlistCardPreferenceCommand('愿望 悟空p 80'), null);
});

test('defaults to merged and stores only a hashed per-player switch', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-wish-card-pref-'));
  try {
    const filePath = path.join(dir, 'preferences.json');
    const identity = { accountId: 'Bot-A', senderId: 'Sensitive-QQ-OpenId', filePath };
    // 默认（键缺失、文件不存在、旧版本文件）一律一体卡
    assert.equal(DEFAULT_WISHLIST_CARD_MERGED, true);
    assert.equal(await getWishlistCardMerged(identity), true);
    assert.equal(await getWishlistCardMerged({ accountId: 'Bot-A', senderId: '', filePath }), true, '没有可信发送者时按默认值处理');

    assert.equal(await setWishlistCardMerged({ ...identity, merged: false }), false);
    assert.equal(await getWishlistCardMerged(identity), false);
    const raw = await readFile(filePath, 'utf8');
    assert.equal(raw.includes(identity.senderId), false, '文件不得出现原始 QQ 标识');
    assert.equal(JSON.parse(raw).players[wishlistCardPreferenceKey(identity.accountId, identity.senderId)], false);

    assert.equal(await setWishlistCardMerged({ ...identity, merged: true }), true);
    assert.equal(await getWishlistCardMerged(identity), true);

    // 损坏文件必须显式失败，调用方据此走兼容拆分而不是猜成「已开启」
    await writeFile(filePath, '{ not json', 'utf8');
    await assert.rejects(() => getWishlistCardMerged(identity));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('preference file lives next to the wishlist ledger', () => {
  const statePath = path.join(os.tmpdir(), 'wf-state', 'warframe-wishlist.json');
  assert.equal(wishlistCardPreferencePath(statePath), path.join(os.tmpdir(), 'wf-state', 'warframe-wishlist-card-preferences.json'));
});
