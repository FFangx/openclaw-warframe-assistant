import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  COMMAND_REGISTRY,
  buildHelpSections,
  buildTemplateCatalog,
  buildToolCommandSummary,
  isUserPrivateCommand,
  matchCommandText,
  matchSubscriptionCommand,
  matchWeeklyCommand,
  matchWishlistCommand,
  registryContractErrors,
} from './command-registry.mjs';

test('R1 注册表字段完整且 commandId 唯一', () => {
  assert.deepEqual(registryContractErrors(), []);
  assert.ok(COMMAND_REGISTRY.length >= 20);
  for (const entry of COMMAND_REGISTRY) {
    assert.match(entry.commandId, /^[a-z][a-z0-9-]+$/u);
    assert.equal(typeof entry.canonicalSyntax, 'string');
    assert.ok(Array.isArray(entry.aliases));
    assert.equal(typeof entry.privacyScope, 'string');
    assert.equal(typeof entry.fastPath, 'boolean');
    assert.equal(typeof entry.modelCallable, 'boolean');
    assert.equal(typeof entry.executor, 'string');
    assert.equal(typeof entry.helpTitle, 'string');
    assert.equal(typeof entry.helpSummary, 'string');
    assert.ok(Array.isArray(entry.helpExamples));
    assert.ok(Array.isArray(entry.nextActions));
  }
});

test('路由、帮助和工具目录都来自同一注册表', () => {
  const catalog = buildTemplateCatalog();
  assert.deepEqual(catalog.map((item) => item.commandId), COMMAND_REGISTRY.map((item) => item.commandId));
  const helpIds = buildHelpSections().flatMap(([, rows]) => rows.map((row) => row.commandId));
  for (const entry of COMMAND_REGISTRY.filter((item) => item.helpExamples.length > 0)) assert.ok(helpIds.includes(entry.commandId), entry.commandId);
  const summary = buildToolCommandSummary();
  for (const entry of COMMAND_REGISTRY.filter((item) => item.modelCallable && !item.guideOnly)) assert.match(summary, new RegExp(entry.canonicalSyntax.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
});

test('注册表匹配定义覆盖短命令、用户私聊、周常、订阅和愿望单入口', () => {
  assert.equal(matchCommandText('/wm 悟空p', 'shortcut-parser')?.commandId, 'market');
  assert.equal(matchCommandText('获取 夜灵 Prime 系统', 'shortcut-parser')?.query, '夜灵 Prime 系统');
  assert.equal(matchCommandText('裂缝推荐 钢铁', 'shortcut-parser')?.commandId, 'fissure');
  assert.equal(matchCommandText('钢铁裂缝 生存', 'shortcut-parser')?.query, '钢铁 生存');
  assert.equal(isUserPrivateCommand('我的库存 延几草'), true);
  assert.equal(isUserPrivateCommand('我有这些遗物吗'), false);
  assert.equal(matchCommandText('开遗物 钢铁', 'user-account')?.commandId, 'recommend');
  assert.equal(matchCommandText('精炼推荐', 'user-account')?.commandId, 'refine');
  assert.equal(matchCommandText('杜卡德 600', 'user-account')?.commandId, 'ducat-plan');
  assert.equal(matchCommandText('商店 泰辛', 'user-account')?.commandId, 'shop');
  assert.equal(matchCommandText('紫卡 3', 'user-account')?.commandId, 'rivens');
  assert.equal(Boolean(matchWeeklyCommand('完成 1 3')), true);
  assert.equal(Boolean(matchWishlistCommand('愿望 商品 20')), true);
  assert.equal(Boolean(matchSubscriptionCommand('订阅 赏金 尖刃弹头')), true);
});

test('dispatch 对周常执行第二层用户私聊门禁', async () => {
  const { dispatchCommand } = await import('./dispatch.mjs');
  const denied = await dispatchCommand('周常', { personalAllowed: false });
  assert.equal(denied.kind, 'weekly-denied');
  assert.equal(denied.ok, false);
  assert.match(denied.text, /用户本人/u);
});

test('用户可见产品文案不再使用旧身份称呼', async () => {
  const legacyTerm = String.fromCodePoint(0x4e3b, 0x4eba);
  const candidates = [
    new URL('../../README.md', import.meta.url),
    new URL('../../INSTALL.md', import.meta.url),
    new URL('../../CONFIG.md', import.meta.url),
    new URL('../../SECURITY.md', import.meta.url),
    new URL('../../CHANGELOG.md', import.meta.url),
    new URL('../SKILL.md', import.meta.url),
    new URL('../references/capabilities.md', import.meta.url),
    new URL('../../config/AGENTS.warframe.md', import.meta.url),
    new URL('../../extension/index.ts', import.meta.url),
    new URL('../../extension/openclaw.plugin.json', import.meta.url),
    new URL('../../../.openclaw/extensions/warframe-fast-commands/index.ts', import.meta.url),
    new URL('../../../.openclaw/extensions/warframe-fast-commands/openclaw.plugin.json', import.meta.url),
    new URL('./dispatch.mjs', import.meta.url),
    new URL('./shortcuts.mjs', import.meta.url),
  ];
  let checked = 0;
  for (const candidate of candidates) {
    try {
      const content = await readFile(candidate, 'utf8');
      checked += 1;
      assert.equal(content.includes(legacyTerm), false, candidate.pathname);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  assert.ok(checked >= 4);
});
