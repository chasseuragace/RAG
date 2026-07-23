const { RetrievalPolicy } = require('../policy');
const { Decision } = require('../decision');
const { serverEvents } = require('../../events');

/**
 * BalancedPolicy — the production default.
 *
 * Balances quality, completeness, and latency. Mirrors the overall system
 * goal of `BALANCED` objectives but is a first-class, explicit policy rather
 * than the catch-all heuristic. Replaces `HeuristicRetrievalPolicy` as the
 * recommended default going forward.
 */
class BalancedPolicy extends RetrievalPolicy {
  constructor(config = {}) {
    super();
    this.answerQualityThreshold = config.answerQualityThreshold || 0.5;
    this.answerCompletenessThreshold = config.answerCompletenessThreshold || 0.6;
    this.lowScoreThreshold = config.lowScoreThreshold || 0.3;
    this.lowCoverageThreshold = config.lowCoverageThreshold || 0.4;
    this.maxRewrites = config.maxRewrites || 1;
  }

  resolve(assessment, goal, trace) {
    const { missingEvidence, completeness, quality, sourceDiversity } = assessment;

    const rewriteCount = trace
      ? trace.events.filter(e => (e.action?.action || e.action?.type) === 'rewrite_query').length
      : 0;

    // Sufficient evidence on both dimensions — answer.
    if (quality >= this.answerQualityThreshold && completeness >= this.answerCompletenessThreshold) {
      serverEvents.logEvent('agentic:policy:balanced', { action: 'answer', quality, completeness });
      return Decision.create(
        'answer',
        `sufficient_evidence: quality=${quality.toFixed(2)}, completeness=${completeness.toFixed(2)}`,
        { quality, completeness, sourceDiversity, thresholds: { quality: this.answerQualityThreshold, completeness: this.answerCompletenessThreshold } },
        'normal'
      );
    }

    // Very low quality — expand retrieval set.
    if (quality < this.lowScoreThreshold) {
      serverEvents.logEvent('agentic:policy:balanced', { action: 'increase_topk', reason: 'low_quality' });
      return Decision.create(
        'increase_topk',
        `Recall boost: quality=${quality.toFixed(2)} below floor threshold`,
        { quality, threshold: this.lowScoreThreshold },
        'high'
      );
    }

    // Low coverage with few sources — try a different query formulation.
    if (
      completeness < this.lowCoverageThreshold &&
      sourceDiversity < 2 &&
      rewriteCount < this.maxRewrites
    ) {
      serverEvents.logEvent('agentic:policy:balanced', { action: 'rewrite_query', completeness, sourceDiversity });
      return Decision.create(
        'rewrite_query',
        `Coverage appears low: completeness=${completeness.toFixed(2)}, sourceDiversity=${sourceDiversity}`,
        { completeness, sourceDiversity, missingConcepts: missingEvidence.missingConcepts, rewriteCount },
        'normal'
      );
    }

    // Partial completeness with multiple sources — fetch more docs.
    if (completeness < this.answerCompletenessThreshold && sourceDiversity >= 2) {
      serverEvents.logEvent('agentic:policy:balanced', { action: 'increase_topk', reason: 'partial_completeness' });
      return Decision.create(
        'increase_topk',
        `Precision weak: completeness=${completeness.toFixed(2)} with ${sourceDiversity} sources`,
        { completeness, sourceDiversity },
        'normal'
      );
    }

    // Fallback — best available evidence.
    serverEvents.logEvent('agentic:policy:balanced', { action: 'answer', reason: 'fallback' });
    return Decision.create(
      'answer',
      'fallback: returning best available evidence',
      { quality, completeness },
      'low'
    );
  }
}

module.exports = { BalancedPolicy };
