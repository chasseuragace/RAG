/**
 * LLMPolicy — RetrievalPolicy backed by an LLM inference call.
 *
 * Replaces heuristic threshold comparisons with an LLM judgment.
 * Falls back silently to a configurable fallback policy (default: HeuristicRetrievalPolicy)
 * on any parse / validation / network failure.
 *
 * The LLM is given:
 *   - The current RetrievalAssessment (structured numbers + missing evidence)
 *   - The RetrievalGoal (objective, minimumQuality, remaining iterations)
 *   - The prior actions already taken (from the Trace)
 *   - The valid action vocabulary
 *
 * It must respond with a single JSON object:
 *   { "action": "<one of the valid actions>", "rationale": "...", "evidence": { ... } }
 *
 * Streaming is NOT implemented here — the current transport is synchronous HTTP.
 * Latency note: the LLM call consumes from the coordinator's global latencyBudget.
 * A per-policy latency cap can be added via config.policyLatencyBudgetMs when needed.
 */
const { RetrievalPolicy } = require('../policy');
const { Decision } = require('../decision');
const { HeuristicRetrievalPolicy } = require('./heuristic');
const { serverEvents } = require('../../events');

const VALID_ACTIONS = ['answer', 'increase_topk', 'rewrite_query', 'stop'];

class LLMPolicy extends RetrievalPolicy {
  /**
   * @param {object} inference  — any object with generateAnswer(prompt, [], []) → string
   * @param {object} config
   * @param {RetrievalPolicy} config.fallbackPolicy  — used when LLM fails (default: HeuristicRetrievalPolicy)
   * @param {number}  config.temperature             — passed through if inference supports it (informational)
   * @param {boolean} config.logPrompts              — emit full prompt to serverEvents (default: false)
   */
  constructor(inference, config = {}) {
    super();
    if (!inference) throw new Error('LLMPolicy requires an inference instance');
    this.inference = inference;
    this.fallbackPolicy = config.fallbackPolicy || new HeuristicRetrievalPolicy();
    this.logPrompts = config.logPrompts || false;
  }

  async resolve(assessment, goal, trace) {
    const prompt = this._buildPrompt(assessment, goal, trace);

    if (this.logPrompts) {
      serverEvents.logEvent('llm:policy:prompt', { prompt });
    }

    let raw;
    try {
      // Pass prompt as the query; no context documents; no conversation history.
      raw = await this.inference.generateAnswer(prompt, [], []);
    } catch (err) {
      serverEvents.logEvent('llm:policy:error', { stage: 'inference', message: err.message });
      return this._fallback(assessment, goal, trace, `inference_error: ${err.message}`);
    }

    const parsed = this._parse(raw);
    if (!parsed) {
      serverEvents.logEvent('llm:policy:error', { stage: 'parse', raw });
      return this._fallback(assessment, goal, trace, `parse_error: could not extract JSON from response`);
    }

    if (!VALID_ACTIONS.includes(parsed.action)) {
      serverEvents.logEvent('llm:policy:error', { stage: 'validate', action: parsed.action });
      return this._fallback(assessment, goal, trace, `invalid_action: "${parsed.action}" not in vocabulary`);
    }

    serverEvents.logEvent('llm:policy:decision', {
      action: parsed.action,
      rationale: parsed.rationale,
    });

    return Decision.create(
      parsed.action,
      parsed.rationale || `llm_decision: ${parsed.action}`,
      parsed.evidence || { llmDriven: true },
      'normal'
    );
  }

  // ─── prompt construction ────────────────────────────────────────────────────

  _buildPrompt(assessment, goal, trace) {
    const priorActions = this._priorActions(trace);
    const missingConcepts = assessment.missingEvidence?.missingConcepts || [];

    return `You are a retrieval quality judge deciding the next action for a RAG pipeline.

## Current retrieval assessment
- quality (relevance of top results): ${assessment.quality.toFixed(3)}
- completeness (query term coverage): ${assessment.completeness.toFixed(3)}
- consistency (score variance across results): ${assessment.consistency.toFixed(3)}
- sourceDiversity (number of distinct sources): ${assessment.sourceDiversity}
- missingConcepts: ${missingConcepts.length > 0 ? missingConcepts.join(', ') : 'none'}

## Goal
- objective: ${goal.objective || 'BALANCED'}
- minimumQuality: ${goal.minimumQuality ?? 0.5}
- maxIterations: ${goal.maxIterations ?? 2}

## Prior actions taken this iteration
${priorActions.length > 0 ? priorActions.map((a, i) => `  ${i + 1}. ${a}`).join('\n') : '  none'}

## Valid actions
- answer          — evidence is sufficient, return results to the user
- increase_topk   — fetch more candidate documents
- rewrite_query   — reformulate the query to improve coverage
- stop            — evidence is insufficient and further retrieval will not help

## Instructions
Respond with ONLY a JSON object on a single line. No markdown, no explanation outside the JSON.
The JSON must have exactly these keys: action, rationale, evidence.
- action: one of the valid actions above
- rationale: one sentence explaining why
- evidence: an object with 1-3 key/value pairs supporting your reasoning

Example: {"action":"answer","rationale":"Quality and completeness are both above threshold.","evidence":{"quality":0.82,"completeness":0.91}}`;
  }

  _priorActions(trace) {
    if (!trace || !trace.events) return [];
    return trace.events
      .filter(e => e.phase === 'execute')
      .map(e => e.action?.action || e.action?.type || 'unknown');
  }

  // ─── response parsing ───────────────────────────────────────────────────────

  /**
   * Extract the first valid JSON object from the LLM response string.
   * The LLM may wrap it in markdown fences or add preamble — we strip those.
   */
  _parse(raw) {
    if (typeof raw !== 'string' || raw.trim().length === 0) return null;

    // Strip markdown code fences if present
    const stripped = raw.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();

    // Find the first { ... } block
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;

    try {
      const obj = JSON.parse(stripped.slice(start, end + 1));
      if (typeof obj.action !== 'string') return null;
      return obj;
    } catch (_) {
      return null;
    }
  }

  // ─── fallback ────────────────────────────────────────────────────────────────

  _fallback(assessment, goal, trace, reason) {
    serverEvents.logEvent('llm:policy:fallback', { reason, fallback: this.fallbackPolicy.constructor.name });
    const decision = this.fallbackPolicy.resolve(assessment, goal, trace);
    // Wrap in a new Decision so callers can see the fallback was used
    return Decision.create(
      decision.action,
      `[fallback:${this.fallbackPolicy.constructor.name}] ${decision.rationale}`,
      { ...decision.evidence, fallbackReason: reason },
      decision.priority
    );
  }
}

module.exports = { LLMPolicy, VALID_ACTIONS };
