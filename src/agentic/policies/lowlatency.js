const { RetrievalPolicy } = require('../policy');
const { Decision } = require('../decision');
const { serverEvents } = require('../../events');

/**
 * LowLatencyPolicy — answers as fast as possible.
 *
 * Uses a very low quality threshold and never rewrites the query.
 * Suited to `MINIMIZE_LATENCY` objectives where speed trumps precision.
 */
class LowLatencyPolicy extends RetrievalPolicy {
  constructor(config = {}) {
    super();
    // Answer even with mediocre quality.
    this.answerQualityThreshold = config.answerQualityThreshold || 0.3;
    this.emptyCorpusThreshold = config.emptyCorpusThreshold || 0.05;
  }

  resolve(assessment, goal, trace) {
    const { quality, completeness, sourceDiversity } = assessment;

    // Check if retrieval has already been attempted (execute events in trace).
    const hasAttemptedRetrieval = trace
      ? trace.events.some(e => e.phase === 'execute')
      : false;

    // If retrieval ran and still found nothing — give up.
    if (hasAttemptedRetrieval && quality <= this.emptyCorpusThreshold) {
      serverEvents.logEvent('agentic:policy:lowlatency', { action: 'stop', reason: 'empty_or_irrelevant_corpus' });
      return Decision.create(
        'stop',
        `empty_or_irrelevant_corpus: quality=${quality.toFixed(2)} at or below floor threshold`,
        { quality, threshold: this.emptyCorpusThreshold },
        'high'
      );
    }

    // Answer immediately once we have anything usable — no rewrites, no topK expansion.
    if (quality >= this.answerQualityThreshold) {
      serverEvents.logEvent('agentic:policy:lowlatency', { action: 'answer', quality });
      return Decision.create(
        'answer',
        `fast_answer: quality=${quality.toFixed(2)} meets low-latency threshold`,
        { quality, completeness, sourceDiversity, threshold: this.answerQualityThreshold },
        'high'
      );
    }

    // No results yet or quality below threshold — do one topK expansion.
    // Never rewrite; that would cost extra latency.
    serverEvents.logEvent('agentic:policy:lowlatency', { action: 'increase_topk', quality });
    return Decision.create(
      'increase_topk',
      `Single recall boost: quality=${quality.toFixed(2)} below threshold, no rewrite allowed`,
      { quality, threshold: this.answerQualityThreshold },
      'normal'
    );
  }
}

module.exports = { LowLatencyPolicy };
