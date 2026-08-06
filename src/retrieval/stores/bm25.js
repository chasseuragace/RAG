const { KeywordStore } = require('../../shared/interfaces');
const { serverEvents } = require('../../shared/events');

class BM25Store extends KeywordStore {
  constructor(k1 = 1.2, b = 0.75) {
    super();
    this.k1 = k1;
    this.b = b;
    this.documents = new Map();
    this.invertedIndex = new Map();
    this.docLengths = new Map();
    this.totalDocs = 0;
    this.avgDocLength = 0;
  }

  _tokenize(text) {
    return (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(t => t.length > 2);
  }

  async index(id, content, metadata = {}) {
    this.documents.set(id, { content: content || '', metadata });
    const tokens = this._tokenize(content || '');
    const freqs = new Map();
    for (const t of tokens) freqs.set(t, (freqs.get(t) || 0) + 1);
    for (const [term, freq] of freqs) {
      if (!this.invertedIndex.has(term)) this.invertedIndex.set(term, []);
      this.invertedIndex.get(term).push({ docId: id, freq });
    }
    this.docLengths.set(id, tokens.length);
    this.totalDocs = this.documents.size;
    this.avgDocLength = Array.from(this.docLengths.values()).reduce((a, b) => a + b, 0) / (this.totalDocs || 1);
    serverEvents.logEvent('bm25:indexed', { id, termCount: freqs.size });
  }

  async search(query, topK = 10) {
    const start = Date.now();
    const terms = this._tokenize(query);
    const scores = new Map();
    for (const term of terms) {
      const postings = this.invertedIndex.get(term);
      if (!postings) continue;
      const df = postings.length;
      const idf = Math.log((this.totalDocs - df + 0.5) / (df + 0.5) + 1);
      for (const { docId, freq } of postings) {
        const dl = this.docLengths.get(docId) || 0;
        const tf = (freq * (this.k1 + 1)) / (freq + this.k1 * (1 - this.b + this.b * (dl / (this.avgDocLength || 1))));
        scores.set(docId, (scores.get(docId) || 0) + idf * tf);
      }
    }
    const results = [];
    for (const [id, score] of scores) {
      const doc = this.documents.get(id);
      if (doc) results.push({ id, score, metadata: doc.metadata });
    }
    const sorted = results.sort((a, b) => b.score - a.score).slice(0, topK);
    serverEvents.logEvent('bm25:search', { query, resultsCount: sorted.length, duration: Date.now() - start });
    return sorted;
  }

  async clear() {
    this.documents.clear();
    this.invertedIndex.clear();
    this.docLengths.clear();
    this.totalDocs = 0;
    this.avgDocLength = 0;
    serverEvents.logEvent('bm25:cleared', {});
  }

  async deleteByDocId(docId) {
    const doc = this.documents.get(docId);
    if (!doc) return 0;
    const tokens = this._tokenize(doc.content);
    const termFreqs = new Map();
    for (const t of tokens) termFreqs.set(t, (termFreqs.get(t) || 0) + 1);
    let removed = 0;
    for (const [term, freq] of termFreqs) {
      const postings = this.invertedIndex.get(term);
      if (postings) {
        const idx = postings.findIndex(p => p.docId === docId);
        if (idx >= 0) { postings.splice(idx, 1); removed++; }
      }
    }
    this.documents.delete(docId);
    this.docLengths.delete(docId);
    this.totalDocs = this.documents.size;
    this.avgDocLength = Array.from(this.docLengths.values()).reduce((a, b) => a + b, 0) / (this.totalDocs || 1);
    serverEvents.logEvent('bm25:deleted', { docId, removed });
    return removed;
  }

  async getStats() {
    return { totalDocuments: this.totalDocs, avgDocLength: this.avgDocLength.toFixed(1) };
  }
}

module.exports = { BM25Store };
