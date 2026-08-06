const { Reranker } = require('../../shared/interfaces');
const { serverEvents } = require('../../shared/events');

class CrossEncoderReranker extends Reranker {
  constructor(endpoint = 'http://localhost:8080/rerank', apiKey = null) {
    super();
    this.endpoint = endpoint;
    this.apiKey = apiKey;
  }

  async rerank(query, documents) {
    const start = Date.now();
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey && { Authorization: `Bearer ${this.apiKey}` })
      },
      body: JSON.stringify({
        query,
        documents: documents.map(d => ({ id: d.id, text: d.metadata.content || '' }))
      })
    });
    if (!res.ok) throw new Error(`Reranker error: ${res.status} ${res.statusText}`);
    const data = await res.json();
    const results = documents.map((doc, i) => ({
      ...doc,
      score: data.scores[i],
      rerankReason: 'cross-encoder'
    }));
    serverEvents.logEvent('rerank:complete', { inputCount: documents.length, outputCount: results.length, duration: Date.now() - start });
    return results;
  }
}

module.exports = { CrossEncoderReranker };
