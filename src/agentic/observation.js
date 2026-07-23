class Observation {
  constructor({ query, originalQuery, topK, results = [], rerankedResults = [], previousActions = [], iteration = 0, topScore = 0, retrievalQuality = 0, missingEvidence = [], judgment = null, finalAction = null }) {
    this.query = query;
    this.originalQuery = originalQuery || query;
    this.topK = topK;
    this.results = results;
    this.rerankedResults = rerankedResults;
    this.previousActions = previousActions;
    this.iteration = iteration;
    this.topScore = topScore;
    this.retrievalQuality = retrievalQuality;
    this.missingEvidence = missingEvidence;
    this.judgment = judgment;
    this.finalAction = finalAction;
  }

  static create(query, topK = 5) {
    return new Observation({ query, originalQuery: query, topK });
  }

  withResults(results) {
    const topScore = results.length > 0 ? results[0].score : 0;
    return new Observation({
      ...this,
      results,
      rerankedResults: results,
      topScore,
      iteration: this.iteration + 1,
      previousActions: [...this.previousActions, { type: 'search', query: this.query, resultCount: results.length, topScore }]
    });
  }

  withAction(action) {
    return new Observation({
      ...this,
      previousActions: [...this.previousActions, { ...action, iteration: this.iteration }]
    });
  }
}

module.exports = { Observation };
