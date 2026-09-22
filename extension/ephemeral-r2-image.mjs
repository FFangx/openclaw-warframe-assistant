import { createHash, createHmac, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
const QUOTA_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const EPHEMERAL_R2_LIMITS = Object.freeze({
  maxImageBytes: 1024 * 1024,
  maxUploadsPerWindow: 5000,
  maxBytesPerWindow: 1024 * 1024 * 1024,
  windowDays: 30,
});

let quotaQueue = Promise.resolve();

function awsEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function hmac(key, value, encoding) {
  return createHmac('sha256', key).update(value, 'utf8').digest(encoding);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function signingKey(secretAccessKey, dateStamp) {
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, 'auto');
  const serviceKey = hmac(regionKey, 's3');
  return hmac(serviceKey, 'aws4_request');
}

function timestamps(now) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/gu, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function canonicalObjectPath(bucket, key) {
  return `/${awsEncode(bucket)}/${String(key).split('/').map(awsEncode).join('/')}`;
}

function normalizedConfig(source = process.env) {
  const accountId = String(source.WARFRAME_R2_ACCOUNT_ID || '').trim();
  const bucket = String(source.WARFRAME_R2_BUCKET || '').trim();
  const accessKeyId = String(source.WARFRAME_R2_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = String(source.WARFRAME_R2_SECRET_ACCESS_KEY || '').trim();
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error('Warframe ephemeral R2 image storage is not configured');
  }
  if (!/^[a-z0-9-]+$/iu.test(bucket)) throw new Error('Warframe R2 bucket name is invalid');
  const requestedTtl = Number.parseInt(String(source.WARFRAME_R2_URL_TTL_SECONDS || DEFAULT_TTL_SECONDS), 10);
  // The bucket removes wm/ objects after one day; longer signatures cannot keep them available.
  const ttlSeconds = Number.isFinite(requestedTtl) ? Math.min(DEFAULT_TTL_SECONDS, Math.max(60, requestedTtl)) : DEFAULT_TTL_SECONDS;
  return { accountId, bucket, accessKeyId, secretAccessKey, ttlSeconds };
}

function defaultUsagePath(source = process.env) {
  const stateRoot = String(source.OPENCLAW_STATE_DIR || '').trim() || path.join(os.homedir(), '.openclaw');
  return path.join(stateRoot, 'warframe-r2-usage.json');
}

function parseUsage(raw) {
  const value = JSON.parse(raw);
  if (value?.schemaVersion !== 1 || !Array.isArray(value.entries)) throw new Error('invalid schema');
  const entries = value.entries.map((entry) => ({ at: Number(entry?.at), bytes: Number(entry?.bytes) }));
  if (entries.some((entry) => !Number.isFinite(entry.at) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0)) {
    throw new Error('invalid entry');
  }
  return entries;
}

async function readUsage(usagePath) {
  try {
    return parseUsage(await readFile(usagePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw new Error('Warframe R2 usage ledger is unavailable');
  }
}

async function writeUsage(usagePath, entries) {
  await mkdir(path.dirname(usagePath), { recursive: true });
  const tempPath = `${usagePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify({ schemaVersion: 1, entries })}\n`, { encoding: 'utf8', flag: 'wx' });
  try {
    await rename(tempPath, usagePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function reserveQuota(bytes, now, usagePath) {
  if (bytes > EPHEMERAL_R2_LIMITS.maxImageBytes) throw new Error('Warframe R2 image exceeds the local size limit');
  const execute = async () => {
    const cutoff = now.getTime() - QUOTA_WINDOW_MS;
    const entries = (await readUsage(usagePath)).filter((entry) => entry.at > cutoff);
    const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    if (entries.length >= EPHEMERAL_R2_LIMITS.maxUploadsPerWindow
      || totalBytes + bytes > EPHEMERAL_R2_LIMITS.maxBytesPerWindow) {
      throw new Error('Warframe R2 local rolling quota reached');
    }
    entries.push({ at: now.getTime(), bytes });
    try {
      await writeUsage(usagePath, entries);
    } catch {
      throw new Error('Warframe R2 usage ledger could not be updated');
    }
  };
  const reserved = quotaQueue.then(execute, execute);
  quotaQueue = reserved.catch(() => {});
  return reserved;
}

function presignedGetUrl(config, key, now) {
  const host = `${config.accountId}.r2.cloudflarestorage.com`;
  const objectPath = canonicalObjectPath(config.bucket, key);
  const { amzDate, dateStamp } = timestamps(now);
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const params = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${config.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(config.ttlSeconds)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  const canonicalQuery = params
    .map(([name, value]) => [awsEncode(name), awsEncode(value)])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
  const canonicalRequest = `GET\n${objectPath}\n${canonicalQuery}\nhost:${host}\n\nhost\nUNSIGNED-PAYLOAD`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`;
  const signature = hmac(signingKey(config.secretAccessKey, dateStamp), stringToSign, 'hex');
  return `https://${host}${objectPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

async function uploadObject(config, key, body, now, fetchImpl) {
  const host = `${config.accountId}.r2.cloudflarestorage.com`;
  const objectPath = canonicalObjectPath(config.bucket, key);
  const url = `https://${host}${objectPath}`;
  const { amzDate, dateStamp } = timestamps(now);
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const payloadHash = sha256(body);
  const canonicalHeaders = `content-type:image/png\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = `PUT\n${objectPath}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`;
  const signature = hmac(signingKey(config.secretAccessKey, dateStamp), stringToSign, 'hex');
  const response = await fetchImpl(url, {
    method: 'PUT',
    headers: {
      authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'content-type': 'image/png',
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    },
    body,
  });
  if (!response?.ok) throw new Error(`Warframe R2 image upload failed with HTTP ${response?.status || 'unknown'}`);
}

export async function uploadEphemeralR2Image(filePath, options = {}) {
  const config = normalizedConfig(options.env);
  const body = await readFile(filePath);
  const digest = sha256(body);
  const now = options.now instanceof Date ? options.now : new Date();
  const key = `wm/${now.toISOString().slice(0, 10).replaceAll('-', '')}/${digest}.png`;
  await reserveQuota(body.byteLength, now, options.usagePath || defaultUsagePath(options.env));
  await uploadObject(config, key, body, now, options.fetchImpl || fetch);
  return { url: presignedGetUrl(config, key, now), key, ttlSeconds: config.ttlSeconds };
}
