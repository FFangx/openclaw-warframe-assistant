import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMarketKeyboard, sendMarketKeyboard } from './qq-market-keyboard.mjs';

const quote = {
  ok: true,
  kind: 'market',
  viewMode: 'quote',
  marketQuery: '悟空p',
  item: { name: 'Wukong Prime Set', zhName: '悟空 Prime 一套' },
  contactTemplates: ['/w One first', '/w Two second', '/w Three third'],
};

test('three sellers produce only seller 2, seller 3 and trend actions', () => {
  const keyboard = buildMarketKeyboard(quote);
  assert.deepEqual(keyboard.content.rows.map((row) => row.buttons.map((button) => button.render_data.label)), [
    ['2号卖家', '3号卖家'],
    ['走势 悟空 Pri…'],
  ]);
  assert.equal(keyboard.content.rows[0].buttons[0].action.data, '/w Two second');
  assert.equal(keyboard.content.rows[0].buttons[0].action.enter, false);
  assert.equal(keyboard.content.rows[1].buttons[0].action.data, 'wm 悟空p 走势');
  assert.equal(keyboard.content.rows[1].buttons[0].action.enter, true);
});

test('trend response and group targets do not emit another keyboard', async () => {
  assert.equal(buildMarketKeyboard({ ...quote, viewMode: 'trend' }), null);
  const result = await sendMarketKeyboard({
    data: quote,
    target: 'qqbot:group:anything',
    cfg: {},
  });
  assert.deepEqual(result, { sent: false, reason: 'not-c2c' });
});

test('native QQ sender receives a passive c2c message with inline keyboard', async () => {
  let observed;
  const result = await sendMarketKeyboard({
    data: quote,
    target: 'qqbot:c2c:opaque-user',
    replyToId: 'message-1',
    cfg: { channels: { qqbot: { appId: 'app', clientSecret: 'secret' } } },
    loadSender: async () => ({
      version: 'test',
      getMessageApi: () => ({
        sendMessage: async (...args) => {
          observed = args;
          return { id: 'sent-1' };
        },
      }),
    }),
  });
  assert.equal(result.sent, true);
  assert.equal(observed[0], 'c2c');
  assert.equal(observed[1], 'opaque-user');
  assert.equal(observed[4].msgId, 'message-1');
  assert.deepEqual(observed[4].inlineKeyboard, buildMarketKeyboard(quote));
});
