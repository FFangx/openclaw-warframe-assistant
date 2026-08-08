#!/usr/bin/env node

// 开遗物/裂缝库存增强：库存交集 → 双币期望 → 可选任务偏好，零 AI 判断。
// 知识依据见 references/game-knowledge.md：全能裂缝可开除安魂外任意遗物，绝不按「无对应遗物」过滤。
// 估值数据源（学 AlecaFrame 双指标思路）：
//   奖励表+概率 = 本地 Relics.json（离线）；杜卡德 = market /v1/tools/ducats 整表；白金 = 今日/90 日可靠成交中位（逐件持久缓存）
//   → 库存遗物全量估值，不做候选裁剪（曾按囤量 top4 取候选，把量少但值钱的遗物漏掉了）
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ITEMS_BASE = 'https://api.warframestat.us';
const MARKET_BASE = 'https://api.warframe.market';
const TIMEOUT_MS = 20_000;
const TOP_RESULTS = 8;
const MIN_REMAIN_MS = 5 * 60 * 1000; // 快过期的裂缝不推
const CACHE_TTL_MS = 60 * 60 * 1000;

const ERA_ZH = { Lith: '古纪', Meso: '前纪', Neo: '中纪', Axi: '后纪', Requiem: '安魂', Omnia: '全能' };
const MISSION_ZH = {
  Extermination: '歼灭', Capture: '捕获', Sabotage: '破坏', Rescue: '救援', Spy: '间谍',
  Defense: '防御', 'Mobile Defense': '移动防御', Interception: '拦截', Survival: '生存',
  Excavation: '挖掘', Disruption: '中断', 'Void Cascade': '虚空覆涌', 'Void Flood': '虚空洪流',
  Alchemy: '炼金术', Volatile: '反应堆破坏', Skirmish: '前哨战', Crossfire: '混战歼灭', Hijack: '劫持',
};
const PLANET_ZH = {
  Mercury: '水星', Venus: '金星', Earth: '地球', Lua: '月球', Mars: '火星', Deimos: '火卫二',
  Phobos: '火卫一', Ceres: '谷神星', Jupiter: '木星', Europa: '欧罗巴', Saturn: '土星',
  Uranus: '天王星', Neptune: '海王星', Pluto: '冥王星', Eris: '阋神星', Sedna: '赛德娜',
  Void: '虚空', Zariman: '扎里曼', 'Kuva Fortress': '赤毒要塞', Veil: '面纱比邻星',
  'Earth Proxima': '地球比邻星', 'Venus Proxima': '金星比邻星', 'Saturn Proxima': '土星比邻星',
  'Neptune Proxima': '海王星比邻星', 'Pluto Proxima': '冥王星比邻星', 'Veil Proxima': '面纱比邻星',
};

// 任务体验只做离散标签和优先级，不再伪装成精确耗时系数乘进遗物价值。
const SPEED_MISSIONS = new Set(['Capture', 'Extermination']);
const COMFORT_MISSIONS = new Set(['Defense', 'Survival']);
const ENDLESS_MISSIONS = new Set([
  'Defense', 'Survival', 'Interception', 'Excavation', 'Disruption',
  'Void Cascade', 'Void Flood', 'Alchemy',
]);

export const FISSURE_PREFERENCES = Object.freeze({
  balanced: { zh: '综合', command: '' },
  speed: { zh: '速刷', command: '速刷' },
  comfort: { zh: '舒适', command: '舒适' },
  yield: { zh: '收益', command: '收益' },
});

export const RELIC_VAULT_FILTERS = Object.freeze({
  all: { zh: '全部遗物', command: '' },
  unvaulted: { zh: '未入库', command: '未入库' },
  vaulted: { zh: '已入库', command: '已入库' },
});

export function parseFissurePreference(value) {
  const text = String(value || '').normalize('NFKC');
  if (/速刷|快速|快开|效率/iu.test(text)) return 'speed';
  if (/舒适|轻松|挂机/iu.test(text)) return 'comfort';
  if (/收益|额外|长线/iu.test(text)) return 'yield';
  return 'balanced';
}

export function parseRelicVaultFilter(value) {
  const text = String(value || '').normalize('NFKC');
  // 「未入库」本身包含「入库」，所以必须先判断未入库。
  if (/未入库|当前可获取|可获取|现役/iu.test(text)) return 'unvaulted';
  if (/已入库|入库|绝版/iu.test(text)) return 'vaulted';
  return 'all';
}

export function parseDucatRecommendTarget(value) {
  const text = String(value || '').normalize('NFKC').trim();
  if (!/杜卡德|金币|ducat/iu.test(text)) return { type: 'none', query: '' };
  if (/(?:^|\s)奸商(?:\s|$)/u.test(text)) return { type: 'trader', query: '' };
  const modifiers = /^(?:杜卡德|金币|ducat|白金|未入库|已入库|当前可获取|可获取|现役|速刷|快速|快开|效率|舒适|轻松|挂机|收益|额外|长线|单人|solo|1人|一人|组队|4人|四人)$/iu;
  const query = text.split(/\s+/u).filter((token) => !modifiers.test(token)).join(' ').trim();
  return query ? { type: 'item', query } : { type: 'ordinary', query: '' };
}

export function classifyFissure(fissure) {
  const tags = [];
  if (SPEED_MISSIONS.has(fissure.missionType)) tags.push({ key: 'speed', zh: '速刷' });
  if (COMFORT_MISSIONS.has(fissure.missionType)) tags.push({ key: 'comfort', zh: '舒适' });
  if (ENDLESS_MISSIONS.has(fissure.missionType)) tags.push({ key: 'endless', zh: '长线' });
  if (fissure.isStorm || fissure.isHard) tags.push({ key: 'bonus', zh: '额外收益' });
  return tags;
}

function preferenceRank(row, preference) {
  const has = (key) => row.tags.some((tag) => tag.key === key);
  if (preference === 'speed') return has('speed') ? 0 : 1;
  if (preference === 'comfort') return has('comfort') ? 0 : 1;
  if (preference === 'yield') {
    if (row.storm) return 0;
    if (row.hard) return 1;
    if (has('endless')) return 2;
    return 3;
  }
  return 0;
}

// 综合榜先看真实遗物收益；仅在收益完全相同时用离散体验标签打破平局。
// 这样不会再制造“任务效率精确分数”，也不会让持续型扎里曼任务仅凭剩余时间排第一。
function balancedTieRank(row) {
  const has = (key) => row.tags.some((tag) => tag.key === key);
  // 九重天实际效率对舰员等级、配置和熟练度更敏感，放在同收益候选的最后。
  if (row.storm) return 5;
  if (has('speed')) return 0;
  if (has('comfort')) return 1;
  if (row.hard) return 2;
  if (has('endless')) return 4;
  return 3;
}

async function getJson(url, headers = {}, attempt = 0) {
  const response = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) {
    if (attempt < 2 && (response.status === 429 || response.status >= 500)) {
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      return getJson(url, headers, attempt + 1);
    }
    throw new Error(`HTTP ${response.status}: ${url}`);
  }
  return response.json();
}

async function mapLimit(values, limit, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index], index);
    }
  }));
  return results;
}

// —— 本地遗物奖励表（AlecaFrame cachedData，只读；本地缺失走 CDN 兑底） ——
export async function loadLocalRelicDb(alecaDir) {
  const { readAlecaJson } = await import('./wfdata.mjs');
  const relicsRaw = await readAlecaJson('json/Relics.json', { alecaDir });
  if (!Array.isArray(relicsRaw)) throw new Error('遗物奖励表不可用（本地与在线源均读不到）');
  const rewardsByBase = new Map();
  for (const relic of relicsRaw) {
    // 只取 Intact 版本（概率基准）；同一遗物其余精炼度奖励同源
    const match = String(relic.name || '').match(/^(.+)\s+Intact$/u);
    if (!match || !Array.isArray(relic.rewards)) continue;
    rewardsByBase.set(match[1], relic.rewards.map((reward) => ({
      name: reward.item?.name || '',
      slug: reward.item?.warframeMarket?.urlName || null,
      chance: Number(reward.chance) || 0,
    })));
  }
  return { rewardsByBase };
}

// —— 杜卡德整表 + 逐件成交中位：slug → { p, d, zh, marketBasis, dailyVolume, reliable } ——
// 附带 __meta 键（非 slug 命名空间不冲突）：{stale, cachedAt}，调用方据此标注「离线快照」
export async function loadPriceTable() {
  const { staleCachedJson } = await import('./wfdata.mjs');
  const result = await staleCachedJson('market-price-table', { ttlMs: CACHE_TTL_MS, version: 4 }, async () => {
    const [items, ducats] = await Promise.all([
      getJson(`${MARKET_BASE}/v2/items`, { Platform: 'pc', Crossplay: 'true', Language: 'zh-hans' }),
      getJson(`${MARKET_BASE}/v1/tools/ducats`),
    ]);
    const byId = new Map((items.data || []).map((item) => [item.id, {
      slug: item.slug,
      zh: item.i18n?.['zh-hans']?.name || null,
      isMod: (item.tags || []).includes('mod'),
    }]));
    const payload = ducats?.payload || {};
    const rows = payload.previous_hour?.length ? payload.previous_hour : (payload.previous_day || []);
    const prices = {};
    for (const row of rows) {
      const meta = byId.get(row.item);
      if (!meta) continue;
      prices[meta.slug] = { p: null, d: Number(row.ducats) || 0, zh: meta.zh, isMod: meta.isMod, reliable: false };
    }
    if (!Object.keys(prices).length) throw new Error('价格整表为空');
    return prices;
  });
  return { ...result.data, __meta: { stale: result.stale, cachedAt: result.cachedAt } };
}

export async function loadFairPriceTable(rewards, options = {}) {
  if (options.prices) {
    return Object.fromEntries(Object.entries(options.prices).map(([slug, entry]) => [slug,
      slug === '__meta' ? entry : { ...entry, reliable: entry?.reliable ?? true }]));
  }
  const base = await loadPriceTable();
  const prices = {};
  for (const [slug, entry] of Object.entries(base)) {
    if (slug === '__meta') continue;
    prices[slug] = { ...entry };
  }
  const slugs = [...new Set((rewards || []).map((reward) => reward?.slug).filter((slug) => slug && prices[slug]))];
  const { fetchTradeStatistics } = await import('./trader-shopping.mjs');
  await mapLimit(slugs, 4, async (slug) => {
    const entry = prices[slug];
    const quote = await fetchTradeStatistics(slug, Boolean(entry.isMod));
    if (!quote?.platinum) return;
    entry.p = quote.platinum;
    entry.marketBasis = quote.basis;
    entry.dailyVolume = quote.dailyVolume;
    entry.reliable = true;
    entry.stale = Boolean(quote.stale);
  });
  prices.__meta = base.__meta;
  return prices;
}

// —— 精炼度与组队期望（2026-08-04，口径对齐 AlecaFrame） ——
// 四档掉率见 references/game-knowledge.md；每档 chance = 单个奖励的独立概率（常见×3/罕见×2/稀有×1）
export const REFINEMENTS = [
  { key: 'Intact', zh: '完整', traces: 0, chance: { common: 76 / 3, uncommon: 22 / 2, rare: 2 } },
  { key: 'Exceptional', zh: '优良', traces: 25, chance: { common: 70 / 3, uncommon: 26 / 2, rare: 4 } },
  { key: 'Flawless', zh: '无瑕', traces: 50, chance: { common: 60 / 3, uncommon: 34 / 2, rare: 6 } },
  { key: 'Radiant', zh: '光辉', traces: 100, chance: { common: 50 / 3, uncommon: 40 / 2, rare: 10 } },
];
const rarityOfChance = (chance) => (Number(chance) <= 3 ? 'rare' : Number(chance) <= 12 ? 'uncommon' : 'common');

// E[max of squad 次独立 roll]：开奖可选全队任意人的奖励，所以组队期望是取最优而非算术和。
// squad=1 时退化为单人期望 Σp·v（同一公式两套口径）。逆向验证：AlecaFrame Squad=4 杜卡德 39.2/34.4/36.5 全部精确复现。
export function expectedBest(entries, squad = 4) {
  const sorted = entries.filter((item) => Number(item.chance) > 0).sort((a, b) => a.value - b.value);
  // 概率总和 <100 时缺失部分按「0 价值」垫底（否则组队口径会把低概率高价值项的 CDF 算穿）
  const total = sorted.reduce((sum, item) => sum + item.chance, 0);
  let cumulative = Math.max(0, 1 - total / 100);
  let expected = 0;
  let prevPow = Math.pow(cumulative, squad);
  for (const item of sorted) {
    cumulative = Math.min(cumulative + item.chance / 100, 1);
    const pow = Math.pow(cumulative, squad);
    expected += item.value * (pow - prevPow);
    prevPow = pow;
  }
  return expected;
}

// 指定精炼档下的组队期望（白金+杜卡德各算一次：价值排序不同不能共用 CDF）。
// 概率用「档位缩放」而非查表覆盖：ref档/Intact档 的比例乘原始 chance——Intact 严格保持数据原值，
// 非标准概率（打桩/未来特殊遗物）也不失真；标准遗物两法等价。
function refinementExpectation(rewards, priceOf, refinement, squad) {
  const intact = REFINEMENTS[0];
  const withChance = rewards.map((reward) => {
    const rarity = rarityOfChance(reward.chance);
    return { reward, chance: reward.chance * (refinement.chance[rarity] / intact.chance[rarity]) };
  });
  const plat = expectedBest(withChance.map(({ reward, chance }) => ({ value: priceOf(reward)?.p || 0, chance })), squad);
  const ducats = expectedBest(withChance.map(({ reward, chance }) => ({ value: priceOf(reward)?.d || 0, chance })), squad);
  return { plat: Math.round(plat * 10) / 10, ducats: Math.round(ducats * 10) / 10 };
}

// 建议阈值：每 100 光体的期望增益（光辉 vs 完整）。
// 🔴 组队口径下增益被放大约 3 倍（4 人取最优），阈值必须分口径定——
// 2026-08-04 真实库存 50 种实测：统一用单人阈值时组队档 68% 判光辉，推荐失去筛选意义；
// 分口径后组队白金分布 ≈ 光辉/无瑕/不精炼 各三分之一。数字按增益分位数拍定，可调。
const REFINE_THRESHOLDS = {
  plat: { squad: { radiant: 6, flawless: 2.5 }, solo: { radiant: 2.5, flawless: 1.2 } },
  ducat: { squad: { radiant: 25, flawless: 12 }, solo: { radiant: 10, flawless: 5 } },
};

// rewards（带 Intact chance）→ 四档期望 + 建议档位；priceOf(reward) → {p,d}，价格口径由调用方定
export function appraiseRefinements(rewards, priceOf, { squad = 4, mode = 'plat' } = {}) {
  const tiers = REFINEMENTS.map((refinement) => ({ key: refinement.key, zh: refinement.zh, traces: refinement.traces, ...refinementExpectation(rewards, priceOf, refinement, squad) }));
  const gainPlat = Math.round((tiers[3].plat - tiers[0].plat) * 10) / 10;
  const gainDucats = Math.round(tiers[3].ducats - tiers[0].ducats);
  const ducatMode = mode === 'ducat';
  const gain = ducatMode ? gainDucats : gainPlat;
  const bar = REFINE_THRESHOLDS[ducatMode ? 'ducat' : 'plat'][squad > 1 ? 'squad' : 'solo'];
  const pick = gain >= bar.radiant ? tiers[3] : gain >= bar.flawless ? tiers[2] : tiers[0];
  const unit = ducatMode ? '杜' : 'p';
  const suggest = {
    key: pick.key,
    zh: pick.key === 'Intact' ? '不精炼' : pick.zh,
    gainPlat,
    gainDucats,
    reason: pick.key === 'Intact'
      ? `精炼满也只多 ${ducatMode ? `${gainDucats} 杜` : `${gainPlat}p`}，直接开`
      : `光辉比完整期望 +${ducatMode ? `${gainDucats} 杜` : `${gainPlat}p`}/100光体`,
  };
  return { tiers, suggest, squad };
}

// 组队口径估值（默认 squad=4 对齐 AlecaFrame；squad=1 退化为算术期望）；无 slug 的奖励价值按 0
export function appraiseOffline(rewards, prices, squad = 4) {
  const priceOf = (reward) => (reward.slug ? prices[reward.slug] : null);
  const expected = expectedBest(rewards.map((reward) => ({ value: priceOf(reward)?.p || 0, chance: reward.chance })), squad);
  const expectedDucats = expectedBest(rewards.map((reward) => ({ value: priceOf(reward)?.d || 0, chance: reward.chance })), squad);
  let top = null;
  let topDucat = null;
  for (const reward of rewards) {
    const entry = priceOf(reward);
    const price = entry?.p || 0;
    const ducats = entry?.d || 0;
    const zhName = entry?.zh || reward.name;
    if (reward.chance <= 3 && (!top || price > (top.price || 0))) top = {
      name: reward.name,
      zhName,
      price: Math.round(price * 10) / 10,
      marketBasis: entry?.marketBasis || null,
      dailyVolume: entry?.dailyVolume ?? null,
    };
    if (!topDucat || ducats > (topDucat.ducats || 0)) topDucat = { name: reward.name, zhName, ducats };
  }
  const priceReliable = rewards.every((reward) => !reward.slug || Boolean(prices[reward.slug]?.reliable));
  return { expected: Math.round(expected * 10) / 10, expectedDucats: Math.round(expectedDucats), top, topDucat, priceReliable };
}

// 目标商品模式：一次开奖中先比较每个实际候选奖励的经济盈余，再按开奖概率求期望。
// 这里只枚举公开掉率，不读取游戏画面、网络封包或队友客户端。4 人时最多 7^4=2401 种组合。
export function appraiseTraderTarget(rewards, prices, squad = 4, goal = {}) {
  const targetDucats = Number(goal.ducats) || 0;
  const targetPlat = Number(goal.marketPlat) || 0;
  if (targetDucats <= 0 || targetPlat <= 0) return null;
  const platPerDucat = targetPlat / targetDucats;
  const rolls = rewards.map((reward) => {
    const entry = reward.slug ? prices[reward.slug] : null;
    const ducats = Number(entry?.d) || 0;
    const platinum = Number(entry?.p) || 0;
    return {
      chance: Math.max(0, Number(reward.chance) || 0) / 100,
      ducats,
      platinum,
      saving: Math.max(0, ducats * platPerDucat - platinum),
    };
  });
  const totalChance = rolls.reduce((sum, reward) => sum + reward.chance, 0);
  if (totalChance < 1) rolls.push({ chance: 1 - totalChance, ducats: 0, platinum: 0, saving: 0 });
  const draws = Math.max(1, Math.min(4, Number(squad) || 1));
  let expectedSaving = 0;
  let expectedDucats = 0;
  let expectedPlat = 0;
  let conversionChance = 0;
  const better = (candidate, current) => !current
    || candidate.saving > current.saving
    || (candidate.saving === current.saving && candidate.ducats > current.ducats)
    || (candidate.saving === current.saving && candidate.ducats === current.ducats && candidate.platinum < current.platinum);
  const visit = (depth, probability, best) => {
    if (depth === draws) {
      if (best?.saving > 0) {
        expectedSaving += probability * best.saving;
        expectedDucats += probability * best.ducats;
        expectedPlat += probability * best.platinum;
        conversionChance += probability;
      }
      return;
    }
    for (const reward of rolls) {
      if (reward.chance <= 0) continue;
      visit(depth + 1, probability * reward.chance, better(reward, best) ? reward : best);
    }
  };
  visit(0, 1, null);
  return {
    expectedSaving: Math.round(expectedSaving * 10) / 10,
    expectedDucats: Math.round(expectedDucats * 10) / 10,
    expectedPlat: Math.round(expectedPlat * 10) / 10,
    conversionChance: Math.round(conversionChance * 1000) / 10,
    ducatsPerPlat: Math.round(targetDucats / targetPlat * 10) / 10,
  };
}

const relicEra = (baseName) => String(baseName).split(' ')[0];
const relicZh = (baseName) => {
  const [era, code] = String(baseName).split(' ');
  return `${ERA_ZH[era] || era} ${code || ''}`.trim();
};
const vaultStatusZh = (vaulted) => (vaulted ? '已入库' : '未入库');

function splitNode(value) {
  const match = String(value || '').match(/^(.*?)\s*\(([^)]+)\)\s*$/u);
  if (!match) return { node: String(value || '未知节点'), planet: '未知星区' };
  return { node: match[1], planet: PLANET_ZH[match[2]] || match[2] };
}

// relics: alecaframe loadRelics 的输出；options.mode: 'plat'（默认）| 'ducat'；options.squad: 4（默认组队）| 1（单人）；options.preference: balanced|speed|comfort|yield；options.vaultFilter: all|unvaulted|vaulted
export async function recommendFissures(relics, options = {}) {
  const mode = options.mode === 'ducat' ? 'ducat' : 'plat';
  const perspective = options.perspective === 'fissure' ? 'fissure' : 'relic';
  const squad = Number(options.squad) >= 1 ? Math.min(Number(options.squad), 4) : 4;
  const preference = FISSURE_PREFERENCES[options.preference] ? options.preference : parseFissurePreference(options.preference);
  const vaultFilter = RELIC_VAULT_FILTERS[options.vaultFilter] ? options.vaultFilter : parseRelicVaultFilter(options.vaultFilter);
  const ducatGoal = mode === 'ducat' && options.ducatGoal ? options.ducatGoal : null;
  const ducatStrategy = mode === 'ducat' ? (ducatGoal ? 'trader' : 'ordinary') : null;
  const now = Date.now();

  // 1) 库存按遗物合并精炼度——全量进入估值，不做候选裁剪
  const byBase = new Map();
  for (const item of relics) {
    const entry = byBase.get(item.baseName) || { base: item.baseName, era: relicEra(item.baseName), count: 0, refinements: new Set(), vaulted: Boolean(item.vaulted) };
    entry.count += item.count;
    if (item.refinement) entry.refinements.add(item.refinement);
    entry.vaulted = entry.vaulted || Boolean(item.vaulted);
    byBase.set(item.baseName, entry);
  }
  const allOwned = [...byBase.values()].filter((entry) => entry.count > 0);
  const owned = allOwned.filter((entry) => vaultFilter === 'vaulted'
    ? entry.vaulted
    : vaultFilter === 'unvaulted'
      ? !entry.vaulted
      : true);
  if (!owned.length && vaultFilter !== 'all') {
    return { ok: false, kind: 'fissure-recommend', mode, preference, squad, vaultFilter, error: 'no_relics_for_vault_filter', fetchedAt: new Date().toISOString() };
  }
  const requiemCount = owned.filter((entry) => entry.era === 'Requiem').reduce((sum, entry) => sum + entry.count, 0);

  // 2) 裂缝 + 奖励表 + 价格整表
  const worldState = options.worldState || await getJson(`${ITEMS_BASE}/pc`);
  const minRemainMs = Number.isFinite(Number(options.minRemainMs)) ? Math.max(0, Number(options.minRemainMs)) : MIN_REMAIN_MS;
  const fissures = (Array.isArray(worldState.fissures) ? worldState.fissures : [])
    .filter((f) => !f.expired && Date.parse(f.expiry) - now > minRemainMs);
  if (!fissures.length) {
    return { ok: false, kind: 'fissure-recommend', mode, preference, squad, vaultFilter, error: 'no_fissures', fetchedAt: new Date().toISOString() };
  }
  let localDb = options.localDb ?? null;
  if (!localDb && options.alecaDir) {
    try { localDb = await loadLocalRelicDb(options.alecaDir); } catch { localDb = null; }
  }
  if (!localDb) {
    return { ok: false, kind: 'fissure-recommend', mode, preference, squad, vaultFilter, error: 'no_local_relic_db', fetchedAt: new Date().toISOString() };
  }
  const relevantRewards = owned.flatMap((entry) => localDb.rewardsByBase.get(entry.base) || []);
  const prices = await loadFairPriceTable(relevantRewards, options);
  const priceStaleAt = prices.__meta?.stale ? prices.__meta.cachedAt : null;

  // 3) 全量离线估值（组队口径）+ 精炼建议
  const priceOf = (reward) => (reward.slug ? prices[reward.slug] : null);
  const appraisedAll = [];
  for (const entry of owned) {
    const rewards = localDb.rewardsByBase.get(entry.base);
    if (!rewards) continue;
    const refine = appraiseRefinements(rewards, priceOf, { squad, mode });
    const targetEconomy = ducatGoal ? appraiseTraderTarget(rewards, prices, squad, ducatGoal) : null;
    appraisedAll.push({ ...entry, refinements: [...entry.refinements], ...appraiseOffline(rewards, prices, squad), refine, targetEconomy });
  }
  const appraised = appraisedAll.filter((entry) => entry.era !== 'Requiem'
    && (mode === 'ducat' && !ducatGoal ? true : entry.priceReliable));

  // 4) 先按遗物价值排，再为每枚遗物挑最多两条当前路线。
  // 全能=可承载全部非安魂候选（game-knowledge：全能可开除安魂外任意遗物）。
  // 模式价值键：赚白金=白金期望；普通杜卡德=毛杜卡德期望；奸商目标=同次开奖中可兑换奖励的预期白金节省。
  const valueOf = (entry) => mode === 'ducat'
    ? (ducatGoal ? (entry.targetEconomy?.expectedSaving || 0) : (entry.expectedDucats || 0))
    : entry.expected;
  const makeRow = (fissure, relic) => {
    const location = splitNode(fissure.node);
    const row = {
      id: fissure.id,
      tier: fissure.tier,
      tierZh: ERA_ZH[fissure.tier] || fissure.tier,
      hard: Boolean(fissure.isHard),
      storm: Boolean(fissure.isStorm),
      missionType: fissure.missionType,
      missionZh: MISSION_ZH[fissure.missionType] || fissure.missionType || '未知任务',
      tags: classifyFissure(fissure),
      node: location.node,
      planet: location.planet,
      expiry: fissure.expiry,
      relic: { base: relic.base, zh: relicZh(relic.base), count: relic.count, refinements: relic.refinements, vaulted: relic.vaulted },
      topReward: relic.top,
      topDucat: relic.topDucat || null,
      expectedValue: relic.expected,
      expectedDucats: relic.expectedDucats || 0,
      targetEconomy: relic.targetEconomy || null,
      refineZh: relic.refine?.suggest?.zh || null,
      refineReason: relic.refine?.suggest?.reason || null,
      valueScore: Math.round(valueOf(relic) * 10) / 10,
    };
    row.preferenceRank = preferenceRank(row, preference);
    row.balancedTieRank = balancedTieRank(row);
    return row;
  };
  const routeOrder = (a, b) => a.preferenceRank - b.preferenceRank
    || (preference === 'balanced' ? a.balancedTieRank - b.balancedTieRank : 0)
    || Date.parse(b.expiry) - Date.parse(a.expiry)
    || String(a.id).localeCompare(String(b.id));
  const requiemFissures = fissures.filter((fissure) => fissure.tier === 'Requiem').length;
  const runnableFissures = fissures.filter((fissure) => fissure.tier !== 'Requiem');
  const eligibleRelics = ducatGoal ? appraised.filter((entry) => valueOf(entry) > 0) : appraised;

  // 裂缝先行：每条当前裂缝只出现一次，再从兼容库存中挑价值最高的遗物。
  // 用于主人私聊的「裂缝」库存增强；排序由裂缝查询卡负责，这里不再混入旧任务权重。
  if (perspective === 'fissure') {
    const reliableAll = mode === 'ducat' && !ducatGoal ? appraisedAll : appraisedAll.filter((entry) => entry.priceReliable);
    const eligibleAll = ducatGoal ? reliableAll.filter((entry) => valueOf(entry) > 0) : reliableAll;
    const bestForTier = (tier) => {
      const pool = tier === 'Omnia'
        ? eligibleAll.filter((entry) => entry.era !== 'Requiem')
        : eligibleAll.filter((entry) => entry.era === tier);
      return [...pool].sort((a, b) => valueOf(b) - valueOf(a) || String(a.base).localeCompare(String(b.base)))[0] || null;
    };
    const rows = fissures.flatMap((fissure) => {
      const relic = bestForTier(fissure.tier);
      return relic ? [makeRow(fissure, relic)] : [];
    });
    return {
      ok: true,
      kind: 'fissure-recommend',
      perspective,
      mode,
      preference,
      vaultFilter,
      ducatStrategy,
      ducatGoal,
      squad,
      fetchedAt: new Date().toISOString(),
      priceStaleAt,
      rows,
      matchedCount: rows.length,
      matchedRelicCount: new Set(rows.map((row) => row.relic.base)).size,
      totalFissures: fissures.length,
      appraisedCount: appraisedAll.length,
      economicallyViableCount: ducatGoal ? eligibleAll.length : null,
      error: null,
      requiem: requiemFissures > 0 && requiemCount > 0 ? { fissures: requiemFissures, relics: requiemCount } : null,
    };
  }

  const routeGroups = [];
  for (const relic of eligibleRelics) {
    const routes = runnableFissures
      .filter((fissure) => fissure.tier === 'Omnia' || fissure.tier === relic.era)
      .map((fissure) => makeRow(fissure, relic))
      .sort(routeOrder)
      .slice(0, 2);
    if (!routes.length) continue;
    routeGroups.push({
      relic,
      valueScore: Math.round(valueOf(relic) * 10) / 10,
      bestRoute: routes[0],
      routes,
    });
  }
  routeGroups.sort((a, b) => b.valueScore - a.valueScore
    || routeOrder(a.bestRoute, b.bestRoute)
    || String(a.relic.base).localeCompare(String(b.relic.base)));
  const matchedRows = routeGroups.flatMap((group) => group.routes);
  const rows = matchedRows.slice(0, TOP_RESULTS);

  return {
    ok: rows.length > 0,
    kind: 'fissure-recommend',
    perspective,
    mode,
    preference,
    vaultFilter,
    ducatStrategy,
    ducatGoal,
    squad,
    fetchedAt: new Date().toISOString(),
    priceStaleAt,
    rows,
    matchedCount: matchedRows.length,
    matchedRelicCount: routeGroups.length,
    totalFissures: fissures.length,
    appraisedCount: appraised.length,
    economicallyViableCount: ducatGoal ? appraised.filter((entry) => valueOf(entry) > 0).length : null,
    error: rows.length ? null : (ducatGoal ? 'market_route_better' : 'no_matching_fissures'),
    requiem: requiemFissures > 0 && requiemCount > 0 ? { fissures: requiemFissures, relics: requiemCount } : null,
  };
}

// —— 库存全扫：哪些遗物值得精炼（按精炼增益排序） ——
export async function recommendRefinement(relics, options = {}) {
  const mode = options.mode === 'ducat' ? 'ducat' : 'plat';
  const squad = Number(options.squad) >= 1 ? Math.min(Number(options.squad), 4) : 4;
  let localDb = options.localDb ?? null;
  if (!localDb && options.alecaDir) {
    try { localDb = await loadLocalRelicDb(options.alecaDir); } catch { localDb = null; }
  }
  if (!localDb) return { ok: false, kind: 'refine-recommend', mode, squad, error: 'no_local_relic_db', fetchedAt: new Date().toISOString() };
  // 库存合并（含安魂：安魂 Mod 可交易，精炼同样有效）
  const byBase = new Map();
  for (const item of relics) {
    const entry = byBase.get(item.baseName) || { base: item.baseName, count: 0, vaulted: Boolean(item.vaulted) };
    entry.count += item.count;
    entry.vaulted = entry.vaulted || Boolean(item.vaulted);
    byBase.set(item.baseName, entry);
  }
  const relevantRewards = [...byBase.values()].flatMap((entry) => localDb.rewardsByBase.get(entry.base) || []);
  const prices = await loadFairPriceTable(relevantRewards, options);
  const priceStaleAt = prices.__meta?.stale ? prices.__meta.cachedAt : null;
  const priceOf = (reward) => (reward.slug ? prices[reward.slug] : null);
  const rows = [];
  for (const entry of [...byBase.values()].filter((item) => item.count > 0)) {
    const rewards = localDb.rewardsByBase.get(entry.base);
    if (!rewards) continue;
    const { tiers, suggest } = appraiseRefinements(rewards, priceOf, { squad, mode });
    const topRare = rewards.filter((reward) => reward.chance <= 3)
      .map((reward) => ({
        zhName: priceOf(reward)?.zh || reward.name,
        price: priceOf(reward)?.p || 0,
        marketBasis: priceOf(reward)?.marketBasis || null,
        dailyVolume: priceOf(reward)?.dailyVolume ?? null,
      }))
      .sort((a, b) => b.price - a.price)[0] || null;
    if (mode === 'plat' && rewards.some((reward) => reward.slug && !prices[reward.slug]?.reliable)) continue;
    rows.push({
      base: entry.base,
      zh: relicZh(entry.base),
      count: entry.count,
      vaulted: entry.vaulted,
      intact: tiers[0],
      radiant: tiers[3],
      suggest,
      topRare,
    });
  }
  const gainOf = (row) => (mode === 'ducat' ? row.suggest.gainDucats : row.suggest.gainPlat);
  rows.sort((a, b) => gainOf(b) - gainOf(a) || b.count - a.count);
  // 全量三档分布（卡片只显示 TOP，分布让「不值得精炼的大多数」可见）
  const distribution = { radiant: 0, flawless: 0, intact: 0 };
  for (const row of rows) {
    if (row.suggest.key === 'Radiant') distribution.radiant += 1;
    else if (row.suggest.key === 'Flawless') distribution.flawless += 1;
    else distribution.intact += 1;
  }
  const worth = rows.filter((row) => row.suggest.key !== 'Intact');
  // 各档代表（档内增益最高者）：TOP 榜按增益排序天然被光辉档霸屏，示例行让另两档可见
  const examplesOf = (key) => rows.filter((row) => row.suggest.key === key).slice(0, 2)
    .map((row) => `${row.zh}（${vaultStatusZh(row.vaulted)}）`);
  return {
    ok: rows.length > 0,
    kind: 'refine-recommend',
    mode,
    squad,
    fetchedAt: new Date().toISOString(),
    priceStaleAt,
    rows: rows.slice(0, Number(options.top) || 12),
    totalOwned: rows.length,
    worthCount: worth.length,
    distribution,
    examples: { flawless: examplesOf('Flawless'), intact: examplesOf('Intact') },
  };
}

// 价格快照标注：wm 挂掉时用陈旧表照常算，但必须告知用户（硬规则：不冒充实时）
const staleLine = (staleAt) => {
  if (!staleAt) return null;
  const time = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(staleAt));
  return `⚠ warframe.market 暂不可用，价格为 ${time} 离线快照`;
};

// 文字兜底（卡片渲染失败时用）
export function formatRefineRecommend(data) {
  if (!data.ok) {
    if (data.error === 'no_local_relic_db') return '本地遗物数据表读取失败，请确认 AlecaFrame 数据完整。';
    return '本地没有遗物库存记录。';
  }
  const lines = [`🔮 精炼推荐 · ${data.squad > 1 ? `${data.squad} 人组队` : '单人'}口径（光辉 vs 完整的期望增益，每 100 光体）`];
  const stale = staleLine(data.priceStaleAt);
  if (stale) lines.push(stale);
  data.rows.forEach((row, index) => {
    const gain = data.mode === 'ducat' ? `${row.suggest.gainDucats} 杜` : `${row.suggest.gainPlat}p`;
    lines.push(`${index + 1}. ${row.zh} ×${row.count}｜${vaultStatusZh(row.vaulted)}｜建议${row.suggest.zh}｜增益 +${gain}｜稀有奖 ${row.topRare?.zhName || '—'}`);
  });
  const dist = data.distribution;
  lines.push(`全库 ${data.totalOwned} 种：建议光辉 ${dist?.radiant ?? '?'} · 无瑕 ${dist?.flawless ?? '?'} · 不精炼 ${dist?.intact ?? '?'}；发「精炼推荐 单人」换单人口径。`);
  if (data.examples?.flawless?.length) lines.push(`无瑕档代表：${data.examples.flawless.join('、')}`);
  if (data.examples?.intact?.length) lines.push(`不精炼代表：${data.examples.intact.join('、')}（直接开）`);
  return lines.join('\n');
}

// 文字兜底（卡片渲染失败时用）
export function formatRecommend(data) {
  if (!data.ok) {
    if (data.error === 'no_local_relic_db') return '本地遗物数据表读取失败，请确认 AlecaFrame 数据完整。';
    if (data.error === 'no_relics_for_vault_filter') {
      return data.vaultFilter === 'vaulted'
        ? '你的库存中没有“已入库”遗物，无法按该条件推荐裂缝。'
        : '你的库存中没有“未入库”遗物，无法按该条件推荐裂缝。';
    }
    if (data.error === 'market_route_better') return `按「${data.ducatGoal?.name || '目标商品'}」当前行情，你库存中的遗物没有能以更低白金机会成本补杜卡德的候选；直接卖部件或从市场购买更合适。`;
    return '当前没有能配上你库存遗物的裂缝（或裂缝列表为空）。';
  }
  const ducatMode = data.mode === 'ducat';
  const squadZh = (data.squad ?? 4) > 1 ? `${data.squad ?? 4}人组队` : '单人';
  const preferenceZh = FISSURE_PREFERENCES[data.preference]?.zh || FISSURE_PREFERENCES.balanced.zh;
  const vaultFilterZh = RELIC_VAULT_FILTERS[data.vaultFilter]?.zh || RELIC_VAULT_FILTERS.all.zh;
  const modeZh = ducatMode ? (data.ducatGoal ? `奸商对标：${data.ducatGoal.name}` : '赚杜卡德') : '赚白金';
  const lines = [`🎯 开遗物 · ${modeZh} · ${preferenceZh} · ${vaultFilterZh} · ${squadZh}口径（库存 × 双币期望）`];
  if (data.ducatGoal) lines.push(`目标 ${data.ducatGoal.ducats} 杜 / 市场 ${data.ducatGoal.marketPlat}p｜盈亏线 1p≈${data.ducatGoal.ducatsPerPlat} 杜｜${data.ducatGoal.marketBasis === 'today' ? '今日中位' : '90天中位'}｜日均 ${data.ducatGoal.dailyVolume ?? '—'} 件`);
  lines.push(`可立即开 ${data.matchedRelicCount ?? 0} 种遗物；每种最多列两条当前路线。`);
  const stale = staleLine(data.priceStaleAt);
  if (stale) lines.push(stale);
  data.rows.forEach((row, index) => {
    const flags = [row.hard ? '钢铁' : '', row.storm ? '九重天' : '', ...(row.tags || []).map((tag) => tag.zh)].filter(Boolean).join('/');
    lines.push(`${index + 1}. ${row.relic.zh} ×${row.relic.count}｜${vaultStatusZh(row.relic.vaulted)}`);
    lines.push(`   路线 ${row.tierZh}${row.missionZh} ${row.planet}·${row.node}${flags ? `（${flags}）` : ''}`);
    const refineNote = row.refineZh ? `｜建议${row.refineZh}` : '';
    lines.push(ducatMode
      ? data.ducatGoal
        ? `   预计省 ${row.targetEconomy?.expectedSaving || 0}p｜可兑 ${row.targetEconomy?.expectedDucats || 0} 杜 / 放弃 ${row.targetEconomy?.expectedPlat || 0}p｜转换概率 ${row.targetEconomy?.conversionChance || 0}%${refineNote}`
        : `   重点奖励 ${row.topDucat?.zhName || '—'} ${row.topDucat?.ducats || 0} 杜卡德｜期望 ${row.expectedDucats} 杜卡德 / ${row.expectedValue} 白金${refineNote}`
      : `   重点奖励 ${row.topReward?.zhName || '—'} ${row.topReward?.price || 0} 白金｜期望 ${row.expectedValue} 白金 / ${row.expectedDucats} 杜卡德${refineNote}`);
  });
  if (data.requiem) lines.push(`另有安魂裂缝 ${data.requiem.fissures} 条，你有安魂遗物 ${data.requiem.relics} 个。`);
  const preferenceNote = data.preference === 'speed' ? '每枚遗物优先匹配捕获/歼灭' : data.preference === 'comfort' ? '每枚遗物优先匹配防御/生存' : data.preference === 'yield' ? '每枚遗物优先匹配九重天→钢铁→无尽' : '遗物按期望收益排序，每枚最多两条路线';
  lines.push(`${preferenceNote}；${ducatMode ? (data.ducatGoal ? '按目标商品动态盈亏线逐次开奖选择，不读取实时奖励' : '普通模式按毛杜卡德期望排序，不扣白金') : `期望按完整精炼度·${squadZh}开奖取最优·可靠成交中位估算`}，仅供参考。`);
  return lines.join('\n');
}
