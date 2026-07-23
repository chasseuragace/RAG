const { ConstrainedPlanner } = require('../planner');
const { RetrievalExecutor } = require('../executor');
const { RetrievalJudge } = require('../judge');
const { serverEvents } = require('../../events');

class HeuristicRetrievalStrategy {
  constructor(embedder, hybridStore, reranker, config = {}) {
    this.planner = new ConstrainedPlanner(config);
    this.executor = new RetrievalExecutor(embedder, hybridStore, reranker);
    this.judge = new RetrievalJudge(config);
  }

  async run(observation, maxIterations = 4) {
    const start = Date.now();
    serverEvents.logEvent('agentic:strategy:start', { query: observation.query, maxIterations });

    let obs = observation;
    for (let i = 0; i < maxIterations; i++) {
      obs = new observation.constructor({ ...obs, iteration: i });

      const action = await this.planner.decide(obs);
      obs = obs.withAction(action);
      serverEvents.logEvent('agentic:action', { iteration: i, action: action.type, reason: action.reason });

      if (action.type === 'answer' || action.type === 'stop') {
        serverEvents.logEvent('agentic:strategy:complete', { iterations: i + 1, action: action.type, reason: action.reason });
        return { ...obs, finalAction: action, duration: `${Date.now() - start}ms` };
      }

      obs = await this.executor.execute(action, obs);

      const judgment = await this.judge.evaluate(obs);
      obs = { ...obs, judgment, retrievalQuality: judgment.quality, missingEvidence: judgment.missing };

      if (judgment.sufficient) {
        serverEvents.logEvent('agentic:strategy:complete', { iterations: i + 1, action: 'answer', reason: judgment.reason });
        return { ...obs, finalAction: { type: 'answer', reason: judgment.reason }, duration: `${Date.now() - start}ms` };
      }
    }

    const fallbackAction = { type: 'stop', reason: 'max_iterations_reached' };
    serverEvents.logEvent('agentic:strategy:complete', { iterations: maxIterations, action: 'stop', reason: fallbackAction.reason });
    return { ...obs, finalAction: fallbackAction, duration: `${Date.now() - start}ms` };
  }
}

module.exports = { HeuristicRetrievalStrategy };
