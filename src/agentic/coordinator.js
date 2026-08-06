const { serverEvents } = require('../shared/events');
const { Decision } = require('./decision');
const { Trace, TraceEvent } = require('./trace');

class Coordinator {
  constructor(judge, policy, executor, threadManager = null, contextWindowManager = null) {
    this.judge = judge;
    this.policy = policy;
    this.executor = executor;
    this.threadManager = threadManager;
    this.contextWindowManager = contextWindowManager;
  }

  async _buildContext(obs) {
    if (!this.threadManager || !this.contextWindowManager || !obs.thread) {
      return obs;
    }
    const thread = await this.threadManager.getThread(obs.thread.id);
    const contextPayload = await this.contextWindowManager.buildContext(
      thread,
      '',
      [],
      1000
    );
    return obs.withContextPayload(contextPayload).withThread(thread);
  }

  async run(observation, goal) {
    const start = Date.now();
    const trace = observation.trace || new Trace();
    let obs = observation;
    let remaining = goal.latencyBudget;

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
        timing: { ms: Date.now() - iterStart }
      }));

      const decision = await this.policy.resolve(assessment, goal, trace);
      trace.add(new TraceEvent({
        timestamp: Date.now(),
        iteration: i,
        phase: 'policy',
        decision,
        timing: { ms: Date.now() - iterStart }
      }));

      if (decision.action === 'answer' || decision.action === 'stop') {
        serverEvents.logEvent('agentic:strategy:complete', {
          iterations: i + 1,
          action: decision.action,
          reason: decision.rationale,
        });
        return {
          ...obs,
          assessment,
          decision,
          trace,
          finalAction: { type: decision.action, reason: decision.rationale, evidence: decision.evidence },
          duration: `${Date.now() - start}ms`,
        };
      }

      if (remaining < 50) {
        serverEvents.logEvent('agentic:strategy:complete', {
          iterations: i + 1,
          action: 'stop',
          reason: 'latency_budget_exceeded',
        });
        return {
          ...obs,
          assessment,
          decision: Decision.create('stop', 'latency_budget_exceeded', { remainingBudgetMs: remaining }),
          trace,
          finalAction: { type: 'stop', reason: 'latency_budget_exceeded', evidence: { remainingBudgetMs: remaining } },
          duration: `${Date.now() - start}ms`,
        };
      }

      obs = await this.executor.execute(decision, obs, remaining);
      const actionMs = Date.now() - iterStart;
      trace.add(new TraceEvent({
        timestamp: Date.now(),
        iteration: i,
        phase: 'execute',
        action: decision,
        timing: { ms: actionMs }
      }));

      if (actionMs > remaining) {
        remaining = 0;
      } else {
        remaining -= actionMs;
      }
    }

    const finalAssessment = await this.judge.evaluate(obs);
    const finalDecision = await this.policy.resolve(finalAssessment, { ...goal, finalPass: true }, trace);
    const resolvedAction = (finalDecision.action === 'answer') ? 'answer' : 'stop';
    const resolvedRationale = (finalDecision.action === 'answer')
      ? finalDecision.rationale
      : `max_iterations_reached (policy wanted: ${finalDecision.action} — ${finalDecision.rationale})`;
    const resolvedEvidence = (finalDecision.action === 'answer')
      ? finalDecision.evidence
      : {
          iterations: goal.maxIterations,
          wantedAction: finalDecision.action,
          wantedRationale: finalDecision.rationale,
          wantedEvidence: finalDecision.evidence,
        };

    serverEvents.logEvent('agentic:strategy:complete', {
      iterations: goal.maxIterations,
      action: resolvedAction,
      reason: resolvedRationale,
    });
    return {
      ...obs,
      assessment: finalAssessment,
      decision: finalDecision.action === 'answer'
        ? finalDecision
        : Decision.create('stop', resolvedRationale, resolvedEvidence),
      trace,
      finalAction: { type: resolvedAction, reason: resolvedRationale, evidence: resolvedEvidence },
      duration: `${Date.now() - start}ms`,
    };
  }
}

module.exports = { Coordinator };
