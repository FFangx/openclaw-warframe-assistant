import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertOfficialRawWorldStateContract,
  assertOfficialWorldStateContract,
  loadWorldState,
  normalizeOfficialWorldState,
} from './worldstate-source.mjs';
import { attachStaticBountyRewards } from './bounties.mjs';

const date = (ms) => ({ $date: { $numberLong: String(ms) } });

const minimalOfficialRaw = (now = Date.now()) => ({
  Time: Math.floor(now / 1000),
  ActiveMissions: [], VoidStorms: [], Alerts: [], Invasions: [], Goals: [],
  VoidTraders: [], SyndicateMissions: [], Conquests: [],
  Sorties: [], LiteSorties: [], EndlessXpSchedule: [], KnownCalendarSeasons: [],
  SeasonInfo: null,
});

const directCache = async (_name, _options, loader) => ({ data: await loader(), stale: false, cachedAt: null });
const emptyMaps = async () => ({ nodes: {} });
const emptyLang = async () => ({});

test('official world state normalizes the public query sections', async () => {
  const now = Date.now();
  const expiry = now + 60 * 60 * 1000;
  const raw = {
    Time: Math.floor(now / 1000),
    ActiveMissions: [{ _id: { $oid: 'f1' }, Expiry: date(expiry), Node: 'SolNode1', MissionType: 'MT_CAPTURE', Modifier: 'VoidT1', Hard: true }],
    VoidStorms: [{ _id: { $oid: 's1' }, Expiry: date(expiry), Node: 'CrewNode1', ActiveMissionTier: 'VoidT6' }],
    Alerts: [{ _id: { $oid: 'a1' }, Expiry: date(expiry), MissionInfo: { location: 'SolNode1', missionType: 'MT_DEFENSE', faction: 'FC_GRINEER', missionReward: { credits: 1000 } } }],
    Invasions: [{ _id: { $oid: 'i1' }, Node: 'SolNode1', Count: 50, Goal: 100, Faction: 'FC_CORPUS', DefenderFaction: 'FC_GRINEER', AttackerReward: {}, DefenderReward: {} }],
    Goals: [{ _id: { $oid: 'e1' }, Expiry: date(expiry), Node: 'SolNode1', Tag: 'HeatFissure' }],
    Sorties: [{ _id: { $oid: 'so1' }, Expiry: date(expiry), Boss: 'SORTIE_BOSS_HYENA', Variants: [{ missionType: 'MT_EXTERMINATION', modifierType: 'SORTIE_MODIFIER_EXIMUS', node: 'SolNode1' }] }],
    LiteSorties: [{ _id: { $oid: 'lite1' }, Expiry: date(expiry), Boss: 'SORTIE_BOSS_BOREAL', Missions: [{ missionType: 'MT_EXTERMINATION', node: 'SolNode1' }] }],
    VoidTraders: [{ _id: { $oid: 'v1' }, Activation: date(now - 1000), Expiry: date(expiry), Node: 'PlutoHUB' }],
    Conquests: [{ Activation: date(now - 1000), Expiry: date(expiry), Type: 'CT_LAB', Variables: ['EnergyStarved'], Missions: [{ faction: 'FC_MITW', missionType: 'MT_DEFENSE', difficulties: [{ type: 'CD_NORMAL', deviation: 'LostInTranslation', risks: 'Voidburst' }] }] }],
    EndlessXpSchedule: [{ Activation: date(now - 1000), Expiry: date(expiry), CategoryChoices: [{ Category: 'EXC_NORMAL', Choices: ['Mesa'] }, { Category: 'EXC_HARD', Choices: ['Dread'] }] }],
    KnownCalendarSeasons: [{ Activation: date(now - 1000), Expiry: date(expiry), Season: 'CST_SUMMER', YearIteration: 21, Days: [{ day: 186, events: [{ type: 'CET_CHALLENGE', challenge: '/Lotus/Types/Challenges/Calendar1999/CalendarTest' }] }] }],
    SeasonInfo: { AffiliationTag: 'RadioTestSyndicate', ActiveChallenges: [{ Challenge: '/Lotus/Types/Challenges/Seasons/WeeklyHard/EliteTest' }] },
    SyndicateMissions: [],
  };
  const state = await normalizeOfficialWorldState(raw, { nodes: { SolNode1: { name: 'Test', planet: 'Earth' }, CrewNode1: { name: 'Railjack', planet: 'Veil' } }, now });
  assert.equal(state.timestamp, new Date(Math.floor(now / 1000) * 1000).toISOString());
  assert.deepEqual(state.fissures.map((item) => [item.tier, item.missionType, item.isHard, item.isStorm]), [
    ['Lith', 'Capture', true, false], ['Omnia', 'Skirmish', false, true],
  ]);
  assert.equal(state.alerts[0].mission.type, 'Defense');
  assert.equal(state.invasions[0].completion, 50);
  assert.equal(state.events[0].description, 'Thermia Fractures');
  assert.equal(state.sortie.variants[0].modifier, 'Eximus Stronghold');
  assert.equal(state.voidTrader.active, true);
  assert.equal(state.archimedeas[0].typeKey, 'CT_LAB');
  assert.equal(state.archimedeas[0].missions[0].missionType, 'Defense');
  assert.equal(state.archonHunt.missions[0].type, 'Extermination');
  assert.deepEqual(state.duviriCycle.choices.map((item) => item.category), ['normal', 'hard']);
  assert.equal(state.calendar.season, 'Summer');
  assert.equal(state.calendar.days[0].events[0].challenge.key, 'calendartest');
  assert.equal(state.nightwave.tag, 'RadioTestSyndicate');
  assert.equal(state.nightwave.activeChallenges[0].isElite, true);
  assert.match(state.nightwave.activeChallenges[0].id, /elitetest$/u);
  assert.equal(assertOfficialWorldStateContract(state), state);
  assert.deepEqual(
    ['fissures', 'alerts', 'invasions', 'events', 'voidTraders', 'syndicateMissions', 'archimedeas'].filter((field) => !Array.isArray(state[field])),
    [],
  );
});

test('official conquest risks are split per difficulty without comma-joined keys', async () => {
  const now = Date.now();
  const expiry = now + 60 * 60 * 1000;
  const raw = {
    Time: Math.floor(now / 1000),
    ActiveMissions: [], VoidStorms: [], Alerts: [], Invasions: [], Goals: [],
    Sorties: [], LiteSorties: [], VoidTraders: [], SyndicateMissions: [],
    EndlessXpSchedule: [], KnownCalendarSeasons: [],
    SeasonInfo: null,
    Conquests: [{
      Activation: date(now - 1000), Expiry: date(expiry), Type: 'CT_LAB', Variables: ['Starvation', 'DullBlades'],
      Missions: [{
        faction: 'FC_MITW', missionType: 'MT_ALCHEMY',
        difficulties: [
          { type: 'CD_NORMAL', deviation: 'AlchemicalShields', risks: ['RegeneratingEnemies'] },
          { type: 'CD_HARD', deviation: 'AlchemicalShields', risks: ['RegeneratingEnemies', 'AntiMaterialWeapons'] },
        ],
      }],
    }],
  };
  const state = await normalizeOfficialWorldState(raw, { nodes: {}, now });
  const mission = state.archimedeas[0].missions[0];
  assert.deepEqual(mission.risks.map((risk) => risk.key), ['RegeneratingEnemies', 'AntiMaterialWeapons']);
  assert.deepEqual(mission.risks.map((risk) => risk.isHard), [false, true]);
  assert.deepEqual(state.archimedeas[0].personalModifiers.map((mod) => mod.key), ['Starvation', 'DullBlades']);
});

test('official world state completeness contract rejects missing seasonal sections', () => {
  assert.throws(() => assertOfficialWorldStateContract({
    timestamp: new Date().toISOString(), fissures: [], alerts: [], invasions: [], events: [],
    voidTraders: [], syndicateMissions: [], archimedeas: [], sortie: null, archonHunt: null,
    nightwave: null, duviriCycle: null,
  }), /calendar missing/u);
});

test('official raw contract rejects HTTP-success payloads with missing critical collections', () => {
  assert.throws(() => assertOfficialRawWorldStateContract({ Time: Math.floor(Date.now() / 1000) }), /ActiveMissions must be an array/u);
});

test('PC returns validated official data without waiting for a slow WarframeStat cross-check', async () => {
  let crossCheckStarted = false;
  const fetchJson = async (url) => {
    if (url.includes('worldState.php')) return minimalOfficialRaw();
    crossCheckStarted = true;
    return new Promise(() => {});
  };
  const result = await Promise.race([
    loadWorldState('pc', { fetchJson, staleCachedJson: directCache, getBountyZhMaps: emptyMaps, getLangTable: emptyLang }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('official path waited for WarframeStat')), 100)),
  ]);
  assert.equal(result._dataSource, 'api.warframe.com');
  assert.equal(result._officialFallback, false);
  assert.equal(result._communityCrossCheck, 'scheduled');
  assert.equal(crossCheckStarted, true);
});

test('PC rejects malformed official data and falls back to WarframeStat', async () => {
  const fallback = { timestamp: new Date().toISOString(), fissures: [{ id: 'community-f1' }] };
  const fetchJson = async (url) => (url.includes('worldState.php') ? { Time: Math.floor(Date.now() / 1000) } : fallback);
  const result = await loadWorldState('pc', {
    fetchJson, staleCachedJson: directCache, getBountyZhMaps: emptyMaps, getLangTable: emptyLang,
  });
  assert.deepEqual(result.fissures, fallback.fissures);
  assert.equal(result._dataSource, 'api.warframestat.us');
  assert.equal(result._officialFallback, true);
  assert.match(result._officialError, /ActiveMissions must be an array/u);
  assert.match(result._sourceLabel, /已自动切换/u);
});

test('PC does not promote a stale official inner cache to a fresh result', async () => {
  const fallback = { timestamp: new Date().toISOString(), fissures: [{ id: 'community-fresh' }] };
  const cache = async (name, _options, loader) => {
    if (name === 'official-worldstate') return { data: minimalOfficialRaw(Date.now() - 120_000), stale: true, cachedAt: new Date(Date.now() - 120_000).toISOString() };
    return { data: await loader(), stale: false, cachedAt: null };
  };
  const result = await loadWorldState('pc', {
    fetchJson: async () => fallback,
    staleCachedJson: cache,
    getBountyZhMaps: emptyMaps,
    getLangTable: emptyLang,
  });
  assert.deepEqual(result.fissures, fallback.fissures);
  assert.equal(result._dataSource, 'api.warframestat.us');
  assert.match(result._officialError, /source is stale/u);
});

test('PC all-source failure returns the reliable normalized cache with stale metadata', async () => {
  const reliable = { timestamp: new Date(Date.now() - 60_000).toISOString(), fissures: [{ id: 'cached-f1' }], _dataSource: 'api.warframe.com' };
  const cache = async (name, _options, loader) => {
    if (name === 'official-worldstate') return { data: await loader(), stale: false, cachedAt: null };
    try {
      return { data: await loader(), stale: false, cachedAt: null };
    } catch {
      return { data: reliable, stale: true, cachedAt: reliable.timestamp };
    }
  };
  const result = await loadWorldState('pc', {
    fetchJson: async () => { throw new Error('simulated outage'); },
    staleCachedJson: cache,
    getBountyZhMaps: emptyMaps,
    getLangTable: emptyLang,
  });
  assert.deepEqual(result.fissures, reliable.fissures);
  assert.equal(result._dataStale, true);
  assert.equal(result._cachedAt, reliable.timestamp);
});

test('official bounty jobs attach the matching WFCD level and rotation reward table', () => {
  const result = attachStaticBountyRewards([{ syndicate: 'Ostrons', jobs: [{ enemyLevels: [5, 15], uniqueName: '/Deck/TierATableBRewards', rewardPoolDrops: [] }] }], {
    Ostrons: [{ bountyLevel: 'Level 5 - 15 Cetus Bounty', rewards: { A: [{ itemName: 'Wrong' }], B: [{ itemName: 'Aya', rarity: 'Rare', chance: 8.33 }] } }],
  });
  assert.deepEqual(result[0].jobs[0].rewardPoolDrops, [{ item: 'Aya', rarity: 'Rare', chance: 8.33 }]);
});
