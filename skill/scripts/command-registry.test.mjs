import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  COMMAND_REGISTRY,
  HELP_SECTION_REGISTRY,
  buildHelpSections,
  buildTemplateCatalog,
  buildToolCommandSummary,
  isUserPrivateCommand,
  matchCommandText,
  matchSubscriptionCommand,
  matchWeeklyCommand,
  matchWishlistCommand,
  resolveHelpTopic,
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
  const helpIds = buildHelpSections({ featuredOnly: false }).flatMap(({ commands }) => commands.map((row) => row.commandId));
  for (const entry of COMMAND_REGISTRY.filter((item) => item.helpExamples.length > 0)) assert.ok(helpIds.includes(entry.commandId), entry.commandId);
  const summary = buildToolCommandSummary();
  for (const entry of COMMAND_REGISTRY.filter((item) => item.modelCallable && !item.guideOnly)) assert.match(summary, new RegExp(entry.canonicalSyntax.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
});

test('帮助分区 schema、别名和 featured 命令主帮助覆盖合同', () => {
  assert.ok(HELP_SECTION_REGISTRY.length >= 5);
  const sectionIds = new Set(HELP_SECTION_REGISTRY.map((section) => section.id));
  assert.equal(sectionIds.size, HELP_SECTION_REGISTRY.length);
  const sectionTopics = new Set();
  for (const section of HELP_SECTION_REGISTRY) {
    assert.match(section.id, /^[a-z][a-z0-9-]+$/u);
    assert.equal(typeof section.title, 'string');
    assert.ok(Array.isArray(section.aliases));
    assert.ok(section.aliases.length > 0);
    for (const topic of [section.id, section.title, ...section.aliases]) {
      const normalized = String(topic).normalize('NFKC').trim();
      assert.ok(normalized);
      assert.ok(!sectionTopics.has(normalized), `duplicate section topic: ${normalized}`);
      sectionTopics.add(normalized);
    }
    assert.equal(typeof section.order, 'number');
    assert.ok(COMMAND_REGISTRY.some((entry) => entry.helpSectionId === section.id), section.id);
  }
  for (const entry of COMMAND_REGISTRY) {
    assert.equal(typeof entry.featured, 'boolean', entry.commandId);
    const aliases = entry.aliases.map((alias) => String(alias).normalize('NFKC').trim());
    assert.ok(aliases.every(Boolean), entry.commandId);
    assert.equal(new Set(aliases).size, aliases.length, `duplicate command alias: ${entry.commandId}`);
  }
  const allRows = buildHelpSections({ featuredOnly: false }).flatMap(({ commands }) => commands);
  assert.deepEqual(new Set(allRows.map((row) => row.commandId)), new Set(COMMAND_REGISTRY.map((entry) => entry.commandId)));
  const featuredRows = buildHelpSections().flatMap(({ commands }) => commands);
  assert.equal(featuredRows.length, new Set(featuredRows.map((row) => row.commandId)).size);
  assert.ok(featuredRows.some((row) => row.commandId === 'help'));
  assert.ok(featuredRows.some((row) => row.commandId === 'market'));
  assert.ok(!featuredRows.some((row) => row.commandId === 'account'));
  assert.ok(!featuredRows.some((row) => row.commandId === 'subscription'));
  assert.ok(featuredRows.every((row) => COMMAND_REGISTRY.find((entry) => entry.commandId === row.commandId)?.featured));
});

test('帮助主题按分区优先、命令别名次之，未知主题确定性拒绝', () => {
  assert.deepEqual(resolveHelpTopic('世界状态'), { kind: 'section', sectionId: 'worldstate', commandId: null, text: '世界状态' });
  assert.deepEqual(resolveHelpTopic('基础'), { kind: 'section', sectionId: 'basics', commandId: null, text: '基础' });
  assert.deepEqual(resolveHelpTopic('裂缝'), { kind: 'section', sectionId: 'relics', commandId: null, text: '裂缝' });
  assert.deepEqual(resolveHelpTopic('奸商'), { kind: 'command', sectionId: 'shop', commandId: 'trader-shopping', text: '奸商' });
  assert.deepEqual(resolveHelpTopic('wm'), { kind: 'command', sectionId: 'market', commandId: 'market', text: 'wm' });
  assert.equal(resolveHelpTopic('不存在的主题'), null);
});

test('注册表匹配定义覆盖短命令、用户私聊、周常、订阅和愿望单入口', () => {
  assert.equal(matchCommandText('/wm 悟空p', 'shortcut-parser')?.commandId, 'market');
  assert.equal(matchCommandText('帮助 世界状态', 'shortcut-parser')?.commandId, 'help');
  assert.equal(matchCommandText('帮助 世界状态', 'shortcut-parser')?.query, '世界状态');
  assert.equal(matchCommandText('帮助不存在', 'shortcut-parser'), null);
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
