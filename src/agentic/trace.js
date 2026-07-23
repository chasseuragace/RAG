const { serverEvents } = require('../events');

class TraceEvent {
  constructor({ timestamp, iteration, phase, action = null, assessment = null, decision = null, timing = null }) {
    this.timestamp = timestamp;
    this.iteration = iteration;
    this.phase = phase;
    this.action = action;
    this.assessment = assessment;
    this.decision = decision;
    this.timing = timing;
  }
}

class Trace {
  constructor() {
    this.events = [];
  }

  add(event) {
    this.events.push(event);
    serverEvents.logEvent('trace:event', {
      iteration: event.iteration,
      phase: event.phase,
      action: event.action?.action || event.action?.type || null,
      rationale: event.action?.rationale || event.decision?.rationale || null,
      timing: event.timing,
    });
  }

  toArray() {
    return this.events.map(e => ({
      timestamp: e.timestamp,
      iteration: e.iteration,
      phase: e.phase,
      // action may be a Decision (has .action) or a plain object (has .type)
      action: e.action ? {
        type: e.action.action || e.action.type || null,
        rationale: e.action.rationale || e.action.reason || null,
        evidence: e.action.evidence || null,
      } : null,
      assessment: e.assessment ? {
        quality: e.assessment.quality,
        completeness: e.assessment.completeness,
        consistency: e.assessment.consistency,
        sourceDiversity: e.assessment.sourceDiversity,
        missingEvidence: e.assessment.missingEvidence,
      } : null,
      decision: e.decision ? {
        type: e.decision.action,
        rationale: e.decision.rationale,
        evidence: e.decision.evidence,
      } : null,
      timing: e.timing,
    }));
  }
}

module.exports = { Trace, TraceEvent };
