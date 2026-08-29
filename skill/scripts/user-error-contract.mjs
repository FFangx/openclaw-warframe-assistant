// 小型共享用户错误合同（R19/R17 切片，见 config/AGENTS.warframe.md 底线）：
// 只定义「脱敏错误负载」的稳定形状与诊断映射，供个人/公共确定性命令边界与
// 开遗物等确定性命令复用。不建设 trace、状态中心或 Monitor Registry。
//
// 安全边界（硬规则）：
//  - 绝不携带 URL、响应体、堆栈、账号标识、目标标识或凭据；
//  - httpStatus 只允许 400..599 的安全状态码（不带 URL 细节）；
//  - 文字一律由本模块/调用方重新构造，不透出原始错误 message/cause；
//  - 成功但降级的可用结果用 code=stale_fallback 的「提示」负载（degraded），
//    不做成失败；失败结果用 code 指向 userError。
//
// EndpointRequestError（http-resilience.mjs）的 diagnostic 是权威端点诊断；
// userErrorFromDiagnostic 只做类别映射，不复制内部字段。

export const USER_ERROR_CODES = Object.freeze([
  'unsupported_input',
  'no_match',
  'source_unavailable',
  'permission_denied',
  'stale_fallback',
  'internal_error',
]);

const CODE_HINT = Object.freeze({
  unsupported_input: '该写法当前不支持；发送「帮助 遗物」或「帮助 账号」查看支持写法。',
  no_match: '当前数据中没有符合条件的结果。',
  source_unavailable: '数据源暂时不可用。',
  permission_denied: '当前会话无权执行该操作。',
  stale_fallback: '实时数据不可用，以下为缓存或备用源结果（仅供参考）。',
  internal_error: '处理失败，请稍后重试。',
});

const CATEGORY_RE = /^[a-z][a-z0-9_-]{0,31}$/u;
const UNSAFE_CHARS = /[\u0000-\u001f\u007f\r\n]/gu;

function safeText(value, maxLength = 120) {
  return String(value ?? '').replace(UNSAFE_CHARS, ' ').trim().slice(0, maxLength);
}

/**
 * 构造一个不可变、字段白名单化的用户错误负载。
 * 未知/非法字段直接抛错（测试与调用方都能抓住拼写错误）。
 */
export function userError(spec = {}) {
  const code = String(spec.code || '');
  if (!USER_ERROR_CODES.includes(code)) throw new Error(`user error code 非法: ${code || '(空)'}`);
  const category = safeText(spec.category || code);
  if (!CATEGORY_RE.test(category)) throw new Error(`user error category 非法: ${category}`);
  const httpStatus = spec.httpStatus == null ? null : Number(spec.httpStatus);
  if (httpStatus !== null && (!Number.isInteger(httpStatus) || httpStatus < 400 || httpStatus > 599)) {
    throw new Error(`user error httpStatus 必须是 400..599 或 null: ${spec.httpStatus}`);
  }
  const payload = {
    code,
    category,
    retryable: spec.retryable === true,
  };
  if (httpStatus !== null) payload.httpStatus = httpStatus;
  if (spec.fallbackUsed === true) payload.fallbackUsed = true;
  if (spec.cachedUsed === true) payload.cachedUsed = true;
  if (spec.retryHint) {
    const hint = safeText(spec.retryHint);
    if (hint) payload.retryHint = hint;
  }
  if (Array.isArray(spec.nextSteps)) {
    const steps = spec.nextSteps.map((step) => safeText(step)).filter(Boolean).slice(0, 6);
    if (steps.length) payload.nextSteps = steps;
  }
  if (spec.attempts != null && Number.isInteger(Number(spec.attempts)) && Number(spec.attempts) >= 0) {
    payload.attempts = Number(spec.attempts);
  }
  return Object.freeze(payload);
}

/**
 * 把端点诊断（EndpointRequestError.diagnostic / http-resilience 类别）映射为
 * 用户错误负载。未知类别保守映射为 source_unavailable（可重试）。
 * 该映射保持「404 确定性缺失、403 熔断语义」：404 → no_match 不可重试且不触发熔断；
 * 403 → source_unavailable：这是上游来源拒绝访问，不是用户权限不足；底层仍维持长熔断。
 */
export function userErrorFromDiagnostic(diagnostic = {}, extra = {}) {
  const category = safeText(diagnostic?.category || 'network');
  const status = Number(diagnostic?.status) || null;
  const attempts = Number(diagnostic?.attempts);
  // 调用方只能补充展示信息，不能覆盖诊断映射出的 code/status/retryable。
  const additions = {
    ...(extra.category ? { category: extra.category } : {}),
    ...(extra.fallbackUsed === true ? { fallbackUsed: true } : {}),
    ...(extra.cachedUsed === true ? { cachedUsed: true } : {}),
    ...(extra.retryHint ? { retryHint: extra.retryHint } : {}),
    ...(Array.isArray(extra.nextSteps) ? { nextSteps: extra.nextSteps } : {}),
  };
  const base = {
    category,
    retryable: false,
    ...(Number.isInteger(attempts) && attempts >= 0 ? { attempts } : {}),
  };
  let mapped;
  if (category === 'not_found') {
    mapped = userError({
      ...base, ...additions, code: 'no_match', retryable: false,
      ...(status === 404 ? { httpStatus: 404 } : {}),
    });
  } else if (category === 'rate_limited') {
    mapped = userError({
      ...base, ...additions, code: 'source_unavailable', retryable: true,
      ...(status === 429 ? { httpStatus: 429 } : {}),
      retryHint: '已按服务商限流要求自动重试；仍失败请稍后再发。',
    });
  } else if (category === 'http_error' && status === 403) {
    mapped = userError({
      ...base, ...additions, code: 'source_unavailable', category: 'forbidden', retryable: true, httpStatus: 403,
      retryHint: '数据源拒绝访问，已暂停请求 15 分钟；保护期结束后系统会自动恢复探测。',
    });
  } else if (category === 'http_error') {
    mapped = userError({
      ...base, ...additions, code: 'source_unavailable', retryable: false,
      ...(status !== null ? { httpStatus: status } : {}),
    });
  } else if (category === 'circuit_open') {
    mapped = userError({
      ...base, ...additions, code: 'source_unavailable', retryable: true,
      retryHint: '端点熔断保护中，已自动暂停重试；恢复后重新查询即可。',
    });
  } else {
    // timeout / network / server_error / bad_response / 未知类别：可重试
    mapped = userError({
      ...base, ...additions, code: 'source_unavailable', retryable: true,
      ...(status !== null ? { httpStatus: status } : {}),
    });
  }
  return mapped;
}

/**
 * 生成用户可见的脱敏说明（不含 URL/响应体/堆栈/标识）。
 * 仅用于把契约负载安全地翻译成文字；真正进入用户消息的文本由调用方再拼接
 * 「系统如何理解输入」和「下一步命令」。
 */
export function formatUserError(error = {}, options = {}) {
  const safe = error && typeof error === 'object' ? error : {};
  const code = USER_ERROR_CODES.includes(safe.code) ? safe.code : 'internal_error';
  const lines = [];
  if (code === 'stale_fallback') {
    lines.push(options.message || CODE_HINT.stale_fallback);
    if (safe.cachedUsed === true) lines.push('本次使用本地缓存，不代表实时数据。');
    if (safe.fallbackUsed === true) lines.push('本次使用备用数据源。');
  } else {
    lines.push(options.message || CODE_HINT[code]);
    if (safe.retryable === true && !safe.retryHint) lines.push('系统会自动处理；你也可以稍后重试。');
    if (safe.retryHint) lines.push(safe.retryHint);
    if (safe.httpStatus != null) lines.push(`来源响应状态 ${safe.httpStatus}（细节不公开）。`);
    if (safe.cachedUsed === true) lines.push('本次使用了本地缓存。');
    if (safe.fallbackUsed === true) lines.push('本次使用了备用数据源。');
  }
  const steps = (options.nextSteps || safe.nextSteps || []).map((step) => safeText(step)).filter(Boolean).slice(0, 6);
  if (steps.length) lines.push(`下一步：${steps.join('｜')}`);
  return lines.join('\n');
}

/** 成功但降级的提示负载（不伪装成失败）：stale_fallback + 缓存/备用源说明。 */
export function degradedNotice(spec = {}) {
  return userError({
    code: 'stale_fallback',
    retryable: false,
    ...(spec.cachedUsed || spec.fallbackUsed ? spec : {}),
  });
}
