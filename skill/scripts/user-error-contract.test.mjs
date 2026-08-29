import assert from 'node:assert/strict';
import test from 'node:test';

import { EndpointRequestError } from './http-resilience.mjs';
import {
  degradedNotice,
  formatUserError,
  userError,
  userErrorFromDiagnostic,
} from './user-error-contract.mjs';
import { runShortcut } from './shortcuts.mjs';

test('404 是确定性未命中，403 是来源拒绝而不是用户权限不足', () => {
  const missing = userErrorFromDiagnostic({ category: 'not_found', status: 404, attempts: 1 });
  assert.deepEqual(missing, {
    code: 'no_match', category: 'not_found', retryable: false, httpStatus: 404, attempts: 1,
  });

  const forbidden = userErrorFromDiagnostic({ category: 'http_error', status: 403, attempts: 1 });
  assert.equal(forbidden.code, 'source_unavailable');
  assert.equal(forbidden.category, 'forbidden');
  assert.equal(forbidden.retryable, true);
  assert.equal(forbidden.httpStatus, 403);
  assert.match(forbidden.retryHint, /15 分钟/u);
  assert.notEqual(forbidden.code, 'permission_denied');

  const cannotOverride = userErrorFromDiagnostic(
    { category: 'http_error', status: 403 },
    { code: 'permission_denied', retryable: false, httpStatus: 404 },
  );
  assert.equal(cannotOverride.code, 'source_unavailable');
  assert.equal(cannotOverride.retryable, true);
  assert.equal(cannotOverride.httpStatus, 403);
});

test('429、超时与熔断映射为可恢复来源故障，且只保留安全字段', () => {
  const limited = userErrorFromDiagnostic({
    endpoint: 'market:v2:orders', category: 'rate_limited', status: 429, attempts: 2,
    openUntil: Date.now() + 30_000, secret: 'https://example.invalid/token',
  }, { nextSteps: ['wm 悟空p（稍后重试）'] });
  assert.equal(limited.code, 'source_unavailable');
  assert.equal(limited.httpStatus, 429);
  assert.equal(limited.attempts, 2);
  assert.deepEqual(Object.keys(limited).toSorted(), [
    'attempts', 'category', 'code', 'httpStatus', 'nextSteps', 'retryHint', 'retryable',
  ]);
  assert.doesNotMatch(JSON.stringify(limited), /example\.invalid|token|market:v2/u);

  const timeout = userErrorFromDiagnostic({ category: 'timeout', attempts: 2 });
  assert.equal(timeout.retryable, true);
  const circuit = userErrorFromDiagnostic({ category: 'circuit_open', attempts: 0 });
  assert.equal(circuit.retryable, true);
  assert.match(circuit.retryHint, /熔断/u);
});

test('权限拒绝与成功降级使用不同合同，不把缓存结果伪装成失败', () => {
  const denied = userError({ code: 'permission_denied', category: 'personal-identity', retryable: false });
  assert.equal(denied.code, 'permission_denied');
  const degraded = degradedNotice({ cachedUsed: true, fallbackUsed: true });
  assert.equal(degraded.code, 'stale_fallback');
  assert.equal(degraded.cachedUsed, true);
  assert.equal(degraded.fallbackUsed, true);
  assert.match(formatUserError(degraded), /缓存/u);
  assert.match(formatUserError(degraded), /备用数据源/u);
});

test('裂缝来源 403 会形成可行动的用户回复，且不泄露底层地址或异常', async () => {
  const reply = await runShortcut('裂缝 九重天', {
    loadWorldState: async () => {
      throw new EndpointRequestError('raw https://secret.invalid/worldstate', {
        endpoint: 'worldstate:official:raw', category: 'http_error', status: 403,
        retryable: false, attempts: 1, openUntil: Date.now() + 15 * 60_000,
      });
    },
  });
  assert.equal(reply.ok, false);
  assert.equal(reply.data.userError.code, 'source_unavailable');
  assert.equal(reply.data.userError.httpStatus, 403);
  assert.match(reply.text, /无法取得.*九重天.*最新世界状态/u);
  assert.match(reply.text, /15 分钟/u);
  assert.match(reply.text, /下一步/u);
  assert.doesNotMatch(reply.text, /secret\.invalid|worldstate:official|raw https/u);
});
