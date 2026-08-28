// 生产数据源优先级与降级语义合同（R5 第六片）：四条公共数据链的单一机器可读真源。
//
// references/sources.md 与 references/operations.md 记录的降级事实——① PC 世界状态
// （DE 官方为主 → warframestat 全量备用 → 可靠缓存末级；browse.wf Oracle 部分镜像仅
// 在官方失败且 warframestat 成功时叠加 fissures 字段，不可单独、不写可靠缓存）、
// ② Warframe.Market 只读目录/详情/订单/成交统计（分端点健康；历史成交不得冒充实时）、
// ③ 掉落查询（warframestat drops → WFCD GitHub 备用）、④ 物品/中文目录
// （本机 AlecaFrame → AlecaFrame CDN → warframestat 旧兜底）——在本模块以结构化数据
// 固化；生产模块从这里取规范路由常量，测试按本合同的 provider/链/端点注册表与
// 文档事实校验真实实现路径。缺失、重复、未知 provider、错误顺序、错误角色或文档漂移
// 都会失败。
//
// 本模块是只读契约层：零网络、零凭据、零文件写入、零副作用。

// ---------- 规范路由常量（真实模块从这里取） ----------

export const DE_OFFICIAL_WORLDSTATE_URL = 'https://api.warframe.com/cdn/worldState.php';
export const WARFRAMESTAT_BASE_URL = 'https://api.warframestat.us';
export const WARFRAMESTAT_DROPS_SEARCH_URL = 'https://api.warframestat.us/drops/search/';
export const WARFRAMESTAT_ITEMS_ZH_URL = 'https://api.warframestat.us/items?language=zh&only=uniqueName,name';
export const ORACLE_WORLDSTATE_URL = 'https://oracle.browse.wf/worldState.min.json';
export const MARKET_BASE_URL = 'https://api.warframe.market';
export const WFCD_DROP_DATA_BASE_URL = 'https://raw.githubusercontent.com/WFCD/warframe-drop-data/gh-pages/data';
export const WFCD_DROPS_SLIM_URL = `${WFCD_DROP_DATA_BASE_URL}/all.slim.json`;
export const ALECA_CDN_BASE_URL = 'https://cdn.alecaframe.com/warframeData';

// ---------- provider 注册表 ----------

// id 稳定不可变：唯一性/未知性由 validateSourceContract 强制。
// kind: remote（网络端点）/ local（本机文件）/ cache（本地可靠缓存层）。
// roles：该 provider 在四条公共链中允许扮演的角色（链步骤的 role 必须 ∈ roles）。
export const SOURCE_PROVIDERS = Object.freeze([
  Object.freeze({ id: 'de-official', kind: 'remote', host: 'api.warframe.com', roles: Object.freeze(['worldstate-primary']) }),
  Object.freeze({
    id: 'warframestat', kind: 'remote', host: 'api.warframestat.us',
    roles: Object.freeze(['full-fallback', 'drops-query-primary', 'catalog-zh-legacy']),
  }),
  Object.freeze({ id: 'oracle', kind: 'remote', host: 'oracle.browse.wf', roles: Object.freeze(['worldstate-fissure-overlay']) }),
  Object.freeze({ id: 'warframe-market', kind: 'remote', host: 'api.warframe.market', roles: Object.freeze(['market-readonly']) }),
  Object.freeze({ id: 'wfcd-github', kind: 'remote', host: 'raw.githubusercontent.com', roles: Object.freeze(['drops-query-fallback']) }),
  Object.freeze({ id: 'alecaframe-local', kind: 'local', roles: Object.freeze(['catalog-zh-primary']) }),
  Object.freeze({ id: 'alecaframe-cdn', kind: 'remote', host: 'cdn.alecaframe.com', roles: Object.freeze(['catalog-zh-fallback']) }),
  Object.freeze({ id: 'reliable-cache', kind: 'cache', roles: Object.freeze(['worldstate-last-resort']) }),
]);

// ---------- 链注册表 ----------

// SOURCE_CHAINS：名称稳定不可变（缺失/未知即失败）。
// steps 顺序即降级顺序：第 N 步只在第 N-1 步失败后生效；角色由 STEP_ORDER 矩阵锁定。
// overlays 是「不构成独立层级」的条件字段级叠加：只在基底步生效后叠加，永不单独。
export const SOURCE_CHAINS = Object.freeze({
  'worldstate-pc': Object.freeze({
    label: 'PC 世界状态',
    steps: Object.freeze([
      Object.freeze({ provider: 'de-official', role: 'worldstate-primary' }),
      Object.freeze({ provider: 'warframestat', role: 'full-fallback' }),
      Object.freeze({ provider: 'reliable-cache', role: 'worldstate-last-resort' }),
    ]),
    overlays: Object.freeze([
      Object.freeze({
        provider: 'oracle',
        role: 'fissure-overlay',
        base: 'warframestat',
        baseRole: 'full-fallback',
        // 门禁：只在「官方失败」且「warframestat 全量成功」时叠加裂缝字段；
        // 官方成功或 warframestat 失败都不允许叠加，单独或写可靠缓存一律禁止。
        gate: Object.freeze({ official: 'failed', community: 'success' }),
        standalone: false,
        cacheable: false,
        fields: Object.freeze(['fissures']),
      }),
    ]),
  }),
  'market-readonly': Object.freeze({
    label: 'Warframe.Market 只读目录/详情/订单/成交统计',
    // 端点级韧性：四类端点各有独立健康键（resilienceKey）；全部只读；
    // dataKind 区分事实口径：orders=实时挂单，statistics=已成交历史（closed-history，
    // neverRealTime=true —— 历史成交绝不冒充实时价格）。
    endpoints: Object.freeze([
      Object.freeze({ id: 'catalog', path: '/v2/items', dataKind: 'catalog', readOnly: true, resilienceKey: 'market:v2:catalog' }),
      Object.freeze({ id: 'detail', path: '/v2/item/{slug}', dataKind: 'catalog', readOnly: true, resilienceKey: 'market:v2:detail' }),
      Object.freeze({ id: 'orders', path: '/v2/orders/item/{slug}/top', dataKind: 'live', readOnly: true, realTime: true, resilienceKey: 'market:v2:orders' }),
      Object.freeze({ id: 'statistics', path: '/v1/items/{slug}/statistics', dataKind: 'closed-history', readOnly: true, realTime: false, neverRealTime: true, resilienceKey: 'market:v1:statistics' }),
    ]),
  }),
  'drops-query': Object.freeze({
    label: '掉率查询',
    steps: Object.freeze([
      Object.freeze({ provider: 'warframestat', role: 'drops-query-primary' }),
      Object.freeze({ provider: 'wfcd-github', role: 'drops-query-fallback' }),
    ]),
  }),
  'catalog-zh': Object.freeze({
    label: '物品/中文目录',
    // scope 单调收窄：本地与 CDN 覆盖全部（目录 json + lang 中文名），
    // warframestat 旧兜底只重建 lang 表（目录 json 无该层）。
    steps: Object.freeze([
      Object.freeze({ provider: 'alecaframe-local', role: 'catalog-zh-primary', scope: Object.freeze(['catalog-json', 'lang']) }),
      Object.freeze({ provider: 'alecaframe-cdn', role: 'catalog-zh-fallback', scope: Object.freeze(['catalog-json', 'lang']) }),
      Object.freeze({ provider: 'warframestat', role: 'catalog-zh-legacy', scope: Object.freeze(['lang']) }),
    ]),
  }),
});

const DOCUMENTED_CHAIN_NAMES = Object.freeze(['worldstate-pc', 'market-readonly', 'drops-query', 'catalog-zh']);

// 链「顺序 × 角色」矩阵：provider:role 必须逐位相等（错误顺序/错误角色都失败）。
const STEP_ORDER = Object.freeze({
  'worldstate-pc': Object.freeze(['de-official:worldstate-primary', 'warframestat:full-fallback', 'reliable-cache:worldstate-last-resort']),
  'drops-query': Object.freeze(['warframestat:drops-query-primary', 'wfcd-github:drops-query-fallback']),
  'catalog-zh': Object.freeze(['alecaframe-local:catalog-zh-primary', 'alecaframe-cdn:catalog-zh-fallback', 'warframestat:catalog-zh-legacy']),
});

// 规范路由常量 → 所属 provider（自检：常量主机必须与 provider 注册表一致）。
const ROUTE_OWNERS = Object.freeze([
  [DE_OFFICIAL_WORLDSTATE_URL, 'de-official'],
  [WARFRAMESTAT_BASE_URL, 'warframestat'],
  [WARFRAMESTAT_DROPS_SEARCH_URL, 'warframestat'],
  [WARFRAMESTAT_ITEMS_ZH_URL, 'warframestat'],
  [ORACLE_WORLDSTATE_URL, 'oracle'],
  [MARKET_BASE_URL, 'warframe-market'],
  [WFCD_DROPS_SLIM_URL, 'wfcd-github'],
  [ALECA_CDN_BASE_URL, 'alecaframe-cdn'],
]);

const MARKET_ENDPOINT_IDS = Object.freeze(['catalog', 'detail', 'orders', 'statistics']);
const MARKET_DATA_KINDS = Object.freeze(new Set(['catalog', 'live', 'closed-history']));
const MARKET_SCOPES = Object.freeze(new Set(['catalog-json', 'lang']));

function defaultRegistry() {
  return { providers: SOURCE_PROVIDERS, chains: SOURCE_CHAINS };
}

/** 文档化链名称（按文档顺序） */
export function documentedChainNames() {
  return [...DOCUMENTED_CHAIN_NAMES];
}

/** provider 注册表按 id 建索引 */
export function providerById(registry = defaultRegistry()) {
  return new Map((registry.providers || []).map((provider) => [provider.id, provider]));
}

/** 链步骤列表（只读视图） */
export function chainSteps(chainName, registry = defaultRegistry()) {
  const chain = registry.chains?.[chainName];
  return chain?.steps || [];
}

/** 链端点列表（只读视图） */
export function chainEndpoints(chainName, registry = defaultRegistry()) {
  const chain = registry.chains?.[chainName];
  return chain?.endpoints || [];
}

/**
 * 校验数据源注册表（默认校验真实注册表；测试可注入被破坏的注册表）：
 * provider 缺失/重复/未知、链缺失/未知、链步骤顺序或角色错误、provider 角色未声明、
 * Oracle 叠加层违背「不单独/不缓存/仅 fissures/门禁」、Market 端点只读/口径/健康键
 * 错误、目录链 scope 收窄违反——全部抛错。通过时返回 { chains, providers }。
 */
export function validateSourceContract(registry = defaultRegistry()) {
  const providers = registry?.providers;
  const chains = registry?.chains;
  if (!providers || !Array.isArray(providers)) throw new Error('数据源合同 provider 注册表必须是数组');
  if (!chains || typeof chains !== 'object' || Array.isArray(chains)) throw new Error('数据源合同链注册表必须是对象');

  // provider 唯一性（重复失败）
  const providerIds = new Set();
  for (const provider of providers) {
    if (!provider?.id || typeof provider.id !== 'string' || !provider.id.trim()) throw new Error('provider 缺少 id');
    if (providerIds.has(provider.id)) throw new Error(`数据源合同 provider 重复: ${provider.id}`);
    providerIds.add(provider.id);
    if (!Array.isArray(provider.roles) || provider.roles.length === 0) throw new Error(`provider ${provider.id} 缺少角色`);
    if (provider.kind === 'remote' && (!provider.host || !/^[a-z0-9.-]+$/u.test(provider.host))) {
      throw new Error(`provider ${provider.id} 远程主机非法: ${provider.host}`);
    }
  }
  const providerByIdMap = new Map(providers.map((provider) => [provider.id, provider]));

  // 链集合完整性（缺失/未知失败）
  const chainNames = Object.keys(chains);
  const missingChains = DOCUMENTED_CHAIN_NAMES.filter((name) => !(name in chains));
  if (missingChains.length) throw new Error(`数据源合同缺失链: ${missingChains.join(', ')}`);
  const unknownChains = chainNames.filter((name) => !DOCUMENTED_CHAIN_NAMES.includes(name));
  if (unknownChains.length) throw new Error(`数据源合同含未知链: ${unknownChains.join(', ')}`);

  // 路由常量主机自检（与 provider 注册表一致）
  for (const [url, ownerId] of ROUTE_OWNERS) {
    const owner = providerByIdMap.get(ownerId);
    if (owner?.host) {
      const host = new URL(url).hostname;
      if (owner.host !== host) throw new Error(`路由常量 ${url} 与 provider ${ownerId} 主机不一致: ${owner.host} ≠ ${host}`);
    }
  }

  const usedProviders = new Set();
  const checkStep = (chainName, step, index) => {
    if (!step?.provider || typeof step.provider !== 'string') throw new Error(`链 ${chainName} 第 ${index + 1} 步缺少 provider`);
    const provider = providerByIdMap.get(step.provider);
    if (!provider) throw new Error(`链 ${chainName} 引用未知 provider: ${step.provider}`);
    usedProviders.add(provider.id);
    if (!provider.roles.includes(step.role)) {
      throw new Error(`链 ${chainName} 第 ${index + 1} 步 provider ${step.provider} 未声明角色 ${step.role}`);
    }
    return provider;
  };

  // 角色前置检查（先于顺序矩阵）：Oracle 绝不能作为链步骤；
  // 可靠缓存只能作为 worldstate-pc 末级，其他链不得使用。
  for (const chainName of DOCUMENTED_CHAIN_NAMES) {
    for (const step of chains[chainName].steps || []) {
      if (step?.provider === 'oracle') throw new Error('oracle 绝不能作为链步骤（部分镜像只能作为条件叠加层）');
    }
    if (chainName !== 'worldstate-pc' && (chains[chainName].steps || []).some((step) => step.provider === 'reliable-cache')) {
      throw new Error(`链 ${chainName} 不得使用可靠缓存层（只能作为世界状态末级）`);
    }
  }
  if (chains['worldstate-pc']?.steps?.at(-1)?.provider !== 'reliable-cache') {
    throw new Error('worldstate-pc 末级必须是可靠缓存（online 全部失败才回退）');
  }

  // 步骤顺序 × 角色矩阵（错误顺序/错误角色失败）
  for (const [chainName, expected] of Object.entries(STEP_ORDER)) {
    const chain = chains[chainName];
    if (!chain || !Array.isArray(chain.steps)) throw new Error(`链 ${chainName} 缺少 steps`);
    if (chain.steps.length !== expected.length) {
      throw new Error(`链 ${chainName} 步骤数与文档不符: ${chain.steps.length} ≠ ${expected.length}`);
    }
    chain.steps.forEach((step, index) => {
      checkStep(chainName, step, index);
      const signature = `${step.provider}:${step.role}`;
      if (signature !== expected[index]) {
        throw new Error(`链 ${chainName} 第 ${index + 1} 步顺序/角色错误: ${signature}（期望 ${expected[index]}）`);
      }
    });
  }

  // 链内 provider 不重复
  for (const chainName of DOCUMENTED_CHAIN_NAMES) {
    const ids = (chains[chainName].steps || []).map((step) => step.provider);
    if (new Set(ids).size !== ids.length) throw new Error(`链 ${chainName} 步骤 provider 重复`);
  }

  // worldstate-pc：Oracle 部分镜像只能作为裂缝字段级叠加层
  const ws = chains['worldstate-pc'];
  if (!Array.isArray(ws.overlays) || ws.overlays.length !== 1) {
    throw new Error('worldstate-pc 必须有且仅有一个叠加层定义');
  }
  for (const overlay of ws.overlays) {
    const provider = providerByIdMap.get(overlay.provider);
    if (!provider) throw new Error(`worldstate-pc 叠加层引用未知 provider: ${overlay.provider}`);
    usedProviders.add(provider.id);
    if (!provider.roles.includes('worldstate-fissure-overlay') || overlay.role !== 'fissure-overlay') {
      throw new Error(`provider ${overlay.provider} 的角色必须是 fissure-overlay（只能叠加，不能作为链步骤）`);
    }
    if (overlay.standalone !== false) throw new Error(`provider ${overlay.provider} 必须 standalone:false（部分镜像不可单独作为完整状态）`);
    if (overlay.cacheable !== false) throw new Error(`provider ${overlay.provider} 必须 cacheable:false（叠加结果不写入可靠缓存）`);
    if (!ws.steps.some((step) => step.provider === overlay.base && step.role === overlay.baseRole)) {
      throw new Error(`provider ${overlay.provider} 的叠加基底必须是 ${overlay.base}(${overlay.baseRole})`);
    }
    if (overlay.gate?.official !== 'failed' || overlay.gate?.community !== 'success') {
      throw new Error(`provider ${overlay.provider} 的门禁必须是「官方失败 + warframestat 成功」`);
    }
    if (!Array.isArray(overlay.fields) || overlay.fields.length === 0 || overlay.fields.some((field) => field !== 'fissures')) {
      throw new Error(`provider ${overlay.provider} 只允许叠加 fissures 字段`);
    }
  }
  // Oracle 绝不能作为任何链的步骤（不可单独/不可作完整状态）——见上面前置检查；
  // 这里只负责叠加层自身语义。可靠缓存是 worldstate-pc 末级（见上面前置检查）。

  // market-readonly：恰好四类端点、全只读、口径分离、健康键唯一
  const market = chains['market-readonly'];
  if (!Array.isArray(market.endpoints) || market.endpoints.length !== MARKET_ENDPOINT_IDS.length) {
    throw new Error('market-readonly 端点数与文档不符');
  }
  const marketById = new Map(market.endpoints.map((endpoint) => [endpoint.id, endpoint]));
  const missingEndpoints = MARKET_ENDPOINT_IDS.filter((id) => !marketById.has(id));
  const unknownEndpoints = [...marketById.keys()].filter((id) => !MARKET_ENDPOINT_IDS.includes(id));
  if (missingEndpoints.length) throw new Error(`market-readonly 缺失端点: ${missingEndpoints.join(', ')}`);
  if (unknownEndpoints.length) throw new Error(`market-readonly 含未知端点: ${unknownEndpoints.join(', ')}`);
  const keys = new Set();
  const paths = new Set();
  for (const id of MARKET_ENDPOINT_IDS) {
    const endpoint = marketById.get(id);
    if (!endpoint || typeof endpoint !== 'object') throw new Error(`market-readonly 端点 ${id} 缺少契约条目`);
    if (endpoint.readOnly !== true) throw new Error(`Market 端点 ${id} 必须只读（绝不执行写操作）`);
    if (!MARKET_DATA_KINDS.has(endpoint.dataKind)) throw new Error(`Market 端点 ${id} 数据口径未知: ${endpoint.dataKind}`);
    if (typeof endpoint.resilienceKey !== 'string' || !endpoint.resilienceKey.trim()) throw new Error(`Market 端点 ${id} 缺少端点健康键`);
    if (keys.has(endpoint.resilienceKey)) throw new Error(`Market 端点健康键重复: ${endpoint.resilienceKey}`);
    if (typeof endpoint.path !== 'string' || !endpoint.path.startsWith('/')) throw new Error(`Market 端点 ${id} 路径非法: ${endpoint.path}`);
    if (paths.has(endpoint.path)) throw new Error(`Market 端点路径重复: ${endpoint.path}`);
    keys.add(endpoint.resilienceKey);
    paths.add(endpoint.path);
  }
  if (marketById.get('orders')?.dataKind !== 'live' || marketById.get('orders')?.realTime !== true) {
    throw new Error('orders 端点必须声明实时挂单口径（dataKind=live, realTime=true）');
  }
  const statistics = marketById.get('statistics');
  if (statistics?.dataKind !== 'closed-history' || statistics?.realTime !== false || statistics?.neverRealTime !== true) {
    throw new Error('statistics 端点必须声明已成交历史口径（dataKind=closed-history, neverRealTime=true）——历史价不得冒充实时');
  }
  usedProviders.add('warframe-market');

  // catalog-zh：scope 单调收窄（末级只允许 lang）
  const catalog = chains['catalog-zh'];
  if (catalog.steps.length >= 2) {
    for (let index = 1; index < catalog.steps.length; index += 1) {
      const previous = new Set(catalog.steps[index - 1].scope || []);
      const current = catalog.steps[index].scope || [];
      if (current.some((item) => !previous.has(item))) {
        throw new Error(`链 catalog-zh 第 ${index + 1} 步 scope 扩大（降级链只能收窄）: ${current.join(',')}`);
      }
    }
    const lastScope = catalog.steps.at(-1).scope || [];
    if (!lastScope.includes('lang')) throw new Error('链 catalog-zh 末级必须覆盖 lang（warframestat 旧兜底只重建中文名表）');
    for (const step of catalog.steps) {
      for (const item of step.scope || []) {
        if (!MARKET_SCOPES.has(item)) throw new Error(`链 catalog-zh 出现未知 scope: ${item}`);
      }
    }
  }

  // 每个声明的 provider 都必须被链使用（防孤儿/未知漂移）
  for (const provider of providers) {
    if (!usedProviders.has(provider.id)) throw new Error(`数据源合同未使用 provider: ${provider.id}`);
  }

  return { chains: [...DOCUMENTED_CHAIN_NAMES], providers: [...providerIds] };
}

/**
 * 断言观察到的实际降级序列与合同一致（默认要求整链完全相等；
 * allowPrefix=true 时允许只观察到前若干步——例如测试只覆盖到某一层）。
 */
export function assertChainSteps(chainName, observedProviders, { allowPrefix = false } = {}) {
  const registry = defaultRegistry();
  const chain = registry.chains?.[chainName];
  if (!chain) throw new Error(`数据源合同没有链: ${chainName}`);
  const expected = chain.steps.map((step) => step.provider);
  const observed = (observedProviders || []).map((provider) => String(provider));
  for (let index = 0; index < observed.length; index += 1) {
    if (observed[index] !== expected[index]) {
      throw new Error(`链 ${chainName} 观察顺序偏差: 第 ${index + 1} 步 ${observed[index]} ≠ 合同 ${expected[index]}`);
    }
  }
  if (!allowPrefix && observed.length !== expected.length) {
    throw new Error(`链 ${chainName} 观察步骤数不符: [${observed.join(', ')}] ≠ [${expected.join(', ')}]`);
  }
  return { chain: chainName, expected, observed, prefix: observed.length < expected.length };
}

/**
 * Market URL → 端点分类（只读，不抛错）：命中返回 { id, dataKind, resilienceKey, readOnly }；
 * 非 Market 主机或不匹配的路径返回 null。可用它审计真实实现的路由/健康键映射。
 */
export function classifyMarketEndpoint(url, options = {}) {
  const endpoints = options.endpoints || chainEndpoints('market-readonly');
  const baseUrl = options.baseUrl || MARKET_BASE_URL;
  let parsed;
  try { parsed = new URL(String(url)); } catch { return null; }
  let baseHost;
  try { baseHost = new URL(baseUrl).hostname; } catch { return null; }
  if (parsed.hostname !== baseHost) return null;
  for (const endpoint of endpoints) {
    const pattern = String(endpoint.path).replace(/\{slug\}/gu, '[^/]+');
    if (new RegExp(`^${pattern}$`, 'u').test(parsed.pathname)) {
      return { id: endpoint.id, dataKind: endpoint.dataKind, resilienceKey: endpoint.resilienceKey, readOnly: endpoint.readOnly };
    }
  }
  return null;
}

/** Market URL → 数据口径（live / catalog / closed-history；未命中返回 null） */
export function marketDataKindOf(url, options = {}) {
  return classifyMarketEndpoint(url, options)?.dataKind ?? null;
}

// ---------- 文档事实（references 漂移检测） ----------

// 每条事实 = 一个文档文件 + 一组必须逐字出现的 needle（缺失=漂移）与/或
// 一组必须按出现顺序排列的 needle（order=颠序=漂移）。文件路径相对仓库根。
export const DOC_FACTS = Object.freeze([
  Object.freeze({
    id: 'worldstate-pc.order',
    file: 'references/sources.md',
    order: Object.freeze([DE_OFFICIAL_WORLDSTATE_URL, 'https://api.warframestat.us/{platform}', ORACLE_WORLDSTATE_URL]),
  }),
  Object.freeze({
    id: 'worldstate-pc.gates',
    file: 'references/sources.md',
    needles: Object.freeze(['部分镜像', '绝不能单独', '不写入可靠缓存', 'Last-Modified', 'ActiveMissions/VoidStorms']),
  }),
  Object.freeze({
    id: 'market-readonly.order',
    file: 'references/sources.md',
    order: Object.freeze(['/v2/items', '/v2/item/{slug}', '/v2/orders/item/{slug}/top', '/v1/items/{slug}/statistics']),
  }),
  Object.freeze({
    id: 'market-readonly.semantics',
    file: 'references/sources.md',
    needles: Object.freeze(['statistics_closed', '不得把在线挂单伪装成成交价', '分别维护端点健康', '只读']),
  }),
  Object.freeze({
    id: 'drops-query.order',
    file: 'references/sources.md',
    order: Object.freeze([WARFRAMESTAT_DROPS_SEARCH_URL, WFCD_DROPS_SLIM_URL]),
  }),
  Object.freeze({
    id: 'catalog-zh.order',
    file: 'references/sources.md',
    order: Object.freeze(['cachedData', ALECA_CDN_BASE_URL, 'api.warframestat.us/items?language=zh']),
  }),
  Object.freeze({
    id: 'data-source-contract.bullet',
    file: 'references/operations.md',
    needles: Object.freeze(['数据源合同', 'data-source-contract.mjs']),
  }),
]);

/** 文档漂移检查（只读）：返回 [{ code, fact, file, missing?, positions? }]；空 = 无漂移。 */
export function sourceDocViolations(docs = {}, facts = DOC_FACTS) {
  const failures = [];
  for (const fact of facts) {
    const text = String(docs[fact.file] ?? '');
    if (!text) {
      failures.push({ code: 'doc_missing', fact: fact.id, file: fact.file });
      continue;
    }
    for (const needle of fact.needles || []) {
      if (!text.includes(needle)) failures.push({ code: 'doc_drift', fact: fact.id, file: fact.file, missing: needle });
    }
    if (Array.isArray(fact.order) && fact.order.length > 1) {
      for (const needle of fact.order) {
        if (!text.includes(needle)) failures.push({ code: 'doc_drift', fact: fact.id, file: fact.file, missing: needle });
      }
      const positions = fact.order.map((needle) => text.indexOf(needle));
      if (positions.every((position) => position >= 0)
        && positions.some((position, index) => index > 0 && position < positions[index - 1])) {
        failures.push({ code: 'doc_order', fact: fact.id, file: fact.file, positions });
      }
    }
  }
  return failures;
}

/** 断言文档与合同一致（缺失/漂移/颠序都抛错）；通过时返回 true。 */
export function validateSourceDocs(docs = {}, facts = DOC_FACTS) {
  const failures = sourceDocViolations(docs, facts);
  if (failures.length) {
    throw new Error(`数据源文档漂移: ${failures.map((failure) => (
      `${failure.code}(${failure.fact}@${failure.file}${failure.missing ? ` 缺 ${failure.missing}` : ''})`
    )).join('；')}`);
  }
  return true;
}
