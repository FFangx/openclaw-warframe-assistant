// R18 片：模型可见上下文合成边界（before_prompt_build → prependContext）。
//
// 本模块是 before_prompt_build 中「上下文建什么、按什么顺序、多大」的纯函数
// 事实源：不访问网络、不调用模型、不读取事件身份之外的任何运行时状态，
// 因此可以由确定性合同测试直接验证。
//
// 边界（硬规则）：
// - 只合成两类内容：① 动态查询门禁（subscription_diagnosis 判定，纯静态文案）
//   ② 短命令指代桥接上下文（context-bridge 白名单输出的脱敏信封）。
// - 敏感字段（原始身份、target/sender、token/key、raw snapshot、完整工具结果等）
//   只可能由 context-bridge 的白名单清洗层进入；本模块不再从事件或 ctx 复制
//   任何字段，测试通过全链路输入的哨兵值证明这些字段不会出现在输出中。
// - 过期实时事实的降级由 context-bridge 按 evidence 新鲜度语义打标记，
//   本模块只负责合成顺序与总字节上限。
// - 总输出字节上限：PROMPT_CONTEXT_MAX_BYTES（UTF-8）。异常超限时 fail closed：
//   不截断结构化桥接内容，只保留完整门禁和固定的重新查询说明。

export const PROMPT_CONTEXT_MAX_BYTES = 4096;
export const DYNAMIC_QUERY_GATE_MAX_BYTES = 512;
export const BRIDGED_CONTEXT_OMITTED = '[Warframe 短命令上下文已省略] 上下文超过安全上限；必须重新调用 warframe_assistant 查询，不得依据旧卡片断言当前状态。';

export function byteLengthUtf8(text) {
  return new TextEncoder().encode(String(text || '')).length;
}

export function dynamicQueryGateText(operation) {
  if (operation !== 'subscription_diagnosis') return '';
  return `[Warframe 动态查询门禁] 本轮问题属于订阅历史/漏提醒诊断。必须先调用 warframe_assistant operation=${operation}，query 只传用户关注的物品或订阅条件；若还问当前轮，再追加对应 operation=command 当前查询。禁止用 lookup drops、静态 wiki 或模型记忆替代。`;
}

const WARFRAME_CONTEXT_PATTERN = /(?:Warframe|星际战甲|赏金|悬赏|遗物|裂缝|仲裁|尖刃弹头|Bladed Rounds|Prime|杜卡德|虚空商人|AlecaFrame|WFInfo)/iu;

function messageText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => messageText(item?.text || item?.content || '')).join(' ');
  return messageText(value?.content || value?.text || '');
}

export function hasWarframeContext(prompt, messages = []) {
  const recent = [prompt, ...messages.slice(-8).map(messageText)].join(' ');
  return WARFRAME_CONTEXT_PATTERN.test(recent);
}

/**
 * 合成 before_prompt_build 的 prependContext。
 * @param {object} input
 * @param {object|null} input.intent classifyNaturalWarframeQuery 的结果
 * @param {string} input.prompt 本轮用户提示
 * @param {Array} [input.messages] 本轮消息历史（用于 Warframe 领域判定）
 * @param {string} [input.bridged] context-bridge 消费结果（已脱敏）
 * @returns {{ prependContext: string, bytes: number, truncated: boolean }|null}
 */
export function composePromptContext({ intent, prompt, messages = [], bridged = '' }) {
  const gate = intent?.requiredOperation && hasWarframeContext(prompt, messages)
    ? dynamicQueryGateText(intent.requiredOperation)
    : '';
  const parts = [gate, bridged || ''].filter(Boolean);
  if (!parts.length) return null;

  let joined = parts.join('\n');
  let truncated = false;
  const bytes = byteLengthUtf8(joined);
  if (bytes > PROMPT_CONTEXT_MAX_BYTES) {
    // 结构化 JSON 和末尾的重新查询规则都不能被截成半段；异常超限时丢弃
    // 整个桥接载荷，保留完整安全门与固定降级说明。
    joined = [gate, BRIDGED_CONTEXT_OMITTED].filter(Boolean).join('\n');
    truncated = true;
  }
  return { prependContext: joined, bytes: byteLengthUtf8(joined), truncated };
}
