class Observation {
  constructor({ query, originalQuery, topK, results = [], rerankedResults = [], previousActions = [], iteration = 0, topScore = 0, assessment = null, decision = null, trace = null, goal = null }) {
    this.query = query;
    this.originalQuery = originalQuery || query;
    this.topK = topK;
    this.results = results;
    this.rerankedResults = rerankedResults;
    this.previousActions = previousActions;
    this.iteration = iteration;
    this.topScore = topScore;
    this.assessment = assessment;
    this.decision = decision;
    this.trace = trace || new (require('./trace').Trace)();
    this.goal = goal;
  }

  static create(query, topK = 5, goal = null) {
    return new Observation({ query, originalQuery: query, topK, goal });
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
