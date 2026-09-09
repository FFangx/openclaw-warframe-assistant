import assert from 'node:assert/strict';
import test from 'node:test';
import { createContextBridge, CONSUMED_PAYLOAD_MAX_BYTES } from './context-bridge.mjs';
import { buildEvidenceEnvelope } from './evidence.mjs';

const sample = { ok: true, kind: 'relic-farm', query: '夜灵p', summary: '候选遗物均已入库', entities: [{ type: 'prime-set', displayName: '夜灵 Prime', canonicalName: 'Revenant Prime' }], nextActions: [{ command: 'wm 夜灵p', label: '查整套价格' }] };

function payloadOf(prompt) {
  const marker = '[Warframe 短命令上下文] ';
  const start = prompt.indexOf(marker);
  assert.ok(start >= 0, '桥接上下文标记缺失');
  const payloadStart = start + marker.length;
  const end = prompt.indexOf('\n', payloadStart);
  assert.ok(end > payloadStart, '桥接上下文必须保持 [Warframe 短命令上下文] <json> 结构');
  return JSON.parse(prompt.slice(payloadStart, end));
}


test('bridge is isolated by caller key and contains only the safe envelope', () => {
  const bridge = createContextBridge();
  assert.equal(bridge.remember('group:a|sender:1', { ...sample, rawSnapshot: { secret: 1 } }), true);
  assert.equal(bridge.peek('group:a|sender:2').length, 0);
  const prompt = bridge.consumePrompt('group:a|sender:1');
  assert.match(prompt, /Revenant Prime/u);
  assert.doesNotMatch(prompt, /rawSnapshot|secret/u);
});

test('bridge expires after ttl or four model turns and failed results do not overwrite', () => {
  let clock = 1000;
  const bridge = createContextBridge({ now: () => clock });
  bridge.remember('k', sample);
  assert.equal(bridge.remember('k', { ok: false }), false);
  for (let index = 0; index < 4; index += 1) assert.match(bridge.consumePrompt('k'), /夜灵/u);
  assert.equal(bridge.consumePrompt('k'), '');
  bridge.remember('k', sample);
  clock += 15 * 60 * 1000 + 1;
  assert.equal(bridge.consumePrompt('k'), '');
});

test('群聊上下文按发送者隔离，同一发送者也按群隔离，用户私聊与群聊互不可见', () => {
  const bridge = createContextBridge();
  const personal = { ...sample, scope: 'personal', entities: [{ type: 'prime-set', displayName: '夜灵 Prime', canonicalName: 'Revenant Prime' }] };
  assert.equal(bridge.remember('qqbot:group:g1|sender:a', sample), true);
  assert.equal(bridge.remember('qqbot:group:g1|sender:b', personal), true);
  assert.equal(bridge.remember('qqbot:group:g2|sender:a', sample), true);
  assert.equal(bridge.remember('qqbot:c2c:owner|owner', personal), true);
  // 同群不同发送者互不可见
  assert.equal(bridge.peek('qqbot:group:g1|sender:a').length, 1);
  assert.equal(bridge.peek('qqbot:group:g1|sender:b').length, 1);
  assert.equal(bridge.peek('qqbot:group:g1|sender:c').length, 0);
  // 同一发送者在不同群互不可见
  assert.equal(bridge.peek('qqbot:group:g2|sender:a').length, 1);
  assert.equal(bridge.peek('qqbot:group:g1|sender:a').length, 1);
  // 用户私聊独立成键：群的 key 与私聊 key 不同，任何方向都不泄漏
  assert.equal(bridge.peek('qqbot:group:g1|owner').length, 0);
  assert.equal(bridge.peek('qqbot:group:g2|owner').length, 0);
  assert.equal(bridge.peek('qqbot:c2c:owner|owner').length, 1);
  // 个人域信封保留 scope 标记，插件据此只在用户私聊放行（见 index.ts rememberShortCommandContext）
  assert.equal(bridge.peek('qqbot:group:g1|sender:b')[0].scope, 'personal');
  assert.equal(bridge.peek('qqbot:c2c:owner|owner')[0].scope, 'personal');
});

test('TTL 边界：恰好到期即失效，重新写入后重新计时', () => {
  let clock = 0;
  const bridge = createContextBridge({ now: () => clock, ttlMs: 60_000 });
  bridge.remember('k', sample);
  clock = 59_999;
  assert.match(bridge.consumePrompt('k'), /夜灵/u);
  clock = 60_000;
  assert.equal(bridge.consumePrompt('k'), '');
  assert.equal(bridge.peek('k').length, 0);
  // 过期后重新写入可再次使用
  clock = 0;
  bridge.remember('k', sample);
  assert.match(bridge.consumePrompt('k'), /夜灵/u);
});

test('四轮模型轮次上限：新的成功写入重置轮次预算', () => {
  const bridge = createContextBridge();
  bridge.remember('k', sample);
  for (let index = 0; index < 4; index += 1) assert.match(bridge.consumePrompt('k'), /夜灵/u);
  assert.equal(bridge.consumePrompt('k'), '');
  bridge.remember('k', sample);
  assert.match(bridge.consumePrompt('k'), /夜灵/u);
});

test('失败或空结果不覆盖上一条有效上下文', () => {
  const bridge = createContextBridge();
  assert.equal(bridge.remember('k', sample), true);
  assert.equal(bridge.remember('k', { ok: false, error: 'boom' }), false);
  assert.equal(bridge.remember('k', { ok: true, kind: 'market' }), false);
  assert.equal(bridge.remember('k', { ok: true, entities: [], nextActions: [] }), false);
  assert.equal(bridge.remember('k', null), false);
  assert.equal(bridge.peek('k').length, 1);
  const prompt = bridge.consumePrompt('k');
  assert.match(prompt, /Revenant Prime/u);
  assert.doesNotMatch(prompt, /boom/u);
});

test('获取 X 的实体上下文可支撑「这个甲多少钱」追问，nextActions 与卡片同构', () => {
  const bridge = createContextBridge();
  const relicFarm = {
    ok: true, kind: 'relic-farm', query: '夜灵p', scope: 'public',
    summary: '已生成库存优先的遗物获取路线。',
    entities: [{ type: 'prime-set', displayName: '夜灵 Prime', canonicalName: 'Revenant Prime' }],
    nextActions: [
      { command: 'wm 夜灵 Prime 一套', label: '查看市场价格' },
      { command: '遗物 夜灵p', label: '查看相关遗物' },
    ],
    fetchedAt: '2026-08-21T00:00:00.000Z',
  };
  bridge.remember('qqbot:group:g|sender:1', relicFarm);
  const prompt = bridge.consumePrompt('qqbot:group:g|sender:1');
  // 实体规范名进入模型上下文，「这个甲多少钱」可据此拼出 wm Revenant Prime
  assert.match(prompt, /"canonicalName":"Revenant Prime"/u);
  // 与卡片提示同一结构 {command,label} 的 nextActions 原样进入上下文
  assert.match(prompt, /"command":"wm 夜灵 Prime 一套"/u);
  assert.match(prompt, /"label":"查看市场价格"/u);
  // 上下文只用于解析指代，实时价格必须重新走 warframe_assistant
  assert.match(prompt, /必须重新调用 warframe_assistant/u);
});

test('nextActions 消毒后与卡片渲染端同构：只保留 command+label，且截断到渲染上限两条', () => {
  const bridge = createContextBridge();
  const overflow = {
    ok: true, kind: 'where-to-buy', query: '诡文枭主', scope: 'public',
    summary: '找到 1 个商人货源。',
    entities: [{ type: 'shop-item', displayName: '诡文枭主', canonicalName: '诡文枭主' }],
    nextActions: [
      { command: 'wm 诡文枭主', label: '查看玩家市场' },
      { command: '商店 泰辛', label: '查看商人货单' },
      { command: 'extra', label: '不应上卡' },
    ],
    fetchedAt: '2026-08-21T00:00:00.000Z',
  };
  bridge.remember('k', overflow);
  const prompt = bridge.consumePrompt('k');
  assert.match(prompt, /"command":"wm 诡文枭主"/u);
  assert.match(prompt, /"label":"查看玩家市场"/u);
  assert.match(prompt, /"command":"商店 泰辛"/u);
  // 渲染端 renderNextActions 同样只画前两条 command，超出部分两侧一致丢弃
  assert.doesNotMatch(prompt, /"command":"extra"/u);
  assert.doesNotMatch(prompt, /"label":"不应上卡"/u);
});

test('R18：桥接载荷只允许白名单键，原始身份/target/sender/token/快照/工具结果不进入', () => {
  const bridge = createContextBridge();
  const hostile = {
    ok: true, kind: 'fissure', query: '九重天', scope: 'public',
    summary: '当前匹配 6 条裂缝。',
    entities: [{ type: 'fissure-query', displayName: '当前虚空裂缝', canonicalName: '九重天' }],
    nextActions: [{ command: '开遗物', label: '按库存推荐遗物' }],
    fetchedAt: '2026-09-09T00:00:00.000Z',
    rawSnapshot: { secret: 'RAW_SENTINEL' },
    target: 'qqbot:group:9999', senderId: 'SENDER_SENTINEL',
    token: 'TOKEN_SENTINEL', apiKey: 'KEY_SENTINEL',
    authorization: 'Bearer AUTH_SENTINEL', cookie: 'sid=COOKIE_SENTINEL',
    fullToolResult: { orders: [{ seller: 'SELLER_SENTINEL', platinum: 1 }] },
    ownerOpenId: 'OWNER_SENTINEL', conversationId: 'CONV_SENTINEL',
  };
  bridge.remember('k', hostile);
  const prompt = bridge.consumePrompt('k');
  for (const sentinel of ['RAW_SENTINEL', 'SENDER_SENTINEL', 'TOKEN_SENTINEL', 'KEY_SENTINEL',
    'AUTH_SENTINEL', 'COOKIE_SENTINEL', 'SELLER_SENTINEL', 'OWNER_SENTINEL', 'CONV_SENTINEL']) {
    assert.doesNotMatch(prompt, new RegExp(sentinel, 'u'), sentinel);
  }
  assert.doesNotMatch(prompt, /qqbot:group:9999/u);
  // 结构白名单：item 只有 kind/query/summary/entities/nextActions/fetchedAt(+stale)，
  // entity 只有 type/displayName/canonicalName，action 只有 command/label
  const payload = payloadOf(prompt);
  const itemKeys = new Set(['kind', 'query', 'summary', 'entities', 'nextActions', 'fetchedAt', 'stale']);
  const entityKeys = new Set(['type', 'displayName', 'canonicalName']);
  const actionKeys = new Set(['command', 'label']);
  for (const item of payload) {
    for (const key of Object.keys(item)) assert.ok(itemKeys.has(key), `unexpected item key: ${key}`);
    for (const entity of item.entities || []) {
      for (const key of Object.keys(entity)) assert.ok(entityKeys.has(key), `unexpected entity key: ${key}`);
    }
    for (const action of item.nextActions || []) {
      for (const key of Object.keys(action)) assert.ok(actionKeys.has(key), `unexpected action key: ${key}`);
    }
  }
});

test('R18：已过期实时事实不携带 summary，仅保留指代锚点并明确降级', () => {
  const clock = Date.parse('2026-09-09T12:00:00.000Z');
  const bridge = createContextBridge({ now: () => clock });
  const stale = {
    ok: true, kind: 'bounty', query: '尖刃弹头', scope: 'public',
    summary: '本轮在出：希图斯 赏金（5.68%）',
    entities: [{ type: 'bounty', displayName: '尖刃弹头', canonicalName: '尖刃弹头' }],
    nextActions: [],
    fetchedAt: '2026-09-09T11:50:00.000Z',
    expiry: '2026-09-09T11:59:59.000Z',
  };
  assert.equal(bridge.remember('k', stale), true);
  const prompt = bridge.consumePrompt('k');
  const payload = payloadOf(prompt);
  assert.equal(payload[0].stale, true);
  assert.equal('summary' in payload[0], false);
  assert.doesNotMatch(prompt, /本轮在出/u);
  assert.match(prompt, /其中标记为 stale 的条目仅为指代解析保留；其实时事实已过期，不得作为当前状态证据/u);
  // 指代锚点保留：仍可解析「刚才那个」
  assert.match(prompt, /尖刃弹头/u);
});

test('R18：未过期与无 expiry 条目不携带 stale 标记，也不出现降级句（既有语义兼容）', () => {
  const clock = Date.parse('2026-09-09T12:00:00.000Z');
  const bridge = createContextBridge({ now: () => clock });
  const fresh = {
    ...sample,
    summary: '当前匹配 6 条裂缝。',
    fetchedAt: '2026-09-09T11:50:00.000Z',
    expiry: '2026-09-09T12:30:00.000Z',
  };
  bridge.remember('a', fresh);
  bridge.remember('b', sample);
  const freshPayload = payloadOf(bridge.consumePrompt('a'));
  assert.equal('stale' in freshPayload[0], false);
  assert.equal(freshPayload[0].summary, '当前匹配 6 条裂缝。');
  const plainPayload = payloadOf(bridge.consumePrompt('b'));
  assert.equal('stale' in plainPayload[0], false);
  assert.equal(plainPayload[0].summary, '候选遗物均已入库');
  assert.doesNotMatch(bridge.consumePrompt('a'), /其实时事实已过期/u);
  assert.doesNotMatch(bridge.consumePrompt('b'), /其实时事实已过期/u);
});

test('R18：新鲜度边界与 evidence 语义一致（恰好到期即视为过期）', () => {
  const clock = Date.parse('2026-09-09T12:00:00.000Z');
  const bridge = createContextBridge({ now: () => clock });
  const atExpiry = {
    ...sample,
    fetchedAt: '2026-09-09T11:00:00.000Z',
    expiry: '2026-09-09T12:00:00.000Z',
  };
  bridge.remember('k', atExpiry);
  const payload = payloadOf(bridge.consumePrompt('k'));
  assert.equal(payload[0].stale, true);
  const evidence = buildEvidenceEnvelope(
    { ok: true, kind: 'bounty', facts: { fetchedAt: atExpiry.fetchedAt, expiry: atExpiry.expiry } },
    'command', '赏金 示例',
  );
  assert.equal(evidence.freshness, 'expired');
});

test('R18：体积裁剪时 canonicalName 缺失仍保留 displayName 指代锚点', () => {
  const bridge = createContextBridge();
  bridge.remember('k', {
    ok: true,
    kind: 'fissure',
    query: '九重天'.repeat(40),
    summary: '摘要'.repeat(120),
    entities: Array.from({ length: 3 }, (_, index) => ({
      type: 'fissure-query'.repeat(4),
      displayName: `显示锚点${index}`.repeat(20),
      canonicalName: '',
    })),
    nextActions: Array.from({ length: 2 }, (_, index) => ({
      command: `开遗物${index}`.repeat(20),
      label: `动作${index}`.repeat(20),
    })),
    fetchedAt: '2026-09-09T00:00:00.000Z',
  });
  const payload = payloadOf(bridge.consumePrompt('k'));
  assert.match(payload[0].entities[0].displayName, /显示锚点0/u);
});
