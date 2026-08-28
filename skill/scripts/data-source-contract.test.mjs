import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 隔离缓存目录：模块在 import 时解析 WARFRAME_DATA_CACHE_DIR，必须先设再动态导入
// （与 reward-zh-fallback.test.mjs 同款模式）。零真实网络、零真实个人快照。
const cacheDir = await mkdtemp(join(os.tmpdir(), 'warframe-source-contract-'));
process.env.WARFRAME_DATA_CACHE_DIR = cacheDir;

const contract = await import('./data-source-contract.mjs');
const worldstate = await import('./worldstate-source.mjs');
const lookup = await import('./lookup.mjs');
const wfdata = await import('./wfdata.mjs');
const trader = await import('./trader-shopping.mjs');
const shortcuts = await import('./shortcuts.mjs');

const {
  ALECA_CDN_BASE_URL,
  DE_OFFICIAL_WORLDSTATE_URL,
  DOC_FACTS,
  MARKET_BASE_URL,
  ORACLE_WORLDSTATE_URL,
  SOURCE_CHAINS,
  SOURCE_PROVIDERS,
  WARFRAMESTAT_BASE_URL,
  WARFRAMESTAT_DROPS_SEARCH_URL,
  WARFRAMESTAT_ITEMS_ZH_URL,
  WFCD_DROPS_SLIM_URL,
  assertChainSteps,
  chainEndpoints,
  classifyMarketEndpoint,
  documentedChainNames,
  marketDataKindOf,
  sourceDocViolations,
  validateSourceContract,
  validateSourceDocs,
} = contract;
const { OFFICIAL_URL, ORACLE_URL, PRIMARY_BASE, loadWorldState } = worldstate;
const { sectionDrops } = lookup;
const { getLangTable, readAlecaJson } = wfdata;
const { endpointFor: traderEndpointFor, summarizeTradeStatistics } = trader;
const { marketEndpoint: shortcutsMarketEndpoint } = shortcuts;

// scripts 的父目录就是 Skill 根：源码为 repo/skill，部署后为
// workspace/skills/warframe-assistant；两种布局都可直接定位 references。
const skillRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

test.after(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// 深拷贝（合同对象带 freeze，注入破损注册表必须克隆）
const clone = (value) => JSON.parse(JSON.stringify(value));
const realRegistry = () => ({ providers: clone(SOURCE_PROVIDERS), chains: clone(SOURCE_CHAINS) });

// ---------- 注册表本身 ----------

test('数据源注册表：恰好四条链与八个 provider；路由常量与 provider 主机自洽', () => {
  const summary = validateSourceContract();
  assert.deepEqual(summary.chains, ['worldstate-pc', 'market-readonly', 'drops-query', 'catalog-zh']);
  assert.deepEqual(documentedChainNames(), ['worldstate-pc', 'market-readonly', 'drops-query', 'catalog-zh']);
  assert.deepEqual(Object.keys(SOURCE_CHAINS), ['worldstate-pc', 'market-readonly', 'drops-query', 'catalog-zh']);
  assert.equal(SOURCE_PROVIDERS.length, 8);
  // 世界状态链：官方为主 → warframestat 全量备用 → 可靠缓存末级；Oracle 只在叠加层
  assert.deepEqual(chainEndpoints('worldstate-pc'), []);
  assert.deepEqual(SOURCE_CHAINS['worldstate-pc'].steps.map((step) => step.provider),
    ['de-official', 'warframestat', 'reliable-cache']);
  assert.deepEqual(SOURCE_CHAINS['worldstate-pc'].overlays[0], {
    provider: 'oracle',
    role: 'fissure-overlay',
    base: 'warframestat',
    baseRole: 'full-fallback',
    gate: { official: 'failed', community: 'success' },
    standalone: false,
    cacheable: false,
    fields: ['fissures'],
  });
  // Market 只读：四端点、全部只读；订单实时、统计历史（不得冒充实时）
  assert.deepEqual(chainEndpoints('market-readonly').map((endpoint) => endpoint.id), ['catalog', 'detail', 'orders', 'statistics']);
  for (const endpoint of chainEndpoints('market-readonly')) assert.equal(endpoint.readOnly, true);
  assert.equal(chainEndpoints('market-readonly').find((e) => e.id === 'orders').realTime, true);
  assert.equal(chainEndpoints('market-readonly').find((e) => e.id === 'statistics').neverRealTime, true);
  // 掉率与目录链顺序
  assert.deepEqual(SOURCE_CHAINS['drops-query'].steps.map((step) => step.provider), ['warframestat', 'wfcd-github']);
  assert.deepEqual(SOURCE_CHAINS['catalog-zh'].steps.map((step) => step.provider), ['alecaframe-local', 'alecaframe-cdn', 'warframestat']);
});

test('注册表校验（负向）：缺失链/未知链/未知 provider/重复 provider/顺序错误/角色错误都抛错', () => {
  const missingChain = realRegistry();
  delete missingChain.chains['drops-query'];
  assert.throws(() => validateSourceContract(missingChain), /缺失链/u);
  const unknownChain = realRegistry();
  unknownChain.chains.foo = { steps: [] };
  assert.throws(() => validateSourceContract(unknownChain), /未知链/u);
  const unknownProvider = realRegistry();
  unknownProvider.chains['drops-query'].steps[0].provider = 'mystery-host';
  assert.throws(() => validateSourceContract(unknownProvider), /未知 provider/u);
  const duplicateProvider = realRegistry();
  duplicateProvider.providers.push({ id: 'de-official', kind: 'remote', host: 'api.warframe.com', roles: ['worldstate-primary'] });
  assert.throws(() => validateSourceContract(duplicateProvider), /重复/u);
  // 错误顺序：官方与 warframestat 互换
  const wrongOrder = realRegistry();
  [wrongOrder.chains['worldstate-pc'].steps[0], wrongOrder.chains['worldstate-pc'].steps[1]] =
    [wrongOrder.chains['worldstate-pc'].steps[1], wrongOrder.chains['worldstate-pc'].steps[0]];
  assert.throws(() => validateSourceContract(wrongOrder), /顺序\/角色/u);
  // 错误角色：全量备用被写成了掉率主源角色
  const wrongRole = realRegistry();
  wrongRole.chains['worldstate-pc'].steps[1].role = 'drops-query-primary';
  assert.throws(() => validateSourceContract(wrongRole), /顺序\/角色/u);
  // provider 未声明该角色
  const undeclaredRole = realRegistry();
  undeclaredRole.chains['drops-query'].steps[0].role = 'worldstate-primary';
  assert.throws(() => validateSourceContract(undeclaredRole), /未声明角色/u);
});

test('Oracle 叠加层约束（负向）：单独/可缓存/错误门禁/非 fissures 字段/作为链步骤都失败', () => {
  const standalone = realRegistry();
  standalone.chains['worldstate-pc'].overlays[0].standalone = true;
  assert.throws(() => validateSourceContract(standalone), /standalone|单独/u);
  const cacheable = realRegistry();
  cacheable.chains['worldstate-pc'].overlays[0].cacheable = true;
  assert.throws(() => validateSourceContract(cacheable), /cacheable/u);
  const badGate = realRegistry();
  badGate.chains['worldstate-pc'].overlays[0].gate = { official: 'failed', community: 'failed' };
  assert.throws(() => validateSourceContract(badGate), /门禁/u);
  const badFields = realRegistry();
  badFields.chains['worldstate-pc'].overlays[0].fields = ['fissures', 'alerts'];
  assert.throws(() => validateSourceContract(badFields), /fissures/u);
  const asStep = realRegistry();
  asStep.chains['drops-query'].steps[1] = { provider: 'oracle', role: 'worldstate-fissure-overlay' };
  assert.throws(() => validateSourceContract(asStep), /绝不能作为链步骤/u);
  const inOtherChain = realRegistry();
  inOtherChain.chains['drops-query'].steps[1] = { provider: 'reliable-cache', role: 'drops-query-fallback' };
  assert.throws(() => validateSourceContract(inOtherChain), /不得使用可靠缓存/u);
  const cacheNotLast = realRegistry();
  cacheNotLast.chains['worldstate-pc'].steps.pop();
  assert.throws(() => validateSourceContract(cacheNotLast), /末级/u);
  const twoOverlays = realRegistry();
  twoOverlays.chains['worldstate-pc'].overlays.push(clone(twoOverlays.chains['worldstate-pc'].overlays[0]));
  assert.throws(() => validateSourceContract(twoOverlays), /且仅有一个叠加层/u);
});

test('Market 只读链（负向）：缺失/未知端点、非只读、口径混淆、健康键重复都失败', () => {
  const missing = realRegistry();
  missing.chains['market-readonly'].endpoints = missing.chains['market-readonly'].endpoints.filter((e) => e.id !== 'statistics');
  assert.throws(() => validateSourceContract(missing), /端点数与文档不符|缺失端点/u);
  const unknown = realRegistry();
  unknown.chains['market-readonly'].endpoints.push({ id: 'write', path: '/v2/items/write', dataKind: 'catalog', readOnly: false, resilienceKey: 'market:v2:write' });
  assert.throws(() => validateSourceContract(unknown), /端点数与文档不符|未知端点/u);
  const mutating = realRegistry();
  mutating.chains['market-readonly'].endpoints.find((e) => e.id === 'catalog').readOnly = false;
  assert.throws(() => validateSourceContract(mutating), /只读/u);
  const liveStats = realRegistry();
  liveStats.chains['market-readonly'].endpoints.find((e) => e.id === 'statistics').dataKind = 'live';
  assert.throws(() => validateSourceContract(liveStats), /closed-history/u);
  const historyOrders = realRegistry();
  historyOrders.chains['market-readonly'].endpoints.find((e) => e.id === 'orders').dataKind = 'closed-history';
  assert.throws(() => validateSourceContract(historyOrders), /实时挂单/u);
  const dupKey = realRegistry();
  dupKey.chains['market-readonly'].endpoints.find((e) => e.id === 'detail').resilienceKey = 'market:v2:catalog';
  assert.throws(() => validateSourceContract(dupKey), /健康键重复/u);
});

test('目录链 scope（负向）：降级链只能收窄、末级必须覆盖 lang', () => {
  const widened = realRegistry();
  widened.chains['catalog-zh'].steps[2].scope = ['lang', 'foo'];
  assert.throws(() => validateSourceContract(widened), /scope/u);
  const noLang = realRegistry();
  noLang.chains['catalog-zh'].steps[2].scope = ['catalog-json'];
  assert.throws(() => validateSourceContract(noLang), /lang/u);
});

// ---------- 真实实现常量/路由 ----------

test('世界状态链：真实实现路由常量与合同完全一致', () => {
  assert.equal(OFFICIAL_URL, DE_OFFICIAL_WORLDSTATE_URL);
  assert.equal(ORACLE_URL, ORACLE_WORLDSTATE_URL);
  assert.equal(PRIMARY_BASE, WARFRAMESTAT_BASE_URL);
  assert.equal(WFCD_DROPS_SLIM_URL.startsWith('https://raw.githubusercontent.com/WFCD/warframe-drop-data/gh-pages/data'), true);
});

test('Market 只读链：四端点分类、实时/历史口径与真实实现健康键一一对应', () => {
  const urls = {
    catalog: `${MARKET_BASE_URL}/v2/items`,
    detail: `${MARKET_BASE_URL}/v2/item/wukong_prime_set`,
    orders: `${MARKET_BASE_URL}/v2/orders/item/wukong_prime_set/top?rank=0`,
    statistics: `${MARKET_BASE_URL}/v1/items/wukong_prime_set/statistics`,
  };
  for (const [id, url] of Object.entries(urls)) {
    const classified = classifyMarketEndpoint(url);
    assert.equal(classified.id, id);
    assert.equal(classified.readOnly, true);
    assert.equal(classified.resilienceKey, chainEndpoints('market-readonly').find((e) => e.id === id).resilienceKey);
    // 真实实现（trader-shopping / shortcuts）的端点健康键映射与合同一致
    assert.equal(traderEndpointFor(url), classified.resilienceKey);
    assert.equal(shortcutsMarketEndpoint(url), classified.resilienceKey);
  }
  // 口径分离：订单=实时挂单；统计=已成交历史（绝不冒充实时）
  assert.equal(marketDataKindOf(urls.orders), 'live');
  assert.equal(marketDataKindOf(urls.statistics), 'closed-history');
  // 非 Market 主机不归类（图片/CDN 走裸 fetch）
  assert.equal(classifyMarketEndpoint('https://warframe.market/static/assets/x.png'), null);
  assert.equal(shortcutsMarketEndpoint('https://warframe.market/static/assets/x.png'), null);
  assert.equal(classifyMarketEndpoint('https://cdn.alecaframe.com/warframeData/img/x.png'), null);
  // 统计口径：总结只输出 today/90days 历史分位；空统计表不出价（不冒充实时）
  const payload = { payload: { statistics_closed: {
    '48hours': [{ datetime: new Date().toISOString(), median: 30, volume: 12 }],
    '90days': [{ datetime: '2026-08-01T00:00:00.000Z', median: 28, volume: 40 }],
  } } };
  const summary = summarizeTradeStatistics(payload, false);
  assert.equal(summary.basis, 'today');
  assert.ok(['today', '90days'].includes(summary.basis));
  assert.equal(summarizeTradeStatistics({ payload: { statistics_closed: {} } }, false), null);
});

// ---------- 真实行为链（零网络） ----------

test('掉率查询链：warframestat 主源成功即返；失败后按 WFCD GitHub 备用（顺序与合同一致）', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    calls.push(value);
    if (value.startsWith(WARFRAMESTAT_DROPS_SEARCH_URL)) {
      return json([{ item: 'Synthetic Gauss Prime Chassis', place: 'Synthetic Node', chance: 1 }]);
    }
    if (value === WFCD_DROPS_SLIM_URL) return json({ data: [{ item: 'Synthetic', place: 'All', chance: 5 }] });
    throw new Error(`unexpected ${value}`);
  };
  try {
    const primary = await sectionDrops('gauss');
    assert.equal(primary.source, 'https://api.warframestat.us/drops');
    assert.equal(primary.data.length, 1);
    assert.equal(String(calls[0]).startsWith(WARFRAMESTAT_DROPS_SEARCH_URL), true);
    assertChainSteps('drops-query', ['warframestat'], { allowPrefix: true });
  } finally {
    globalThis.fetch = originalFetch;
  }

  calls.length = 0;
  globalThis.fetch = async (url) => {
    const value = String(url);
    calls.push(value);
    if (value.startsWith(WARFRAMESTAT_DROPS_SEARCH_URL)) throw new Error('drops search down');
    if (value === WFCD_DROPS_SLIM_URL) return json([{ item: 'Synthetic Gauss Prime', place: 'All', chance: 5 }]);
    throw new Error(`unexpected ${value}`);
  };
  try {
    const fallback = await sectionDrops('gauss');
    assert.equal(fallback.source, WFCD_DROPS_SLIM_URL);
    assert.equal(fallback.data.length, 1);
    assert.deepEqual(calls, [`${WARFRAMESTAT_DROPS_SEARCH_URL}gauss`, WFCD_DROPS_SLIM_URL]);
    assertChainSteps('drops-query', ['warframestat', 'wfcd-github']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const bigLangTable = (prefix, count = 1002) => {
  const table = {};
  for (let index = 0; index < count; index += 1) table[`/Lotus/${prefix}Item${index}`] = { zh: { name: `${prefix} 合成体 ${index}` } };
  return table;
};

async function makeAlecaDir() {
  const dir = await mkdtemp(join(os.tmpdir(), 'warframe-source-catalog-'));
  await mkdir(join(dir, 'cachedData', 'json'), { recursive: true });
  return dir;
}

test('物品/中文目录链：本机 lang.json 命中即止（零联网、无缓存写入）', async () => {
  const dir = await makeAlecaDir();
  await writeFile(join(dir, 'cachedData', 'json', 'lang.json'),
    JSON.stringify({ '/Lotus/Synthetic': { zh: { name: '合成体' } } }), 'utf8');
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error(`network ${url}`); };
  try {
    const table = await getLangTable({ alecaDir: dir });
    assert.deepEqual(table, { '/Lotus/Synthetic': { zh: { name: '合成体' } } });
    assert.equal(calls.length, 0);
    assertChainSteps('catalog-zh', ['alecaframe-local'], { allowPrefix: true });
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('物品/中文目录链：本地缺失 → AlecaFrame CDN（≥1000 条采信）；失败才走 warframestat 旧兜底', async () => {
  const dir = await makeAlecaDir();
  await rm(join(cacheDir, 'lang-zh-rebuilt.json'), { force: true });
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    calls.push(value);
    if (value === `${ALECA_CDN_BASE_URL}/json/lang.json`) return json(bigLangTable('CDN'));
    if (value === WARFRAMESTAT_ITEMS_ZH_URL) return json([]);
    throw new Error(`unexpected ${value}`);
  };
  try {
    const table = await getLangTable({ alecaDir: dir });
    assert.equal(Object.keys(table).length, 1002);
    assert.equal(table['/Lotus/CDNItem0'].zh.name, 'CDN 合成体 0');
    assert.deepEqual(calls, [`${ALECA_CDN_BASE_URL}/json/lang.json`]);
    assertChainSteps('catalog-zh', ['alecaframe-local', 'alecaframe-cdn'], { allowPrefix: true });
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }

  const legacyDir = await makeAlecaDir();
  await rm(join(cacheDir, 'lang-zh-rebuilt.json'), { force: true });
  const legacyCalls = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    legacyCalls.push(value);
    if (value === `${ALECA_CDN_BASE_URL}/json/lang.json`) throw new Error('cdn down');
    if (value === WARFRAMESTAT_ITEMS_ZH_URL) {
      return json(Array.from({ length: 1001 }, (_, index) => ({ uniqueName: `/Lotus/Legacy${index}`, name: `Legacy ${index}` })));
    }
    throw new Error(`unexpected ${value}`);
  };
  try {
    const table = await getLangTable({ alecaDir: legacyDir });
    assert.equal(Object.keys(table).length, 1001);
    assert.deepEqual(legacyCalls, [`${ALECA_CDN_BASE_URL}/json/lang.json`, WARFRAMESTAT_ITEMS_ZH_URL]);
    assertChainSteps('catalog-zh', ['alecaframe-local', 'alecaframe-cdn', 'warframestat']);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(legacyDir, { recursive: true, force: true });
  }
});

test('物品/中文目录链（目录 json）：本机命中即止；缺失 → CDN；CDN 失败 → null（无 warframestat 层）', async () => {
  const dir = await makeAlecaDir();
  await writeFile(join(dir, 'cachedData', 'json', 'Relics.json'), JSON.stringify([{ uniqueName: '/Lotus/LocalRelic' }]), 'utf8');
  await rm(join(cacheDir, 'aleca-json_Relics.json'), { force: true });
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error(`network ${url}`); };
  try {
    const local = await readAlecaJson('json/Relics.json', { alecaDir: dir });
    assert.deepEqual(local, [{ uniqueName: '/Lotus/LocalRelic' }]);
    assert.equal(calls.length, 0, '本机命中绝不联网');
  } finally {
    globalThis.fetch = originalFetch;
  }

  await rm(join(dir, 'cachedData', 'json', 'Relics.json'), { force: true });
  await rm(join(cacheDir, 'aleca-json_Relics.json'), { force: true });
  calls.length = 0;
  globalThis.fetch = async (url) => {
    const value = String(url);
    calls.push(value);
    if (value === `${ALECA_CDN_BASE_URL}/json/Relics.json`) return json([{ uniqueName: '/Lotus/CdnRelic' }]);
    throw new Error(`unexpected ${value}`);
  };
  try {
    const cdn = await readAlecaJson('json/Relics.json', { alecaDir: dir });
    assert.deepEqual(cdn, [{ uniqueName: '/Lotus/CdnRelic' }]);
    assert.deepEqual(calls, [`${ALECA_CDN_BASE_URL}/json/Relics.json`]);
    assertChainSteps('catalog-zh', ['alecaframe-local', 'alecaframe-cdn'], { allowPrefix: true });
  } finally {
    globalThis.fetch = originalFetch;
  }

  await rm(join(cacheDir, 'aleca-json_Mods.json'), { force: true });
  calls.length = 0;
  globalThis.fetch = async (url) => {
    const value = String(url);
    calls.push(value);
    if (value === `${ALECA_CDN_BASE_URL}/json/Mods.json`) throw new Error('cdn down');
    throw new Error(`unexpected ${value}`);
  };
  try {
    const none = await readAlecaJson('json/Mods.json', { alecaDir: dir });
    assert.equal(none, null, '目录 json 无 warframestat 层，失败即空');
    assert.deepEqual(calls, [`${ALECA_CDN_BASE_URL}/json/Mods.json`]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

const dateOf = (ms) => ({ $date: { $numberLong: String(ms) } });

const minimalOfficialRaw = (now = Date.now()) => ({
  Time: Math.floor(now / 1000),
  ActiveMissions: [], VoidStorms: [], Alerts: [], Invasions: [], Goals: [],
  VoidTraders: [], SyndicateMissions: [], Conquests: [],
  Sorties: [], LiteSorties: [], EndlessXpSchedule: [], KnownCalendarSeasons: [],
  SeasonInfo: null,
});

const minimalOracleRaw = () => ({
  Events: [], Goals: [], Alerts: [], Sorties: [], LiteSorties: [],
  ActiveMissions: [], VoidTraders: [], VoidStorms: [], DailyDeals: [], Conquests: [], Tmp: null,
});

test('PC 世界状态链：官方成功即止；官方失败+warframestat 失败只回退可靠缓存，Oracle 绝不单独/写入缓存', async () => {
  const observedSteps = [];
  const writes = [];
  let reliableSnapshot = null;
  let warframestatUp = false;
  let officialCalls = 0;
  const staleCache = async (name, _options, loader) => {
    try {
      const data = await loader();
      writes.push(name);
      return { data, stale: false, cachedAt: null };
    } catch (error) {
      if (name === 'worldstate-normalized-pc' && reliableSnapshot) {
        return { data: reliableSnapshot, stale: true, cachedAt: Date.parse(reliableSnapshot.timestamp) };
      }
      throw error;
    }
  };
  const readCached = async () => (reliableSnapshot
    ? { data: reliableSnapshot, cachedAt: Date.parse(reliableSnapshot.timestamp) }
    : null);
  const fetchJson = async (url) => {
    const value = String(url);
    if (value === DE_OFFICIAL_WORLDSTATE_URL) {
      observedSteps.push('de-official');
      officialCalls += 1;
      if (officialCalls === 1) return minimalOfficialRaw();
      throw new Error('official down');
    }
    if (value.startsWith(WARFRAMESTAT_BASE_URL)) {
      observedSteps.push('warframestat');
      if (warframestatUp) {
        return { timestamp: new Date().toISOString(), fissures: [{ id: 'wf-f1' }], alerts: [], invasions: [] };
      }
      throw new Error('warframestat down');
    }
    if (value.includes('oracle.browse.wf')) {
      observedSteps.push('oracle');
      return {
        data: minimalOracleRaw(),
        responseMeta: { lastModified: new Date(Date.now() - 60_000).toUTCString(), etag: '"e"', cacheControl: 'public,max-age=10' },
      };
    }
    throw new Error(`unexpected ${value}`);
  };
  const load = () => loadWorldState('pc', {
    fetchJson,
    staleCachedJson: staleCache,
    readCachedData: readCached,
    getBountyZhMaps: async () => ({ nodes: {} }),
    getLangTable: async () => ({}),
    crossCheck: false,
  });

  // 第一轮：官方成功 → 不再触碰备用源；官方结果写入可靠缓存
  const first = await load();
  assert.equal(first._dataSource, 'api.warframe.com');
  assert.equal(first._officialFallback, false);
  assertChainSteps('worldstate-pc', observedSteps, { allowPrefix: true });
  assert.deepEqual(observedSteps, ['de-official']);
  assert.ok(writes.includes('worldstate-normalized-pc'), '官方结果必须写入可靠缓存');
  reliableSnapshot = first;

  // 第二轮：官方失败 + warframestat 失败 + Oracle 可用 → 只回退可靠缓存：
  // Oracle 绝不单独返回、不叠加、不写可靠缓存
  observedSteps.length = 0;
  const writesBefore = writes.length;
  const second = await load();
  assert.equal(second._dataStale, true);
  assert.equal(second._onlineSourcesFailed, true);
  assert.equal(second._fieldProviders.fissures, 'api.warframe.com');
  assert.equal(second._oracleEnvelope, undefined);
  assert.ok(observedSteps.includes('oracle'), '官方失败后 Oracle 被探测');
  assertChainSteps('worldstate-pc', observedSteps.filter((step) => step !== 'oracle'), { allowPrefix: true });
  assert.ok(!writes.slice(writesBefore).includes('worldstate-normalized-pc'), '叠加/回退快照绝不写入可靠缓存');

  // 第三轮：官方失败 + warframestat 成功 + Oracle 准予 → 只有 fissures 来自 Oracle 叠加；
  // 叠加对象不写可靠缓存（cached:false）
  warframestatUp = true;
  observedSteps.length = 0;
  const third = await load();
  assert.equal(third._dataSource, 'api.warframestat.us');
  assert.equal(third._officialFallback, true);
  assert.equal(third._fieldProviders.fissures, 'oracle.browse.wf');
  assert.equal(third._fieldProviders.alerts, 'api.warframestat.us');
  assert.equal(third._oracleEnvelope.partial, true);
  assert.deepEqual(third._oracleEnvelope.scope, ['ActiveMissions', 'VoidStorms']);
  assert.deepEqual(third._composite, { base: 'api.warframestat.us', overlay: 'oracle.browse.wf', overlayFields: ['fissures'], cached: false });
  assertChainSteps('worldstate-pc', ['de-official', 'warframestat'], { allowPrefix: true });
});

// ---------- 文档漂移检测 ----------

test('文档事实：references/sources.md 与 operations.md 与合同一致（零漂移）', async () => {
  const sources = await readFile(join(skillRoot, 'references', 'sources.md'), 'utf8');
  const operations = await readFile(join(skillRoot, 'references', 'operations.md'), 'utf8');
  const docs = { 'references/sources.md': sources, 'references/operations.md': operations };
  assert.deepEqual(sourceDocViolations(docs), []);
  validateSourceDocs(docs);
  assert.ok(DOC_FACTS.length >= 7);
});

test('文档漂移（负向）：缺失路由、颠倒顺序、少关键事实、文档缺失都失败', async () => {
  const sources = await readFile(join(skillRoot, 'references', 'sources.md'), 'utf8');
  const operations = await readFile(join(skillRoot, 'references', 'operations.md'), 'utf8');
  const docs = { 'references/sources.md': sources, 'references/operations.md': operations };

  // 缺失路由：抽走全部 Oracle 世界状态 URL（行 15 与新合同节各一处）
  const missingOracle = { ...docs, 'references/sources.md': sources.replaceAll(ORACLE_WORLDSTATE_URL, 'https://oracle.example.invalid/removed') };
  assert.throws(() => validateSourceDocs(missingOracle), /漂移.*worldstate-pc\.order/u);

  // 顺序颠倒：只有链 1 顺序事实的自定义文档，把官方与 warframestat 对调 → doc_order
  const reordered = { 'references/sources.md': `先在文档里写备用 https://api.warframestat.us/{platform}，再写官方 ${DE_OFFICIAL_WORLDSTATE_URL}，最后 Oracle ${ORACLE_WORLDSTATE_URL}` };
  const orderViolations = sourceDocViolations(reordered, DOC_FACTS.filter((fact) => fact.id === 'worldstate-pc.order'));
  assert.deepEqual(orderViolations.map((violation) => violation.code), ['doc_order']);

  // 关键事实缺失：Market 语义 needle 被改写 → doc_drift
  const marketBroken = { ...docs, 'references/sources.md': sources.replace('不得把在线挂单伪装成成交价', '不得把挂单当成交') };
  const marketViolations = sourceDocViolations(marketBroken, DOC_FACTS.filter((fact) => fact.id === 'market-readonly.semantics'));
  assert.ok(marketViolations.some((violation) => violation.code === 'doc_drift'));

  // 文档整个缺失 → doc_missing
  assert.deepEqual(sourceDocViolations({}, DOC_FACTS.slice(0, 1)).map((violation) => violation.code), ['doc_missing']);
});
