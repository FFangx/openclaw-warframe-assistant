import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describeDrop, withLock } from './drops.mjs';
import { buildDropsAlertCard } from './warframe-cards.mjs';

test('掉落监测会自动回收被超时进程遗留的陈旧锁', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'warframe-drops-lock-'));
  const statePath = path.join(dir, 'drops.json');
  const lockPath = `${statePath}.lock`;
  await writeFile(lockPath, '', 'utf8');
  const old = new Date(Date.now() - 5 * 60 * 1000);
  await utimes(lockPath, old, old);

  const value = await withLock(statePath, async () => 'recovered');
  assert.equal(value, 'recovered');
  await assert.rejects(stat(lockPath), (error) => error?.code === 'ENOENT');
});

test('遗物掉落提醒显示入库状态', () => {
  const uniqueName = '/Lotus/Types/Game/Projections/LithT1Bronze';
  const drop = describeDrop(uniqueName, 1, new Map([[uniqueName, {
    englishName: 'Lith T1 Intact', displayName: '古纪 T1 遗物（完整）', category: 'Relics',
    rarity: null, tradable: true, isPrime: false, ducats: null, imageName: null, vaulted: true,
  }]]));
  assert.equal(drop.isRelic, true);
  assert.equal(drop.vaulted, true);
  assert.match(buildDropsAlertCard({ drops: [drop], total: 1, syncedAt: new Date().toISOString() }).html, /已入库/u);
});
