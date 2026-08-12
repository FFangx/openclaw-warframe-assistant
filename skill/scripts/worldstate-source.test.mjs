import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeOfficialWorldState } from './worldstate-source.mjs';
import { attachStaticBountyRewards } from './bounties.mjs';

const date = (ms) => ({ $date: { $numberLong: String(ms) } });

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
});

test('official bounty jobs attach the matching WFCD level and rotation reward table', () => {
  const result = attachStaticBountyRewards([{ syndicate: 'Ostrons', jobs: [{ enemyLevels: [5, 15], uniqueName: '/Deck/TierATableBRewards', rewardPoolDrops: [] }] }], {
    Ostrons: [{ bountyLevel: 'Level 5 - 15 Cetus Bounty', rewards: { A: [{ itemName: 'Wrong' }], B: [{ itemName: 'Aya', rarity: 'Rare', chance: 8.33 }] } }],
  });
  assert.deepEqual(result[0].jobs[0].rewardPoolDrops, [{ item: 'Aya', rarity: 'Rare', chance: 8.33 }]);
});
