import assert from 'node:assert/strict';
import test from 'node:test';
import { createContextBridge } from './context-bridge.mjs';

const sample = { ok: true, kind: 'relic-farm', query: '夜灵p', summary: '候选遗物均已入库', entities: [{ type: 'prime-set', displayName: '夜灵 Prime', canonicalName: 'Revenant Prime' }], nextActions: [{ command: 'wm 夜灵p', label: '查整套价格' }] };

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
