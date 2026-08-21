import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  ARCHIMEDEA_PLACEHOLDER_DESC, ARCHIMEDEA_PLACEHOLDER_NAME, CALENDAR_UPGRADE_PLACEHOLDER_ZH,
  HEALTH_SOURCE_LABEL, NIGHTWAVE_PLACEHOLDER_ZH, SHOP_NAME_PLACEHOLDER_ZH,
  aggregateEndpointHealth, analyzeArchimedeaTranslationDrift, analyzeCalendarUpgradeDrift,
  analyzeNightwaveDrift, analyzeOfficialNormalizedDrift, analyzeOfficialRawDrift,
  sanitizeEndpointHealth, scanShopAssemblyLeaks, scanZhTableLeaks, shopNameLeakSeverity,
} from './drift-report.mjs';
import { calendarUpgradeZh, evaluateAutoCheck, localizeArchimedeaModifier, nightwaveChallengeZh } from './weekly.mjs';
import { itemZh } from './vendor-shop.mjs';

// 漂移监控测试（第 6 项）：全部零联网、零凭据、零写入；合成 fixture + 本地静态表。
// 漂移报告是统计 + 可审计键样本，禁止猜数字、禁止自动核销判定、禁止个人分数。

test('占位文案常量与 weekly.mjs 热路径兜底输出保持同步', () => {
  assert.equal(NIGHTWAVE_PLACEHOLDER_ZH, nightwaveChallengeZh({ id: '1786924800000brandnew' }, null));
  assert.equal(ARCHIMEDEA_PLACEHOLDER_NAME, localizeArchimedeaModifier({ key: 'BrandNewMod' }, new Map(), {}).name);
  assert.equal(ARCHIMEDEA_PLACEHOLDER_DESC, localizeArchimedeaModifier({ key: 'BrandNewMod' }, new Map(), {}).desc);
  assert.equal(
    CALENDAR_UPGRADE_PLACEHOLDER_ZH,
    calendarUpgradeZh({ title: 'Totally New Buff' }, '/Lotus/Upgrades/Calendar/TotallyNewBuff', null),
  );
  const names = { zhOf: () => null, catalogZhOf: () => null, catalogTailZhOf: () => null, languageTailZhOf: () => null };
  assert.equal(itemZh('/Lotus/StoreItems/Types/Keys/UnknownInternalKey', names), SHOP_NAME_PLACEHOLDER_ZH);
});

// —— 1) 午夜电波挑战漂移 ——

const nwNamesStub = { nightwaveZhOf: (key) => (key === 'seasonweeklyknown' ? '已知挑战' : null) };
const nwResolveZh = (challenge) => nightwaveChallengeZh(challenge, nwNamesStub);

test('电波挑战缺 requiredCount/译名/关键字段时给出统计与键样本，不猜数字', () => {
  const challenges = [
    { id: '1786924800000seasonweeklybrandnew', isDaily: false, isElite: false }, // 全新周常：未知
    { id: '1786924800000seasonweeklyknown', isDaily: false, isElite: false },    // 已收录
    { id: '1786924800000dailychallengex', isDaily: true },                       // 每日未知（不影响核销安全）
    { isElite: true },                                                           // 缺路径/id
  ];
  const report = analyzeNightwaveDrift(challenges, { requiredByKey: { seasonweeklyknown: 15 }, resolveZh: nwResolveZh });
  assert.equal(report.total, 4);
  assert.equal(report.weekly, 3);
  assert.equal(report.elite, 1);
  assert.equal(report.daily, 1);
  assert.equal(report.missingRequired.count, 3);
  assert.deepEqual(report.missingRequired.keys.map((k) => k.key).sort(), ['', 'dailychallengex', 'seasonweeklybrandnew']);
  assert.equal(report.missingZh.count, 3);
  assert.equal(report.missingKeyFields.count, 1);
  assert.equal(report.checkoffSafe, false);
  // 样本只含键，绝不携带猜测的 required 数值
  for (const sample of [...report.missingRequired.keys, ...report.missingZh.keys, ...report.missingKeyFields.keys]) {
    assert.deepEqual(Object.keys(sample).sort(), ['isDaily', 'isElite', 'key']);
  }
  assert.ok(report.reasons.some((reason) => reason.includes('不猜数量、不自动核销')));
});

test('电波挑战漂移时自动核销被保守禁用（同源判据联测）', () => {
  const challenges = [
    { id: '1786924800000seasonweeklybrandnew', isDaily: false, isElite: false },
    { id: '1786924800000seasonweeklyknown', isDaily: false, isElite: false },
  ];
  const worldState = { nightwave: { activeChallenges: challenges } };
  const inventory = { ChallengeProgress: [{ Name: 'SeasonWeeklyKnown', Progress: 15 }] };
  const result = evaluateAutoCheck(inventory, worldState, Date.now(), { seasonweeklyknown: 15 }, new Date().toISOString());
  // 已收录 1 条命中，但另一条缺 requiredCount → 只报 1/2，不整体核销
  assert.equal(result.progress.nightwave, '周挑战 1/2');
  assert.equal(result.auto.nightwave, undefined);
});

test('电波挑战全部非每日项有 requiredCount 时 checkoffSafe 为真', () => {
  const challenges = [
    { id: '1786924800000seasonweeklyknown', isDaily: false },
    { id: '1786924800000dailychallengex', isDaily: true }, // 每日缺 required 不影响周常核销安全
  ];
  const report = analyzeNightwaveDrift(challenges, { requiredByKey: { seasonweeklyknown: 15 }, resolveZh: nwResolveZh });
  assert.equal(report.checkoffSafe, true);
  assert.equal(report.missingRequired.count, 1); // 每日挑战缺失仍计入统计
});

// —— 2) 科研词缀 / 1999 日历增益占位漂移 ——

function archimedeaFixture(kindKey) {
  const now = Date.now();
  return {
    typeKey: kindKey,
    activation: new Date(now - 86400000).toISOString(),
    expiry: new Date(now + 6 * 86400000).toISOString(),
    missions: [
      { missionType: 'Defense', deviation: { key: 'BrandNewDeviation', name: 'Brand New' }, risks: [{ key: 'UnknownRisk', name: 'Unknown Risk' }] },
      { missionType: 'Survival', risks: [] },
    ],
    personalModifiers: [{ key: 'FreshPersonal', name: 'Fresh Personal' }],
  };
}

test('科研词缀占位统计与可审计键样本（LAB/HEX 分桶），不输出个人分数', () => {
  const entries = [archimedeaFixture('CT_LAB'), archimedeaFixture('CT_HEX')];
  // 空词典/空静态表：全部词缀落占位（每套 3 个：deviation + risk + personal）
  const report = analyzeArchimedeaTranslationDrift(entries, { oracleMap: null, oracleTailMap: null, staticZh: {} });
  assert.equal(report.total, 6);
  assert.equal(report.nameUntranslated, 6);
  assert.equal(report.descPlaceholder, 6);
  assert.equal(report.byKind.LAB.total, 3);
  assert.equal(report.byKind.HEX.total, 3);
  assert.equal(report.byKind.LAB.nameUntranslated, 3);
  // 样本键可审计：kind/where/key/name
  assert.ok(report.samples.some((s) => s.kind === 'LAB' && s.where === 'deviation' && s.key === 'BrandNewDeviation'));
  assert.ok(report.samples.some((s) => s.kind === 'HEX' && s.where === 'personal' && s.key === 'FreshPersonal'));
  // 明确不含任何个人分数/快照字段
  const json = JSON.stringify(report);
  assert.ok(!/ConquestCacheScore|ChallengeProgress|standing|tokens/iu.test(json), '漂移报告不得携带个人分数');
  assert.ok(!/score/iu.test(json), '漂移报告不得出现 score 字段');
});

test('科研词缀已翻译但缺说明时只算软漂移（descPlaceholder）', () => {
  const oracleMap = new Map([['Brand New', [{ name: '新词缀', descEn: 'Brand New', desc: '' }]]]);
  const entries = [archimedeaFixture('CT_LAB')];
  const report = analyzeArchimedeaTranslationDrift(entries, { oracleMap, oracleTailMap: null, staticZh: {} });
  assert.equal(report.nameUntranslated, 2); // 只有 deviation 有译名
  assert.equal(report.descPlaceholder, 3); // deviation 有译名但说明为空也算软漂移
  assert.equal(report.byKind.LAB.descPlaceholder, 3);
});

test('1999 日历增益占位统计与键样本（未翻译 / 静态手订占位分列），无个人数据', () => {
  const days = [
    { date: '2026-01-01T00:00:00.000Z', events: [{ type: 'Override', upgrade: { title: 'Energy Waves On Combo' }, upgradePath: '/Lotus/Upgrades/Calendar/EnergyWavesOnCombo' }] },
    { date: '2026-01-02T00:00:00.000Z', events: [{ type: 'Override', upgrade: { title: 'OvershieldCap' }, upgradePath: '/Lotus/Upgrades/Calendar/OvershieldCap' }] },
    { date: '2026-01-03T00:00:00.000Z', events: [{ type: 'Override', upgrade: { title: 'Radial Javelin On Heavy' }, upgradePath: '/Lotus/Upgrades/Calendar/RadialJavelinOnHeavy' }] },
    { date: '2026-01-04T00:00:00.000Z', events: [{ type: 'Big Prize!', reward: 'Kuva' }] },
  ];
  const report = analyzeCalendarUpgradeDrift(days);
  assert.equal(report.total, 3);
  assert.equal(report.untranslated, 1); // EnergyWavesOnCombo：上游未收录 → 诚实占位
  assert.equal(report.staticPlaceholder, 1); // RadialJavelinOnHeavy：静态表手订占位
  assert.deepEqual(report.samples.map((s) => s.path).sort(), [
    '/Lotus/Upgrades/Calendar/EnergyWavesOnCombo',
    '/Lotus/Upgrades/Calendar/RadialJavelinOnHeavy',
  ]);
  const json = JSON.stringify(report);
  assert.ok(!/Progress|standing|score|Inventory/iu.test(json), '日历漂移报告不得携带个人数据');
});

// —— 3) 商店装配内部名泄漏扫描 ——

test('装配行泄漏分级：路径整漏 / 尾段直出 / 类名与驼峰内部名', () => {
  assert.equal(shopNameLeakSeverity('/Lotus/Types/Items/MiscItems/WeaponUtilityUnlocker', '/Lotus/Types/Items/MiscItems/WeaponUtilityUnlocker'), 'path');
  assert.equal(shopNameLeakSeverity('WeaponUtilityUnlockerBlueprint', '/Lotus/Types/Items/MiscItems/WeaponUtilityUnlockerBlueprint'), 'tail');
  // 显示名等于路径尾段：尾段直出（最常见泄漏形态）
  assert.equal(shopNameLeakSeverity('AshCrewedCaptainGenerator', '/Lotus/Types/StoreItems/JadeShadowsPart2Mission/CrewMembers/AshCrewedCaptainGenerator'), 'tail');
  // 显示名是内部类名但与路径尾段不一致（跨字段错位泄漏）
  assert.equal(shopNameLeakSeverity('AshCrewedCaptainGenerator', '/Lotus/Types/StoreItems/JadeShadowsPart2Mission/CrewMembers/AshCrewedCaptainGeneratorBlueprint'), 'class-name');
  assert.equal(shopNameLeakSeverity('MPVAviaPrimeArmorSet', '/Lotus/Types/StoreItems/Packages/MegaPrimeVault/MPVAviaPrimeArmorSet'), 'tail');
  // 合法英文保留项与中文占位不判泄漏
  assert.equal(shopNameLeakSeverity('Valkyr', '/Lotus/Types/Recipes/WarframeRecipes/ValkyrBlueprint'), null);
  assert.equal(shopNameLeakSeverity('Titania Prime 单件包', '/Lotus/Types/StoreItems/Packages/MegaPrimeVault/MPVTitaniaPrimeSinglePack'), null);
  assert.equal(shopNameLeakSeverity(SHOP_NAME_PLACEHOLDER_ZH, '/Lotus/StoreItems/Types/Keys/UnknownInternalKey'), null);
});

test('合成未知名装配结果必须落中文占位，扫描零泄漏', () => {
  const names = { zhOf: () => null, catalogZhOf: () => null, catalogTailZhOf: () => null, languageTailZhOf: () => null };
  const synthetic = [
    '/Lotus/StoreItems/Types/Keys/UnknownInternalKey',
    '/Lotus/StoreItems/Types/Items/MiscItems/BrandNewGadgetBlueprint',
    '/Lotus/StoreItems/Types/Recipes/WarframeRecipes/StyanaxSystemsBlueprint',
    '/Lotus/StoreItems/Types/Packages/MegaPrimeVault/MPVBrandNewPrimeSet',
  ].map((storeItem) => ({ storeItem, name: itemZh(storeItem, names) }));
  for (const row of synthetic) assert.equal(row.name, SHOP_NAME_PLACEHOLDER_ZH, `${row.storeItem} 必须占位而非泄漏`);
  assert.deepEqual(scanShopAssemblyLeaks(synthetic), { total: 4, leaks: [], clean: true });
});

test('扫描器能抓出装配结果里的既有泄漏行（负样本）', () => {
  const rows = [
    { storeItem: '/Lotus/Types/StoreItems/JadeShadowsPart2Mission/CrewMembers/AshCrewedCaptainGenerator', name: 'AshCrewedCaptainGenerator' },
    { storeItem: '/Lotus/StoreItems/Types/Keys/UnknownInternalKey', name: SHOP_NAME_PLACEHOLDER_ZH },
  ];
  const result = scanShopAssemblyLeaks(rows);
  assert.equal(result.clean, false);
  assert.equal(result.leaks.length, 1);
  assert.equal(result.leaks[0].severity, 'tail');
  assert.equal(result.leaks[0].index, 0);
});

test('当前 weekly-static.json 用户可见中文表逐值扫描零内部名泄漏', () => {
  const staticData = JSON.parse(readFileSync(new URL('./weekly-static.json', import.meta.url), 'utf8'));
  const tables = [
    'rewardItemZh', 'calendarUpgradeZh', 'calendarUpgradeZhByPath', 'calendarChallengeZh',
    'nightwaveZh', 'incarnonZh', 'calendarEventZh', 'factionZh', 'descZh', 'archimedeaZh',
  ].map((label) => ({ label, entries: Object.entries(staticData[label] || {}) }));
  const result = scanZhTableLeaks(tables);
  assert.ok(result.total > 100, `静态中文表应有可扫描条目（实际 ${result.total}）`);
  assert.deepEqual(result.leaks, []);
});

// —— 4) DE 官方 worldState 结构漂移 ——

test('官方 worldState 关键集合缺失/畸形 → cacheable=false（拒绝写可靠缓存）', () => {
  const complete = {
    Time: Math.floor(Date.now() / 1000),
    ActiveMissions: [], VoidStorms: [], Alerts: [], Invasions: [], Goals: [],
    Sorties: [], LiteSorties: [], VoidTraders: [], Conquests: [], SyndicateMissions: [],
    EndlessXpSchedule: [], KnownCalendarSeasons: [],
  };
  assert.deepEqual(analyzeOfficialRawDrift(complete), {
    cacheable: true, missing: [], malformed: [], reason: null,
  });
  const noMissions = { ...complete };
  delete noMissions.ActiveMissions;
  const drift = analyzeOfficialRawDrift(noMissions);
  assert.equal(drift.cacheable, false);
  assert.deepEqual(drift.missing, ['ActiveMissions']);
  assert.match(drift.reason, /缺失关键集合/u);
  const brokenAlerts = { ...complete, Alerts: { not: 'an array' } };
  const malformed = analyzeOfficialRawDrift(brokenAlerts);
  assert.equal(malformed.cacheable, false);
  assert.deepEqual(malformed.malformed, ['Alerts']);
  const noTime = { ...complete };
  delete noTime.Time;
  assert.equal(analyzeOfficialRawDrift(noTime).cacheable, false);
});

test('规范化世界状态漂移：字段合同 + 科研完整性叠加决定是否可写可靠缓存', () => {
  const now = Date.now();
  const entry = (kind) => ({
    typeKey: kind,
    activation: new Date(now - 86400000).toISOString(),
    expiry: new Date(now + 6 * 86400000).toISOString(),
    missions: Array.from({ length: 3 }, () => ({ missionType: 'Defense' })),
    personalModifiers: [{ key: 'Armorless' }],
  });
  const complete = {
    timestamp: new Date().toISOString(),
    fissures: [], alerts: [], invasions: [], events: [], voidTraders: [], syndicateMissions: [],
    archimedeas: [entry('CT_LAB'), entry('CT_HEX')],
    sortie: null, archonHunt: null, nightwave: null, duviriCycle: null, calendar: null,
  };
  const ok = analyzeOfficialNormalizedDrift(complete);
  assert.equal(ok.contractOk, true);
  assert.equal(ok.weeklyCacheable, true);
  assert.equal(ok.cacheable, true);

  const noCalendar = { ...complete };
  delete noCalendar.calendar;
  const missing = analyzeOfficialNormalizedDrift(noCalendar);
  assert.equal(missing.contractOk, false);
  assert.equal(missing.cacheable, false);
  assert.deepEqual(missing.missing, ['calendar']);

  const partialArchimedeas = { ...complete, archimedeas: [entry('CT_LAB')] };
  const partial = analyzeOfficialNormalizedDrift(partialArchimedeas);
  assert.equal(partial.contractOk, true);
  assert.equal(partial.weeklyCacheable, false);
  assert.equal(partial.cacheable, false, '科研两套不完整时不得写本周可靠缓存');

  const brokenArrays = { ...complete, fissures: 'not-an-array' };
  assert.equal(analyzeOfficialNormalizedDrift(brokenArrays).cacheable, false);
});

// —— 5) 端点健康聚合（白名单脱敏） ——

const seededHealth = {
  'market:catalog': {
    consecutiveFailures: 2, lastCategory: 'rate_limited', lastStatus: 429,
    lastFailureAt: 1_000, lastSuccessAt: 500, openedAt: 1_000, openUntil: 31_000,
    // 累计遥测（http-resilience.mjs 新写入）：真实失败频率
    totalFailures: 5, failureCategoryCounts: { rate_limited: 3, network: 2 },
    failureStatusCounts: { '429': 3, '503': 1 }, circuitOpenCount: 2,
    url: 'https://api.warframe.market/v2/items?token=SECRET',
    headers: { Authorization: 'Bearer SECRET' },
    responseBody: '<html>sensitive</html>',
  },
  'worldstate:primary:pc': {
    consecutiveFailures: 1, lastCategory: 'http_error', lastStatus: 403,
    lastFailureAt: 2_000, lastSuccessAt: null, openedAt: 2_000, openUntil: 902_000,
    totalFailures: 1, failureCategoryCounts: { http_error: 1 },
    failureStatusCounts: { '403': 1 }, circuitOpenCount: 1,
    url: 'https://api.warframe.com/cdn/worldState.php',
  },
  'market:orders': {
    // 旧 v1 schema：无累计计数，仅最近状态覆盖；lastCategory 不得冒充频率
    consecutiveFailures: 1, lastCategory: 'http_error', lastStatus: 500,
    lastFailureAt: 4_000, lastSuccessAt: 3_000, openedAt: null, openUntil: null,
    token: 'SHOULD-NOT-LEAK',
  },
};

test('端点健康脱敏：只保留白名单字段（含累计遥测），聚合区分累计失败次数与旧状态覆盖', () => {
  const sanitized = sanitizeEndpointHealth(seededHealth);
  assert.deepEqual(Object.keys(sanitized['market:catalog']).sort(), [
    'circuitOpenCount', 'consecutiveFailures', 'failureCategoryCounts', 'failureStatusCounts',
    'lastCategory', 'lastFailureAt', 'lastStatus', 'lastSuccessAt', 'openUntil', 'openedAt', 'totalFailures',
  ]);
  // 旧 v1 条目无累计字段，仍可读
  assert.deepEqual(Object.keys(sanitized['market:orders']).sort(), [
    'consecutiveFailures', 'lastCategory', 'lastFailureAt', 'lastStatus',
    'lastSuccessAt', 'openUntil', 'openedAt',
  ]);
  const aggregate = aggregateEndpointHealth(seededHealth, { now: 5_000 });
  assert.equal(aggregate.endpoints, 3);
  assert.equal(aggregate.openCircuits, 2);
  // 频率只来自累计计数：旧端点 lastCategory http_error/500 不并入
  assert.deepEqual(aggregate.byCategory, { rate_limited: 3, network: 2, http_error: 1 });
  assert.deepEqual(aggregate.byStatus, { '429': 3, '503': 1, '403': 1 });
  assert.equal(aggregate.totalFailures, 6);
  assert.equal(aggregate.circuitOpenCount, 3);
  assert.equal(aggregate.legacyStateEndpoints, 1);
  assert.equal(aggregate.lastFailureAt, 4_000);
  assert.equal(aggregate.lastFailureIso, new Date(4_000).toISOString());
  assert.equal(aggregate.lastSuccessAt, 3_000);
  const catalog = aggregate.details.find((d) => d.endpoint === 'market:catalog');
  assert.equal(catalog.circuitOpen, true);
  assert.equal(catalog.backoffMs, 26_000);
  assert.equal(catalog.legacyState, false);
  assert.equal(catalog.totalFailures, 5);
  const orders = aggregate.details.find((d) => d.endpoint === 'market:orders');
  assert.equal(orders.circuitOpen, false);
  assert.equal(orders.backoffMs, 0);
  assert.equal(orders.legacyState, true);
  assert.equal(orders.totalFailures, undefined); // 旧 v1 无累计计数
  // 输出全文不得出现 URL、请求头、令牌、响应体或任何敏感值
  const json = JSON.stringify(aggregate);
  assert.ok(!json.includes('SECRET'));
  assert.ok(!json.includes('Bearer'));
  assert.ok(!json.includes('Authorization'));
  assert.ok(!json.includes('responseBody'));
  assert.ok(!json.includes('https://'));
  assert.ok(!json.includes('sensitive'));
});

test('CLI health：单次只读输出脱敏聚合，source 为固定安全标签且不输出本机路径（子进程，零联网）', async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'wf-drift-health-'));
  const healthFile = path.join(cacheDir, 'endpoint-health.v1.json');
  try {
    const base = Date.now();
    await writeFile(healthFile, JSON.stringify({
      version: 1,
      updatedAt: base,
      endpoints: {
        'market:item': {
          consecutiveFailures: 0, lastSuccessAt: base, lastFailureAt: null,
          lastCategory: null, lastStatus: null, openedAt: null, openUntil: null,
          totalFailures: 2, failureCategoryCounts: { network: 2 }, failureStatusCounts: {}, circuitOpenCount: 1,
          url: 'https://api.warframe.market/v2/item/wukong_prime_set?auth=LEAKME',
          headers: { 'X-Api-Key': 'LEAKME' },
        },
        'worldstate:primary:pc': {
          // 旧 v1 schema：仅最近状态覆盖，无累计计数
          consecutiveFailures: 1, lastFailureAt: base, lastSuccessAt: null,
          lastCategory: 'http_error', lastStatus: 403, openedAt: base, openUntil: base + 900_000,
        },
      },
    }), 'utf8');
    const cliPath = fileURLToPath(new URL('./drift-report.mjs', import.meta.url));
    const { stdout } = await promisify(execFile)(process.execPath, [cliPath, 'health', '--health', healthFile], {
      encoding: 'utf8',
      env: { ...process.env, WARFRAME_DATA_CACHE_DIR: cacheDir },
    });
    const output = JSON.parse(stdout);
    assert.equal(output.ok, true);
    assert.equal(output.command, 'health');
    assert.equal(output.source, HEALTH_SOURCE_LABEL);
    assert.notEqual(HEALTH_SOURCE_LABEL, healthFile);
    assert.equal(output.aggregate.endpoints, 2);
    assert.equal(output.aggregate.openCircuits, 1);
    // 频率只来自累计计数；旧端点 lastCategory http_error 不并入
    assert.deepEqual(output.aggregate.byCategory, { network: 2 });
    assert.equal(output.aggregate.totalFailures, 2);
    assert.equal(output.aggregate.legacyStateEndpoints, 1);
    assert.equal(output.aggregate.lastFailureIso, new Date(base).toISOString());
    const open = output.aggregate.details.find((d) => d.endpoint === 'worldstate:primary:pc');
    assert.equal(open.circuitOpen, true);
    assert.equal(open.legacyState, true);
    // 子进程内 now 比父进程捕获的 base 晚几毫秒，退避余量允许微小损耗
    assert.ok(open.backoffMs > 899_000 && open.backoffMs <= 900_000, `backoffMs=${open.backoffMs}`);
    // 输出不得包含文件里混入的敏感字段，也不得包含本机文件路径
    assert.ok(!stdout.includes('LEAKME'));
    assert.ok(!stdout.includes('X-Api-Key'));
    assert.ok(!stdout.includes('https://'));
    assert.ok(!stdout.includes(healthFile), 'CLI 输出不得包含本机健康文件绝对路径');
    assert.ok(!stdout.includes(cacheDir), 'CLI 输出不得包含本机缓存目录绝对路径');
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});
