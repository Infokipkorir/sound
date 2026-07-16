// ai.js
// The "brain" — but not the AI model itself. This is the controller that
// decides, for a given message, which module gets to answer it and in
// what order. Nothing here does NLP directly; it delegates to:
//   intent.js     -> what does the user want?
//   memory.js     -> what have we already discussed?
//   knowledge.js  -> what do we know?
//   search.js     -> which known facts best match this message?
//   response.js   -> how do we phrase the answer?

const { detectIntent } = require('./intent');
const { search } = require('./search');
const { buildResponse } = require('./response');
const { getHistory, appendMessage, getContext, setLastIntent } = require('./memory');

async function handleMessage({ sessionId, message }) {
  // 1. Record the incoming message before we do anything else, so context
  //    is never lost even if a later step throws.
  appendMessage(sessionId, { role: 'user', text: message, at: Date.now() });

  // 2. Classify what the user is trying to do.
  const intent = detectIntent(message, getContext(sessionId));
  setLastIntent(sessionId, intent.type);

  // 3. Route by intent. Deterministic intents (greeting, pricing, booking)
  //    are answered directly; open-ended intents (faq, services, unknown)
  //    fall through to the knowledge search.
  let payload;

  switch (intent.type) {
    case 'greeting':
      payload = { kind: 'greeting' };
      break;

    case 'pricing':
      payload = { kind: 'pricing', matches: search('pricing', { topK: 3 }) };
      break;

    case 'booking':
      payload = { kind: 'booking' };
      break;

    case 'faq':
    case 'services':
    default: {
      const matches = search(message, { topK: 3 });
      payload = { kind: matches.length ? 'knowledge' : 'fallback', matches };
      break;
    }
  }

  // 4. Turn the raw payload into a human-readable reply with suggestions.
  const reply = buildResponse({ intent, payload, history: getHistory(sessionId) });

  appendMessage(sessionId, { role: 'bot', text: reply.text, at: Date.now() });

  return {
    reply: reply.text,
    suggestions: reply.suggestions,
    intent: intent.type,
    confidence: intent.confidence,
  };
}

module.exports = { handleMessage };
