#!/usr/bin/env node

// prime-reward-index.mjs — WFInfo 全 Prime 奖励可靠估值索引生成器（独立、可重复、离线可测）。
//
// 用途：把「全量遗物奖励表中的全 Prime 可交易奖励 × 现有可靠成交统计」预热成 WFInfo
//   同目录标准索引 %APPDATA%\WFInfo\prime_reward_prices.json（schemaVersion=1），供奸商
//   目标模式在策略缺价时按英文规范名补缺估值（策略内价格始终优先，见 WFInfo 侧合同）。
//
// 数据链（全部复用现有正式链路，零手写清单）：
//   1) 奖励集合 = 现有正式遗物奖励表 Relics.json（AlecaFrame cachedData 只读，
//      本地缺失走 AlecaFrame CDN 兑底，同 recommend.mjs loadLocalRelicDb）——
//      全量遗物（含安魂）Intact 行的奖励并集，键 = 遗物表英文规范名
//      （与 ducat_strategy.json prices 键同源，即 WFInfo OCR 规范名）。
//      集合只保留「可交易（有 warframe.market urlName）且英文规范名含独立单词 Prime」
//      的奖励（如 Soma Prime Blueprint），明确排除 Forma/Requiem 等非 Prime 可交易奖励；
//      其余奖励不入集合，由 coverage 诚实披露。
//   2) 目录/杜卡德整表 = recommend.mjs loadPriceTable（/v2/items + /v1/tools/ducats，
//      1h 缓存），取 slug → isMod（Prime MOD 用 rank 0 口径，防满级价虚高）。
//   3) 单价 = trader-shopping.mjs fetchTradeStatistics（今日/90 日可靠成交中位 + 日均量，
//      与杜卡德规划/策略同步同一统计口径；1h 缓存）。
//   只入「存在可靠成交统计、platinum > 0 且 basis 为今日/90 日口径」的条目；
//   其余条目不入 prices，由 coverage 诚实披露。
//
// 可靠性合同：
//   - 新鲜缓存零联网复用：输出文件存在、schema/时间/字段严格校验通过且未过期时直接复用，
//     不做任何网络请求；--force 强制重建。generatedAt 明显晚于当前时间（>5 分钟）拒绝复用。
//   - 条目级校验与 WFInfo C# 消费侧同语义：platinum 有限正数；basis 仅 today/90days
//     （兼容旧别名 90d/90-day）；dailyVolume 若存在必须有限且 >=0。无效条目逐项跳过，
//     全部无效（空结果）则文件级拒绝。
//   - 过期/损坏：不复用，走重建；重建失败绝不覆盖上一份文件（同目录临时文件完整写入后
//     只执行一次操作系统原子 rename 替换；目标替换失败即放弃，旧文件路径与字节原样保留）。
//   - 诚实结果：CLI 输出 JSON 状态（fresh/rebuilt/refresh_failed/failed），失败退出码 1，
//     参数错误退出码 2；过期索引留在盘上但 WFInfo 侧严格校验会拒绝使用（安全停判）。
//
// CLI：
//   node prime-reward-index.mjs [--output <path>] [--ttl-hours <n>] [--concurrency <n>]
//                                [--limit <n>] [--force] [--aleca-dir <path>] [--help]
//   --output       输出路径（默认 %APPDATA%\WFInfo\prime_reward_prices.json；smoke 必须给临时目录）
//   --ttl-hours    有效期小时数（默认 24，必须 >0）
//   --concurrency  并发抓价上限（默认 4，1..16）
//   --limit        最多定价的奖励条目数（默认 0=不限制；smoke 建议 3）
//   --force        忽略新鲜缓存强制重建
//   --aleca-dir    AlecaFrame 数据目录（默认环境变量 ALECAFRAME_DATA_DIR / 本机默认位置）

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PRIME_REWARD_INDEX_SCHEMA_VERSION = 1;
export const PRIME_REWARD_INDEX_FILENAME = 'prime_reward_prices.json';
export const PRIME_REWARD_INDEX_DEFAULT_TTL_HOURS = 24;
export const PRIME_REWARD_INDEX_DEFAULT_CONCURRENCY = 4;
export const PRIME_REWARD_INDEX_MAX_CONCURRENCY = 16;
// generatedAt 允许的最大时钟偏差：未来 5 分钟内视为正常（与 WFInfo C# 侧一致）。
export const PRIME_REWARD_INDEX_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export function defaultIndexPath() {
  return process.env.APPDATA ? path.join(process.env.APPDATA, 'WFInfo', PRIME_REWARD_INDEX_FILENAME) : null;
}

const round1 = (value) => Math.round(Number(value) * 10) / 10;

// —— 集合口径：英文规范名必须含独立单词 Prime（Primed… 等不含独立 Prime 不算）；
//    明确排除 Forma/Requiem 等非 Prime 可交易遗物奖励。 ——
export function isCanonicalPrimeRewardName(name) {
  const text = String(name || '');
  return /\bPrime\b/u.test(text) && !/\b(?:Forma|Requiem)\b/u.test(text);
}

// —— basis 口径（与 WFInfo C# 消费侧一致）：today/90days 为标准值；
//    旧别名 90d/90-day 兼容读取并规范化为 90days；其余一律视为无效。 ——
const CANONICAL_BASIS = new Set(['today', '90days']);
const LEGACY_BASIS_ALIASES = new Map([['90d', '90days'], ['90-day', '90days']]);

export function normalizeBasis(basis) {
  if (typeof basis !== 'string') return null;
  const key = basis.trim().toLowerCase();
  if (CANONICAL_BASIS.has(key)) return key;
  if (LEGACY_BASIS_ALIASES.has(key)) return LEGACY_BASIS_ALIASES.get(key);
  return null;
}

// —— 条目级有效性（与 WFInfo C# PrimeRewardPriceIndex.IsValidPrice 同语义） ——
export function isValidPriceEntry(name, price) {
  if (!name || !price || typeof price !== 'object' || Array.isArray(price)) return false;
  const platinum = Number(price.platinum);
  if (!Number.isFinite(platinum) || platinum <= 0) return false;
  if (!normalizeBasis(price.basis)) return false;
  if (price.dailyVolume != null) {
    const volume = Number(price.dailyVolume);
    if (!Number.isFinite(volume) || volume < 0) return false;
  }
  return true;
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

// —— 集合：现有正式遗物奖励表（Relics.json Intact 行）→ 唯一奖励 [{name, slug, relics}] ——
// 只保留「可交易（有 warframe.market urlName）且英文规范名含独立单词 Prime」的奖励，
// 明确排除 Forma/Requiem 等；其余奖励不入集合。
export async function loadPrimeRewardCatalog({ alecaDir = null, relicsFetcher = null } = {}) {
  let relicsRaw;
  if (relicsFetcher) {
    relicsRaw = await relicsFetcher();
  } else {
    const { readAlecaJson } = await import('./wfdata.mjs');
    relicsRaw = await readAlecaJson('json/Relics.json', { alecaDir });
  }
  if (!Array.isArray(relicsRaw)) throw new Error('遗物奖励表不可用（本地与在线源均读不到）');
  const byName = new Map();
  const relicBases = new Set();
  for (const relic of relicsRaw) {
    // 只取 Intact 版本（概率基准；其余精炼度奖励同源），与 recommend.mjs loadLocalRelicDb 同口径
    const match = String(relic.name || '').match(/^(.+)\s+Intact$/u);
    if (!match || !Array.isArray(relic.rewards)) continue;
    relicBases.add(match[1]);
    for (const reward of relic.rewards) {
      const name = String(reward?.item?.name || '').trim();
      const slug = reward?.item?.warframeMarket?.urlName || null;
      if (!name || !slug) continue;
      if (!isCanonicalPrimeRewardName(name)) continue; // 仅 Prime 可交易奖励（排除 Forma/Requiem 等）
      const entry = byName.get(name) || { name, slug, relics: [] };
      if (!entry.relics.includes(match[1])) entry.relics.push(match[1]);
      byName.set(name, entry);
    }
  }
  const rewards = [...byName.values()];
  if (!rewards.length) throw new Error('遗物奖励表中没有含独立单词 Prime 的可交易奖励');
  return { rewards, relicCount: relicBases.size };
}

// —— 纯构建（无网络、无 IO）：catalog = loadPrimeRewardCatalog 输出；quotes = slug → 成交统计 ——
export function buildPrimeRewardIndex(catalog, quotes, { now = Date.now(), ttlHours = PRIME_REWARD_INDEX_DEFAULT_TTL_HOURS } = {}) {
  const generatedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + ttlHours * 60 * 60 * 1000).toISOString();
  const prices = {};
  const byBasis = {};
  for (const entry of catalog.rewards || []) {
    const quote = quotes?.[entry.slug];
    if (!quote || !(Number(quote.platinum) > 0)) continue;
    // basis 仅接受 today/90days（旧别名 90d/90-day 规范化）；无效则不产出
    // （与 WFInfo C# 消费侧同口径，避免产出必然被消费端跳过的条目）。
    const basis = normalizeBasis(quote.basis);
    if (!basis) continue;
    const volume = Number(quote.dailyVolume);
    const dailyVolume = Number.isFinite(volume) && volume >= 0 ? round1(volume) : null;
    byBasis[basis] = (byBasis[basis] || 0) + 1;
    prices[entry.name] = {
      platinum: round1(quote.platinum),
      basis,
      dailyVolume,
    };
  }
  const total = (catalog.rewards || []).length;
  const priced = Object.keys(prices).length;
  return {
    schemaVersion: PRIME_REWARD_INDEX_SCHEMA_VERSION,
    generatedAt,
    expiresAt,
    coverage: {
      rewards: total,
      priced,
      missing: total - priced,
      relics: catalog.relicCount || null,
      byBasis,
    },
    prices,
  };
}

// —— 严格校验（与 WFInfo C# 侧同语义）：文件级错误整体拒绝（missing/schema/time/future/expired/prices）；
//    条目级无效（platinum/basis/dailyVolume 不合规）逐项跳过，全部无效（空结果）整体拒绝（empty）。 ——
export function validatePrimeRewardIndex(index, { now = Date.now() } = {}) {
  if (!index || typeof index !== 'object' || Array.isArray(index)) return { ok: false, error: 'missing' };
  if (Number(index.schemaVersion) !== PRIME_REWARD_INDEX_SCHEMA_VERSION) return { ok: false, error: 'schema' };
  const generatedMs = Date.parse(index.generatedAt || '');
  const expiresMs = Date.parse(index.expiresAt || '');
  if (!Number.isFinite(generatedMs) || !Number.isFinite(expiresMs)) return { ok: false, error: 'time' };
  if (expiresMs <= generatedMs) return { ok: false, error: 'time' }; // 退化/负有效期：结构性错误
  if (generatedMs > now + PRIME_REWARD_INDEX_MAX_CLOCK_SKEW_MS) return { ok: false, error: 'future' };
  if (expiresMs <= now) return { ok: false, error: 'expired' };
  if (!index.prices || typeof index.prices !== 'object' || Array.isArray(index.prices)) return { ok: false, error: 'prices' };
  let valid = 0;
  let skipped = 0;
  for (const [name, price] of Object.entries(index.prices)) {
    if (isValidPriceEntry(name, price)) valid += 1;
    else skipped += 1;
  }
  if (valid === 0) return { ok: false, error: 'empty', skipped };
  return { ok: true, error: null, skipped };
}

// —— 可注入文件操作（失败注入测试用）；默认即 node:fs/promises 原函数 ——
export function createDefaultIndexFileOps() {
  return { mkdir, readFile, rename, rm, writeFile };
}

// —— 原子落盘：同目录临时文件完整写入后，只执行一次操作系统原子 rename(temp, output)。
//    目标替换在当前平台失败（EEXIST/EPERM/EACCES 或任何错误）时立即失败并清理临时文件，
//    绝不 rename/remove/move 现有 output——现有 output 的路径与字节必须保持不变。
//    不能原子更新时宁可让上层报 refresh_failed，也不做备份/回滚。fileOps 可注入以便失败注入测试。
export async function writePrimeRewardIndex(outputPath, index, { fileOps = null } = {}) {
  const ops = fileOps || createDefaultIndexFileOps();
  const dir = path.dirname(outputPath);
  const stamp = `${process.pid}.${Date.now()}`;
  const temporaryPath = `${outputPath}.${stamp}.tmp`;
  try {
    await ops.mkdir(dir, { recursive: true });
    await ops.writeFile(temporaryPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
    await ops.rename(temporaryPath, outputPath); // 唯一一次替换：失败即放弃，现有 output 不动
  } catch (error) {
    await ops.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  return { ok: true, outputPath };
}

// —— 编排：新鲜复用 → 集合 → 并发抓价 → 构建 → 校验 → 原子写入；失败保旧、诚实上报 ——
export async function generatePrimeRewardIndex(options = {}) {
  const {
    outputPath = defaultIndexPath(),
    ttlHours = PRIME_REWARD_INDEX_DEFAULT_TTL_HOURS,
    concurrency = PRIME_REWARD_INDEX_DEFAULT_CONCURRENCY,
    limit = 0,
    force = false,
    now = Date.now(),
    alecaDir = null,
    relicsFetcher = null,
    priceTableFetcher = null,
    priceFetcher = null,
    fileOps = null,
    logger = null,
  } = options;
  const ops = fileOps || createDefaultIndexFileOps();
  const log = (message) => logger?.info ? logger.info(message) : null;

  if (!outputPath) return { ok: false, status: 'failed', error: 'no_output', outputPath: null, preserved: false };
  const limited = Math.max(0, Number(limit) || 0);
  const workers = Math.max(1, Math.min(Number(concurrency) || PRIME_REWARD_INDEX_DEFAULT_CONCURRENCY, PRIME_REWARD_INDEX_MAX_CONCURRENCY));

  // 1) 新鲜缓存零联网复用（--force 之外，命中即不发起任何请求）
  if (!force) {
    try {
      const existing = JSON.parse(await ops.readFile(outputPath, 'utf8'));
      const check = validatePrimeRewardIndex(existing, { now });
      if (check.ok) {
        log(`fresh index reused: ${outputPath}`);
        return {
          ok: true,
          status: 'fresh',
          outputPath,
          generatedAt: existing.generatedAt,
          expiresAt: existing.expiresAt,
          coverage: existing.coverage || null,
        };
      }
      log(`existing index not reusable (${check.error}), rebuilding`);
    } catch { /* 无文件或损坏 → 重建 */ }
  }

  let previousContent = null;
  try { previousContent = await ops.readFile(outputPath, 'utf8'); } catch { /* 首次生成 */ }

  try {
    // 2) 集合（现有正式遗物奖励表）
    const catalog = await loadPrimeRewardCatalog({ alecaDir, relicsFetcher });
    let rewards = catalog.rewards;
    if (limited > 0 && rewards.length > limited) rewards = rewards.slice(0, limited);

    // 3) 目录（slug → isMod，Prime MOD 用 rank 0 成交口径）——与策略同步同一链路
    let slugMeta;
    if (priceTableFetcher) {
      slugMeta = await priceTableFetcher();
    } else {
      const { loadPriceTable } = await import('./recommend.mjs');
      slugMeta = await loadPriceTable();
    }
    const isModOf = (slug) => Boolean(slugMeta?.[slug]?.isMod);

    // 4) 并发抓价（默认 ≤4；只收可靠成交统计且 >0 的条目）
    const quotes = {};
    await mapLimit(rewards, workers, async (reward) => {
      let quote;
      if (priceFetcher) {
        quote = await priceFetcher(reward.slug, isModOf(reward.slug));
      } else {
        const { fetchTradeStatistics } = await import('./trader-shopping.mjs');
        quote = await fetchTradeStatistics(reward.slug, isModOf(reward.slug));
      }
      if (quote && Number(quote.platinum) > 0) quotes[reward.slug] = quote;
    });

    // 5) 构建 + 校验 + 原子写入
    const built = buildPrimeRewardIndex({ ...catalog, rewards }, quotes, { now, ttlHours });
    const check = validatePrimeRewardIndex(built, { now });
    if (!check.ok) throw new Error(`built index failed validation: ${check.error}`);
    await writePrimeRewardIndex(outputPath, built, { fileOps });
    return {
      ok: true,
      status: 'rebuilt',
      outputPath,
      generatedAt: built.generatedAt,
      expiresAt: built.expiresAt,
      coverage: built.coverage,
    };
  } catch (error) {
    const message = error?.message || String(error);
    const preserved = previousContent != null;
    log(`index generation failed (${message}); previous file ${preserved ? 'preserved' : 'absent'}`);
    return { ok: false, status: preserved ? 'refresh_failed' : 'failed', error: message, outputPath, preserved };
  }
}

// ==== CLI ====

function usage() {
  console.log([
    'WFInfo Prime 奖励估值索引生成器',
    '',
    '用法：',
    '  node prime-reward-index.mjs [--output <path>] [--ttl-hours <n>] [--concurrency <n>]',
    '                                [--limit <n>] [--force] [--aleca-dir <path>] [--help]',
    '',
    '  --output       输出路径（默认 %APPDATA%\\WFInfo\\prime_reward_prices.json；smoke 请给临时目录）',
    '  --ttl-hours    索引有效期小时数（默认 24，必须 >0）',
    '  --concurrency  并发抓价上限（默认 4，1..16）',
    '  --limit        最多定价的奖励条目数（默认 0=不限制；公共 smoke 建议 3）',
    '  --force        忽略新鲜缓存强制重建',
    '  --aleca-dir    AlecaFrame 数据目录（默认 ALECAFRAME_DATA_DIR 或本机默认位置）',
    '',
    '输出：JSON 状态（fresh=零联网复用 / rebuilt=重建成功 / refresh_failed=失败且旧文件保留 /',
    'failed=首次生成失败）；退出码 0=成功、1=生成失败、2=参数错误。',
    '安全边界：只读公共数据（遗物表/成交统计），不读账号或个人快照；不写真实 APPDATA 之外的路径。',
  ].join('\n'));
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`参数 ${arg} 缺少值`);
      i += 1;
      return next;
    };
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--output') options.outputPath = value();
    else if (arg === '--ttl-hours') options.ttlHours = value();
    else if (arg === '--concurrency') options.concurrency = value();
    else if (arg === '--limit') options.limit = value();
    else if (arg === '--force') options.force = true;
    else if (arg === '--aleca-dir') options.alecaDir = value();
    else throw new Error(`未知参数：${arg}`);
  }
  if (options.ttlHours !== undefined) {
    const hours = Number(options.ttlHours);
    if (!Number.isFinite(hours) || hours <= 0) throw new Error('--ttl-hours 必须是 >0 的数字');
    options.ttlHours = hours;
  }
  if (options.concurrency !== undefined) {
    const workers = Number(options.concurrency);
    if (!Number.isInteger(workers) || workers < 1 || workers > PRIME_REWARD_INDEX_MAX_CONCURRENCY) {
      throw new Error(`--concurrency 必须是 1..${PRIME_REWARD_INDEX_MAX_CONCURRENCY} 的整数`);
    }
    options.concurrency = workers;
  }
  if (options.limit !== undefined) {
    const limited = Number(options.limit);
    if (!Number.isInteger(limited) || limited < 0) throw new Error('--limit 必须是非负整数');
    options.limit = limited;
  }
  return options;
}

async function main() {
  const argv = process.argv.slice(2);
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(String(error?.message || error));
    usage();
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    usage();
    return;
  }
  const result = await generatePrimeRewardIndex(options);
  console.log(JSON.stringify({ ok: result.ok, status: result.status, ...result }, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(String(error?.message || error));
    process.exitCode = 1;
  });
}
