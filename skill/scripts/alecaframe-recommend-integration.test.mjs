import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runAlecaMessage } from './alecaframe.mjs';

const RELIC_UNIQUE_NAME = '/Lotus/Types/Game/Projections/LithT1Bronze';
const rewards = [
  { name: 'Common A', slug: 'common_a', chance: 25.33 },
  { name: 'Common B', slug: 'common_b', chance: 25.33 },
  { name: 'Common C', slug: 'common_c', chance: 25.33 },
  { name: 'Uncommon A', slug: 'uncommon_a', chance: 11 },
  { name: 'Uncommon B', slug: 'uncommon_b', chance: 11 },
  { name: 'Rare', slug: 'rare', chance: 2 },
];
const prices = Object.fromEntries(rewards.map((reward, index) => [reward.slug, {
  p: [3, 4, 5, 8, 9, 30][index],
  d: [15, 15, 15, 45, 45, 100][index],
  zh: `合成奖励 ${index + 1}`,
}]));
const localDb = { rewardsByBase: new Map([['Lith T1', rewards]]) };

function fissure(id, extra = {}) {
  return {
    id,
    tier: 'Lith',
    missionType: 'Capture',
    node: `${id} (Earth)`,
    expiry: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    expired: false,
    ...extra,
  };
}

test('runs synthetic snapshot through recommendation, card and follow-up branches', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'warframe-recommend-e2e-'));
  const alecaDir = path.join(root, 'aleca');
  const catalogDir = path.join(alecaDir, 'cachedData', 'json');
  const previousOffline = process.env.WARFRAME_OFFLINE;
  process.env.WARFRAME_OFFLINE = '1';
  try {
    await mkdir(catalogDir, { recursive: true });
    await writeFile(path.join(alecaDir, 'lastData.dat'), JSON.stringify({
      LastInventorySync: { $oid: '64a000000000000000000001' },
      MiscItems: [{ ItemType: RELIC_UNIQUE_NAME, ItemCount: 7 }],
    }), 'utf8');
    await writeFile(path.join(catalogDir, 'Relics.json'), JSON.stringify([{
      uniqueName: RELIC_UNIQUE_NAME,
      name: 'Lith T1 Intact',
      vaulted: false,
    }]), 'utf8');
    await writeFile(path.join(catalogDir, 'lang.json'), '{}', 'utf8');

    const cases = [
      ['开遗物 单人', '全部裂缝', '单人口径'],
      ['开遗物 单人 九重天', '仅九重天', '单人口径'],
      ['开遗物 钢铁', '仅钢铁', '4人组队口径'],
      ['开遗物 未入库 收益', '全部裂缝', '未入库'],
    ];
    for (const [message, scopeText, detailText] of cases) {
      let rendered = false;
      const result = await runAlecaMessage(message, {
        alecaDir,
        cardDir: path.join(root, 'cards'),
        renderCard: async (card) => {
          assert.equal(typeof card.html, 'string');
          assert.match(card.html, /开遗物/u);
          rendered = true;
          return path.join(root, 'cards', 'synthetic.png');
        },
        recommendOptions: {
          worldState: {
            fissures: [
              fissure('normal'),
              fissure('steel', { isHard: true }),
              fissure('storm', { isStorm: true }),
            ],
          },
          localDb,
          prices,
          minRemainMs: 0,
        },
      });
      assert.equal(result.handled, true, message);
      assert.equal(result.ok, true, message);
      assert.equal(rendered, true, message);
      assert.equal(result.mediaUrl, path.join(root, 'cards', 'synthetic.png'), message);
      assert.match(result.followupText, new RegExp(scopeText, 'u'), message);
      assert.match(result.followupText, new RegExp(detailText, 'u'), message);
      assert.doesNotMatch(result.followupText, /undefined/u, message);
    }
  } finally {
    if (previousOffline === undefined) delete process.env.WARFRAME_OFFLINE;
    else process.env.WARFRAME_OFFLINE = previousOffline;
    await rm(root, { recursive: true, force: true });
  }
});
