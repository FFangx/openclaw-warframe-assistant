#!/usr/bin/env node

// Deterministic Warframe short-command backend for OpenClaw/QQ.
// Read-only: it only queries public Warframe and Warframe.Market endpoints.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { buildFissureQueryCard, compressCardPng, currency, pruneOldCards, renderWarframeCard, RELIC_ICON_DATA } from './warframe-cards.mjs';
import { NEXT_ACTIONS_HEIGHT, renderNextActions } from './card-actions.mjs';
import { appraiseRefinements, classifyFissure } from './recommend.mjs';
import { buildRelicFarmPlan } from './relic-farm.mjs';
import { resilientJsonRequest } from './http-resilience.mjs';
import { readAlecaJson, stripDataUriReplacer } from './wfdata.mjs';
import { loadWorldState } from './worldstate-source.mjs';
import { buildHelpSections, getHelpSection, listHelpSections, matchCommandText, resolveHelpTopic } from './command-registry.mjs';
import { formatUserError, userError, userErrorFromDiagnostic } from './user-error-contract.mjs';
// 规范路由常量（R5 数据源合同）：Market 只读端点基址。
import { MARKET_BASE_URL } from './data-source-contract.mjs';

const execFileAsync = promisify(execFile);

const RELICS_DATA_URL = 'https://raw.githubusercontent.com/WFCD/warframe-items/master/data/json/Relics.json';
const MARKET_BASE = MARKET_BASE_URL;
const TIMEOUT_MS = 20_000;
const DEFAULT_PLATFORM = 'pc';
const DEFAULT_CROSSPLAY = true;

const FISSURE_MISSION_ZH = {
  Extermination: '歼灭', Capture: '捕获', Sabotage: '破坏', Rescue: '救援', Spy: '间谍',
  Defense: '防御', 'Mobile Defense': '移动防御', Interception: '拦截', Survival: '生存',
  Excavation: '挖掘', Disruption: '中断', 'Void Cascade': '虚空覆涌', 'Void Flood': '虚空洪流',
  'Void Armageddon': '虚空决战', Orphix: '奥菲克斯', Assault: '强袭', Defection: '叛逃',
  'Infested Salvage': '疫变回收', Volatile: '反应堆破坏', Alchemy: '炼金术', Crossfire: '歼灭',
  Skirmish: '前哨战',
};
const FISSURE_FACTION_ZH = {
  Grineer: 'Grineer', Corpus: 'Corpus', Infested: 'Infested', Orokin: '奥罗金', Corrupted: '堕落者',
  Sentient: 'Sentient', Murmur: '低语者', 'The Murmur': '低语者', Crossfire: '混战', Tenno: 'Tenno',
};
const PLANET_ZH = {
  Mercury: '水星', Venus: '金星', Earth: '地球', Lua: '月球', Mars: '火星', Deimos: '火卫二',
  Phobos: '火卫一', Ceres: '谷神星', Jupiter: '木星', Europa: '欧罗巴', Saturn: '土星',
  Uranus: '天王星', Neptune: '海王星', Pluto: '冥王星', Eris: '阋神星', Sedna: '赛德娜',
  Void: '虚空', Zariman: '扎里曼', 'Kuva Fortress': '赤毒要塞', Duviri: '双衍王境',
  'Earth Proxima': '地球比邻星', 'Venus Proxima': '金星比邻星', 'Saturn Proxima': '土星比邻星',
  'Neptune Proxima': '海王星比邻星', 'Pluto Proxima': '冥王星比邻星', 'Veil Proxima': '面纱比邻星', Veil: '面纱比邻星',
};
const ERA_ALIASES = [
  ['requiem', 'Requiem'], ['安魂', 'Requiem'],
  ['omnia', 'Omnia'], ['全能', 'Omnia'],
  ['lith', 'Lith'], ['古纪', 'Lith'], ['古', 'Lith'],
  ['meso', 'Meso'], ['前纪', 'Meso'], ['前', 'Meso'],
  ['neo', 'Neo'], ['中纪', 'Neo'], ['中', 'Neo'],
  ['axi', 'Axi'], ['后纪', 'Axi'], ['后', 'Axi'],
];

const ERA_ZH = {
  Lith: '古纪', Meso: '前纪', Neo: '中纪', Axi: '后纪',
  Requiem: '安魂', Omnia: '全能', Vanguard: '先锋',
};

const NON_MARKET_REWARD_ZH = {
  'Forma Blueprint': 'Forma 蓝图',
  '2X Forma Blueprint': '2 个 Forma 蓝图',
};

function localizeRelicRewardName(value) {
  const raw = String(value || '').trim();
  if (NON_MARKET_REWARD_ZH[raw]) return NON_MARKET_REWARD_ZH[raw];
  const forma = raw.match(/^(\d+)X\s+Forma Blueprint$/iu);
  if (forma) return `${forma[1]} 个 Forma 蓝图`;
  return /[A-Za-z]{2,}/u.test(raw) ? '未收录奖励' : (raw || '未知奖励');
}

// 别名依据灰机 wiki「游戏用语」页逐条核对（2026-08-04），子串替换按长度降序执行；
// 勿加会误伤真实物品名前缀的泛词（如「双子」会撞双子系武器、「夜灵」已知风险保留现状）
const ITEM_ALIASES = {
  // —— 战甲 ——
  悟空: 'wukong', 猴子: 'wukong', 猴哥: 'wukong', 吗喽: 'wukong',
  奶妈: 'trinity', 三位一体: 'trinity',
  电男: 'volt', 伏特: 'volt', 冰男: 'frost', 冰队: 'frost',
  火女: 'ember', 火鸡: 'ember',
  毒妈: 'saryn', 牛牛: 'rhino', 牛甲: 'rhino', 犀牛: 'rhino',
  女枪: 'mesa', 高斯: 'gauss', 跑男: 'gauss',
  夜灵甲: 'revenant', 夜灵: 'revenant', 血妈: 'garuda',
  猫甲: 'khora', 蜘蛛甲: 'khora', 玻璃甲: 'gara', 玻璃: 'gara', 龙甲: 'chroma',
  磁力: 'mag', 磁妹: 'mag', 马哥: 'mag',
  圣剑: 'excalibur', 咖喱棒: 'excalibur', 咖喱: 'excalibur',
  洛基: 'loki', 弱鸡: 'loki', 摸尸: 'nekros', 尸体: 'nekros',
  水男: 'hydroid', 鸟姐: 'zephyr',
  蛋男: 'limbo', 李明博: 'limbo', 小明: 'limbo', 小丑: 'mirage',
  妮瓦: 'nova', 诺娃: 'nova',
  母牛: 'hildryn', 妈甲: 'hildryn',
  音甲: 'octavia', DJ甲: 'octavia', 音乐甲: 'octavia',
  音妈: 'banshee', 女妖: 'banshee',
  瓦喵: 'valkyr', 瓦尔基里: 'valkyr', 女武神: 'valkyr', 女汉子: 'valkyr',
  蛆甲: 'nidus', 蛆: 'nidus', 感染甲: 'nidus',
  哪吒三太子: 'nezha', 哪吒: 'nezha', 沙甲: 'inaros',
  妖精: 'titania', 蝴蝶: 'titania', 蝶妹: 'titania', 蝶甲: 'titania',
  工程甲: 'vauban', 工程: 'vauban', 剑圣: 'ash', 阿屎: 'ash',
  龙王: 'oberon', 驴王: 'oberon', 奶爸: 'oberon',
  扶她: 'equinox', 阴阳甲: 'equinox',
  肥宅: 'grendel', 弓妹: 'ivara',
  鬼甲: 'sevagoth', 幽灵甲: 'sevagoth', 鲨鱼辣椒: 'sevagoth',
  狼妹: 'voruna', 狼甲: 'voruna', 狼母: 'voruna',
  花甲: 'wisp', 花妈: 'wisp', 花女: 'wisp', 花姐: 'wisp',
  茶妹: 'protea', 普洱茶: 'protea', 电妹: 'gyre',
  刀哥: 'kullervo', 刀甲: 'kullervo', 但丁: 'dante', 捷德: 'jade',
  扣妹: 'koumei', 骰妹: 'koumei', 马娘: 'dagath', 赛马娘: 'dagath',
  和尚: 'baruuk', 武僧: 'baruuk',
  石甲: 'atlas', 石男: 'atlas', 土甲: 'atlas', 一拳超人: 'atlas', 一拳: 'atlas',
  水妹: 'yareli', 鸭梨: 'yareli',
  蛇甲: 'lavos', 炼金: 'lavos', 药水哥: 'lavos',
  斯巴达: 'styanax', 水晶甲: 'citrine', 主教: 'harrow',
  脑溢血: 'nyx', 卡利班: 'caliban', 老九: 'cyte-09',
  // —— 武器 ——
  战刃: 'glaive', 盘子: 'glaive', 毒盘子: 'cerata', 大剑p: 'galatine prime', 鱼骨: 'boltor',
  异融西诺斯: 'mutalist cernos', 赤毒布拉玛: 'kuva bramma',
  // —— 赋能 ——
  充沛: 'arcane energize', 充沛赋能: 'arcane energize', 速攻: 'arcane strike',
};

const COMPONENT_ALIASES = [
  [/头部神经光元|神经光元|头部|头盔|头$/gu, ' neuroptics blueprint'],
  [/机体/gu, ' chassis blueprint'],
  [/系统/gu, ' systems blueprint'],
  [/枪机/gu, ' receiver'],
  [/枪托/gu, ' stock'],
  [/握柄|手柄/gu, ' handle'],
  [/刀刃/gu, ' blade'],
  [/蓝图/gu, ' blueprint'],
];

const out = (value) => process.stdout.write(`${JSON.stringify(value, stripDataUriReplacer, 2)}\n`);

function normalizeUnicode(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

function compact(value) {
  return normalizeUnicode(value).toLowerCase().replace(/[\s_\-:：·•]+/gu, '');
}

function expandItemQuery(value) {
  let expanded = normalizeUnicode(value).toLowerCase();
  for (const [alias, canonical] of Object.entries(ITEM_ALIASES).sort((a, b) => b[0].length - a[0].length)) {
    expanded = expanded.split(alias).join(canonical);
  }
  expanded = expanded.replace(/一套|套装/gu, ' set');
  expanded = expanded.replace(/([\p{L}\p{N}])p(?=$|[\u4e00-\u9fff])/giu, '$1 prime ');
  // 独立词 p（「zephyr p」「战刃 p」）：紧贴式正则接不住空格分隔的 p，曾致精确匹配失效掉进模糊垃圾堆
  expanded = expanded.replace(/(^|\s)p(?=\s|$)/giu, '$1prime');
  for (const [pattern, replacement] of COMPONENT_ALIASES) {
    expanded = expanded.replace(pattern, replacement);
  }
  return normalizeUnicode(expanded);
}

// 仅供别名全量验证脚本使用
export { ITEM_ALIASES, expandItemQuery, fetchMarketItems, queryMarket, resolveMarketItem };

function parseMarketRankQuery(value) {
  let itemQuery = normalizeUnicode(value);
  let rankMode = null;
  let requestedRank = null;

  const maxRankPattern = /(?:满\s*(?:级|阶|rank|r)|max(?:\s*rank)?)/giu;
  if (maxRankPattern.test(itemQuery)) {
    rankMode = 'max';
    itemQuery = itemQuery.replace(maxRankPattern, ' ');
  } else {
    const prefixed = itemQuery.match(/(?:^|\s)(?:等级|rank|r)\s*[:：]?\s*(\d+)\s*(?:级|阶)?(?=\s|$)/iu);
    const suffixed = itemQuery.match(/(?:^|\s)(\d+)\s*(?:级|阶)(?=\s|$)/iu);
    const attached = itemQuery.match(/(?:等级\s*[:：]?\s*(\d+)|(\d+)\s*(?:级|阶))\s*$/iu);
    const match = prefixed || suffixed || attached;
    if (match) {
      rankMode = 'exact';
      requestedRank = Number(match[1] ?? match[2]);
      itemQuery = `${itemQuery.slice(0, match.index)} ${itemQuery.slice((match.index || 0) + match[0].length)}`;
    }
  }

  return { itemQuery: normalizeUnicode(itemQuery), rankMode, requestedRank };
}

function triangularRankCopies(rank) {
  return ((rank + 1) * (rank + 2)) / 2;
}

function tradingTaxForRank(detail, rank) {
  const tradingTax = Number(detail.tradingTax);
  if (!Number.isFinite(tradingTax)) return detail.tradingTax ?? null;
  const tags = new Set(detail.tags || []);
  const maxRank = Number(detail.maxRank);
  if (rank == null || !Number.isInteger(maxRank) || maxRank <= 0
    || !tags.has('arcane_enhancement') || !tags.has('legendary')) {
    return tradingTax;
  }
  const baseTax = tradingTax / triangularRankCopies(maxRank);
  return Math.round(baseTax * triangularRankCopies(rank));
}

// Market URL → 端点健康键（与 data-source-contract.mjs 的 market-readonly 端点注册表
// 一一对应，合同测试核对真实映射；主机不符返回 null 走裸 fetch）。
export function marketEndpoint(url) {
  const parsed = new URL(url);
  if (parsed.hostname !== 'api.warframe.market') return null;
  const pathname = parsed.pathname;
  if (pathname === '/v2/items') return 'market:v2:catalog';
  if (pathname.includes('/orders/item/')) return 'market:v2:orders';
  if (pathname.startsWith('/v2/item/')) return 'market:v2:detail';
  if (pathname.endsWith('/statistics')) return 'market:v1:statistics';
  return 'market:other';
}

async function getJson(url, headers = {}) {
  const endpoint = marketEndpoint(url);
  if (!endpoint) {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
    return response.json();
  }
  return resilientJsonRequest(url, {
    endpoint, headers,
    // Two bounded attempts stay below the former single 20-second wait and the QQ tool budget.
    timeoutMs: 8_000, maxAttempts: 2, failureThreshold: 2,
  });
}

async function mapLimit(values, limit, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return results;
}

function marketHeaders(platform = DEFAULT_PLATFORM, crossplay = DEFAULT_CROSSPLAY) {
  return { Platform: platform, Crossplay: String(crossplay), Language: 'zh-hans' };
}

async function fetchMarketItems(platform, crossplay) {
  // 目录双层缓存：新鲜 1h；wm 挂掉退陈旧快照（名字不随时变，静默降级即可）
  // version 2：加 id 字段（套装 setParts 是 wm id，要拿目录反查 slug），旧缓存无此字段必须打散
  const { staleCachedJson } = await import('./wfdata.mjs');
  const result = await staleCachedJson(`market-items-${platform}-${crossplay}`, { ttlMs: 60 * 60 * 1000, version: 2 }, async () => {
    const response = await getJson(`${MARKET_BASE}/v2/items`, marketHeaders(platform, crossplay));
    const items = (response.data || []).map((item) => ({
      id: item.id,
      slug: item.slug,
      name: item.i18n?.en?.name || item.slug,
      zhName: item.i18n?.['zh-hans']?.name || null,
      tags: item.tags || [],
    }));
    if (!items.length) throw new Error('wm 目录为空');
    return items;
  });
  return result.data;
}

function itemSearchFields(item) {
  return [compact(item.slug), compact(item.name), compact(item.zhName || '')].filter(Boolean);
}

function dedupeItems(items) {
  return [...new Map(items.map((item) => [item.slug, item])).values()];
}

function damerauLevenshtein(left, right) {
  const a = [...left];
  const b = [...right];
  const matrix = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        matrix[i][j] = Math.min(matrix[i][j], matrix[i - 2][j - 2] + 1);
      }
    }
  }
  return matrix[a.length][b.length];
}

function typoThreshold(length) {
  if (length <= 1) return 0;
  if (length <= 4) return 1;
  if (length <= 9) return 2;
  return Math.min(4, Math.floor(length * 0.2));
}

function fuzzyAliasExpansion(rawQuery) {
  const normalized = normalizeUnicode(rawQuery).toLowerCase();
  const componentMatch = normalized.match(/(头部神经光元|神经光元|头部|头盔|头|机体|系统|枪机|枪托|握柄|手柄|刀刃|蓝图)$/u);
  const component = componentMatch?.[1] || '';
  const prime = /(?:prime|p)(?=$|头|机体|系统|蓝图|枪机|枪托|握柄|手柄|刀刃)/iu.test(normalized);
  const set = /一套|套装|set/iu.test(normalized);
  const base = compact(normalized
    .replace(/prime|一套|套装|set/giu, '')
    .replace(/p(?=$|头|机体|系统|蓝图|枪机|枪托|握柄|手柄|刀刃)/giu, '')
    .replace(component, ''));
  if (!base) return null;

  const ranked = Object.entries(ITEM_ALIASES)
    .map(([alias, canonical]) => ({ alias, canonical, distance: damerauLevenshtein(base, compact(alias)) }))
    .sort((a, b) => a.distance - b.distance || b.alias.length - a.alias.length);
  const best = ranked[0];
  if (!best || best.distance > typoThreshold(Math.max(base.length, [...best.alias].length))) return null;
  if (ranked[1] && ranked[1].distance === best.distance && ranked[1].canonical !== best.canonical) return null;
  return `${best.canonical}${prime ? ' prime' : ''}${set ? ' set' : ''}${component ? ` ${component}` : ''}`;
}

function resolveMarketItem(items, rawQuery, allowFuzzy = true) {
  const expanded = expandItemQuery(rawQuery);
  const q = compact(expanded);
  const explicitComponent = /(neuroptics|chassis|systems|blueprint|receiver|stock|handle|blade)/i.test(expanded);
  const primeQuery = q.includes('prime');

  if (primeQuery && !explicitComponent && !q.endsWith('set')) {
    const base = q.replace(/prime$/u, '').replace(/set$/u, '');
    const preferredSlug = `${base}_prime_set`;
    const preferred = items.find((item) => item.slug === preferredSlug);
    if (preferred) return { match: preferred, candidates: [], expanded };
  }

  const exact = dedupeItems(items.filter((item) => itemSearchFields(item).includes(q)));
  if (exact.length === 1) return { match: exact[0], candidates: [], expanded };
  if (exact.length > 1) return { match: null, candidates: exact.slice(0, 8), expanded };

  // 原样中文精确通道：「一套」→「set」替换后中英混合串对不上 wm 中文名
  // （实例：「虚空锐将 一套」→「虚空锐将set」≠「虚空锐将一套」，精确命中失效掉进消歧列表）
  const rawCompact = compact(rawQuery);
  if (rawCompact && rawCompact !== q) {
    const rawExact = dedupeItems(items.filter((item) => itemSearchFields(item).includes(rawCompact)));
    if (rawExact.length === 1) return { match: rawExact[0], candidates: [], expanded };
  }

  const candidates = dedupeItems(items.filter((item) =>
    itemSearchFields(item).some((field) => field.includes(q) || q.includes(field)),
  ));

  if (primeQuery && !explicitComponent) {
    const sets = candidates.filter((item) => item.slug.endsWith('_prime_set'));
    if (sets.length === 1) return { match: sets[0], candidates: [], expanded };
  }
  if (candidates.length === 1) return { match: candidates[0], candidates: [], expanded };
  // 包含匹配有真实候选时直接列它们；曾被下方 fuzzy 距离排序覆盖成 8 个不相干的短词
  if (candidates.length > 1) return { match: null, candidates: candidates.slice(0, 8), expanded };

  // 「赋能」是类别词不是名字（官方名「主要·死首」）；直查全空后剥掉再试一轮。
  // 先直查后剥离：「赋能·充沛」这类官方名自带「赋能」，上来就剥会误伤
  if (/赋能/u.test(rawQuery)) {
    const stripped = normalizeUnicode(String(rawQuery).replace(/赋能/gu, ' '));
    if (compact(stripped) && compact(stripped) !== q) {
      const retried = resolveMarketItem(items, stripped, false);
      if (retried.match || retried.candidates.length) return retried;
    }
  }

  if (allowFuzzy) {
    const aliasCorrected = fuzzyAliasExpansion(rawQuery);
    if (aliasCorrected && compact(aliasCorrected) !== q) {
      const corrected = resolveMarketItem(items, aliasCorrected, false);
      if (corrected.match) return { ...corrected, correctedFrom: rawQuery, correctedTo: aliasCorrected };
    }

    const ranked = items.map((item) => {
      const distance = Math.min(...itemSearchFields(item).map((field) => damerauLevenshtein(q, field)));
      return { item, distance };
    }).sort((a, b) => a.distance - b.distance || a.item.slug.localeCompare(b.item.slug));
    const best = ranked[0];
    const second = ranked[1];
    if (best && best.distance <= typoThreshold(Math.max(q.length, compact(best.item.slug).length))
      && (!second || second.distance > best.distance)) {
      return { match: best.item, candidates: [], expanded, correctedFrom: rawQuery, correctedTo: best.item.name };
    }
    // 垃圾门：best 都超出容错阈值说明根本不像，列出来只会误导（实例：zephyrp 撞出 shepherd/khra）
    if (best && best.distance <= typoThreshold(q.length) + 1) {
      const fuzzyCandidates = ranked
        .filter((entry) => entry.distance <= best.distance + 1)
        .slice(0, 8)
        .map((entry) => entry.item);
      if (fuzzyCandidates.length) return { match: null, candidates: fuzzyCandidates, expanded };
    }
  }

  return { match: null, candidates: candidates.slice(0, 8), expanded };
}

// ⚠ wm /top 的列表不按价格排序（实测 9,11,2,12,2），必须自己排；sell 升序=最低卖价先行，buy 降序=最高收价先行
function pickOrders(orders, direction = 'sell') {
  return (orders || []).filter((order) => order.visible !== false)
    .toSorted((a, b) => (direction === 'buy' ? Number(b.platinum) - Number(a.platinum) : Number(a.platinum) - Number(b.platinum)))
    .slice(0, 5).map((order) => ({
    id: order.id,
    platinum: Number(order.platinum),
    quantity: Number(order.quantity),
    perTrade: order.perTrade == null ? null : Number(order.perTrade),
    rank: order.rank == null ? null : Number(order.rank),
    user: order.user?.ingameName || '未知玩家',
    reputation: order.user?.reputation ?? null,
    status: order.user?.status || 'unknown',
    platform: order.user?.platform || null,
    crossplay: order.user?.crossplay ?? null,
    locale: order.user?.locale || null,
    updatedAt: order.updatedAt || null,
  }));
}

async function queryMarket(rawQuery, platform = DEFAULT_PLATFORM, crossplay = DEFAULT_CROSSPLAY) {
  const rankQuery = parseMarketRankQuery(rawQuery);
  // Excalibur 全系列不可交易（Prime 创始人独占，Umbra 剧情获取），不直判会被模糊匹配撞到 Caliban
  if (/excalibur/iu.test(expandItemQuery(rankQuery.itemQuery))) {
    return {
      ok: false,
      kind: 'market',
      error: 'untradable',
      query: rawQuery,
      item: { zhName: 'Excalibur' },
      fetchedAt: new Date().toISOString(),
    };
  }
  const items = await fetchMarketItems(platform, crossplay);
  const resolved = resolveMarketItem(items, rankQuery.itemQuery);
  if (!resolved.match) {
    return {
      ok: false,
      kind: 'market',
      error: resolved.candidates.length ? 'ambiguous' : 'not_found',
      query: rawQuery,
      candidates: resolved.candidates.map((item) => ({ slug: item.slug, name: item.name, zhName: item.zhName })),
      fetchedAt: new Date().toISOString(),
    };
  }

  const headers = marketHeaders(platform, crossplay);
  // 详情/卖单/统计都在 wm 上：整段包兜底——挂掉时降级为「价格记忆 + 加权均价快照」的诚实离线回答
  // ⚠ wm 半死状态会 200 + 坏 body，getJson 返回 null 而不抛错——null 必须与异常同样进离线路径
  const offlineResult = async (upstreamError = null) => {
    const { recallPrice, readCachedData } = await import('./wfdata.mjs');
    const wanted = rankQuery.rankMode === 'max' ? 'max' : rankQuery.rankMode === 'exact' ? rankQuery.requestedRank : null;
    // 离线不知道 maxRank：满级查询无法换算具体等级，只回放 0 级/无等级记忆
    const memory = wanted === 'max' ? null
      : (await recallPrice(resolved.match.slug, wanted ?? '-')) || (await recallPrice(resolved.match.slug, 0));
    const table = await readCachedData('market-price-table', 3);
    const wa = table?.data?.[resolved.match.slug] || null;
    // 复用 EndpointRequestError.diagnostic 的脱敏诊断：把 404/403/429/超时/熔断安全映射到用户错误合同。
    const userError = userErrorFromDiagnostic(upstreamError?.diagnostic, {
      fallbackUsed: Boolean(memory || wa),
      nextSteps: ['wm <物品>（稍后再试）', '帮助 查价'],
    });
    return {
      ok: false,
      kind: 'market',
      error: 'market_down',
      query: rawQuery,
      item: { slug: resolved.match.slug, zhName: resolved.match.zhName || resolved.match.name },
      lastKnown: memory ? { platinum: memory.platinum, at: memory.at } : null,
      snapshot: wa ? { waPrice: wa.p, ducats: wa.d, at: table.cachedAt } : null,
      upstream: upstreamError?.diagnostic || null,
      userError,
      fetchedAt: new Date().toISOString(),
    };
  };
  let detail = null;
  let detailError = null;
  try {
    detail = (await getJson(`${MARKET_BASE}/v2/item/${resolved.match.slug}`, headers))?.data || null;
  } catch (error) { detail = null; detailError = error; }
  if (!detail) return offlineResult(detailError);
  const maxRank = Number.isInteger(Number(detail.maxRank)) && Number(detail.maxRank) > 0
    ? Number(detail.maxRank) : null;
  let selectedRank = null;
  if (rankQuery.rankMode && maxRank == null) {
    return {
      ok: false,
      kind: 'market',
      error: 'rank_not_supported',
      query: rawQuery,
      item: { zhName: detail.i18n?.['zh-hans']?.name || resolved.match.zhName || resolved.match.name },
      fetchedAt: new Date().toISOString(),
    };
  }
  if (maxRank != null) {
    selectedRank = rankQuery.rankMode === 'max' ? maxRank
      : rankQuery.rankMode === 'exact' ? rankQuery.requestedRank : 0;
    if (!Number.isInteger(selectedRank) || selectedRank < 0 || selectedRank > maxRank) {
      return {
        ok: false,
        kind: 'market',
        error: 'rank_out_of_range',
        query: rawQuery,
        requestedRank: selectedRank,
        maxRank,
        item: { zhName: detail.i18n?.['zh-hans']?.name || resolved.match.zhName || resolved.match.name },
        fetchedAt: new Date().toISOString(),
      };
    }
  }
  const rankParam = selectedRank == null ? '' : `?rank=${encodeURIComponent(selectedRank)}`;
  let ordersResponse = null;
  let ordersError = null;
  try {
    ordersResponse = await getJson(`${MARKET_BASE}/v2/orders/item/${resolved.match.slug}/top${rankParam}`, headers);
  } catch (error) { ordersResponse = null; ordersError = error; }
  if (!ordersResponse?.data) return offlineResult(ordersError);
  const sell = pickOrders(ordersResponse.data?.sell);
  const buy = pickOrders(ordersResponse.data?.buy, 'buy');
  // 价格记忆：成功查价顺手记最低卖单，wm 挂掉时可回放（失败静默）
  if (sell[0]?.platinum != null) {
    const { rememberPrice } = await import('./wfdata.mjs');
    await rememberPrice(resolved.match.slug, selectedRank ?? '-', sell[0].platinum);
  }

  // 90 天真实成交统计（网站图表同源）：中位价/日均成交量/当前卖价偏离；按查询等级过滤，失败静默降级
  let stats90 = null;
  try {
    const statsResponse = await getJson(`${MARKET_BASE}/v1/items/${resolved.match.slug}/statistics`, headers);
    const closed = statsResponse?.payload?.statistics_closed?.['90days'] || [];
    let rows = closed.filter((row) => (selectedRank != null ? row.mod_rank === selectedRank : row.mod_rank == null));
    if (!rows.length) rows = closed.filter((row) => (row.mod_rank ?? 0) === (selectedRank ?? 0));
    if (rows.length >= 3) {
      const medians = rows.map((row) => Number(row.median)).filter(Number.isFinite).sort((a, b) => a - b);
      const median = medians[Math.floor(medians.length / 2)];
      const totalVolume = rows.reduce((sum, row) => sum + (Number(row.volume) || 0), 0);
      const lowestSell = sell[0]?.platinum ?? null;
      stats90 = {
        median: Math.round(median * 10) / 10,
        dailyVolume: Math.round((totalVolume / rows.length) * 10) / 10,
        deviationPct: lowestSell != null && median > 0 ? Math.round(((lowestSell - median) / median) * 100) : null,
      };
    }
  } catch { /* 统计接口挂了不影响主查询 */ }

  const englishName = detail.i18n?.en?.name || resolved.match.name;
  // 套装查询附散件单价（用户 2026-08-06 拍板）：setParts 是 wm id，目录反查 slug 后逐件拉详情+卖单；
  // 任一件失败该件无价不阻断，整个环节失败静默降级（卡不显示散件区）
  let setParts = null;
  if (detail.setRoot === true && Array.isArray(detail.setParts) && detail.setParts.length > 1) {
    try {
      const byId = new Map(items.filter((item) => item.id).map((item) => [item.id, item]));
      const partEntries = detail.setParts.filter((id) => id !== detail.id).map((id) => byId.get(id)).filter(Boolean);
      setParts = await mapLimit(partEntries, 3, async (part) => {
        try {
          const [partDetail, partOrders] = await Promise.all([
            getJson(`${MARKET_BASE}/v2/item/${part.slug}`, headers),
            getJson(`${MARKET_BASE}/v2/orders/item/${part.slug}/top`, headers),
          ]);
          const lowest = pickOrders(partOrders?.data?.sell)[0]?.platinum ?? null;
          return {
            slug: part.slug,
            zhName: partDetail?.data?.i18n?.['zh-hans']?.name || part.zhName || part.name,
            quantity: Number(partDetail?.data?.quantityInSet) || 1,
            lowestSell: lowest,
          };
        } catch {
          return { slug: part.slug, zhName: part.zhName || part.name, quantity: 1, lowestSell: null };
        }
      });
      if (!setParts.length) setParts = null;
    } catch { setParts = null; }
  }
  const rankSuffix = selectedRank == null ? '' : ` (rank ${selectedRank})`;
  // 网站同款逻辑：按卖家账号语言生成私聊模板；zh 系用官方中文名，其余一律英文
  const buildWhisper = (order) => {
    if (!order) return null;
    if (/^zh/iu.test(order.locale || '')) {
      const zhItemName = detail.i18n?.['zh-hans']?.name || englishName;
      const zhRank = selectedRank == null ? '' : ` (等级 ${selectedRank})`;
      return `/w ${order.user} 你好！我想买："${zhItemName}${zhRank}"，价格：${order.platinum} 白金。(warframe.market)`;
    }
    return `/w ${order.user} Hi! I want to buy: "${englishName}${rankSuffix}" for ${order.platinum} platinum. (warframe.market)`;
  };

  return {
    ok: true,
    kind: 'market',
    platform,
    crossplay,
    fetchedAt: new Date().toISOString(),
    item: {
      slug: resolved.match.slug,
      name: englishName,
      zhName: detail.i18n?.['zh-hans']?.name || resolved.match.zhName || englishName,
      ducats: detail.ducats ?? null,
      tradingTax: tradingTaxForRank(detail, selectedRank),
      reqMasteryRank: detail.reqMasteryRank ?? null,
      thumb: detail.i18n?.en?.thumb || null,
      // icon = wm 完整物品图（MOD 是带边框卡面），卡片头部用；tags 判 MOD/赋能才上词条行
      icon: detail.i18n?.en?.icon || null,
      subIcon: detail.i18n?.en?.subIcon || null,
      description: detail.i18n?.['zh-hans']?.description || null,
      tags: detail.tags || [],
      rank: selectedRank,
      maxRank,
      rankExplicit: rankQuery.rankMode != null,
    },
    correction: resolved.correctedFrom ? { from: resolved.correctedFrom, to: resolved.correctedTo } : null,
    sell,
    buy,
    stats90,
    setParts,
    contactTemplate: buildWhisper(sell[0]),
  };
}

function parseRelicCode(rawQuery) {
  const normalized = compact(rawQuery);
  for (const [alias, era] of ERA_ALIASES) {
    const prefix = compact(alias);
    if (!normalized.startsWith(prefix)) continue;
    const code = normalized.slice(prefix.length).match(/^([a-z]{1,2})(\d+)$/iu);
    if (code) return { era, code: `${code[1].toUpperCase()}${code[2]}`, name: `${era} ${code[1].toUpperCase()}${code[2]}` };
  }
  const english = normalizeUnicode(rawQuery).match(/^(Lith|Meso|Neo|Axi|Requiem|Omnia)\s*([A-Za-z]{1,2}\d+)$/iu);
  if (english) {
    const era = english[1][0].toUpperCase() + english[1].slice(1).toLowerCase();
    return { era, code: english[2].toUpperCase(), name: `${era} ${english[2].toUpperCase()}` };
  }
  return null;
}

function rarityFromChance(chance) {
  const n = Number(chance);
  if (n <= 3) return 'rare';
  if (n <= 12) return 'uncommon';
  return 'common';
}

const RARITY_ORDER = { common: 0, uncommon: 1, rare: 2 };

async function enrichRelicReward(reward, marketItems, platform, crossplay) {
  const slug = reward.item?.warframeMarket?.urlName || null;
  const marketItem = slug ? marketItems.find((item) => item.slug === slug) : null;
  const base = {
    name: reward.item?.name || 'Unknown Reward',
    zhName: marketItem?.zhName || localizeRelicRewardName(reward.item?.name),
    slug,
    chance: Number(reward.chance),
    rarity: rarityFromChance(reward.chance),
    ducats: null,
    platinum: null,
    marketBasis: null,
    dailyVolume: null,
    ducatsPerPlatinum: null,
    thumb: null,
    icon: null,
    subIcon: null,
  };
  if (!slug) return base;
  try {
    const headers = marketHeaders(platform, crossplay);
    const [detailResponse, quote] = await Promise.all([
      getJson(`${MARKET_BASE}/v2/item/${slug}`, headers),
      import('./trader-shopping.mjs').then(({ fetchTradeStatistics }) => fetchTradeStatistics(slug, false)),
    ]);
    const detail = detailResponse.data || {};
    const ducats = detail.ducats ?? null;
    const platinum = quote?.platinum ?? null;
    return {
      ...base,
      zhName: detail.i18n?.['zh-hans']?.name || base.zhName,
      ducats,
      platinum,
      marketBasis: quote?.basis ?? null,
      dailyVolume: quote?.dailyVolume ?? null,
      ducatsPerPlatinum: ducats && platinum ? Math.round(ducats / platinum) : null,
      icon: detail.i18n?.en?.icon || null,
      thumb: detail.i18n?.en?.thumb || null,
      subIcon: detail.i18n?.en?.subIcon || null,
    };
  } catch {
    return base;
  }
}

async function loadRelicDataset() {
  try {
    const local = await readAlecaJson('json/Relics.json');
    if (Array.isArray(local) && local.length) return local;
  } catch { /* GitHub backup below */ }
  return getJson(RELICS_DATA_URL);
}

async function queryRelicForward(parsed, platform, crossplay, squad = 4) {
  const response = await loadRelicDataset();
  const matches = (Array.isArray(response) ? response : []).filter((item) => {
    const baseName = String(item.name || '').replace(/\s+(Intact|Exceptional|Flawless|Radiant)$/iu, '');
    return baseName.toLowerCase() === parsed.name.toLowerCase() && item.type === 'Relic';
  });
  const relic = matches.find((item) => /\sIntact$/iu.test(item.name)) || matches[0];
  if (!relic) {
    return { ok: false, kind: 'relic', mode: 'forward', error: 'not_found', query: parsed.name, fetchedAt: new Date().toISOString() };
  }

  const marketItems = await fetchMarketItems(platform, crossplay);
  const rewards = await mapLimit(relic.rewards || [], 3, (reward) =>
    enrichRelicReward(reward, marketItems, platform, crossplay));
  rewards.sort((a, b) => (RARITY_ORDER[a.rarity] - RARITY_ORDER[b.rarity]) || a.zhName.localeCompare(b.zhName, 'zh-CN'));
  // 精炼四档期望：同卡同口径（可靠成交中位），与行内估值自洽；杜卡德用官方固定值
  const refine = appraiseRefinements(rewards, (reward) => ({ p: reward.platinum || 0, d: reward.ducats || 0 }), { squad });
  // 掉落来源 top3（WFCD drop-data 反查索引，缓存 7 天）：已入库遗物天然无掉点，卡片按「已入库」文案兜住
  let sources = [];
  try {
    const { getRelicSources } = await import('./wfdata.mjs');
    sources = ((await getRelicSources())[parsed.name] || []).slice(0, 3);
  } catch { sources = []; }

  return {
    ok: true,
    kind: 'relic',
    mode: 'forward',
    platform,
    crossplay,
    squad,
    fetchedAt: new Date().toISOString(),
    relic: {
      name: parsed.name,
      zhName: `${ERA_ZH[parsed.era] || parsed.era} ${parsed.code}`,
      vaulted: Boolean(relic.vaulted),
      imageUrl: relic.imageName ? `https://cdn.alecaframe.com/warframeData/img/${encodeURIComponent(relic.imageName)}` : null,
      rewards,
      refine,
      sources,
    },
  };
}

async function queryRelicReverse(rawQuery, platform, crossplay) {
  const [relics, marketItems] = await Promise.all([
    loadRelicDataset(),
    fetchMarketItems(platform, crossplay),
  ]);
  const marketBySlug = new Map(marketItems.map((item) => [item.slug, item]));
  const q = compact(expandItemQuery(rawQuery));
  const matches = [];

  for (const relic of Array.isArray(relics) ? relics : []) {
    if (!/\sIntact$/iu.test(relic.name || '')) continue;
    const rewardMatches = (relic.rewards || []).filter((reward) => {
      const slug = reward.item?.warframeMarket?.urlName;
      const marketItem = slug ? marketBySlug.get(slug) : null;
      const fields = [reward.item?.name, slug, marketItem?.name, marketItem?.zhName].filter(Boolean).map(compact);
      return fields.some((field) => field.includes(q) || q.includes(field));
    });
    if (!rewardMatches.length) continue;
    const baseName = String(relic.name).replace(/\sIntact$/iu, '');
    matches.push({
      name: baseName,
      zhName: localizeRelicName(baseName),
      vaulted: Boolean(relic.vaulted),
      rewards: rewardMatches.map((reward) => {
        const slug = reward.item?.warframeMarket?.urlName;
        const marketItem = slug ? marketBySlug.get(slug) : null;
        const englishName = reward.item?.name;
        return {
          name: englishName,
          zhName: marketItem?.zhName || localizeRelicRewardName(englishName),
          slug,
          chance: Number(reward.chance) || 0,
          rarity: rarityFromChance(reward.chance),
        };
      }),
    });
  }

  const unique = [...new Map(matches.map((item) => [item.name, item])).values()]
    .sort((a, b) => Number(a.vaulted) - Number(b.vaulted) || a.name.localeCompare(b.name));
  // 每遗物附概率最高的一个掉点（缓存索引零逐条请求）；查无（已入库）不显示
  try {
    const { getRelicSources } = await import('./wfdata.mjs');
    const sourceMap = await getRelicSources();
    for (const item of unique) item.source = sourceMap[item.name]?.[0] || null;
  } catch { /* 无来源降级 */ }
  return {
    ok: true,
    kind: 'relic',
    mode: 'reverse',
    platform,
    crossplay,
    query: rawQuery,
    matches: unique.slice(0, 30),
    truncated: unique.length > 30,
    total: unique.length,
    fetchedAt: new Date().toISOString(),
  };
}

async function queryRelic(rawQuery, platform = DEFAULT_PLATFORM, crossplay = DEFAULT_CROSSPLAY) {
  // 先剥口径词（单人/N人）再解析遗物编号；默认 4 人组队对齐 AlecaFrame
  const squad = /单人|单排|solo/iu.test(rawQuery) ? 1 : Number(String(rawQuery).match(/([1-4])\s*人/u)?.[1]) || 4;
  const cleaned = normalizeUnicode(rawQuery).replace(/(?:单人|单排|solo|[1-4]\s*人)/giu, ' ').replace(/\s+/gu, ' ').trim();
  const parsed = parseRelicCode(cleaned);
  return parsed
    ? queryRelicForward(parsed, platform, crossplay, squad)
    : queryRelicReverse(cleaned || rawQuery, platform, crossplay);
}

async function queryRelicFarm(rawQuery, platform = DEFAULT_PLATFORM, crossplay = DEFAULT_CROSSPLAY, options = {}) {
  const reverse = await queryRelicReverse(rawQuery, platform, crossplay);
  if (!reverse.matches.length) return { ok: false, kind: 'relic-farm', error: 'not_found', query: rawQuery, fetchedAt: reverse.fetchedAt };
  let sourceMap = options.relicSourceMap;
  if (!sourceMap) {
    try {
      const { getRelicSources } = await import('./wfdata.mjs');
      sourceMap = await getRelicSources();
    } catch { sourceMap = {}; }
  }

  let bountyData = options.bountyData;
  let bountyChecked = options.bountyChecked === true;
  if (bountyData === undefined) {
    try {
      const { fetchBounties } = await import('./bounties.mjs');
      bountyData = await fetchBounties(options.bountyFetchOptions || {});
      bountyChecked = true;
    } catch {
      bountyData = null;
    }
  }
  const bountyHitsByRelic = {};
  if (bountyData) {
    const { whereBountyReward } = await import('./bounties.mjs');
    for (const relic of reverse.matches) {
      bountyHitsByRelic[relic.name] = whereBountyReward(`${relic.name} Relic`, bountyData).hits
        .map((hit) => ({ ...hit, expiry: bountyData.expiry || null }));
    }
  }

  let ownedRelics = options.ownedRelics ?? null;
  if (ownedRelics === null && (options.personalAllowed === true || process.env.WARFRAME_PERSONAL_OK === '1')) {
    try {
      const { readSnapshot, loadRelics } = await import('./alecaframe.mjs');
      const snapshot = await readSnapshot();
      ownedRelics = await loadRelics(snapshot);
    } catch { ownedRelics = null; }
  }
  return buildRelicFarmPlan({
    query: rawQuery,
    matches: reverse.matches,
    sourceMap: sourceMap || {},
    bountyHitsByRelic,
    bountyChecked,
    ownedRelics,
    fetchedAt: new Date().toISOString(),
  });
}

function parseFissureFilters(rawQuery) {
  const query = normalizeUnicode(rawQuery).toLowerCase();
  const hardOnly = /钢铁|steel/iu.test(query);
  const normalOnly = /普通|normal/iu.test(query);
  const speedOnly = /高效|速刷/iu.test(query);
  const stormOnly = /九重天|航道星舰|storm/iu.test(query);
  const era = ERA_ALIASES.find(([alias]) => query.includes(alias.toLowerCase()))?.[1] || null;
  const missions = Object.entries(FISSURE_MISSION_ZH)
    .filter(([english, chinese]) => query.includes(english.toLowerCase()) || query.includes(chinese))
    .map(([english]) => english);
  return { query, hardOnly: hardOnly && !normalOnly, normalOnly: normalOnly && !hardOnly, speedOnly, stormOnly, era, missions };
}

function splitFissureNode(value) {
  const match = String(value || '').match(/^(.*?)\s*\(([^)]+)\)\s*$/u);
  if (!match) return { node: String(value || '未知节点'), planet: '未知星区' };
  return { node: match[1], planet: PLANET_ZH[match[2]] || match[2] };
}

async function queryFissures(rawQuery = '', platform = DEFAULT_PLATFORM, options = {}) {
  if (platform === 'mobile') return { ok: false, kind: 'fissure', error: 'unsupported_platform', query: rawQuery };
  let state;
  try {
    state = options.worldState || await (options.loadWorldState || loadWorldState)(platform);
  } catch (error) {
    return {
      ok: false,
      kind: 'fissure',
      error: 'source_unavailable',
      query: rawQuery,
      fetchedAt: new Date().toISOString(),
      userError: userErrorFromDiagnostic(error?.diagnostic, {
        nextSteps: [`裂缝${rawQuery ? ` ${rawQuery}` : ''}（稍后重试）`, '帮助 遗物'],
      }),
    };
  }
  const filters = parseFissureFilters(rawQuery);
  const now = Date.now();
  let fissures = (Array.isArray(state.fissures) ? state.fissures : [])
    .filter((item) => !item.expired && Date.parse(item.expiry) > now)
    .map((item) => {
      const location = splitFissureNode(item.node);
      return {
        id: item.id || `${item.node}:${item.tier}:${item.expiry}`,
        node: location.node,
        planet: location.planet,
        mission: FISSURE_MISSION_ZH[item.missionType] || item.missionType || '未知任务',
        missionType: item.missionType,
        faction: FISSURE_FACTION_ZH[item.enemy] || item.enemy || '未知阵营',
        tier: item.tier,
        expiry: item.expiry,
        hard: Boolean(item.isHard),
        storm: Boolean(item.isStorm),
        tags: classifyFissure(item),
      };
    });

  if (filters.hardOnly) fissures = fissures.filter((item) => item.hard);
  if (filters.normalOnly) fissures = fissures.filter((item) => !item.hard);
  if (filters.era) fissures = fissures.filter((item) => item.tier === filters.era);
  if (filters.missions.length) fissures = fissures.filter((item) => filters.missions.includes(item.missionType));
  if (filters.speedOnly) fissures = fissures.filter((item) => item.tags.some((tag) => tag.key === 'speed'));
  if (filters.stormOnly) fissures = fissures.filter((item) => item.storm);

  const tierOrder = { Lith: 1, Meso: 2, Neo: 3, Axi: 4, Requiem: 5, Omnia: 6 };
  fissures.sort((a, b) => (tierOrder[a.tier] || 99) - (tierOrder[b.tier] || 99)
    || Date.parse(a.expiry) - Date.parse(b.expiry));

  // 用户私聊增强：同一张公开裂缝卡，为每条任务补一枚兼容库存遗物；失败时安全降级为纯公开列表。
  let personalized = false;
  let recommendationModeZh = null;
  if (options.personalAllowed === true || process.env.WARFRAME_PERSONAL_OK === '1') {
    try {
      const { runAlecaMessage } = await import('./alecaframe.mjs');
      const recommendation = await runAlecaMessage(`开遗物 ${rawQuery}`.trim(), {
        skipCard: true,
        recommendOptions: { worldState: state, perspective: 'fissure', minRemainMs: 0 },
      });
      if (recommendation.ok && recommendation.data?.perspective === 'fissure') {
        const byId = new Map(recommendation.data.rows.map((row) => [row.id, row]));
        for (const item of fissures) {
          const row = byId.get(item.id);
          if (!row) continue;
          item.recommendation = {
            relic: row.relic,
            expectedValue: row.expectedValue,
            expectedDucats: row.expectedDucats,
            targetEconomy: row.targetEconomy,
            refineZh: row.refineZh,
          };
        }
        personalized = true;
        recommendationModeZh = recommendation.data.mode === 'ducat'
          ? (recommendation.data.ducatGoal ? `奸商对标·${recommendation.data.ducatGoal.name}` : '杜卡德')
          : '白金';
      }
    } catch { /* 库存/行情不可用时保持公开裂缝卡 */ }
  }

  const normalAll = fissures.filter((item) => !item.hard);
  const hardAll = fissures.filter((item) => item.hard);
  const normal = normalAll;
  const hard = hardAll;
  const eraTitle = filters.era ? ERA_ZH[filters.era] : '';
  const title = filters.hardOnly ? `${eraTitle}钢铁虚空裂缝`
    : filters.normalOnly ? `${eraTitle}普通虚空裂缝`
      : eraTitle ? `${eraTitle}虚空裂缝` : '当前虚空裂缝';
  return {
    ok: fissures.length > 0,
    kind: 'fissure',
    query: rawQuery,
    key: filters.query || 'all',
    title,
    filters,
    normal,
    hard,
    normalTotal: normalAll.length,
    hardTotal: hardAll.length,
    total: fissures.length,
    truncated: false,
    personalized,
    recommendationModeZh,
    fetchedAt: new Date().toISOString(),
    sourceTimestamp: state.timestamp || null,
    error: fissures.length ? null : 'no_matches',
    userError: fissures.length ? null : userError({
      code: 'no_match',
      category: 'fissure-filter',
      retryable: false,
      nextSteps: filters.stormOnly ? ['开遗物 九重天', '裂缝', '帮助 裂缝'] : ['开遗物', '裂缝（去掉筛选）', '帮助 裂缝'],
    }),
  };
}

function formatFissures(result) {
  if (!result.ok) {
    if (result.error === 'source_unavailable') {
      return formatUserError(result.userError, {
        message: `当前无法取得“${result.query || '全部'}”裂缝的最新世界状态。`,
      });
    }
    const steps = result.userError?.nextSteps?.length ? `\n下一步：${result.userError.nextSteps.join('｜')}` : '';
    return `当前没有符合“${result.query || '裂缝'}”的活动裂缝。${steps}`;
  }
  const lines = [`当前裂缝：${result.total} 条`];
  for (const item of [...result.normal, ...result.hard]) {
    const tags = (item.tags || []).map((tag) => tag.zh).join('/');
    const rec = item.recommendation?.relic ? ` · 推荐 ${item.recommendation.relic.zh} ×${item.recommendation.relic.count}（${item.recommendation.relic.vaulted ? '已入库' : '未入库'}）` : '';
    lines.push(`• ${item.hard ? '钢铁' : '普通'} · ${ERA_ZH[item.tier] || item.tier} ${item.mission} · ${item.planet} ${item.node}${tags ? ` · ${tags}` : ''}${rec} · ${formatTime(item.expiry)}`);
  }
  lines.push(`来源：世界状态 · ${formatTime(result.fetchedAt)}`);
  return lines.join('\n');
}

function statusLabel(status) {
  return status === 'ingame' ? '游戏中' : status === 'online' ? '在线' : '离线';
}

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso || '未知');
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Europe/Berlin', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

function formatMarket(result) {
  if (!result.ok) {
    if (result.error === 'ambiguous') {
      const choices = result.candidates.map((item, index) => `${index + 1}. ${item.zhName || item.name}`).join('\n');
      return `找到多个可能的物品，请写得更具体：\n${choices}`;
    }
    if (result.error === 'rank_not_supported') return `${result.item.zhName}没有可筛选的等级。`;
    if (result.error === 'untradable') return 'Excalibur 系列战甲不可交易（Prime 为创始人独占，Umbra 通过剧情获取），市场上没有报价。';
    if (result.error === 'rank_out_of_range') return `${result.item.zhName}最高为${result.maxRank}级，不能查询${result.requestedRank}级。`;
    if (result.error === 'market_down') {
      const fmtTime = (at) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(at));
      const message = result.userError?.code === 'no_match'
        ? `Warframe.Market 目录已识别「${result.item.zhName}」，但详情当前不存在。`
        : `Warframe.Market 暂时无法提供「${result.item.zhName}」的实时报价。`;
      const lines = [`⚠ ${formatUserError(result.userError, { message })}`];
      if (result.lastKnown) lines.push(`上次成功查询（${fmtTime(result.lastKnown.at)}）：在线最低卖单 ${result.lastKnown.platinum} 白金。`);
      if (result.snapshot) lines.push(`离线快照（${fmtTime(result.snapshot.at)}）：市场加权均价约 ${result.snapshot.waPrice} 白金${result.snapshot.ducats ? `，杜卡德 ${result.snapshot.ducats}` : ''}。`);
      if (!result.lastKnown && !result.snapshot) lines.push('本地也没有该物品的历史记录，请稍后重试。');
      else lines.push('以上为离线数据仅供参考，恢复后请重新查询。');
      return lines.join('\n');
    }
    return `没有找到“${result.query}”。可尝试完整名称，例如：wm 悟空p、wm 悟空p头。`;
  }
  const item = result.item;
  const lines = [
    `【${item.zhName}】`,
    `杜卡德：${item.ducats ?? '—'} ｜ 交易税：${item.tradingTax == null ? '—' : Number(item.tradingTax).toLocaleString('zh-CN')}`,
    '',
    '卖单（在线最低）：',
  ];
  if (result.correction) lines.splice(1, 0, `已纠正：${result.correction.from} → ${item.zhName}`);
  if (result.stats90) {
    const s = result.stats90;
    const dev = s.deviationPct == null ? '' : Math.abs(s.deviationPct) < 5 ? '｜当前卖价与行情持平' : `｜当前卖价${s.deviationPct > 0 ? '高' : '低'}于中位 ${Math.abs(s.deviationPct)}%`;
    lines.splice(2, 0, `90 天成交：中位 ${s.median} 白金｜日均 ${s.dailyVolume} 笔${dev}`);
  }
  if (!result.sell.length) lines.push('暂无在线卖单');
  result.sell.forEach((order, index) => {
    const rank = item.rank == null ? '' : `｜等级${order.rank ?? item.rank}/${item.maxRank}`;
    lines.push(`${index + 1}. ${order.user}｜${order.platinum}白金 ×${order.quantity}${rank}｜信誉${order.reputation ?? '—'}｜${statusLabel(order.status)}`);
  });
  lines.push('', '买单（在线最高）：');
  if (!result.buy.length) lines.push('暂无在线买单');
  result.buy.slice(0, 3).forEach((order, index) => {
    const rank = item.rank == null ? '' : `｜等级${order.rank ?? item.rank}/${item.maxRank}`;
    lines.push(`${index + 1}. ${order.user}｜${order.platinum}白金 ×${order.quantity}${rank}｜信誉${order.reputation ?? '—'}｜${statusLabel(order.status)}`);
  });
  if (result.contactTemplate) lines.push('', '复制后粘贴到游戏聊天：', result.contactTemplate);
  lines.push('', `跨平台交易｜${formatTime(result.fetchedAt)}｜星际战甲市场`, '价格仅供参考，交易前请再次确认。');
  return lines.join('\n');
}

function formatRelic(result) {
  if (!result.ok) return `没有找到“${result.query}”对应的遗物。请检查纪元和编号，例如：遗物 前x1。`;
  if (result.mode === 'reverse') {
    if (!result.matches.length) return `没有找到包含“${result.query}”的遗物。可以换用完整物品名称。`;
    const lines = [`包含“${result.query}”的遗物：${result.total} 个`];
    for (const item of result.matches) {
      const rewards = item.rewards.map((reward) => reward.zhName).join('、');
      lines.push(`- ${item.vaulted ? '已入库' : '未入库'}｜${localizeRelicName(item.name)}｜${rewards}`);
    }
    if (result.truncated) lines.push('结果较多，仅显示前30项。');
    lines.push('', `跨平台交易｜${formatTime(result.fetchedAt)}｜遗物资料＋星际战甲市场`);
    return lines.join('\n');
  }

  const relic = result.relic;
  const lines = [
    `【${relic.vaulted ? '已入库遗物' : '未入库遗物'}｜${relic.zhName}】`,
    '奖励｜成交中位估值｜杜卡德｜杜卡德/白金',
  ];
  const rarityLabel = { common: '常见', uncommon: '罕见', rare: '稀有' };
  for (const reward of relic.rewards) {
    const price = reward.platinum == null ? '—' : `${reward.platinum}白金（${reward.marketBasis === 'today' ? '今日' : '90日'}，日均${reward.dailyVolume ?? '—'}）`;
    const ducats = reward.ducats == null ? '—' : `${reward.ducats}`;
    const efficiency = reward.ducatsPerPlatinum == null ? '—' : `${reward.ducatsPerPlatinum}`;
    lines.push(`- ${rarityLabel[reward.rarity]}｜${reward.zhName}｜${price}｜${ducats}｜${efficiency}`);
  }
  lines.push('', '估值优先采用可靠今日成交中位，样本不足回退 90 日成交中位。', `跨平台交易｜${formatTime(result.fetchedAt)}｜遗物资料＋星际战甲市场`);
  return lines.join('\n');
}

function formatRelicFarm(result) {
  if (!result.ok) {
    if (result.error === 'ambiguous_target') {
      return `“${result.query}”对应多个 Prime 部件，请说具体一点：\n${(result.choices || []).map((choice) => `- ${choice}`).join('\n')}`;
    }
    return `没有找到“${result.query}”对应的 Prime 部件遗物。请使用具体部件名，例如：获取 悟空Prime系统蓝图。`;
  }
  if (result.setMode) {
    const lines = [`【${result.set.zhName || result.set.name}｜整套获取路线】`];
    for (const component of result.components) {
      const row = component.route;
      if (!row) continue;
      const name = String(component.target.zhName || component.target.name).replace(`${result.set.zhName || result.set.name} `, '');
      const owned = row.relic.ownedCount == null ? '' : `｜库存 ${row.relic.ownedCount}`;
      const source = row.sources[0];
      lines.push(`- ${name}：${row.relic.zhName || localizeRelicName(row.relic.name)}${owned}｜建议${row.refinement.zh} ${row.refinement.chance}%`);
      lines.push(source ? `  ${source.availabilityZh}｜${source.place}｜联合 ${source.combinedChance}%` : '  没有当前可验证的常规掉点');
    }
    lines.push('', '每个部件先选一条最优路线；发送“获取 <具体部件>”可看该部件全部候选。');
    return lines.join('\n');
  }
  const lines = [`【${result.target.zhName || result.target.name}｜获取路线】`];
  for (const row of result.rows) {
    const owned = row.relic.ownedCount == null ? '' : row.relic.ownedCount > 0 ? `｜库存 ${row.relic.ownedCount}` : '｜库存 0';
    lines.push(`- ${row.relic.zhName || localizeRelicName(row.relic.name)}${owned}｜${row.relic.vaulted ? '已入库' : '未入库'}｜${row.refinement.zh} ${row.refinement.chance}%`);
    if (Number(row.relic.ownedCount) > 0) lines.push('  先开现有库存，再决定是否继续刷。');
    if (!row.sources.length) lines.push(`  ${row.relic.vanguard ? '先锋遗物：瓦奇娅限时阿耶兑换，当前未开放' : row.relic.vaulted ? '没有常规掉点' : '当前掉落表查无可靠来源'}`);
    for (const source of row.sources) {
      lines.push(`  ${source.availabilityZh}｜${source.place}｜遗物 ${source.chance}%｜联合 ${source.combinedChance}%`);
    }
  }
  lines.push('', '联合概率＝单次来源结算获得遗物 × 该精炼档开出目标；不是每分钟效率。');
  if (!result.bountyChecked) lines.push('当前赏金校验不可用；悬赏来源仅按静态掉落表标记，未声称本轮正在开放。');
  return lines.join('\n');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

function cardDocument(content, height, width = 600) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:#17191d}
    body{font-family:"Microsoft YaHei UI","Microsoft YaHei",Arial,sans-serif;color:#f3f4f6}
    .card{width:${width}px;height:${height}px;background:linear-gradient(145deg,#28262e 0%,#1e2227 48%,#25232b 100%);border:1px solid #3d3944;overflow:hidden}
    .head{height:100px;padding:18px 24px;background:linear-gradient(110deg,rgba(38,45,48,.98),rgba(30,34,39,.86));border-bottom:1px solid #8f642d}
    .eyebrow{font-size:14px;color:#95d6ac;font-weight:700;letter-spacing:.5px}.title{font-size:28px;line-height:38px;font-weight:800;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .chips{position:absolute;right:22px;top:20px;display:flex;gap:8px}.chip{background:#34343c;border:1px solid #5a5360;border-radius:8px;padding:4px 8px;text-align:center;color:#f3d188;font-weight:700}.chip small{display:block;color:#a7aab1;font-size:10px;font-weight:500}
    table{width:100%;border-collapse:collapse;table-layout:fixed}th{height:30px;background:#d7dbdb;color:#205264;font-size:15px;font-weight:500}td{height:36px;padding:5px 10px;border-bottom:1px solid rgba(181,117,45,.55);font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    tbody tr:nth-child(even){background:rgba(255,255,255,.035)}.name{color:#f6f2ef;font-weight:650}.rep{text-align:center;color:#91d8d1}.qty{text-align:center;color:#d6d8dc}.price{text-align:center;color:#ff87b4;font-weight:800}.market-price-value{display:inline-flex;align-items:center;justify-content:flex-start}.buy .price{color:#61e0b5}.status{font-size:11px;color:#8dd7ae;margin-left:5px}
    .market-head .seller-col,.section .seller-col{text-align:left;padding-left:10px}.market-head .rep-col,.section .rep-col{text-align:center}.market-head .qty-col,.section .qty-col{text-align:center}.market-head .price-col,.section .price-col{text-align:center}
    .market-parts-head{padding:5px 14px 4px;background:#cbd0d0;color:#215064;font-size:13px;font-weight:700;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;column-gap:14px}.market-parts-summary{display:inline-flex;align-items:center;justify-content:flex-end;gap:5px;white-space:nowrap}.market-part-row{height:30px;display:grid;grid-template-columns:78% 22%;align-items:center;border-bottom:1px solid rgba(181,117,45,.35);font-size:13.5px}.market-part-name{padding-left:14px;color:#e8e6e3;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.market-part-price{display:flex;align-items:center;justify-content:center;min-width:0}
    .section td{height:28px;background:#cbd0d0;color:#215064;font-weight:700;border:0}.foot{height:34px;padding:8px 12px;color:#a9adb4;font-size:11px;border-top:1px solid #3e3b43;display:flex;justify-content:space-between}
    .relic-head{height:92px;padding:16px 20px;background:linear-gradient(110deg,#323038,#24262c);border-bottom:1px solid #9e6a2d}.relic-badge{display:inline-block;background:#93c7a5;color:white;border-radius:4px;padding:4px 10px;font-size:20px;font-weight:800}.relic-title{font-size:15px;color:#9ce4b5;font-weight:800}.relic-code{font-size:27px;font-weight:850;margin-top:3px}.relic-note{position:absolute;right:18px;top:20px;color:#dce0e3;text-align:right;font-size:12px;line-height:18px}
    .reward td{height:47px;font-size:16px}.rarity{width:58px;text-align:center;font-size:12px;font-weight:800}.common{color:#ddd}.uncommon{color:#d7cf8e}.rare{color:#e9b879}.reward-name{font-weight:750}.ducat,.eff{text-align:center;color:#f0d48e;font-weight:800}.plat{text-align:center;color:#e8d58c;font-weight:800}
    .reverse td{height:42px;font-size:15px}.vault-state{text-align:center;font-size:12px;font-weight:800}.vaulted{color:#d7a46d}.unvaulted{color:#8ee3ad}.reverse-relic{text-align:center;font-weight:800;color:#f0d48e}.reverse-hit{text-align:center;font-weight:650;color:#f4f2f1}
    .relic-table-head .reward-col{text-align:left;padding-left:10px}.reverse-head .state-col,.reverse-head .relic-col,.reverse-head .hit-col{text-align:center}
    .help td{height:37px;font-size:14px}.help-cmd{color:#f0d48e;font-weight:750}.help-desc{color:#cfd3d8}
  </style></head><body>${content}</body></html>`;
}

function buildMarketCard(data) {
  const item = data.item;
  const ranked = item.rank != null;
  // 词条效果只对 MOD/赋能上卡（tags 判定，flavor 介绍文不上）：+/- 行优先；赋能句式描述按句号拆条
  const isModOrArcane = (item.tags || []).some((tag) => tag === 'mod' || tag === 'arcane_enhancement');
  let effectLines = [];
  if (isModOrArcane) {
    const lines = String(item.description || '').split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    const plusLines = lines.filter((line) => /^[+-]/u.test(line));
    effectLines = (plusLines.length ? plusLines : lines.flatMap((line) => line.split(/(?<=[。；])/u)))
      .map((part) => part.trim().replace(/[。；]$/u, '')).filter(Boolean).slice(0, 4);
  }
  const rankCell = (order) => ranked ? `<td class="qty">${escapeHtml(order.rank ?? item.rank)}/${escapeHtml(item.maxRank)}</td>` : '';
  // 每组用首条价格的实际字符数定宽：首条整体居中对齐表头，其余条目沿同一图标起点左对齐。
  const priceAnchorWidth = (value, iconSize) => {
    const chars = Math.max(1, Number(value).toLocaleString('zh-CN').length);
    return `calc(${iconSize + 3}px + ${chars}ch)`;
  };
  const sellerPriceWidth = priceAnchorWidth(data.sell[0]?.platinum ?? 0, 13);
  const buyerPriceWidth = priceAnchorWidth(data.buy[0]?.platinum ?? 0, 13);
  const sellerRows = data.sell.slice(0, 5).map((order) => `<tr><td class="name">${escapeHtml(order.user)} <span class="status">${escapeHtml(statusLabel(order.status))}</span></td><td class="rep">${escapeHtml(order.reputation ?? '—')}</td><td class="qty">${escapeHtml(order.quantity)}</td>${rankCell(order)}<td class="price"><span class="market-price-value" style="width:${sellerPriceWidth}">${currency('plat', order.platinum, { size: 13, color: '#ff87b4' })}</span></td></tr>`).join('');
  const buyerRows = data.buy.slice(0, 3).map((order) => `<tr class="buy"><td class="name">${escapeHtml(order.user)} <span class="status">${escapeHtml(statusLabel(order.status))}</span></td><td class="rep">${escapeHtml(order.reputation ?? '—')}</td><td class="qty">${escapeHtml(order.quantity)}</td>${rankCell(order)}<td class="price"><span class="market-price-value" style="width:${buyerPriceWidth}">${currency('plat', order.platinum, { size: 13, color: '#61e0b5' })}</span></td></tr>`).join('');
  const columns = ranked
    ? '<col style="width:40%"><col style="width:15%"><col style="width:12%"><col style="width:13%"><col style="width:20%">'
    : '<col style="width:46%"><col style="width:18%"><col style="width:14%"><col style="width:22%">';
  const rankHeader = ranked ? '<th class="qty-col">等级</th>' : '';
  const stats = data.stats90;
  // 卖价 vs 90 天成交中位的偏离：±5% 内算持平，纯数字参考不做决策建议
  const devText = stats?.deviationPct == null ? ''
    : Math.abs(stats.deviationPct) < 5 ? ` · 当前卖价与90天行情持平`
      : ` · 当前卖价${stats.deviationPct > 0 ? '高于' : '低于'}中位 ${Math.abs(stats.deviationPct)}%`;
  // 90天中位不占 chip（长名标题会被三 chip 挤断），并进 footer 统计行
  const footLeft = stats ? `90天成交中位 ${currency('plat', stats.median, { size: 10, color: '#cfe4f0', weight: 750 })} · 日均 ${escapeHtml(stats.dailyVolume)} 笔${devText}` : '当前在线挂单 · 仅供参考';
  // 头部：有物品图时左侧放 84px 图（MOD 是完整卡面竖图，contain 收进方盒），词条效果行跟在标题下
  const effectsHtml = effectLines.length
    ? `<div style="margin-top:5px;display:flex;flex-wrap:wrap;column-gap:14px;row-gap:2px;overflow:hidden">${effectLines.map((line) => `<span style="font-size:12.5px;color:#9fd6b8;font-weight:600">${escapeHtml(line)}</span>`).join('')}</div>`
    : '';
  // 词条允许折行（超长句式词条 nowrap 会溢出压 chips）；头高按字符宽估行数（中间列约 300px 宽）
  const effChars = effectLines.reduce((sum, line) => sum + [...line].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e7f ? 1 : 0.55), 0), 0);
  const effRows = effectLines.length ? Math.max(1, Math.ceil((effChars * 12.5 + (effectLines.length - 1) * 14) / 300)) : 0;
  const headExtra = effRows > 1 ? effRows * 19 : effRows ? 20 : 0;
  const headH = 100 + headExtra;
  const iconHtml = item.iconDataUri
    ? `<div style="flex:0 0 84px;height:${headH - 24}px;display:grid;place-items:center"><img src="${item.iconDataUri}" style="max-width:84px;max-height:${headH - 24}px;object-fit:contain"></div>`
    : '';
  // 标题按有效宽度分级缩字号（中文计 1、拉丁计 0.55），「Wukong Prime 一套」类长名不被截断
  const zhLen = [...String(item.zhName)].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e7f ? 1 : 0.55), 0);
  const titleSize = zhLen > 12 ? 19 : zhLen > 8 ? 23 : 28;
  // 高度按真实行数收缩（行高 37 = td36+border），挂单少时不留大片空白；空列表占一行提示
  const sellCount = Math.max(data.sell.slice(0, 5).length, 1);
  const buyCount = Math.max(data.buy.slice(0, 3).length, 1);
  const colspan = ranked ? 5 : 4;
  const emptySellRow = `<tr><td colspan="${colspan}" style="text-align:center;color:#9aa3ad">没有任何在线卖家出售此物品</td></tr>`;
  const emptyBuyRow = `<tr class="buy"><td colspan="${colspan}" style="text-align:center;color:#9aa3ad">没有任何在线玩家收购此物品</td></tr>`;
  // 套装散件单价区（只在查「X 一套」且拉到部件报价时显示）：套/散对比只给数字不做决策话术
  const setParts = Array.isArray(data.setParts) ? data.setParts : [];
  const priced = setParts.filter((part) => part.lowestSell != null);
  const partsTotal = priced.reduce((sum, part) => sum + part.lowestSell * (part.quantity || 1), 0);
  const setLowest = data.sell[0]?.platinum ?? null;
  const missingPartNote = priced.length < setParts.length ? `（缺 ${setParts.length - priced.length} 件报价）` : '';
  const partPriceWidth = priceAnchorWidth(priced[0]?.lowestSell ?? 0, 12);
  const partsSummary = priced.length
    ? `<span>散件合计 ≈</span>${currency('plat', partsTotal, { size: 12, color: '#215064', weight: 800 })}${missingPartNote ? `<span>${escapeHtml(missingPartNote)}</span>` : ''}${setLowest != null ? `<span>· 整套最低</span>${currency('plat', setLowest, { size: 12, color: '#215064', weight: 800 })}` : ''}`
    : '<span>散件均无在线报价</span>';
  const partsBlock = setParts.length ? `<div class="market-parts-head"><span>散件单价</span><span class="market-parts-summary">${partsSummary}</span></div>${setParts.map((part) => `<div class="market-part-row"><span class="market-part-name">${escapeHtml(part.zhName)}${(part.quantity || 1) > 1 ? ` ×${part.quantity}` : ''}</span><span class="market-part-price">${part.lowestSell == null ? '<span style="color:#9aa3ad">无卖单</span>' : `<span class="market-price-value" style="width:${partPriceWidth}">${currency('plat', part.lowestSell, { size: 12, color: '#e8d58c', weight: 800 })}</span>`}</span></div>`).join('')}` : '';
  const partsH = setParts.length ? 27 + setParts.length * 30 : 0;
  const actions = renderNextActions(data.nextActions);
  const height = headH + partsH + 30 + sellCount * 37 + 28 + buyCount * 37 + 32 + (actions ? NEXT_ACTIONS_HEIGHT : 0);
  // chips 收进 flex 流且固定右上（垂直居中时多行词条会撞框，2026-08-06 赋能·速攻实锤）
  const content = `<div class="card"><div class="head" style="height:${headH}px;display:flex;gap:14px;align-items:center">${iconHtml}<div style="min-width:0;flex:1"><div class="eyebrow">星际战甲市场 · 跨平台交易</div><div class="title" style="font-size:${titleSize}px">${escapeHtml(item.zhName)}</div>${effectsHtml}</div><div class="chips" style="position:static;flex:0 0 auto;align-self:flex-start;margin-top:16px"><div class="chip"><small>杜卡德</small>${item.ducats == null ? '—' : currency('ducat', item.ducats, { size: 12, color: '#f3d188', weight: 700 })}</div><div class="chip"><small>交易税</small>${item.tradingTax == null ? '—' : currency('credit', item.tradingTax, { size: 12, color: '#f3d188', weight: 700 })}</div></div></div>${partsBlock}<table><colgroup>${columns}</colgroup><thead class="market-head"><tr><th class="seller-col">卖家</th><th class="rep-col">信誉</th><th class="qty-col">数量</th>${rankHeader}<th class="price-col">价格</th></tr></thead><tbody>${sellerRows || emptySellRow}<tr class="section"><td class="seller-col">买家</td><td class="rep-col">信誉</td><td class="qty-col">数量</td>${ranked ? '<td class="qty-col">等级</td>' : ''}<td class="price-col">价格</td></tr>${buyerRows || emptyBuyRow}</tbody></table>${actions}<div class="foot"><span>${footLeft}</span><span>${escapeHtml(formatTime(data.fetchedAt))}</span></div></div>`;
  // key 带 v9 + 图/词条/行数/散件特征：模板改版必须打散渲染缓存，否则吃陈旧图
  return { html: cardDocument(content, height), width: 600, height, key: `market-v11-${item.slug}-${stats ? 's' : 'ns'}-${item.iconDataUri ? 'i' : 'x'}${effectLines.length}e${effRows}-r${sellCount}${buyCount}-sp${setParts.length}.${priced.length}` };
}

function buildRelicCard(data) {
  const relic = data.relic;
  const rarityLabel = { common: '常见', uncommon: '罕见', rare: '稀有' };
  // 图嵌进奖励名单元格（不加表列，refine 区 colspan 零改动）；行高 47 放 34px 图不撑行
  const rewardIcon = (reward) => reward.iconDataUri
    ? `<img src="${reward.iconDataUri}" style="width:34px;height:34px;object-fit:contain;vertical-align:middle;margin-right:8px">`
    : '<span style="display:inline-block;width:42px"></span>';
  const anyIcon = relic.rewards.some((reward) => reward.iconDataUri);
  const rows = relic.rewards.map((reward) => {
    const basis = reward.marketBasis === 'today' ? '今日' : reward.marketBasis === '90days' ? '90日' : '';
    const price = reward.platinum == null ? '—' : `${currency('plat', reward.platinum, { size: 12, color: '#e8d58c', weight: 800 })}<div style="margin-top:1px;font-size:8px;color:#7f8b97;font-weight:600">${basis} · 日均${escapeHtml(reward.dailyVolume ?? '—')}</div>`;
    return `<tr class="reward" style="height:52px"><td class="rarity ${escapeHtml(reward.rarity)}">${escapeHtml(rarityLabel[reward.rarity])}</td><td class="reward-name">${anyIcon ? rewardIcon(reward) : ''}${escapeHtml(reward.zhName)}</td><td class="plat" style="height:52px">${price}</td><td class="ducat">${reward.ducats == null ? '—' : currency('ducat', reward.ducats, { size: 12, color: '#f0d48e', weight: 800 })}</td><td class="eff">${escapeHtml(reward.ducatsPerPlatinum ?? '—')}</td></tr>`;
  }).join('');
  // 精炼四档期望区：★=建议档；口径与上表一致（可靠成交中位）
  const refine = relic.refine;
  const refineRows = refine ? refine.tiers.map((tier) => {
    const picked = tier.key === refine.suggest.key;
    return `<tr class="reward"${picked ? ' style="background:rgba(240,199,101,.10)"' : ''}><td class="rarity" style="color:#f0c765;font-weight:800">${picked ? '★' : ''}</td><td class="reward-name">${escapeHtml(tier.zh)} <span style="color:#8f9aa6;font-size:12px;font-weight:500">${tier.traces} 光体</span></td><td class="plat">${currency('plat', tier.plat, { size: 12, color: '#e8d58c', weight: 800 })}</td><td class="ducat" colspan="2">${currency('ducat', Math.round(tier.ducats), { size: 12, color: '#f0d48e', weight: 800 })}</td></tr>`;
  }).join('') : '';
  const refineBlock = refine ? `<tr class="section"><td colspan="5">精炼期望（${(data.squad ?? 4) > 1 ? `${data.squad ?? 4} 人组队取最优` : '单人'}）· 建议${escapeHtml(refine.suggest.zh)}：${escapeHtml(refine.suggest.reason)}</td></tr>${refineRows}` : '';
  // 掉落来源区：top3 掉点+概率；已入库/查无掉点给一行说明（开袋、悬赏轮换或交易获取）
  const sources = Array.isArray(relic.sources) ? relic.sources : [];
  const sourceRows = sources.length
    ? sources.map((source) => `<tr class="reward" style="height:38px"><td></td><td class="reward-name" colspan="2" style="height:38px;font-size:14px;font-weight:600;color:#cfd6dc">${escapeHtml(source.place)}</td><td class="eff" colspan="2" style="height:38px">${escapeHtml(Math.round(source.chance * 10) / 10)}%</td></tr>`).join('')
    : `<tr class="reward" style="height:38px"><td></td><td colspan="4" style="height:38px;font-size:13px;color:#9aa3ad">${relic.vaulted ? '已入库：无常规掉点，靠开袋复刻、瓦奇娅或玩家交易获取' : '当前掉落表查无常规掉点'}</td></tr>`;
  const sourceBlock = `<tr class="section"><td colspan="5">掉落来源${sources.length ? ' · 概率最高前 ' + sources.length : ''}</td></tr>${sourceRows}`;
  const actions = renderNextActions(data.nextActions);
  const height = 468 + (refine ? 28 + refine.tiers.length * 47 : 0) + 28 + Math.max(sources.length, 1) * 39 + (actions ? NEXT_ACTIONS_HEIGHT : 0);
  // 标题头纪元图标：英文遗物名首段即 tier 键（Lith S3），无素材退无图
  const headTier = String(relic.name || '').match(/^(Lith|Meso|Neo|Axi|Requiem|Omnia)/iu)?.[1];
  const headTierKey = headTier ? headTier[0].toUpperCase() + headTier.slice(1).toLowerCase() : '';
  const headIcon = RELIC_ICON_DATA[headTierKey]
    ? `<img src="${RELIC_ICON_DATA[headTierKey]}" width="46" height="46" style="flex:0 0 auto;object-fit:contain">`
    : '';
  const content = `<div class="card"><div class="relic-head" style="display:flex;align-items:center;gap:14px">${headIcon}<div style="min-width:0"><div class="relic-title">${relic.vaulted ? '已入库遗物' : '未入库遗物'}</div><div class="relic-code">${escapeHtml(relic.zhName)}</div></div><div class="relic-note">估值 = 今日/90日成交中位<br>效率 = 杜卡德 ÷ 白金（越高越适合换杜）</div></div><table><colgroup><col style="width:10%"><col style="width:48%"><col style="width:16%"><col style="width:13%"><col style="width:13%"></colgroup><thead class="relic-table-head"><tr><th></th><th class="reward-col">奖励</th><th>估值</th><th>杜卡德</th><th>效率</th></tr></thead><tbody>${rows}${refineBlock}${sourceBlock}</tbody></table>${actions}<div class="foot"><span>遗物资料＋星际战甲市场；发「遗物 编号 单人」换单人口径</span><span>${escapeHtml(formatTime(data.fetchedAt))}</span></div></div>`;
  const quoteKey = relic.rewards.map((reward) => `${reward.slug || reward.name}:${reward.platinum ?? ''}:${reward.marketBasis || ''}:${reward.dailyVolume ?? ''}`).join('|');
  return { html: cardDocument(content, height), width: 600, height, key: `relic10-${relic.name}-s${data.squad ?? 4}-i${relic.rewards.filter((reward) => reward.iconDataUri).length}-d${sources.length}-${createHash('sha1').update(quoteKey).digest('hex').slice(0, 8)}` };
}

function localizeRelicName(name) {
  const match = String(name || '').match(/^(Lith|Meso|Neo|Axi|Requiem|Omnia|Vanguard)\s+(.+)$/iu);
  if (!match) return String(name || '未知遗物');
  const era = match[1][0].toUpperCase() + match[1].slice(1).toLowerCase();
  return `${ERA_ZH[era] || era} ${match[2].toUpperCase()}`;
}

function buildRelicReverseCard(data) {
  const visible = data.matches.slice(0, 18);
  const unvaultedCount = data.matches.filter((item) => !item.vaulted).length;
  const vaultedCount = data.matches.filter((item) => item.vaulted).length;
  // 有任一行带掉点来源就整体升行高，来源小字统一放命中奖励下方（无来源的行只是空一行，列仍对齐）
  const anySource = visible.some((item) => item.source);
  const rowH = anySource ? 54 : 42;
  const rows = visible.map((item) => {
    const rewards = item.rewards.map((reward) => reward.zhName).join('、');
    // 纪元图标：英文遗物名首段即 tier 键（Lith A1）；无素材时 26px 占位保持列对齐；
    // 固定缩进+左对齐（不整体居中）：让「古纪/前纪」字样竖向成列，B10 的尾字符向右冒出（用户 2026-08-06 点名）
    const tier = String(item.name || '').match(/^(Lith|Meso|Neo|Axi|Requiem|Omnia)/iu)?.[1];
    const tierKey = tier ? tier[0].toUpperCase() + tier.slice(1).toLowerCase() : '';
    const icon = RELIC_ICON_DATA[tierKey]
      ? `<img src="${RELIC_ICON_DATA[tierKey]}" width="26" height="26" style="flex:0 0 auto;object-fit:contain">`
      : '<span style="flex:0 0 26px"></span>';
    // 概率最高的一个掉点：未入库显示「掉点 xxx 7.69%」，已入库无掉点该行留白
    const sourceLine = anySource
      ? `<div style="margin-top:2px;font-size:10px;color:#8f9aa6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${item.source ? `掉点 ${escapeHtml(item.source.place)} ${escapeHtml(item.source.chance)}%` : ''}</div>`
      : '';
    return `<tr class="reverse" style="height:${rowH}px"><td class="vault-state ${item.vaulted ? 'vaulted' : 'unvaulted'}" style="height:${rowH}px">${item.vaulted ? '已入库' : '未入库'}</td><td class="reverse-relic" style="height:${rowH}px"><span style="display:flex;align-items:center;gap:6px;padding-left:28px">${icon}<span>${escapeHtml(localizeRelicName(item.name))}</span></span></td><td class="reverse-hit" style="height:${rowH}px"><div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(rewards)}</div>${sourceLine}</td></tr>`;
  }).join('');
  const actions = renderNextActions(data.nextActions);
  const height = 156 + visible.length * rowH + (actions ? NEXT_ACTIONS_HEIGHT : 0);
  // 头部物品图：查询物的 wm 缩略图（renderCard 里解析），无图降级纯文字头
  const headIcon = data.headIconDataUri
    ? `<img src="${data.headIconDataUri}" width="46" height="46" style="flex:0 0 auto;object-fit:contain">`
    : '';
  const content = `<div class="card"><div class="relic-head" style="display:flex;align-items:center;gap:14px">${headIcon}<div style="min-width:0"><div class="relic-title">反向遗物查询</div><div class="relic-code">${escapeHtml(data.query)}</div></div><div class="relic-note">${escapeHtml(data.total)} 个相关遗物<br>未入库 ${unvaultedCount} · 已入库 ${vaultedCount}</div></div><table><colgroup><col style="width:18%"><col style="width:28%"><col style="width:54%"></colgroup><thead class="reverse-head"><tr><th class="state-col">状态</th><th class="relic-col">遗物</th><th class="hit-col">命中奖励</th></tr></thead><tbody>${rows}</tbody></table>${actions}<div class="foot"><span>遗物反向索引${anySource ? ' · 掉点=概率最高来源' : ''}</span><span>${visible.length < data.total ? `显示 ${visible.length}/${data.total}` : escapeHtml(formatTime(data.fetchedAt))}</span></div></div>`;
  return { html: cardDocument(content, height), width: 600, height, key: `relic-reverse8-${data.query}-${visible.length}-${data.headIconDataUri ? 'i' : 'x'}-${anySource ? 's' : 'n'}` };
}

export function buildRelicFarmCard(data) {
  if (data.setMode) return buildRelicFarmSetCard(data);
  const rows = data.rows.map((row, index) => {
    const tier = String(row.relic.name || '').match(/^(Lith|Meso|Neo|Axi|Requiem|Omnia|Vanguard)/iu)?.[1];
    const tierKey = tier ? tier[0].toUpperCase() + tier.slice(1).toLowerCase() : '';
    const icon = RELIC_ICON_DATA[tierKey]
      ? `<img src="${RELIC_ICON_DATA[tierKey]}" width="30" height="30" style="object-fit:contain;flex:0 0 auto">`
      : '<span style="width:30px;flex:0 0 30px"></span>';
    const owned = row.relic.ownedCount == null ? '' : row.relic.ownedCount > 0
      ? `<span style="color:#73e4be">库存 ×${escapeHtml(row.relic.ownedCount)}</span>`
      : '<span style="color:#84909b">库存 0</span>';
    const state = row.relic.vaulted ? '<span style="color:#d7a46d">已入库</span>' : '<span style="color:#8ee3ad">未入库</span>';
    const sources = row.sources.length ? row.sources.map((source) => {
      const color = source.availability === 'current' ? '#73e4be' : source.availability === 'always' ? '#9ed7ff' : '#d7b67a';
      return `<div style="display:flex;gap:7px;align-items:baseline;white-space:nowrap;overflow:hidden"><span style="color:${color};font-weight:800;flex:0 0 auto">${escapeHtml(source.availabilityZh)}</span><span style="overflow:hidden;text-overflow:ellipsis">${escapeHtml(source.place)}</span><span style="color:#f0d48e;flex:0 0 auto">${escapeHtml(source.chance)}%</span><span style="color:#98a6b4;flex:0 0 auto">联合 ${escapeHtml(source.combinedChance)}%</span></div>`;
    }).join('') : `<div style="color:#8f9aa6">${row.relic.vanguard ? '先锋遗物 · 瓦奇娅限时阿耶兑换，当前未开放' : row.relic.vaulted ? '没有常规掉点；检查库存、复刻或交易' : '当前掉落表查无可靠来源'}</div>`;
    return `<div style="min-height:108px;padding:14px 24px;border-bottom:1px solid rgba(164,116,54,.38);display:grid;grid-template-columns:40px 230px 1fr;gap:14px;align-items:start"><div style="font-size:24px;color:#b6c3d3;font-weight:800">${index + 1}</div><div><div style="display:flex;align-items:center;gap:9px;font-size:19px;font-weight:900;color:#70e0db">${icon}${escapeHtml(row.relic.zhName || localizeRelicName(row.relic.name))}</div><div style="margin-top:7px;font-size:14px">${state}${owned ? ` · ${owned}` : ''}</div><div style="margin-top:4px;font-size:13px;color:#aeb8c3">目标${row.target.rarity === 'rare' ? '稀有' : row.target.rarity === 'uncommon' ? '罕见' : '常见'} · 建议${escapeHtml(row.refinement.zh)} ${escapeHtml(row.refinement.chance)}%</div></div><div style="font-size:14px;line-height:1.7;color:#d5dbe2">${Number(row.relic.ownedCount) > 0 ? '<div style="color:#73e4be;font-weight:800">先开现有库存</div>' : ''}${sources}</div></div>`;
  }).join('');
  const actions = renderNextActions(data.nextActions);
  const height = 150 + Math.max(1, data.rows.length) * 108 + 46 + (actions ? NEXT_ACTIONS_HEIGHT : 0);
  const headIcon = data.headIconDataUri
    ? `<img src="${data.headIconDataUri}" width="54" height="54" style="object-fit:contain;flex:0 0 auto">`
    : '';
  const bountyNote = data.bountyChecked ? '已核对当前开放世界悬赏' : '赏金实时校验不可用 · 未声称当前开放';
  const content = `<div class="card"><div class="relic-head" style="height:108px;display:flex;align-items:center;gap:16px;padding-left:26px;padding-right:26px">${headIcon}<div style="min-width:0;flex:1"><div class="relic-title">Prime 部件 · 获取路线</div><div class="relic-code" style="font-size:30px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(data.target.zhName || data.target.name)}</div></div><div class="relic-note">${escapeHtml(data.total)} 枚相关遗物<br>${escapeHtml(bountyNote)}</div></div><div style="height:42px;padding:10px 24px;background:#303640;border-bottom:1px solid #59616b;font-size:14px;font-weight:800;color:#e9eef4">库存优先 → 当前可刷 → 条件/轮换来源</div>${rows}${actions}<div class="foot"><span>联合概率=遗物掉率×目标开奖率 · 不代表每分钟效率</span><span>${escapeHtml(formatTime(data.fetchedAt))}</span></div></div>`;
  return { html: cardDocument(content, height, 780), width: 780, height, key: `relic-farm4-${data.target.slug || data.target.name}-${data.rows.length}-${data.inventoryAvailable ? 'p' : 'x'}-${data.bountyChecked ? 'b' : 'u'}` };
}

export function buildRelicFarmSetCard(data) {
  const setName = data.set.zhName || data.set.name;
  const rows = data.components.map((component, index) => {
    const row = component.route;
    if (!row) return '';
    const componentName = String(component.target.zhName || component.target.name).replace(`${setName} `, '').replace(/\s+/gu, ' ');
    const owned = row.relic.ownedCount == null ? '' : row.relic.ownedCount > 0
      ? `<span style="color:#73e4be">库存 ×${escapeHtml(row.relic.ownedCount)}</span>`
      : '<span style="color:#84909b">库存 0</span>';
    const routeText = row.sources.length
      ? row.sources.map((source) => `<div style="display:grid;grid-template-columns:90px minmax(0,1fr) 180px;gap:8px"><span style="color:${source.availability === 'current' ? '#73e4be' : '#9ed7ff'};font-weight:800">${escapeHtml(source.availabilityZh)}</span><span>${escapeHtml(source.place)}</span><span style="color:#aeb8c3">遗物 ${escapeHtml(source.chance)}% · 联合 ${escapeHtml(source.combinedChance)}%</span></div>`).join('')
      : `<div style="color:#8f9aa6">${row.relic.vanguard ? '先锋遗物 · 瓦奇娅限时阿耶兑换，当前未开放' : row.relic.vaulted ? '没有常规掉点；检查库存、复刻或交易' : '当前掉落表查无可靠来源'}</div>`;
    const alternatives = (component.alternatives || []).map((entry) => `${entry.relic.zhName || localizeRelicName(entry.relic.name)}${Number(entry.relic.ownedCount) > 0 ? `（库存×${entry.relic.ownedCount}）` : entry.relic.vaulted ? '（已入库）' : ''}`).join('　');
    const componentIcon = component.iconDataUri
      ? `<div style="width:64px;height:64px;border-radius:14px;background:radial-gradient(circle,rgba(88,213,204,.17),rgba(20,25,32,.3));border:1px solid rgba(112,224,219,.22);display:flex;align-items:center;justify-content:center;flex:0 0 auto"><img src="${component.iconDataUri}" width="56" height="56" style="object-fit:contain"></div>`
      : '';
    return `<div style="height:210px;padding:20px 26px;border-bottom:1px solid rgba(164,116,54,.38);display:grid;grid-template-columns:38px 274px 1fr;gap:16px;align-items:start"><div style="font-size:25px;color:#b6c3d3;font-weight:800">${index + 1}</div><div><div style="display:flex;align-items:center;gap:13px;min-height:64px">${componentIcon}<div style="min-width:0"><div style="font-size:21px;font-weight:900;color:#70e0db">${escapeHtml(componentName)}</div><div style="margin-top:5px;font-size:16px;font-weight:800;color:#eef2f6;white-space:nowrap">首选 ${escapeHtml(row.relic.zhName || localizeRelicName(row.relic.name))}</div></div></div><div style="margin-top:9px;font-size:14px">${row.relic.vaulted ? '<span style="color:#d7a46d">已入库</span>' : '<span style="color:#8ee3ad">未入库</span>'}${owned ? ` · ${owned}` : ''}</div><div style="margin-top:8px;font-size:13px;color:#7f8c99">共 ${escapeHtml(component.relatedRelics)} 枚相关遗物</div></div><div style="font-size:14px;line-height:1.75;color:#d5dbe2"><div style="font-size:16px;font-weight:800;color:#f0d48e">建议${escapeHtml(row.refinement.zh)} · 目标开奖率 ${escapeHtml(row.refinement.chance)}%</div>${Number(row.relic.ownedCount) > 0 ? '<div style="color:#73e4be;font-weight:800">先开现有库存，再考虑继续获取</div>' : ''}${routeText}${alternatives ? `<div style="margin-top:9px;padding-top:7px;border-top:1px solid rgba(127,140,153,.25);color:#8f9aa6">备选遗物：${escapeHtml(alternatives)}</div>` : ''}</div></div>`;
  }).join('');
  const actions = renderNextActions(data.nextActions);
  const height = 150 + data.components.length * 210 + 46 + (actions ? NEXT_ACTIONS_HEIGHT : 0);
  const headIcon = data.headIconDataUri ? `<div style="width:132px;height:92px;border-radius:18px;background:radial-gradient(circle,rgba(231,190,106,.2),rgba(20,25,32,.15));border:1px solid rgba(240,212,142,.24);display:flex;align-items:center;justify-content:center;flex:0 0 auto"><img src="${data.headIconDataUri}" width="122" height="84" style="object-fit:contain"></div>` : '';
  const bountyNote = data.bountyChecked ? '已核对当前开放世界悬赏' : '赏金实时校验不可用';
  const content = `<div class="card"><div class="relic-head" style="height:108px;display:flex;align-items:center;gap:20px;padding-left:24px;padding-right:28px;background:linear-gradient(118deg,#20373c 0%,#29323b 49%,#493b2d 100%)">${headIcon}<div style="min-width:0;flex:1"><div class="relic-title">Prime 套装 · 获取总览</div><div class="relic-code" style="font-size:34px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(setName)}</div></div><div class="relic-note">${escapeHtml(data.components.length)} 个部件<br>${escapeHtml(bountyNote)}</div></div><div style="height:42px;padding:0 26px;display:flex;align-items:center;background:#303640;border-bottom:1px solid #59616b;font-size:14px;font-weight:800;color:#e9eef4">每个部件：库存优先 → 当前最优遗物 → 两条来源与备选遗物</div>${rows}${actions}<div class="foot"><span>先锋＝瓦奇娅限时阿耶兑换 · 发送“获取 具体部件”查看全部候选</span><span>${escapeHtml(formatTime(data.fetchedAt))}</span></div></div>`;
  return { html: cardDocument(content, height, 900), width: 900, height, key: `relic-farm-set9-${data.set.slug || data.set.name}-${data.components.length}-${data.inventoryAvailable ? 'p' : 'x'}-${data.bountyChecked ? 'b' : 'u'}-${data.headIconDataUri ? 'i' : 'x'}` };
}

// ---- 帮助卡：由单一命令注册表生成（零网络） ----
function helpSectionsForTopic(topic = null) {
  if (topic?.kind === 'section') return buildHelpSections({ sectionId: topic.sectionId });
  return [];
}

function helpTitleForTopic(topic = null) {
  if (topic?.kind === 'section') return `模块帮助 · ${getHelpSection(topic.sectionId)?.title || topic.text}`;
  return '功能总览';
}

function helpNoteForTopic(topic = null) {
  if (topic?.kind === 'section') return '查看本模块的完整指令与说明';
  return '先看全部模块<br>再进入模块查看指令';
}

function buildHelpModuleRows() {
  return listHelpSections().map((section) => ({
    command: `帮助 ${section.helpQuery}`,
    description: `${section.title} · ${section.summary}`,
  }));
}

export function buildHelpCard(topic = null) {
  const sections = helpSectionsForTopic(topic);
  const moduleRows = topic?.kind === 'section' ? [] : buildHelpModuleRows();
  const rows = moduleRows.length
    ? `<tr class="section"><td colspan="2">全部功能模块</td></tr>${moduleRows.map((item) => `<tr class="help"><td class="help-cmd">${escapeHtml(item.command)}</td><td class="help-desc">${escapeHtml(item.description)}</td></tr>`).join('')}`
    : sections.map(({ title, commands }) =>
      `<tr class="section"><td colspan="2">${escapeHtml(title)}</td></tr>`
      + commands.map((item) => {
      const commandText = item.privacyScope === 'userPrivate' && !item.command.includes('🔒') ? `${item.command} 🔒` : item.command;
      return `<tr class="help"><td class="help-cmd">${escapeHtml(commandText)}</td><td class="help-desc">${escapeHtml(item.description)}</td></tr>`;
      }).join('')
    ).join('');
  const sectionCount = moduleRows.length ? 1 : sections.length;
  const rowCount = moduleRows.length || sections.reduce((count, section) => count + section.commands.length, 0);
  const height = 92 + sectionCount * 29 + rowCount * 38 + 34 + 6;
  const displayedCommands = moduleRows.length ? moduleRows.map((item) => item.command) : sections.flatMap((section) => section.commands.map((item) => item.command));
  const maxCommandLength = displayedCommands.reduce((max, command) => Math.max(max, [...String(command)].length), 0);
  const commandWidth = maxCommandLength > 22 ? 48 : maxCommandLength > 16 ? 46 : maxCommandLength > 12 ? 42 : 38;
  const content = `<div class="card"><div class="relic-head"><div class="relic-title">Warframe 助手</div><div class="relic-code">${escapeHtml(helpTitleForTopic(topic))}</div><div class="relic-note">${helpNoteForTopic(topic)}</div></div><table><colgroup><col style="width:${commandWidth}%"><col style="width:${100 - commandWidth}%"></colgroup><tbody>${rows}</tbody></table><div class="foot"><span>🔒 = 仅用户私聊 · 发送「帮助 模块名」查看该模块全部指令</span><span>发「帮助」返回总览</span></div></div>`;
  const digest = createHash('sha256').update(content).digest('hex').slice(0, 12);
  return { html: cardDocument(content, height, 760), width: 760, height, key: `help-${digest}` };
}

export function formatHelp(topic = null) {
  const sections = helpSectionsForTopic(topic);
  const lines = [`【${helpTitleForTopic(topic)}】`];
  if (!topic || topic.kind === 'main') {
    for (const section of listHelpSections()) {
      lines.push(`${section.title}：帮助 ${section.helpQuery}（${section.summary}）`);
    }
    lines.push('进入模块后会显示该模块的全部相关指令。');
    lines.push('也可以直接用自然语言描述想查什么。');
    return lines.join('\n');
  }
  for (const { commands } of sections) {
    for (const item of commands) {
      const privacy = item.privacyScope === 'userPrivate' ? '（仅用户私聊）' : '';
      lines.push(`${item.command}${privacy}：${item.description}`);
    }
  }
  if (!sections.length) lines.push('当前主题没有可展示的命令。');
  lines.push('说人话也行：「奸商来了吗」「这周还剩啥没做」「战刃哪里出」「悟空Prime系统蓝图哪里刷」');
  return lines.join('\n');
}

async function findBrowser() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* continue */ }
  }
  return null;
}

async function renderCard(data, cardDir) {
  if (!cardDir || !data?.ok) return null;
  const browser = await findBrowser();
  if (!browser) return null;
  if (data.kind === 'fissure') return renderWarframeCard(buildFissureQueryCard(data), cardDir);
  // 物品图在渲染前解析（下载+缓存+base64），失败保持 null 无图降级；放这里不进模型注入素材
  if (data.kind === 'market' && data.item && data.item.iconDataUri === undefined) {
    const [{ marketDisplayImageUrl }, { imageDataUri, primeWarframePartIconDataUri }] = await Promise.all([import('./drops.mjs'), import('./wfdata.mjs')]);
    const marketImageUrl = marketDisplayImageUrl(data.item);
    data.item.iconDataUri = marketImageUrl ? await imageDataUri(marketImageUrl) : null;
    if (!data.item.iconDataUri) data.item.iconDataUri = await primeWarframePartIconDataUri(null, data.item.name);
  }
  // 遗物正查：六奖励行优先配 wm 部件副图，主蓝图保留成品主图；无 slug 奖励（Forma 蓝图）无图留空
  if (data.kind === 'relic' && data.mode === 'forward' && Array.isArray(data.relic?.rewards)) {
    const [{ marketDisplayImageUrl }, { imageDataUri, primeWarframePartIconDataUri }] = await Promise.all([import('./drops.mjs'), import('./wfdata.mjs')]);
    for (const reward of data.relic.rewards) {
      if (reward.iconDataUri !== undefined) continue;
      const marketImageUrl = marketDisplayImageUrl(reward);
      reward.iconDataUri = marketImageUrl ? await imageDataUri(marketImageUrl) : null;
      if (!reward.iconDataUri) reward.iconDataUri = await primeWarframePartIconDataUri(null, reward.name);
    }
    // wm 缺图（新 Prime 未上图，Vadarya 实锤）：AlecaFrame 目录英文名→imageName 兜底；无 AlecaFrame 静默降级
    if (data.relic.rewards.some((reward) => !reward.iconDataUri && reward.name)) {
      try {
        const { loadCatalog, defaultAlecaDir } = await import('./drops.mjs');
        const catalog = await loadCatalog(defaultAlecaDir());
        const byEnglish = new Map();
        for (const meta of catalog.values()) {
          const key = String(meta.englishName || '').toLowerCase().replace(/\s+/gu, '');
          if (key && meta.imageName && !byEnglish.has(key)) byEnglish.set(key, meta.imageName);
        }
        for (const reward of data.relic.rewards) {
          if (reward.iconDataUri || !reward.name) continue;
          const key = String(reward.name).toLowerCase().replace(/\s+/gu, '');
          // 奖励名带 Blueprint 尾缀而目录部件不带（Neuroptics Blueprint→Neuroptics），双键查
          const imageName = byEnglish.get(key) || byEnglish.get(key.replace(/blueprint$/u, ''));
          if (imageName) reward.iconDataUri = await imageDataUri(`https://cdn.alecaframe.com/warframeData/img/${imageName}`);
        }
      } catch { /* 无图降级 */ }
    }
  }
  // 遗物反查：头部配查询物的 wm 缩略图（首个命中奖励的英文名查目录，失败无图降级）
  if (data.kind === 'relic' && data.mode === 'reverse' && data.headIconDataUri === undefined) {
    data.headIconDataUri = null;
    try {
      const firstName = data.matches?.[0]?.rewards?.[0]?.name;
      if (firstName) {
        const [{ marketSlugMap, findMarketEntry, marketDisplayImageUrl }, { imageDataUri, primeWarframePartIconDataUri }] = await Promise.all([import('./drops.mjs'), import('./wfdata.mjs')]);
        const entry = findMarketEntry(await marketSlugMap(), firstName);
        const marketImageUrl = marketDisplayImageUrl(entry);
        data.headIconDataUri = marketImageUrl ? await imageDataUri(marketImageUrl) : null;
        if (!data.headIconDataUri) data.headIconDataUri = await primeWarframePartIconDataUri(null, firstName);
      }
    } catch { /* 无图降级 */ }
  }
  if (data.kind === 'relic-farm' && data.headIconDataUri === undefined) {
    data.headIconDataUri = null;
    if (data.setMode) try {
      const [{ loadCatalog, defaultAlecaDir, marketSlugMap, marketDisplayImageUrl }, { imageDataUri, primeWarframePartIconDataUri }] = await Promise.all([import('./drops.mjs'), import('./wfdata.mjs')]);
      const catalog = [...(await loadCatalog(defaultAlecaDir())).values()];
      const catalogImage = (name, allowBlueprintFallback = false) => {
        const normalized = String(name || '').toLowerCase().replace(/\s+/gu, ' ').trim();
        const withoutBlueprint = normalized.replace(/\s+blueprint$/u, '');
        const entry = catalog.find((candidate) => String(candidate.englishName || '').toLowerCase() === normalized)
          || catalog.find((candidate) => String(candidate.englishName || '').toLowerCase() === withoutBlueprint);
        if (!entry?.imageName || (!allowBlueprintFallback && entry.imageName === 'blueprint.png')) return null;
        return `https://cdn.alecaframe.com/warframeData/img/${entry.imageName}`;
      };
      data.headIconDataUri = await imageDataUri(catalogImage(data.set?.name));
      let entries = null;
      if (!data.headIconDataUri) {
        entries = [...(await marketSlugMap()).values()];
        const setEntry = entries.find((entry) => entry.slug === `${data.set?.slug}_set`);
        const setImageUrl = marketDisplayImageUrl(setEntry);
        data.headIconDataUri = setImageUrl ? await imageDataUri(setImageUrl) : null;
      }
      await Promise.all((data.components || []).map(async (component) => {
        if (component.iconDataUri !== undefined) return;
        component.iconDataUri = await imageDataUri(catalogImage(component.target?.name, true));
        if (!component.iconDataUri) {
          entries ||= [...(await marketSlugMap()).values()];
          const entry = entries.find((candidate) => candidate.slug === component.target?.slug);
          const subIconUrl = entry?.subIcon ? `https://warframe.market/static/assets/${entry.subIcon}` : null;
          component.iconDataUri = subIconUrl ? await imageDataUri(subIconUrl) : null;
        }
        if (!component.iconDataUri) component.iconDataUri = await primeWarframePartIconDataUri(null, component.target?.name);
      }));
    } catch { /* 无图降级 */ }
    else try {
      const [{ marketSlugMap, findMarketEntry, marketDisplayImageUrl }, { imageDataUri, primeWarframePartIconDataUri }] = await Promise.all([import('./drops.mjs'), import('./wfdata.mjs')]);
      const imageTarget = data.target?.name || data.target?.zhName;
      const entry = findMarketEntry(await marketSlugMap(), imageTarget);
      const marketImageUrl = marketDisplayImageUrl(entry);
      data.headIconDataUri = marketImageUrl ? await imageDataUri(marketImageUrl) : null;
      if (!data.headIconDataUri) data.headIconDataUri = await primeWarframePartIconDataUri(null, imageTarget);
    } catch { /* 无图降级 */ }
  }
  const card = data.kind === 'market' ? buildMarketCard(data)
    : data.kind === 'help' ? buildHelpCard(data.helpTopic)
      : data.kind === 'relic-farm' ? buildRelicFarmCard(data)
      : data.mode === 'reverse' ? buildRelicReverseCard(data) : buildRelicCard(data);
  const stem = card.key.replace(/[^a-z0-9_-]+/giu, '-').replace(/^-+|-+$/gu, '').toLowerCase().slice(0, 50) || 'card';
  const digest = createHash('sha256').update(card.key).digest('hex').slice(0, 10);
  const safeKey = `${stem}-${digest}`;
  await mkdir(cardDir, { recursive: true });
  await pruneOldCards(cardDir);
  const htmlPath = path.join(cardDir, `${safeKey}.html`);
  const pngPath = path.join(cardDir, `${safeKey}.png`);
  const profilePath = await mkdtemp(path.join(cardDir, '.chrome-'));
  await writeFile(htmlPath, card.html, 'utf8');
  try {
    await execFileAsync(browser, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-default-browser-check',
      '--force-device-scale-factor=2',
      `--user-data-dir=${profilePath}`,
      `--window-size=${card.width},${card.height}`,
      `--screenshot=${pngPath}`,
      pathToFileURL(htmlPath).href,
    ], { timeout: 20_000, windowsHide: true, maxBuffer: 1024 * 1024 });
    await access(pngPath);
    await compressCardPng(pngPath);
    return pngPath;
  } finally {
    await rm(profilePath, { recursive: true, force: true }).catch(() => {});
  }
}

function compactFollowup(data) {
  if (data.kind === 'fissure') {
    const filter = data.query ? ` · 筛选：${data.query}` : '';
    return `当前裂缝 ${data.total} 条${filter}`;
  }
  if (data.kind === 'market') {
    // 只发纯 /w 模板：插件随图文字只放行 /w 开头的内容，且用户长按复制即可直接粘进游戏
    return data.contactTemplate || null;
  }
  if (data.kind === 'relic-farm') {
    if (data.setMode) return `${data.set.zhName || data.set.name}｜已按四个部件分别给出库存优先的获取路线；具体部件可继续单独查询。`;
    return `${data.target.zhName || data.target.name}｜先开库存，再按“当前赏金/常驻掉点/轮换池”选择获取路线。`;
  }
  if (data.mode === 'reverse') {
    return `“${data.query}”反向查询：共找到 ${data.total} 个相关遗物；卡片最多显示前18项。`;
  }
  return `${data.relic.zhName}｜估值优先采用可靠今日成交中位，样本不足回退 90 日成交中位。`;
}

// ---- 自然语言问价（试点）：识别「X多少钱/什么价」类问句 ----
// 句尾价格短语；允许结尾语气词和标点
const NATURAL_PRICE_TAIL = /(?:现在|目前|大概|大约|一般)?\s*(?:多少钱|什么价|啥价|价格(?:是?多少)?|市价|值多少(?:钱|白金)?|(?:能)?卖多少(?:钱|白金)?|多少\s*(?:p|白金|铂金))\s*(?:啊|呀|呢|了|哇|哦|捏)?\s*[?？!！。.~～\s]*$/iu;
// 句首寒暄/请求/时间副词前缀，全部剥掉再取物品名（「现在X多少钱」的现在在句首，tail 里那个只消费紧贴价格短语的）
const NATURAL_PRICE_LEAD = /^(?:请问|问一下|问问|帮我查一下|帮我查查|帮我看看|帮我看一下|查一下|查查|看一下|看看|那个|现在|目前)\s*/iu;
// 「…多少钱？满级的」：等级限定语补在问价短语后面，先摘出来再匹配句尾价格短语
const NATURAL_PRICE_RANK_TAIL = /[?？!！。.~～\s]*(满级|满阶|(?:等级\s*)?\d{1,2}\s*级|r\s*\d{1,2}|rank\s*\d{1,2})\s*的?\s*[?？!！。.~～\s]*$/iu;

export function parseNaturalMarketQuestion(message) {
  const text = normalizeUnicode(message);
  if (!text || text.length > 40) return null;
  if (parseShortcutMessage(text)) return null; // 已是短命令，走硬拦截通道，不归这里管
  let body = text;
  let rankSuffix = null;
  const rankTail = body.match(NATURAL_PRICE_RANK_TAIL);
  if (rankTail && rankTail.index != null && rankTail.index > 0) {
    rankSuffix = rankTail[1].replace(/\s+/gu, '');
    body = body.slice(0, rankTail.index).trim();
  }
  const tail = body.match(NATURAL_PRICE_TAIL);
  if (!tail || tail.index == null) return null;
  let itemPart = body.slice(0, tail.index).trim();
  const prevLen = () => itemPart.length;
  do {
    const before = prevLen();
    itemPart = itemPart.replace(NATURAL_PRICE_LEAD, '').trim();
    if (itemPart.length === before) break;
  } while (itemPart);
  itemPart = itemPart.replace(/^(?:一个|一张|一套|一件)/u, '').replace(/[的地]$/u, '').trim();
  // 空（「多少钱」没主语）或过长（整句闲聊）都放弃，交回模型
  if (!itemPart || itemPart.length > 24) return null;
  return { itemQuery: rankSuffix ? `${itemPart} ${rankSuffix}` : itemPart };
}

// 把行情数据浓缩成给模型的点评素材；措辞/禁令集中在这里，改动无需重启 Gateway
function buildMarketModelContext(data) {
  const item = data.item || {};
  const facts = {};
  const put = (key, value) => { if (value != null && value !== '') facts[key] = value; };
  put('物品', item.zhName || item.name);
  if (item.rank != null) put('查询等级', `${item.rank}/${item.maxRank}`);
  put('当前最低卖价白金', data.sell?.[0]?.platinum);
  put('当前最高收价白金', data.buy?.[0]?.platinum);
  put('交易税', item.tradingTax);
  if (data.stats90) {
    put('90天成交中位价', data.stats90.median);
    put('90天日均成交笔数', data.stats90.dailyVolume);
    if (data.stats90.deviationPct != null) {
      put('当前卖价相对中位偏离', `${data.stats90.deviationPct > 0 ? '+' : ''}${data.stats90.deviationPct}%`);
    }
  }
  return [
    '[Warframe 助手·本轮系统上下文]',
    '用户这句问价已由确定性脚本处理：价格卡片图刚刚已经直接发送给用户，用户看得到图。',
    `底层行情数据（你唯一可用的数据来源，禁止另行检索或编造数字）：${JSON.stringify(facts)}`,
    '你的任务：只依据上面这份数据，用一两句口语化中文点评行情，给出观点（例如：和90天中位比偏贵还是划算、成交活不活跃、现在出手还是再等等）。',
    '硬性禁止：复读卡片上已有的数字清单；再发任何图片、MEDIA: 标记或 <qqimg> 标签；说「我帮你查一下」之类的过程话术；解释系统机制或道歉。直接给结论。',
  ].join('\n');
}

// 自然语言问价入口：识别失败/物品解析失败/渲染失败一律 handled:false 静默放行给模型，宁可漏不可错发
export async function runNaturalShortcut(message, options = {}) {
  const parsed = parseNaturalMarketQuestion(message);
  if (!parsed) return { handled: false, reason: 'no_intent' };
  const platform = options.platform || DEFAULT_PLATFORM;
  const crossplay = options.crossplay ?? DEFAULT_CROSSPLAY;
  const data = await queryMarket(parsed.itemQuery, platform, crossplay);
  if (!data.ok) return { handled: false, reason: data.error || 'query_failed', itemQuery: parsed.itemQuery };
  let mediaUrl = null;
  try {
    mediaUrl = await renderCard(data, options.cardDir || process.env.WARFRAME_CARD_DIR);
  } catch {
    mediaUrl = null;
  }
  if (!mediaUrl) return { handled: false, reason: 'render_failed', itemQuery: parsed.itemQuery };
  return {
    handled: true,
    ok: true,
    command: 'market-natural',
    query: parsed.itemQuery,
    mediaUrl,
    followupText: compactFollowup(data),
    modelContext: buildMarketModelContext(data),
  };
}

// 自然语言→既有短命令的路由（零网络）；命中后由插件走短命令同款发图通道，再把结果数据注入模型点评
export function parseNaturalWorldQuestion(message) {
  const text = normalizeUnicode(message);
  // 查询类问句都很短，长句多为闲聊——门收紧到 24 字宁漏不错发
  if (!text || text.length > 24) return null;
  if (parseShortcutMessage(text)) return null;

  // 功能总览：「你有什么功能」「你能干什么」「怎么用」
  if (/^你(?:都|还)?(?:有|会|支持)(?:什么|啥|哪些)(?:功能|命令|本事|能力|玩法)/u.test(text)
    || /^你(?:能|会|可以|都能)(?:干|做|帮)?(?:什么|啥)[呀啊呢嘞捏？?！!。.\s]*$/u.test(text)
    || /^(?:有|支持)(?:什么|啥|哪些)(?:功能|命令|玩法)/u.test(text)
    || /怎么用|使用帮助|功能介绍|帮助菜单|功能菜单|命令大全/iu.test(text)) {
    return { kind: 'help', command: '帮助', personal: false };
  }

  // 杜卡德兑换自然问法：「哪些部件适合换杜卡德」「帮我换 600 杜」
  if (/杜卡德|杜卡德币/u.test(text) && /换|兑换|清仓|部件|推荐|方案|怎么/u.test(text)) {
    const target = text.match(/(\d[\d,]*)\s*(?:杜|杜卡德|杜卡德币)/u)?.[1]?.replace(/,/gu, '') || '';
    const reserve = text.match(/保留\s*\d+\s*套?/u)?.[0]?.replace(/\s+/gu, '') || '';
    const clearance = /清仓/u.test(text) ? '清仓' : '';
    return { kind: 'ducat-plan', command: ['杜卡德', target, clearance, reserve].filter(Boolean).join(' '), personal: true };
  }

  // 精炼推荐：「哪些遗物值得精炼」「精炼什么」；先于开遗物判定（都含「值得」类词）
  if (/遗物.{0,4}(?:值得|该|要)精炼/u.test(text) || /精炼(?:什么|啥|哪个)/u.test(text) || /(?:值得|该)精炼/u.test(text)) {
    const solo = /单人|单排|solo/iu.test(text);
    return { kind: 'refine', command: solo ? '精炼推荐 单人' : '精炼推荐', personal: true };
  }

  // 开遗物：「有啥值得开的」「开什么好」「怎么开遗物合适」；“买 X 再开”自动对标指定奸商商品。
  if (/值得开|开.{0,2}(?:划算|赚|值)/u.test(text)
    || /^(?:现在)?开(?:点)?(?:什么|啥)好/u.test(text)
    || /(?:什么|啥|哪个)遗物(?:值得开|值钱|划算|好)/u.test(text)
    || /有(?:什么|啥)好(?:裂缝|遗物)/u.test(text)
    || /(?:(?:该)?怎么|如何).{0,4}开遗物/u.test(text)
    || /开遗物.{0,6}(?:怎么|如何|合适|划算|好)/u.test(text)) {
    const buyTargetMatch = text.match(/(?:我)?(?:先|想|要|准备)?买(?:奸商|虚空商人)?(?:的)?[「『]?(.{1,20}?)[」』]?[，,。！？!?；;\s]+(?:(?:该)?怎么|如何).{0,4}开遗物/u);
    const buyTarget = String(buyTargetMatch?.[1] || '').replace(/[「」『』]/gu, '').trim();
    const mode = buyTarget ? '' : (/杜卡德|奸商|虚空商人/u.test(text) ? '杜卡德' : '');
    const preference = /速刷|快速|快开|效率/u.test(text) ? '速刷'
      : /舒适|轻松|挂机/u.test(text) ? '舒适'
        : /收益|额外|长线/u.test(text) ? '收益' : '';
    const squad = /单人|单排|solo/iu.test(text) ? '单人' : '';
    return { kind: 'recommend', command: ['开遗物', mode, buyTarget, preference, squad].filter(Boolean).join(' '), personal: true };
  }

  // 虚空商人：提到奸商/虚空商人且带疑问要素；「买什么/值得买」走购物推荐（个人通道）
  if (/奸商|虚空商人/u.test(text)) {
    if (/买(?:什么|啥|点什么|点啥)|值得买|推荐/u.test(text)) {
      return { kind: 'trader-shopping', command: '奸商推荐', personal: true };
    }
    if (/来|走|带|到|在哪|什么时候|啥时候|吗|么|？|\?/u.test(text)) {
      return { kind: 'trader', command: '虚空商人', personal: false };
    }
  }

  // 本周好货：「有什么好货」「这周有啥值得买的」；奸商的「值得买」已被上方 trader 分支消费；先于商店意图（「商店有啥好货」落好货卡）
  if (/好货/u.test(text) || (/值得买|该买(?:什么|啥)|买(?:什么|啥)好/u.test(text) && /这周|本周|商店|最近/u.test(text))) {
    return { kind: 'weekly-deals', command: '本周好货', personal: true };
  }

  // 商店：「泰辛这周卖什么」「瓦奇娅当期有什么」「商店总览」；奸商已被上方 trader 分支消费不会落到这
  if (/商店|泰辛|瓦奇娅|圣言者|言录使|切片哥|璨璨珍宝|鸟三|达尔沃/u.test(text)
    && /卖(?:什么|啥)|有(?:什么|啥)|货单|上(?:什么|啥)|轮换(?:什么|啥|到什么)?|特惠|精选/u.test(text)) {
    const vendor = text.match(/泰辛|瓦奇娅|圣言者|言录使|切片哥|璨璨珍宝|鸟三|达尔沃/u)?.[0] || '';
    return { kind: 'shop', command: vendor ? `商店 ${vendor}` : '商店', personal: true };
  }

  // 突击：「今天突击是什么」「突击打什么」；「突击」本体是短命令已被 parseShortcutMessage 拦下
  if (/突击/u.test(text) && /(?:是什么|是啥|打什么|打啥|什么任务|啥任务|什么词缀|怎么样|吗|么|？|\?)/u.test(text)) {
    return { kind: 'sortie', command: '突击', personal: false };
  }

  // 钢铁侵袭：「今天侵袭有什么」「钢铁精华哪里刷」；必须先于下方遗物反查（「哪里刷」会被 whereDrop 抢走）
  if ((/侵袭/u.test(text) && /(?:是什么|是啥|有什么|有啥|打什么|打啥|什么任务|啥任务|在哪|怎么样|吗|么|？|\?)/u.test(text))
    || /钢铁精华.{0,6}(?:哪里|哪儿|哪|怎么)(?:能|可以)?(?:刷|出|掉|拿|获得|得)/u.test(text)) {
    return { kind: 'incursion', command: '钢铁侵袭', personal: false };
  }

  // 星球悬赏：「今天悬赏有什么」「希图斯赏金任务有啥」；带地名则直接出单区详情；同样先于 whereDrop
  if (/悬赏|赏金/u.test(text) && /(?:有什么|有啥|是什么|是啥|什么任务|啥任务|打什么|值得|怎么样|吗|么|？|\?)/u.test(text)) {
    const place = text.match(/希图斯|夜灵平野|福尔图娜|奥布山谷|歼世幽都|魔胎之境|火卫二/u)?.[0] || '';
    return { kind: 'bounty', command: place ? `悬赏 ${place}` : '悬赏', personal: false };
  }
  // 悬赏奖励反查：「哪个悬赏出X」「X哪个悬赏能拿」
  const bountyItem = text.match(/^(?:哪个|什么)悬赏(?:能|可以)?(?:出|掉|刷|拿|给)(.{1,16}?)$/u)
    || text.match(/^(.{1,16}?)(?:哪个|什么)悬赏(?:能|可以)?(?:出|掉|刷|拿|给)/u);
  if (bountyItem) {
    const item = String(bountyItem[1] || '').replace(/[啊呀呢了吗么?？!！。.~～\s]+$/u, '').trim();
    if (item && item.length <= 16) return { kind: 'bounty', command: `悬赏 ${item}`, personal: false };
  }

  // 轮换日历：「下期复刻什么」「Saryn 哪周进回廊」「泰辛下周卖什么」
  if ((/复刻|回廊|轮换/u.test(text) && /(?:下期|下次|下周|哪周|什么时候|啥时候|未来|排期|日历)/u.test(text))
    || /瓦奇娅.{0,6}(?:下期|下次|复刻|换期)/u.test(text)) {
    return { kind: 'rotation-calendar', command: '轮换日历', personal: true };
  }

  // 周常进度：「这周还有啥没做」「周常做完了吗」「还剩什么周常」
  if (/周常.{0,6}(?:没|还剩|完|做|干)/u.test(text)
    || /(?:这周|本周).{0,8}(?:没做|没干|还剩|做完|干完)/u.test(text)
    || /还(?:有|剩)(?:什么|啥)?周常/u.test(text)
    || /还有(?:什么|啥)(?:周常)?没(?:做|干|完成)/u.test(text)) {
    return { kind: 'weekly', command: '周常', personal: true };
  }

  // 哪里买：「X在哪买/哪里换」——买/换 语义走商店反查，区别于下方 whereDrop 的 出/掉/刷（掉落语义）。
  // 两种语序都收：物品在前（「诡文枭主哪里买」「诡文枭主在哪换」）或问词在前
  // （「哪里买 诡文枭主」「在哪换 诡文枭主」「怎么买 诡文枭主」）；问词在前优先，
  // 否则「在哪换 X」会被物品在前规则把「在」误当物品。
  const whereBuyVerbFirst = text.match(/^(?:去|在)?(?:哪里|哪儿|哪|怎么)(?:能|可以)?(?:买|换|兑换)(.{1,20}?)$/u);
  const whereBuyItemFirst = text.match(/^(.{1,20}?)(?:是|在|去)?(?:哪里|哪儿|哪)(?:能|可以)?(?:买|换|兑换)/u);
  const whereBuy = whereBuyVerbFirst || whereBuyItemFirst;
  if (whereBuy) {
    const item = String(whereBuy[1] || '').replace(/[啊呀呢了吗么?？!！。.~～\s]+$/u, '').trim();
    if (item && item.length <= 16) return { kind: 'where-to-buy', command: `购买 ${item}`, personal: false };
  }

  // 获取路线：「X哪里刷/怎么获得X」；与只列相关遗物的「哪里出」资料查询分开。
  const whereFarm = text.match(/^(.{1,20}?)(?:是|在|去)?(?:哪里|哪儿|哪)(?:能|可以)?(?:刷|获得|拿)/u)
    || text.match(/^(?:怎么|如何)(?:刷|获得|拿)(.{1,20}?)$/u);
  if (whereFarm) {
    const item = String(whereFarm[1] || '').replace(/[啊呀呢了吗么?？!！。.~～\s]+$/u, '').trim();
    if (item && item.length <= 16) return { kind: 'relic-farm', command: `获取 ${item}`, personal: false };
  }

  // 遗物反查：「X哪里出」「哪个遗物出X」；物品名解析失败由调用方静默放行
  const whereDrop = text.match(/^(.{1,20}?)(?:是|在)?(?:哪里|哪儿|哪)(?:能|可以)?(?:出|掉)/u)
    || text.match(/^(?:哪里|哪儿|哪个遗物)(?:能|可以)?(?:出|掉|有)(.{1,20}?)$/u);
  if (whereDrop) {
    const item = String(whereDrop[1] || '').replace(/[啊呀呢了吗么?？!！。.~～\s]+$/u, '').trim();
    if (item && item.length <= 16) return { kind: 'relic-reverse', command: `遗物 ${item}`, personal: false };
  }

  return null;
}

export function parseShortcutMessage(message) {
  const text = normalizeUnicode(message);
  const routed = matchCommandText(text, 'shortcut-parser');
  if (!routed) return null;
  return { command: routed.commandId, query: routed.query };
}

export function buildShortcutNextActions(data, parsed = {}) {
  if (!data?.ok) return [];
  const query = String(parsed.query || data.query || '').trim();
  if (data.kind === 'market') {
    const name = data.item?.zhName || query;
    return /Prime|圣装|Prime\s*一套/iu.test(`${data.item?.name || ''} ${name}`)
      ? [{ command: `获取 ${name.replace(/\s*(?:一套|套装|Set)$/iu, '')}`, label: '查看获取路线' }]
      : [];
  }
  if (data.kind === 'relic-farm') {
    const name = data.setMode ? (data.set?.zhName || data.set?.name || query) : (data.target?.zhName || data.target?.name || query);
    return [{ command: `wm ${name}${data.setMode ? ' 一套' : ''}`, label: '查看市场价格' }, { command: `遗物 ${query}`, label: '查看相关遗物' }];
  }
  if (data.kind === 'relic') {
    if (data.mode === 'reverse') return [{ command: `获取 ${query}`, label: '规划获取路线' }];
    return [{ command: '裂缝', label: '查看当前裂缝' }];
  }
  if (data.kind === 'fissure') return [{ command: '开遗物', label: '按库存推荐遗物' }];
  if (data.kind === 'where-to-buy') {
    const actions = [{ command: `wm ${query}`, label: '查看玩家市场' }];
    const vendor = data.hits?.[0]?.vendorZh;
    if (vendor) actions.push({ command: `商店 ${vendor}`, label: '查看商人货单' });
    return actions;
  }
  return [];
}

export function buildShortcutContextEnvelope(data, parsed = {}) {
  if (!data?.ok) return null;
  const query = String(parsed.query || data.query || '').trim();
  let entity = null;
  let summary = '';
  if (data.kind === 'market') {
    entity = { type: 'market-item', displayName: data.item?.zhName || query, canonicalName: data.item?.name || data.item?.slug || query };
    summary = `最低在线卖价 ${data.sell?.[0]?.platinum ?? '暂无'} 白金；最高收购价 ${data.buy?.[0]?.platinum ?? '暂无'} 白金。`;
  } else if (data.kind === 'relic-farm') {
    const target = data.setMode ? data.set : data.target;
    entity = { type: data.setMode ? 'prime-set' : 'prime-part', displayName: target?.zhName || target?.name || query, canonicalName: target?.name || query };
    const routes = data.setMode ? data.components?.map((item) => item.route).filter(Boolean) : data.rows;
    const vaultedOnly = routes?.length > 0 && routes.every((route) => route.relic?.vaulted);
    summary = vaultedOnly ? '当前候选遗物均已入库，下一步可转向玩家市场。' : '已生成库存优先的遗物获取路线。';
  } else if (data.kind === 'relic') {
    entity = data.mode === 'forward'
      ? { type: 'relic', displayName: data.relic?.zhName || data.relic?.name, canonicalName: data.relic?.name }
      : { type: 'relic-reward', displayName: query, canonicalName: query };
    summary = data.mode === 'forward' ? `已列出遗物奖励与精炼收益；${data.relic?.vaulted ? '该遗物已入库。' : '该遗物仍可获取。'}` : `找到 ${data.total || data.matches?.length || 0} 枚相关遗物。`;
  } else if (data.kind === 'where-to-buy') {
    entity = { type: 'shop-item', displayName: query, canonicalName: query };
    summary = data.hits?.length ? `找到 ${data.total || data.hits.length} 个商人货源，首选 ${data.hits[0].vendorZh}。` : '没有找到商人货源。';
  } else if (data.kind === 'fissure') {
    entity = { type: 'fissure-query', displayName: data.title || '当前虚空裂缝', canonicalName: query || '当前虚空裂缝' };
    summary = `当前匹配 ${data.total || 0} 条裂缝。`;
  }
  if (!entity?.displayName && !entity?.canonicalName) return null;
  return { ok: true, kind: data.kind, query, scope: data.personalized ? 'personal' : 'public', summary, entities: [entity], nextActions: data.nextActions || [], fetchedAt: data.fetchedAt };
}

export async function runShortcut(message, options = {}) {
  const parsed = parseShortcutMessage(message);
  if (!parsed) return { handled: false };
  if (parsed.command === 'help') {
    const helpTopic = resolveHelpTopic(parsed.query);
    if (!helpTopic) {
      const available = listHelpSections().map((section) => `帮助 ${section.helpQuery}`).join('、');
      return {
        handled: true,
        ok: false,
        command: 'help',
        query: parsed.query || '',
        mediaUrl: null,
        followupText: null,
        text: `没有找到帮助模块「${parsed.query}」。可用模块：${available}。`,
      };
    }
    const data = { ok: true, kind: 'help', helpTopic, fetchedAt: new Date().toISOString() };
    let mediaUrl = null;
    try { mediaUrl = await renderCard(data, options.cardDir || process.env.WARFRAME_CARD_DIR); } catch { mediaUrl = null; }
    return { handled: true, ok: true, command: 'help', query: parsed.query || '', data, mediaUrl, followupText: null, text: formatHelp(helpTopic) };
  }
  if (parsed.command === 'where-to-buy') {
    if (!parsed.query) return { handled: true, ok: false, command: 'where-to-buy', text: '用法：购买 <物品>，例如 购买 武器特殊功能槽连接器' };
    const { loadShopContext, whereToBuy, attachRowIcons } = await import('./vendor-shop.mjs');
    const { buildWhereToBuyCard } = await import('./vendor-shop-card.mjs');
    const { renderWarframeCard } = await import('./warframe-cards.mjs');
    const context = await loadShopContext();
    const data = { ...whereToBuy(parsed.query, context), ok: true, kind: 'where-to-buy', fetchedAt: new Date().toISOString() };
    data.nextActions = buildShortcutNextActions(data, parsed);
    try { await attachRowIcons(data.hits); } catch { /* 无图降级 */ }
    let mediaUrl = null;
    try { mediaUrl = await renderWarframeCard(buildWhereToBuyCard(data, data.fetchedAt), options.cardDir || process.env.WARFRAME_CARD_DIR); } catch { mediaUrl = null; }
    const lines = data.hits.slice(0, 6).map((hit) => `${hit.itemName}：${hit.vendorZh}（${hit.availability}）`);
    return {
      handled: true, ok: true, command: 'where-to-buy', query: parsed.query, data, mediaUrl,
      contextEnvelope: buildShortcutContextEnvelope(data, parsed),
      followupText: mediaUrl && data.hits.length ? '价格为商店原价；限购与轮换以游戏内为准。' : null,
      text: data.hits.length ? `「${parsed.query}」货源：\n${lines.join('\n')}` : `没有商人出售「${parsed.query}」，可能来自掉落/合成；可试「遗物 ${parsed.query}」反查。`,
    };
  }
  if (parsed.command === 'bounty') {
    const { fetchBounties, resolveBountyPlace, resolveBountyBoard, whereBountyReward, attachRewardIcons, attachBountyStanding } = await import('./bounties.mjs');
    const { buildBountyIndexCard, buildBountyPlaceCard, buildBountyBoardCard, buildBountyReverseCard } = await import('./bounty-card.mjs');
    const { renderWarframeCard } = await import('./warframe-cards.mjs');
    let data;
    try {
      data = await fetchBounties(options.bountyFetchOptions || {});
    } catch (error) {
      return { handled: true, ok: false, command: 'bounty', query: parsed.query, text: `赏金数据暂时拉取失败（${String(error?.message || error)}），请稍后重试。` };
    }
    // 用户私聊（插件/dispatch 经 env 授权）：索引卡右列附六集团声望+今日余量；快照读失败静默降级纯公开版
    if (!parsed.query && (options.personalAllowed === true || process.env.WARFRAME_PERSONAL_OK === '1')) {
      try {
        const { readSnapshot } = await import('./alecaframe.mjs');
        attachBountyStanding(data, (await readSnapshot()).inventory);
      } catch { /* 无声望降级 */ }
    }
    let card = null;
    let text = '';
    let facts = null;
    if (!parsed.query) {
      card = buildBountyIndexCard(data);
      text = [
        ...data.places.map((place) => `${place.zh}：${place.jobs.length} 个赏金（发「赏金 ${place.zh}」看全奖池）`),
        ...data.boards.map((board) => `${board.zh}：${board.nodes.length} 个挑战（发「赏金 ${board.zh === '解剖圣所' ? '实验室' : board.zh}」看难度）`),
      ].join('\n');
      facts = {
        type: 'bounty-index', fetchedAt: data.fetchedAt, expiry: data.expiry,
        places: data.places.map((place) => ({ place: place.zh, jobCount: place.jobs.length })),
      };
    } else {
      const place = resolveBountyPlace(parsed.query);
      const boardAlias = place ? null : resolveBountyBoard(parsed.query);
      if (place) {
        const detail = data.places.find((entry) => entry.key === place.key);
        if (!detail) return { handled: true, ok: false, command: 'bounty', query: parsed.query, text: `${place.zh}赏金数据暂不可用，请稍后重试。` };
        // 奖池全展开：解析全部合并后的奖励图（每任务 ~9 个去重物品）；失败无图降级
        try {
          await attachRewardIcons(detail.jobs.flatMap((job) => job.rewardGroups || []));
        } catch { /* 无图降级 */ }
        card = buildBountyPlaceCard(detail, data.expiry);
        text = `${detail.zh}当前 ${detail.jobs.length} 个赏金：${detail.jobs.map((job) => job.zhTitle).join('、')}`;
        facts = {
          type: 'bounty-place', place: detail.zh, fetchedAt: data.fetchedAt,
          expiry: detail.expiry || data.expiry,
          currentJobs: detail.jobs.map((job) => ({
            title: job.zhTitle, levels: job.levels,
            rewards: [...new Set((job.rewards || []).map((reward) => reward.zh).filter(Boolean))],
          })),
        };
      } else if (boardAlias) {
        // 挑战板区（扎里曼/实验室/1999）：每节点挑战+难度+描述，奖池固定不随轮换
        const board = data.boards.find((entry) => entry.key === boardAlias.key);
        if (!board) return { handled: true, ok: false, command: 'bounty', query: parsed.query, text: `${boardAlias.zh}挑战板数据暂不可用（oracle 轮换源可能挂了），请稍后重试。` };
        card = buildBountyBoardCard(board);
        text = `${board.zh}当前 ${board.nodes.length} 个挑战：${board.nodes.map((node) => `${node.challengeZh}${node.levels ? `（Lv ${node.levels[0]}-${node.levels[1]}）` : ''}`).join('、')}`;
        facts = { type: 'bounty-board', board: board.zh, fetchedAt: data.fetchedAt, expiry: board.expiry, nodes: board.nodes };
      } else {
        const result = whereBountyReward(parsed.query, data);
        try { await attachRewardIcons(result.hits); } catch { /* 无图降级 */ }
        card = buildBountyReverseCard(result);
        text = result.hits.length
          ? `「${parsed.query}」本轮在出：\n${result.hits.slice(0, 5).map((hit) => `${hit.placeZh} ${hit.jobZh}（${hit.chance}%）`).join('\n')}`
          : `本轮赏金没有「${parsed.query}」；奖池 2.5 小时轮换，可发「订阅 赏金 ${parsed.query}」蹲下轮。`;
        facts = {
          type: 'bounty-reward-current-check', reward: parsed.query, fetchedAt: data.fetchedAt,
          expiry: data.expiry, currentlyAvailable: result.hits.length > 0, hits: result.hits,
        };
      }
    }
    let mediaUrl = null;
    if (!options.skipRender) {
      try { mediaUrl = await renderWarframeCard(card, options.cardDir || process.env.WARFRAME_CARD_DIR); } catch { mediaUrl = null; }
    }
    return {
      handled: true, ok: true, command: 'bounty', query: parsed.query, data, facts, mediaUrl,
      followupText: mediaUrl && !parsed.query ? '发「赏金 希图斯/金星/火卫二」看奖励池；「赏金 物品名」反查哪个赏金出。' : null,
      text,
    };
  }
  if (!parsed.query && parsed.command !== 'fissure') {
    const text = parsed.command === 'market'
      ? '用法：wm <物品>，例如 wm 悟空p'
      : parsed.command === 'relic-farm'
        ? '用法：获取 <Prime部件>，例如 获取 悟空Prime系统蓝图'
      : '用法：遗物 <纪元编号或物品>，例如 遗物 前x1、遗物 战刃';
    return { handled: true, ok: false, command: parsed.command, text };
  }
  const platform = options.platform || DEFAULT_PLATFORM;
  const crossplay = options.crossplay ?? DEFAULT_CROSSPLAY;
  const data = parsed.command === 'market' ? await queryMarket(parsed.query, platform, crossplay)
    : parsed.command === 'fissure' ? await queryFissures(parsed.query, platform, options)
      : parsed.command === 'relic-farm' ? await queryRelicFarm(parsed.query, platform, crossplay, options)
      : await queryRelic(parsed.query, platform, crossplay);
  data.nextActions = buildShortcutNextActions(data, parsed);
  let mediaUrl = null;
  try {
    mediaUrl = await renderCard(data, options.cardDir || process.env.WARFRAME_CARD_DIR);
  } catch {
    mediaUrl = null;
  }
  return {
    handled: true,
    ok: data.ok,
    command: parsed.command,
    query: parsed.query,
    data,
    contextEnvelope: buildShortcutContextEnvelope(data, parsed),
    mediaUrl,
    followupText: mediaUrl ? compactFollowup(data) : null,
    text: parsed.command === 'market' ? formatMarket(data)
      : parsed.command === 'fissure' ? formatFissures(data)
        : parsed.command === 'relic-farm' ? formatRelicFarm(data) : formatRelic(data),
  };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === 'parse') {
      out(await runShortcut(rest.join(' ')));
      return;
    }
    if (command === 'ask') {
      out(await runNaturalShortcut(rest.join(' ')));
      return;
    }
    if (command === 'route') {
      const routed = parseNaturalWorldQuestion(rest.join(' '));
      out(routed ? { handled: true, ...routed } : { handled: false });
      return;
    }
    if (command === 'market') {
      const data = await queryMarket(rest.join(' '));
      out({ data, text: formatMarket(data) });
      return;
    }
    if (command === 'relic') {
      const data = await queryRelic(rest.join(' '));
      out({ data, text: formatRelic(data) });
      return;
    }
    if (command === 'fissure') {
      const data = await queryFissures(rest.join(' '));
      out({ data, text: formatFissures(data) });
      return;
    }
    out({ handled: false, error: '用法：parse <消息>｜market <物品>｜relic <遗物或物品>｜fissure [筛选条件]' });
    process.exitCode = 1;
  } catch (error) {
    out({ handled: true, ok: false, error: String(error?.message || error), text: '查询暂时失败，请稍后重试。' });
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
