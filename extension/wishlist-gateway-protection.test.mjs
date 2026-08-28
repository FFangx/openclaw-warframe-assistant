// index.ts 合同：R4 第二切片保护轮询/全局合并/令牌桶/并发/指标接线。
//
// index.ts 是 TypeScript 插件入口（无独立编译步骤），用源码字符串断言关键
// 接线，防止后续编辑把保护模式、合并扫描或脱敏指标悄悄拆掉。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const PROD_FALLBACK = 'Warframe.Market 完全不可用（保护扫描全组失败）';

test('index.ts 合同：保护轮询、全局合并限流与指标全部接线', async () => {
  const entry = await readFile(new URL('./index.ts', import.meta.url), 'utf8');

  // 模块导入：指标 store 静态接入；保护原语在 skill 树（受管内容，运行时 pathToFileURL）
  assert.match(entry, /import \{ createWishlistMetrics \} from '\.\/wishlist-metrics\.mjs'/u);
  assert.match(entry, /wishlistProtectionScript = path\.resolve\(pluginDir, '\.\.', '\.\.', '\.\.', 'skills', 'warframe-assistant', 'scripts', 'wishlist-protection\.mjs'\)/u);

  // 状态机接线：保护模式参数、保护扫描与指标 sink 必须注入
  const startBlock = entry.slice(entry.indexOf('async function startWishlistGateway'), entry.indexOf('async function stopWishlistGateway'));
  assert.match(startBlock, /protectionScan: async \(\) => \{ await runWishlistRecoveryScan\(api\); \}/u, '保护轮询复用合并扫描');
  assert.match(startBlock, /metricsSink: \(event: any\) => \{/u, '脱敏指标事件透传');
  assert.match(startBlock, /staleAfterMs: tuning\.staleAfterMs/u, '事件流静默阈值可配置');
  assert.match(startBlock, /protectionMinMs: tuning\.protectionMinMs/u);
  assert.match(startBlock, /protectionMaxMs: tuning\.protectionMaxMs/u);
  assert.match(startBlock, /onOrder: async \(order: any, activityAtIso\?: string\) =>/u, '实时订单携带 WS 接收时间');

  // 参数默认值与钳制边界：staleAfterMs / 20~30 秒 / 400ms 起点节流 / 并发 2
  assert.match(entry, /staleAfterMs: clamp\(raw\?\.staleAfterMs, 5 \* 60_000, 30_000, 30 \* 60_000\)/u);
  assert.match(entry, /const protectionMinMs = clamp\(raw\?\.protectionMinMs, 20_000, 5_000, 60_000\);/u);
  assert.match(entry, /protectionMaxMs: Math\.max\(protectionMinMs, clamp\(raw\?\.protectionMaxMs, 30_000, 5_000, 120_000\)\)/u);
  assert.match(entry, /rateCapacity: clamp\(raw\?\.rateCapacity, 1, 1, 10\)/u);
  assert.match(entry, /rateRefillMs: clamp\(raw\?\.rateRefillMs, 400, 250, 30_000\)/u);
  assert.match(entry, /concurrencyLimit: clamp\(raw\?\.concurrencyLimit, 2, 1, 5\)/u);

  // 恢复/保护扫描：全局合并 + 单份 REST 请求 + 每 target 链保留
  const scanBlock = entry.slice(entry.indexOf('async function runWishlistRecoveryScan'), entry.indexOf('async function ensureDropsCron'));
  assert.match(scanBlock, /moduleProtection\.runCoalescedWishlistScan\(\{/u, '恢复扫描与保护轮询共用合并编排');
  assert.match(scanBlock, /fetchOne: async \(wish: any\) => module\.fetchTopOrdersForItem\(wish, globalThis\.fetch\)/u, '每组合并一次 Market 请求');
  assert.match(scanBlock, /monitorTarget: async \(target: string, targetWishes: any\[\], info: any\) =>/u, '逐 target 保留 per-target 匹配链');
  assert.match(scanBlock, /await wishlistProtectionBucketInstance\(api\)/u, '全局令牌桶');
  assert.match(scanBlock, /await wishlistProtectionConcurrencyInstance\(api\)/u, '全局并发上限');
  assert.match(scanBlock, /forceRest: true/u, 'REST 校准链保留');
  assert.match(scanBlock, new RegExp(PROD_FALLBACK, 'u'), '全组失败走 restError 分支');
  assert.match(scanBlock, /保护轮询继续按 20～30 秒重试/u, 'Market 不可用时不伪造新鲜校准');

  // 指标：断线时长/发现延迟/投递延迟接线，且不暴露标识
  assert.match(entry, /'warframe-wishlist-metrics\.json'/u, '指标文件路径');
  assert.match(entry, /recordDisconnected\(\{ at \}\)/u);
  assert.match(entry, /recordRecovered\(\{ at, durationMs: event\.durationMs \}\)/u);
  assert.match(entry, /recordDiscovery\(/u, '订单发现延迟');
  assert.match(entry, /recordDelivery\(/u, 'QQ 投递延迟');
  assert.match(entry, /latencyMs: Number\.isFinite\(sourceMs\) \? Math\.max\(0, committedAt - sourceMs\) : null/u, '延迟只记数字，不记标识');
  const metricsBlock = entry.slice(entry.indexOf('async function forwardWishlistGatewayMetrics'), entry.indexOf('async function recordWishlistDeliveryLatency'));
  assert.equal(metricsBlock.includes('target'), false, '指标 sink 不得出现 target');
  // 指标文件与 Outbox 同目录但独立，不写入愿望账本
  assert.equal(entry.includes('wishlistMetricsInstance'), true);
});

test('index.ts 合同：停止网关清状态机，不残留扫描/定时器职责', async () => {
  const entry = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  const stopBlock = entry.slice(entry.indexOf('async function stopWishlistGateway'), entry.indexOf('async function handleWishlistLiveOrder'));
  assert.match(stopBlock, /wishlistGateway\?\.stop\(\);/u);
  assert.equal(stopBlock.includes('setInterval'), false, 'stop 只交给状态机，不自行起定时器');
});
