// response.js
// Converts a payload (from ai.js) into the actual text shown to the user,
// plus quick-reply suggestions for support.html's UI. This is the only
// module that deals in phrasing — keeping it centralized means tone
// changes happen in one place instead of scattered across intent.js.

const GREETINGS = [
  "Hi there! How can I help you today?",
  "Hello! What can I do for you?",
  "Hey! I'm here to help — what's on your mind?",
];

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function formatKnowledgeAnswer(matches) {
  if (!matches.length) return null;
  const top = matches[0];
  // Trim to a reasonable chat-bubble length; point to the full source
  // rather than dumping an entire document into the chat window.
  const snippet = top.text.length > 400 ? top.text.slice(0, 400).trim() + '…' : top.text;
  return snippet;
}

function buildResponse({ intent, payload, history }) {
  switch (payload.kind) {
    case 'greeting':
      return {
        text: pick(GREETINGS),
        suggestions: ['See pricing', 'Book a service', 'What do you offer?'],
      };

    case 'pricing': {
      const answer = formatKnowledgeAnswer(payload.matches);
      return {
        text: answer
          ? `Here's what I found on pricing:\n\n${answer}`
          : "I don't have exact pricing loaded yet, but I can connect you with our team for a quote — want me to start that?",
        suggestions: ['Request a quote', 'Talk to a human', 'What services are included?'],
      };
    }

    case 'booking':
      return {
        text: "I'd be happy to help you book. What service are you interested in, and roughly when works for you?",
        suggestions: ['Weekly service', 'One-time service', 'Talk to a human'],
      };

    case 'knowledge': {
      const answer = formatKnowledgeAnswer(payload.matches);
      return {
        text: answer,
        suggestions: ['That answers it', 'I need more detail', 'Talk to a human'],
      };
    }

    case 'fallback':
    default:
      return {
        text: "I'm not fully sure I understood that — could you rephrase, or would you like to talk to a team member directly?",
        suggestions: ['Talk to a human', 'See pricing', 'What do you offer?'],
      };
  }
}

module.exports = { buildResponse };
