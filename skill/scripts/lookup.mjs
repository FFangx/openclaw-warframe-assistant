#!/usr/bin/env node

// 查询手册工具：无模板问题的白名单数据源统一入口（2026-08-04 数据源盘点落地）。
// 模型只许通过这里查数据，禁止自己 fetch——UA/超时/中文名解析/输出裁剪都在本脚本做对。
// 每个子命令输出 {ok, source, fetchedAt, data}；source 为可引用的来源 URL。
//
// 子命令：
//   worldstate <板块>   官方世界状态切片：sortie|archon|baro|varzia|darvo|descents|calendar|nightwave|circuit|conquests|vault-bonus|events|alerts|invasions
//   vendor <商人>       商人完整货单/候选池（teshin|acrithis|donda|或 manifest 关键字）
//   dict <词>           官方词典双向查（英↔中，browse.wf dict.en/dict.zh）
//   drops <关键词>      掉落表搜索（warframestat drops）
//   bounties            赏金轮换（oracle bounty-cycle）
//   sp-incursions       今日钢铁之路侵袭六节点（browse.wf 排期表）
//   recipe <名字>       制造配方（中文名/英文名/路径 → ExportRecipes 精确配方，含部件子配方）
//   item <路径>         物品详情（browse.wf 通用物品 API，/Lotus/... 路径）

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const UA = { 'User-Agent': 'Mozilla/5.0' };
const TIMEOUT_MS = 20_000;
const OFFICIAL_WS = 'https://api.warframe.com/cdn/worldState.php';
const WPEP = 'https://browse.wf/warframe-public-export-plus';

async function fetchJson(url) {
  const response = await fetch(url, { headers: UA, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  return response.json();
}
async function fetchText(url) {
  const response = await fetch(url, { headers: UA, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  return response.text();
}

const msOf = (value) => Number(value?.$date?.$numberLong);
const isoOf = (value) => { const ms = msOf(value); return Number.isFinite(ms) ? new Date(ms).toISOString() : null; };

// 本机 lang.json（uniqueName→官方中文名）：本地缺失走 wfdata 在线兑底，全挂降级为路径尾段
let langPromise = null;
function loadLang() {
  langPromise ??= import('./wfdata.mjs').then((m) => m.getLangTable()).catch(() => ({}));
  return langPromise;
}
async function zhName(uniqueName) {
  const lang = await loadLang();
  const base = String(uniqueName || '').replace('/StoreItems/', '/');
  return lang[base]?.zh?.name || lang[uniqueName]?.zh?.name || base.split('/').pop();
}

// —— worldstate 板块切片：只透出回答问题需要的字段，防 prompt 膨胀 ——
async function sectionWorldstate(section) {
  const ws = await fetchJson(OFFICIAL_WS);
  const nameOf = zhName;
  switch (section) {
    case 'sortie': {
      const s = ws.Sorties?.[0];
      return { boss: s?.Boss, expiry: isoOf(s?.Expiry), missions: s?.Missions };
    }
    case 'archon': {
      const s = ws.LiteSorties?.[0];
      return { boss: s?.Boss, expiry: isoOf(s?.Expiry), missions: s?.Missions };
    }
    case 'baro': {
      const t = ws.VoidTraders?.[0];
      const manifest = await Promise.all((t?.Manifest || []).map(async (item) => ({ name: await nameOf(item.ItemType), ducats: item.PrimePrice, credits: item.RegularPrice })));
      return { node: t?.Node, arrives: isoOf(t?.Activation), leaves: isoOf(t?.Expiry), arrived: manifest.length > 0, manifest };
    }
    case 'varzia': {
      const t = ws.PrimeVaultTraders?.[0];
      // MPV 套包不在 lang.json：内部名转可读（MPVTitaniaGaraPrimeDualPack → Titania+Gara Prime 双人包）
      const prettyPack = (name) => {
        const match = String(name).match(/^MPV([A-Z][a-z]+)([A-Z][a-z]+)?Prime(Single|Dual)Pack$/u);
        if (match) return `${match[1]}${match[2] ? `+${match[2]}` : ''} Prime ${match[3] === 'Dual' ? '双人包' : '单人包'}`;
        return name;
      };
      const named = async (list) => Promise.all((list || []).map(async (item) => ({ name: prettyPack(await nameOf(item.ItemType)), regalAya: item.PrimePrice ?? null, aya: item.RegularPrice ?? null })));
      const future = (t?.ScheduleInfo || []).filter((entry) => msOf(entry.Expiry) > Date.now()).map((entry) => ({ until: isoOf(entry.Expiry), featured: prettyPack(entry.FeaturedItem?.split('/').pop() || '') || null }));
      return { expiry: isoOf(t?.Expiry), current: await named(t?.Manifest), evergreenCount: t?.EvergreenManifest?.length ?? 0, evergreen: await named((t?.EvergreenManifest || []).slice(0, 40)), futureSchedule: future };
    }
    case 'darvo': {
      return Promise.all((ws.DailyDeals || []).map(async (deal) => ({
        item: await nameOf(deal.StoreItem), discount: `${deal.Discount}%`, price: deal.SalePrice, originalPrice: deal.OriginalPrice,
        stock: `${deal.AmountSold}/${deal.AmountTotal} 已售`, until: isoOf(deal.Expiry),
      })));
    }
    case 'descents': {
      return (ws.Descents || []).map((week) => ({
        from: isoOf(week.Activation), until: isoOf(week.Expiry),
        challenges: (week.Challenges || []).map((c) => ({ index: c.Index, type: c.Type, challenge: c.Challenge })),
      }));
    }
    case 'calendar': {
      const season = ws.KnownCalendarSeasons?.[0];
      return { season: season?.Season, until: isoOf(season?.Expiry), days: season?.Days };
    }
    case 'nightwave': {
      const info = ws.SeasonInfo;
      return { season: info?.Season, phase: info?.Phase, until: isoOf(info?.Expiry), challenges: (info?.ActiveChallenges || []).map((c) => ({ key: c.Challenge?.split('/').pop(), daily: Boolean(c.Daily), until: isoOf(c.Expiry) })) };
    }
    case 'circuit': {
      const entry = ws.EndlessXpSchedule?.[0];
      return { until: isoOf(entry?.Expiry), choices: entry?.CategoryChoices };
    }
    case 'conquests': return ws.Conquests;
    case 'vault-bonus': return ws.WeeklyVaultBonusRewards;
    case 'events': return (ws.Goals || []).map((goal) => ({ desc: goal.Desc, node: goal.VictimNode || goal.Node, until: isoOf(goal.Expiry), progress: goal.Count != null ? `${goal.Count}/${goal.Goal}` : (goal.HealthPct != null ? `HP ${(goal.HealthPct * 100).toFixed(1)}%` : null) }));
    case 'alerts': return ws.Alerts;
    case 'invasions': return (ws.Invasions || []).filter((entry) => !entry.Completed).slice(0, 20).map((entry) => ({ node: entry.Node, attacker: entry.DefenderMissionInfo?.faction, count: entry.Count, goal: entry.Goal }));
    default: throw new Error(`未知板块：${section}（可用：sortie archon baro varzia darvo descents calendar nightwave circuit conquests vault-bonus events alerts invasions）`);
  }
}

// —— 商人货单：ExportVendors 候选池（含概率/限购），中文名走 lang.json ——
const VENDOR_ALIASES = {
  teshin: 'TeshinHardModeVendorManifest', '泰辛': 'TeshinHardModeVendorManifest',
  acrithis: 'AcrithisVendorManifest', '言录使': 'AcrithisVendorManifest',
  donda: 'IronwakeDondaVendorManifest',
};
async function sectionVendor(query) {
  const vendors = await fetchJson(`${WPEP}/ExportVendors.json`);
  const keys = Object.keys(vendors);
  const wanted = VENDOR_ALIASES[String(query || '').toLowerCase()] || query;
  const key = keys.find((k) => k.endsWith(`/${wanted}`)) || keys.find((k) => k.toLowerCase().includes(String(wanted || '').toLowerCase()));
  if (!key) throw new Error(`没找到商人「${query}」；可用别名：teshin/泰辛、acrithis/言录使、donda，或传 manifest 关键字`);
  const vendor = vendors[key];
  const items = await Promise.all((vendor.items || []).slice(0, 80).map(async (item) => ({
    name: await zhName(item.storeItem),
    quantity: item.quantity ?? 1,
    price: (item.itemPrices || []).map((price) => `${price.ItemCount}× ${price.ItemType.split('/').pop()}`).join(' + ') || (item.regularPrice != null ? `${item.regularPrice} 现金` : null),
    ...(item.probability != null ? { probability: item.probability } : {}),
    ...(item.purchaseLimit != null ? { purchaseLimit: item.purchaseLimit } : {}),
    ...(item.durationHours != null ? { rotationHours: item.durationHours } : {}),
    ...(item.alwaysOffered ? { alwaysOffered: true } : {}),
  })));
  return { manifest: key, isDynamic: Boolean(vendor.isDynamic), totalItems: (vendor.items || []).length, items };
}

// —— 官方词典双向查：值匹配（英文不区分大小写，中文子串） ——
async function sectionDict(query) {
  const [en, zh] = await Promise.all([fetchJson(`${WPEP}/dict.en.json`), fetchJson(`${WPEP}/dict.zh.json`)]);
  const q = String(query || '').trim();
  const qLower = q.toLowerCase();
  const hits = [];
  for (const [key, enValue] of Object.entries(en)) {
    const zhValue = zh[key];
    if (!zhValue) continue;
    if (String(enValue).toLowerCase() === qLower || String(zhValue) === q) hits.push({ key, en: enValue, zh: zhValue, exact: true });
    else if (hits.length < 10 && (String(enValue).toLowerCase().includes(qLower) || String(zhValue).includes(q))) hits.push({ key, en: enValue, zh: zhValue, exact: false });
    if (hits.filter((h) => h.exact).length >= 5) break;
  }
  hits.sort((a, b) => Number(b.exact) - Number(a.exact));
  return hits.slice(0, 10);
}

// —— 掉落表搜索（warframestat drops，社区维护的官方掉率表） ——
async function sectionDrops(query) {
  const data = await fetchJson(`https://api.warframestat.us/drops/search/${encodeURIComponent(query)}`);
  return (Array.isArray(data) ? data : []).slice(0, 30);
}

// —— 今日钢铁之路侵袭（browse.wf 排期表 + 区域中文名） ——
async function sectionSpIncursions() {
  const [schedule, regions, zh] = await Promise.all([
    fetchText('https://browse.wf/sp-incursions.txt'),
    fetchJson(`${WPEP}/ExportRegions.json`),
    fetchJson(`${WPEP}/dict.zh.json`),
  ]);
  const today = Math.floor(Date.now() / 86_400_000) * 86_400;
  const line = schedule.split('\n').find((row) => row.startsWith(String(today)));
  if (!line) throw new Error('排期表缺今日条目');
  const nodes = line.split(';')[1].split(',').map((code) => {
    const region = regions[code.trim()] || {};
    return { node: code.trim(), name: region.name ? (zh[region.name] || region.name) : code.trim(), planet: region.systemName ? (zh[region.systemName] || region.systemName) : '', mission: region.missionName ? (zh[region.missionName] || region.missionName) : '' };
  });
  return { date: new Date(today * 1000).toISOString().slice(0, 10), nodes };
}

// —— 制造配方（ExportRecipes 精确数据，避免抓网页被截断出残答案） ——
async function sectionRecipe(query) {
  const raw = String(query || '').trim();
  if (!raw) throw new Error('用法：recipe <中文名|英文名|/Lotus/路径>');
  const lang = await loadLang();
  // 目标 uniqueName：路径直用；否则用本机 lang.json 双向反查（去空格容错）
  let target = null;
  const candidates = [];
  if (raw.startsWith('/Lotus/')) {
    target = raw.replace('/StoreItems/', '/');
  } else {
    const compactQ = raw.normalize('NFKC').toLowerCase().replace(/[\s\u3000]+/gu, '');
    for (const [key, value] of Object.entries(lang)) {
      const zh = String(value?.zh?.name || '').toLowerCase().replace(/[\s\u3000]+/gu, '');
      const en = String(value?.en?.name || '').toLowerCase().replace(/[\s\u3000]+/gu, '');
      if (zh === compactQ || en === compactQ) { target = key; break; }
      if (candidates.length < 8 && compactQ.length >= 2 && (zh.includes(compactQ) || en.includes(compactQ))) candidates.push({ uniqueName: key, zh: value?.zh?.name });
    }
    if (!target && candidates.length === 1) target = candidates[0].uniqueName;
    if (!target) {
      if (candidates.length) return { resolved: false, query: raw, candidates };
      throw new Error(`本机词典查无「${raw}」，请用游戏内官方名或 /Lotus/ 路径`);
    }
  }
  const recipes = await fetchJson(`${WPEP}/ExportRecipes.json`);
  const describe = async (recipe) => ({
    credits: recipe.buildPrice ?? null,
    buildHours: Number.isFinite(recipe.buildTime) ? recipe.buildTime / 3600 : null,
    rushPlatinum: recipe.skipBuildTimePrice ?? null,
    ingredients: await Promise.all((recipe.ingredients || []).map(async (ing) => ({
      type: ing.ItemType, zh: await zhName(ing.ItemType), count: ing.ItemCount,
    }))),
  });
  const main = Object.values(recipes).find((recipe) => recipe.resultType === target);
  if (!main) throw new Error(`「${await zhName(target)}」没有制造配方（成品直接获取或商店购买）`);
  // 部件自身有配方的展开一层（战甲/机甲四件套模式）
  const components = [];
  for (const ing of main.ingredients || []) {
    const sub = Object.values(recipes).find((recipe) => recipe.resultType === ing.ItemType);
    if (sub) components.push({ zh: await zhName(ing.ItemType), ...(await describe(sub)) });
  }
  return { resolved: true, name: await zhName(target), uniqueName: target, recipe: await describe(main), components };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const arg = rest.join(' ').trim();
  const fetchedAt = new Date().toISOString();
  const emit = (source, data) => process.stdout.write(`${JSON.stringify({ ok: true, source, fetchedAt, data })}\n`);
  try {
    if (command === 'worldstate') return emit(OFFICIAL_WS, await sectionWorldstate(arg));
    if (command === 'vendor') return emit(`${WPEP}/ExportVendors.json`, await sectionVendor(arg));
    if (command === 'dict') return emit(`${WPEP}/dict.zh.json`, await sectionDict(arg));
    if (command === 'drops') return emit('https://api.warframestat.us/drops', await sectionDrops(arg));
    if (command === 'bounties') return emit('https://oracle.browse.wf/bounty-cycle', await fetchJson('https://oracle.browse.wf/bounty-cycle'));
    if (command === 'sp-incursions') return emit('https://browse.wf/sp-incursions.txt', await sectionSpIncursions());
    if (command === 'recipe') return emit(`${WPEP}/ExportRecipes.json`, await sectionRecipe(arg));
    if (command === 'item') {
      if (!arg.startsWith('/Lotus/')) throw new Error('item 只接受 /Lotus/... 路径（可先用 vendor/worldstate 拿到路径）');
      return emit(`https://browse.wf${arg}`, await fetchJson(`https://browse.wf${arg.replace('/StoreItems/', '/')}`));
    }
    process.stdout.write(`${JSON.stringify({ ok: false, error: '用法：worldstate <板块>｜vendor <商人>｜dict <词>｜drops <关键词>｜bounties｜sp-incursions｜recipe <名字>｜item </Lotus/...>' })}\n`);
    process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: String(error?.message || error) })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
