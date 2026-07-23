const { RetrievalPolicy } = require('../policy');
const { Decision } = require('../decision');
const { serverEvents } = require('../../events');

/**
 * AggressiveRetrievalPolicy — maximises recall.
 *
 * Biased toward fetching more documents rather than answering early.
 * Will expand topK and rewrite the query before settling for an answer.
 * Suited to `MAXIMIZE_RECALL` objectives where latency is not a concern.
 */
class AggressiveRetrievalPolicy extends RetrievalPolicy {
  constructor(config = {}) {
    super();
    // Only answer if quality and completeness are both high.
    this.answerQualityThreshold = config.answerQualityThreshold || 0.75;
    this.answerCompletenessThreshold = config.answerCompletenessThreshold || 0.75;
    this.lowScoreThreshold = config.lowScoreThreshold || 0.4;
    this.maxRewrites = config.maxRewrites || 2;
  }

  resolve(assessment, goal, trace) {
    const { missingEvidence, completeness, quality, sourceDiversity } = assessment;

    const rewriteCount = trace
      ? trace.events.filter(e => (e.action?.action || e.action?.type) === 'rewrite_query').length
      : 0;

    // Only answer when evidence is genuinely strong.
    if (
      quality >= this.answerQualityThreshold &&
      completeness >= this.answerCompletenessThreshold
    ) {
      serverEvents.logEvent('agentic:policy:aggressive', { action: 'answer', quality, completeness });
      return Decision.create(
        'answer',
        `high_confidence_evidence: quality=${quality.toFixed(2)}, completeness=${completeness.toFixed(2)}`,
        { quality, completeness, sourceDiversity },
        'normal'
      );
    }

    // Prefer rewriting first (up to maxRewrites) to improve term coverage.
    if (rewriteCount < this.maxRewrites && missingEvidence.missingConcepts.length > 0) {
      serverEvents.logEvent('agentic:policy:aggressive', { action: 'rewrite_query', rewriteCount });
      return Decision.create(
        'rewrite_query',
        `Expanding query coverage: ${missingEvidence.missingConcepts.slice(0, 2).join(', ')}`,
        { missingConcepts: missingEvidence.missingConcepts, rewriteCount, maxRewrites: this.maxRewrites },
        'high'
      );
    }

    // Fall back to fetching more documents.
    serverEvents.logEvent('agentic:policy:aggressive', { action: 'increase_topk', quality, completeness });
    return Decision.create(
      'increase_topk',
      `Maximising recall: quality=${quality.toFixed(2)}, completeness=${completeness.toFixed(2)} still below thresholds`,
      { quality, completeness, sourceDiversity, thresholds: { quality: this.answerQualityThreshold, completeness: this.answerCompletenessThreshold } },
      'high'
    );
  }
}

module.exports = { AggressiveRetrievalPolicy };
