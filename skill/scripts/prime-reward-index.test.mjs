// prime-reward-index.test.mjs — Prime 奖励估值索引回归（全部零联网零凭据）。
// 覆盖：构建口径、集合仅含独立单词 Prime 的可交易奖励（排除 Forma/Requiem）、
// 严格校验（schema/时间/未来 generatedAt/过期/负有效期/条目逐项跳过/空结果拒绝）、
// 新鲜缓存零联网复用、过期重建、刷新失败保旧文件、原子替换失败注入（写临时或 rename 任意
// 错误时旧目标路径与字节不变、无 temp/bak 残留）、并发上限、并行性能、原子写入、
// CLI 参数与离线 fresh 子进程。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PRIME_REWARD_INDEX_MAX_CLOCK_SKEW_MS,
  PRIME_REWARD_INDEX_SCHEMA_VERSION,
  buildPrimeRewardIndex,
  createDefaultIndexFileOps,
  generatePrimeRewardIndex,
  isCanonicalPrimeRewardName,
  loadPrimeRewardCatalog,
  normalizeBasis,
  validatePrimeRewardIndex,
  writePrimeRewardIndex,
} from './prime-reward-index.mjs';

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('./prime-reward-index.mjs', import.meta.url));
const NOW = Date.parse('2026-08-01T00:00:00.000Z');

// 子进程助手：不因非零退出码抛错，返回 { code, stdout }
async function runCli(args, env = process.env) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], { env, encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout || '' };
  }
}

const fixtureRelics = [
  {
    name: 'Lith S1 Intact', vaulted: false,
    rewards: [
      { item: { name: 'Synthetic Prime Blueprint', warframeMarket: { urlName: 'synthetic_prime_blueprint' } }, chance: 11 },
      { item: { name: 'Synthetic Prime Systems Blueprint', warframeMarket: { urlName: 'synthetic_prime_systems_blueprint' } }, chance: 2 },
      { item: { name: 'Synthetic Sigil', warframeMarket: { urlName: 'synthetic_sigil' } }, chance: 10 }, // 非 Prime 可交易 → 排除
    ],
  },
  {
    name: 'Meso S2 Intact', vaulted: false,
    rewards: [
      { item: { name: 'Synthetic Prime Blueprint', warframeMarket: { urlName: 'synthetic_prime_blueprint' } }, chance: 11 },
      { item: { name: 'Synthetic Prime Neuroptics Blueprint', warframeMarket: { urlName: 'synthetic_prime_neuroptics_blueprint' } }, chance: 2 },
      { item: { name: 'Forma Blueprint', warframeMarket: { urlName: 'forma_blueprint' } }, chance: 30 }, // Forma → 明确排除
    ],
  },
  {
    name: 'Axi S3 Intact', vaulted: true,
    rewards: [
      { item: { name: 'Synthetic Prime Chassis Blueprint', warframeMarket: { urlName: 'synthetic_prime_chassis_blueprint' } }, chance: 25.33 },
      { item: { name: 'Untradeable Prime Widget' }, chance: 2 }, // 无 slug → 不入集合
      { item: { name: 'Primed Continuity', warframeMarket: { urlName: 'primed_continuity' } }, chance: 2 }, // Primed 非独立 Prime 单词 → 排除
    ],
  },
  {
    name: 'Requiem I Intact', vaulted: false,
    rewards: [
      { item: { name: 'Requiem I', warframeMarket: { urlName: 'requiem_i' } }, chance: 25 }, // 安魂 → 明确排除
    ],
  },
  { name: 'Lith S1 Exceptional', rewards: [] }, // 非 Intact 行 → 不参与
];

const fixtureQuotes = {
  synthetic_prime_blueprint: { platinum: 42.35, basis: 'today', dailyVolume: 3.1 },
  synthetic_prime_systems_blueprint: { platinum: 8, basis: '90days', dailyVolume: 0.4 },
  synthetic_prime_neuroptics_blueprint: { platinum: 0, basis: 'today', dailyVolume: 0 }, // 无价 → 不入
  synthetic_prime_chassis_blueprint: { platinum: 5.55, basis: '90days', dailyVolume: 0 },
  synthetic_sigil: { platinum: 15, basis: 'today', dailyVolume: 1 }, // 非 Prime → 不入
  forma_blueprint: { platinum: 20, basis: 'today', dailyVolume: 5 }, // Forma → 不入
  primed_continuity: { platinum: 60, basis: '90days', dailyVolume: 0.2 }, // Primed → 不入
  requiem_i: { platinum: 30, basis: 'today', dailyVolume: 2 }, // 安魂 → 不入
};

const fixtureCatalog = () => loadPrimeRewardCatalog({ relicsFetcher: async () => fixtureRelics });

const simpleRewards = [{ name: 'A Prime Blueprint', slug: 'a_prime_blueprint', relics: ['Lith S1'] }];
const simpleQuotes = { a_prime_blueprint: { platinum: 5, basis: 'today', dailyVolume: 1 } };
const simpleCatalog = () => Promise.resolve({ rewards: simpleRewards, relicCount: 1 });
const buildSimple = (overrides = {}, now = NOW) => buildPrimeRewardIndex(overrides.catalog || simpleRewards, overrides.quotes || simpleQuotes, { now, ttlHours: 24 });

test('isCanonicalPrimeRewardName：仅独立单词 Prime 且排除 Forma/Requiem', () => {
  assert.equal(isCanonicalPrimeRewardName('Soma Prime Blueprint'), true);
  assert.equal(isCanonicalPrimeRewardName('Prime'), true);
  assert.equal(isCanonicalPrimeRewardName('Excalibur Prime Set'), true);
  assert.equal(isCanonicalPrimeRewardName('Primed Continuity'), false); // 非独立单词
  assert.equal(isCanonicalPrimeRewardName('Forma Blueprint'), false);
  assert.equal(isCanonicalPrimeRewardName('Requiem I'), false);
  assert.equal(isCanonicalPrimeRewardName('Synthetic Sigil'), false);
  assert.equal(isCanonicalPrimeRewardName(''), false);
});

test('normalizeBasis：today/90days 保留，90d/90-day 规范化，其余无效', () => {
  assert.equal(normalizeBasis('today'), 'today');
  assert.equal(normalizeBasis('90days'), '90days');
  assert.equal(normalizeBasis('90d'), '90days');
  assert.equal(normalizeBasis('90-day'), '90days');
  assert.equal(normalizeBasis('TODAY'), 'today');
  assert.equal(normalizeBasis(' 90Days '), '90days');
  assert.equal(normalizeBasis('weekly'), null);
  assert.equal(normalizeBasis(null), null);
  assert.equal(normalizeBasis(''), null);
  assert.equal(normalizeBasis(42), null);
});

test('buildPrimeRewardIndex 只入可靠成交、>0 且基准合规的条目，字段与覆盖统计正确', async () => {
  const catalog = await fixtureCatalog();
  const index = buildPrimeRewardIndex(catalog, fixtureQuotes, { now: NOW, ttlHours: 24 });
  assert.equal(index.schemaVersion, PRIME_REWARD_INDEX_SCHEMA_VERSION);
  assert.equal(index.generatedAt, new Date(NOW).toISOString());
  assert.equal(index.expiresAt, new Date(NOW + 24 * 60 * 60 * 1000).toISOString());
  assert.deepEqual(Object.keys(index.prices).sort(), [
    'Synthetic Prime Blueprint',
    'Synthetic Prime Chassis Blueprint',
    'Synthetic Prime Systems Blueprint',
  ]);
  assert.equal(index.prices['Synthetic Prime Blueprint'].platinum, 42.4); // round1
  assert.equal(index.prices['Synthetic Prime Blueprint'].basis, 'today');
  assert.equal(index.prices['Synthetic Prime Blueprint'].dailyVolume, 3.1);
  assert.equal(index.prices['Synthetic Prime Systems Blueprint'].basis, '90days');
  assert.equal(index.coverage.rewards, 4);
  assert.equal(index.coverage.priced, 3);
  assert.equal(index.coverage.missing, 1);
  assert.equal(index.coverage.relics, 4);
  assert.deepEqual(index.coverage.byBasis, { today: 1, '90days': 2 });

  // 旧别名在构建期即规范化
  const aliased = buildPrimeRewardIndex(catalog, { synthetic_prime_blueprint: { platinum: 9, basis: '90d', dailyVolume: 2 } }, { now: NOW, ttlHours: 24 });
  assert.equal(aliased.prices['Synthetic Prime Blueprint'].basis, '90days');
  assert.deepEqual(aliased.coverage.byBasis, { '90days': 1 });

  // 无效基准（weekly）的条目不产出
  const badBasis = buildPrimeRewardIndex(catalog, { synthetic_prime_blueprint: { platinum: 9, basis: 'weekly', dailyVolume: 2 } }, { now: NOW, ttlHours: 24 });
  assert.equal(badBasis.prices['Synthetic Prime Blueprint'], undefined);
  assert.equal(badBasis.coverage.priced, 0);
  assert.equal(badBasis.coverage.missing, 4);
});

test('loadPrimeRewardCatalog 只取 Intact 行、去重按英文规范名、无 slug 跳过、仅含独立 Prime 且排除 Forma/Requiem', async () => {
  const catalog = await fixtureCatalog();
  assert.equal(catalog.relicCount, 4);
  const names = catalog.rewards.map((entry) => entry.name);
  assert.deepEqual(names, [
    'Synthetic Prime Blueprint',
    'Synthetic Prime Systems Blueprint',
    'Synthetic Prime Neuroptics Blueprint',
    'Synthetic Prime Chassis Blueprint',
  ]);
  assert.equal(catalog.rewards.find((entry) => entry.name === 'Synthetic Prime Blueprint').relics.length, 2);
  await assert.rejects(
    loadPrimeRewardCatalog({ relicsFetcher: async () => [] }),
    /遗物奖励表中没有含独立单词 Prime 的可交易奖励/u,
  );
  // 只有非 Prime 奖励的表同样拒绝
  await assert.rejects(
    loadPrimeRewardCatalog({ relicsFetcher: async () => [{
      name: 'Lith S1 Intact',
      rewards: [{ item: { name: 'Forma Blueprint', warframeMarket: { urlName: 'forma_blueprint' } } }],
    }] }),
    /遗物奖励表中没有含独立单词 Prime 的可交易奖励/u,
  );
});

test('validatePrimeRewardIndex 文件级拒绝：缺失/schema/时间/未来/过期/负有效期/无 prices/空结果', () => {
  const good = buildPrimeRewardIndex({ rewards: simpleRewards, relicCount: 1 }, simpleQuotes, { now: NOW, ttlHours: 24 });
  assert.deepEqual(validatePrimeRewardIndex(good, { now: NOW }), { ok: true, error: null, skipped: 0 });
  assert.equal(validatePrimeRewardIndex(null, { now: NOW }).error, 'missing');
  assert.equal(validatePrimeRewardIndex({ ...good, schemaVersion: 2 }, { now: NOW }).error, 'schema');
  assert.equal(validatePrimeRewardIndex({ ...good, generatedAt: 'not-a-date' }, { now: NOW }).error, 'time');
  assert.equal(validatePrimeRewardIndex({ ...good, expiresAt: 'not-a-date' }, { now: NOW }).error, 'time');
  assert.equal(validatePrimeRewardIndex({ ...good, expiresAt: new Date(NOW + 60_000).toISOString() }, { now: NOW + 120_000 }).error, 'expired');
  assert.equal(validatePrimeRewardIndex({ ...good, expiresAt: good.generatedAt }, { now: NOW }).error, 'time');
  assert.equal(validatePrimeRewardIndex({ ...good, prices: null }, { now: NOW }).error, 'prices');

  // generatedAt 未来：>5 分钟拒绝，≤5 分钟时钟偏差放行
  const future = new Date(NOW + PRIME_REWARD_INDEX_MAX_CLOCK_SKEW_MS + 60_000).toISOString();
  assert.equal(validatePrimeRewardIndex({ ...good, generatedAt: future, expiresAt: new Date(NOW + 3 * 24 * 60 * 60 * 1000).toISOString() }, { now: NOW }).error, 'future');
  const withinSkew = new Date(NOW + PRIME_REWARD_INDEX_MAX_CLOCK_SKEW_MS - 60_000).toISOString();
  assert.equal(validatePrimeRewardIndex({ ...good, generatedAt: withinSkew, expiresAt: new Date(NOW + 3 * 24 * 60 * 60 * 1000).toISOString() }, { now: NOW }).ok, true);

  // 全部条目无效 → 空结果整体拒绝
  assert.equal(validatePrimeRewardIndex({ ...good, prices: { 'A Prime Blueprint': { platinum: 0, basis: 'today', dailyVolume: 1 } } }, { now: NOW }).error, 'empty');
  assert.equal(validatePrimeRewardIndex({ ...good, prices: {} }, { now: NOW }).error, 'empty');
});

test('validatePrimeRewardIndex 条目级逐项跳过：非法 basis/NaN/Infinity/负成交量/坏类型不影响其余条目', () => {
  const good = buildPrimeRewardIndex({ rewards: simpleRewards, relicCount: 1 }, simpleQuotes, { now: NOW, ttlHours: 24 });
  const bad = {
    ...good,
    prices: {
      'A Prime Blueprint': { platinum: 5, basis: 'today', dailyVolume: 1 },
      'Bad Basis': { platinum: 5, basis: 'weekly', dailyVolume: 1 },
      'Null Basis': { platinum: 5, basis: null, dailyVolume: 1 },
      'NaN Volume': { platinum: 5, basis: 'today', dailyVolume: 'NaN' },
      'Infinity Volume': { platinum: 5, basis: 'today', dailyVolume: Infinity },
      'Negative Volume': { platinum: 5, basis: 'today', dailyVolume: -1 },
      'Zero Platinum': { platinum: 0, basis: 'today', dailyVolume: 1 },
      'NaN Platinum': { platinum: 'NaN', basis: 'today', dailyVolume: 1 },
      'Non-Object': 'nope',
      '': { platinum: 5, basis: 'today', dailyVolume: 1 },
    },
  };
  const check = validatePrimeRewardIndex(bad, { now: NOW });
  assert.deepEqual(check, { ok: true, error: null, skipped: 9 });
  // 旧别名逐项放行
  const aliased = {
    ...good,
    prices: {
      '90d Alias': { platinum: 5, basis: '90d', dailyVolume: 1 },
      '90-day Alias': { platinum: 5, basis: '90-day', dailyVolume: 1 },
    },
  };
  assert.deepEqual(validatePrimeRewardIndex(aliased, { now: NOW }), { ok: true, error: null, skipped: 0 });
  // 只留坏条目 → empty
  assert.equal(validatePrimeRewardIndex({ ...good, prices: { 'Bad Basis': { platinum: 5, basis: 'weekly', dailyVolume: 1 } } }, { now: NOW }).error, 'empty');
});

test('新鲜缓存零联网复用：任何 fetcher 被调用即测试失败', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'prime-reward-index-'));
  try {
    const outputPath = path.join(dir, 'prime_reward_prices.json');
    const fresh = buildPrimeRewardIndex({ rewards: simpleRewards, relicCount: 1 }, simpleQuotes, { now: NOW, ttlHours: 24 });
    await writeFile(outputPath, JSON.stringify(fresh), 'utf8');
    let fetchCalls = 0;
    const result = await generatePrimeRewardIndex({
      outputPath, now: NOW, ttlHours: 24, concurrency: 4, force: false,
      relicsFetcher: async () => { fetchCalls += 1; throw new Error('network must not be touched'); },
      priceTableFetcher: async () => { fetchCalls += 1; throw new Error('network must not be touched'); },
      priceFetcher: async () => { fetchCalls += 1; throw new Error('network must not be touched'); },
    });
    assert.equal(fetchCalls, 0);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'fresh');
    assert.equal(result.outputPath, outputPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('generatedAt 未来的索引不复用（fresh 零联网复用被拒绝）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'prime-reward-index-'));
  try {
    const outputPath = path.join(dir, 'prime_reward_prices.json');
    const future = buildPrimeRewardIndex({ rewards: simpleRewards, relicCount: 1 }, simpleQuotes, { now: NOW + 2 * 24 * 60 * 60 * 1000, ttlHours: 24 });
    await writeFile(outputPath, JSON.stringify(future), 'utf8');
    let fetchCalls = 0;
    const result = await generatePrimeRewardIndex({
      outputPath, now: NOW, ttlHours: 24, concurrency: 2, force: false,
      relicsFetcher: async () => { fetchCalls += 1; return fixtureRelics; },
      priceTableFetcher: async () => ({}),
      priceFetcher: async () => { fetchCalls += 1; return { platinum: 5, basis: 'today', dailyVolume: 1 }; },
    });
    assert.ok(fetchCalls > 0, 'future index must not be reused fresh');
    assert.equal(result.status, 'rebuilt');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('过期/损坏文件不复用：重建成功且无 .tmp 残留', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'prime-reward-index-'));
  try {
    const outputPath = path.join(dir, 'prime_reward_prices.json');
    const stale = buildPrimeRewardIndex({ rewards: simpleRewards, relicCount: 1 }, simpleQuotes, { now: NOW - 48 * 60 * 60 * 1000, ttlHours: 24 });
    await writeFile(outputPath, JSON.stringify(stale), 'utf8');
    const catalog = await fixtureCatalog();
    const result = await generatePrimeRewardIndex({
      outputPath, now: NOW, ttlHours: 24, concurrency: 4,
      relicsFetcher: async () => fixtureRelics,
      priceTableFetcher: async () => Object.fromEntries(catalog.rewards.map((entry) => [entry.slug, { isMod: false }])),
      priceFetcher: async (slug) => fixtureQuotes[slug] || null,
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'rebuilt');
    const written = JSON.parse(await readFile(outputPath, 'utf8'));
    assert.equal(written.schemaVersion, 1);
    assert.equal(written.coverage.priced, 3);
    const leftovers = await readdir(dir);
    assert.ok(!leftovers.some((name) => name.endsWith('.tmp') || name.endsWith('.bak')));

    // 损坏文件同样触发重建
    await writeFile(outputPath, '{ not json !!!', 'utf8');
    const rebuilt = await generatePrimeRewardIndex({
      outputPath, now: NOW, ttlHours: 24, concurrency: 4,
      relicsFetcher: async () => fixtureRelics,
      priceTableFetcher: async () => Object.fromEntries(catalog.rewards.map((entry) => [entry.slug, { isMod: false }])),
      priceFetcher: async (slug) => fixtureQuotes[slug] || null,
    });
    assert.equal(rebuilt.ok, true);
    assert.equal(rebuilt.status, 'rebuilt');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('刷新失败绝不覆盖上一份文件，且诚实上报 refresh_failed/failed', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'prime-reward-index-'));
  try {
    const outputPath = path.join(dir, 'prime_reward_prices.json');
    const previous = buildPrimeRewardIndex({ rewards: simpleRewards, relicCount: 1 }, simpleQuotes, { now: NOW - 48 * 60 * 60 * 1000, ttlHours: 24 });
    const previousBytes = JSON.stringify(previous);
    await writeFile(outputPath, previousBytes, 'utf8');

    const failed = await generatePrimeRewardIndex({
      outputPath, now: NOW, ttlHours: 24, concurrency: 2,
      relicsFetcher: async () => fixtureRelics,
      priceTableFetcher: async () => { throw new Error('dukats endpoint down'); },
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.status, 'refresh_failed');
    assert.match(failed.error, /dukats endpoint down/u);
    assert.equal(failed.preserved, true);
    assert.equal(await readFile(outputPath, 'utf8'), previousBytes); // 逐字节未动

    // 无上一份文件时：failed（无可保留）
    const freshDir = await mkdtemp(path.join(os.tmpdir(), 'prime-reward-index-'));
    try {
      const noPrevious = await generatePrimeRewardIndex({
        outputPath: path.join(freshDir, 'prime_reward_prices.json'), now: NOW, ttlHours: 24, concurrency: 2,
        relicsFetcher: async () => { throw new Error('relic source down'); },
      });
      assert.equal(noPrevious.ok, false);
      assert.equal(noPrevious.status, 'failed');
      assert.equal(noPrevious.preserved, false);
    } finally {
      await rm(freshDir, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('原子替换失败注入：写临时失败或 rename 任意错误，旧目标路径与字节不变、无 temp/bak 残留', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'prime-reward-index-'));
  try {
    const outputPath = path.join(dir, 'prime_reward_prices.json');
    const index = buildPrimeRewardIndex({ rewards: simpleRewards, relicCount: 1 }, simpleQuotes, { now: NOW, ttlHours: 24 });
    const previousBytes = JSON.stringify(buildPrimeRewardIndex({ rewards: simpleRewards, relicCount: 1 }, simpleQuotes, { now: NOW - 48 * 60 * 60 * 1000, ttlHours: 24 }));
    await writeFile(outputPath, previousBytes, 'utf8');
    const defaultOps = createDefaultIndexFileOps();
    const eperm = (code) => Object.assign(new Error(`injected ${code}`), { code });
    const leftovers = async () => (await readdir(dir)).filter((name) => name.endsWith('.tmp') || name.endsWith('.bak'));

    // 1) 写临时文件失败：旧目标不动，无残留
    const opsWriteFail = {
      ...defaultOps,
      writeFile: async () => { throw eperm('ENOSPC'); },
    };
    await assert.rejects(writePrimeRewardIndex(outputPath, index, { fileOps: opsWriteFail }), /ENOSPC/u);
    assert.equal(await readFile(outputPath, 'utf8'), previousBytes);
    assert.deepEqual(await leftovers(), []);

    // 2) rename 任意错误（EEXIST/EPERM/EACCES/其他）：只尝试这一次，绝不备份/回滚现有 output；
    //    旧目标路径存在且字节不变，无 temp/bak 残留
    for (const code of ['EEXIST', 'EPERM', 'EACCES', 'EBUSY']) {
      let renameAttempts = 0;
      const opsRenameFail = {
        ...defaultOps,
        rename: async () => {
          renameAttempts += 1;
          throw eperm(code);
        },
      };
      await assert.rejects(writePrimeRewardIndex(outputPath, index, { fileOps: opsRenameFail }), new RegExp(code, 'u'));
      assert.equal(renameAttempts, 1, `${code}: rename 必须只尝试一次`);
      assert.equal(await readFile(outputPath, 'utf8'), previousBytes); // 旧目标路径存在且字节不变
      assert.deepEqual(await leftovers(), []);
    }
    // 非文件系统类错误同样：旧目标不变、无残留
    const opsGenericFail = {
      ...defaultOps,
      rename: async () => { throw new Error('rename unsupported on this platform'); },
    };
    await assert.rejects(writePrimeRewardIndex(outputPath, index, { fileOps: opsGenericFail }), /unsupported/u);
    assert.equal(await readFile(outputPath, 'utf8'), previousBytes);
    assert.deepEqual(await leftovers(), []);

    // 3) 成功路径：仅一次 rename 替换，新内容完整，无残留
    let renameCalls = 0;
    const opsOk = {
      ...defaultOps,
      rename: async (from, to) => {
        renameCalls += 1;
        return defaultOps.rename(from, to);
      },
    };
    const ok = await writePrimeRewardIndex(outputPath, index, { fileOps: opsOk });
    assert.equal(ok.ok, true);
    assert.equal(renameCalls, 1);
    const written = JSON.parse(await readFile(outputPath, 'utf8'));
    assert.equal(written.schemaVersion, PRIME_REWARD_INDEX_SCHEMA_VERSION);
    assert.deepEqual(written.prices, index.prices); // 新内容完整
    assert.deepEqual(await leftovers(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('E2E：rename 失败 → refresh_failed 且旧索引路径与字节保留、无临时/备份残留', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'prime-reward-index-'));
  try {
    const outputPath = path.join(dir, 'prime_reward_prices.json');
    const previous = buildPrimeRewardIndex({ rewards: simpleRewards, relicCount: 1 }, simpleQuotes, { now: NOW - 48 * 60 * 60 * 1000, ttlHours: 24 });
    const previousBytes = JSON.stringify(previous);
    await writeFile(outputPath, previousBytes, 'utf8');
    const catalog = await fixtureCatalog();
    const defaultOps = createDefaultIndexFileOps();
    let renameCalls = 0;
    const ops = {
      ...defaultOps,
      rename: async () => {
        renameCalls += 1;
        throw Object.assign(new Error('locked by another process'), { code: 'EPERM' });
      },
    };
    const result = await generatePrimeRewardIndex({
      outputPath, now: NOW, ttlHours: 24, concurrency: 2, fileOps: ops,
      relicsFetcher: async () => fixtureRelics,
      priceTableFetcher: async () => Object.fromEntries(catalog.rewards.map((entry) => [entry.slug, { isMod: false }])),
      priceFetcher: async (slug) => fixtureQuotes[slug] || null,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'refresh_failed');
    assert.match(result.error, /locked by another process/u);
    assert.equal(result.preserved, true);
    assert.equal(renameCalls, 1); // 只尝试一次原子替换，绝不备份/回滚现有 output
    assert.equal(await readFile(outputPath, 'utf8'), previousBytes); // 旧目标路径存在且字节不变
    const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp') || name.endsWith('.bak'));
    assert.deepEqual(leftovers, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('受控并发：在飞请求数不超过 concurrency，且总请求数正确', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'prime-reward-index-'));
  try {
    const catalog = await fixtureCatalog();
    const slugs = catalog.rewards.map((entry) => entry.slug);
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const priceFetcher = async (slug) => {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return fixtureQuotes[slug] || null;
    };
    const result = await generatePrimeRewardIndex({
      outputPath: path.join(dir, 'prime_reward_prices.json'), now: NOW, ttlHours: 24, concurrency: 3,
      relicsFetcher: async () => fixtureRelics,
      priceTableFetcher: async () => Object.fromEntries(slugs.map((slug) => [slug, { isMod: false }])),
      priceFetcher,
    });
    assert.equal(result.ok, true);
    assert.equal(calls, slugs.length);
    assert.ok(maxInFlight <= 3, `maxInFlight=${maxInFlight} 超过 3`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('性能粗测：并发 4 抓 24 件应明显快于串行 24×25ms', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'prime-reward-index-'));
  try {
    const performanceRelics = Array.from({ length: 24 }, (_, index) => ({
      name: `Lith P${index} Intact`,
      rewards: [{ item: { name: `Fake Prime Part ${index} Blueprint`, warframeMarket: { urlName: `fake_prime_part_${index}_blueprint` } }, chance: 5 }],
    }));
    const priceFetcher = async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { platinum: 10, basis: '90days', dailyVolume: 1 };
    };
    const started = Date.now();
    const result = await generatePrimeRewardIndex({
      outputPath: path.join(dir, 'prime_reward_prices.json'), now: NOW, ttlHours: 24, concurrency: 4,
      relicsFetcher: async () => performanceRelics,
      priceTableFetcher: async () => ({}),
      priceFetcher,
    });
    const elapsed = Date.now() - started;
    assert.equal(result.ok, true);
    assert.equal(result.coverage.priced, 24);
    const serialMs = 24 * 25;
    assert.ok(elapsed < serialMs * 0.75, `elapsed=${elapsed}ms 未明显快于串行 ${serialMs}ms`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('原子写入：可重复覆盖、内容完整、无临时文件残留', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'prime-reward-index-'));
  try {
    const outputPath = path.join(dir, 'prime_reward_prices.json');
    const first = buildPrimeRewardIndex({ rewards: simpleRewards, relicCount: 1 }, simpleQuotes, { now: NOW, ttlHours: 24 });
    await writePrimeRewardIndex(outputPath, first);
    const second = buildPrimeRewardIndex({ rewards: simpleRewards, relicCount: 1 }, { a_prime_blueprint: { platinum: 9, basis: '90days', dailyVolume: 2 } }, { now: NOW + 60_000, ttlHours: 24 });
    await writePrimeRewardIndex(outputPath, second);
    const parsed = JSON.parse(await readFile(outputPath, 'utf8'));
    assert.equal(parsed.prices['A Prime Blueprint'].platinum, 9);
    const names = await readdir(dir);
    assert.ok(!names.some((name) => name.endsWith('.tmp') || name.endsWith('.bak')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// —— CLI 子进程（零联网：--help/参数错误不触网；fresh 复用离线完成） ——
test('CLI：--help 与参数错误退出码正确', async () => {
  const help = await runCli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--output/u);
  assert.match(help.stdout, /--ttl-hours/u);
  assert.equal((await runCli(['--wat'])).code, 2);
  assert.equal((await runCli(['--ttl-hours', 'abc'])).code, 2);
  assert.equal((await runCli(['--concurrency', '99'])).code, 2);
  assert.equal((await runCli(['--limit', '-1'])).code, 2);
});

test('CLI：预置新鲜索引时零联网复用（子进程、APPDATA 隔离）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'prime-reward-index-'));
  try {
    const outputPath = path.join(dir, 'prime_reward_prices.json');
    const fresh = buildPrimeRewardIndex({ rewards: simpleRewards, relicCount: 1 }, simpleQuotes, { now: Date.now() - 60_000, ttlHours: 24 });
    await writeFile(outputPath, JSON.stringify(fresh), 'utf8');
    const env = {
      ...process.env,
      APPDATA: path.join(dir, 'empty-appdata'),
      WARFRAME_DATA_CACHE_DIR: path.join(dir, 'empty-cache'),
      WARFRAME_OFFLINE: '1',
    };
    const result = await runCli(['--output', outputPath], env);
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.status, 'fresh');
    assert.equal(parsed.outputPath, outputPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI：无 --output 且无 APPDATA 时诚实失败而非写错位置', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'prime-reward-index-'));
  try {
    const env = { ...process.env, APPDATA: '', WARFRAME_DATA_CACHE_DIR: path.join(dir, 'empty-cache'), WARFRAME_OFFLINE: '1' };
    const result = await runCli([], env);
    assert.equal(result.code, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.status, 'failed');
    assert.equal(parsed.error, 'no_output');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 确保本测试文件自身不使用网络（模块级 fixture 覆盖所有分支）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // 本文件不作为 CLI 运行
}
