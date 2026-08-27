import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertOfficialRawWorldStateContract,
  assertOfficialWorldStateContract,
  assertOracleFissureContract,
  assertOracleRawWorldStateContract,
  loadWorldState,
  normalizeOfficialWorldState,
  normalizeOracleWorldState,
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

// 实况 oracle.browse.wf/worldState.min.json 的真实部分载荷：只有裁剪的 11 个键
// （Events/Goals/Alerts/Sorties/LiteSorties/ActiveMissions/VoidTraders/VoidStorms/
// DailyDeals/Conquests/Tmp），没有 Invasions、SyndicateMissions、SeasonInfo、
// EndlessXpSchedule、KnownCalendarSeasons 等官方顶层字段——不是全量镜像。
// 实测该端点 HTTP 响应**没有顶层 Time**（只有 Date/Last-Modified/ETag/Cache-Control 头），
// 所以不带 Time 才是真实形状：上游内容时间由 HTTP Last-Modified 承担。
const minimalOracleRaw = () => ({
  Events: [], Goals: [], Alerts: [], Sorties: [], LiteSorties: [],
  ActiveMissions: [], VoidTraders: [], VoidStorms: [], DailyDeals: [], Conquests: [], Tmp: null,
});

// Oracle 抓取走 withResponseMeta：测试替身必须返回实况路径的 { data, responseMeta } 形状。
// lastModified 缺省给「2 分钟前」的新鲜值；传 null=缺 Last-Modified 响应头。
const oracleResponse = (raw = minimalOracleRaw(), { lastModified, now = Date.now() } = {}) => ({
  data: raw,
  responseMeta: {
    lastModified: lastModified === undefined ? new Date(now - 2 * 60_000).toUTCString() : lastModified,
    etag: '"oracle-etag"',
    cacheControl: 'public,max-age=10',
  },
});

const oracleRawWithFissure = (id, { now = Date.now() } = {}) => ({
  ...minimalOracleRaw(),
  ActiveMissions: [{ _id: { $oid: id }, Expiry: date(now + 60 * 60 * 1000), Node: 'SolNode1', MissionType: 'MT_CAPTURE', Modifier: 'VoidT2', Hard: false }],
});

const communityFallback = () => ({
  timestamp: new Date().toISOString(),
  alerts: [{ id: 'community-alert' }],
  invasions: [{ id: 'community-invasion' }],
});

const directCache = async (_name, _options, loader) => ({ data: await loader(), stale: false, cachedAt: null });
// 测试默认没有可靠规范化缓存：事件 ID 连续性仅在注入快照时校验。
const noCache = async () => null;
const emptyMaps = async () => ({ nodes: {} });
const emptyLang = async () => ({});

// 记录写盘的可信缓存替身：命名缓存的新鲜写入全部记账，官方失败时对可靠缓存返回 stale 基底。
function trackingCache({ reliable = null } = {}) {
  const writes = [];
  const cache = async (name, _options, loader) => {
    try {
      const data = await loader();
      writes.push(name);
      return { data, stale: false, cachedAt: null };
    } catch (error) {
      if (name === 'worldstate-normalized-pc' && reliable) {
        return { data: reliable, stale: true, cachedAt: reliable.timestamp };
      }
      throw error;
    }
  };
  cache.writes = writes;
  return cache;
}

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

test('Oracle contract accepts the real no-Time partial payload and rejects malformed fissure collections', () => {
  // 实况部分载荷（无 Time、无 Invasions/SyndicateMissions 等）必须能通过 Oracle 专属合同，
  // 但绝不能通过官方全量合同——这就是旧实现「Oracle 恒失败」的原因。
  const partial = minimalOracleRaw();
  assert.equal(partial.Time, undefined);
  assert.deepEqual(Object.keys(partial).sort(), ['ActiveMissions', 'Alerts', 'Conquests', 'DailyDeals', 'Events', 'Goals', 'LiteSorties', 'Sorties', 'Tmp', 'VoidStorms', 'VoidTraders']);
  assert.equal(assertOracleRawWorldStateContract(partial), partial);
  assert.throws(() => assertOfficialRawWorldStateContract(partial), /Invasions must be an array/u);
  assert.throws(() => assertOracleRawWorldStateContract({ ActiveMissions: [] }), /VoidStorms must be an array/u);
  assert.throws(() => assertOracleRawWorldStateContract({ ActiveMissions: null, VoidStorms: [] }), /ActiveMissions must be an array/u);
});

test('Oracle normalization emits fissures only with timestamp from the validated Last-Modified', async () => {
  const now = Date.now();
  const lastModifiedMs = now - 3 * 60_000;
  const raw = {
    ...minimalOracleRaw(),
    ActiveMissions: [{ _id: { $oid: 'o-f1' }, Expiry: date(now + 60 * 60 * 1000), Node: 'SolNode1', MissionType: 'MT_CAPTURE', Modifier: 'VoidT2', Hard: true }],
    VoidStorms: [{ _id: { $oid: 'o-s1' }, Expiry: date(now + 60 * 60 * 1000), Node: 'CrewNode1', ActiveMissionTier: 'VoidT6' }],
  };
  const state = await normalizeOracleWorldState(raw, { nodes: { SolNode1: { name: 'Test', planet: 'Earth' }, CrewNode1: { name: 'Railjack', planet: 'Veil' } }, now, upstreamTime: lastModifiedMs });
  assert.deepEqual(Object.keys(state).sort(), ['fissures', 'timestamp']);
  // timestamp 必须是已验证的 HTTP Last-Modified（上游内容修改时间），不是本机抓取时间。
  assert.equal(state.timestamp, new Date(lastModifiedMs).toISOString());
  assert.notEqual(state.timestamp, new Date(now).toISOString());
  assert.deepEqual(state.fissures.map((item) => [item.id, item.tier, item.missionType, item.isHard, item.isStorm]), [
    ['o-f1', 'Meso', 'Capture', true, false], ['o-s1', 'Omnia', 'Skirmish', false, true],
  ]);
  assert.equal(assertOracleFissureContract(state), state);
  // 字段级来源：没有伪造任何官方全字段，也绝不通过官方完整性合同。
  assert.equal(state.invasions, undefined);
  assert.equal(state.syndicateMissions, undefined);
  assert.equal(state.nightwave, undefined);
  assert.throws(() => assertOfficialWorldStateContract(state), /alerts must be an array/u);
});

test('PC official success does not await Oracle or WarframeStat and keeps the warframestat health probe', async () => {
  let crossCheckStarted = false;
  let oracleRequested = false;
  const fetchJson = async (url) => {
    if (url.includes('worldState.php')) return minimalOfficialRaw();
    if (url.includes('oracle.browse.wf')) {
      oracleRequested = true;
      return new Promise(() => {});
    }
    crossCheckStarted = true;
    return new Promise(() => {});
  };
  const result = await Promise.race([
    loadWorldState('pc', { fetchJson, staleCachedJson: directCache, readCachedData: noCache, getBountyZhMaps: emptyMaps, getLangTable: emptyLang }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('official path waited for a community source')), 100)),
  ]);
  assert.equal(result._dataSource, 'api.warframe.com');
  assert.equal(result._officialFallback, false);
  assert.equal(result._communityCrossCheck, 'scheduled');
  assert.equal(crossCheckStarted, true);
  assert.equal(oracleRequested, false);
  // 质量信封：provider/fetchedAt/上游时间/延迟/完整性/内容哈希，以及按字段的 provider。
  assert.equal(result._envelope.provider, 'api.warframe.com');
  assert.ok(Number.isFinite(Date.parse(result._envelope.fetchedAt)));
  assert.ok(Number.isFinite(Date.parse(result._envelope.upstreamTime)));
  assert.ok(Number.isFinite(result._envelope.latencyMs));
  assert.equal(result._envelope.completeness.missing.length, 0);
  assert.match(result._envelope.contentHash, /^[0-9a-f]{64}$/u);
  assert.equal(result._fieldProviders.fissures, 'api.warframe.com');
});

test('PC official failure overlays valid Oracle fissures onto the WarframeStat full state without caching the composite', async () => {
  const oracleOptions = [];
  let warframeStatRequested = false;
  const lastModified = new Date(Date.now() - 2 * 60_000).toUTCString();
  const cache = trackingCache();
  const fetchJson = async (url, resilience) => {
    if (url.includes('worldState.php')) throw new Error('official unreachable');
    if (url.includes('oracle.browse.wf/worldState.min.json')) {
      oracleOptions.push(resilience);
      return oracleResponse(oracleRawWithFissure('oracle-f1'), { lastModified });
    }
    warframeStatRequested = true;
    return communityFallback();
  };
  const result = await loadWorldState('pc', {
    fetchJson, staleCachedJson: cache, readCachedData: noCache, getBountyZhMaps: emptyMaps, getLangTable: emptyLang,
  });
  // 基底是 warframestat 全量（社区口径），只有 fissures 来自 Oracle 部分镜像。
  assert.equal(result._dataSource, 'api.warframestat.us');
  assert.equal(result._officialFallback, true);
  assert.match(result._sourceLabel, /browse\.wf Oracle/u);
  assert.match(result._sourceLabel, /已自动切换/u);
  assert.match(result._officialError, /official unreachable/u);
  assert.deepEqual(result.fissures.map((item) => item.id), ['oracle-f1']);
  assert.equal(result.fissures[0].tier, 'Meso');
  assert.equal(result.fissures[0].missionType, 'Capture');
  assert.equal(result.fissures[0].isHard, false);
  assert.equal(result.alerts[0].id, 'community-alert');
  // 按字段 provider：fissures=Oracle，其余=warframestat；绝不假装整包来自单一全量源。
  assert.equal(result._fieldProviders.fissures, 'oracle.browse.wf');
  assert.equal(result._fieldProviders.alerts, 'api.warframestat.us');
  assert.equal(result._fieldProviders.invasions, 'api.warframestat.us');
  // 两份来源信封：warframestat 为基底信封；Oracle 信封明示部分镜像与自身字段范围。
  assert.equal(result._envelope.provider, 'api.warframestat.us');
  assert.equal(result._oracleEnvelope.provider, 'oracle.browse.wf');
  assert.deepEqual(result._oracleEnvelope.completeness.required, ['ActiveMissions', 'VoidStorms']);
  assert.equal(result._oracleEnvelope.completeness.missing.length, 0);
  assert.equal(result._oracleEnvelope.partial, true);
  // 实况端点无顶层 Time：scope 不再声明 Time；上游时间单独取自 HTTP Last-Modified。
  assert.deepEqual(result._oracleEnvelope.scope, ['ActiveMissions', 'VoidStorms']);
  assert.equal(result._oracleEnvelope.upstreamTime, new Date(Date.parse(lastModified)).toISOString());
  assert.ok(Number.isFinite(Date.parse(result._oracleEnvelope.fetchedAt)));
  assert.deepEqual(result._composite, { base: 'api.warframestat.us', overlay: 'oracle.browse.wf', overlayFields: ['fissures'], cached: false });
  assert.equal(result._dataStale, false);
  // 叠加结果不得伪装成官方完整状态（不通过官方完整性合同）。
  assert.throws(() => assertOfficialWorldStateContract(result), /events must be an array/u);
  assert.equal(warframeStatRequested, true);
  // Oracle 拥有独立端点健康键、短超时与熔断配置，并开启响应元数据模式（Last-Modified）。
  assert.equal(oracleOptions.length, 1);
  assert.equal(oracleOptions[0].endpoint, 'worldstate:oracle:pc');
  assert.equal(oracleOptions[0].withResponseMeta, true);
  assert.ok(oracleOptions[0].timeoutMs <= 8_000);
  assert.ok(oracleOptions[0].failureThreshold >= 2);
  // 叠加对象不写入可靠缓存（可靠缓存只保留官方全量结果）。
  assert.equal(cache.writes.includes('worldstate-normalized-pc'), false);
  assert.ok(cache.writes.includes('oracle-worldstate'));
});

test('PC official failure with malformed Oracle falls back to WarframeStat with diagnostics', async () => {
  const fallback = { timestamp: new Date().toISOString(), fissures: [{ id: 'community-f1' }] };
  const fetchJson = async (url) => {
    if (url.includes('worldState.php')) return { Time: Math.floor(Date.now() / 1000) };
    if (url.includes('oracle.browse.wf')) return oracleResponse({ ActiveMissions: null, VoidStorms: [] });
    return fallback;
  };
  const result = await loadWorldState('pc', {
    fetchJson, staleCachedJson: directCache, readCachedData: noCache, getBountyZhMaps: emptyMaps, getLangTable: emptyLang,
  });
  assert.deepEqual(result.fissures, fallback.fissures);
  assert.equal(result._dataSource, 'api.warframestat.us');
  assert.equal(result._officialFallback, true);
  assert.match(result._officialError, /ActiveMissions must be an array/u);
  assert.match(result._oracleError, /ActiveMissions must be an array/u);
  assert.equal(result._oracleEnvelope, undefined);
  assert.equal(result._composite, undefined);
  assert.equal(result._fieldProviders.fissures, 'api.warframestat.us');
  assert.match(result._sourceLabel, /已自动切换/u);
  assert.match(result._sourceLabel, /Oracle 裂缝层/u);
  assert.doesNotMatch(result._sourceLabel, /裂缝由 browse\.wf Oracle 补齐/u);
});

test('PC official failure with old Oracle upstream Last-Modified falls back to WarframeStat', async () => {
  const fallback = { timestamp: new Date().toISOString(), fissures: [{ id: 'community-fresh' }] };
  const fetchJson = async (url) => {
    if (url.includes('worldState.php')) throw new Error('official unreachable');
    if (url.includes('oracle.browse.wf')) return oracleResponse(minimalOracleRaw(), { lastModified: new Date(Date.now() - 20 * 60_000).toUTCString() });
    return fallback;
  };
  const result = await loadWorldState('pc', {
    fetchJson, staleCachedJson: directCache, readCachedData: noCache, getBountyZhMaps: emptyMaps, getLangTable: emptyLang,
  });
  assert.deepEqual(result.fissures, fallback.fissures);
  assert.equal(result._dataSource, 'api.warframestat.us');
  assert.match(result._oracleError, /too old/u);
  assert.equal(result._fieldProviders.fissures, 'api.warframestat.us');
});

test('PC official failure with missing or invalid Oracle Last-Modified falls back to WarframeStat honestly', async () => {
  const fallback = { timestamp: new Date().toISOString(), fissures: [{ id: 'community-fresh' }] };
  for (const [label, lastModified] of [['missing', null], ['invalid', 'not-a-date']]) {
    const fetchJson = async (url) => {
      if (url.includes('worldState.php')) throw new Error('official unreachable');
      if (url.includes('oracle.browse.wf')) return oracleResponse(minimalOracleRaw(), { lastModified });
      return fallback;
    };
    const result = await loadWorldState('pc', {
      fetchJson, staleCachedJson: directCache, readCachedData: noCache, getBountyZhMaps: emptyMaps, getLangTable: emptyLang,
    });
    // 缺失/无效的 Last-Modified 不得用响应 Date 或本机 fetchedAt 冒充上游内容时间：诚实拒绝叠加。
    assert.deepEqual(result.fissures, fallback.fissures, label);
    assert.equal(result._dataSource, 'api.warframestat.us', label);
    assert.match(result._oracleError, /Last-Modified missing or invalid/u, label);
    assert.equal(result._oracleEnvelope, undefined, label);
    assert.equal(result._fieldProviders.fissures, 'api.warframestat.us', label);
  }
});

test('Oracle invalid response is rejected before the v3 cache can store it', async () => {
  let oracleStored = false;
  const cache = async (name, _options, loader) => {
    if (name === 'oracle-worldstate') {
      const data = await loader();
      oracleStored = true;
      return { data, stale: false, cachedAt: null };
    }
    return { data: await loader(), stale: false, cachedAt: null };
  };
  const result = await loadWorldState('pc', {
    fetchJson: async (url) => {
      if (url.includes('worldState.php')) throw new Error('official unreachable');
      if (url.includes('oracle.browse.wf')) return oracleResponse(minimalOracleRaw(), { lastModified: null });
      return { timestamp: new Date().toISOString(), fissures: [{ id: 'community-fresh' }] };
    },
    staleCachedJson: cache,
    readCachedData: noCache,
    getBountyZhMaps: emptyMaps,
    getLangTable: emptyLang,
  });
  assert.equal(oracleStored, false);
  assert.deepEqual(result.fissures, [{ id: 'community-fresh' }]);
  assert.match(result._oracleError, /Last-Modified missing or invalid/u);
});

test('PC official failure with divergent Oracle fissure IDs falls back to WarframeStat', async () => {
  const fallback = { timestamp: new Date().toISOString(), fissures: [{ id: 'community-fresh' }] };
  const fetchJson = async (url) => {
    if (url.includes('worldState.php')) throw new Error('official unreachable');
    if (url.includes('oracle.browse.wf')) return oracleResponse(oracleRawWithFissure('mirror-f1'));
    return fallback;
  };
  const result = await loadWorldState('pc', {
    fetchJson,
    staleCachedJson: directCache,
    readCachedData: async () => ({ data: { fissures: [{ id: 'cached-f1' }] }, cachedAt: Date.now() }),
    getBountyZhMaps: emptyMaps,
    getLangTable: emptyLang,
  });
  assert.deepEqual(result.fissures, fallback.fissures);
  assert.equal(result._dataSource, 'api.warframestat.us');
  assert.match(result._oracleError, /diverges/u);
});

test('PC Oracle overlay passes continuity when sharing an event ID with the recent reliable snapshot', async () => {
  const fetchJson = async (url) => {
    if (url.includes('worldState.php')) throw new Error('official unreachable');
    if (url.includes('oracle.browse.wf')) return oracleResponse(oracleRawWithFissure('oracle-f1'));
    return communityFallback();
  };
  const result = await loadWorldState('pc', {
    fetchJson,
    staleCachedJson: directCache,
    readCachedData: async () => ({ data: { fissures: [{ id: 'oracle-f1' }] }, cachedAt: Date.now() }),
    getBountyZhMaps: emptyMaps,
    getLangTable: emptyLang,
  });
  assert.deepEqual(result.fissures.map((item) => item.id), ['oracle-f1']);
  assert.equal(result._dataSource, 'api.warframestat.us');
  assert.equal(result._oracleError, undefined);
  assert.equal(result._fieldProviders.fissures, 'oracle.browse.wf');
});

test('Oracle cached metadata keeps the original Last-Modified for the age gate regardless of read time', async () => {
  const fallback = { timestamp: new Date().toISOString(), fissures: [{ id: 'community-fresh' }] };
  const now = Date.now();
  const bundle = (deltaMs) => ({
    raw: minimalOracleRaw(),
    meta: {
      lastModified: new Date(now - deltaMs).toUTCString(),
      etag: '"cached-etag"',
      cacheControl: 'public,max-age=10',
    },
  });
  // 情形 A：缓存读取时间非常新（10 秒前），但缓存里的 Last-Modified 已 16 分钟：
  // 年龄必须按原始 Last-Modified 计算（不是缓存读取/写入时间），因此拒绝叠加。
  const recentReadCache = async (name, _options, loader) => {
    if (name === 'oracle-worldstate') return { data: bundle(16 * 60_000), stale: false, cachedAt: now - 10_000 };
    return { data: await loader(), stale: false, cachedAt: null };
  };
  const rejected = await loadWorldState('pc', {
    fetchJson: async (url) => {
      if (url.includes('worldState.php')) throw new Error('official unreachable');
      return fallback;
    },
    staleCachedJson: recentReadCache, readCachedData: noCache, getBountyZhMaps: emptyMaps, getLangTable: emptyLang,
  });
  assert.deepEqual(rejected.fissures, fallback.fissures);
  assert.match(rejected._oracleError, /too old/u);
  assert.equal(rejected._oracleEnvelope, undefined);
  // 情形 B：缓存读取时间很旧（10 分钟前），但 Last-Modified 只 14 分钟：
  // 年龄只取决于上游内容修改时间，缓存时长不额外计龄，因此允许叠加（内容为空裂缝集）。
  const oldReadCache = async (name, _options, loader) => {
    if (name === 'oracle-worldstate') return { data: bundle(14 * 60_000), stale: false, cachedAt: now - 10 * 60_000 };
    return { data: await loader(), stale: false, cachedAt: null };
  };
  const accepted = await loadWorldState('pc', {
    fetchJson: async (url) => {
      if (url.includes('worldState.php')) throw new Error('official unreachable');
      return fallback;
    },
    staleCachedJson: oldReadCache, readCachedData: noCache, getBountyZhMaps: emptyMaps, getLangTable: emptyLang,
  });
  assert.deepEqual(accepted.fissures, []);
  assert.equal(accepted._oracleError, undefined);
  assert.equal(accepted._fieldProviders.fissures, 'oracle.browse.wf');
  // 信封上游时间 = 缓存里保留的原始 Last-Modified（未被刷新成读取时间）。
  const storedLastModifiedMs = Date.parse(bundle(14 * 60_000).meta.lastModified);
  assert.equal(accepted._oracleEnvelope.upstreamTime, new Date(storedLastModifiedMs).toISOString());
  assert.equal(accepted._oracleEnvelope.fetchedAt, now - 10 * 60_000);
});

test('Oracle inner cache version 3 stores the raw-plus-metadata bundle (v2 raw-only entries not reused)', async () => {
  const fallback = { timestamp: new Date().toISOString(), fissures: [{ id: 'community-fresh' }] };
  let oracleVersion = null;
  let oracleFetched = 0;
  let storedBundle = null;
  const cache = async (name, options, loader) => {
    if (name === 'oracle-worldstate') {
      oracleVersion = options.version;
      oracleFetched++;
      storedBundle = await loader();
      return { data: storedBundle, stale: false, cachedAt: null };
    }
    return { data: await loader(), stale: false, cachedAt: null };
  };
  const result = await loadWorldState('pc', {
    fetchJson: async (url) => {
      if (url.includes('worldState.php')) throw new Error('official unreachable');
      if (url.includes('oracle.browse.wf')) return oracleResponse(oracleRawWithFissure('oracle-f1'));
      return fallback;
    },
    staleCachedJson: cache, readCachedData: noCache, getBountyZhMaps: emptyMaps, getLangTable: emptyLang,
  });
  // 版本 3：部署中的 v2 纯载荷缓存（没有 meta 字段）不会被当作带元数据的包读取。
  assert.equal(oracleVersion, 3);
  assert.equal(oracleFetched, 1);
  assert.deepEqual(Object.keys(storedBundle).sort(), ['meta', 'raw']);
  assert.equal(typeof storedBundle.meta.lastModified, 'string');
  assert.equal(storedBundle.meta.etag, '"oracle-etag"');
  assert.equal(storedBundle.meta.cacheControl, 'public,max-age=10');
  assert.deepEqual(result.fissures.map((item) => item.id), ['oracle-f1']);
  assert.equal(result._oracleError, undefined);
});

test('PC stale Oracle inner cache falls through to WarframeStat without overwriting the reliable cache', async () => {
  const freshFallback = { timestamp: new Date().toISOString(), fissures: [{ id: 'community-fresh' }] };
  const cache = trackingCache({ reliable: null });
  const innerCache = async (name, _options, loader) => {
    if (name === 'oracle-worldstate') {
      return {
        data: { raw: minimalOracleRaw(), meta: { lastModified: new Date(Date.now() - 120_000).toUTCString(), etag: null, cacheControl: null } },
        stale: true,
        cachedAt: new Date(Date.now() - 120_000).toISOString(),
      };
    }
    if (name === 'official-worldstate') return { data: await loader(), stale: false, cachedAt: null };
    return cache(name, _options, loader);
  };
  const result = await loadWorldState('pc', {
    fetchJson: async (url) => {
      if (url.includes('worldState.php')) throw new Error('official unreachable');
      return freshFallback;
    },
    staleCachedJson: innerCache,
    readCachedData: noCache,
    getBountyZhMaps: emptyMaps,
    getLangTable: emptyLang,
  });
  assert.deepEqual(result.fissures, freshFallback.fissures);
  assert.equal(result._dataSource, 'api.warframestat.us');
  assert.equal(result._officialFallback, true);
  assert.match(result._officialError, /official unreachable/u);
  assert.match(result._oracleError, /oracle world state source is stale/u);
  assert.match(result._sourceLabel, /已自动切换/u);
  assert.equal(cache.writes.includes('worldstate-normalized-pc'), false);
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
    readCachedData: noCache,
    getBountyZhMaps: emptyMaps,
    getLangTable: emptyLang,
  });
  assert.deepEqual(result.fissures, fallback.fissures);
  assert.equal(result._dataSource, 'api.warframestat.us');
  assert.equal(result._officialFallback, true);
  assert.match(result._officialError, /source is stale/u);
});

test('PC all-source failure returns the reliable normalized cache with truthful stale metadata, never Oracle alone', async () => {
  const reliable = { timestamp: new Date(Date.now() - 60_000).toISOString(), fissures: [{ id: 'cached-f1' }], _dataSource: 'api.warframe.com' };
  const cache = trackingCache({ reliable });
  const result = await loadWorldState('pc', {
    fetchJson: async () => { throw new Error('simulated outage'); },
    staleCachedJson: cache,
    readCachedData: noCache,
    getBountyZhMaps: emptyMaps,
    getLangTable: emptyLang,
  });
  assert.deepEqual(result.fissures, reliable.fissures);
  assert.equal(result._dataStale, true);
  assert.equal(result._cachedAt, reliable.timestamp);
  assert.equal(result._onlineSourcesFailed, true);
  assert.equal(cache.writes.includes('worldstate-normalized-pc'), false);
});

test('PC all-source failure with only Oracle fissures online still falls back to stale cache', async () => {
  const reliable = { timestamp: new Date(Date.now() - 60_000).toISOString(), fissures: [{ id: 'cached-f1' }], _dataSource: 'api.warframe.com' };
  const cache = trackingCache({ reliable });
  const fetchJson = async (url) => {
    if (url.includes('worldState.php')) throw new Error('official unreachable');
    if (url.includes('oracle.browse.wf')) return oracleResponse(oracleRawWithFissure('oracle-only-f1'));
    throw new Error('warframestat unreachable');
  };
  const result = await loadWorldState('pc', {
    fetchJson,
    staleCachedJson: cache,
    readCachedData: noCache,
    getBountyZhMaps: emptyMaps,
    getLangTable: emptyLang,
  });
  // Oracle 只是部分镜像：绝不能单独作为完整状态返回——维持可靠缓存并保持 stale 真实。
  assert.deepEqual(result.fissures, reliable.fissures);
  assert.equal(result._dataStale, true);
  assert.equal(result._cachedAt, reliable.timestamp);
  assert.equal(result.fissures.some((item) => item.id === 'oracle-only-f1'), false);
  assert.match(result._communityError, /warframestat unreachable/u);
  assert.match(result._communityError, /insufficient alone/u);
});

test('PC all-source failure without a reliable cache throws the combined error', async () => {
  const fetchJson = async (url) => {
    if (url.includes('worldState.php')) throw new Error('official unreachable');
    if (url.includes('oracle.browse.wf')) throw new Error('oracle unreachable');
    throw new Error('warframestat unreachable');
  };
  await assert.rejects(
    loadWorldState('pc', {
      fetchJson, staleCachedJson: directCache, readCachedData: noCache, getBountyZhMaps: emptyMaps, getLangTable: emptyLang,
    }),
    /world state sources unavailable: official=official unreachable; oracle=oracle unreachable; warframestat=warframestat unreachable/u,
  );
});

test('official bounty jobs attach the matching WFCD level and rotation reward table', () => {
  const result = attachStaticBountyRewards([{ syndicate: 'Ostrons', jobs: [{ enemyLevels: [5, 15], uniqueName: '/Deck/TierATableBRewards', rewardPoolDrops: [] }] }], {
    Ostrons: [{ bountyLevel: 'Level 5 - 15 Cetus Bounty', rewards: { A: [{ itemName: 'Wrong' }], B: [{ itemName: 'Aya', rarity: 'Rare', chance: 8.33 }] } }],
  });
  assert.deepEqual(result[0].jobs[0].rewardPoolDrops, [{ item: 'Aya', rarity: 'Rare', chance: 8.33 }]);
});
