// Prime 部件获取路线：纯决策层，不联网、不读个人数据。
// 调用方负责提供遗物反查、WFCD 静态掉点、当前赏金与可选本机库存。

import { REFINEMENTS } from './recommend.mjs';

const BOUNTY_PREFIXES = Object.freeze([
  ['希图斯悬赏', '希图斯'],
  ['福尔图娜悬赏', '福尔图娜'],
  ['殁世幽都悬赏', '殁世幽都'],
]);

const CONDITIONAL_SOURCES = new Set([
  '利刃豺狼', '巨人战舰破坏', '赤毒虹吸器', '赤毒洪流', '梦魇任务', '仲裁',
]);

const AVAILABILITY_ORDER = Object.freeze({ current: 0, always: 1, conditional: 2, rotation: 3, unknown: 4 });
const AVAILABILITY_ZH = Object.freeze({
  current: '当前赏金',
  always: '常驻掉点',
  conditional: '条件轮换',
  rotation: '悬赏轮换池',
  unknown: '来源待确认',
});

const compact = (value) => String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/[\s·]+/gu, '');
const round2 = (value) => Math.round(Number(value) * 100) / 100;

function rarityOf(chance) {
  const value = Number(chance);
  if (value <= 3) return 'rare';
  if (value <= 12) return 'uncommon';
  return 'common';
}

function targetRefinement(chance) {
  const rarity = rarityOf(chance);
  const refinement = rarity === 'common' ? REFINEMENTS[0] : REFINEMENTS[3];
  return {
    key: refinement.key,
    zh: refinement.zh,
    rarity,
    chance: round2(refinement.chance[rarity]),
  };
}

function bountyRegion(place) {
  return BOUNTY_PREFIXES.find(([prefix]) => String(place || '').startsWith(prefix))?.[1] || null;
}

function sourceKind(place) {
  if (bountyRegion(place)) return 'bounty';
  if (CONDITIONAL_SOURCES.has(String(place || '').replace(/（.*$/u, ''))) return 'conditional';
  return 'mission';
}

function sourceRow(source, availability, overrides = {}) {
  const chance = round2(source.chance);
  return {
    place: String(source.place || '')
      .replace(/H(?:ö|\?|�)llvania/giu, '霍瓦尼亚')
      .replace(/Legacyte Harvest/giu, '传承种收割'),
    chance,
    kind: overrides.kind || sourceKind(source.place),
    availability,
    availabilityZh: AVAILABILITY_ZH[availability],
    expectedSourceRewards: chance > 0 ? round2(100 / chance) : null,
    ...overrides,
  };
}

function currentBountySources(hits = []) {
  return hits.map((hit) => {
    const levels = Array.isArray(hit.levels) && hit.levels.length >= 2 ? ` Lv${hit.levels[0]}-${hit.levels[1]}` : '';
    return sourceRow({ place: `${hit.placeZh} ${hit.jobZh}${levels}`, chance: hit.chance }, 'current', {
      kind: 'bounty', expiry: hit.expiry || null,
    });
  });
}

export function classifyRelicSources(staticSources = [], currentHits = [], { bountyChecked = false } = {}) {
  const rows = [];
  const current = currentBountySources(currentHits);
  rows.push(...current);
  for (const source of staticSources) {
    const kind = sourceKind(source.place);
    if (kind === 'bounty') {
      const region = bountyRegion(source.place);
      // 当前赏金行采用实时 job/概率；静态表同一区域只保留为轮换池候选，避免重复声称“当前”。
      if (current.some((entry) => entry.place.startsWith(`${region} `))) continue;
      rows.push(sourceRow(source, bountyChecked ? 'rotation' : 'unknown', { kind: 'bounty' }));
    } else if (kind === 'conditional') {
      rows.push(sourceRow(source, 'conditional', { kind }));
    } else {
      rows.push(sourceRow(source, 'always', { kind }));
    }
  }
  const byPlace = new Map();
  for (const row of rows) {
    const key = `${row.availability}|${row.place}`;
    const previous = byPlace.get(key);
    if (!previous || row.chance > previous.chance) byPlace.set(key, row);
  }
  const unique = [...byPlace.values()];
  return unique.sort((left, right) => (AVAILABILITY_ORDER[left.availability] - AVAILABILITY_ORDER[right.availability])
    || right.chance - left.chance || left.place.localeCompare(right.place, 'zh-CN'));
}

function rewardIdentity(reward) {
  return reward.slug || compact(reward.name || reward.zhName);
}

export function resolveRelicFarmTarget(matches = []) {
  const rewards = new Map();
  for (const relic of matches) {
    for (const reward of relic.rewards || []) {
      const key = rewardIdentity(reward);
      if (!key) continue;
      const current = rewards.get(key) || { ...reward, relicNames: [] };
      if (!current.relicNames.includes(relic.name)) current.relicNames.push(relic.name);
      rewards.set(key, current);
    }
  }
  return [...rewards.values()].sort((left, right) => String(left.zhName || left.name).localeCompare(String(right.zhName || right.name), 'zh-CN'));
}

function warframePrimeFamily(target) {
  const slug = String(target?.slug || '');
  return slug.match(/^(.+_prime)(?:_(?:chassis|neuroptics|systems))?_blueprint$/u)?.[1] || null;
}

function componentOrder(target) {
  const slug = String(target?.slug || '');
  if (/_prime_blueprint$/u.test(slug)) return 0;
  if (/_neuroptics_blueprint$/u.test(slug)) return 1;
  if (/_chassis_blueprint$/u.test(slug)) return 2;
  if (/_systems_blueprint$/u.test(slug)) return 3;
  return 9;
}

function setDisplayName(targets) {
  const blueprint = targets.find((target) => /_prime_blueprint$/u.test(String(target.slug || ''))) || targets[0];
  return {
    name: String(blueprint?.name || '').replace(/\sBlueprint$/iu, ''),
    zhName: String(blueprint?.zhName || blueprint?.name || '').replace(/\s*蓝图$/u, ''),
    slug: warframePrimeFamily(blueprint),
  };
}

function buildSinglePlan({ query, matches, target, sourceMap, bountyHitsByRelic, bountyChecked, ownedRelics, fetchedAt }) {
  const ownedMap = ownedRelics == null ? null : new Map();
  for (const relic of ownedRelics || []) {
    const key = compact(relic.baseName);
    ownedMap.set(key, (ownedMap.get(key) || 0) + Math.max(0, Number(relic.count) || 0));
  }
  const rows = [];
  for (const relic of matches) {
    const reward = (relic.rewards || []).find((entry) => rewardIdentity(entry) === rewardIdentity(target));
    if (!reward) continue;
    const refinement = targetRefinement(reward.chance);
    const ownedCount = ownedMap ? (ownedMap.get(compact(relic.name)) || 0) : null;
    const sources = relic.vaulted ? [] : classifyRelicSources(
      sourceMap[relic.name] || [], bountyHitsByRelic[relic.name] || [], { bountyChecked },
    ).slice(0, 2);
    for (const source of sources) {
      source.combinedChance = round2(source.chance * refinement.chance / 100);
      source.expectedCombinedRewards = source.combinedChance > 0 ? round2(100 / source.combinedChance) : null;
    }
    rows.push({
      relic: { name: relic.name, zhName: relic.zhName, vaulted: Boolean(relic.vaulted), vanguard: /^Vanguard\s/iu.test(relic.name), ownedCount },
      target: { name: reward.name, zhName: reward.zhName, slug: reward.slug || null, rarity: refinement.rarity },
      refinement,
      sources,
      bestAvailability: sources[0]?.availability || 'unknown',
      bestCombinedChance: sources[0]?.combinedChance ?? null,
    });
  }
  rows.sort((left, right) => {
    const leftOwned = Number(left.relic.ownedCount) > 0;
    const rightOwned = Number(right.relic.ownedCount) > 0;
    return Number(rightOwned) - Number(leftOwned)
      || Number(left.relic.vaulted) - Number(right.relic.vaulted)
      || (AVAILABILITY_ORDER[left.bestAvailability] - AVAILABILITY_ORDER[right.bestAvailability])
      || (right.bestCombinedChance || 0) - (left.bestCombinedChance || 0)
      || left.relic.name.localeCompare(right.relic.name);
  });
  return { target, rows };
}

export function buildRelicFarmPlan({
  query,
  matches = [],
  sourceMap = {},
  bountyHitsByRelic = {},
  bountyChecked = false,
  ownedRelics = null,
  fetchedAt = new Date().toISOString(),
} = {}) {
  if (!matches.length) return { ok: false, kind: 'relic-farm', error: 'not_found', query, fetchedAt };
  const targets = resolveRelicFarmTarget(matches);
  if (targets.length !== 1) {
    const families = new Set(targets.map(warframePrimeFamily).filter(Boolean));
    if (targets.length >= 3 && families.size === 1 && targets.every(warframePrimeFamily)) {
      const sortedTargets = [...targets].sort((left, right) => componentOrder(left) - componentOrder(right));
      const components = sortedTargets.map((target) => buildSinglePlan({
        query, matches, target, sourceMap, bountyHitsByRelic, bountyChecked, ownedRelics, fetchedAt,
      })).map(({ target, rows }) => ({ target, route: rows[0] || null, alternatives: rows.slice(1, 3), relatedRelics: rows.length }));
      return {
        ok: true, kind: 'relic-farm', setMode: true, query,
        set: setDisplayName(sortedTargets), components,
        inventoryAvailable: ownedRelics != null, bountyChecked, fetchedAt,
      };
    }
    return {
      ok: false, kind: 'relic-farm', error: 'ambiguous_target', query, fetchedAt,
      choices: targets.slice(0, 8).map((target) => target.zhName || target.name),
    };
  }
  const target = targets[0];
  const { rows } = buildSinglePlan({ query, matches, target, sourceMap, bountyHitsByRelic, bountyChecked, ownedRelics, fetchedAt });
  return {
    ok: true,
    kind: 'relic-farm',
    query,
    target: { name: target.name, zhName: target.zhName, slug: target.slug || null },
    inventoryAvailable: ownedRelics != null,
    bountyChecked,
    rows: rows.slice(0, 6),
    total: rows.length,
    fetchedAt,
  };
}
