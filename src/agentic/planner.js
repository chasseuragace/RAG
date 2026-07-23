const { serverEvents } = require('../events');

class ConstrainedPlanner {
  constructor(config = {}) {
    this.minResultsForAnswer = config.minResultsForAnswer || 2;
    this.lowScoreThreshold = config.lowScoreThreshold || 0.3;
    this.mediumScoreThreshold = config.mediumScoreThreshold || 0.5;
    this.maxRewrites = config.maxRewrites || 1;
  }

  async decide(observation) {
    const { results, rerankedResults, iteration, previousActions, topScore, query, originalQuery } = observation;
    const actionCount = previousActions.filter(a => a.type === 'search' || a.type === 'increase_topk' || a.type === 'rewrite_query').length;
    const rewritesUsed = previousActions.filter(a => a.type === 'rewrite_query').length;

    if (results.length === 0 && iteration > 0) {
      return {
        type: 'stop',
        reason: 'no_results_after_retrieval',
        detail: 'Hybrid search returned no documents for this query.'
      };
    }

    if (actionCount >= 3) {
      return {
        type: 'stop',
        reason: 'max_actions_reached',
        detail: `Exhausted ${actionCount} retrieval actions without reaching threshold.`
      };
    }

    if (results.length >= this.minResultsForAnswer && topScore >= this.mediumScoreThreshold) {
      return {
        type: 'answer',
        reason: `sufficient_evidence: ${results.length} docs, topScore=${topScore.toFixed(2)}`
      };
    }

    if (results.length > 0 && topScore < this.lowScoreThreshold) {
      return {
        type: 'increase_topk',
        reason: 'low_relevance_score',
        detail: `Top score ${topScore.toFixed(2)} below ${this.lowScoreThreshold}. Expanding recall.`
      };
    }

    if (results.length < 2 && rewritesUsed < this.maxRewrites) {
      return {
        type: 'rewrite_query',
        reason: 'insufficient_results_for_rewrite',
        detail: `Only ${results.length} result(s) found. Attempting query expansion.`
      };
    }

    if (results.length > 0 && query !== originalQuery && results.length < this.minResultsForAnswer) {
      return {
        type: 'increase_topk',
        reason: 'post_rewrite_expansion',
        detail: `Expanding recall after query rewrite.`
      };
    }

    return {
      type: 'answer',
      reason: 'fallback',
      detail: 'Returning best available results.'
    };
  }
}

module.exports = { ConstrainedPlanner };
