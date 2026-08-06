const { Reranker } = require('../../shared/interfaces');
const { serverEvents } = require('../../shared/events');

class MockReranker extends Reranker {
  constructor() { super(); }

  async rerank(query, documents) {
    const start = Date.now();
    const queryTerms = new Set(query.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(t => t.length > 0));
    const scored = documents.map((doc, idx) => {
      const content = (doc.metadata.content || '').toLowerCase();
      const terms = content.split(/\s+/);
      let overlap = 0;
      for (const t of terms) {
        if (queryTerms.has(t)) overlap++;
      }
      const wordOverlapScore = overlap / (queryTerms.size || 1);
      const positionBonus = idx === 0 ? 0.05 : 0;
      const newScore = Math.min(1, Math.max(0, (doc.score * 0.6) + (wordOverlapScore * 0.4) + positionBonus));
      return {
        ...doc,
        score: newScore,
        rerankReason: `overlap=${overlap},factor=${wordOverlapScore.toFixed(2)}`
      };
    });
    const results = scored.sort((a, b) => b.score - a.score);
    serverEvents.logEvent('rerank:complete', { inputCount: documents.length, outputCount: results.length, topScore: results[0]?.score, duration: Date.now() - start });
    return results;
  }
}

module.exports = { MockReranker };
