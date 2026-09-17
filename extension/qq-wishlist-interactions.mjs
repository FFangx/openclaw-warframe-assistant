import { createHash, randomBytes } from 'node:crypto';

export const PREFIX = 'wfwish:v1:';
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const UNDO_TTL_MS = 5 * 60 * 1000;

function actorHash(accountId, senderId) {
  return createHash('sha256').update(`qqbot\0${String(accountId || 'default').trim().toLowerCase()}\0${String(senderId || '').trim().toLowerCase()}`).digest('hex');
}

export function createWishlistInteractionStore(options = {}) {
  const pending = new Map();
  const now = options.now || (() => Date.now());
  const token = options.token || (() => randomBytes(12).toString('hex'));
  const prune = () => {
    for (const [key, value] of pending) if (value.expiresAt <= now()) pending.delete(key);
    while (pending.size >= 512) pending.delete(pending.keys().next().value);
  };
  return {
    register({ accountId, senderId, action, wishId, expectedUpdatedAt, payload = null }) {
      if (!senderId || !action || !wishId) return null;
      prune();
      const id = token();
      pending.set(id, {
        actor: actorHash(accountId, senderId), action, wishId, expectedUpdatedAt, payload,
        expiresAt: now() + (String(action).startsWith('undo_') ? UNDO_TTL_MS : (options.ttlMs || DEFAULT_TTL_MS)),
      });
      return `${PREFIX}${id}`;
    },
    acquire(buttonData, identity) {
      const value = String(buttonData || '');
      if (!value.startsWith(PREFIX)) return { matched: false };
      const id = value.slice(PREFIX.length);
      const entry = pending.get(id);
      if (!entry || entry.expiresAt <= now()) { pending.delete(id); return { matched: true, ok: false, reason: 'expired' }; }
      if (entry.actor !== actorHash(identity.accountId, identity.senderId)) return { matched: true, ok: false, reason: 'actor-mismatch' };
      if (entry.inFlight) return { matched: true, ok: false, reason: 'busy' };
      entry.inFlight = true;
      return { matched: true, ok: true, ...entry };
    },
    release(buttonData, identity) {
      const id = String(buttonData || '').slice(PREFIX.length);
      const entry = pending.get(id);
      if (!entry || entry.actor !== actorHash(identity.accountId, identity.senderId)) return false;
      entry.inFlight = false;
      return true;
    },
  };
}

export const wishlistInteractions = createWishlistInteractionStore();
