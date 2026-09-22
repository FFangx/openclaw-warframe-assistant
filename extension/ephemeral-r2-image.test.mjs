import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { EPHEMERAL_R2_LIMITS, uploadEphemeralR2Image } from './ephemeral-r2-image.mjs';

const env = {
  WARFRAME_R2_ACCOUNT_ID: 'account123',
  WARFRAME_R2_BUCKET: 'warframe-images',
  WARFRAME_R2_ACCESS_KEY_ID: 'access-key',
  WARFRAME_R2_SECRET_ACCESS_KEY: 'secret-key',
  WARFRAME_R2_URL_TTL_SECONDS: '900',
};

test('uploads a PNG with SigV4 and returns a 15-minute signed GET URL', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'warframe-r2-test-'));
  let request;
  try {
    const usagePath = path.join(tempDir, 'usage.json');
    const result = await uploadEphemeralR2Image(new URL(import.meta.url), {
      env,
      usagePath,
      now: new Date('2026-09-14T20:00:00.000Z'),
      fetchImpl: async (...args) => {
        request = args;
        return { ok: true, status: 200 };
      },
    });

    assert.match(request[0], /^https:\/\/account123\.r2\.cloudflarestorage\.com\/warframe-images\/wm\/20260914\/[a-f0-9]{64}\.png$/u);
    assert.equal(request[1].method, 'PUT');
    assert.equal(request[1].headers['content-type'], 'image/png');
    assert.match(request[1].headers.authorization, /^AWS4-HMAC-SHA256 Credential=access-key\/20260914\/auto\/s3\/aws4_request,/u);
    assert.equal(result.ttlSeconds, 900);
    const signed = new URL(result.url);
    assert.equal(signed.searchParams.get('X-Amz-Expires'), '900');
    assert.equal(signed.searchParams.get('X-Amz-Credential'), 'access-key/20260914/auto/s3/aws4_request');
    assert.match(signed.searchParams.get('X-Amz-Signature'), /^[a-f0-9]{64}$/u);
    const usage = JSON.parse(await readFile(usagePath, 'utf8'));
    assert.equal(usage.entries.length, 1);
    assert.ok(usage.entries[0].bytes > 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('image URLs default to one day and cannot outlive the bucket retention', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'warframe-r2-ttl-test-'));
  try {
    for (const ttl of [undefined, '604800']) {
      const source = { ...env };
      if (ttl === undefined) delete source.WARFRAME_R2_URL_TTL_SECONDS;
      else source.WARFRAME_R2_URL_TTL_SECONDS = ttl;
      const result = await uploadEphemeralR2Image(new URL(import.meta.url), {
        env: source, usagePath: path.join(tempDir, `usage-${ttl || 'default'}.json`),
        now: new Date('2026-09-18T20:00:00.000Z'), fetchImpl: async () => ({ ok: true, status: 200 }),
      });
      assert.equal(result.ttlSeconds, 86400);
      assert.equal(new URL(result.url).searchParams.get('X-Amz-Expires'), '86400');
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('requires a complete private R2 configuration', async () => {
  await assert.rejects(
    uploadEphemeralR2Image(new URL(import.meta.url), { env: {}, fetchImpl: async () => ({ ok: true }) }),
    /not configured/u,
  );
});

test('fails closed before upload when the rolling local quota is exhausted', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'warframe-r2-quota-test-'));
  try {
    const usagePath = path.join(tempDir, 'usage.json');
    const now = new Date('2026-09-15T10:00:00.000Z');
    await writeFile(usagePath, JSON.stringify({
      schemaVersion: 1,
      entries: Array.from({ length: EPHEMERAL_R2_LIMITS.maxUploadsPerWindow }, () => ({
        at: now.getTime() - 1000,
        bytes: 1,
      })),
    }));
    let uploadCalled = false;
    await assert.rejects(
      uploadEphemeralR2Image(new URL(import.meta.url), {
        env,
        usagePath,
        now,
        fetchImpl: async () => {
          uploadCalled = true;
          return { ok: true };
        },
      }),
      /rolling quota reached/u,
    );
    assert.equal(uploadCalled, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
