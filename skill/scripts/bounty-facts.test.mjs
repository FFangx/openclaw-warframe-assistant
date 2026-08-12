import test from 'node:test';
import assert from 'node:assert/strict';
import { runShortcut } from './shortcuts.mjs';

const deimosSyndicate = [{
  syndicate: 'Entrati',
  expiry: '2099-01-01T00:00:00.000Z',
  jobs: [{
    id: 'current-deimos-job', type: '异物取回', enemyLevels: [15, 25],
    rewardPoolDrops: [{ item: '触媒连动', chance: 5.68, rarity: 'Rare' }],
  }],
}];

test('地点赏金 facts 只声明当前奖池，不把历史 B 轮奖励写成当前在架', async () => {
  const result = await runShortcut('赏金 火卫二', {
    bountyFetchOptions: { syndicates: deimosSyndicate, cycle: {}, maps: { items: {}, jobs: {}, challenges: {}, challengeDetails: {}, nodes: {} } },
    skipRender: true,
  });
  assert.equal(result.handled, true);
  assert.equal(result.facts?.type, 'bounty-place');
  assert.deepEqual(result.facts.currentJobs[0].rewards, ['触媒连动']);
  assert.equal(JSON.stringify(result.facts).includes('尖刃弹头'), false);
});

test('奖励反查以 currentlyAvailable 明确表示当前轮没有目标奖励', async () => {
  const result = await runShortcut('赏金 尖刃弹头', {
    bountyFetchOptions: { syndicates: deimosSyndicate, cycle: {}, maps: { items: {}, jobs: {}, challenges: {}, challengeDetails: {}, nodes: {} } },
    skipRender: true,
  });
  assert.equal(result.facts?.type, 'bounty-reward-current-check');
  assert.equal(result.facts.currentlyAvailable, false);
  assert.deepEqual(result.facts.hits, []);
});
