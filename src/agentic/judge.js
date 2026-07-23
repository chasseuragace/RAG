const { serverEvents } = require('../events');
const { RetrievalAssessment } = require('./assessment');

class RetrievalJudge {
  constructor(config = {}) {
    this.sufficientThreshold = config.sufficientThreshold || 0.6;
    this.maxMissingItems = config.maxMissingItems || 3;
    this.minDocsForSufficiency = config.minDocsForSufficiency || 2;
  }

  async evaluate(observation) {
    const { results, rerankedResults, query, previousActions } = observation;
    const topResults = rerankedResults.length > 0 ? rerankedResults : results;
    const topScore = topResults.length > 0 ? topResults[0].score : 0;

    const quality = this._retrievalQuality(topResults, topScore);
    const completeness = this._completeness(topResults, query);
    const consistency = this._consistency(topResults);
    const sourceDiversity = this._sourceDiversity(topResults);
    const missingEvidence = this._missingEvidence(topResults, query);

    serverEvents.logEvent('agentic:judge', {
      quality,
      completeness,
      consistency,
      sourceDiversity,
      missingCount: missingEvidence.missingConcepts.length + missingEvidence.ambiguousTerms.length + missingEvidence.conflictingEvidence.length + missingEvidence.unsupportedClaims.length
    });

    return RetrievalAssessment.create(quality, completeness, consistency, sourceDiversity, missingEvidence);
  }

  _retrievalQuality(results, topScore) {
    const scoreComponent = Math.min(1, topScore);
    const coverageComponent = Math.min(1, results.length / 5);
    return scoreComponent * 0.6 + coverageComponent * 0.4;
  }

  _completeness(results, query) {
    if (results.length === 0) return 0;
    const queryTerms = new Set(query.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(t => t.length > 2));
    if (queryTerms.size === 0) return 1;
    const coveredTerms = new Set();
    for (const r of results) {
      const content = (r.metadata && r.metadata.content || '').toLowerCase();
      for (const t of content.split(/\s+/)) {
        if (queryTerms.has(t)) coveredTerms.add(t);
      }
    }
    return coveredTerms.size / queryTerms.size;
  }

  _consistency(results) {
    if (results.length < 2) return 1;
    const scores = results.map(r => r.score);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length;
    return Math.max(0, 1 - Math.sqrt(variance));
  }

  _sourceDiversity(results) {
    const sources = new Set(results.map(r => r.metadata && r.metadata.original_id));
    return sources.size;
  }

  _missingEvidence(results, query) {
    const missingConcepts = [];
    const ambiguousTerms = [];
    const conflictingEvidence = [];
    const unsupportedClaims = [];

    if (results.length === 0) {
      missingConcepts.push('no_retrieved_documents');
      return { missingConcepts, ambiguousTerms, conflictingEvidence, unsupportedClaims };
    }

    if (results.length < this.minDocsForSufficiency) {
      missingConcepts.push(`only_${results.length}_source_available`);
    }

    if (results[0].score < 0.3) {
      missingConcepts.push('low_relevance_top_result');
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
      missingConcepts.push(`uncovered_query_terms: ${uncovered.join(', ')}`);
    }

    return { missingConcepts, ambiguousTerms, conflictingEvidence, unsupportedClaims };
  }
}

module.exports = { RetrievalJudge };
