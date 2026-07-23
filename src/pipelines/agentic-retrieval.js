const { RetrievalPipeline } = require('../core/interfaces');
const { Observation } = require('../agentic/observation');
const { Coordinator } = require('../agentic/coordinator');
const { RetrievalJudge } = require('../agentic/judge');
const { RetrievalPolicy } = require('../agentic/policy');
const { HeuristicRetrievalPolicy } = require('../agentic/policies/heuristic');
const { RetrievalExecutor } = require('../agentic/executor');
const { serverEvents } = require('../events');

class AgenticRetrievalPipeline extends RetrievalPipeline {
  constructor(embedder, hybridStore, reranker, strategyOrGoal, policyOrMaxSteps) {
    super(embedder, hybridStore);
    this.embedder = embedder;
    this.hybridStore = hybridStore;
    this.reranker = reranker;
    if (strategyOrGoal && typeof strategyOrGoal.run === 'function') {
      this.strategy = strategyOrGoal;
      this.goal = typeof policyOrMaxSteps === 'number'
        ? { objective: 'BALANCED', latencyBudget: 5000, maxIterations: policyOrMaxSteps, minimumQuality: 0.5 }
        : { objective: 'BALANCED', latencyBudget: 5000, maxIterations: 2, minimumQuality: 0.5 };
    } else {
      this.goal = strategyOrGoal || { objective: 'BALANCED', latencyBudget: 5000, maxIterations: 2, minimumQuality: 0.5 };
      this.strategy = { run: this._createStrategy(embedder, hybridStore, reranker, policyOrMaxSteps) };
    }
  }

  _createStrategy(embedder, hybridStore, reranker, policy) {
    const judge = new RetrievalJudge();
    const policyInstance = policy || new HeuristicRetrievalPolicy();
    const executor = new RetrievalExecutor(embedder, hybridStore, reranker);
    const coordinator = new Coordinator(judge, policyInstance, executor);
    return async (observation, maxIterations) => coordinator.run(observation, { ...this.goal, maxIterations });
  }

  async run(query, topK = 5) {
    const start = Date.now();
    serverEvents.logEvent('agentic:start', { query, maxIterations: this.goal.maxIterations, objective: this.goal.objective });
    try {
      const observation = Observation.create(query, topK, this.goal);
      const result = await this.strategy.run(observation, this.goal.maxIterations);
      const final = result.decision ? result.rerankedResults.slice(0, topK) : [];
      const duration = Date.now() - start;
      serverEvents.logEvent('agentic:complete', {
        steps: (result.trace ? result.trace.events.filter(e => e.phase === 'execute').length : 0),
        finalCount: final.length,
        duration,
        finalAction: result.finalAction
      });
      return {
        success: true,
        query,
        resultsCount: final.length,
        duration: `${duration}ms`,
        assessment: result.assessment ? { quality: result.assessment.quality, completeness: result.assessment.completeness, consistency: result.assessment.consistency, sourceDiversity: result.assessment.sourceDiversity, missingEvidence: result.assessment.missingEvidence } : null,
        decision: result.decision ? { action: result.decision.action, rationale: result.decision.rationale, evidence: result.decision.evidence, priority: result.decision.priority } : null,
        finalAction: result.finalAction,
        trace: result.trace ? result.trace.toArray() : [],
        goal: result.goal || this.goal,
        steps: result.trace ? result.trace.toArray() : [],
        results: final.map(r => ({ id: r.id, relevance: (r.score * 100).toFixed(2) + '%', metadata: r.metadata, rerankReason: r.rerankReason }))
      };
    } catch (err) {
      serverEvents.logEvent('error', { stage: 'agentic', message: err.message });
      return { success: false, error: err.message, duration: `${Date.now() - start}ms` };
    }
  }
}

module.exports = { AgenticRetrievalPipeline };
