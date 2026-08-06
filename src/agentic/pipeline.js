const { RetrievalPipeline } = require('../shared/interfaces');
const { Observation } = require('./observation');
const { Coordinator } = require('./coordinator');
const { RetrievalJudge, LLMJudge } = require('./judge');
const { RetrievalPolicy } = require('./policy');
const { HeuristicRetrievalPolicy } = require('./policies/heuristic');
const { RetrievalExecutor } = require('./executor');
const { serverEvents } = require('../shared/events');

class AgenticRetrievalPipeline extends RetrievalPipeline {
  constructor(embedder, hybridStore, reranker, goal, policy, judge, queryRewriter, unifiedPipeline = null, threadManager = null, contextWindowManager = null, options = {}) {
    super(embedder, hybridStore);
    this.embedder = embedder;
    this.hybridStore = hybridStore;
    this.reranker = reranker;
    this.goal = goal || {
      objective: 'BALANCED',
      latencyBudget: 5000,
      maxIterations: 2,
      minimumQuality: 0.5
    };
    this.threadManager = threadManager;
    this.contextWindowManager = contextWindowManager;
    this.systemPrompt = options.systemPrompt || 'You are a helpful retrieval assistant.';
    this.responseMaxTokens = options.responseMaxTokens || 1000;
    this._sessionId = null;
    this.strategy = { run: this._createStrategy(embedder, hybridStore, reranker, policy, judge, queryRewriter, unifiedPipeline, threadManager, contextWindowManager) };
  }

  _createStrategy(embedder, hybridStore, reranker, policy, judge, queryRewriter, unifiedPipeline, threadManager, contextWindowManager) {
    const judgeInstance = judge || new RetrievalJudge();
    const policyInstance = policy || new HeuristicRetrievalPolicy();
    const executor = new RetrievalExecutor(embedder, hybridStore, reranker, queryRewriter, unifiedPipeline);
    const coordinator = new Coordinator(judgeInstance, policyInstance, executor, threadManager, contextWindowManager, {
      systemPrompt: this.systemPrompt,
      responseMaxTokens: this.responseMaxTokens,
    });
    return async (observation, maxIterations) => coordinator.run(observation, { ...this.goal, maxIterations });
  }

  async run(query, topK = 5, sessionId = null, abortSignal = null) {
    const start = Date.now();
    if (!this._sessionId) {
      this._sessionId = sessionId || `sess_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
    }
    const sid = this._sessionId;
    serverEvents.logEvent('agentic:start', { query, maxIterations: this.goal.maxIterations, objective: this.goal.objective, sessionId: sid });
    try {
      if (abortSignal) abortSignal.throwIfAborted();
      const observation = Observation.create(query, topK, this.goal, sid);
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
        results: final.map(r => ({ id: r.id, relevance: (r.score * 100).toFixed(2) + '%', score: r.score, metadata: r.metadata, rerankReason: r.rerankReason }))
      };
    } catch (err) {
      serverEvents.logEvent('error', { stage: 'agentic', message: err.message });
      return { success: false, error: err.message, duration: `${Date.now() - start}ms` };
    }
  }
}

module.exports = { AgenticRetrievalPipeline };
