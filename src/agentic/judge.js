const { serverEvents } = require('../events');
const { RetrievalAssessment } = require('./assessment');
const { extractJson } = require('./lib/llm-json');

class RetrievalJudge {
  constructor(config = {}) {
    this.sufficientThreshold = config.sufficientThreshold || 0.6;
    this.maxMissingItems = config.maxMissingItems || 3;
    this.minDocsForSufficiency = config.minDocsForSufficiency || 2;
  }

  async evaluate(observation) {
    const { results, rerankedResults, query, previousActions } = observation;
    const topResults = rerankedResults.length > 0 ? rerankedResults : results;
    const topScore = topResults.length > 0 ? topResults[0].score : 0;

    const quality = this._retrievalQuality(topResults, topScore);
    const completeness = this._completeness(topResults, query);
    const consistency = this._consistency(topResults);
    const sourceDiversity = this._sourceDiversity(topResults);
    const missingEvidence = this._missingEvidence(topResults, query);

    serverEvents.logEvent('agentic:judge', {
      quality,
      completeness,
      consistency,
      sourceDiversity,
      missingCount: missingEvidence.missingConcepts.length + missingEvidence.ambiguousTerms.length + missingEvidence.conflictingEvidence.length + missingEvidence.unsupportedClaims.length
    });

    return RetrievalAssessment.create(quality, completeness, consistency, sourceDiversity, missingEvidence);
  }

  _retrievalQuality(results, topScore) {
    const scoreComponent = Math.min(1, topScore);
    const coverageComponent = Math.min(1, results.length / 5);
    return scoreComponent * 0.6 + coverageComponent * 0.4;
  }

  _completeness(results, query) {
    if (results.length === 0) return 0;
    const queryTerms = new Set(query.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(t => t.length > 2));
    if (queryTerms.size === 0) return 1;
    const coveredTerms = new Set();
    for (const r of results) {
      const content = (r.metadata && r.metadata.content || '').toLowerCase();
      for (const t of content.split(/\s+/)) {
        if (queryTerms.has(t)) coveredTerms.add(t);
      }
    }
    return coveredTerms.size / queryTerms.size;
  }

  _consistency(results) {
    if (results.length < 2) return 1;
    const scores = results.map(r => r.score);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length;
    return Math.max(0, 1 - Math.sqrt(variance));
  }

  _sourceDiversity(results) {
    const sources = new Set(results.map(r => r.metadata && r.metadata.original_id));
    return sources.size;
  }

  _missingEvidence(results, query) {
    const missingConcepts = [];
    const ambiguousTerms = [];
    const conflictingEvidence = [];
    const unsupportedClaims = [];

    if (results.length === 0) {
      missingConcepts.push('no_retrieved_documents');
      return { missingConcepts, ambiguousTerms, conflictingEvidence, unsupportedClaims };
    }

    if (results.length < this.minDocsForSufficiency) {
      missingConcepts.push(`only_${results.length}_source_available`);
    }

    if (results[0].score < 0.3) {
      missingConcepts.push('low_relevance_top_result');
    }

    const queryTerms = new Set(query.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(t => t.length > 2));
    const coveredTerms = new Set();
    for (const r of results) {
      const content = (r.metadata && r.metadata.content || '').toLowerCase();
      for (const t of content.split(/\s+/)) {
        if (queryTerms.has(t)) coveredTerms.add(t);
      }
    }
    const uncovered = [...queryTerms].filter(t => !coveredTerms.has(t)).slice(0, this.maxMissingItems);
    if (uncovered.length > 0) {
      missingConcepts.push(`uncovered_query_terms: ${uncovered.join(', ')}`);
    }

    return { missingConcepts, ambiguousTerms, conflictingEvidence, unsupportedClaims };
  }
}

/**
 * LLMJudge — cascading RetrievalJudge.
 *
 * Runs the existing heuristic RetrievalJudge first (cheap, no LLM call).
 * Only escalates to an LLM pass when heuristic quality lands in the gray
 * zone (config.grayZoneLow..grayZoneHigh) — clear passes and clear fails
 * don't need semantic judgment, so most iterations never touch the LLM.
 *
 * The LLM does NOT recompute quality/completeness/consistency/sourceDiversity
 * — those stay numeric and heuristic. It only fills in the three fields the
 * heuristic structurally can't: ambiguousTerms, conflictingEvidence,
 * unsupportedClaims. Output shape is identical to RetrievalJudge's, so
 * Policy and Executor need zero changes.
 *
 * On any inference/parse/validation failure, falls back silently to the
 * heuristic assessment untouched — the loop must never stall because the
 * LLM judge is unavailable.
 *
 * Latency note: the LLM call (when triggered) consumes from the
 * coordinator's global latencyBudget, same as LLMPolicy.
 */
class LLMJudge {
  /**
   * @param {object} inference  — any object with generateAnswer(prompt, [], []) → string
   * @param {object} config
   * @param {RetrievalJudge} config.heuristicJudge  — pre-filter / fallback (default: new RetrievalJudge(config))
   * @param {number}  config.grayZoneLow            — quality floor to trigger LLM pass (default 0.4)
   * @param {number}  config.grayZoneHigh           — quality ceiling to trigger LLM pass (default 0.7)
   * @param {boolean} config.logPrompts             — emit full prompt to serverEvents (default: false)
   */
  constructor(inference, config = {}) {
    if (!inference) throw new Error('LLMJudge requires an inference instance');
    this.inference = inference;
    this.heuristicJudge = config.heuristicJudge || new RetrievalJudge(config);
    this.grayZoneLow = config.grayZoneLow ?? 0.4;
    this.grayZoneHigh = config.grayZoneHigh ?? 0.7;
    this.logPrompts = config.logPrompts || false;
  }

  async evaluate(observation) {
    const heuristic = await this.heuristicJudge.evaluate(observation);

    if (!this._inGrayZone(heuristic.quality)) {
      serverEvents.logEvent('llm:judge:skip', { quality: heuristic.quality, reason: 'outside_gray_zone' });
      return heuristic;
    }

    const prompt = this._buildPrompt(observation, heuristic);

    if (this.logPrompts) {
      serverEvents.logEvent('llm:judge:prompt', { prompt });
    }

    let raw;
    try {
      raw = await this.inference.generateAnswer(prompt, [], []);
    } catch (err) {
      serverEvents.logEvent('llm:judge:error', { stage: 'inference', message: err.message });
      return this._fallback(heuristic, `inference_error: ${err.message}`);
    }

    const parsed = extractJson(raw);
    if (!parsed) {
      serverEvents.logEvent('llm:judge:error', { stage: 'parse', raw });
      return this._fallback(heuristic, 'parse_error: could not extract JSON from response');
    }

    if (!this._isValidShape(parsed)) {
      serverEvents.logEvent('llm:judge:error', { stage: 'validate', parsed });
      return this._fallback(heuristic, 'invalid_shape: missing or malformed semantic fields');
    }

    serverEvents.logEvent('llm:judge:decision', {
      ambiguousTerms: parsed.ambiguousTerms.length,
      conflictingEvidence: parsed.conflictingEvidence.length,
      unsupportedClaims: parsed.unsupportedClaims.length,
    });

    return RetrievalAssessment.create(
      heuristic.quality,
      heuristic.completeness,
      heuristic.consistency,
      heuristic.sourceDiversity,
      {
        missingConcepts: heuristic.missingEvidence.missingConcepts,
        ambiguousTerms: parsed.ambiguousTerms,
        conflictingEvidence: parsed.conflictingEvidence,
        unsupportedClaims: parsed.unsupportedClaims,
      }
    );
  }

  // ─── cascade gate ───────────────────────────────────────────

  _inGrayZone(quality) {
    return quality >= this.grayZoneLow && quality <= this.grayZoneHigh;
  }

  // ─── prompt construction ────────────────────────────────────

  _buildPrompt(observation, heuristic) {
    const topResults = observation.rerankedResults.length > 0 ? observation.rerankedResults : observation.results;
    const excerpts = topResults.slice(0, 5).map((r, i) => {
      const content = (r.metadata && r.metadata.content || '').slice(0, 400);
      return `[${i + 1}] (source: ${r.metadata?.original_id ?? 'unknown'}) ${content}`;
    }).join('\n\n');

    return `You are assessing retrieved evidence for a RAG pipeline. A heuristic scorer already computed quality=${heuristic.quality.toFixed(3)} and completeness=${heuristic.completeness.toFixed(3)}, but it cannot detect semantic issues in the text itself. That's your job.

## Query
${observation.query}

## Retrieved passages
${excerpts || '(no passages retrieved)'}

## Instructions
Respond with ONLY a JSON object on a single line. No markdown, no explanation outside the JSON.
The JSON must have exactly these keys: ambiguousTerms, conflictingEvidence, unsupportedClaims.
- ambiguousTerms: array of terms whose meaning is unclear or context-dependent (empty array if none)
- conflictingEvidence: array of short strings describing direct contradictions between passages (empty array if none)
- unsupportedClaims: array of short strings naming claims not backed by the passage content itself (empty array if none)

Example: {"ambiguousTerms":["bank"],"conflictingEvidence":[],"unsupportedClaims":["Passage 2 claims a date not stated in any source"]}

More examples:
- {"ambiguousTerms":[],"conflictingEvidence":["Passage 1 says the rabbit was white, Passage 3 says it was brown"],"unsupportedClaims":[]}
- {"ambiguousTerms":[],"conflictingEvidence":[],"unsupportedClaims":["Passage 2 claims the rabbit was named Bingo, but no passage confirms this"]}
- {"ambiguousTerms":["tutorial"],"conflictingEvidence":[],"unsupportedClaims":["Passage 1 claims the tutorial is for beginners, but no passage specifies the audience"]}
- {"ambiguousTerms":["model"],"conflictingEvidence":["Passage 1 gives version 3.5, Passage 4 gives version 4.0"],"unsupportedClaims":["Passage 3 claims this model is the fastest, but no benchmark is cited"]}
- {"ambiguousTerms":[],"conflictingEvidence":[],"unsupportedClaims":[]}`;
  }

  // ─── validation ─────────────────────────────────────────────

  _isValidShape(parsed) {
    return Array.isArray(parsed.ambiguousTerms)
      && Array.isArray(parsed.conflictingEvidence)
      && Array.isArray(parsed.unsupportedClaims);
  }

  // ─── fallback ────────────────────────────────────────────────

  _fallback(heuristic, reason) {
    serverEvents.logEvent('llm:judge:fallback', { reason });
    return heuristic;
  }
}

module.exports = { RetrievalJudge, LLMJudge };
