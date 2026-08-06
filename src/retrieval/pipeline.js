const { RetrievalPipeline } = require('../shared/interfaces');
const { serverEvents } = require('../shared/events');

class ConcreteRetrievalPipeline extends RetrievalPipeline {
  async run(query, topK = 5) {
    const start = Date.now();
    serverEvents.logEvent('retrieval:start', { query, topK });
    try {
      const qEmb = await this.embedder.embed(query);
      serverEvents.logEvent('retrieval:query-embedded', { queryLength: query.length });
      const results = await this.store.query(qEmb, topK);
      const duration = Date.now() - start;
      serverEvents.logEvent('retrieval:complete', { resultsCount: results.length, duration });
      return {
        success: true,
        query,
        resultsCount: results.length,
        duration: `${duration}ms`,
        results: results.map(r => ({ id: r.id, relevance: (r.score*100).toFixed(2)+'%', metadata: r.metadata }))
      };
    } catch (err) {
      serverEvents.logEvent('error', { stage: 'retrieval', message: err.message });
      return { success: false, error: err.message, duration: `${Date.now()-start}ms` };
    }
  }
}

class HybridRetrievalPipeline {
  constructor(embedder, hybridStore) {
    this.embedder = embedder;
    this.hybridStore = hybridStore;
  }
  async run(query, topK = 5) {
    const start = Date.now();
    serverEvents.logEvent('retrieval:start', { query, topK, mode: 'hybrid' });
    try {
      const qEmb = await this.embedder.embed(query);
      serverEvents.logEvent('retrieval:query-embedded', { queryLength: query.length });
      const results = await this.hybridStore.search(qEmb, query, topK);
      const duration = Date.now() - start;
      serverEvents.logEvent('retrieval:complete', { resultsCount: results.length, duration, mode: 'hybrid' });
      return {
        success: true,
        query,
        resultsCount: results.length,
        duration: `${duration}ms`,
        results: results.map(r => ({ id: r.id, relevance: (r.score*100).toFixed(2)+'%', metadata: r.metadata, rrfRank: r.rrfRank }))
      };
    } catch (err) {
      serverEvents.logEvent('error', { stage: 'retrieval', message: err.message });
      return { success: false, error: err.message, duration: `${Date.now()-start}ms` };
    }
  }
}

/**
 * NEREnrichedRetrievalPipeline
 *
 * Implements the full biomedical retrieval lane:
 *
 *   [Step 1] AcronymGlossary.expand(query)     → expanded query text for BM25 coverage
 *   [Step 2] EntityExtractor.extract(expanded) → entity map { DRUG, DISEASE, BIOMARKER, ... }
 *   [Step 3] MetadataFilter.build(entities)    → filter object (e.g. { DISEASE: Set{'hiv'} })
 *   [Step 4] HybridStore.search(...)           → dense + sparse; post-filtered by MetadataFilter
 *   [Step 5] Reranker (optional)               → final sorted results
 *
 * All four collaborators (embedder, hybridStore, ner, glossary, filter, reranker)
 * conform to their interfaces and can be swapped independently.
 *
 * When ner / glossary / filter are omitted the pipeline degrades gracefully to
 * plain HybridRetrievalPipeline behaviour.
 */
class NEREnrichedRetrievalPipeline {
  /**
   * @param {Embedder}         embedder
   * @param {HybridStore}      hybridStore
   * @param {object}           [opts]
   * @param {EntityExtractor}  [opts.ner]      — NER extractor for query entity tagging
   * @param {AcronymGlossary}  [opts.glossary] — acronym expander
   * @param {MetadataFilter}   [opts.filter]   — metadata filter builder + matcher
   * @param {Reranker}         [opts.reranker] — optional post-filter reranker
   */
  constructor(embedder, hybridStore, opts = {}) {
    this.embedder   = embedder;
    this.hybridStore = hybridStore;
    this.ner        = opts.ner      || null;
    this.glossary   = opts.glossary || null;
    this.filter     = opts.filter   || null;
    this.reranker   = opts.reranker || null;
  }

  async run(query, topK = 5) {
    const start = Date.now();
    serverEvents.logEvent('retrieval:ner:start', { query, topK });

    try {
      // ── Step 1: Acronym expansion ──────────────────────────────────────────
      const expandedQuery = this.glossary ? this.glossary.expand(query) : query;
      if (expandedQuery !== query) {
        serverEvents.logEvent('retrieval:ner:expanded', { original: query, expanded: expandedQuery });
      }

      // ── Step 2: NER on expanded query ──────────────────────────────────────
      const entities = this.ner ? await this.ner.extract(expandedQuery) : {};
      serverEvents.logEvent('retrieval:ner:entities', { entities });

      // ── Step 3: Build metadata filter ──────────────────────────────────────
      const metaFilter = this.filter ? this.filter.build(entities) : {};
      serverEvents.logEvent('retrieval:ner:filter', {
        filter: Object.fromEntries(
          Object.entries(metaFilter).map(([k, v]) => [k, [...v]])
        )
      });

      // ── Step 4: Hybrid retrieval (dense + sparse) ──────────────────────────
      // Fetch a larger candidate pool so the filter has material to work with.
      const candidateK = topK * 4;
      const qEmb = await this.embedder.embed(expandedQuery);
      serverEvents.logEvent('retrieval:ner:query-embedded', {});

      const candidates = await this.hybridStore.search(qEmb, expandedQuery, candidateK);

      // ── Step 4b: Apply metadata filter ────────────────────────────────────
      const filtered = (this.filter && Object.keys(metaFilter).length > 0)
        ? this.filter.filterResults(candidates, metaFilter)
        : candidates;

      serverEvents.logEvent('retrieval:ner:post-filter', {
        candidatesCount: candidates.length,
        filteredCount: filtered.length
      });

      // Fall back to unfiltered results if the filter is too aggressive.
      const pool = filtered.length > 0 ? filtered : candidates;

      // ── Step 5: Rerank & trim ──────────────────────────────────────────────
      let final;
      if (this.reranker && pool.length > 0) {
        final = await this.reranker.rerank(query, pool);
        serverEvents.logEvent('retrieval:ner:reranked', { count: final.length });
      } else {
        final = pool;
      }
      final = final.slice(0, topK);

      const duration = Date.now() - start;
      serverEvents.logEvent('retrieval:ner:complete', { resultsCount: final.length, duration });

      return {
        success: true,
        query,
        expandedQuery,
        entities,
        filter: Object.fromEntries(
          Object.entries(metaFilter).map(([k, v]) => [k, [...v]])
        ),
        resultsCount: final.length,
        duration: `${duration}ms`,
        results: final.map(r => ({
          id: r.id,
          relevance: (r.score * 100).toFixed(2) + '%',
          metadata: r.metadata,
          rrfRank: r.rrfRank
        }))
      };
    } catch (err) {
      serverEvents.logEvent('error', { stage: 'retrieval:ner', message: err.message });
      return { success: false, error: err.message, duration: `${Date.now() - start}ms` };
    }
  }
}

module.exports = { ConcreteRetrievalPipeline, HybridRetrievalPipeline, NEREnrichedRetrievalPipeline };
