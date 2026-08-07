import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyFissure, parseFissurePreference, recommendFissures } from './recommend.mjs';

const relics = [{ baseName: 'Lith T1', count: 7, refinement: 'Intact' }];
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
  zh: `奖励 ${index + 1}`,
}]));
const localDb = { rewardsByBase: new Map([['Lith T1', rewards]]) };

function fissure(id, missionType, extra = {}) {
  return {
    id,
    tier: 'Lith',
    missionType,
    node: `${id} (Earth)`,
    expiry: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    expired: false,
    ...extra,
  };
}

const worldState = {
  fissures: [
    fissure('capture', 'Capture'),
    fissure('exterminate', 'Extermination'),
    fissure('hard-exterminate', 'Extermination', { isHard: true }),
    fissure('defense', 'Defense'),
    fissure('survival', 'Survival'),
    fissure('interception', 'Interception'),
    fissure('excavation', 'Excavation'),
    fissure('storm', 'Skirmish', { isStorm: true }),
  ],
};

async function run(preference) {
  return recommendFissures(relics, { preference, worldState, localDb, prices });
}

test('parses the four recommendation preferences', () => {
  assert.equal(parseFissurePreference('裂缝推荐'), 'balanced');
  assert.equal(parseFissurePreference('杜卡德 速刷'), 'speed');
  assert.equal(parseFissurePreference('白金 舒适 单人'), 'comfort');
  assert.equal(parseFissurePreference('额外收益'), 'yield');
});

test('labels mission experience without inventing a numeric time factor', () => {
  assert.deepEqual(classifyFissure({ missionType: 'Capture' }).map((tag) => tag.key), ['speed']);
  assert.deepEqual(classifyFissure({ missionType: 'Defense' }).map((tag) => tag.key), ['comfort', 'endless']);
  assert.deepEqual(classifyFissure({ missionType: 'Interception' }).map((tag) => tag.key), ['endless']);
  assert.deepEqual(classifyFissure({ missionType: 'Skirmish', isStorm: true }).map((tag) => tag.key), ['bonus']);
});

test('uses the unified Chinese name for Volatile missions', async () => {
  const data = await recommendFissures(relics, {
    preference: 'balanced',
    worldState: { fissures: [fissure('volatile', 'Volatile', { isStorm: true })] },
    localDb,
    prices,
  });
  assert.equal(data.rows[0].missionZh, '反应堆破坏');
});

test('keeps Void Cascade and Void Flood official Chinese names distinct', async () => {
  const data = await recommendFissures(relics, {
    preference: 'balanced',
    worldState: {
      fissures: [
        fissure('cascade', 'Void Cascade'),
        fissure('flood', 'Void Flood'),
      ],
    },
    localDb,
    prices,
  });
  assert.equal(data.rows.find((row) => row.missionType === 'Void Cascade')?.missionZh, '虚空覆涌');
  assert.equal(data.rows.find((row) => row.missionType === 'Void Flood')?.missionZh, '虚空洪流');
});

test('balanced mode uses speed, comfort and Railjack-last tie-breaking at equal relic value', async () => {
  const data = await run('balanced');
  assert.equal(data.ok, true);
  assert.equal(data.preference, 'balanced');
  assert.equal(new Set(data.rows.map((row) => row.valueScore)).size, 1);
  assert.equal(new Set(data.rows.map((row) => row.preferenceRank)).size, 1);
  assert.equal(data.rows.slice(0, 3).every((row) => row.tags.some((tag) => tag.key === 'speed')), true);
  assert.equal(data.rows.slice(3, 5).every((row) => row.tags.some((tag) => tag.key === 'comfort')), true);
  assert.equal(data.rows.slice(5, 7).every((row) => row.tags.some((tag) => tag.key === 'endless')), true);
  assert.equal(data.rows.at(-1).storm, true);
});

test('speed and comfort modes use categorical priority then value fallback', async () => {
  const speed = await run('speed');
  assert.equal(speed.rows.slice(0, 3).every((row) => row.tags.some((tag) => tag.key === 'speed')), true);

  const comfort = await run('comfort');
  assert.deepEqual(new Set(comfort.rows.slice(0, 2).map((row) => row.missionType)), new Set(['Defense', 'Survival']));
});

test('yield mode prioritizes Void Storm, then Steel Path, then endless fissures', async () => {
  const data = await run('yield');
  assert.equal(data.rows[0].storm, true);
  assert.equal(data.rows[1].hard, true);
  assert.equal(data.rows.slice(2, 6).every((row) => row.tags.some((tag) => tag.key === 'endless')), true);
  const interception = data.rows.find((row) => row.missionType === 'Interception');
  assert.equal(interception.tags.some((tag) => tag.key === 'bonus'), false);
});
