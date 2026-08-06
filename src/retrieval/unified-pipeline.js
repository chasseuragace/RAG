const { serverEvents } = require('../shared/events');

class UnifiedRetrievalPipeline {
  /**
   * Fuses graph traversal + hybrid vector/BM25 retrieval into a single
   * context object. Does NOT rerank — reranking is left to the caller
   * (typically the agentic loop) so it happens exactly once.
   *
   * @param {object} options
   * @param {Embedder}      options.embedder
   * @param {HybridStore}   options.hybridStore
   * @param {GraphStore}    options.graphStore
   * @param {ContextFuser}  options.contextFuser
   * @param {EntityExtractor} [options.ner]
   * @param {AcronymGlossary} [options.glossary]
   * @param {MetadataFilter}  [options.filter]
   * @param {number}         [options.minGraphConfidence=0.6]
   * @param {number}         [options.graphDepth=2]
   * @param {number}         [options.candidateK=20]
   */
  constructor(options = {}) {
    this.embedder       = options.embedder;
    this.hybridStore    = options.hybridStore;
    this.graphStore     = options.graphStore;
    this.contextFuser   = options.contextFuser;
    this.ner            = options.ner ?? null;
    this.glossary       = options.glossary ?? null;
    this.filter         = options.filter ?? null;
    this.minGraphConfidence = options.minGraphConfidence ?? 0.6;
    this.graphDepth     = options.graphDepth ?? 2;
    this.candidateK     = options.candidateK ?? 20;
  }

  /**
   * @param {string} query
   * @param {object} [opts]
   * @param {number} [opts.topK=5]
   * @returns {Promise<{ success: boolean, graphFacts: string[], droppedGraphFacts: object[], candidates: object[], combined: string, duration: string }>}
   */
  async retrieve(query, opts = {}) {
    const start = Date.now();
    const topK = opts.topK || 5;
    serverEvents.logEvent('unified:start', { query, topK });

    try {
      // 1. Acronym expansion
      const expandedQuery = this.glossary ? await this.glossary.expand(query) : query;

      // 2. NER
      const entities = this.ner ? await this.ner.extract(expandedQuery) : {};
      const metaFilter = this.filter ? this.filter.build(entities) : {};
      const allEntityValues = Object.values(entities).flat();

      // 3. Parallel retrieval
      const [graphPaths, vectorChunks] = await Promise.all([
        this._runGraphPath(allEntityValues),
        this._runVectorPath(expandedQuery, metaFilter, topK),
      ]);

      serverEvents.logEvent('unified:retrieved', {
        graphPaths: graphPaths.length,
        vectorChunks: vectorChunks.length,
      });

      // 4. Fuse (pass minGraphConfidence via options on the fuser instance if it supports it)
      const fused = this.contextFuser
        ? this.contextFuser.fuse(graphPaths, vectorChunks, expandedQuery)
        : this._defaultFuse(graphPaths, vectorChunks);

      const duration = Date.now() - start;
      serverEvents.logEvent('unified:complete', {
        graphFactCount: fused.graphFacts?.length ?? 0,
        textChunkCount: fused.textChunks?.length ?? 0,
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
        graphFacts: fused.graphFacts || [],
        droppedGraphFacts: fused.droppedGraphFacts || [],
        candidates: fused.textChunks || vectorChunks,
        combined: fused.combined || '',
        duration: `${duration}ms`,
      };
    } catch (err) {
      serverEvents.logEvent('error', { stage: 'unified', message: err.message });
      return { success: false, error: err.message, duration: `${Date.now() - start}ms` };
    }
  }

  async _runGraphPath(entityValues) {
    if (!this.graphStore || entityValues.length === 0) return [];
    try {
      return await this.graphStore.queryByEntities(entityValues, this.graphDepth);
    } catch (err) {
      serverEvents.logEvent('unified:graph-error', { error: err.message });
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
        return filtered.length > 0 ? filtered : candidates;
      }
      return candidates;
    } catch (err) {
      serverEvents.logEvent('unified:vector-error', { error: err.message });
      return [];
    }
  }

  _defaultFuse(graphPaths, vectorChunks) {
    const graphFacts = (graphPaths || []).map(t =>
      `${t.subject.toUpperCase()} ${t.predicate} ${t.object.toUpperCase()}` +
      (t.confidence < 1.0 ? ` [confidence: ${(t.confidence * 100).toFixed(0)}%]` : '') +
      (t.sourceChunkId ? ` (source: ${t.sourceChunkId})` : '')
    );
    const textChunks = (vectorChunks || []).slice(0, this.candidateK);
    const combined = [
      graphFacts.length > 0 ? '## Verified Knowledge-Graph Facts\n' + graphFacts.join('\n') : '',
      textChunks.length > 0 ? '## Retrieved Text Passages\n' + textChunks.map((r, i) => `[${i+1}] (source: ${r.metadata?.original_id || r.id || 'chunk-'+i})\n${r.metadata?.content || ''}`).join('\n\n---\n\n') : '',
    ].filter(Boolean).join('\n\n') || '(no context retrieved)';

    return { graphFacts, textChunks, combined, meta: { fusionStrategy: 'default-inline' } };
  }
}

module.exports = { UnifiedRetrievalPipeline };
