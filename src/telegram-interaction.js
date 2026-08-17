const interactionVersions = new Map();
const INTERACTION_TTL_MS = 10 * 60_000;

function interactionKey(chatId, messageId) {
  if (chatId === undefined || chatId === null || messageId === undefined || messageId === null) return "";
  return `${chatId}:${messageId}`;
}

function prune(now = Date.now()) {
  for (const [key, entry] of interactionVersions) {
    if (entry.expiresAt <= now) interactionVersions.delete(key);
  }
}

// Every callback starts a new view of one Telegram message. Long-running work
// retains this token and must not overwrite a view the user has since replaced.
export function beginTelegramInteraction(chatId, messageId, now = Date.now()) {
  const key = interactionKey(chatId, messageId);
  if (!key) return null;
  prune(now);
  const revision = Number(interactionVersions.get(key)?.revision || 0) + 1;
  interactionVersions.set(key, { revision, expiresAt: now + INTERACTION_TTL_MS });
  return { key, revision };
}

export function isTelegramInteractionCurrent(token, now = Date.now()) {
  if (!token?.key || !Number.isSafeInteger(token.revision)) return true;
  const entry = interactionVersions.get(token.key);
  if (!entry || entry.expiresAt <= now) return false;
  return entry.revision === token.revision;
}

export function resetTelegramInteractionStateForTest() {
  interactionVersions.clear();
}
