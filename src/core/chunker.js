/**
 * Deterministic, per-document text chunking. Boundaries depend only on the
 * input text (paragraph > sentence > word fallback), never on neighboring
 * documents — so a single file change ripples only that file's chunks.
 */
const { CHUNK_SIZE, CHUNK_OVERLAP } = require('../config');

function chunkText(text, maxSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  if (text.length <= maxSize) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxSize;
    if (end >= text.length) {
      chunks.push(text.slice(start));
      break;
    }
    // try to cut at paragraph or sentence boundary
    let cut = text.lastIndexOf('\n\n', end);
    if (cut <= start) cut = text.lastIndexOf('. ', end);
    if (cut <= start) cut = text.lastIndexOf(' ', end);
    if (cut <= start) cut = end;
    chunks.push(text.slice(start, cut));
    start = cut - overlap;
    if (start < 0) start = 0;
  }
  return chunks;
}

module.exports = { chunkText };
