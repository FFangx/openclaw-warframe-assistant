import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { withLock } from './drops.mjs';

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
