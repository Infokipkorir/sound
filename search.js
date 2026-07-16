// search.js
// Pure keyword scoring — a lightweight TF (term-frequency) ranker with a
// title-match bonus. This is deliberately NOT semantic/embedding search
// (that needs an API or a local embedding model); it's a dependency-free
// stand-in that works well for FAQ-style knowledge bases. See Chapter 16
// for the upgrade path to real embeddings.

const { getKnowledgeBase } = require('./knowledge');

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'do', 'does', 'i', 'you', 'to', 'of', 'for',
  'and', 'or', 'my', 'your', 'in', 'on', 'what', 'how', 'can', 'please',
]);

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w && !STOPWORDS.has(w));
}

function scoreChunk(queryTokens, chunk) {
  const bodyTokens = tokenize(chunk.text);
  const titleTokens = tokenize(chunk.title);

  let score = 0;
  for (const qt of queryTokens) {
    const bodyHits = bodyTokens.filter(t => t === qt).length;
    const titleHits = titleTokens.filter(t => t === qt).length;
    score += bodyHits * 1;
    score += titleHits * 2; // title matches count more
  }

  // Normalize a little by chunk length so short precise chunks aren't
  // drowned out by long ones that happen to contain a keyword once.
  return score / Math.sqrt(bodyTokens.length + 1);
}

function search(query, { topK = 3, minScore = 0.15 } = {}) {
  const knowledgeBase = getKnowledgeBase();
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0 || knowledgeBase.length === 0) return [];

  const scored = knowledgeBase
    .map(chunk => ({ chunk, score: scoreChunk(queryTokens, chunk) }))
    .filter(r => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return scored.map(r => ({
    title: r.chunk.title,
    text: r.chunk.text,
    source: r.chunk.source,
    score: Number(r.score.toFixed(3)),
  }));
}

module.exports = { search, tokenize };
