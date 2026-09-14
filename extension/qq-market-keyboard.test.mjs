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
    ['走势 悟空 Prime 一套'],
  ]);
  assert.equal(keyboard.content.rows[0].buttons[0].render_data.style, 1);
  assert.equal(keyboard.content.rows[1].buttons[0].render_data.style, 1);
  assert.equal(keyboard.content.rows[0].buttons[0].action.data, '/w Two second');
  assert.equal(keyboard.content.rows[0].buttons[0].action.enter, false);
  assert.equal(keyboard.content.rows[1].buttons[0].action.data, 'wm 悟空p 走势');
  assert.equal(keyboard.content.rows[1].buttons[0].action.enter, true);
});

test('registered trend action uses a callback without sending a user command', async () => {
  const sent = [];
  await sendMarketKeyboard({
    data: quote, accountId: 'default', target: 'qqbot:c2c:user-a',
    cfg: { channels: { qqbot: { appId: 'app', clientSecret: 'secret' } } },
    loadSender: async () => ({
      version: 'test',
      getMessageApi: () => ({ sendMessage: async (...args) => { sent.push(args); return { id: 'm1' }; } }),
    }),
  });
  const trend = sent[0][4].inlineKeyboard.content.rows.at(-1).buttons[0];
  assert.equal(trend.action.type, 1);
  assert.equal(trend.action.enter, undefined);
  assert.equal(trend.action.click_limit, undefined);
  assert.equal(trend.render_data.visited_label, trend.render_data.label);
  assert.match(trend.action.data, /^wftrend:v1:/u);
  assert.equal(trend.action.data.includes('wm '), false);
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
  const callbackData = observed[4].inlineKeyboard.content.rows.at(-1).buttons[0].action.data;
  assert.deepEqual(observed[4].inlineKeyboard, buildMarketKeyboard(quote, { trendCallbackData: callbackData }));
});

test('combined market reply sends an ephemeral Markdown image, seller text and keyboard in one payload', async () => {
  const requests = [];
  const messageApi = {
    tokenManager: { getAccessToken: async () => 'token' },
    client: {
      request: async (...args) => {
        requests.push(args);
        return { id: 'combined-1' };
      },
    },
  };
  const result = await sendMarketKeyboard({
    data: quote,
    target: 'qqbot:c2c:opaque-user',
    replyToId: 'message-1',
    content: quote.contactTemplates[0],
    mediaUrl: new URL(import.meta.url),
    uploadImage: async () => ({ url: 'https://private.example/image.png?signature=temporary', ttlSeconds: 900 }),
    cfg: { channels: { qqbot: { appId: 'app', clientSecret: 'secret' } } },
    loadSender: async () => ({ version: 'test', getMessageApi: () => messageApi }),
  });
  assert.equal(result.messageId, 'combined-1');
  assert.equal(requests.length, 1);
  assert.equal(requests[0][2], '/v2/users/opaque-user/messages');
  assert.equal(requests[0][3].msg_type, 2);
  assert.match(requests[0][3].markdown.content, /^!\[Warframe Market\]\(https:\/\/private\.example\/image\.png\?signature=temporary\)/u);
  assert.match(requests[0][3].markdown.content, /\/w One first$/u);
  assert.equal(requests[0][3].msg_id, 'message-1');
  const callbackData = requests[0][3].keyboard.content.rows.at(-1).buttons[0].action.data;
  assert.deepEqual(requests[0][3].keyboard, buildMarketKeyboard(quote, { trendCallbackData: callbackData }));
});
