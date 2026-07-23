const { Observation } = require('../observation');
const { RetrievalAssessment } = require('../assessment');
const { Decision } = require('../decision');
const { Trace, TraceEvent } = require('../trace');

class StubRetrievalStrategy {
  constructor(sequence = []) {
    this.sequence = sequence;
    this.index = 0;
  }

  async run(observation, maxIterations) {
    let obs = { ...observation, previousActions: [], trace: new Trace() };
    for (let i = 0; i < maxIterations; i++) {
      const next = this.sequence[this.index] || { finalAction: Decision.create('stop', 'sequence_exhausted') };
      this.index++;
      if (next.finalAction) {
        const assessment = next.assessment || RetrievalAssessment.create(0.5, 0.5, 0.5, 1);
        obs.trace.add(new TraceEvent({
          timestamp: Date.now(),
          iteration: i,
          phase: 'policy',
          decision: next.finalAction,
          assessment,
          timing: { ms: 0 }
        }));
        return {
          ...obs,
          assessment,
          decision: next.finalAction,
          finalAction: { type: next.finalAction.action, reason: next.finalAction.rationale, evidence: next.finalAction.evidence },
          rerankedResults: next.rerankedResults || [],
          trace: obs.trace,
          goal: observation.goal,
        };
      }

      const assessment = next.assessment || RetrievalAssessment.create(0.5, 0.5, 0.5, 1);
      obs.trace.add(new TraceEvent({
        timestamp: Date.now(),
        iteration: i,
        phase: 'execute',
        action: next.action,
        assessment,
        timing: { ms: 0 }
      }));
      obs = {
        ...obs,
        previousActions: [...obs.previousActions, ...(next.steps || [])],
        rerankedResults: next.rerankedResults || obs.rerankedResults,
      };
    }

    const fallback = Decision.create('stop', 'max_iterations_reached', { iterations: maxIterations });
    obs.trace.add(new TraceEvent({
      timestamp: Date.now(),
      iteration: maxIterations,
      phase: 'policy',
      decision: fallback,
      timing: { ms: 0 }
    }));
    return {
      ...obs,
      assessment: RetrievalAssessment.create(0.3, 0.3, 0.5, 0),
      decision: fallback,
      finalAction: { type: 'stop', reason: 'max_iterations_reached', evidence: { iterations: maxIterations } },
      trace: obs.trace,
      goal: observation.goal,
    };
  }

  reset() { this.index = 0; }
}

module.exports = { StubRetrievalStrategy };
