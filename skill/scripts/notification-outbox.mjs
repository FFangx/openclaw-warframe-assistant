// 共享可复用通知 Outbox 核心（整改 R3「QQ 通知事务」，第一纵向切片：掉落通知链）。
//
// 设计契约（不要回退）：
// - 每条待发送事件是一条记录：业务幂等键 businessKey、内容哈希 contentHash、
//   媒体/文字 parts（逐项状态）、创建时间 createdAt、过期时间 expiresAt、
//   尝试次数 attempts、逐次结果类别 attemptsLog、最终状态 status/outcome。
// - part schema v1 含可选 transport（'media' 缺省 / 'lossless'）：投递器按模式选择通道，
//   本模块只持久化；contentHash 包含 transport（无损与普通媒体不互相去重）。
//   旧记录没有该字段，载入时归一为 'media'，投递行为向后兼容不变。
// - 投递是「逐 part」的：每个 part 的发送结果都立即持久化，重试只补投未发送的
//   part——图片成功文字失败时不会把成功图片重发一遍。
// - 先落盘再发送：进程在发送期间被杀，下轮仍能从磁盘恢复 pending；同一业务键
//   （含已投递 tombstone）不会重复入队。tombstone 与终态记录都有界。
// - 本模块零网络、零凭据、零账号访问，只操作调用方指定的本地文件；投递器由
//   调用方注入，以便测试与多通道复用。
// - 原子落盘：临时文件 + rename；进程内串行队列与跨进程陈旧锁回收共同保护
//   「读盘 → 变更 → 写回」，避免不同 cron/Gateway 进程互相覆盖。
//
// 状态文件 schemaVersion 1：
//   { schemaVersion, updatedAt, nextId, entries: [...], tombstones: { businessKey: deliveredAt } }
// target 只以不可逆 SHA-256 targetKey 落盘；原始 QQ target 仅存在于调用栈中。

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const OUTBOX_SCHEMA_VERSION = 1;
// 欠账保留 48 小时：网络恢复后自动补投，超期丢弃防无限堆积（与旧 pendingDelivery 一致）
export const DEFAULT_TTL_MS = 48 * 60 * 60 * 1000;
// 已投递业务键 tombstone 上限：超限淘汰最早投递的键
export const TOMBSTONE_LIMIT = 200;
// 终态（delivered/expired）记录保留上限；pending 永不淘汰
export const ENTRIES_LIMIT = 400;
// 每条记录保留的逐次尝试明细上限
export const ATTEMPT_LOG_LIMIT = 20;
// 多 part 投递可能连续等待多个 60s 渠道调用；锁必须明显长于正常发送窗口。
const LOCK_STALE_MS = 5 * 60 * 1000;
const LOCK_HEARTBEAT_MS = 30 * 1000;
const LOCK_WAIT_MS = 50;
const LOCK_ATTEMPTS = 600;
export const ENTRY_STATUS = Object.freeze({ PENDING: 'pending', DELIVERED: 'delivered', EXPIRED: 'expired' });
export const PART_STATUS = Object.freeze({ PENDING: 'pending', SENT: 'sent' });
// 结果类别：delivered 服务端接受 / failed 发送失败 / expired 超期丢弃 / skipped 同业务键去重跳过
export const RESULT_CATEGORY = Object.freeze({ DELIVERED: 'delivered', FAILED: 'failed', EXPIRED: 'expired', SKIPPED: 'skipped' });

// 媒体 part 的投递模式（part.transport，R3 第三片新增）：
// - 'media'（缺省）：普通投递通道（--media），旧记录与掉落/世界状态通知行为不变
// - 'lossless'：QQ /files + srv_send_msg=true 一步原图直发（周报主卡专用）
// 本模块只持久化模式供投递器选择通道，不理解具体通道细节；文字 part 恒走 --message 与 transport 无关。
export const PART_TRANSPORT = Object.freeze({ MEDIA: 'media', LOSSLESS: 'lossless' });

function normalizeTransport(value) {
  return String(value || '').trim().toLowerCase() === 'lossless' ? 'lossless' : 'media';
}

const LEGACY_MEDIA_RE = /\bMEDIA:\s*`?([^\n`]+)`?/giu;

export function sha256(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

export function targetKeyOf(target) {
  const normalized = String(target || '').trim().toLowerCase();
  if (!normalized) throw new Error('通知 Outbox 需要 target');
  return sha256(normalized);
}

// 规范化 parts → 内容哈希：内容相同哈希相同，任何字段漂移都会改变哈希。
// 只指纹 part 内容本身（不含业务键/目标），作为「内容是否变化」的可审计依据。
// 投递模式（transport）属于内容指纹：无损原图与普通媒体的同一文件不会互相去重。
export function contentHashOf(parts) {
  return sha256(JSON.stringify({
    parts: (Array.isArray(parts) ? parts : []).map((part) => ({
      kind: String(part?.kind || ''),
      value: String(part?.value ?? ''),
      transport: normalizeTransport(part?.transport),
    })),
  }));
}

// 旧欠账消息字符串（可含 MEDIA: 行）→ parts；与 subscriptions.mjs 的
// monitorDeliveryParts 保持同一解析语义：MEDIA: 行转媒体 part，其余为文字 part。
export function parseLegacyMessage(message) {
  const text = String(message ?? '');
  const mediaUrls = [...text.matchAll(LEGACY_MEDIA_RE)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  const remainder = text.replace(LEGACY_MEDIA_RE, '').trim();
  const parts = mediaUrls.map((value) => ({ kind: 'media', value }));
  if (remainder) parts.push({ kind: 'text', value: remainder });
  return parts;
}

function normalizeParts(parts) {
  if (!Array.isArray(parts)) throw new Error('通知 Outbox 需要 parts 数组');
  const clean = [];
  for (const part of parts) {
    const kind = String(part?.kind || '');
    const value = String(part?.value ?? '');
    if (kind !== 'media' && kind !== 'text') continue;
    if (!value) continue;
    clean.push({ kind, value, transport: normalizeTransport(part?.transport) });
  }
  return clean;
}

function emptyStore() {
  return {
    schemaVersion: OUTBOX_SCHEMA_VERSION,
    updatedAt: null,
    nextId: 1,
    entries: [],
    tombstones: {},
  };
}

// 载入容错：逐条净化而非整体拒绝；缺关键字段的记录丢弃（防御旧手改文件），
// 文件本身损坏（JSON 解析失败、schemaVersion 超前）直接抛错，绝不静默重置——
// 重置会丢 pending 欠账，宁可让监测报错保持文件原样等人处理。
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!raw.id || !raw.businessKey || !Array.isArray(raw.parts)) return null;
  const targetKey = typeof raw.targetKey === 'string' && /^[0-9a-f]{64}$/u.test(raw.targetKey)
    ? raw.targetKey
    : null;
  if (!targetKey) return null;
  // redactOnTerminal 记录终态后 part.value 会被擦除（只留 contentHash/状态/时间审计）；
  // 这类记录允许空 value；其余记录任一部分非法都无法完整恢复（尤其不允许把 sent
  // 部分静默丢掉），弃整条并保留其余记录，绝不编造投递状态。
  const redactOnTerminal = raw.redactOnTerminal === true;
  const terminalRedacted = redactOnTerminal && ['delivered', 'expired'].includes(String(raw.status || ''));
  if (!raw.parts.every((part) => (
    part && ['media', 'text'].includes(String(part.kind || ''))
    && (terminalRedacted || String(part.value ?? ''))
  ))) return null;
  const parts = raw.parts.map((part) => ({
    kind: String(part.kind),
    value: String(part.value),
    // 旧格式记录没有 transport：归一为默认 'media'，普通投递行为不变
    transport: normalizeTransport(part.transport),
    status: part.status === 'sent' ? 'sent' : 'pending',
    attempts: Math.max(0, Number(part.attempts) || 0),
    sentAt: typeof part.sentAt === 'string' ? part.sentAt : null,
    lastAttemptAt: typeof part.lastAttemptAt === 'string' ? part.lastAttemptAt : null,
  }));
  if (!parts.length) return null;
  return {
    schemaVersion: OUTBOX_SCHEMA_VERSION,
    id: String(raw.id),
    businessKey: String(raw.businessKey),
    targetKey,
    redactOnTerminal,
    contentHash: typeof raw.contentHash === 'string' ? raw.contentHash : contentHashOf(parts),
    parts,
    status: ['pending', 'delivered', 'expired'].includes(raw.status) ? raw.status : 'pending',
    attempts: Math.max(0, Number(raw.attempts) || 0),
    attemptsLog: (Array.isArray(raw.attemptsLog) ? raw.attemptsLog : [])
      .filter((item) => item && item.at && ['delivered', 'failed', 'expired', 'skipped'].includes(String(item.category || '')))
      .slice(-ATTEMPT_LOG_LIMIT)
      .map((item) => ({
        at: String(item.at),
        partIndex: Number.isInteger(item.partIndex) ? item.partIndex : null,
        category: String(item.category),
        resultCode: typeof item.resultCode === 'string' && /^[a-z0-9_-]{1,64}$/u.test(item.resultCode)
          ? item.resultCode
          : null,
      })),
    outcome: ['delivered', 'failed', 'expired', 'pending'].includes(raw.outcome) ? raw.outcome : 'pending',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : null,
    deliveredAt: typeof raw.deliveredAt === 'string' ? raw.deliveredAt : null,
    expiredAt: typeof raw.expiredAt === 'string' ? raw.expiredAt : null,
  };
}

function normalizeStore(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('通知 Outbox 状态文件无效');
  const version = Number(raw.schemaVersion) || 0;
  if (version > OUTBOX_SCHEMA_VERSION) {
    throw new Error(`通知 Outbox 状态 schemaVersion ${version} 高于当前支持的 ${OUTBOX_SCHEMA_VERSION}`);
  }
  const entries = (Array.isArray(raw.entries) ? raw.entries : [])
    .map(normalizeEntry)
    .filter(Boolean);
  const tombstones = {};
  if (raw.tombstones && typeof raw.tombstones === 'object' && !Array.isArray(raw.tombstones)) {
    for (const [key, value] of Object.entries(raw.tombstones)) {
      if (key && typeof value === 'string' && Number.isFinite(Date.parse(value))) tombstones[key] = value;
    }
  }
  return {
    schemaVersion: OUTBOX_SCHEMA_VERSION,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    nextId: Number.isInteger(raw.nextId) && raw.nextId > 0 ? raw.nextId : 1,
    entries,
    tombstones,
  };
}

// 有界化：pending 永不淘汰；终态记录与 tombstone 超限时淘汰最旧的
function enforceBounds(store) {
  if (store.entries.length > ENTRIES_LIMIT) {
    const overflow = store.entries.length - ENTRIES_LIMIT;
    const evictable = store.entries
      .filter((entry) => entry.status !== 'pending')
      .sort((a, b) => {
        const at = (entry) => Date.parse(entry.deliveredAt || entry.expiredAt || entry.createdAt) || 0;
        return at(a) - at(b);
      });
    const evicted = new Set(evictable.slice(0, overflow).map((entry) => entry.id));
    if (evicted.size) store.entries = store.entries.filter((entry) => !evicted.has(entry.id));
  }
  const tombstoneKeys = Object.keys(store.tombstones);
  if (tombstoneKeys.length > TOMBSTONE_LIMIT) {
    const overflow = tombstoneKeys.length - TOMBSTONE_LIMIT;
    const oldest = tombstoneKeys
      .sort((a, b) => (Date.parse(store.tombstones[a]) || 0) - (Date.parse(store.tombstones[b]) || 0))
      .slice(0, overflow);
    for (const key of oldest) delete store.tombstones[key];
  }
}

/**
 * 创建 Outbox 实例。所有方法都做「读盘 → 变更 → 原子落盘」，保证进程重启后
 * pending 可恢复；文件模式每次操作都在跨进程锁内重新读盘，避免长生命周期实例
 * 覆盖其他进程的新状态；memory: true 时纯内存（测试用，不落盘）。
 *
 * @param {object} [options]
 * @param {string|null} [options.filePath] 状态文件路径（memory 模式忽略）
 * @param {boolean} [options.memory] 纯内存模式（测试）
 * @param {number} [options.ttlMs] 欠账保留时长，默认 48h
 * @param {() => number} [options.now] 时间源注入（测试）
 */
export function createOutbox(options = {}) {
  const filePath = options.filePath || null;
  const memory = options.memory === true;
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_TTL_MS;
  const now = () => (typeof options.now === 'function' ? options.now() : Date.now());

  let store = null;
  let queue = Promise.resolve();
  const serialized = (operation) => {
    const run = queue.then(operation, operation);
    queue = run.then(() => undefined, () => undefined);
    return run;
  };

  async function withDiskLock(operation) {
    if (memory || !filePath) return operation();
    const lockPath = `${filePath}.lock`;
    const lockToken = `${process.pid}:${randomUUID()}`;
    await mkdir(path.dirname(filePath), { recursive: true });
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      try {
        await writeFile(lockPath, `${lockToken}\n`, { encoding: 'utf8', flag: 'wx' });
        const heartbeat = setInterval(() => {
          const stamp = new Date();
          void utimes(lockPath, stamp, stamp).catch(() => {});
        }, LOCK_HEARTBEAT_MS);
        heartbeat.unref?.();
        try {
          // 其他进程可能刚写过；持锁后强制重新读盘，避免长生命周期实例覆盖新状态。
          store = null;
          return await operation();
        } finally {
          clearInterval(heartbeat);
          // 只释放自己创建的锁；若文件已被外部恢复流程替换，不能误删新持有者的锁。
          const owner = await readFile(lockPath, 'utf8').catch(() => '');
          if (owner.trim() === lockToken) await unlink(lockPath).catch(() => {});
        }
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        try {
          const info = await stat(lockPath);
          if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
            await unlink(lockPath).catch(() => {});
            continue;
          }
        } catch { /* 锁刚被释放，直接重试 */ }
        await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
      }
    }
    throw new Error('通知 Outbox 状态正忙，请在下一轮重试');
  }

  const locked = (operation) => serialized(() => withDiskLock(operation));

  async function load() {
    if (store) return store;
    if (memory || !filePath) { store = emptyStore(); return store; }
    let raw;
    try {
      raw = JSON.parse(await readFile(filePath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') { store = emptyStore(); return store; }
      throw new Error(`通知 Outbox 状态文件损坏（${filePath}）：${String(error?.message || error)}`);
    }
    store = normalizeStore(raw);
    return store;
  }

  async function persist() {
    // 有界化在每次变更后生效，内存模式同样应用（只跳过落盘）
    enforceBounds(store);
    if (memory || !filePath) return;
    store.updatedAt = new Date(now()).toISOString();
    await mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(store)}\n`, 'utf8');
    await rename(tempPath, filePath);
  }

  function safeResultCode(value) {
    const code = String(value || '').trim().toLowerCase();
    return /^[a-z0-9_-]{1,64}$/u.test(code) ? code : 'delivery_failed';
  }

  function appendAttempt(entry, partIndex, category, resultCode = null) {
    entry.attemptsLog.push({
      at: new Date(now()).toISOString(),
      partIndex,
      category,
      resultCode: resultCode ? safeResultCode(resultCode) : null,
    });
    if (entry.attemptsLog.length > ATTEMPT_LOG_LIMIT) entry.attemptsLog.shift();
  }

  // 终态擦除（redactOnTerminal 记录）：清空 part.value 但保留 part 状态/时间/尝试数，
  // contentHash 与 attemptsLog 不变，给重启补投与后续审计留完整可查的脱敏证据。
  function redactParts(entry) {
    for (const part of entry.parts) part.value = '';
  }

  /**
   * 入队一条待发送通知。同一 businessKey 已存在（任何状态）或已投递 tombstone
   * 命中时，不会重复入队：返回 { created:false, deduped:true, entry: 已存在记录|null }。
   *
   * @param {object} input { businessKey, target, parts, createdAt?, expiresAt?, redactOnTerminal? }
   *   expiresAt：调用方显式的业务过期时间（如世界状态通知取本卡片最早的有效 expiry）。
   *   必须为合法时间，且不晚于 createdAt + ttlMs（本 Outbox 的默认 TTL）——更晚会被
   *   封顶到默认 TTL；允许更早（时效事件到期即停补投，防过期后盲目补发）。
   *   缺省行为不变：createdAt + ttlMs（掉落通知 48h）。
   *   redactOnTerminal：终态（delivered/expired）立即擦除所有 part.value，只保留
   *   contentHash、part 状态、时间与脱敏结果审计（R3 第四片：愿望命中通知用；
   *   掉落/世界状态/周报记录不带该标记，行为不变）。
   * @returns {Promise<{entry, created, deduped}>}
   */
  function enqueue(input) {
    return locked(async () => {
      const businessKey = String(input?.businessKey || '').trim();
      const target = String(input?.target || '').trim().toLowerCase();
      if (!businessKey) throw new Error('通知 Outbox 入队需要 businessKey');
      if (!target) throw new Error('通知 Outbox 入队需要 target');
      if (businessKey.toLowerCase().includes(target)) throw new Error('通知 Outbox businessKey 不得包含原始 target');
      const targetKey = targetKeyOf(target);
      const parts = normalizeParts(input?.parts);
      if (!parts.length) throw new Error('通知 Outbox 入队需要至少一个媒体/文字 part');
      await load();
      const existing = store.entries.find((entry) => entry.businessKey === businessKey);
      if (existing) return { entry: existing, created: false, deduped: true };
      if (store.tombstones[businessKey]) return { entry: null, created: false, deduped: true };
      const createdAt = typeof input.createdAt === 'string' && Number.isFinite(Date.parse(input.createdAt))
        ? input.createdAt
        : new Date(now()).toISOString();
      const createdAtMs = Date.parse(createdAt);
      let expiresAt = new Date(createdAtMs + ttlMs).toISOString();
      if (input.expiresAt != null && String(input.expiresAt).trim() !== '') {
        const requestedMs = Date.parse(input.expiresAt);
        if (!Number.isFinite(requestedMs)) throw new Error('通知 Outbox 的 expiresAt 必须为合法时间');
        // 调用方业务过期可以更早，但绝不晚于默认 TTL（默认 TTL 是欠账保留的硬上限）
        expiresAt = new Date(Math.min(requestedMs, createdAtMs + ttlMs)).toISOString();
      }
      const entry = {
        schemaVersion: OUTBOX_SCHEMA_VERSION,
        id: `ob-${store.nextId}`,
        businessKey,
        targetKey,
        redactOnTerminal: input.redactOnTerminal === true,
        contentHash: contentHashOf(parts),
        parts: parts.map((part) => ({
          ...part,
          status: 'pending',
          attempts: 0,
          sentAt: null,
          lastAttemptAt: null,
        })),
        status: 'pending',
        attempts: 0,
        attemptsLog: [],
        outcome: 'pending',
        createdAt,
        expiresAt,
        deliveredAt: null,
        expiredAt: null,
      };
      store.nextId += 1;
      store.entries.push(entry);
      await persist();
      return { entry, created: true, deduped: false };
    });
  }

  /**
   * 投递指定 target 的 pending 记录（可用 ids 限定本轮新入队的那条；
   * keyPrefix 只投递业务键前缀匹配的 pending——愿望链用它只恢复本链欠账，
   * 不代投世界状态/周报/掉落记录；缺省不过滤，行为与旧版完全一致）。
   * 逐 part 发送并立即持久化：成功 part 记 sent，失败 part 留 pending 等下一轮；
   * 全部 part 成功才置 delivered 并写 tombstone；超过 expiresAt 的记录置 expired。
   * redactOnTerminal 记录进入 delivered/expired 终态时立即擦除 part.value
   * （contentHash/part 状态/时间/脱敏结果审计保留）。
   * mailer(part, entry) 必须返回 { ok: true } 或
   * { ok: false, category: <固定脱敏类别> }，抛错按 mailer_exception 处理。
   *
   * @returns {Promise<{attempted, sentParts, failedParts, deliveredIds, pendingIds, expiredIds}>}
   */
  function deliverPending(input) {
    return locked(async () => {
      const mailer = input?.mailer;
      if (typeof mailer !== 'function') throw new Error('通知 Outbox 投递需要 mailer');
      const target = String(input?.target || '').trim().toLowerCase();
      const targetKey = target ? targetKeyOf(target) : '';
      const keyPrefix = typeof input?.keyPrefix === 'string' && input.keyPrefix ? input.keyPrefix : null;
      const ids = Array.isArray(input?.ids) ? new Set(input.ids.map(String)) : null;
      await load();
      const summary = { attempted: 0, sentParts: 0, failedParts: 0, deliveredIds: [], pendingIds: [], expiredIds: [] };
      const candidates = store.entries.filter((entry) => (
        entry.status === 'pending'
        && (!targetKey || entry.targetKey === targetKey)
        && (!keyPrefix || entry.businessKey.startsWith(keyPrefix))
        && (!ids || ids.has(entry.id))
      ));
      for (const entry of candidates) {
        summary.attempted += 1;
        const expiresAtMs = Date.parse(entry.expiresAt);
        // expiresAt 缺失/非法（手改文件）按超期安全处理：绝不无限重试
        if (!Number.isFinite(expiresAtMs) || now() > expiresAtMs) {
          entry.status = 'expired';
          entry.outcome = 'expired';
          entry.expiredAt = new Date(now()).toISOString();
          if (entry.redactOnTerminal) redactParts(entry);
          appendAttempt(entry, null, 'expired', null);
          summary.expiredIds.push(entry.id);
          await persist();
          continue;
        }
        for (let index = 0; index < entry.parts.length; index += 1) {
          const part = entry.parts[index];
          if (part.status === 'sent') continue;
          part.attempts += 1;
          entry.attempts += 1;
          part.lastAttemptAt = new Date(now()).toISOString();
          let result = { ok: false, category: 'no_response' };
          try {
            result = (await mailer(part, entry)) || result;
          } catch (error) {
            result = { ok: false, category: 'mailer_exception' };
          }
          if (result?.ok === true) {
            part.status = 'sent';
            part.sentAt = new Date(now()).toISOString();
            appendAttempt(entry, index, 'delivered', null);
            summary.sentParts += 1;
          } else {
            appendAttempt(entry, index, 'failed', result?.category || 'delivery_failed');
            summary.failedParts += 1;
          }
          // 每个 part 的结果立即落盘：发送期间被杀，下轮也不会重复已成功的 part
          await persist();
        }
        if (entry.parts.every((part) => part.status === 'sent')) {
          entry.status = 'delivered';
          entry.outcome = 'delivered';
          entry.deliveredAt = new Date(now()).toISOString();
          store.tombstones[entry.businessKey] = entry.deliveredAt;
          // 终态擦除：只留 contentHash/part 状态/时间/脱敏结果审计（愿望链敏感 payload 不落盘）
          if (entry.redactOnTerminal) redactParts(entry);
          summary.deliveredIds.push(entry.id);
        } else {
          entry.outcome = 'failed';
          summary.pendingIds.push(entry.id);
        }
        await persist();
      }
      return summary;
    });
  }

  /** 只读快照（测试与诊断用；返回深拷贝，不会带出未序列化字段） */
  function snapshot() {
    return locked(async () => {
      await load();
      return JSON.parse(JSON.stringify(store));
    });
  }

  return {
    filePath,
    ttlMs,
    memory,
    enqueue,
    deliverPending,
    snapshot,
  };
}

/**
 * 旧欠账队列（{ id, message, queuedAt }[]，如旧版 drops 状态文件的
 * pendingDelivery）兼容迁移：逐条按 businessKey
 * `legacy:<targetKey>:<id>` 入队，幂等且不会让不同订阅目标相互去重
 * （重复迁移同一批不会产生重复记录）；已有记录或 tombstone 命中视为 skipped。
 * 过期时间保持旧口径 queuedAt + ttlMs（48h），不因迁移重置欠账时钟；
 * 已超期（queuedAt + ttl < now）的记录不迁移，等价于旧 flush 的「超期丢弃」。
 *
 * @returns {Promise<{migrated, skipped, expired}>}
 */
export async function migrateLegacyDeliveryQueue(queue, outbox, input = {}) {
  const items = Array.isArray(queue) ? queue : [];
  const target = String(input?.target || '').trim().toLowerCase();
  if (!target) throw new Error('通知 Outbox 迁移需要 target');
  const targetKey = targetKeyOf(target);
  const now = input?.now ? () => input.now() : () => Date.now();
  let migrated = 0;
  let skipped = 0;
  let expired = 0;
  for (const item of items) {
    if (!item || typeof item !== 'object') { skipped += 1; continue; }
    const legacyId = String(item.id ?? '').trim();
    if (!legacyId) { skipped += 1; continue; }
    const queuedAt = Date.parse(item.queuedAt);
    if (!Number.isFinite(queuedAt)) { skipped += 1; continue; }
    if (now() - queuedAt > outbox.ttlMs) { expired += 1; continue; }
    const parts = parseLegacyMessage(item.message);
    if (!parts.length) { skipped += 1; continue; }
    const result = await outbox.enqueue({
      businessKey: `legacy:${targetKey}:${legacyId}`,
      target,
      parts,
      createdAt: item.queuedAt,
    });
    if (result.created) migrated += 1;
    else skipped += 1;
  }
  return { migrated, skipped, expired };
}
