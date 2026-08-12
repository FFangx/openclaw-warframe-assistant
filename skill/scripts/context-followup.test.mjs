import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchCommand } from './dispatch.mjs';
import { parseAlecaMessage, splitInventoryQueryList } from './alecaframe.mjs';

test('带“这些遗物”的上下文追问不被当成字面库存命令', async () => {
  const result = await dispatchCommand('我有这些遗物吗', { personalAllowed: true });
  assert.equal(result.handled, false);
});

test('模型展开后的多枚遗物命令仍进入个人库存通道', async () => {
  const result = await dispatchCommand('我的遗物 后纪 A22 B7 B8 C8', { personalAllowed: false });
  assert.equal(result.handled, true);
  assert.equal(result.kind, 'personal-denied');
});

test('显式列举的多个普通物品保留为一次批量库存查询', () => {
  assert.deepEqual(splitInventoryQueryList('延凡草、瑶丛'), ['延凡草', '瑶丛']);
  assert.deepEqual(splitInventoryQueryList('延凡草 和 瑶丛'), ['延凡草', '瑶丛']);
  assert.deepEqual(splitInventoryQueryList('Wukong Prime'), ['Wukong Prime']);
  assert.deepEqual(parseAlecaMessage('我有多少延凡草、瑶丛'), { command: 'inventory', query: '延凡草、瑶丛' });
});
