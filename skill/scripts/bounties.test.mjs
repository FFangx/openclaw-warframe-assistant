import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureBountyRewards } from './bounties.mjs';

test('官方备用源缺少奖励池时，赏金订阅会补入静态奖励表', async () => {
  const syndicates = [{
    syndicate: 'Ostrons',
    jobs: [{ enemyLevels: [5, 15], uniqueName: '/Lotus/Types/Game/MissionDecks/EidolonJobMissionRewardsTableARewards', rewardPoolDrops: [] }],
  }];
  const tables = {
    Ostrons: [{ bountyLevel: 'Level 5 - 15', rewards: { A: [{ itemName: 'Target Reward', rarity: 'Rare', chance: 5 }] } }],
  };
  const result = await ensureBountyRewards(syndicates, async () => tables);
  assert.deepEqual(result[0].jobs[0].rewardPoolDrops, [{ item: 'Target Reward', rarity: 'Rare', chance: 5 }]);
});

test('主源已有奖励池时不加载静态奖励表', async () => {
  const syndicates = [{ syndicate: 'Ostrons', jobs: [{ rewardPoolDrops: [{ item: 'Existing Reward', rarity: 'Rare', chance: 5 }] }] }];
  let called = false;
  const result = await ensureBountyRewards(syndicates, async () => { called = true; return {}; });
  assert.equal(called, false);
  assert.equal(result, syndicates);
});
