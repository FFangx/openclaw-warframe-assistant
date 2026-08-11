import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { attachPrices, describeDrop, marketDisplayImagePath, withLock } from './drops.mjs';
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

test('掉落卡日均成交量明确标注为交易笔数', () => {
  const card = buildDropsAlertCard({
    drops: [{
      uniqueName: '/Test/Arcane', displayName: '次要·无情', gained: 1,
      tradable: true, isArcane: true, rarityZh: '稀有', platinum: 1,
      marketBasis: 'today', dailyVolume: 79.4,
    }],
    total: 1,
    syncedAt: new Date().toISOString(),
  });
  assert.match(card.html, /日均 79\.4 笔交易/u);
});

test('市场部件使用副图，主蓝图和套装继续使用成品主图', () => {
  assert.equal(marketDisplayImagePath({
    icon: 'items/images/en/nyx_prime_systems.png',
    thumb: 'items/images/en/thumbs/nyx_prime_systems.128x128.png',
    subIcon: 'sub_icons/warframe/prime_systems_128x128.png',
  }), 'sub_icons/warframe/prime_systems_128x128.png');
  assert.equal(marketDisplayImagePath({
    icon: 'items/images/en/gyre_prime_blueprint.webp',
    thumb: 'items/images/en/thumbs/gyre_prime_blueprint.128x128.webp',
    subIcon: 'sub_icons/blueprint_128x128.png',
  }), 'items/images/en/thumbs/gyre_prime_blueprint.128x128.webp');
  assert.equal(marketDisplayImagePath({
    icon: 'items/images/en/nyx_prime_set.png',
    thumb: 'items/images/en/thumbs/nyx_prime_set.128x128.png',
    subIcon: null,
  }), 'items/images/en/thumbs/nyx_prime_set.128x128.png');
});

test('掉落查价覆盖全部卡片行、限制并发并只用真实成交索引兜底', async () => {
  const drops = Array.from({ length: 9 }, (_, index) => ({
    uniqueName: `/Test/Item${index + 1}`,
    displayName: `物品 ${index + 1}`,
    englishName: `Item ${index + 1}`,
    tradable: true,
    isMod: index >= 3,
    isArcane: false,
  }));
  const slugs = new Map(drops.map((drop, index) => [drop.englishName.toLowerCase().replace(/\s+/gu, ''), {
    slug: `item_${index + 1}`,
    zhName: null,
  }]));
  let active = 0;
  let maxActive = 0;
  const queried = [];
  const quoteFetcher = async (slug) => {
    queried.push(slug);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    const number = Number(slug.split('_').at(-1));
    return number <= 6 ? { platinum: number, basis: '90days', dailyVolume: number } : null;
  };
  const priceIndex = {
    item7: { p0: 7.5, p0Basis: 'closed' },
    item8: { p0: 8.5, p0Basis: 'closed' },
    item9: { p0: 9.5, p0Basis: 'sell' },
  };

  await attachPrices(drops, { slugs, quoteFetcher, priceIndex });

  assert.equal(queried.length, 9);
  assert.ok(maxActive <= 3);
  assert.equal(drops[5].platinum, 6);
  assert.equal(drops[6].platinum, 7.5);
  assert.equal(drops[6].marketBasis, 'daily-closed');
  assert.equal(drops[7].platinum, 8.5);
  assert.equal(drops[8].platinum, null);
});
