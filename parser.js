// parser.js
// Standalone document-to-text parsers, separate from knowledge.js's
// loading/chunking logic. knowledge.js handles *what* gets loaded and
// *when*; parser.js handles *how* to turn one file's bytes into text.
// Kept separate so these functions are reusable (e.g. an admin upload
// endpoint could call parsePdf() directly without going through the
// whole knowledge-base reload).

const fs = require('fs');

async function parsePdf(filePath) {
  const pdfParse = require('pdf-parse');
  const buffer = fs.readFileSync(filePath);
  const data = await pdfParse(buffer);
  return { text: data.text, pages: data.numpages };
}

async function parseDocx(filePath) {
  const mammoth = require('mammoth');
  const { value: html, messages } = await mammoth.convertToHtml({ path: filePath });
  return { html, text: html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(), warnings: messages };
}

async function parseExcel(filePath) {
  const XLSX = require('xlsx');
  const workbook = XLSX.readFile(filePath);
  const sheets = {};
  for (const sheetName of workbook.SheetNames) {
    sheets[sheetName] = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
  }
  return sheets;
}

// OCR-ready hook: not implemented by default (keeps the system dependency
// -light and API-free), but the interface is here so knowledge.js can
// call parseImageOcr() the same way it calls the other parsers once you
// wire in pytesseract-equivalent tooling (e.g. tesseract.js) — see
// Chapter 16, "Future upgrades".
async function parseImageOcr(filePath) {
  throw new Error(
    'OCR is not enabled. Install tesseract.js and implement parseImageOcr() to add scanned-document support.'
  );
}

module.exports = { parsePdf, parseDocx, parseExcel, parseImageOcr };
