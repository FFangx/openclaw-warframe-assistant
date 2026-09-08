import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runShortcut } from './shortcuts.mjs';
import {
  createTraceStore,
  isRepresentativeChain,
  privacyScopeHash,
  sanitizeEnvelope,
  TRACE_ENVELOPE_FIELDS,
} from './trace.mjs';

const contentHash = 'a'.repeat(64);

function event(traceId, stage = 'received', overrides = {}) {
  return {
    traceId,
    triggerType: 'test',
    commandId: 'fissure',
    privacyScopeHash: privacyScopeHash('public'),
    stage,
    startedAt: new Date().toISOString(),
    durationMs: 1,
    source: 'test',
    freshness: 'local',
    resultCategory: 'ok',
    retryCount: 0,
    contentHash,
    ...overrides,
  };
}

test('trace envelope is a strict 12-field allowlist and rejects non-hash payloads', () => {
  const record = sanitizeEnvelope({
    ...event('trace-1'),
    target: 'qqbot:c2c:secret',
    senderId: 'secret-sender',
    query: 'raw user text',
    responseBody: 'secret body',
    stack: 'secret stack',
    contentHash: 'https://example.invalid/private',
    privacyScopeHash: 'not-a-hash',
  });
  assert.deepEqual(Object.keys(record), TRACE_ENVELOPE_FIELDS);
  assert.equal(record.contentHash, '');
  assert.equal(record.privacyScopeHash, '');
  const serialized = JSON.stringify(record);
  assert.doesNotMatch(serialized, /secret|raw user|example\.invalid/iu);
});

test('representative-chain gate is exact after command normalization', () => {
  assert.equal(isRepresentativeChain('/裂缝　九重天'), true);
  assert.equal(isRepresentativeChain('裂缝 九重天 速刷'), false);
  assert.equal(isRepresentativeChain('开遗物 九重天'), false);
});

test('trace store tolerates corruption, fails open, and enforces byte and trace bounds', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-trace-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'trace.jsonl');
  await writeFile(filePath, '{broken json\n', 'utf8');
  const store = createTraceStore({ filePath, maxBytes: 900, maxTraces: 2, maxStagesPerTrace: 2 });
  assert.deepEqual(await store.read(), []);
  for (let index = 0; index < 8; index += 1) {
    assert.equal(await store.append(event(`trace-${index}`, 'received')), true);
    assert.equal(await store.append(event(`trace-${index}`, 'route')), true);
    assert.equal(await store.append(event(`trace-${index}`, 'facts')), true);
  }
  const text = await readFile(filePath, 'utf8');
  assert.ok(Buffer.byteLength(text, 'utf8') <= 900);
  const records = await store.read();
  assert.ok(new Set(records.map((record) => record.traceId)).size <= 2);
  const counts = new Map();
  for (const record of records) counts.set(record.traceId, (counts.get(record.traceId) || 0) + 1);
  assert.ok([...counts.values()].every((count) => count <= 2));

  const impossible = createTraceStore({ filePath: dir });
  assert.equal(await impossible.append(event('fail-open')), false);
});

test('裂缝 九重天 emits facts/decision/render with one trace id and cache evidence', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-trace-chain-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'trace.jsonl');
  const traceId = 'representative-trace';
  const expiry = new Date(Date.now() + 60 * 60_000).toISOString();
  const result = await runShortcut('裂缝 九重天', {
    traceStore: filePath,
    traceId,
    traceTriggerType: 'qq-before-dispatch',
    worldState: {
      timestamp: new Date().toISOString(),
      _dataSource: 'api.warframe.com',
      _dataStale: true,
      _cachedAt: new Date().toISOString(),
      _envelope: { provider: 'api.warframe.com', contentHash },
      fissures: [{
        id: 'storm-1', tier: 'Axi', missionType: 'Skirmish', enemy: 'Corpus',
        node: 'Veil Node (Veil Proxima)', expiry, expired: false, isStorm: true,
      }],
    },
    renderCard: async () => 'synthetic-card.png',
  });
  assert.equal(result.ok, true);
  const records = await createTraceStore({ filePath }).read();
  assert.deepEqual(records.map((record) => record.stage), ['facts', 'decision', 'render']);
  assert.ok(records.every((record) => record.traceId === traceId));
  assert.ok(records.every((record) => record.privacyScopeHash === privacyScopeHash('public')));
  assert.equal(records.find((record) => record.stage === 'facts').freshness, 'stale-cache');
  assert.equal(records.find((record) => record.stage === 'facts').resultCategory, 'degraded');
  assert.equal(records.find((record) => record.stage === 'render').resultCategory, 'card-created');
});

test('render failure is traced and non-target commands never create a trace file', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-trace-render-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'trace.jsonl');
  const expiry = new Date(Date.now() + 60 * 60_000).toISOString();
  const worldState = {
    timestamp: new Date().toISOString(),
    _dataSource: 'api.warframe.com',
    fissures: [{
      id: 'storm-1', tier: 'Axi', missionType: 'Skirmish', enemy: 'Corpus',
      node: 'Veil Node (Veil Proxima)', expiry, expired: false, isStorm: true,
    }],
  };
  await runShortcut('裂缝 九重天', {
    traceStore: filePath,
    traceId: 'render-failure',
    worldState,
    renderCard: async () => { throw new Error('synthetic renderer failure'); },
  });
  const records = await createTraceStore({ filePath }).read();
  assert.equal(records.find((record) => record.stage === 'render').resultCategory, 'render-failed');

  const otherPath = path.join(dir, 'other.jsonl');
  await runShortcut('裂缝', {
    traceStore: otherPath,
    traceId: 'must-not-exist',
    worldState,
    renderCard: async () => 'synthetic-card.png',
  });
  assert.deepEqual(await createTraceStore({ filePath: otherPath }).read(), []);
});
