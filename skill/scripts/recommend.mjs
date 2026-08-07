#!/usr/bin/env node

// 裂缝推荐：库存交集 → 双币期望 → 可选任务偏好，零 AI 判断。
// 知识依据见 references/game-knowledge.md：全能裂缝可开除安魂外任意遗物，绝不按「无对应遗物」过滤。
// 估值数据源（学 AlecaFrame 双指标思路）：
//   奖励表+概率 = 本地 Relics.json（离线）；白金均价+杜卡德 = market /v1/tools/ducats 整表（1 请求，缓存 1h）
//   → 库存遗物全量估值，不做候选裁剪（曾按囤量 top4 取候选，把量少但值钱的遗物漏掉了）
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ITEMS_BASE = 'https://api.warframestat.us';
const MARKET_BASE = 'https://api.warframe.market';
const TIMEOUT_MS = 20_000;
const TOP_RESULTS = 8;
const MIN_REMAIN_MS = 5 * 60 * 1000; // 快过期的裂缝不推
const CACHE_TTL_MS = 60 * 60 * 1000;
// 杜卡德模式的白金机会成本：市场上 1p ≈ 10~15 杜卡德，取保守值 10——
// 白金期望高的遗物拿去换杜卡德 = 亏，按此汇率扣分沉底
const DUCAT_PER_PLAT_OPPORTUNITY = 10;

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

export function parseFissurePreference(value) {
  const text = String(value || '').normalize('NFKC');
  if (/速刷|快速|快开|效率/iu.test(text)) return 'speed';
  if (/舒适|轻松|挂机/iu.test(text)) return 'comfort';
  if (/收益|额外|长线/iu.test(text)) return 'yield';
  return 'balanced';
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

// —— 价格整表：slug → { p: 加权均价, d: 杜卡德, zh: 中文名 }（2 请求，持久双层缓存 1h；wm 挂掉退陈旧快照） ——
// 附带 __meta 键（非 slug 命名空间不冲突）：{stale, cachedAt}，调用方据此标注「离线快照」
export async function loadPriceTable() {
  const { staleCachedJson } = await import('./wfdata.mjs');
  const result = await staleCachedJson('market-price-table', { ttlMs: CACHE_TTL_MS, version: 3 }, async () => {
    const [items, ducats] = await Promise.all([
      getJson(`${MARKET_BASE}/v2/items`, { Platform: 'pc', Crossplay: 'true', Language: 'zh-hans' }),
      getJson(`${MARKET_BASE}/v1/tools/ducats`),
    ]);
    const byId = new Map((items.data || []).map((item) => [item.id, { slug: item.slug, zh: item.i18n?.['zh-hans']?.name || null }]));
    const payload = ducats?.payload || {};
    const rows = payload.previous_hour?.length ? payload.previous_hour : (payload.previous_day || []);
    const prices = {};
    for (const row of rows) {
      const meta = byId.get(row.item);
      if (!meta) continue;
      prices[meta.slug] = { p: Number(row.wa_price) || 0, d: Number(row.ducats) || 0, zh: meta.zh };
    }
    if (!Object.keys(prices).length) throw new Error('价格整表为空');
    return prices;
  });
  return { ...result.data, __meta: { stale: result.stale, cachedAt: result.cachedAt } };
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
    if (reward.chance <= 3 && (!top || price > (top.price || 0))) top = { name: reward.name, zhName, price: Math.round(price * 10) / 10 };
    if (!topDucat || ducats > (topDucat.ducats || 0)) topDucat = { name: reward.name, zhName, ducats };
  }
  return { expected: Math.round(expected * 10) / 10, expectedDucats: Math.round(expectedDucats), top, topDucat };
}

const relicEra = (baseName) => String(baseName).split(' ')[0];
const relicZh = (baseName) => {
  const [era, code] = String(baseName).split(' ');
  return `${ERA_ZH[era] || era} ${code || ''}`.trim();
};

function splitNode(value) {
  const match = String(value || '').match(/^(.*?)\s*\(([^)]+)\)\s*$/u);
  if (!match) return { node: String(value || '未知节点'), planet: '未知星区' };
  return { node: match[1], planet: PLANET_ZH[match[2]] || match[2] };
}

// relics: alecaframe loadRelics 的输出；options.mode: 'plat'（默认）| 'ducat'；options.squad: 4（默认组队）| 1（单人）；options.preference: balanced|speed|comfort|yield
export async function recommendFissures(relics, options = {}) {
  const mode = options.mode === 'ducat' ? 'ducat' : 'plat';
  const squad = Number(options.squad) >= 1 ? Math.min(Number(options.squad), 4) : 4;
  const preference = FISSURE_PREFERENCES[options.preference] ? options.preference : parseFissurePreference(options.preference);
  const now = Date.now();

  // 1) 库存按遗物合并精炼度——全量进入估值，不做候选裁剪
  const byBase = new Map();
  for (const item of relics) {
    const entry = byBase.get(item.baseName) || { base: item.baseName, era: relicEra(item.baseName), count: 0, refinements: new Set() };
    entry.count += item.count;
    if (item.refinement) entry.refinements.add(item.refinement);
    byBase.set(item.baseName, entry);
  }
  const owned = [...byBase.values()].filter((entry) => entry.count > 0);
  const requiemCount = owned.filter((entry) => entry.era === 'Requiem').reduce((sum, entry) => sum + entry.count, 0);

  // 2) 裂缝 + 奖励表 + 价格整表
  const worldState = options.worldState || await getJson(`${ITEMS_BASE}/pc`);
  const fissures = (Array.isArray(worldState.fissures) ? worldState.fissures : [])
    .filter((f) => !f.expired && Date.parse(f.expiry) - now > MIN_REMAIN_MS);
  if (!fissures.length) {
    return { ok: false, kind: 'fissure-recommend', mode, preference, error: 'no_fissures', fetchedAt: new Date().toISOString() };
  }
  let localDb = options.localDb ?? null;
  if (!localDb && options.alecaDir) {
    try { localDb = await loadLocalRelicDb(options.alecaDir); } catch { localDb = null; }
  }
  if (!localDb) {
    return { ok: false, kind: 'fissure-recommend', mode, preference, error: 'no_local_relic_db', fetchedAt: new Date().toISOString() };
  }
  const prices = options.prices || await loadPriceTable();
  const priceStaleAt = prices.__meta?.stale ? prices.__meta.cachedAt : null;

  // 3) 全量离线估值（组队口径）+ 精炼建议
  const priceOf = (reward) => (reward.slug ? prices[reward.slug] : null);
  const appraised = [];
  for (const entry of owned.filter((item) => item.era !== 'Requiem')) {
    const rewards = localDb.rewardsByBase.get(entry.base);
    if (!rewards) continue;
    const refine = appraiseRefinements(rewards, priceOf, { squad, mode });
    appraised.push({ ...entry, refinements: [...entry.refinements], ...appraiseOffline(rewards, prices, squad), refine });
  }

  // 4) 逐裂缝配最优遗物并打分；全能=全部候选参与（game-knowledge：全能可开除安魂外任意遗物）
  // 模式价值键：赚白金=白金期望；赚杜卡德=杜卡德期望扣白金机会成本（白金高的换杜卡德=亏）
  const valueOf = (entry) => mode === 'ducat'
    ? Math.max(0, (entry.expectedDucats || 0) - entry.expected * DUCAT_PER_PLAT_OPPORTUNITY)
    : entry.expected;
  const bestFor = (tier) => {
    const pool = tier === 'Omnia' ? appraised : appraised.filter((entry) => entry.era === tier);
    return [...pool].sort((a, b) => valueOf(b) - valueOf(a))[0] || null;
  };
  const rows = [];
  let requiemFissures = 0;
  for (const fissure of fissures) {
    if (fissure.tier === 'Requiem') { requiemFissures += 1; continue; }
    const relic = bestFor(fissure.tier);
    if (!relic) continue;
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
      relic: { base: relic.base, zh: relicZh(relic.base), count: relic.count, refinements: relic.refinements },
      topReward: relic.top,
      topDucat: relic.topDucat || null,
      expectedValue: relic.expected,
      expectedDucats: relic.expectedDucats || 0,
      refineZh: relic.refine?.suggest?.zh || null,
      refineReason: relic.refine?.suggest?.reason || null,
      valueScore: Math.round(valueOf(relic) * 10) / 10,
    };
    row.preferenceRank = preferenceRank(row, preference);
    row.balancedTieRank = balancedTieRank(row);
    rows.push(row);
  }
  rows.sort((a, b) => a.preferenceRank - b.preferenceRank
    || b.valueScore - a.valueScore
    || (preference === 'balanced' ? a.balancedTieRank - b.balancedTieRank : 0)
    || Date.parse(b.expiry) - Date.parse(a.expiry));

  return {
    ok: rows.length > 0,
    kind: 'fissure-recommend',
    mode,
    preference,
    squad,
    fetchedAt: new Date().toISOString(),
    priceStaleAt,
    rows: rows.slice(0, TOP_RESULTS),
    matchedCount: rows.length,
    totalFissures: fissures.length,
    appraisedCount: appraised.length,
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
  const prices = options.prices || await loadPriceTable();
  const priceStaleAt = prices.__meta?.stale ? prices.__meta.cachedAt : null;
  const priceOf = (reward) => (reward.slug ? prices[reward.slug] : null);

  // 库存合并（含安魂：安魂 Mod 可交易，精炼同样有效）
  const byBase = new Map();
  for (const item of relics) {
    const entry = byBase.get(item.baseName) || { base: item.baseName, count: 0 };
    entry.count += item.count;
    byBase.set(item.baseName, entry);
  }
  const rows = [];
  for (const entry of [...byBase.values()].filter((item) => item.count > 0)) {
    const rewards = localDb.rewardsByBase.get(entry.base);
    if (!rewards) continue;
    const { tiers, suggest } = appraiseRefinements(rewards, priceOf, { squad, mode });
    const topRare = rewards.filter((reward) => reward.chance <= 3)
      .map((reward) => ({ zhName: priceOf(reward)?.zh || reward.name, price: priceOf(reward)?.p || 0 }))
      .sort((a, b) => b.price - a.price)[0] || null;
    rows.push({
      base: entry.base,
      zh: relicZh(entry.base),
      count: entry.count,
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
  const examplesOf = (key) => rows.filter((row) => row.suggest.key === key).slice(0, 2).map((row) => row.zh);
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
    lines.push(`${index + 1}. ${row.zh} ×${row.count}｜建议${row.suggest.zh}｜增益 +${gain}｜稀有奖 ${row.topRare?.zhName || '—'}`);
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
    return '当前没有能配上你库存遗物的裂缝（或裂缝列表为空）。';
  }
  const ducatMode = data.mode === 'ducat';
  const squadZh = (data.squad ?? 4) > 1 ? `${data.squad ?? 4}人组队` : '单人';
  const preferenceZh = FISSURE_PREFERENCES[data.preference]?.zh || FISSURE_PREFERENCES.balanced.zh;
  const lines = [`🎯 裂缝推荐 · ${ducatMode ? '赚杜卡德' : '赚白金'} · ${preferenceZh} · ${squadZh}口径（库存 × 双币期望）`];
  const stale = staleLine(data.priceStaleAt);
  if (stale) lines.push(stale);
  data.rows.forEach((row, index) => {
    const flags = [row.hard ? '钢铁' : '', row.storm ? '九重天' : '', ...(row.tags || []).map((tag) => tag.zh)].filter(Boolean).join('/');
    lines.push(`${index + 1}. ${row.tierZh}${row.missionZh} ${row.planet}·${row.node}${flags ? `（${flags}）` : ''}`);
    const refineNote = row.refineZh ? `｜建议${row.refineZh}` : '';
    lines.push(ducatMode
      ? `   配 ${row.relic.zh} ×${row.relic.count}｜重点奖励 ${row.topDucat?.zhName || '—'} ${row.topDucat?.ducats || 0} 杜卡德｜期望 ${row.expectedDucats} 杜卡德 / ${row.expectedValue} 白金${refineNote}`
      : `   配 ${row.relic.zh} ×${row.relic.count}｜重点奖励 ${row.topReward?.zhName || '—'} ${row.topReward?.price || 0} 白金｜期望 ${row.expectedValue} 白金 / ${row.expectedDucats} 杜卡德${refineNote}`);
  });
  if (data.requiem) lines.push(`另有安魂裂缝 ${data.requiem.fissures} 条，你有安魂遗物 ${data.requiem.relics} 个。`);
  const preferenceNote = data.preference === 'speed' ? '速刷优先捕获/歼灭' : data.preference === 'comfort' ? '舒适优先防御/生存' : data.preference === 'yield' ? '收益优先九重天→钢铁→无尽' : '默认按遗物期望收益，同收益时速刷/舒适优先';
  lines.push(`${preferenceNote}；${ducatMode ? '杜卡德排序会扣除白金机会成本' : `期望按完整精炼度·${squadZh}开奖取最优·市场加权均价估算`}，仅供参考。`);
  return lines.join('\n');
}
