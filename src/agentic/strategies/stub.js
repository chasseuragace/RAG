class StubRetrievalStrategy {
  constructor(sequence = []) {
    this.sequence = sequence;
    this.index = 0;
  }

  async run(observation, maxIterations) {
    let obs = { ...observation, previousActions: [] };
    for (let i = 0; i < maxIterations; i++) {
      const next = this.sequence[this.index] || { finalAction: { type: 'stop', reason: 'sequence_exhausted' } };
      this.index++;
      obs = {
        ...obs,
        previousActions: [...obs.previousActions, ...(next.steps || [])],
      };
      if (next.finalAction) {
        return {
          ...obs,
          ...next,
          rerankedResults: next.rerankedResults || [],
          previousActions: obs.previousActions,
        };
      }
    }
    return {
      ...obs,
      finalAction: { type: 'stop', reason: 'max_iterations_reached' },
      rerankedResults: [],
      previousActions: obs.previousActions,
    };
  }

  reset() { this.index = 0; }
}

module.exports = { StubRetrievalStrategy };
