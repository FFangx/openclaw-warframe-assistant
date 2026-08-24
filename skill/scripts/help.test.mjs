import assert from 'node:assert/strict';
import test from 'node:test';

import { buildHelpCard, formatHelp } from './shortcuts.mjs';

test('帮助卡与文字帮助都说明愿望单入口及即时查价', () => {
  const card = buildHelpCard();
  const text = formatHelp();

  assert.equal(card.key, 'help-v25');
  assert.match(card.html, /愿望单 · 市场盯价/u);
  assert.match(card.html, /愿望 商品 价格/u);
  assert.match(card.html, /现有合价单立即出市场卡/u);
  assert.match(card.html, /愿望单 \/ 已购 W3K7/u);
  assert.match(text, /愿望单：愿望 商品 价格/u);
  assert.match(text, /改价\/暂停\/继续\/已购\/取消/u);
  assert.match(text, /之后秒级提醒/u);
});
