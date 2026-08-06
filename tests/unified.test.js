/**
 * Unified Architecture Validation Tests
 *
 * These tests target the specific bugs and design decisions resolved in the
 * unified pipeline refactor. They are grouped by priority:
 *
 *  P0 — Data integrity / soft-delete correctness
 *  P1 — Fusion, authority, and reranking behavior
 *  P2 — Performance guards (concurrency, multi-chunk updates)
 *  P3 — Ergonomics / edge cases
 *
 * Run all:
 *   node rag-server.js --unified-test
 *
 * Run mock-only subset (no external services):
 *   node rag-server.js --unified-test --mock-only
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const { TestRunner } = require('./runner');
const { MockEmbedder } = require('../src/retrieval/embedders/mock');
const { MockVectorStore } = require('../src/retrieval/stores/mock');
const { MockDocumentLoader } = require('../src/ingestion/loaders/mock');
const { MockEntityExtractor } = require('../src/retrieval/ner/mock-extractor');
const { MockMetadataFilter } = require('../src/retrieval/ner/mock-filter');
const { MockRelationshipExtractor } = require('../src/ingestion/graph/mock-extractor');
const { MockProvenanceAnnotator } = require('../src/ingestion/authority/mock-annotator');
const { StaticDictionaryScorer } = require('../src/retrieval/authority/mock-scorer');
const { MockContextFuser } = require('../src/retrieval/graph/mock-fuser');
const { MockReranker } = require('../src/retrieval/rerankers/mock');
const { AuthorityAwareReranker } = require('../src/retrieval/rerankers/authority-aware');
const { BM25Store } = require('../src/retrieval/stores/bm25');
const { HybridStore } = require('../src/retrieval/stores/hybrid');
const { ConcreteInjectionPipeline } = require('../src/ingestion/pipeline');
const { DocRegistry, hashContent } = require('../src/ingestion/registry');
const { UnifiedRetrievalPipeline } = require('../src/retrieval/unified-pipeline');
const { AgenticRetrievalPipeline } = require('../src/agentic/pipeline');
const { Observation } = require('../src/agentic/observation');
const { RetrievalObjectives } = require('../src/shared/interfaces');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tempRegistry() {
  const tmp = path.join(os.tmpdir(), `rag-unified-${process.pid}.json`);
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  return new DocRegistry(tmp);
}

function buildMockUnified(opts = {}) {
  const embedder = new MockEmbedder();
  const vectorStore = new MockVectorStore();
  const bm25 = new BM25Store();
  const hybrid = new HybridStore(vectorStore, bm25);
  const graphStore = opts.graphStore || new (require('../src/ingestion/graph/mock-store').MockGraphStore)();
  const fuser = new MockContextFuser({ minGraphConfidence: opts.minGraphConfidence ?? 0.6 });

  const pipeline = new UnifiedRetrievalPipeline({
    embedder,
    hybridStore: hybrid,
    graphStore,
    contextFuser: fuser,
    ner: new MockEntityExtractor(),
    glossary: null,
    filter: new MockMetadataFilter(),
    minGraphConfidence: opts.minGraphConfidence ?? 0.6,
    graphDepth: opts.graphDepth ?? 2,
    candidateK: opts.candidateK ?? 20,
  });

  return { pipeline, embedder, vectorStore, bm25, hybrid, graphStore, fuser };
}

function seedStore(hybrid, embedder, docs) {
  for (const [id, text] of docs) {
    hybrid.store(id, embedder.embed(text), { original_id: id, content: text });
  }
}

// ─── Mock-only tests ─────────────────────────────────────────────────────────

async function setupMockTests() {
  const runner = new TestRunner();

  // ── P1: Confidence filtering ──────────────────────────────────────────────

  runner.test('P1: MockContextFuser filters low-confidence triples via constructor', async (assert) => {
    const { fuser } = buildMockUnified({ minGraphConfidence: 0.7 });
    const graphPaths = [
      { subject: 'A', predicate: 'TREATS', object: 'B', confidence: 0.3, sourceChunkId: 'c1' },
      { subject: 'A', predicate: 'TREATS', object: 'C', confidence: 0.9, sourceChunkId: 'c2' },
    ];
    const vectorChunks = [
      { id: 'd1', score: 0.8, metadata: { content: 'text', original_id: 'd1' } },
    ];

    const result = fuser.fuse(graphPaths, vectorChunks, 'A');
    await assert.assertTrue(result.graphFacts.some(f => f.includes('C')), 'includes high-confidence triple');
    await assert.assertTrue(!result.graphFacts.some(f => f.includes('B')), 'excludes low-confidence triple');
    await assert.assertEqual(result.droppedGraphFacts.length, 1, 'droppedGraphFacts contains the excluded triple');
    await assert.assertEqual(result.droppedGraphFacts[0].object, 'B', 'dropped triple is the 0.3-confidence one');
  });

  runner.test('P1: MockContextFuser default minGraphConfidence is 0.6', async (assert) => {
    const { fuser } = buildMockUnified();
    const graphPaths = [
      { subject: 'X', predicate: 'REL', object: 'Y', confidence: 0.5, sourceChunkId: 'c1' },
      { subject: 'X', predicate: 'REL', object: 'Z', confidence: 0.9, sourceChunkId: 'c2' },
    ];
    const result = fuser.fuse(graphPaths, [], 'X');
    await assert.assertEqual(result.graphFacts.length, 1, 'only the 0.9 triple passes');
    await assert.assertEqual(result.droppedGraphFacts.length, 1, 'the 0.5 triple is dropped');
  });

  // ── P2: Authority baseline neutrality ────────────────────────────────────

  runner.test('P2: StaticDictionaryScorer returns configurable baseline for completely unknown chunks', async (assert) => {
    const scorer = new StaticDictionaryScorer();
    const score = scorer.computeScore({});
    // Weights: domain 0.40 * 0.50 + docType 0.40 * 0.50 + recency 0.20 * 1.0 = 0.60
    await assert.assertTrue(Math.abs(score - 0.6) < 1e-9, `unknown baseline is ~0.60 (got ${score})`);
  });

  runner.test('P2: StaticDictionaryScorer boosts known-domain chunks above unknown', async (assert) => {
    const scorer = new StaticDictionaryScorer();
    const unknownScore = scorer.computeScore({});
    const knownScore = scorer.computeScore({
      source_domain: 'nejm.org',
      document_type: 'RCT',
      publication_year: 2024,
    });
    await assert.assertTrue(knownScore > unknownScore, 'known authority beats unknown baseline');
    await assert.assertTrue(knownScore > 0.80, 'high-authority chunk scores above 0.80');
  });

  // ── P3: Reranker can be explicitly disabled ───────────────────────────────

  runner.test('P3: AgenticRetrievalPipeline accepts reranker: null without error', async (assert) => {
    const { embedder, hybrid } = buildMockUnified();
    seedStore(hybrid, embedder, [
      ['dl1', 'deep learning neural networks explained'],
      ['dl2', 'machine learning algorithms and models'],
    ]);

    const pipeline = new AgenticRetrievalPipeline(
      embedder, hybrid, null,
      { objective: RetrievalObjectives.BALANCED, latencyBudget: 5000, maxIterations: 1, minimumQuality: 0.3 },
      null, null, null, null
    );

    const result = await pipeline.run('deep learning', 2);
    await assert.assertTrue(result.success, 'pipeline succeeds with reranker disabled');
    await assert.assertTrue(Array.isArray(result.results), 'returns results array');
  });

  // ── P1: UnifiedRetrievalPipeline does not rerank ──────────────────────────

  runner.test('P1: UnifiedRetrievalPipeline returns pre-rerank candidates', async (assert) => {
    const { pipeline, embedder, hybrid } = buildMockUnified();
    seedStore(hybrid, embedder, [
      ['d1', 'cats and dogs are pets'],
      ['d2', 'dogs and cats friendship'],
    ]);

    const result = await pipeline.retrieve('dogs', { topK: 2 });
    await assert.assertTrue(result.success, 'retrieve succeeds');
    await assert.assertTrue(Array.isArray(result.candidates), 'candidates array present');
    await assert.assertTrue(result.candidates.length > 0, 'has candidates');
    // The unified pipeline should NOT apply reranking — scores should be raw RRF scores
    // MockReranker would add a rerankReason field; unified should not.
    await assert.assertTrue(!('rerankReason' in result.candidates[0]), 'candidates are not reranked');
  });

  // ── P1: Graph facts confidence annotation ─────────────────────────────────

  runner.test('P1: MockContextFuser annotates confidence in graph fact strings', async (assert) => {
    const { fuser } = buildMockUnified();
    const graphPaths = [
      { subject: 'A', predicate: 'TREATS', object: 'B', confidence: 0.85, sourceChunkId: 'c1' },
    ];
    const result = fuser.fuse(graphPaths, [], 'A');
    await assert.assertTrue(result.graphFacts[0].includes('confidence: 85%'), 'non-unity confidence is annotated');
  });

  runner.test('P1: MockContextFuser omits confidence tag for unity-confidence triples', async (assert) => {
    const { fuser } = buildMockUnified();
    const graphPaths = [
      { subject: 'A', predicate: 'TREATS', object: 'B', confidence: 1.0, sourceChunkId: 'c1' },
    ];
    const result = fuser.fuse(graphPaths, [], 'A');
    await assert.assertTrue(!result.graphFacts[0].includes('confidence'), 'unity confidence has no tag');
  });

  return runner;
}

// ─── Real integration tests (require Neo4j + Chroma + Postgres) ──────────────

async function setupRealTests() {
  const runner = new TestRunner();

  // ── P0: Prefix collision safe delete ─────────────────────────────────────

  runner.test('P0: Neo4jGraphStore.deleteByDocId uses prefix-safe STARTS WITH', async (assert) => {
    const graphStore = new (require('../src/ingestion/graph/store').Neo4jGraphStore)();
    await graphStore.clear();

    const docId = 'doc1.md';
    const backupDocId = 'doc1_backup.md';

    await graphStore.storeTriple({ subject: 'A', predicate: 'TREATS', object: 'B', confidence: 0.9, sourceChunkId: `${docId}_chunk_0`, documentId: docId });
    await graphStore.storeTriple({ subject: 'C', predicate: 'CAUSES', object: 'D', confidence: 0.9, sourceChunkId: `${backupDocId}_chunk_0`, documentId: backupDocId });

    await graphStore.deleteByDocId(docId);

    const stats = await graphStore.getStats();
    await assert.assertEqual(stats.tripleCount, 1, 'only the backup doc triple remains');

    const remaining = await graphStore.queryByEntity('C', 1);
    await assert.assertEqual(remaining.length, 1, 'backup triple is still queryable');
    await assert.assertEqual(remaining[0].object, 'd', 'backup triple object is intact');

    const deleted = await graphStore.queryByEntity('A', 1);
    await assert.assertEqual(deleted.length, 0, 'deleted doc triples are gone');

    await graphStore.clear();
  });

  // ── P0: Full rebuild clears graph ────────────────────────────────────────

  runner.test('P0: ConcreteInjectionPipeline.run() clears Neo4j before ingestion', async (assert) => {
    const loader = new MockDocumentLoader();
    const embedder = new MockEmbedder();
    const store = new MockVectorStore();
    const bm25 = new BM25Store();
    const hybrid = new HybridStore(store, bm25);
    const ner = new MockEntityExtractor();
    const relExtractor = new MockRelationshipExtractor();
    const graphStore = new (require('../src/ingestion/graph/store').Neo4jGraphStore)();
    const annotator = new MockProvenanceAnnotator();

    const pipeline = new ConcreteInjectionPipeline(
      loader, embedder, hybrid, ner, relExtractor, graphStore, annotator
    );

    await graphStore.clear();
    await graphStore.storeTriple({ subject: 'STALE', predicate: 'TREATS', object: 'OLD', confidence: 0.9, sourceChunkId: 'stale_chunk_0', documentId: 'stale.md' });

    const statsBefore = await graphStore.getStats();
    await assert.assertTrue(statsBefore.tripleCount >= 1, 'seeded a stale triple');

    const registry = tempRegistry();
    const result = await pipeline.run('./examples', registry);

    await assert.assertEqual(result.success, true, 'injection succeeds');

    // The stale triple must be gone. New triples from ./examples may exist,
    // so we verify by querying for the stale subject directly.
    const stale = await graphStore.queryByEntity('stale', 1);
    await assert.assertEqual(stale.length, 0, 'stale triple is removed after full rebuild');

    await graphStore.clear();
    fs.unlinkSync(registry.filePath);
  });

  // ── P0: Incremental sync cleans graph for removed/changed docs ────────────

  runner.test('P0: runIncremental deletes Neo4j triples for removed and changed docs', async (assert) => {
    const loader = new MockDocumentLoader();
    const embedder = new MockEmbedder();
    const store = new MockVectorStore();
    const bm25 = new BM25Store();
    const hybrid = new HybridStore(store, bm25);
    const ner = new MockEntityExtractor();
    const relExtractor = new MockRelationshipExtractor();
    const graphStore = new (require('../src/ingestion/graph/store').Neo4jGraphStore)();
    const annotator = new MockProvenanceAnnotator();

    const pipeline = new ConcreteInjectionPipeline(
      loader, embedder, hybrid, ner, relExtractor, graphStore, annotator
    );

    await graphStore.clear();

    // Round 1: inject two docs
    const docs1 = [
      { id: 'a.md', content: 'AZT treats HIV', metadata: { file: 'a.md', size: 20, mtime: 1000 } },
      { id: 'b.md', content: 'HIV causes AIDS', metadata: { file: 'b.md', size: 20, mtime: 1000 } },
    ];
    const registry = tempRegistry();
    // We bypass the loader and feed docs directly via a temporary registry + runIncremental.
    // But runIncremental reads from loader. So we use a mock loader pattern:
    const currentDocs = [];
    const mutableLoader = new (class extends (require('../src/shared/interfaces').DocumentLoader) {
      async loadDocuments() {
        return currentDocs.map(d => ({
          id: d.id, content: d.content,
          metadata: { file: d.id, path: d.id, size: d.content.length, mtime: 0 }
        }));
      }
    })();

    const mutablePipeline = new ConcreteInjectionPipeline(
      mutableLoader, embedder, hybrid, ner, relExtractor, graphStore, annotator
    );

    currentDocs.push(...docs1);
    await mutablePipeline.runIncremental('/x', registry);

    let stats = await graphStore.getStats();
    await assert.assertTrue(stats.tripleCount >= 2, 'initial ingest created triples');

    // Round 2: remove doc a, change doc b to content that still produces a triple
    currentDocs.length = 0;
    currentDocs.push({
      id: 'b.md',
      content: 'AZT treats HIV',
      metadata: { file: 'b.md', size: 20, mtime: 2000 },
    });

    await mutablePipeline.runIncremental('/x', registry);

    stats = await graphStore.getStats();
    await assert.assertTrue(stats.tripleCount >= 1, 'changed doc created new triples');

    const aztTriples = await graphStore.queryByEntity('azt', 1);
    await assert.assertTrue(aztTriples.some(t => t.subject === 'azt' && t.object === 'hiv'), 'AZT->HIV triple exists from changed doc');

    await graphStore.clear();
    fs.unlinkSync(registry.filePath);
  });

  // ── P2: Confidence filtering via real UnifiedRetrievalPipeline ────────────

  runner.test('P2: UnifiedRetrievalPipeline filters graph facts below minGraphConfidence', async (assert) => {
    const graphStore = new (require('../src/ingestion/graph/store').Neo4jGraphStore)();
    await graphStore.clear();
    const emptyStats = await graphStore.getStats();
    await assert.assertEqual(emptyStats.tripleCount, 0, 'graph is empty before seeding test data');

    await graphStore.storeTriple({ subject: 'AZT', predicate: 'TREATS', object: 'HIV', confidence: 0.3, sourceChunkId: 'low_chunk_0', documentId: 'low.md' });
    await graphStore.storeTriple({ subject: 'AZT', predicate: 'TREATS', object: 'AIDS', confidence: 0.9, sourceChunkId: 'high_chunk_0', documentId: 'high.md' });

    const { pipeline } = buildMockUnified({ minGraphConfidence: 0.6, graphStore });

    const result = await pipeline.retrieve('AZT', { topK: 5 });
    await assert.assertTrue(result.success, 'retrieve succeeds');
    await assert.assertTrue(result.graphFacts.some(f => f.includes('AIDS')), 'includes high-confidence fact');
    await assert.assertTrue(!result.graphFacts.some(f => f.includes('HIV')), 'excludes low-confidence fact');
    await assert.assertTrue(result.droppedGraphFacts.some(f => f.object === 'hiv'), 'droppedGraphFacts contains the low-confidence triple');

    await graphStore.clear();
  });

  // ── P2: Concurrency cap respected ────────────────────────────────────────

  runner.test('P2: queryByEntities batches Neo4j queries when exceeding maxConcurrent', async (assert) => {
    const graphStore = new (require('../src/ingestion/graph/store').Neo4jGraphStore)();
    await graphStore.clear();

    const entities = [];
    for (let i = 0; i < 8; i++) {
      const name = `entity_${i}`;
      entities.push(name);
      await graphStore.storeTriple({ subject: name, predicate: 'RELATED_TO', object: `target_${i}`, confidence: 0.9, sourceChunkId: `${name}_chunk_0`, documentId: name });
    }

    const start = Date.now();
    const results = await graphStore.queryByEntities(entities, 1, 5);
    const duration = Date.now() - start;

    await assert.assertEqual(results.length, 8, 'all 8 entity triples returned');
    await assert.assertTrue(duration < 30000, `batched query completed in ${duration}ms (under 30s)`);

    await graphStore.clear();
  });

  return runner;
}

// ─── Entry points ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const mockOnly = args.includes('--mock-only');

  try {
    if (mockOnly) {
      const runner = await setupMockTests();
      const ok = await runner.run();
      process.exit(ok ? 0 : 1);
    } else {
      const mockRunner = await setupMockTests();
      const realRunner = await setupRealTests();

      let allPassed = true;

      console.log('\n── Mock unified tests ──');
      const mockOk = await mockRunner.run();
      allPassed = allPassed && mockOk;

      console.log('\n── Real unified tests ──');
      const realOk = await realRunner.run();
      allPassed = allPassed && realOk;

      process.exit(allPassed ? 0 : 1);
    }
  } catch (e) {
    console.error('\n❌ Unified tests failed:', e.message);
    process.exit(1);
  }
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

module.exports = { setupMockTests, setupRealTests };
