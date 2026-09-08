import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  authorizationResultCategory,
  createQqTraceContext,
  deliveryResultCategory,
  isTraceTarget,
  recordQqTraceStage,
  traceModule,
} from './trace-bridge.mjs';

test('QQ trace bridge uses the exact representative gate and classifies delivery truthfully', async () => {
  assert.equal(await isTraceTarget('裂缝 九重天'), true);
  assert.equal(await isTraceTarget('裂缝 九重天 速刷'), false);
  assert.equal(authorizationResultCategory(false, true), 'allowed-public');
  assert.equal(authorizationResultCategory(true, false), 'allowed-personal-enhancement');
  assert.equal(deliveryResultCategory({ messageId: 'accepted' }), 'accepted');
  assert.equal(deliveryResultCategory({ error: 'server rejected' }), 'rejected');
  assert.equal(deliveryResultCategory(null, false), 'adapter-unavailable');
});

test('one QQ trace id can answer all seven stages including server rejection', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-qq-trace-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storePath = path.join(dir, 'trace.jsonl');
  const ctx = await createQqTraceContext({ storePath, triggerType: 'qq-before-dispatch' });
  const common = {
    startedAt: new Date().toISOString(), durationMs: 0, freshness: 'local',
    retryCount: 0, contentHash: '', scope: 'public',
  };
  for (const stage of ['received', 'route', 'authorization', 'facts', 'decision', 'render']) {
    assert.equal(await recordQqTraceStage(ctx, {
      ...common, stage, source: 'synthetic', resultCategory: stage === 'render' ? 'card-created' : 'ok',
    }), true);
  }
  assert.equal(await recordQqTraceStage(ctx, {
    ...common, stage: 'delivery', source: 'qqbot-adapter', resultCategory: deliveryResultCategory({ error: 'rejected' }),
  }), true);
  const module = await traceModule();
  const records = await module.createTraceStore({ filePath: storePath }).read();
  assert.deepEqual(records.map((record) => record.stage), [
    'received', 'route', 'authorization', 'facts', 'decision', 'render', 'delivery',
  ]);
  assert.ok(records.every((record) => record.traceId === ctx.traceId));
  assert.equal(records.at(-1).resultCategory, 'rejected');
});

test('QQ bridge recording is fail-open', async () => {
  const ctx = await createQqTraceContext({ storePath: process.cwd(), triggerType: 'qq-before-dispatch' });
  assert.equal(await recordQqTraceStage(ctx, {
    stage: 'received', startedAt: new Date().toISOString(), source: 'qq-channel',
    freshness: 'local', resultCategory: 'received', scope: 'public',
  }), false);
});

test('plugin wiring traces only authoritative before_dispatch and carries delivery context', async () => {
  const entry = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  assert.match(entry, /handleFastCommand\(api, \{[\s\S]*?\.\.\.ingressEvent,[\s\S]*?\}, 'qq-before-dispatch'\)/u);
  assert.match(entry, /\[QQ_REPLY_TRACE\]: trace/u);
  assert.match(entry, /WARFRAME_TRACE_STORE:[\s\S]*?WARFRAME_TRACE_ID:[\s\S]*?WARFRAME_TRACE_TRIGGER:/u);
  assert.match(entry, /stage: 'received'[\s\S]*?stage: 'route'[\s\S]*?stage: 'authorization'/u);
  assert.match(entry, /stage: 'delivery'[\s\S]*?resultCategory: category/u);
  assert.doesNotMatch(entry, /handleFastCommand\(api, event, 'qq-/u);
});
