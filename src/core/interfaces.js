/**
 * Abstract base classes defining the seams of the system. Concrete mock and
 * real implementations live under loaders/, embedders/, stores/, pipelines/.
 */
class DocumentLoader { async loadDocuments(folderPath) { throw new Error('not implemented'); } }
class Embedder { async embed(text) { throw new Error('not implemented'); } async embedBatch(texts) { throw new Error('not implemented'); } }
class VectorStore { async store(id, embedding, metadata) { throw new Error('not implemented'); } async query(queryEmbedding, topK, queryText = '') { throw new Error('not implemented'); } async clear() { throw new Error('not implemented'); } async deleteByDocId(docId) { throw new Error('not implemented'); } async getStats() { throw new Error('not implemented'); } }
class InjectionPipeline { constructor(loader, embedder, store) { this.loader = loader; this.embedder = embedder; this.store = store; } async run(folderPath) { throw new Error('not implemented'); } }
class RetrievalPipeline { constructor(embedder, store) { this.embedder = embedder; this.store = store; } async run(query, topK) { throw new Error('not implemented'); } }
class Reranker { async rerank(query, documents) { throw new Error('not implemented'); } }
class KeywordStore { async index(id, content, metadata) { throw new Error('not implemented'); } async search(query, topK) { throw new Error('not implemented'); } async clear() { throw new Error('not implemented'); } async deleteByDocId(docId) { throw new Error('not implemented'); } async getStats() { throw new Error('not implemented'); } }

class Coordinator { async run(observation, goal) { throw new Error('not implemented'); } }
class RetrievalPolicy { resolve(assessment, goal, trace) { throw new Error('not implemented'); } }

/**
 * Authority scorer seam.
 *
 * Takes a chunk's provenance metadata (authority_signal) and returns a
 * normalised authority score in [0.0, 1.0].
 *
 * computeScore(authoritySignal) → number
 *   authoritySignal = {
 *     source_domain?:         string,   e.g. "nejm.org"
 *     document_type?:         string,   e.g. "RCT" | "meta-analysis" | "review" | ...
 *     publication_year?:      number,
 *     citation_count?:        number,
 *     journal_impact_factor?: number,
 *   }
 *
 * updateWeights(newGroundTruth) → void
 *   newGroundTruth = { [domain_or_type]: float }
 *   Allows dynamic recalibration without restarting the server.
 */
class AuthorityScorer {
  computeScore(authoritySignal) { throw new Error('not implemented'); }
  updateWeights(newGroundTruth)  { throw new Error('not implemented'); }
}

/**
 * Provenance / authority annotator seam.
 *
 * Runs at ingestion time — reads a document's raw metadata and produces an
 * `authority_signal` object that is attached to every chunk from that document.
 *
 * annotate(docMetadata) → authoritySignal
 *   docMetadata = whatever the DocumentLoader returns in doc.metadata
 *   authoritySignal = { source_domain, document_type, publication_year, ... }
 *
 * The contract is intentionally loose on the output shape so implementations
 * can add domain-specific fields. The AuthorityScorer must handle whatever
 * shape the annotator produces.
 */
class ProvenanceAnnotator {
  annotate(docMetadata) { throw new Error('not implemented'); }
}

/**
 * Graph store seam.
 *
 * Stores and queries knowledge-graph triples of the form:
 *   { subject, predicate, object, sourceChunkId, metadata }
 *
 * storeTriple(triple)               → Promise<void>
 * queryByEntity(entityName, depth)  → Promise<GraphPath[]>
 *   GraphPath = { subject, predicate, object, sourceChunkId, metadata }
 * queryByEntities(entityNames, depth) → Promise<GraphPath[]>
 * clear()                           → Promise<void>
 * getStats()                        → Promise<{ tripleCount, entityCount }>
 */
class GraphStore {
  async storeTriple(triple) { throw new Error('not implemented'); }
  async queryByEntity(entityName, depth) { throw new Error('not implemented'); }
  async queryByEntities(entityNames, depth) { throw new Error('not implemented'); }
  async clear() { throw new Error('not implemented'); }
  async getStats() { throw new Error('not implemented'); }
}

/**
 * Relationship-extraction seam.
 *
 * Extracts Subject-Predicate-Object triples from text.
 * Swap with REBEL, OpenIE, or a fine-tuned model.
 *
 * extract(text, sourceChunkId) → Promise<Triple[]>
 *   Triple = { subject, predicate, object, confidence, sourceChunkId }
 */
class RelationshipExtractor {
  async extract(text, sourceChunkId) { throw new Error('not implemented'); }
}

/**
 * Context fusion seam.
 *
 * Merges structured graph paths with unstructured vector-chunk results
 * into a unified context object ready for the reranker / LLM.
 *
 * fuse(graphPaths, vectorChunks, query) → FusedContext
 *   FusedContext = {
 *     graphFacts:   string[],   — human-readable "subject PREDICATE object" lines
 *     textChunks:   object[],   — vector results (pass-through)
 *     combined:     string,     — single context string for the LLM prompt
 *   }
 */
class ContextFuser {
  fuse(graphPaths, vectorChunks, query) { throw new Error('not implemented'); }
}

/**
 * NER / entity-extraction seam.
 * extract(text) → { DRUG: [...], GENE: [...], DISEASE: [...], BIOMARKER: [...], ... }
 * Entity keys are upper-case label strings; values are arrays of surface strings.
 */
class EntityExtractor { async extract(text) { throw new Error('not implemented'); } }

/**
 * Acronym glossary seam.
 * expand(text) → string  — replaces known acronyms with "ACRONYM OR expanded-form" pairs.
 * lookup(acronym) → string[] — returns all expansions for a single token (empty if unknown).
 */
class AcronymGlossary {
  expand(text) { throw new Error('not implemented'); }
  lookup(acronym) { throw new Error('not implemented'); }
}

/**
 * Metadata filter seam.
 * Converts an entity map produced by EntityExtractor into a filter object that
 * the vector / keyword stores can apply to restrict result sets.
 *
 * build(entities) → object  — e.g. { DISEASE: 'HIV', DRUG: 'AZT' }
 * match(chunkMetadata, filter) → boolean  — true if the chunk passes the filter.
 */
class MetadataFilter {
  build(entities) { throw new Error('not implemented'); }
  match(chunkMetadata, filter) { throw new Error('not implemented'); }
}

const RetrievalObjectives = { BALANCED: 'BALANCED', MAXIMIZE_RECALL: 'MAXIMIZE_RECALL', MINIMIZE_LATENCY: 'MINIMIZE_LATENCY', MAXIMIZE_PRECISION: 'MAXIMIZE_PRECISION' };

module.exports = {
  DocumentLoader, Embedder, VectorStore, InjectionPipeline, RetrievalPipeline,
  Reranker, KeywordStore, Coordinator, RetrievalPolicy, RetrievalObjectives,
  EntityExtractor, AcronymGlossary, MetadataFilter,
  GraphStore, RelationshipExtractor, ContextFuser,
  AuthorityScorer, ProvenanceAnnotator,
};
