import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  getMarketCardPreference,
  marketCardPreferenceKey,
  parseMarketCardPreferenceCommand,
  setMarketCardPreference,
} from './qq-market-card-preferences.mjs';

test('parses only exact wm card preference commands', () => {
  assert.deepEqual(parseMarketCardPreferenceCommand('wm卡片 开'), { action: '开', enabled: true });
  assert.deepEqual(parseMarketCardPreferenceCommand('WM 卡片 关'), { action: '关', enabled: false });
  assert.deepEqual(parseMarketCardPreferenceCommand('wm卡片'), { action: '状态', enabled: null });
  assert.deepEqual(parseMarketCardPreferenceCommand('wm卡片 状态'), { action: '状态', enabled: null });
  assert.equal(parseMarketCardPreferenceCommand('wm 卡片 Nidus'), null);
});

test('stores only a hashed opt-in identity and defaults to disabled', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-card-pref-'));
  const filePath = path.join(dir, 'preferences.json');
  const identity = { accountId: 'Bot-A', senderId: 'Sensitive-QQ-OpenId', filePath };
  assert.equal(await getMarketCardPreference(identity), false);
  assert.equal(await setMarketCardPreference({ ...identity, enabled: true }), true);
  assert.equal(await getMarketCardPreference(identity), true);
  const raw = await readFile(filePath, 'utf8');
  assert.equal(raw.includes(identity.senderId), false);
  assert.equal(JSON.parse(raw).players[marketCardPreferenceKey(identity.accountId, identity.senderId)], true);
  assert.equal(await setMarketCardPreference({ ...identity, enabled: false }), false);
  assert.equal(await getMarketCardPreference(identity), false);
});
