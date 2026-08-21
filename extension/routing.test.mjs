import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isShortcut, isSubscriptionCommand } from './routing.mjs';

test('plugin entry imports every routing helper it calls', async () => {
  const [entry, routing] = await Promise.all([
    readFile(new URL('./index.ts', import.meta.url), 'utf8'),
    readFile(new URL('./routing.mjs', import.meta.url), 'utf8'),
  ]);
  const importClause = entry.match(/import\s*\{([^}]+)\}\s*from\s*['"]\.\/routing\.mjs['"]/u)?.[1] || '';
  const imported = new Set(importClause.split(',').map((name) => name.trim()).filter(Boolean));
  const exportedHelpers = [...routing.matchAll(/export\s+function\s+(\w+)\s*\(/gu)].map((match) => match[1]);
  const missing = exportedHelpers.filter((name) => new RegExp(`\\b${name}\\s*\\(`, 'u').test(entry) && !imported.has(name));
  assert.deepEqual(missing, []);
});

test('strict documented commands stay on the deterministic fast path', () => {
  for (const input of [
    'wm 高压电流', '遗物 Axi A22', '哪里刷 Caliban p', 'Caliban p哪里刷', '普通裂缝', '赏金 尖刃弹头', '哪里买 诡文枭主',
    '我的库存 延几草', '我的遗物 A22', '我的紫卡 伯斯顿', '周报', '完成 深层科研',
    '仲裁', '警报', '入侵', '活动', '虚空商人', '突击', '钢铁侵袭',
  ]) assert.equal(isShortcut(input), true, input);
  assert.equal(isSubscriptionCommand('订阅 赏金 尖刃弹头'), true);
});

test('natural language and contextual follow-ups reach the model tool router', () => {
  for (const input of [
    '我有多少延几草、瑶丛',
    '我有这些遗物吗',
    '毒囊双枪灵化需要什么材料，去哪里拿',
    '诡文枭主在哪里买',
    '这周还有哪些没做',
    '帮我订阅一下尖刃弹头赏金',
    '奸商这周有什么值得买的',
    '现在有什么好裂缝，按我的库存推荐一下',
  ]) {
    assert.equal(isShortcut(input), false, input);
    assert.equal(isSubscriptionCommand(input), false, input);
  }
});
