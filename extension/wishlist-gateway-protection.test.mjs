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
  assert.match(startBlock, /recoveryScan: async \(\) => \{ await runWishlistScanShared\(api\); \}/u, '恢复扫描走共用执行槽');
  assert.match(startBlock, /protectionScan: async \(\) => \{ await runWishlistScanShared\(api\); \}/u, '保护轮询复用合并扫描');
  assert.match(startBlock, /metricsSink: \(event: any\) => \{/u, '脱敏指标事件透传');
  assert.match(startBlock, /staleAfterMs: tuning\.staleAfterMs/u, '事件流静默阈值可配置');
  assert.match(startBlock, /protectionMinMs: tuning\.protectionMinMs/u);
  assert.match(startBlock, /protectionMaxMs: tuning\.protectionMaxMs/u);
  assert.match(startBlock, /onOrder: async \(order: any, activityAtIso\?: string\) =>/u, '实时订单携带 WS 接收时间');

  // 参数默认值与钳制边界：staleAfterMs / 20~30 秒 / 400ms 起点节流 / 并发 2 / 十分钟低频校准
  assert.match(entry, /staleAfterMs: clamp\(raw\?\.staleAfterMs, 5 \* 60_000, 30_000, 30 \* 60_000\)/u);
  assert.match(entry, /const protectionMinMs = clamp\(raw\?\.protectionMinMs, 20_000, 5_000, 60_000\);/u);
  assert.match(entry, /protectionMaxMs: Math\.max\(protectionMinMs, clamp\(raw\?\.protectionMaxMs, 30_000, 5_000, 120_000\)\)/u);
  assert.match(entry, /rateCapacity: clamp\(raw\?\.rateCapacity, 1, 1, 10\)/u);
  assert.match(entry, /rateRefillMs: clamp\(raw\?\.rateRefillMs, 400, 250, 30_000\)/u);
  assert.match(entry, /concurrencyLimit: clamp\(raw\?\.concurrencyLimit, 2, 1, 5\)/u);
  assert.match(entry, /calibrationIntervalMs: clamp\(raw\?\.calibrationIntervalMs, 10 \* 60_000, 60_000, 60 \* 60_000\)/u, '十分钟低频校准可配置且有钳制');

  // 恢复/保护/低频校准扫描：全局合并 + 单份 REST 请求 + 每 target 链保留
  const scanBlock = entry.slice(entry.indexOf('async function runWishlistRecoveryScan'), entry.indexOf('async function ensureDropsCron'));
  assert.match(scanBlock, /moduleProtection\.runCoalescedWishlistScan\(\{/u, '恢复扫描与保护轮询共用合并编排');
  assert.match(scanBlock, /fetchOne: async \(wish: any\) => module\.fetchTopOrdersForItem\(wish, globalThis\.fetch\)/u, '每组合并一次 Market 请求');
  assert.match(scanBlock, /monitorTarget: async \(target: string, targetWishes: any\[\], info: any\) =>/u, '逐 target 保留 per-target 匹配链');
  assert.match(scanBlock, /await wishlistProtectionBucketInstance\(api\)/u, '全局令牌桶');
  assert.match(scanBlock, /await wishlistProtectionConcurrencyInstance\(api\)/u, '全局并发上限');
  assert.match(scanBlock, /const forceRest = options\.forceRest !== false;/u, '恢复/保护默认强制校准，低频校准按到期扫描');
  assert.match(scanBlock, /if \(!forceRest\) \{/u, '到期门先于任何 Market 请求');
  assert.match(scanBlock, /return \{ ok: true, reason: 'not_due', targets: 0, groups: 0, fetched: 0, failedGroups: 0, marketAvailable: null \};/u, '未到期零联网返回');
  assert.match(scanBlock, /restIntervalMs: tuning\.calibrationIntervalMs/u, '低频校准沿用十分钟到期语义');
  assert.match(scanBlock, /richPayload: true/u, '命中载荷与 wm 一致（单一 rich part：图片＋文案＋键盘）');
  assert.match(scanBlock, new RegExp(PROD_FALLBACK, 'u'), '全组失败走 restError 分支');
  assert.match(scanBlock, /保护轮询继续按 20～30 秒重试/u, 'Market 不可用时不伪造新鲜校准');

  // 低频校准：插件内调度替代 CLI cron + 与恢复/保护共用单飞执行槽
  assert.match(entry, /const WISHLIST_CALIBRATION_TICK_MS = 60_000;/u, '校准节拍');
  assert.match(entry, /if \(options\.skipIfBusy && wishlistScanInFlight > 0\) \{/u, '节拍撞上在飞扫描时跳过');
  assert.match(entry, /await previous;\n    return runWishlistRecoveryScan\(api, \{ forceRest: options\.forceRest !== false \}\);/u, '三个入口串行共用执行槽');
  assert.match(entry, /wishlistCalibrationTimer = setInterval\(\(\) => \{ void runWishlistCalibrationTick\(api\); \}, WISHLIST_CALIBRATION_TICK_MS\);/u, '启动低频校准定时器');
  assert.match(entry, /recordScan\(\{\n      at: new Date\(\)\.toISOString\(\),\n      ok: true,/u, '校准扫描写脱敏指标');
  assert.match(entry, /scope: 'calibration'/u, '校准指标可区分于恢复/保护扫描');
  assert.match(entry, /summary = error\?\.scanSummary \|\| \{\}/u, 'Market 不可用时用真实组数记指标');

  // 退役：不再为任何 target 建 wishlist cron，只清旧任务
  assert.equal(entry.includes("'add', '--name', 'Warframe 愿望单校准'"), false, '不再注册 CLI 校准 cron');
  assert.match(entry, /const WISHLIST_CRON_DECLARATION_PREFIX = 'warframe-assistant:wishlist:qq:';/u);
  assert.match(entry, /async function retireWishlistCrons\(api: any, reason: string\): Promise<number>/u);
  assert.match(startBlock, /await retireWishlistCrons\(api, 'startup'\);/u, '升级后启动即清理旧 cron');
  assert.match(entry, /await retireWishlistCrons\(api, action\);/u, '愿望管理动作继续幂等退役');

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

test('index.ts 合同：愿望卡总开关只有私聊门，且默认按一体卡投递', async () => {
  const entry = await readFile(new URL('./index.ts', import.meta.url), 'utf8');

  // 偏好读取：默认一体卡，读取失败按兼容拆分；键只保存摘要（模块自带测试）
  assert.match(entry, /import \{ WISHLIST_CARD_PREFERENCE_FILE, getWishlistCardMerged, parseWishlistCardPreferenceCommand, setWishlistCardMerged \} from '\.\/qq-wishlist-card-preferences\.mjs';/u);
  assert.match(entry, /const wishlistCardPreferenceFile = path\.resolve\(path\.dirname\(wishlistState\), WISHLIST_CARD_PREFERENCE_FILE\);/u);
  const readBlock = entry.slice(entry.indexOf('async function wishlistMergedCardEnabled'), entry.indexOf('async function wishlistCardPreferenceReply'));
  assert.match(readBlock, /if \(!senderId\) return false;/u, '没有可信发送者时按兼容拆分');
  assert.match(readBlock, /api\?\.logger\?\.warn\?\.\('Warframe wishlist card preference read failed; using compatible split delivery'\);/u, '读取失败如实降级且不打印异常原文');
  assert.match(readBlock, /return false;/u);

  // 命令回执：仅私聊，三种动作都给出可逆说明
  const replyBlock = entry.slice(entry.indexOf('async function wishlistCardPreferenceReply'), entry.indexOf('function installMarketTrendInteractionBridge'));
  assert.match(replyBlock, /if \(Boolean\(event\.isGroup \|\| agentContextIsGroup\(ctx\)\)\) \{/u, '群聊拒绝');
  assert.match(replyBlock, /'愿望卡设置仅支持 QQ 私聊。'/u);
  assert.match(replyBlock, /发送“愿望卡 \$\{merged \? '关' : '开'\}”可切换。/u, '状态回执说明如何切换');

  // 三个入口都在通用快捷路径之前处理开关命令
  const sites = entry.split("wishlistCardCommand").length - 1;
  assert.ok(sites >= 4, `开关命令需在三个钩子前置处理（当前引用 ${sites} 次）`);
  assert.match(entry, /const wishlistCardCommand = isQQChannel\(channel\) \? parseWishlistCardPreferenceCommand\(content\) : null;/u);
  assert.match(entry, /const wishlistCardCommand = isQQChannel\(event\.channel\)\n        \? parseWishlistCardPreferenceCommand\(event\.content\)\n        : null;/u);
  assert.match(entry, /if \(!marketCardCommand && !wishlistCardCommand && !isShortcut\(content\) && !isSubscriptionCommand\(content\)\) return;/u);
  assert.match(entry, /reason: 'warframe-wishlist-card-preference'/u);

  // 投递链：四个愿望富卡片出口都走同一分流，开关与降级共用一条路径
  const mergeSites = entry.split('await wishlistMergedCardEnabled(api').length - 1;
  assert.equal(mergeSites, 4, '命中通知、建卡跟随与交互回复（有图/无图两条）都读同一开关');
  assert.equal(entry.includes('sendWishlistKeyboardWithFallback'), false, '旧分发入口不再被直接调用');
  assert.equal(entry.includes('sendWishlistKeyboard('), false, '旧键盘投递不再被直接调用');
  assert.match(entry, /const sent = await sendWishlistCard\(\{/u);
  assert.match(entry, /const sendMedia = sendMediaFor\(adapter, \{ cfg: api\.config, to: target, mediaLocalRoots: \[subscriptionCardDir, cardDir\] \}\);/u, '命中通知复用 adapter 媒体端口');
  assert.match(entry, /sendMedia: sendMediaFor\(adapter, common\)/u, '建卡跟随与交互回复复用 adapter 媒体端口');
});

test('index.ts 合同：停止网关清状态机，不残留扫描/定时器职责', async () => {
  const entry = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  const stopBlock = entry.slice(entry.indexOf('async function stopWishlistGateway'), entry.indexOf('async function handleWishlistLiveOrder'));
  assert.match(stopBlock, /wishlistGateway\?\.stop\(\);/u);
  assert.equal(stopBlock.includes('setInterval'), false, 'stop 只交给状态机，不自行起定时器');
  assert.match(stopBlock, /if \(wishlistCalibrationTimer\) clearInterval\(wishlistCalibrationTimer\);/, '停止时必须清掉低频校准定时器');
  assert.match(stopBlock, /wishlistCalibrationTimer = null;/, '停止后不保留定时器句柄');
});
