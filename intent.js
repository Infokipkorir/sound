// intent.js
// Deterministic, keyword + pattern based intent detection.
// No ML model — just weighted keyword sets scored per intent, plus a
// handful of regex patterns for things numbers/dates make easy to catch
// (e.g. booking requests almost always mention a date/time word).
//
// Returns { type, confidence } where confidence is 0..1, purely so
// response.js / ai.js can decide when to hedge ("I think you're asking
// about...") versus answer directly.

const INTENTS = {
  greeting: {
    keywords: ['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening', 'howdy'],
    weight: 1,
  },
  pricing: {
    keywords: ['price', 'pricing', 'cost', 'how much', 'quote', 'rate', 'rates', 'fee', 'fees', 'charge'],
    weight: 1,
  },
  booking: {
    keywords: ['book', 'schedule', 'appointment', 'reserve', 'reservation', 'available', 'availability', 'when can'],
    weight: 1,
  },
  services: {
    keywords: ['service', 'services', 'what do you offer', 'what can you do', 'do you provide', 'do you do'],
    weight: 0.9,
  },
  faq: {
    keywords: ['help', 'how do i', 'how does', 'why', 'what is', 'explain', 'question'],
    weight: 0.7,
  },
};

function normalize(text) {
  return text.toLowerCase().replace(/[^\w\s?]/g, ' ').replace(/\s+/g, ' ').trim();
}

function scoreIntent(text, def) {
  let hits = 0;
  for (const kw of def.keywords) {
    if (text.includes(kw)) hits += 1;
  }
  if (hits === 0) return 0;
  // Diminishing returns after the first couple of keyword hits, scaled
  // by the intent's base weight.
  return Math.min(1, (hits / 2) * def.weight);
}

function detectIntent(rawMessage, context = {}) {
  const text = normalize(rawMessage);

  let best = { type: 'unknown', confidence: 0 };
  for (const [type, def] of Object.entries(INTENTS)) {
    const score = scoreIntent(text, def);
    if (score > best.confidence) {
      best = { type, confidence: Number(score.toFixed(2)) };
    }
  }

  // Context nudge: if the previous bot turn was a pricing answer and the
  // user's follow-up is short/ambiguous ("and for weekly?"), keep them in
  // the pricing intent rather than falling back to "unknown".
  if (best.type === 'unknown' && context.lastIntent === 'pricing' && text.length < 40) {
    return { type: 'pricing', confidence: 0.4 };
  }

  if (best.confidence === 0) {
    return { type: 'faq', confidence: 0.2 }; // default to knowledge search, not a dead end
  }

  return best;
}

module.exports = { detectIntent, INTENTS };
