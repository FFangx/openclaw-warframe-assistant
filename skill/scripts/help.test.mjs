import assert from 'node:assert/strict';
import test from 'node:test';

import { buildHelpCard, formatHelp, parseShortcutMessage, runShortcut } from './shortcuts.mjs';
import { HELP_SECTION_REGISTRY, resolveHelpTopic } from './command-registry.mjs';

test('主帮助完整显示全部模块，模块帮助显示全部相关命令', () => {
  const main = buildHelpCard();
  const worldstate = buildHelpCard(resolveHelpTopic('世界状态'));
  const text = formatHelp();

  assert.match(main.key, /^help-[0-9a-f]{12}$/u);
  for (const entry of ['帮助 基础', '帮助 查价', '帮助 遗物', '帮助 世界状态', '帮助 周常', '帮助 商店', '帮助 账号', '帮助 订阅', '帮助 愿望单']) {
    assert.match(main.html, new RegExp(entry, 'u'));
  }
  assert.match(main.html, /订阅提醒/u);
  assert.match(main.html, /愿望单 · 市场盯价/u);
  assert.doesNotMatch(main.html, /wm 悟空p/u);
  assert.match(worldstate.html, /<td colspan="2">世界状态<\/td>/u);
  assert.doesNotMatch(worldstate.html, /<td colspan="2">商店<\/td>/u);
  assert.notEqual(main.key, worldstate.key);
  assert.match(text, /订阅提醒：帮助 订阅/u);
  assert.match(text, /愿望单 · 市场盯价：帮助 愿望单/u);
  assert.match(text, /进入模块后会显示该模块的全部相关指令/u);
  assert.match(worldstate.html, /模块帮助 · 世界状态/u);
});

test('命令别名只跳转模块，未知主题确定性提示', async () => {
  assert.deepEqual(parseShortcutMessage('帮助 世界状态')?.query, '世界状态');
  assert.deepEqual(parseShortcutMessage('帮助 wm')?.query, 'wm');
  const marketText = formatHelp(resolveHelpTopic('wm'));
  const marketCard = buildHelpCard(resolveHelpTopic('wm'));
  assert.match(marketText, /wm 悟空p/u);
  assert.match(marketCard.html, /模块帮助 · 查价 · warframe\.market/u);
  assert.doesNotMatch(marketCard.html, /命令帮助/u);
  const denied = await runShortcut('帮助 不存在的主题');
  assert.equal(denied.handled, true);
  assert.equal(denied.ok, false);
  assert.equal(denied.mediaUrl, null);
  assert.match(denied.text, /可用模块/u);
  assert.match(denied.text, /帮助 世界状态/u);
  assert.match(denied.text, /帮助 订阅/u);
});

test('愿望单帮助入口仍由注册表生成', () => {
  const card = buildHelpCard(resolveHelpTopic('愿望单'));
  const text = formatHelp(resolveHelpTopic('愿望单'));
  assert.match(card.html, /愿望单 · 市场盯价/u);
  assert.match(card.html, /愿望 商品 价格/u);
  assert.match(card.html, /已有合价单时立即返回行情/u);
  assert.match(card.html, /已购\/取消 &lt;短编号&gt;/u);
  assert.match(text, /愿望 商品 价格：建立目标价/u);
  assert.match(text, /愿望单：查看全部愿望/u);
  assert.match(text, /改价\/暂停\/继续 <短编号>：调整目标价/u);
  assert.match(text, /已购\/取消 <短编号>：标记已购或删除愿望/u);
});

test('订阅模块逐项说明全部订阅类型与管理指令', () => {
  const card = buildHelpCard(resolveHelpTopic('订阅'));
  const text = formatHelp(resolveHelpTopic('订阅'));
  for (const expected of [
    '订阅 裂缝 [筛选]', '订阅 仲裁 [任务词]', '订阅 警报/入侵/活动 [词]',
    '订阅 突击/钢铁侵袭 [词]', '订阅 赏金 &lt;物品|任务词&gt;',
    '订阅 虚空商人/重要情报', '订阅 轮换/复刻 &lt;名称&gt;', '订阅 周常',
    '订阅 商店 [泰辛|圣言者]', '订阅 商品 &lt;物品&gt;', '订阅 掉落 [全部|物品]',
    '我的订阅', '暂停/恢复/取消订阅 &lt;编号|全部&gt;',
  ]) assert.match(card.html, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.match(text, /赏金轮换命中目标时推送/u);
  assert.match(text, /编号以“我的订阅”当前列表为准/u);
  assert.equal((card.html.match(/14 类事件、商品上架和轮换提醒/gu) || []).length, 0);
});

test('全部帮助模块都能生成详细卡片和文字说明', () => {
  for (const section of HELP_SECTION_REGISTRY) {
    const topic = resolveHelpTopic(section.helpQuery);
    const card = buildHelpCard(topic);
    const text = formatHelp(topic);
    assert.match(card.html, /模块帮助/u, section.id);
    assert.ok(card.height > 190, section.id);
    assert.match(text, /^【模块帮助/u, section.id);
  }
});
