// wishlist-metrics.mjs 审计指标测试（整改 R4 第二切片）。
//
// 只检查脱敏指标：断线时长、订单发现延迟、QQ 投递延迟、扫描/Market 可用性；
// 原始 target/owner/order/wish/seller 标识必须永不出现在指标文件。

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { classifyMarketError, createWishlistMetrics } from './wishlist-metrics.mjs';

const ISO = (ms) => new Date(ms).toISOString();

test('classifyMarketError：错误归为脱敏类别（HTTP 状态/网络/超时/解析/未知）', () => {
  assert.equal(classifyMarketError(new Error('Warframe.Market top orders HTTP 503')), 'http_5xx');
  assert.equal(classifyMarketError(new Error('HTTP 429 too many requests')), 'http_429');
  assert.equal(classifyMarketError(new Error('HTTP 404 not found')), 'http_404');
  assert.equal(classifyMarketError(new Error('fetch aborted: timeout after 8000ms')), 'network_timeout');
  assert.equal(classifyMarketError(new Error('connect ECONNREFUSED api.warframe.market:443')), 'network');
  assert.equal(classifyMarketError(new Error('Unexpected token < in JSON')) , 'bad_response');
  assert.equal(classifyMarketError(new Error('something else')), 'unknown');
  assert.equal(classifyMarketError(''), 'unknown');
});

test('断线/发现/投递指标：聚合计数、最近窗口有界、未知来源如实计数', async () => {
  const clock = { now: Date.parse('2026-08-28T00:00:00.000Z') };
  const metrics = createWishlistMetrics({ memory: true, now: () => clock.now });
  await metrics.recordDisconnected({ at: ISO(clock.now) });
  await metrics.recordRecovered({ at: ISO(clock.now + 5_000), durationMs: 5_000 });
  await metrics.recordRecovered({ at: ISO(clock.now + 8_000), durationMs: 8_000 });
  await metrics.recordDiscovery({ at: ISO(clock.now + 9_000), latencyMs: 4_500, sourceKnown: true });
  await metrics.recordDiscovery({ at: ISO(clock.now + 10_000), latencyMs: null, sourceKnown: false });
  await metrics.recordDelivery({ at: ISO(clock.now + 30_000), latencyMs: 1_200 });

  const snapshot = await metrics.snapshot();
  assert.equal(snapshot.disconnect.count, 1, '断线事件计数（时长在恢复时记录）');
  assert.equal(snapshot.disconnect.totalMs, 13_000);
  assert.equal(snapshot.disconnect.maxMs, 8_000);
  assert.equal(snapshot.disconnect.lastMs, 8_000);
  assert.equal(snapshot.discovery.count, 2);
  assert.equal(snapshot.discovery.totalMs, 4_500);
  assert.equal(snapshot.discovery.unknownSource, 1);
  assert.equal(snapshot.delivery.count, 1);
  assert.equal(snapshot.delivery.totalMs, 1_200);
  assert.equal(snapshot.recent.length, 6);

  // 最近窗口有界：超过 50 条只保留最后 50
  for (let index = 0; index < 60; index += 1) {
    await metrics.recordDiscovery({ at: ISO(clock.now), latencyMs: index });
  }
  const bounded = await metrics.snapshot();
  assert.equal(bounded.recent.length, 50);
});

test('扫描记录与 Market 可用性：全组失败才标记不可用，恢复后清零', async () => {
  const metrics = createWishlistMetrics({ memory: true });
  await metrics.recordScan({ at: ISO(1_000), ok: true, groups: 2, fetched: 2, failedGroups: 0 });
  let snapshot = await metrics.snapshot();
  assert.equal(snapshot.market.available, true);
  assert.equal(snapshot.market.consecutiveFailures, 0);
  assert.equal(snapshot.scans.count, 1);
  assert.equal(snapshot.scans.lastOk, true);

  // 部分失败：仍可用（有真实成功数据），但记失败类别
  await metrics.recordScan({ at: ISO(2_000), ok: false, groups: 2, fetched: 1, failedGroups: 1, error: 'HTTP 503' });
  snapshot = await metrics.snapshot();
  assert.equal(snapshot.market.available, true);
  assert.equal(snapshot.scans.lastErrorCategory, 'http_5xx');

  // 全组失败：当场标记 Market 完全不可用 + 连续失败计数
  await metrics.recordScan({ at: ISO(3_000), ok: false, groups: 1, fetched: 0, failedGroups: 1, error: 'connect ECONNREFUSED' });
  snapshot = await metrics.snapshot();
  assert.equal(snapshot.market.available, false);
  assert.equal(snapshot.market.since, ISO(3_000));
  assert.equal(snapshot.market.lastErrorCategory, 'network');
  assert.equal(snapshot.market.consecutiveFailures, 1);

  // 恢复：可用并清零
  await metrics.recordScan({ at: ISO(4_000), ok: true, groups: 1, fetched: 1, failedGroups: 0 });
  snapshot = await metrics.snapshot();
  assert.equal(snapshot.market.available, true);
  assert.equal(snapshot.market.consecutiveFailures, 0);
});

test('持久化：重新加载实例读到同一指标；文件含 schema/updatedAt，绝不含任何标识', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'warframe-wishlist-metrics-'));
  const filePath = path.join(dir, 'warframe-wishlist-metrics.json');
  try {
    const clock = { now: Date.parse('2026-08-28T01:00:00.000Z') };
    const first = createWishlistMetrics({ filePath, now: () => clock.now });
    await first.recordDisconnected({ at: ISO(clock.now) });
    await first.recordRecovered({ at: ISO(clock.now + 3_000), durationMs: 3_000 });
    await first.recordScan({ at: ISO(clock.now + 4_000), ok: false, groups: 2, fetched: 0, failedGroups: 2, error: 'HTTP 503' });

    // 重新实例（模拟进程重启）→ 从磁盘恢复
    const second = createWishlistMetrics({ filePath, now: () => clock.now });
    const restored = await second.snapshot();
    assert.equal(restored.schemaVersion, 1);
    assert.equal(restored.disconnect.totalMs, 3_000);
    assert.equal(restored.market.available, false);
    assert.ok(restored.updatedAt);

    // 文件本身无任何标识（原始 target/order/wish/seller/openid 都不出现）
    const raw = await readFile(filePath, 'utf8');
    for (const secret of ['qqbot:c2c:member-b', 'order-o-1', 'WABC1', 'seller-a', 'openid-123']) {
      assert.equal(raw.includes(secret), false, `指标文件不得包含 ${secret}`);
    }
    assert.equal(raw.includes('latencyMs') || raw.includes('durationMs'), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('markMarketUnavailable：主动标记完全不可用并归类错误', async () => {
  const metrics = createWishlistMetrics({ memory: true });
  await metrics.markMarketUnavailable({ at: ISO(9_000), error: 'fetch failed' });
  const snapshot = await metrics.snapshot();
  assert.equal(snapshot.market.available, false);
  assert.equal(snapshot.market.since, ISO(9_000));
  assert.equal(snapshot.market.lastErrorCategory, 'network');
  assert.equal(snapshot.market.consecutiveFailures, 1);
});
