// Resilient PC world-state loader.
// PC order: official DE worldState.php -> browse.wf Oracle full mirror -> WarframeStat fallback -> last cached normalized snapshot.
// Other platforms keep the WarframeStat normalized API path.
// The official/Oracle sources are mapped to the subset consumed by public queries and subscriptions.

import { createHash } from 'node:crypto';

import { getBountyZhMaps, getLangTable, readCachedData, staleCachedJson } from './wfdata.mjs';
import { resilientJsonRequest } from './http-resilience.mjs';

const PRIMARY_BASE = 'https://api.warframestat.us';
const OFFICIAL_URL = 'https://api.warframe.com/cdn/worldState.php';
// Browse.wf 实时客户端的公开 Oracle 全量镜像：与官方 worldState.php 同样的 raw 结构。
const ORACLE_URL = 'https://oracle.browse.wf/worldState.min.json';
const TIMEOUT_MS = 20_000;
// Oracle 使用短超时/熔断的独立端点健康键，作为官方故障后的快速接管层。
const ORACLE_TIMEOUT_MS = 6_000;
const CACHE_TTL_MS = 45_000;
// Oracle 是官方镜像候选：上游 Time 超过该年龄说明镜像内容滞后，禁止接管；
// 直接命中 DE 官方源不受此门禁（官方即权威，只用原始/规范化双层完整性合同判定）。
const ORACLE_MAX_UPSTREAM_AGE_MS = 15 * 60_000;
// 裂缝事件 ID 连续性只在最近可靠快照足够新（生命周期内）时才执行零交集强制拒绝，
// 避免跨波次正常轮换触发误判。
const CONTINUITY_WINDOW_MS = 10 * 60_000;

const TIER = { VoidT1: 'Lith', VoidT2: 'Meso', VoidT3: 'Neo', VoidT4: 'Axi', VoidT5: 'Requiem', VoidT6: 'Omnia' };
const MISSION = {
  MT_EXTERMINATION: 'Extermination', MT_CAPTURE: 'Capture', MT_SABOTAGE: 'Sabotage', MT_RESCUE: 'Rescue',
  MT_INTEL: 'Spy', MT_DEFENSE: 'Defense', MT_MOBILE_DEFENSE: 'Mobile Defense', MT_TERRITORY: 'Interception',
  MT_SURVIVAL: 'Survival', MT_EXCAVATE: 'Excavation', MT_DISRUPTION: 'Disruption', MT_PURIFY: 'Disruption',
  MT_ALCHEMY: 'Alchemy', MT_ASSAULT: 'Assault', MT_HIVE: 'Hive', MT_HIJACK: 'Hijack',
  MT_ASSASSINATION: 'Assassination', MT_EVACUATION: 'Defection', MT_ARTIFACT: 'Mobile Defense',
  MT_VOID_CASCADE: 'Void Cascade', MT_VOID_FLOOD: 'Void Flood', MT_ARMAGEDDON: 'Void Armageddon',
  MT_ENDLESS_CAPTURE: 'Legacyte Harvest',
};
const FACTION = {
  FC_GRINEER: 'Grineer', FC_CORPUS: 'Corpus', FC_INFESTATION: 'Infested', FC_OROKIN: 'Orokin',
  FC_CORRUPTED: 'Corrupted', FC_SENTIENT: 'Sentient', FC_MITW: 'The Murmur', FC_TENNO: 'Tenno',
};
const BOSS = {
  SORTIE_BOSS_HYENA: 'Hyena Pack', SORTIE_BOSS_VOR: 'Captain Vor', SORTIE_BOSS_RUK: 'General Sargas Ruk',
  SORTIE_BOSS_HEK: 'Councilor Vay Hek', SORTIE_BOSS_KRIL: 'Lech Kril', SORTIE_BOSS_REGOR: 'Tyl Regor',
  SORTIE_BOSS_JACKAL: 'Jackal', SORTIE_BOSS_RAPTOR: 'Raptor', SORTIE_BOSS_LEPHANTIS: 'Lephantis',
  SORTIE_BOSS_ALAD: 'Mutalist Alad V', SORTIE_BOSS_CORRUPTED_VOR: 'Corrupted Vor',
  SORTIE_BOSS_BOREAL: 'Archon Boreal', SORTIE_BOSS_AMAR: 'Archon Amar', SORTIE_BOSS_NIRA: 'Archon Nira',
};
const MODIFIER = {
  SORTIE_MODIFIER_EXIMUS: 'Eximus Stronghold', SORTIE_MODIFIER_HAZARD_RADIATION: 'Environmental Hazard: Radiation Pockets',
  SORTIE_MODIFIER_IMPACT: 'Enemy Physical Enhancement: Impact', SORTIE_MODIFIER_SLASH: 'Enemy Physical Enhancement: Slash',
  SORTIE_MODIFIER_PUNCTURE: 'Enemy Physical Enhancement: Puncture', SORTIE_MODIFIER_LOW_ENERGY: 'Energy Reduction',
  SORTIE_MODIFIER_MAGNETIC: 'Enemy Elemental Enhancement: Magnetic', SORTIE_MODIFIER_CORROSIVE: 'Enemy Elemental Enhancement: Corrosive',
  SORTIE_MODIFIER_VIRAL: 'Enemy Elemental Enhancement: Viral', SORTIE_MODIFIER_ELECTRICITY: 'Enemy Elemental Enhancement: Electricity',
  SORTIE_MODIFIER_RADIATION: 'Enemy Elemental Enhancement: Radiation', SORTIE_MODIFIER_GAS: 'Enemy Elemental Enhancement: Gas',
  SORTIE_MODIFIER_FIRE: 'Enemy Elemental Enhancement: Heat', SORTIE_MODIFIER_BLAST: 'Enemy Elemental Enhancement: Blast',
  SORTIE_MODIFIER_FREEZE: 'Enemy Elemental Enhancement: Cold', SORTIE_MODIFIER_POISON: 'Enemy Elemental Enhancement: Toxin',
};
const EVENT_NAME = { HeatFissure: 'Thermia Fractures', GhoulEmergence: 'Ghoul Purge', PlagueStar: 'Plague Star', WaterFight: 'Dog Days' };
const EVENT_DETAIL = { HeatFissure: 'Seal fractures across the Orb Vallis', GhoulEmergence: 'Help Konzu rid the plains of Grineer Ghouls' };
const HUB = {
  MercuryHUB: 'Larunda Relay (Mercury)', EarthHUB: 'Strata Relay (Earth)', SaturnHUB: 'Kronia Relay (Saturn)',
  PlutoHUB: 'Orcus Relay (Pluto)', VenusHUB: 'Vesper Relay (Venus)', ErisHUB: 'Kuiper Relay (Eris)',
};
const CALENDAR_SEASON = { CST_SPRING: 'Spring', CST_SUMMER: 'Summer', CST_AUTUMN: 'Autumn', CST_WINTER: 'Winter' };

async function fetchJson(url, resilience = null) {
  if (resilience) {
    return resilientJsonRequest(url, {
      endpoint: resilience.endpoint,
      timeoutMs: resilience.timeoutMs ?? 6_000,
      maxAttempts: resilience.maxAttempts ?? 1,
      failureThreshold: resilience.failureThreshold ?? 2,
      forbiddenOpenMs: resilience.forbiddenOpenMs ?? 15 * 60_000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
  }
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.json();
}

const msOf = (value) => {
  const raw = value?.$date?.$numberLong ?? value?.$date ?? value;
  const number = Number(raw);
  if (Number.isFinite(number)) return number > 0 && number < 100_000_000_000 ? number * 1000 : number;
  return Date.parse(String(raw || ''));
};
const isoOf = (value) => {
  const ms = msOf(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const idOf = (value, fallback = '') => value?._id?.$oid || value?.$oid || fallback;
const missionOf = (value) => MISSION[value] || String(value || 'Unknown').replace(/^MT_/u, '').toLowerCase().replace(/(^|_)\w/gu, (part) => part.replace('_', ' ').toUpperCase());
const factionOf = (value) => FACTION[value] || String(value || 'Unknown').replace(/^FC_/u, '');

function nodeOf(code, nodes) {
  const entry = nodes?.[code];
  return entry?.name ? `${entry.name}${entry.planet ? ` (${entry.planet})` : ''}` : String(code || 'Unknown');
}

function itemName(path, lang) {
  return lang?.[path]?.zh?.name || String(path || '').split('/').pop() || 'Unknown';
}

function rewardOf(raw, lang) {
  return {
    items: (raw?.items || []).map((path) => itemName(path, lang)),
    countedItems: (raw?.countedItems || []).map((entry) => ({ count: Number(entry?.ItemCount) || 1, type: itemName(entry?.ItemType, lang) })),
    credits: Number(raw?.credits) || 0,
  };
}

function normalizeFissure(entry, nodes, isStorm, now) {
  const expiry = isoOf(entry?.Expiry);
  return {
    id: idOf(entry, `${entry?.Node}:${expiry}`), activation: isoOf(entry?.Activation), expiry,
    node: nodeOf(entry?.Node, nodes), missionType: isStorm ? 'Skirmish' : missionOf(entry?.MissionType),
    enemy: factionOf(entry?.Faction || nodes?.[entry?.Node]?.faction), tier: TIER[isStorm ? entry?.ActiveMissionTier : entry?.Modifier] || 'Unknown',
    isStorm, isHard: !isStorm && Boolean(entry?.Hard), expired: !expiry || Date.parse(expiry) <= now,
  };
}

function normalizeSortie(entry, nodes, now, lite = false) {
  if (!entry) return null;
  const expiry = isoOf(entry.Expiry);
  const variants = entry.Variants || entry.Missions || [];
  return {
    id: idOf(entry), activation: isoOf(entry.Activation), expiry, expired: !expiry || Date.parse(expiry) <= now,
    boss: BOSS[entry.Boss] || entry.Boss || 'Unknown', faction: factionOf(nodes?.[variants.at(-1)?.node]?.faction),
    variants: variants.map((variant) => ({
      missionType: missionOf(variant.missionType), modifier: MODIFIER[variant.modifierType] || variant.modifierType || '',
      node: nodeOf(variant.node, nodes),
    })),
    ...(lite ? {
      rewardPool: 'Archon Hunt',
      missions: variants.map((variant) => ({ type: missionOf(variant.missionType), typeKey: missionOf(variant.missionType), node: nodeOf(variant.node, nodes), nodeKey: variant.node })),
    } : {}),
  };
}

const tailOf = (value) => String(value || '').split('/').pop() || '';

function normalizeConquests(entries) {
  return (entries || []).map((entry) => ({
    id: `conquest:${entry.Type}:${isoOf(entry.Activation)}`,
    activation: isoOf(entry.Activation), expiry: isoOf(entry.Expiry),
    type: entry.Type, typeKey: entry.Type,
    missions: (entry.Missions || []).map((mission) => {
      // 官方 risks 是数组（如 ["RegeneratingEnemies","AntiMaterialWeapons"]）。旧实现把数组
      // String() 后用空白切分，逗号合并键变成单条「RegeneratingEnemies,AntiMaterialWeapons」，
      // 词缀译名链查无 → 整行落占位。这里逐项展开：普通难度风险在前，精英独有的风险 isHard。
      const toKeys = (difficulty) => (Array.isArray(difficulty?.risks)
        ? difficulty.risks
        : String(difficulty?.risks || '').split(/[\s,]+/u)).filter(Boolean);
      const normalDifficulty = (mission.difficulties || []).find((item) => item.type !== 'CD_HARD');
      const hardDifficulty = (mission.difficulties || []).find((item) => item.type === 'CD_HARD');
      const normalKeys = new Set(toKeys(normalDifficulty));
      const riskKeys = [...new Set([...toKeys(normalDifficulty), ...toKeys(hardDifficulty)])];
      return {
        faction: factionOf(mission.faction), factionKey: mission.faction,
        missionType: missionOf(mission.missionType), missionTypeKey: missionOf(mission.missionType),
        deviation: mission.difficulties?.[0]?.deviation
          ? { key: mission.difficulties[0].deviation, name: mission.difficulties[0].deviation, description: '' }
          : null,
        risks: riskKeys.map((key) => ({ key, name: key, description: '', isHard: !normalKeys.has(key) })),
      };
    }),
    personalModifiers: (entry.Variables || []).map((key) => ({ key, name: key, description: '' })),
  }));
}

function normalizeCalendar(entry) {
  if (!entry) return null;
  const eventOf = (event) => {
    if (event.type === 'CET_CHALLENGE') return { type: 'To Do', challenge: { key: tailOf(event.challenge).toLowerCase(), title: tailOf(event.challenge), description: '' } };
    if (event.type === 'CET_REWARD') return { type: 'Big Prize!', reward: tailOf(event.reward) };
    if (event.type === 'CET_UPGRADE') return { type: 'Override', upgrade: { title: tailOf(event.upgrade) } };
    return null;
  };
  return {
    activation: isoOf(entry.Activation), expiry: isoOf(entry.Expiry),
    season: CALENDAR_SEASON[entry.Season] || String(entry.Season || '').replace(/^CST_/u, '').toLowerCase().replace(/^\w/u, (c) => c.toUpperCase()),
    yearIteration: Number(entry.YearIteration),
    days: (entry.Days || []).map((day) => ({
      date: new Date(Date.UTC(1999, 0, Number(day.day) || 1)).toISOString(),
      events: (day.events || []).map(eventOf).filter(Boolean),
    })),
  };
}

function normalizeDuviri(entry) {
  if (!entry) return null;
  return {
    id: `duviri-week:${isoOf(entry.Activation)}`, activation: isoOf(entry.Activation), expiry: isoOf(entry.Expiry),
    choices: (entry.CategoryChoices || []).map((choice) => ({
      category: choice.Category === 'EXC_HARD' ? 'hard' : 'normal', categoryKey: choice.Category, choices: choice.Choices || [],
    })),
  };
}

function normalizeSyndicates(entries, nodes) {
  const tagName = { CetusSyndicate: 'Ostrons', SolarisSyndicate: 'Solaris United', EntratiSyndicate: 'Entrati' };
  return (entries || []).map((entry) => ({
    id: idOf(entry), activation: isoOf(entry.Activation), expiry: isoOf(entry.Expiry), syndicate: tagName[entry.Tag] || entry.Tag,
    nodes: (entry.Nodes || []).map((node) => nodeOf(node, nodes)),
    jobs: (entry.Jobs || []).map((job) => ({
      id: `${String(job.jobType || '').split('/').pop()}${msOf(entry.Expiry) || ''}`,
      type: String(job.jobType || '').split('/').pop(), uniqueName: job.rewards || '',
      enemyLevels: [Number(job.minEnemyLevel) || 0, Number(job.maxEnemyLevel) || 0],
      standingStages: job.xpAmounts || [], minMR: Number(job.masteryReq) || 0, rewardPoolDrops: [],
    })),
  }));
}

export async function normalizeOfficialWorldState(raw, { nodes = {}, lang = {}, now = Date.now() } = {}) {
  const alerts = (raw?.Alerts || []).map((entry) => {
    const expiry = isoOf(entry.Expiry);
    return {
      id: idOf(entry), activation: isoOf(entry.Activation), expiry, expired: !expiry || Date.parse(expiry) <= now,
      mission: {
        node: nodeOf(entry?.MissionInfo?.location, nodes), type: missionOf(entry?.MissionInfo?.missionType),
        faction: factionOf(entry?.MissionInfo?.faction), reward: rewardOf(entry?.MissionInfo?.missionReward, lang),
      },
    };
  });
  const invasions = (raw?.Invasions || []).map((entry) => ({
    id: idOf(entry), activation: isoOf(entry.Activation), node: nodeOf(entry.Node, nodes), completed: Boolean(entry.Completed),
    expired: Boolean(entry.Completed), count: Number(entry.Count) || 0, requiredRuns: Number(entry.Goal) || 0,
    completion: Number(entry.Goal) ? Math.abs(Number(entry.Count) / Number(entry.Goal) * 100) : 0,
    attacker: { faction: factionOf(entry.Faction), reward: rewardOf(entry.AttackerReward, lang) },
    defender: { faction: factionOf(entry.DefenderFaction), reward: rewardOf(entry.DefenderReward, lang) },
    rewardTypes: [...(entry.AttackerReward?.items || []), ...(entry.AttackerReward?.countedItems || []), ...(entry.DefenderReward?.items || []), ...(entry.DefenderReward?.countedItems || [])].map((item) => itemName(item?.ItemType || item, lang)),
  }));
  const events = (raw?.Goals || []).map((entry) => {
    const expiry = isoOf(entry.Expiry);
    return {
      id: idOf(entry), activation: isoOf(entry.Activation), expiry, expired: !expiry || Date.parse(expiry) <= now,
      description: EVENT_NAME[entry.Tag] || String(entry.Desc || entry.Tag || 'Unknown').split('/').pop(),
      tooltip: EVENT_DETAIL[entry.Tag] || String(entry.ToolTip || '').split('/').pop(), node: nodeOf(entry.Node, nodes),
    };
  });
  const voidTraders = (raw?.VoidTraders || []).map((entry) => {
    const activation = isoOf(entry.Activation); const expiry = isoOf(entry.Expiry);
    return { id: idOf(entry), activation, expiry, active: Boolean(activation && expiry && Date.parse(activation) <= now && now < Date.parse(expiry)), location: HUB[entry.Node] || nodeOf(entry.Node, nodes), inventory: [] };
  });
  const nightwave = raw?.SeasonInfo ? {
    id: String(raw.SeasonInfo.Season ?? ''), tag: raw.SeasonInfo.AffiliationTag || '', activation: isoOf(raw.SeasonInfo.Activation), expiry: isoOf(raw.SeasonInfo.Expiry),
    activeChallenges: (raw.SeasonInfo.ActiveChallenges || []).map((entry) => ({ id: `${msOf(entry.Expiry)}${tailOf(entry.Challenge).toLowerCase()}`, activation: isoOf(entry.Activation), expiry: isoOf(entry.Expiry), isDaily: Boolean(entry.Daily), isElite: Boolean(entry.Elite) || String(entry.Challenge || '').includes('/WeeklyHard/') })),
  } : null;
  const sortie = normalizeSortie(raw?.Sorties?.[0], nodes, now);
  const archonHunt = normalizeSortie(raw?.LiteSorties?.[0], nodes, now, true);
  return {
    timestamp: isoOf(raw?.Time) || new Date(now).toISOString(), buildLabel: raw?.BuildLabel || null,
    fissures: [
      ...(raw?.ActiveMissions || []).map((entry) => normalizeFissure(entry, nodes, false, now)),
      ...(raw?.VoidStorms || []).map((entry) => normalizeFissure(entry, nodes, true, now)),
    ],
    alerts, invasions, events, sortie, archonHunt, nightwave, voidTraders, voidTrader: voidTraders[0] || null,
    syndicateMissions: normalizeSyndicates(raw?.SyndicateMissions, nodes),
    archimedeas: normalizeConquests(raw?.Conquests),
    duviriCycle: normalizeDuviri(raw?.EndlessXpSchedule?.[0]),
    calendar: normalizeCalendar(raw?.KnownCalendarSeasons?.[0]),
    constructionProgress: raw?.ProjectPct ? { fomorianProgress: Number(raw.ProjectPct[0]) || 0, razorbackProgress: Number(raw.ProjectPct[1]) || 0 } : null,
    _dataSource: 'api.warframe.com', _officialFallback: true,
  };
}

export function assertOfficialWorldStateContract(state) {
  const arrayFields = ['fissures', 'alerts', 'invasions', 'events', 'voidTraders', 'syndicateMissions', 'archimedeas'];
  for (const field of arrayFields) {
    if (!Array.isArray(state?.[field])) throw new Error(`official world state contract: ${field} must be an array`);
  }
  if (!state?.timestamp || !Number.isFinite(Date.parse(state.timestamp))) {
    throw new Error('official world state contract: timestamp missing or invalid');
  }
  for (const field of ['sortie', 'archonHunt', 'nightwave', 'duviriCycle', 'calendar']) {
    if (!(field in state)) throw new Error(`official world state contract: ${field} missing`);
  }
  return state;
}

export function assertOfficialRawWorldStateContract(raw) {
  const arrayFields = ['ActiveMissions', 'VoidStorms', 'Alerts', 'Invasions', 'Goals', 'VoidTraders', 'SyndicateMissions', 'Conquests'];
  for (const field of arrayFields) {
    if (!Array.isArray(raw?.[field])) throw new Error(`official raw world state contract: ${field} must be an array`);
  }
  if (!Number.isFinite(msOf(raw?.Time))) {
    throw new Error('official raw world state contract: Time missing or invalid');
  }
  return raw;
}

const RAW_ARRAY_FIELDS = ['ActiveMissions', 'VoidStorms', 'Alerts', 'Invasions', 'Goals', 'VoidTraders', 'SyndicateMissions', 'Conquests'];
const hashOf = (value) => {
  try { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); } catch { return null; }
};

// 来源质量信封：按来源记录 provider/fetchedAt/上游时间/延迟/完整性与内容哈希，
// 供 doctor 与巡检审计每个字段来自哪个提供者、多新鲜、是否完整。
function sourceEnvelope(raw, provider, { latencyMs = null, fetchedAt = null } = {}) {
  const missing = RAW_ARRAY_FIELDS.filter((field) => !Array.isArray(raw?.[field]));
  return {
    provider,
    fetchedAt: fetchedAt || new Date().toISOString(),
    upstreamTime: isoOf(raw?.Time) || null,
    latencyMs: Number.isFinite(latencyMs) ? Math.round(latencyMs) : null,
    completeness: { required: RAW_ARRAY_FIELDS.length, present: RAW_ARRAY_FIELDS.length - missing.length, missing },
    contentHash: hashOf(raw),
  };
}

// 规范化结果的每个顶层字段都由同一来源提供；按字段记录 provider 供审计，不做来源推断。
function fieldProvidersOf(state, provider) {
  const fieldProviders = {};
  for (const key of Object.keys(state || {})) {
    if (!key.startsWith('_')) fieldProviders[key] = provider;
  }
  return fieldProviders;
}

// 候选镜像（Oracle）必须有相对本机的合理新鲜上游时间；官方主源不设此门禁。
function assertFreshUpstream(raw, label = 'oracle', now = Date.now()) {
  const upstreamMs = msOf(raw?.Time);
  if (!Number.isFinite(upstreamMs) || now - upstreamMs > ORACLE_MAX_UPSTREAM_AGE_MS) {
    throw new Error(`${label} upstream state is too old`);
  }
}

const fissureEventIds = (state) => new Set((state?.fissures || []).map((entry) => entry?.id).filter(Boolean));

// 裂缝事件 ID 集合连续性：候选镜像与最近可靠规范化快照同属一个生命周期窗口时
// （缓存内记录 <10 分钟）必须存在交集；零交集说明镜像内容与已知现实不一致，
// 拒绝接管且不覆盖可靠缓存。
async function assertFissureContinuity(state, cacheName, readCached, now = Date.now()) {
  const snapshot = await readCached(cacheName, 2);
  const cachedIds = snapshot ? fissureEventIds(snapshot.data) : new Set();
  if (!cachedIds.size || !Number.isFinite(Number(snapshot.cachedAt)) || now - Number(snapshot.cachedAt) > CONTINUITY_WINDOW_MS) return;
  const candidateIds = fissureEventIds(state);
  for (const id of candidateIds) {
    if (cachedIds.has(id)) return;
  }
  throw new Error('fissure event set diverges from the last reliable snapshot');
}

export async function loadWorldState(platform = 'pc', options = {}) {
  const normalizedPlatform = platform === 'xbox' ? 'xb1' : platform === 'switch' ? 'swi' : platform;
  const forceOfficial = options.forceOfficial === true || process.env.WARFRAME_WORLDSTATE_FORCE_OFFICIAL === '1';
  const cacheName = `worldstate-normalized-${normalizedPlatform}${forceOfficial ? '-official-probe' : ''}`;
  const dependencies = {
    fetchJson: options.fetchJson || fetchJson,
    staleCachedJson: options.staleCachedJson || staleCachedJson,
    readCachedData: options.readCachedData || readCachedData,
    getBountyZhMaps: options.getBountyZhMaps || getBountyZhMaps,
    getLangTable: options.getLangTable || getLangTable,
  };
  const warframeStatUrl = `${PRIMARY_BASE}/${normalizedPlatform}`;
  const fetchWarframeStat = () => dependencies.fetchJson(warframeStatUrl, {
    endpoint: `worldstate:warframestat:${normalizedPlatform}`,
  });
  const fetchOracle = () => dependencies.fetchJson(ORACLE_URL, {
    endpoint: 'worldstate:oracle:pc',
    timeoutMs: ORACLE_TIMEOUT_MS,
    maxAttempts: 2,
    failureThreshold: 2,
  });
  // 节点/语言表：官方与 Oracle 镜像共用；本地缓存为主，失败不阻塞切换判定。
  const facts = () => Promise.all([
    dependencies.getBountyZhMaps(),
    dependencies.getLangTable().catch(() => ({})),
  ]);
  const result = await dependencies.staleCachedJson(cacheName, { ttlMs: CACHE_TTL_MS, version: 2 }, async () => {
    if (normalizedPlatform !== 'pc') {
      const primary = await fetchWarframeStat();
      return { ...primary, _dataSource: 'api.warframestat.us', _officialFallback: false };
    }

    try {
      let officialMeta = { latencyMs: null };
      const [officialResult, [maps, lang]] = await Promise.all([
        dependencies.staleCachedJson('official-worldstate', { ttlMs: 60_000, version: 2 }, () => {
          const started = Date.now();
          return dependencies.fetchJson(OFFICIAL_URL).then((data) => { officialMeta.latencyMs = Date.now() - started; return data; });
        }),
        facts(),
      ]);
      if (officialResult.stale) throw new Error('official world state source is stale');
      const official = officialResult.data;
      assertOfficialRawWorldStateContract(official);
      const state = assertOfficialWorldStateContract(await normalizeOfficialWorldState(official, { nodes: maps?.nodes || {}, lang }));
      state._officialFallback = false;
      state._sourceLabel = 'DE official worldState';
      state._envelope = sourceEnvelope(official, 'api.warframe.com', { latencyMs: officialMeta.latencyMs, fetchedAt: officialMeta.latencyMs === null ? officialResult.cachedAt : null });
      state._fieldProviders = fieldProvidersOf(state, 'api.warframe.com');

      // This request only updates the shared resilience/health record. It is deliberately
      // not awaited, so a slow or broken community convenience API cannot delay fresh
      // official PC data. Consumers always receive the already-validated official facts.
      if (!forceOfficial && options.crossCheck !== false) {
        void Promise.resolve(fetchWarframeStat()).catch(() => null);
        state._communityCrossCheck = 'scheduled';
      }
      return state;
    } catch (officialError) {
      if (forceOfficial) throw officialError;
      // 第二全量源：browse.wf Oracle 全量镜像（同一 raw worldState 结构）。镜像必须通过
      // 同官方一致的原始/规范化双层完整性合同；陈旧内层缓存、HTTP 200 但结构残缺、
      // 或规范化结果不完整，一律不得接管，也不得写入可靠规范化缓存。
      let oracleError = null;
      try {
        let oracleMeta = { latencyMs: null };
        const [oracleResult, [maps, lang]] = await Promise.all([
          dependencies.staleCachedJson('oracle-worldstate', { ttlMs: 60_000, version: 2 }, () => {
            const started = Date.now();
            return fetchOracle().then((data) => { oracleMeta.latencyMs = Date.now() - started; return data; });
          }),
          facts(),
        ]);
        if (oracleResult.stale) throw new Error('oracle world state source is stale');
        const oracle = oracleResult.data;
        assertOfficialRawWorldStateContract(oracle);
        assertFreshUpstream(oracle, 'oracle');
        const state = assertOfficialWorldStateContract(await normalizeOfficialWorldState(oracle, { nodes: maps?.nodes || {}, lang }));
        await assertFissureContinuity(state, cacheName, dependencies.readCachedData);
        state._dataSource = 'oracle.browse.wf';
        state._officialFallback = true;
        state._sourceLabel = 'browse.wf Oracle（DE 官方源暂不可用，已自动切换）';
        state._officialError = String(officialError?.message || officialError);
        state._officialHealth = officialError?.diagnostic || null;
        state._envelope = sourceEnvelope(oracle, 'oracle.browse.wf', { latencyMs: oracleMeta.latencyMs, fetchedAt: oracleMeta.latencyMs === null ? oracleResult.cachedAt : null });
        state._fieldProviders = fieldProvidersOf(state, 'oracle.browse.wf');
        return state;
      } catch (oracleError_) {
        oracleError = oracleError_;
      }
      try {
        const started = Date.now();
        const fallback = await fetchWarframeStat();
        return {
          ...fallback,
          _dataSource: 'api.warframestat.us',
          _officialFallback: true,
          _officialError: `${String(officialError?.message || officialError)}; oracle=${String(oracleError?.message || oracleError)}`,
          _officialHealth: officialError?.diagnostic || null,
          _oracleError: String(oracleError?.message || oracleError),
          _oracleHealth: oracleError?.diagnostic || null,
          _sourceLabel: 'WarframeStat（DE 官方源与 Oracle 镜像暂不可用，已自动切换）',
          _envelope: { provider: 'api.warframestat.us', fetchedAt: new Date().toISOString(), upstreamTime: null, latencyMs: Date.now() - started, completeness: null, contentHash: hashOf(fallback) },
          _fieldProviders: fieldProvidersOf(fallback, 'api.warframestat.us'),
        };
      } catch (communityError) {
        const error = new Error(`world state sources unavailable: official=${String(officialError?.message || officialError)}; oracle=${String(oracleError?.message || oracleError)}; warframestat=${String(communityError?.message || communityError)}`);
        error.cause = communityError;
        throw error;
      }
    }
  });
  return { ...result.data, _dataStale: result.stale, _cachedAt: result.cachedAt };
}
