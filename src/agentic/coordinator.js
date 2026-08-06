const { serverEvents } = require('../shared/events');
const { Decision } = require('./decision');
const { Trace, TraceEvent } = require('./trace');
const { Message } = require('../shared/interfaces');

class Coordinator {
  constructor(judge, policy, executor, threadManager = null, contextWindowManager = null, options = {}) {
    this.judge = judge;
    this.policy = policy;
    this.executor = executor;
    this.threadManager = threadManager;
    this.contextWindowManager = contextWindowManager;
    this.inference = options.inference || null;
    this.systemPrompt = options.systemPrompt || 'You are a helpful retrieval assistant.';
    this.responseMaxTokens = options.responseMaxTokens || 1000;
    this._addedQueries = new Set();
  }

  // ── Answer generation ──────────────────────────────────────────────────────

  /**
   * Call inference with the built context payload, persist the assistant
   * message to the thread, and return the answer string.
   * Returns null silently if inference is not wired or context is missing.
   */
  async _generateAnswer(obs, abortSignal = null) {
    if (!this.inference) return null;
    if (!obs.contextPayload || !obs.contextPayload.messages) return null;
    try {
      const answer = await this.inference.generateChat(
        obs.contextPayload.messages, {}, abortSignal
      );
      if (this.threadManager && obs.sessionId) {
        const assistantMsg = Message.create('assistant', answer);
        await this.threadManager.addMessage(obs.sessionId, assistantMsg).catch(() => {});
      }
      serverEvents.logEvent('agentic:answer:generated', {
        sessionId: obs.sessionId,
        length: answer?.length,
      });
      return answer;
    } catch (err) {
      serverEvents.logEvent('agentic:answer:error', { message: err.message });
      return null;
    }
  }

  // ── Standardised return shape ──────────────────────────────────────────────

  _finalReturn(obs, assessment, decision, trace, start, extraFields = {}) {
    return {
      ...obs,
      assessment,
      decision,
      trace,
      finalAction: { type: decision.action, reason: decision.rationale, evidence: decision.evidence },
      duration: `${Date.now() - start}ms`,
      // Enrichment fields bubbled up from the last UnifiedPipeline search
      expandedQuery: obs.expandedQuery || obs.query,
      entities:      obs.entities      || {},
      graphFacts:    obs.graphFacts    || [],
      ...extraFields,
    };
  }

  // ── Context building ───────────────────────────────────────────────────────

  async _buildContext(obs) {
    if (!this.threadManager || !this.contextWindowManager || !obs.query) {
      return obs;
    }

    const sessionId = obs.sessionId;
    if (!sessionId) {
      throw new Error('Observation missing sessionId — cannot fetch thread');
    }

    try {
      await this.threadManager.getOrCreate(sessionId);

      const queryKey = `${sessionId}::${obs.query}`;
      if (!this._addedQueries.has(queryKey)) {
        await this.threadManager.addMessage(sessionId, Message.create('user', obs.query));
        this._addedQueries.add(queryKey);
      }

      const ragResults = obs.rerankedResults && obs.rerankedResults.length > 0
        ? obs.rerankedResults
        : obs.results;
      const ragContext = ragResults.map(r => ({
        id:      r.id,
        content: (r.metadata && r.metadata.content) || r.content || '',
        score:   r.score,
      }));

      const updatedThread = await this.threadManager.getThread(sessionId);
      const contextPayload = await this.contextWindowManager.buildContext(
        updatedThread,
        this.systemPrompt,
        ragContext,
        this.responseMaxTokens
      );

      return obs.withContextPayload(contextPayload).withThread(updatedThread);
    } catch (err) {
      serverEvents.logEvent('agentic:context:error', { message: err.message, sessionId });
      if (!this._contextRetryAttempted) {
        this._contextRetryAttempted = true;
        try {
          await this.threadManager.getOrCreate(sessionId);
          const ragResults = obs.rerankedResults && obs.rerankedResults.length > 0
            ? obs.rerankedResults
            : obs.results;
          const ragContext = ragResults.map(r => ({
            id:      r.id,
            content: (r.metadata && r.metadata.content) || r.content || '',
            score:   r.score,
          }));
          const updatedThread = await this.threadManager.getThread(sessionId);
          const contextPayload = await this.contextWindowManager.buildContext(
            updatedThread,
            this.systemPrompt,
            ragContext,
            this.responseMaxTokens
          );
          return obs.withContextPayload(contextPayload).withThread(updatedThread);
        } catch (retryErr) {
          serverEvents.logEvent('agentic:context:retry-failed', { message: retryErr.message });
        }
      }
      serverEvents.logEvent('agentic:context:degraded', {
        message: 'context build failed, proceeding without context',
      });
      return obs;
    }
  }

  // ── Main loop ──────────────────────────────────────────────────────────────

  async run(observation, goal) {
    const start = Date.now();
    const trace = observation.trace || new Trace();
    let obs = observation;
    let remaining = goal.latencyBudget;

    // ── Cold-start: run an initial search before the first judge pass so the
    // judge never evaluates an empty result set. This saves one wasted LLM
    // judge call and ensures the context payload is populated from iteration 0.
    if (obs.results.length === 0 && obs.rerankedResults.length === 0) {
      obs = await this.executor.execute({ action: 'search' }, obs);
      trace.add(new TraceEvent({
        timestamp: Date.now(),
        iteration: 0,
        phase: 'execute',
        action: { action: 'search', reason: 'cold_start' },
        timing: { ms: 0 },
      }));
    }

    for (let i = 0; i < goal.maxIterations; i++) {
      const iterStart = Date.now();

      if (i > 0) {
        const elapsed = Date.now() - start;
        remaining = Math.max(0, goal.latencyBudget - elapsed);
      }

      obs = await this._buildContext(obs);

      const assessment = await this.judge.evaluate(obs);
      trace.add(new TraceEvent({
        timestamp: Date.now(),
        iteration: i,
        phase: 'judge',
        assessment,
        timing: { ms: Date.now() - iterStart },
      }));

      const decision = await this.policy.resolve(assessment, goal, trace, obs);
      trace.add(new TraceEvent({
        timestamp: Date.now(),
        iteration: i,
        phase: 'policy',
        decision,
        timing: { ms: Date.now() - iterStart },
      }));

      if (decision.action === 'answer' || decision.action === 'stop') {
        serverEvents.logEvent('agentic:strategy:complete', {
          iterations: i + 1,
          action: decision.action,
          reason: decision.rationale,
        });
        const answer = decision.action === 'answer'
          ? await this._generateAnswer(obs)
          : null;
        return this._finalReturn(obs, assessment, decision, trace, start, { answer });
      }

      if (remaining < 50) {
        serverEvents.logEvent('agentic:strategy:complete', {
          iterations: i + 1,
          action: 'stop',
          reason: 'latency_budget_exceeded',
        });
        const timeoutDecision = Decision.create(
          'stop', 'latency_budget_exceeded', { remainingBudgetMs: remaining }
        );
        return this._finalReturn(obs, assessment, timeoutDecision, trace, start, { answer: null });
      }

      obs = await this.executor.execute(decision, obs, remaining);
      const actionMs = Date.now() - iterStart;
      trace.add(new TraceEvent({
        timestamp: Date.now(),
        iteration: i,
        phase: 'execute',
        action: decision,
        timing: { ms: actionMs },
      }));

      remaining = actionMs > remaining ? 0 : remaining - actionMs;
    }

    // maxIterations reached — do a final judge+policy pass
    const finalAssessment = await this.judge.evaluate(obs);
    const finalDecision = await this.policy.resolve(
      finalAssessment, { ...goal, finalPass: true }, trace, obs
    );
    const resolvedAction = finalDecision.action === 'answer' ? 'answer' : 'stop';
    const resolvedRationale = finalDecision.action === 'answer'
      ? finalDecision.rationale
      : `max_iterations_reached (policy wanted: ${finalDecision.action} — ${finalDecision.rationale})`;
    const resolvedEvidence = finalDecision.action === 'answer'
      ? finalDecision.evidence
      : {
          iterations:       goal.maxIterations,
          wantedAction:     finalDecision.action,
          wantedRationale:  finalDecision.rationale,
          wantedEvidence:   finalDecision.evidence,
        };

    serverEvents.logEvent('agentic:strategy:complete', {
      iterations: goal.maxIterations,
      action: resolvedAction,
      reason: resolvedRationale,
    });

    const finalDecisionObj = finalDecision.action === 'answer'
      ? finalDecision
      : Decision.create('stop', resolvedRationale, resolvedEvidence);
    const answer = resolvedAction === 'answer'
      ? await this._generateAnswer(obs)
      : null;
    return this._finalReturn(obs, finalAssessment, finalDecisionObj, trace, start, { answer });
  }
}

module.exports = { Coordinator };
