/**
 * MockContextFuser — merges structured graph paths with unstructured vector chunks.
 *
 * Swap for a learned fusion model (cross-encoder, attention-based merger, etc.)
 * by implementing the ContextFuser interface from src/core/interfaces.js.
 *
 * fuse(graphPaths, vectorChunks, query) → FusedContext
 *
 * FusedContext shape:
 * {
 *   graphFacts:  string[],   — "AZT TREATS hiv" lines (structured evidence)
 *   textChunks:  object[],   — vector result objects (unstructured evidence)
 *   combined:    string,     — single prompt-ready context block for the LLM
 *   meta: {
 *     graphFactCount:  number,
 *     textChunkCount:  number,
 *     fusionStrategy:  string,
 *   }
 * }
 *
 * ─── Fusion strategy (mock) ────────────────────────────────────────────────
 * 1. De-duplicate graph paths by (subject|predicate|object).
 * 2. Sort by confidence desc, cap at maxGraphFacts.
 * 3. Render each path as a human-readable fact line.
 * 4. Combine: facts block first (grounding), then text passages.
 *    Rationale: LLMs attend more strongly to content near the end of the
 *    context, so hard facts lead and richer prose follows.
 */

const { ContextFuser } = require('../core/interfaces');

const DEFAULT_OPTIONS = {
  maxGraphFacts:  20,    // hard cap on injected triples
  maxTextChunks:  10,    // hard cap on text passages
  factSeparator:  '\n',
  chunkSeparator: '\n\n---\n\n',
};

class MockContextFuser extends ContextFuser {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxGraphFacts=20]
   * @param {number} [opts.maxTextChunks=10]
   * @param {string} [opts.factSeparator]
   * @param {string} [opts.chunkSeparator]
   */
  constructor(opts = {}) {
    super();
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  /**
   * @param {object[]} graphPaths   — triples from GraphStore.queryByEntities()
   * @param {object[]} vectorChunks — results from HybridStore / NEREnrichedRetrievalPipeline
   * @param {string}   query        — original (or expanded) user query
   * @returns {FusedContext}
   */
  fuse(graphPaths, vectorChunks, query) {
    // ── 1. Graph facts ───────────────────────────────────────────────────────
    const seen  = new Set();
    const facts = [];
    for (const t of (graphPaths || [])) {
      const key = `${(t.subject||'').toLowerCase()}|${t.predicate}|${(t.object||'').toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push(t);
      if (facts.length >= this.opts.maxGraphFacts) break;
    }

    // Render as human-readable lines
    const graphFacts = facts.map(t =>
      `${t.subject.toUpperCase()} ${t.predicate} ${t.object.toUpperCase()}` +
      (t.confidence < 1.0 ? ` [confidence: ${(t.confidence * 100).toFixed(0)}%]` : '') +
      (t.sourceChunkId    ? ` (source: ${t.sourceChunkId})` : '')
    );

    // ── 2. Text chunks ───────────────────────────────────────────────────────
    const textChunks = (vectorChunks || []).slice(0, this.opts.maxTextChunks);

    // ── 3. Combined context string ───────────────────────────────────────────
    const parts = [];

    if (graphFacts.length > 0) {
      parts.push(
        '## Verified Knowledge-Graph Facts\n' +
        graphFacts.join(this.opts.factSeparator)
      );
    }

    if (textChunks.length > 0) {
      const passages = textChunks.map((r, i) => {
        const content = r.metadata?.content || '';
        const src     = r.metadata?.original_id || r.id || `chunk-${i}`;
        return `[${i + 1}] (source: ${src})\n${content}`;
      });
      parts.push(
        '## Retrieved Text Passages\n' +
        passages.join(this.opts.chunkSeparator)
      );
    }

    const combined = parts.length > 0
      ? parts.join('\n\n')
      : '(no context retrieved)';

    return {
      graphFacts,
      textChunks,
      combined,
      meta: {
        graphFactCount:  graphFacts.length,
        textChunkCount:  textChunks.length,
        fusionStrategy: 'mock-sequential',
        query,
      },
    };
  }
}

module.exports = { MockContextFuser };
