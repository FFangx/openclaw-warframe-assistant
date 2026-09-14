import { createHash, randomBytes } from 'node:crypto';

export const QQ_MARKET_INTERACTION_BRIDGE = Symbol.for('warframe.qqbot.market-interaction.v1');
const PREFIX = 'wftrend:v1:';
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MAX_PENDING = 256;

function actorHash(accountId, senderId) {
  return createHash('sha256')
    .update(`qqbot\0${String(accountId || '').trim().toLowerCase()}\0${String(senderId || '').trim().toLowerCase()}`)
    .digest('hex');
}

export function createMarketTrendInteractionStore(options = {}) {
  const pending = new Map();
  const now = options.now || (() => Date.now());
  const token = options.token || (() => randomBytes(12).toString('hex'));
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_TTL_MS;

  const prune = () => {
    const current = now();
    for (const [key, value] of pending) {
      if (value.expiresAt <= current) pending.delete(key);
    }
    while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
  };

  return {
    register({ accountId, senderId, query }) {
      const normalizedSender = String(senderId || '').trim().toLowerCase();
      const normalizedQuery = String(query || '').trim();
      if (!normalizedSender || !normalizedQuery) return null;
      prune();
      const id = token();
      pending.set(id, {
        actor: actorHash(accountId, normalizedSender),
        query: normalizedQuery,
        expiresAt: now() + ttlMs,
      });
      return `${PREFIX}${id}`;
    },
    acquire(buttonData, { accountId, senderId }) {
      const value = String(buttonData || '').trim();
      if (!value.startsWith(PREFIX)) return { matched: false };
      const id = value.slice(PREFIX.length);
      const entry = pending.get(id);
      if (!entry || entry.expiresAt <= now()) {
        pending.delete(id);
        return { matched: true, ok: false, reason: 'expired' };
      }
      if (entry.actor !== actorHash(accountId, senderId)) return { matched: true, ok: false, reason: 'actor-mismatch' };
      if (entry.inFlight) return { matched: true, ok: false, reason: 'busy' };
      entry.inFlight = true;
      return { matched: true, ok: true, query: entry.query };
    },
    release(buttonData, { accountId, senderId }) {
      const value = String(buttonData || '').trim();
      if (!value.startsWith(PREFIX)) return false;
      const entry = pending.get(value.slice(PREFIX.length));
      if (!entry || entry.expiresAt <= now() || entry.actor !== actorHash(accountId, senderId)) return false;
      entry.inFlight = false;
      return true;
    },
    size() {
      prune();
      return pending.size;
    },
  };
}

export const marketTrendInteractions = createMarketTrendInteractionStore();
