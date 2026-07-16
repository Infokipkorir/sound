// knowledge.js
// Loads every file under /training into a single in-memory array of
// { id, source, title, text } chunks that search.js can query.
// Runs once at server boot (see server.js) — not per-request — so adding
// new files just means restarting the server, no rebuild step needed.

const fs = require('fs');
const path = require('path');
const { marked } = require('marked');

const TRAINING_DIR = path.join(__dirname, 'training');

let knowledgeBase = []; // populated by loadKnowledgeBase()

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function chunkText(text, source, maxChars = 800) {
  // Splits long documents into overlapping-free paragraph chunks so
  // search.js can rank individual sections instead of whole documents.
  const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const chunks = [];
  let buffer = '';

  for (const para of paragraphs) {
    if ((buffer + '\n\n' + para).length > maxChars && buffer) {
      chunks.push(buffer.trim());
      buffer = para;
    } else {
      buffer = buffer ? `${buffer}\n\n${para}` : para;
    }
  }
  if (buffer.trim()) chunks.push(buffer.trim());

  return chunks.map((text, i) => ({
    id: `${source}#${i}`,
    source,
    title: path.basename(source),
    text,
  }));
}

async function loadMarkdown(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const html = marked.parse(raw);
  return chunkText(stripHtml(html), filePath);
}

async function loadTxt(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return chunkText(raw, filePath);
}

async function loadJson(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  // Expected shape: [{ question, answer }, ...] or { entries: [...] }
  const entries = Array.isArray(raw) ? raw : raw.entries || [];
  return entries.map((entry, i) => ({
    id: `${filePath}#${i}`,
    source: filePath,
    title: entry.question || path.basename(filePath),
    text: entry.answer ? `${entry.question}\n${entry.answer}` : JSON.stringify(entry),
  }));
}

async function loadPdf(filePath) {
  // pdf-parse is required lazily so the server still boots even if a
  // dependency is missing and no PDFs are present in /training yet.
  const pdfParse = require('pdf-parse');
  const buffer = fs.readFileSync(filePath);
  const data = await pdfParse(buffer);
  return chunkText(data.text, filePath);
}

async function loadDocx(filePath) {
  const mammoth = require('mammoth');
  const { value: html } = await mammoth.convertToHtml({ path: filePath });
  return chunkText(stripHtml(html), filePath);
}

async function loadFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  try {
    switch (ext) {
      case '.md': return await loadMarkdown(filePath);
      case '.txt': return await loadTxt(filePath);
      case '.json': return await loadJson(filePath);
      case '.pdf': return await loadPdf(filePath);
      case '.docx': return await loadDocx(filePath);
      default: return [];
    }
  } catch (err) {
    console.warn(`knowledge.js: failed to load ${filePath}: ${err.message}`);
    return [];
  }
}

function walk(dir) {
  let files = [];
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files = files.concat(walk(full));
    else files.push(full);
  }
  return files;
}

async function loadKnowledgeBase() {
  const files = walk(TRAINING_DIR);
  const chunkLists = await Promise.all(files.map(loadFile));
  knowledgeBase = chunkLists.flat();
  console.log(`knowledge.js: loaded ${knowledgeBase.length} chunks from ${files.length} files`);
  return knowledgeBase;
}

function getKnowledgeBase() {
  return knowledgeBase;
}

module.exports = { loadKnowledgeBase, getKnowledgeBase };
