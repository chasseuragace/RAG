const { Coordinator } = require('../coordinator');
const { RetrievalJudge } = require('../judge');
const { HeuristicRetrievalPolicy } = require('../policies/heuristic');
const { RetrievalExecutor } = require('../executor');
const { serverEvents } = require('../../shared/events');

class HeuristicRetrievalStrategy {
  constructor(embedder, hybridStore, reranker, config = {}) {
    this.embedder = embedder;
    this.hybridStore = hybridStore;
    this.reranker = reranker;
    this.config = config;
  }

  async run(observation, maxIterations) {
    const judge = new RetrievalJudge(this.config);
    const policy = new HeuristicRetrievalPolicy(this.config);
    const executor = new RetrievalExecutor(this.embedder, this.hybridStore, this.reranker);
    const coordinator = new Coordinator(judge, policy, executor);

    serverEvents.logEvent('agentic:strategy:start', { query: observation.query, maxIterations });
    return coordinator.run(observation, { ...observation.goal, maxIterations });
  }
}

module.exports = { HeuristicRetrievalStrategy };
