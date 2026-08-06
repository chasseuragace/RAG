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
const { serverEvents } = require('../../shared/events');
const { extractJson } = require('../lib/llm-json');

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

    const parsed = extractJson(raw);
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


  _buildPrompt(assessment, goal, trace) {
    const priorActions = this._priorActions(trace);
    const missingConcepts = assessment.missingEvidence?.missingConcepts || [];
    const isFinalPass = goal.finalPass === true;
    const validActions = isFinalPass
      ? ['answer', 'stop']
      : ['answer', 'increase_topk', 'rewrite_query', 'stop'];

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
${isFinalPass ? '- **This is the final iteration — only \'answer\' or \'stop\' are available.**' : ''}

## Prior actions taken this iteration
${priorActions.length > 0 ? priorActions.map((a, i) => `  ${i + 1}. ${a}`).join('\n') : '  none'}

## Valid actions
${validActions.map(a => `- ${a}  — ${a === 'answer' ? 'evidence is sufficient, return results to the user' : a === 'stop' ? 'evidence is insufficient and further retrieval will not help' : a === 'increase_topk' ? 'fetch more candidate documents' : 'reformulate the query to improve coverage'}`).join('\n')}

## Instructions
Respond with ONLY a JSON object on a single line. No markdown, no explanation outside the JSON.
The JSON must have exactly these keys: action, rationale, evidence.
- action: one of the valid actions listed above (no others are accepted)
- rationale: one sentence explaining why
- evidence: an object with 1-3 key/value pairs supporting your reasoning

${isFinalPass
  ? `Examples (final pass — only answer or stop):
{"action":"answer","rationale":"Quality meets threshold despite low completeness.","evidence":{"quality":0.62,"completeness":0.45}}
{"action":"stop","rationale":"Quality is too low and no further retrieval actions are available.","evidence":{"quality":0.28,"missingConcepts":2}}`
  : `Examples:
{"action":"answer","rationale":"Quality and completeness are both above threshold.","evidence":{"quality":0.82,"completeness":0.91}}
{"action":"increase_topk","rationale":"Coverage is low; fetching more candidates may surface missing terms.","evidence":{"completeness":0.31,"missingConcepts":3}}
{"action":"rewrite_query","rationale":"Top result score is poor; reformulating the query should improve relevance.","evidence":{"quality":0.38,"topScore":0.29}}
{"action":"stop","rationale":"Results are too sparse and the query has already been rewritten once.","evidence":{"quality":0.21,"priorRewrites":1}}`
}`;
  }

  _priorActions(trace) {
    if (!trace || !trace.events) return [];
    return trace.events
      .filter(e => e.phase === 'execute')
      .map(e => e.action?.action || e.action?.type || 'unknown');
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
