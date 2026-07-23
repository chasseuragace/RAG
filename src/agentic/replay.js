/**
 * ReplayHarness — runs any RetrievalPolicy against every fixture in a GoldenDataset
 * and reports how often the policy's decision matches the expected action.
 *
 * This is the offline evaluation loop for Phase 5. It lets you compare heuristic
 * policies against LLMPolicy without touching the coordinator, executor, or judge.
 *
 * Usage:
 *   const harness = new ReplayHarness();
 *   const report  = await harness.run(policy, dataset);
 *   // report: { total, matched, mismatched, matchRate, results[] }
 *
 * Each result entry:
 *   { id, description, expectedAction, actualAction, matched, rationale, evidence }
 */
const { RetrievalAssessment } = require('./assessment');
const { Trace, TraceEvent } = require('./trace');
const { Decision } = require('./decision');
const { serverEvents } = require('../events');

class ReplayHarness {
  /**
   * Reconstruct a Trace from the traceActions array stored in a golden fixture.
   * Each entry is a prior action type string; we wrap it as a minimal execute event
   * so policies that count prior actions (e.g. rewrite_query count) work correctly.
   */
  _buildTrace(traceActions = []) {
    const trace = new Trace();
    traceActions.forEach((actionType, i) => {
      trace.add(new TraceEvent({
        timestamp: Date.now(),
        iteration: i,
        phase: 'execute',
        action: Decision.create(actionType, `replayed_action_${i}`),
      }));
    });
    return trace;
  }

  /**
   * Reconstruct a RetrievalAssessment from the plain object stored in a fixture.
   */
  _buildAssessment(raw) {
    return RetrievalAssessment.create(
      raw.quality,
      raw.completeness,
      raw.consistency,
      raw.sourceDiversity,
      raw.missingEvidence
    );
  }

  /**
   * Run policy against every record in dataset.
   *
   * @param {RetrievalPolicy} policy
   * @param {GoldenDataset}   dataset
   * @param {string|null}     tag     — optional tag filter
   * @returns {Promise<ReplayReport>}
   */
  async run(policy, dataset, tag = null) {
    const fixtures = dataset.all(tag);
    const results = [];

    for (const fixture of fixtures) {
      const assessment = this._buildAssessment(fixture.assessment);
      const trace = this._buildTrace(fixture.traceActions || []);
      const goal = fixture.goal || {};

      let actualAction, rationale, evidence, error;
      try {
        const decision = await Promise.resolve(policy.resolve(assessment, goal, trace));
        actualAction = decision.action;
        rationale = decision.rationale;
        evidence = decision.evidence;
      } catch (err) {
        actualAction = 'error';
        rationale = err.message;
        evidence = {};
        error = err.message;
      }

      const matched = actualAction === fixture.expectedAction;
      results.push({
        id: fixture.id,
        description: fixture.description || '',
        tags: fixture.tags || [],
        expectedAction: fixture.expectedAction,
        actualAction,
        matched,
        rationale,
        evidence,
        ...(error ? { error } : {}),
      });
    }

    const matched = results.filter(r => r.matched).length;
    const total = results.length;
    const matchRate = total > 0 ? matched / total : 0;

    const report = { total, matched, mismatched: total - matched, matchRate, results };

    serverEvents.logEvent('replay:complete', {
      total,
      matched,
      matchRate: matchRate.toFixed(3),
      policy: policy.constructor.name,
    });

    return report;
  }
}

module.exports = { ReplayHarness };
