import assert from 'node:assert/strict';
import test from 'node:test';

import { buildHelpCard, formatHelp, parseShortcutMessage, runShortcut } from './shortcuts.mjs';
import { resolveHelpTopic } from './command-registry.mjs';

test('主帮助只显示 featured 高频命令，分区帮助显示完整命令', () => {
  const main = buildHelpCard();
  const worldstate = buildHelpCard(resolveHelpTopic('世界状态'));
  const text = formatHelp();

  assert.match(main.key, /^help-[0-9a-f]{12}$/u);
  assert.match(main.html, /基础使用/u);
  assert.doesNotMatch(main.html, /愿望单 · 市场盯价/u);
  assert.doesNotMatch(main.html, /<td colspan="2">我的账号<\/td>/u);
  assert.match(worldstate.html, /<td colspan="2">世界状态<\/td>/u);
  assert.doesNotMatch(worldstate.html, /<td colspan="2">商店<\/td>/u);
  assert.notEqual(main.key, worldstate.key);
  assert.match(text, /可用分区/u);
  assert.doesNotMatch(text, /之后秒级提醒/u);
  assert.match(worldstate.html, /分区帮助 · 世界状态/u);
});

test('帮助主题支持分区、命令别名和未知主题确定性提示', async () => {
  assert.deepEqual(parseShortcutMessage('帮助 世界状态')?.query, '世界状态');
  assert.deepEqual(parseShortcutMessage('帮助 wm')?.query, 'wm');
  const commandText = formatHelp(resolveHelpTopic('wm'));
  const commandCard = buildHelpCard(resolveHelpTopic('wm'));
  assert.match(commandText, /查价/u);
  assert.match(commandText, /wm 悟空p/u);
  assert.match(commandCard.html, /命令帮助 · 查价/u);
  const denied = await runShortcut('帮助 不存在的主题');
  assert.equal(denied.handled, true);
  assert.equal(denied.ok, false);
  assert.equal(denied.mediaUrl, null);
  assert.match(denied.text, /可用分区/u);
  assert.match(denied.text, /世界状态/u);
});

test('愿望单帮助入口仍由注册表生成', () => {
  const card = buildHelpCard(resolveHelpTopic('愿望单'));
  const text = formatHelp(resolveHelpTopic('愿望单'));
  assert.match(card.html, /愿望单 · 市场盯价/u);
  assert.match(card.html, /愿望 商品 价格/u);
  assert.match(card.html, /现有合价单立即出市场卡/u);
  assert.match(card.html, /愿望单 \/ 已购 W3K7/u);
  assert.match(text, /愿望单：愿望 商品 价格/u);
  assert.match(text, /改价\/暂停\/继续\/已购\/取消/u);
  assert.match(text, /之后秒级提醒/u);
});
