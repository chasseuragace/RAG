const { Embedder } = require('../../shared/interfaces');
const { serverEvents } = require('../../shared/events');

class GeminiEmbedder extends Embedder {
  constructor(apiKey = null) {
    super();
    this.apiKey = apiKey || process.env.GEMINI_API_KEY || process.env.AI_STUDIO_API_KEY;
    if (!this.apiKey) throw new Error('Gemini API key required');
    this.callCount = 0;
  }
  async embed(text) {
    this.callCount++;
    const start = Date.now();
    const res = await fetch(`https://generativelanguage.googleapis.com/v1/models/gemini-embedding-2:embedContent?key=${this.apiKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { parts: [{ text }] } })
    });
    if (!res.ok) throw new Error(`Gemini API error: ${res.status}`);
    const data = await res.json();
    const embedding = data.embedding.values;
    serverEvents.logEvent('embedding:complete', { textLength: text.length, duration: Date.now()-start });
    return embedding;
  }
  async embedBatch(texts) {
    const start = Date.now();
    const chunkSize = 100;
    const results = [];
    for (let i = 0; i < texts.length; i += chunkSize) {
      const chunk = texts.slice(i, i+chunkSize);
      const res = await fetch(`https://generativelanguage.googleapis.com/v1/models/gemini-embedding-2:batchEmbedContents?key=${this.apiKey}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: chunk.map(t => ({ model: 'models/gemini-embedding-2', content: { parts: [{ text: t }] } })) })
      });
      if (!res.ok) throw new Error(`Gemini batch error: ${res.status}`);
      const data = await res.json();
      results.push(...data.embeddings.map(e => e.values));
    }
    serverEvents.logEvent('embedding:batch', { count: texts.length, duration: Date.now()-start });
    return results;
  }
  getCallCount() { return this.callCount; }
}

module.exports = { GeminiEmbedder };
