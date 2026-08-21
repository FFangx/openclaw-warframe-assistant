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

