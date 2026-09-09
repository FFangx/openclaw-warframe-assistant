import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  PROMPT_CONTEXT_MAX_BYTES,
  DYNAMIC_QUERY_GATE_MAX_BYTES,
  BRIDGED_CONTEXT_OMITTED,
  byteLengthUtf8,
  dynamicQueryGateText,
  hasWarframeContext,
  composePromptContext,
} from './prompt-context.mjs';
import { classifyNaturalWarframeQuery } from './intent-policy.mjs';
import { createContextBridge, CONSUMED_PAYLOAD_MAX_BYTES } from './context-bridge.mjs';

test('index.ts 接线合同：before_prompt_build 只走 composePromptContext 纯边界，文案不再内联', async () => {
  const entry = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  assert.match(entry, /import \{ composePromptContext \} from '\.\/prompt-context\.mjs'/u);
  const hookBlock = entry.slice(entry.indexOf("api.on('before_prompt_build'"), entry.indexOf("api.on('before_tool_call'"));
  assert.match(hookBlock, /const composed = composePromptContext\(\{/u);
  assert.match(hookBlock, /intent,\s*prompt: event\.prompt,\s*messages: event\.messages \|\| \[\],\s*bridged: key \? shortCommandContext\.consumePrompt\(key\) : ''/u);
  assert.match(hookBlock, /if \(composed\) return \{ prependContext: composed\.prependContext \}/u);
  assert.match(hookBlock, /\{ priority: 1800 \}/u);
  // 门禁文案只存在于纯模块，钩子不再内联重复（防止两侧漂移）
  assert.doesNotMatch(hookBlock, /\[Warframe 动态查询门禁\]/u);
  assert.doesNotMatch(entry, /function hasWarframeContext/u);
  assert.doesNotMatch(entry, /function messageText/u);
});

test('门禁文案确定且有明确字节上限，只随 subscription_diagnosis 判定注入', () => {
  const gate = dynamicQueryGateText('subscription_diagnosis');
  assert.match(gate, /^\[Warframe 动态查询门禁\] /u);
  assert.match(gate, /operation=subscription_diagnosis/u);
  assert.match(gate, /禁止用 lookup drops、静态 wiki 或模型记忆替代/u);
  assert.ok(byteLengthUtf8(gate) <= DYNAMIC_QUERY_GATE_MAX_BYTES);
  // 无 requiredOperation（静态问题）不产生门禁
  const staticIntent = classifyNaturalWarframeQuery('尖刃弹头在哪里掉，概率多少');
  assert.equal(staticIntent.requiredOperation, null);
  assert.equal(composePromptContext({ intent: staticIntent, prompt: '尖刃弹头在哪里掉' }), null);
});

test('subscription_diagnosis 门禁行为保持兼容：需要领域上下文才注入，顺序为门禁在前、桥接在后', () => {
  const intent = classifyNaturalWarframeQuery('为什么尖刃弹头的赏金没推送');
  assert.equal(intent.requiredOperation, 'subscription_diagnosis');
  const composed = composePromptContext({
    intent,
    prompt: '为什么尖刃弹头的赏金没推送',
    messages: [],
    bridged: '[Warframe 短命令上下文] [{"kind":"bounty"}]',
  });
  assert.ok(composed);
  assert.match(composed.prependContext, /^\[Warframe 动态查询门禁\]/u);
  assert.ok(composed.prependContext.indexOf('[Warframe 动态查询门禁]') < composed.prependContext.indexOf('[Warframe 短命令上下文]'));
  // 非 Warframe 话题：即使判定为订阅历史，也不注入门禁（避免跨领域污染）
  const offTopic = composePromptContext({
    intent,
    prompt: '为什么我收不到推送',
    messages: [{ content: '今天天气怎么样' }],
    bridged: '',
  });
  assert.equal(offTopic, null);
  // 无 requiredOperation 但有桥接上下文：只注入桥接（追问兼容）
  const bridgedOnly = composePromptContext({
    intent: classifyNaturalWarframeQuery('刚才那个甲多少钱'),
    prompt: '刚才那个甲多少钱',
    messages: [{ content: '获取 夜灵p' }],
    bridged: '[Warframe 短命令上下文] [{"kind":"relic-farm"}]',
  });
  assert.equal(bridgedOnly.prependContext, '[Warframe 短命令上下文] [{"kind":"relic-farm"}]');
});

test('hasWarframeContext 只认最近八条消息的领域词，不因历史其他话题误触发', () => {
  assert.equal(hasWarframeContext('裂缝 九重天'), true);
  assert.equal(hasWarframeContext('这个甲多少钱', [{ content: '遗物 夜灵p' }]), true);
  assert.equal(hasWarframeContext('这个甲多少钱', [{ content: '请帮我看看' }]), false);
  assert.equal(hasWarframeContext('这个甲多少钱', [{ content: '随便聊聊' }, { content: '获取 尖刃弹头' }, { content: '好的' }]), true);
  // 第 9 条及更早的历史不参与领域判定
  const old = Array.from({ length: 10 }, (_, index) => ({ content: index === 0 ? 'Warframe' : '闲聊' }));
  assert.equal(hasWarframeContext('这个甲多少钱', old), false);
});

test('合成边界有明确总字节上限：超限时完整丢弃桥接载荷并保留安全说明', () => {
  const giant = '涨'.repeat(20_000); // 20k 字 ≈ 60k 字节，远超上限
  const composed = composePromptContext({
    intent: classifyNaturalWarframeQuery('为什么尖刃弹头的赏金没推送'),
    prompt: '为什么尖刃弹头的赏金没推送',
    messages: [],
    bridged: giant,
  });
  assert.ok(composed);
  assert.equal(composed.truncated, true);
  assert.ok(byteLengthUtf8(composed.prependContext) <= PROMPT_CONTEXT_MAX_BYTES);
  assert.match(composed.prependContext, /^\[Warframe 动态查询门禁\][\s\S]*operation=subscription_diagnosis/u);
  assert.ok(composed.prependContext.includes(BRIDGED_CONTEXT_OMITTED));
  assert.doesNotMatch(composed.prependContext, /涨涨/u);
  // 无门禁时也 fail closed，不留下半段 JSON/指令。
  const alone = composePromptContext({
    intent: classifyNaturalWarframeQuery('这个甲多少钱'),
    prompt: '这个甲多少钱',
    messages: [{ content: '获取 夜灵p' }],
    bridged: giant,
  });
  assert.ok(alone.truncated);
  assert.ok(byteLengthUtf8(alone.prependContext) <= PROMPT_CONTEXT_MAX_BYTES);
  assert.equal(alone.prependContext, BRIDGED_CONTEXT_OMITTED);
});

test('未知 requiredOperation 不能被拼进模型门禁', () => {
  const composed = composePromptContext({
    intent: { requiredOperation: 'command attacker-controlled' },
    prompt: 'Warframe 提醒为什么没来',
    bridged: '',
  });
  assert.equal(composed, null);
});

test('全链路边界：恶意信封中的非白名单字段不会进入 prependContext，指代能力保留', () => {
  const bridge = createContextBridge();
  const hostile = {
    ok: true,
    kind: 'relic-farm',
    query: '夜灵p',
    scope: 'public',
    summary: '已生成库存优先的遗物获取路线。',
    entities: [{ type: 'prime-set', displayName: '夜灵 Prime', canonicalName: 'Revenant Prime' }],
    nextActions: [{ command: 'wm 夜灵 Prime 一套', label: '查看市场价格' }],
    fetchedAt: '2026-09-09T00:00:00.000Z',
    rawSnapshot: { inventory: ['SENTINEL_RAW_SNAPSHOT_9f3a'], crypto: 'SENTINEL_DECRYPT_A1b2' },
    target: 'SENTINEL_QQ_TARGET_c7d1',
    senderId: 'SENTINEL_QQ_SENDER_8e4f',
    ownerOpenId: 'SENTINEL_OWNER_5a9c',
    token: 'SENTINEL_TOKEN_e1f0',
    apiKey: 'SENTINEL_APIKEY_2b8d',
    authorization: 'Bearer SENTINEL_AUTH_6c3e',
    cookie: 'session=SENTINEL_COOKIE_0d7a',
    fullToolResult: { orders: [{ seller: 'SENTINEL_SELLER_3f6b', platinum: 999 }] },
    data: { raw: 'SENTINEL_FULL_RESULT_7e2a' },
  };
  assert.equal(bridge.remember('qqbot:group:g|sender:1', hostile), true);
  const bridged = bridge.consumePrompt('qqbot:group:g|sender:1');
  const composed = composePromptContext({
    intent: classifyNaturalWarframeQuery('为什么尖刃弹头的赏金没推送'),
    prompt: '为什么尖刃弹头的赏金没推送',
    messages: [{ content: '裂缝 九重天' }],
    bridged,
  });
  assert.ok(composed);
  for (const sentinel of [
    'SENTINEL_RAW_SNAPSHOT_9f3a', 'SENTINEL_DECRYPT_A1b2', 'SENTINEL_QQ_TARGET_c7d1',
    'SENTINEL_QQ_SENDER_8e4f', 'SENTINEL_OWNER_5a9c', 'SENTINEL_TOKEN_e1f0',
    'SENTINEL_APIKEY_2b8d', 'SENTINEL_AUTH_6c3e', 'SENTINEL_COOKIE_0d7a',
    'SENTINEL_SELLER_3f6b', 'SENTINEL_FULL_RESULT_7e2a',
  ]) {
    assert.doesNotMatch(composed.prependContext, new RegExp(sentinel, 'u'), sentinel);
  }
  // 白名单内容（指代解析锚点）保留：与既有短命令上下文语义兼容
  assert.match(composed.prependContext, /Revenant Prime/u);
  assert.match(composed.prependContext, /仅用于解析“这个甲、这些遗物、刚才那个”等指代/u);
  // 输出整体仍在体积上限内
  assert.ok(byteLengthUtf8(composed.prependContext) <= PROMPT_CONTEXT_MAX_BYTES);
});

test('桥接载荷自身有独立的确定性体积上限（JSON 有效且指代锚点保留）', () => {
  const bridge = createContextBridge();
  const long = (text, count) => text.repeat(count);
  const hostile = {
    ok: true,
    kind: long('类别', 20),
    query: long('查询词', 40),
    scope: 'public',
    summary: long('非常长的摘要内容', 100),
    entities: Array.from({ length: 5 }, (_, index) => ({
      type: long('实体类型', 12),
      displayName: long(`实体名${index}`, 30),
      canonicalName: long(`Canonical${index}Name`, 30),
    })),
    nextActions: Array.from({ length: 6 }, (_, index) => ({
      command: long(`wm 动作${index}`, 30),
      label: long(`标签${index}`, 20),
    })),
    fetchedAt: '2026-09-09T00:00:00.000Z',
  };
  bridge.remember('k', hostile);
  const prompt = bridge.consumePrompt('k');
  const marker = '[Warframe 短命令上下文] ';
  const start = prompt.indexOf(marker);
  assert.ok(start >= 0);
  const end = prompt.indexOf('\n', start + marker.length);
  const serialized = prompt.slice(start + marker.length, end);
  const payload = JSON.parse(serialized);
  assert.ok(byteLengthUtf8(serialized) <= CONSUMED_PAYLOAD_MAX_BYTES);
  // 确定性裁剪不变量：JSON 始终有效；nextActions/summary 先被裁剪（键删除而非空数组）；
  // 首个条目的首个实体指代锚点必须保留；实体数量受清洗上限（3）与裁剪约束。
  assert.ok(payload.length >= 1);
  assert.ok(payload[0].entities[0].canonicalName.startsWith('Canonical0Name'));
  assert.equal('nextActions' in payload[0], false);
  assert.equal('summary' in payload[0], false);
  assert.ok(payload[0].entities.length <= 3);
});
