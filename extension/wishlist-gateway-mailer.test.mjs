import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createGatewayWishlistMailer } from './wishlist-gateway-mailer.mjs';

const TARGET = 'qqbot:c2c:tester';
const COMMON = { cfg: { a: 1 }, mediaLocalRoots: ['C:\\cards'] };

function fakeAdapter(overrides = {}) {
  const adapter = {
    sendMedia: async (args) => ({ messageId: 'm-media', ...args }),
    sendText: async (args) => ({ messageId: 'm-text', ...args }),
  };
  return { ...adapter, ...overrides };
}

test('Gateway adapter mailer：媒体走 sendMedia（text 空）、文字走 sendText，服务端明确接受才算成功', async () => {
  const mediaCalls = [];
  const textCalls = [];
  const mailer = createGatewayWishlistMailer(fakeAdapter({
    sendMedia: async (args) => { mediaCalls.push(args); return { messageId: 'm-1' }; },
    sendText: async (args) => { textCalls.push(args); return { messageId: 'm-2' }; },
  }), TARGET, COMMON);

  const mediaResult = await mailer({ kind: 'media', value: 'C:\\cards\\hit.png' });
  assert.deepEqual(mediaResult, { ok: true, category: null });
  assert.deepEqual(mediaCalls[0], { ...COMMON, to: TARGET, text: '', mediaUrl: 'C:\\cards\\hit.png' });

  const textResult = await mailer({ kind: 'text', value: '愿望单命中 1 条新卖单。' });
  assert.deepEqual(textResult, { ok: true, category: null });
  assert.deepEqual(textCalls[0], { ...COMMON, to: TARGET, text: '愿望单命中 1 条新卖单。' });
});

test('Gateway adapter mailer：adapter 返回 error → provider_rejected；抛异常 → adapter_exception（不保存原始异常）', async () => {
  const mailer = createGatewayWishlistMailer(fakeAdapter({
    sendMedia: async () => ({ error: 'rate limited', messageId: undefined }),
    sendText: async () => { throw new Error('socket hang up'); },
  }), TARGET, COMMON);
  assert.deepEqual(await mailer({ kind: 'media', value: 'a.png' }), { ok: false, category: 'provider_rejected' });
  assert.deepEqual(await mailer({ kind: 'text', value: 'x' }), { ok: false, category: 'adapter_exception' });
});

test('Gateway adapter mailer：没有 messageId 不得误报成功', async () => {
  const mailer = createGatewayWishlistMailer(fakeAdapter({
    sendMedia: async () => ({ ok: true }),
    sendText: async () => undefined,
  }), TARGET, COMMON);
  assert.deepEqual(await mailer({ kind: 'media', value: 'a.png' }), { ok: false, category: 'missing_message_id' });
  assert.deepEqual(await mailer({ kind: 'text', value: 'x' }), { ok: false, category: 'missing_message_id' });
});

test('Gateway adapter mailer：缺配套方法或缺 target → 固定类别，不抛裸异常', async () => {
  const noMedia = createGatewayWishlistMailer(fakeAdapter({ sendMedia: undefined }), TARGET, COMMON);
  assert.deepEqual(await noMedia({ kind: 'media', value: 'a.png' }), { ok: false, category: 'adapter_unsupported' });
  const noText = createGatewayWishlistMailer(fakeAdapter({ sendText: undefined }), TARGET, COMMON);
  assert.deepEqual(await noText({ kind: 'text', value: 'x' }), { ok: false, category: 'adapter_unsupported' });
  const noTarget = createGatewayWishlistMailer(fakeAdapter({}), '', COMMON);
  assert.deepEqual(await noTarget({ kind: 'text', value: 'x' }), { ok: false, category: 'missing_target' });
  const missing = createGatewayWishlistMailer(null, TARGET, COMMON);
  assert.deepEqual(await missing({ kind: 'text', value: 'x' }), { ok: false, category: 'adapter_unsupported' });
});

test('index.ts 合同：愿望命中 Outbox 注入与恢复（服务端类别、锁外逐 part、启动恢复）', async () => {
  const entry = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  assert.match(entry, /import \{ createGatewayWishlistMailer \} from '\.\/wishlist-gateway-mailer\.mjs'/u);
  assert.match(entry, /wishlistOutboxPath = path\.resolve\(path\.dirname\(wishlistState\), 'warframe-delivery-outbox\.json'\)/u);
  assert.match(entry, /createOutbox\(\{ filePath: wishlistOutboxPath \}\)/u);
  // live order 路径必须注入 Outbox，账本提交后由注入 mailer 逐 part 持久化（keyPrefix 只投本链）
  assert.match(entry, /processWishlistLiveOrder\(order, wishlistState, subscriptionCardDir, \{ outbox \}\)/u);
  assert.match(entry, /await flushWishlistTargetPending\(api, String\(result\.target\)\)/u);
  assert.match(entry, /deliverPending\(\{ target, mailer, keyPrefix: 'wishlist:' \}\)/u);
  // 启动时先恢复相关 target pending（在 refresh/连 socket 之前）
  assert.match(entry, /await restoreWishlistPending\(api\);/u);
  const startBlock = entry.slice(entry.indexOf('async function startWishlistGateway'), entry.indexOf('async function stopWishlistGateway'));
  assert.ok(startBlock.indexOf('restoreWishlistPending(api)') < startBlock.indexOf('await refresh();'), '恢复必须在连接前');
  // 裸循环发送只允许留在交互 follow-up（建立后立即行情卡）路径，live order 路径不得使用
  const liveBlock = entry.slice(entry.indexOf('processWishlistLiveOrder(order'), entry.indexOf('Warframe wishlist live order failed'));
  assert.equal(liveBlock.includes('sendWishlistGatewayResult'), false);
  assert.match(entry, /for \(const delivery of deliveries\) await sendWishlistGatewayResult\(api, delivery\)/u);
  assert.equal(entry.includes('for ${target}'), false, '日志不得包含原始 QQ target');
  assert.equal(liveBlock.includes('result?.target ||'), false, 'live 异常日志不得拼接原始 QQ target');
});
