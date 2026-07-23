const { Embedder } = require('../core/interfaces');
const { serverEvents } = require('../events');

class MockEmbedder extends Embedder {
  constructor() { super(); this.callCount = 0; this.cache = new Map(); this.wordVectors = new Map(); this.dim = 384; }
  _hashString(str) { let hash = 0; for (let i = 0; i < str.length; i++) hash = ((hash << 5) - hash) + str.charCodeAt(i); return hash & hash; }
  _getWordVector(word) {
    if (this.wordVectors.has(word)) return this.wordVectors.get(word);
    const seed = this._hashString(word);
    const vec = Array(this.dim).fill(0).map((_, i) => { const r = Math.sin(seed + i * 127.1) * 43758.5453; return r - Math.floor(r); });
    this.wordVectors.set(word, vec);
    return vec;
  }
  async embed(text) {
    this.callCount++;
    if (this.cache.has(text)) return this.cache.get(text);
    const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 1);
    const vectors = words.map(w => this._getWordVector(w));
    const embedding = Array(this.dim).fill(0);
    if (vectors.length > 0) {
      for (let i = 0; i < this.dim; i++) { let sum = 0; for (const v of vectors) sum += v[i]; embedding[i] = sum / vectors.length; }
    }
    const norm = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0)) || 1;
    const normalized = embedding.map(v => v / norm);
    this.cache.set(text, normalized);
    serverEvents.logEvent('embedding:complete', { textLength: text.length, words: words.length });
    return normalized;
  }
  async embedBatch(texts) { return Promise.all(texts.map(t => this.embed(t))); }
  getCallCount() { return this.callCount; }
}

module.exports = { MockEmbedder };
