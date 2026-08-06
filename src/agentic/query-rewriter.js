/**
 * QueryRewriter — produces an expanded or reformulated query to improve
 * retrieval coverage.
 *
 * The heuristic version extracts long words from top results and appends
 * them. The LLM version sends the query + top passages + the policy's
 * rationale to an inference model and asks it to produce a better query.
 *
 * Both conform to the same interface: rewrite(query, observation, rationale, evidence) → string.
 */

const { serverEvents } = require('../events');

class QueryRewriter {
  rewrite(query, observation, rationale, evidence) {
    throw new Error('not implemented');
  }
}

class HeuristicQueryRewriter extends QueryRewriter {
  rewrite(query, observation, rationale, evidence) {
    const topWords = observation.rerankedResults.slice(0, 2).flatMap(d =>
      (d.metadata && d.metadata.content || '').toLowerCase().split(/\s+/).filter(w => w.length > 4)
    ).slice(0, 5);
    const expanded = `${query} ${topWords.join(' ')}`.trim();
    return expanded.length > query.length ? expanded : query;
  }
}

class LLMQueryRewriter extends QueryRewriter {
  /**
   * @param {object} inference  — any object with generateAnswer(prompt, [], []) → string
   * @param {object} config
   * @param {QueryRewriter} config.fallback  — used when LLM fails (default: HeuristicQueryRewriter)
   * @param {boolean} config.logPrompts       — emit full prompt to serverEvents (default: false)
   */
  constructor(inference, config = {}) {
    super();
    if (!inference) throw new Error('LLMQueryRewriter requires an inference instance');
    this.inference = inference;
    this.fallback = config.fallback || new HeuristicQueryRewriter();
    this.logPrompts = config.logPrompts || false;
  }

  async rewrite(query, observation, rationale, evidence) {
    const prompt = this._buildPrompt(query, observation, rationale, evidence);

    if (this.logPrompts) {
      serverEvents.logEvent('llm:rewriter:prompt', { prompt });
    }

    let raw;
    try {
      raw = await this.inference.generateAnswer(prompt, [], []);
    } catch (err) {
      serverEvents.logEvent('llm:rewriter:error', { stage: 'inference', message: err.message });
      return this._fallback(query, observation, rationale, `inference_error: ${err.message}`);
    }

    const rewritten = (raw || '').trim();
    if (rewritten.length === 0 || rewritten === query) {
      return this._fallback(query, observation, rationale, 'empty_or_identical_response');
    }

    serverEvents.logEvent('llm:rewriter:decision', {
      originalQuery: query,
      rewrittenQuery: rewritten,
      usedFallback: false,
    });
    return rewritten;
  }

  /**
   * Classify what kind of gap the policy is reporting so we can tailor the
   * rewrite strategy in the prompt.
   *
   * low_coverage → the right documents aren't being found; widen the query
   *                with synonyms and related terms.
   * low_quality  → the retrieved documents aren't relevant enough; sharpen
   *                the query by being more specific or removing ambiguous terms.
   * unknown      → no strong signal; apply a balanced reformulation.
   */
  _classifyGap(rationale) {
    if (!rationale) return 'unknown';
    const r = rationale.toLowerCase();
    if (r.includes('coverage') || r.includes('completeness') || r.includes('missing') || r.includes('term')) {
      return 'low_coverage';
    }
    if (r.includes('quality') || r.includes('relevance') || r.includes('irrelevant') || r.includes('poor')) {
      return 'low_quality';
    }
    return 'unknown';
  }

  _buildPrompt(query, observation, rationale, evidence) {
    const topResults = observation.rerankedResults.length > 0 ? observation.rerankedResults : observation.results;
    const excerpts = topResults.slice(0, 5).map((r, i) => {
      const content = (r.metadata && r.metadata.content || '').slice(0, 300);
      return `[${i + 1}] (source: ${r.metadata?.original_id ?? 'unknown'}) ${content}`;
    }).join('\n\n');

    const rationaleLine = rationale ? `\n## Why the policy wants a rewrite\n${rationale}` : '';
    const evidenceLine = evidence && Object.keys(evidence).length > 0
      ? `\n## Policy evidence\n${Object.entries(evidence).map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`).join('\n')}`
      : '';

    const gap = this._classifyGap(rationale);
    const strategyLine = gap === 'low_coverage'
      ? 'Strategy: the query is missing key terms — expand it with synonyms, related concepts, or alternative phrasings to improve document coverage.'
      : gap === 'low_quality'
      ? 'Strategy: the retrieved results are not relevant enough — sharpen the query by being more specific, removing ambiguous terms, or focusing on the core subject.'
      : 'Strategy: apply a balanced reformulation that improves both coverage and relevance.';

    return `You are a query reformulation assistant for a RAG retrieval pipeline.

## Original query
${query}

## Top retrieved passages
${excerpts || '(no passages retrieved)'}
${rationaleLine}${evidenceLine}

## Rewrite strategy
${strategyLine}

## Task
Rewrite the query to improve retrieval. The rewritten query should:
- Capture the full intent of the original query
- Follow the rewrite strategy above
- Address the specific gap identified by the policy (see "Why the policy wants a rewrite")
- Be a single concise query string (not a sentence, not an explanation)

Return ONLY the rewritten query string. No preamble, no markdown, no explanation.

Example (low_coverage):
Original: "what did Parang name the rabbit"
Rewritten: "Parang rabbit name Bingo pet nickname"

Example (low_quality):
Original: "bank interest rates"
Rewritten: "commercial bank annual interest rate deposit accounts"`;
  }

  _fallback(query, observation, rationale, reason) {
    serverEvents.logEvent('llm:rewriter:decision', {
      originalQuery: query,
      rewrittenQuery: null,
      usedFallback: true,
      fallbackReason: reason,
      fallback: this.fallback.constructor.name,
    });
    return this.fallback.rewrite(query, observation);
  }
}

module.exports = { QueryRewriter, HeuristicQueryRewriter, LLMQueryRewriter };