// memory.js
// Per-session conversation memory, kept in-process (a Map). Fine for a
// single Node instance / low-to-moderate traffic. If you scale to
// multiple server instances, swap the Map for Redis using the same
// function signatures below — nothing else in the app needs to change.

const SESSION_TTL_MS = 1000 * 60 * 60; // 1 hour of inactivity expires a session
const MAX_TURNS_KEPT = 20; // cap memory growth per session

const sessions = new Map(); // sessionId -> { messages: [], lastIntent: string|null, updatedAt: number }

function touch(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { messages: [], lastIntent: null, updatedAt: Date.now() });
  }
  const s = sessions.get(sessionId);
  s.updatedAt = Date.now();
  return s;
}

function appendMessage(sessionId, msg) {
  const s = touch(sessionId);
  s.messages.push(msg);
  if (s.messages.length > MAX_TURNS_KEPT) {
    s.messages = s.messages.slice(-MAX_TURNS_KEPT);
  }
}

function getHistory(sessionId) {
  return sessions.has(sessionId) ? sessions.get(sessionId).messages : [];
}

function getContext(sessionId) {
  const s = sessions.get(sessionId);
  if (!s || !s.messages.length) return {};
  const lastBotTurn = [...s.messages].reverse().find(m => m.role === 'bot');
  return {
    lastIntent: s.lastIntent,
    lastBotText: lastBotTurn ? lastBotTurn.text : null,
  };
}

function setLastIntent(sessionId, intentType) {
  touch(sessionId).lastIntent = intentType;
}

// Periodic cleanup of stale sessions so memory doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions.entries()) {
    if (now - s.updatedAt > SESSION_TTL_MS) sessions.delete(id);
  }
}, 1000 * 60 * 10).unref();

module.exports = { appendMessage, getHistory, getContext, setLastIntent };
