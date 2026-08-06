/**
 * GraphRAGPipeline — dual-path retrieval combining:
 *
 *   Path A (Structural)  : Graph traversal → verified triples / relational paths
 *   Path B (Semantic)    : NER-enriched hybrid retrieval → top-K text chunks
 *
 * Both paths run in parallel.  Results are merged by the ContextFuser and
 * optionally re-ranked before being returned to the caller / LLM.
 *
 * ─── Runtime flow ─────────────────────────────────────────────────────────
 *
 *   query
 *    │
 *    ├─► [Acronym Expansion]       glossary.expand(query)
 *    │
 *    ├─► [Query NER]               ner.extract(expandedQuery)
 *    │                             → entities { DRUG, DISEASE, BIOMARKER, … }
 *    │
 *    ├─► [Build Metadata Filter]   filter.build(entities)
 *    │
 *    ├─┬─────────────────────────────────────────────────────────────┐
 *    │ │  PATH A — GRAPH TRAVERSAL                                   │
 *    │ │  graphStore.queryByEntities(allEntityValues, depth)         │
 *    │ │  → graphPaths[]                                             │
 *    │ └─────────────────────────────────────────────────────────────┘
 *    │
 *    ├─┬─────────────────────────────────────────────────────────────┐
 *    │ │  PATH B — HYBRID RETRIEVAL (dense + BM25 + metadata filter) │
 *    │ │  embedder.embed(expandedQuery)                              │
 *    │ │  hybridStore.search(qEmb, expandedQuery, candidateK)        │
 *    │ │  filter.filterResults(candidates, metaFilter)               │
 *    │ │  → vectorChunks[]                                           │
 *    │ └─────────────────────────────────────────────────────────────┘
 *    │
 *    ├─► [Context Fusion]          fuser.fuse(graphPaths, vectorChunks, query)
 *    │                             → { graphFacts, textChunks, combined }
 *    │
 *    └─► [Optional Rerank]         reranker.rerank(query, vectorChunks)
 *
 * ─── Swappability ─────────────────────────────────────────────────────────
 * Every collaborator (embedder, hybridStore, graphStore, ner, glossary,
 * filter, fuser, reranker) is injected and conforms to its interface.
 * Any of them can be null — the pipeline degrades gracefully.
 */

const { serverEvents } = require('../shared/events');

class GraphRAGPipeline {
  /**
   * @param {Embedder}              embedder
   * @param {HybridStore}           hybridStore
   * @param {GraphStore}            graphStore
   * @param {object}                [opts]
   * @param {EntityExtractor}       [opts.ner]
   * @param {AcronymGlossary}       [opts.glossary]
   * @param {MetadataFilter}        [opts.filter]
   * @param {ContextFuser}          [opts.fuser]
   * @param {Reranker}              [opts.reranker]
   * @param {number}                [opts.graphDepth=1]   hop depth for graph traversal
   * @param {number}                [opts.candidateK=20]  multiplier for pre-filter pool
   */
  constructor(embedder, hybridStore, graphStore, opts = {}) {
    this.embedder    = embedder;
    this.hybridStore = hybridStore;
    this.graphStore  = graphStore;
    this.ner         = opts.ner       || null;
    this.glossary    = opts.glossary  || null;
    this.filter      = opts.filter    || null;
    this.fuser       = opts.fuser     || null;
    this.reranker    = opts.reranker  || null;
    this.graphDepth  = opts.graphDepth  ?? 1;
    this.candidateK  = opts.candidateK  ?? 20;
  }

  /**
   * @param {string} query
   * @param {number} [topK=5]
   * @returns {Promise<GraphRAGResult>}
   */
  async run(query, topK = 5) {
    const start = Date.now();
    serverEvents.logEvent('graph-rag:start', { query, topK });

    try {
      // ── Step 1: Acronym expansion ──────────────────────────────────────────
      const expandedQuery = this.glossary ? this.glossary.expand(query) : query;
      if (expandedQuery !== query) {
        serverEvents.logEvent('graph-rag:expanded', { original: query, expanded: expandedQuery });
      }

      // ── Step 2: Query NER ──────────────────────────────────────────────────
      const entities = this.ner ? await this.ner.extract(expandedQuery) : {};
      serverEvents.logEvent('graph-rag:entities', { entities });

      // ── Step 3: Build metadata filter ──────────────────────────────────────
      const metaFilter = this.filter ? this.filter.build(entities) : {};

      // Flatten all entity values for graph traversal
      const allEntityValues = Object.values(entities).flat();

      // ── Step 4: Parallel retrieval ──────────────────────────────────────────
      const [graphPaths, vectorChunks] = await Promise.all([
        this._runGraphPath(allEntityValues),
        this._runVectorPath(expandedQuery, metaFilter, topK),
      ]);

      serverEvents.logEvent('graph-rag:retrieved', {
        graphPaths: graphPaths.length,
        vectorChunks: vectorChunks.length,
      });

      // ── Step 5: Optional rerank of vector chunks ───────────────────────────
      let rankedChunks = vectorChunks;
      if (this.reranker && vectorChunks.length > 0) {
        rankedChunks = await this.reranker.rerank(query, vectorChunks);
        serverEvents.logEvent('graph-rag:reranked', { count: rankedChunks.length });
      }
      rankedChunks = rankedChunks.slice(0, topK);

      // ── Step 6: Context fusion ─────────────────────────────────────────────
      const fusedContext = this.fuser
        ? this.fuser.fuse(graphPaths, rankedChunks, query)
        : _defaultFuse(graphPaths, rankedChunks);

      const duration = Date.now() - start;
      serverEvents.logEvent('graph-rag:complete', {
        graphFactCount: fusedContext.graphFacts?.length ?? 0,
        textChunkCount: fusedContext.textChunks?.length ?? 0,
        duration,
      });

      return {
        success: true,
        query,
        expandedQuery,
        entities,
        filter: Object.fromEntries(
          Object.entries(metaFilter).map(([k, v]) => [k, [...v]])
        ),
        graphPaths,
        vectorChunks: rankedChunks,
        context: fusedContext,
        resultsCount: rankedChunks.length,
        duration: `${duration}ms`,
        // Convenience: pass combined context string straight to the LLM
        combinedContext: fusedContext.combined ?? '',
      };

    } catch (err) {
      serverEvents.logEvent('error', { stage: 'graph-rag', message: err.message });
      return { success: false, error: err.message, duration: `${Date.now() - start}ms` };
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  async _runGraphPath(entityValues) {
    if (!this.graphStore || entityValues.length === 0) return [];
    try {
      return await this.graphStore.queryByEntities(entityValues, this.graphDepth);
    } catch (err) {
      serverEvents.logEvent('graph-rag:graph-error', { error: err.message });
      return [];
    }
  }

  async _runVectorPath(expandedQuery, metaFilter, topK) {
    if (!this.embedder || !this.hybridStore) return [];
    try {
      const qEmb = await this.embedder.embed(expandedQuery);
      const candidates = await this.hybridStore.search(qEmb, expandedQuery, this.candidateK);

      if (this.filter && Object.keys(metaFilter).length > 0) {
        const filtered = this.filter.filterResults(candidates, metaFilter);
        // Graceful degradation: if filter wiped everything, keep unfiltered pool
        return filtered.length > 0 ? filtered : candidates;
      }
      return candidates;
    } catch (err) {
      serverEvents.logEvent('graph-rag:vector-error', { error: err.message });
      return [];
    }
  }
}

// Minimal inline fuse used when no ContextFuser is injected
function _defaultFuse(graphPaths, vectorChunks) {
  const graphFacts = graphPaths.map(t =>
    `${t.subject} ${t.predicate} ${t.object}`
  );
  return {
    graphFacts,
    textChunks: vectorChunks,
    combined: [
      graphFacts.length > 0 ? '## Graph Facts\n' + graphFacts.join('\n') : '',
      vectorChunks.length > 0 ? '## Text Passages\n' + vectorChunks.map((r, i) => `[${i+1}] ${r.metadata?.content || ''}`).join('\n\n') : '',
    ].filter(Boolean).join('\n\n') || '(no context)',
    meta: { fusionStrategy: 'default-inline' },
  };
}

module.exports = { GraphRAGPipeline };
