// Resilient PC world-state loader.
// Order: WarframeStat normalized API -> official DE worldState.php -> last cached normalized snapshot.
// The official source is mapped to the subset consumed by public queries and subscriptions.

import { getBountyZhMaps, getLangTable, staleCachedJson } from './wfdata.mjs';
import { resilientJsonRequest } from './http-resilience.mjs';

const PRIMARY_BASE = 'https://api.warframestat.us';
const OFFICIAL_URL = 'https://api.warframe.com/cdn/worldState.php';
const TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 45_000;

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
    missions: (entry.Missions || []).map((mission) => ({
      faction: factionOf(mission.faction), factionKey: mission.faction,
      missionType: missionOf(mission.missionType), missionTypeKey: missionOf(mission.missionType),
      deviation: mission.difficulties?.[0]?.deviation
        ? { key: mission.difficulties[0].deviation, name: mission.difficulties[0].deviation, description: '' }
        : null,
      risks: [...new Set((mission.difficulties || []).flatMap((difficulty) => String(difficulty.risks || '').split(/\s+/u).filter(Boolean)))]
        .map((key, index) => ({ key, name: key, description: '', isHard: index > 0 })),
    })),
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

export async function loadWorldState(platform = 'pc', options = {}) {
  const normalizedPlatform = platform === 'xbox' ? 'xb1' : platform === 'switch' ? 'swi' : platform;
  const forceOfficial = options.forceOfficial === true || process.env.WARFRAME_WORLDSTATE_FORCE_OFFICIAL === '1';
  const cacheName = `worldstate-normalized-${normalizedPlatform}${forceOfficial ? '-official-probe' : ''}`;
  const result = await staleCachedJson(cacheName, { ttlMs: CACHE_TTL_MS, version: 1 }, async () => {
    try {
      if (forceOfficial) throw new Error('diagnostic: primary source bypassed');
      const primary = await fetchJson(`${PRIMARY_BASE}/${normalizedPlatform}`, {
        endpoint: `worldstate:warframestat:${normalizedPlatform}`,
      });
      return { ...primary, _dataSource: 'api.warframestat.us', _officialFallback: false };
    } catch (primaryError) {
      if (normalizedPlatform !== 'pc') throw primaryError;
      const [{ data: official }, maps, lang] = await Promise.all([
        staleCachedJson('official-worldstate', { ttlMs: 60_000, version: 1 }, () => fetchJson(OFFICIAL_URL)),
        getBountyZhMaps(),
        getLangTable().catch(() => ({})),
      ]);
      const state = assertOfficialWorldStateContract(await normalizeOfficialWorldState(official, { nodes: maps?.nodes || {}, lang }));
      state._primaryError = String(primaryError?.message || primaryError);
      state._primaryHealth = primaryError?.diagnostic || null;
      return state;
    }
  });
  return { ...result.data, _dataStale: result.stale, _cachedAt: result.cachedAt };
}
