const { Embedder } = require('../core/interfaces');
const { serverEvents } = require('../events');

class MockEmbedder extends Embedder {
  constructor() { super(); this.callCount = 0; this.cache = new Map(); }
  _hashString(str) { let hash = 0; for (let i = 0; i < str.length; i++) hash = ((hash << 5) - hash) + str.charCodeAt(i); return hash & hash; }
  async embed(text) {
    this.callCount++;
    if (this.cache.has(text)) return this.cache.get(text);
    const seed = this._hashString(text);
    const embedding = Array(384).fill(0).map((_, i) => { const r = Math.sin(seed + i * 12.9898) * 43758.5453; return r - Math.floor(r); });
    this.cache.set(text, embedding);
    serverEvents.logEvent('embedding:complete', { textLength: text.length });
    return embedding;
  }
  async embedBatch(texts) { return Promise.all(texts.map(t => this.embed(t))); }
  getCallCount() { return this.callCount; }
}

module.exports = { MockEmbedder };
