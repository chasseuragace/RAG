const { serverEvents } = require('../events');

class RetrievalJudge {
  constructor(config = {}) {
    this.sufficientThreshold = config.sufficientThreshold || 0.6;
    this.maxMissingItems = config.maxMissingItems || 3;
    this.minDocsForSufficiency = config.minDocsForSufficiency || 2;
  }

  async evaluate(observation) {
    const { results, rerankedResults, query, originalQuery, previousActions } = observation;
    const topResults = rerankedResults.length > 0 ? rerankedResults : results;
    const topScore = topResults.length > 0 ? topResults[0].score : 0;

    const quality = this._retrievalQuality(topResults, topScore);
    const missing = this._identifyMissing(topResults, query);
    const sufficient = topResults.length >= this.minDocsForSufficiency && quality >= this.sufficientThreshold;

    const judgment = {
      sufficient,
      quality,
      missing,
      reason: sufficient
        ? `quality=${quality.toFixed(2)}, docs=${topResults.length}`
        : `quality=${quality.toFixed(2)} below ${this.sufficientThreshold}, docs=${topResults.length} < ${this.minDocsForSufficiency}`
    };

    serverEvents.logEvent('agentic:judge', { sufficient, quality, missing: missing.length, reason: judgment.reason });
    return judgment;
  }

  _retrievalQuality(results, topScore) {
    const scoreComponent = Math.min(1, topScore);
    const coverageComponent = Math.min(1, results.length / 5);
    return scoreComponent * 0.6 + coverageComponent * 0.4;
  }

  _identifyMissing(results, query) {
    const missing = [];
    if (results.length === 0) {
      missing.push('no_retrieved_documents');
    } else if (results.length < this.minDocsForSufficiency) {
      missing.push(`only_${results.length}_document_found`);
    }
    if (results.length > 0 && results[0].score < 0.3) {
      missing.push('low_relevance_top_result');
    }
    const queryTerms = new Set(query.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(t => t.length > 2));
    const coveredTerms = new Set();
    for (const r of results) {
      const content = (r.metadata && r.metadata.content || '').toLowerCase();
      for (const t of content.split(/\s+/)) {
        if (queryTerms.has(t)) coveredTerms.add(t);
      }
    }
    const uncovered = [...queryTerms].filter(t => !coveredTerms.has(t)).slice(0, this.maxMissingItems);
    if (uncovered.length > 0) {
      missing.push(`uncovered_query_terms: ${uncovered.join(', ')}`);
    }
    return missing.slice(0, this.maxMissingItems);
  }
}

module.exports = { RetrievalJudge };
