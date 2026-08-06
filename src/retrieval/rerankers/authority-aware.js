/**
 * AuthorityAwareReranker — the "Gatekeeper".
 *
 * Composes semantic relevance (from an inner Reranker) with authority score
 * (from an AuthorityScorer) into a single final_score, then re-sorts candidates.
 *
 * Implements the Reranker interface so it is a drop-in replacement anywhere
 * a plain Reranker is accepted (including GraphRAGPipeline, NEREnrichedRetrievalPipeline).
 *
 * ─── Scoring formula ──────────────────────────────────────────────────────
 *   final_score = α * semantic_score + β * authority_score
 *
 *   Default: α = 0.6, β = 0.4
 *   Both weights are configurable at construction time and updatable at runtime.
 *
 * ─── Inputs ───────────────────────────────────────────────────────────────
 *   rerank(query, candidates) → ranked candidates[]
 *
 *   Each candidate is expected to carry:
 *     - candidate.score            — raw vector/RRF score (used as proxy for semantic)
 *     - candidate.metadata?.authority_signal — attached at ingestion by ProvenanceAnnotator
 *
 *   If the inner semanticReranker is present, it is called first to produce a
 *   refined semantic_score.  Otherwise candidate.score is used directly.
 *
 * ─── Output ───────────────────────────────────────────────────────────────
 *   Each result gains three extra fields (non-breaking additions):
 *     - semanticScore:   number
 *     - authorityScore:  number
 *     - finalScore:      number   ← sort key
 */

const { Reranker } = require('../../shared/interfaces');

class AuthorityAwareReranker extends Reranker {
  /**
   * @param {AuthorityScorer} authorityScorer  — required
   * @param {object}          [opts]
   * @param {Reranker}        [opts.semanticReranker]  — optional inner reranker (cross-encoder, etc.)
   * @param {number}          [opts.semanticWeight=0.6]
   * @param {number}          [opts.authorityWeight=0.4]
   */
  constructor(authorityScorer, opts = {}) {
    super();
    if (!authorityScorer) throw new Error('AuthorityAwareReranker requires an AuthorityScorer');
    this.authorityScorer  = authorityScorer;
    this.semanticReranker = opts.semanticReranker  || null;
    this.semanticWeight   = opts.semanticWeight    ?? 0.6;
    this.authorityWeight  = opts.authorityWeight   ?? 0.4;
  }

  /**
   * @param {string}   query
   * @param {object[]} candidates  — result objects with .score and .metadata
   * @returns {Promise<object[]>}  sorted by finalScore desc
   */
  async rerank(query, candidates) {
    if (!candidates || candidates.length === 0) return [];

    // Step 1: get semantic scores
    let semanticScores;
    if (this.semanticReranker) {
      const reranked = await this.semanticReranker.rerank(query, candidates);
      // Build a map id → score from the inner reranker's output
      const scoreMap = new Map(reranked.map(r => [r.id, r.score ?? 0]));
      semanticScores = candidates.map(c => scoreMap.get(c.id) ?? c.score ?? 0);
    } else {
      // Fall back to the raw vector/RRF score, normalised to [0, 1]
      const maxScore = Math.max(...candidates.map(c => c.score ?? 0), 1e-9);
      semanticScores = candidates.map(c => (c.score ?? 0) / maxScore);
    }

    // Step 2: compute authority scores and compose
    const scored = candidates.map((candidate, i) => {
      const authoritySignal = candidate.metadata?.authority_signal ?? {};
      const authorityScore  = this.authorityScorer.computeScore(authoritySignal);
      const semanticScore   = semanticScores[i];
      const finalScore = (this.semanticWeight * semanticScore) +
                         (this.authorityWeight * authorityScore);
      return {
        ...candidate,
        semanticScore:  +semanticScore.toFixed(4),
        authorityScore: +authorityScore.toFixed(4),
        finalScore:     +finalScore.toFixed(4),
        score:          +finalScore.toFixed(4), // override .score so downstream code is consistent
      };
    });

    // Step 3: sort by finalScore descending
    return scored.sort((a, b) => b.finalScore - a.finalScore);
  }

  /**
   * Adjust weights at runtime (e.g., based on user feedback signal).
   * @param {{ semanticWeight?: number, authorityWeight?: number }} weights
   */
  updateWeights({ semanticWeight, authorityWeight } = {}) {
    if (semanticWeight  !== undefined) this.semanticWeight  = semanticWeight;
    if (authorityWeight !== undefined) this.authorityWeight = authorityWeight;
  }
}

module.exports = { AuthorityAwareReranker };
