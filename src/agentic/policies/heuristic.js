const { RetrievalPolicy } = require('../policy');
const { Decision } = require('../decision');
const { serverEvents } = require('../../events');

class HeuristicRetrievalPolicy extends RetrievalPolicy {
  constructor(config = {}) {
    super();
    this.minResultsForAnswer = config.minResultsForAnswer || 2;
    this.lowScoreThreshold = config.lowScoreThreshold || 0.3;
    this.mediumScoreThreshold = config.mediumScoreThreshold || 0.5;
    this.maxRewrites = config.maxRewrites || 1;
  }

  resolve(assessment, goal, trace) {
    const { missingEvidence, completeness, quality, sourceDiversity } = assessment;

    if (goal.finalPass) {
      if (quality >= this.mediumScoreThreshold) {
        return Decision.create(
          'answer',
          `final_pass: quality=${quality.toFixed(2)}, completeness=${completeness.toFixed(2)}`,
          { quality, completeness, sourceDiversity },
          'normal'
        );
      }
      return Decision.create(
        'stop',
        `final_pass: quality=${quality.toFixed(2)} below threshold, no more iterations`,
        { quality, threshold: this.mediumScoreThreshold },
        'high'
      );
    }

    if (quality >= this.mediumScoreThreshold && completeness >= 0.6) {
      return Decision.create(
        'answer',
        `sufficient_evidence: quality=${quality.toFixed(2)}, completeness=${completeness.toFixed(2)}`,
        { quality, completeness, sourceDiversity },
        'normal'
      );
    }

    if (quality < this.lowScoreThreshold) {
      return Decision.create(
        'increase_topk',
        'Recall appears low: top relevance below threshold',
        { topScore: quality, threshold: this.lowScoreThreshold },
        'high'
      );
    }

    if (completeness < 0.4 && sourceDiversity < 2) {
      return Decision.create(
        'rewrite_query',
        'Coverage appears low: few distinct sources and incomplete coverage',
        { completeness, sourceDiversity, missingConcepts: missingEvidence.missingConcepts },
        'normal'
      );
    }

    if (completeness < 0.6 && sourceDiversity >= 2) {
      return Decision.create(
        'increase_topk',
        'Precision appears weak: several sources but incomplete coverage',
        { completeness, sourceDiversity },
        'normal'
      );
    }

    return Decision.create(
      'answer',
      'fallback: returning best available evidence',
      { quality, completeness },
      'low'
    );
  }
}

module.exports = { HeuristicRetrievalPolicy };
