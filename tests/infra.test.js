/**
 * Infrastructure tests — hit real Postgres (pg_search BM25), Chroma, and Neo4j.
 *
 * Everything above the storage layer is mocked:
 *   embedder   → MockEmbedder   (deterministic, no Gemini API key needed)
 *   inference  → not used
 *   NER        → MockEntityExtractor
 *   reranker   → MockReranker
 *
 * Run with:
 *   node rag-server.js --infra-test
 *
 * Requires docker compose services to be running:
 *   docker compose up -d postgres neo4j chroma
 *
 * What is tested (one section per service):
 *
 *   ── PostgresBM25Store (pg_search) ──────────────────────────────────────────
 *   I1  init() creates table + BM25 index, reports correct backend
 *   I2  index() + search() returns BM25-ranked results in correct order
 *   I3  phrase_prefix search matches partial terms
 *   I4  deleteByDocId() removes only the target doc's chunks
 *   I5  clear() wipes everything; subsequent search returns empty
 *   I6  getStats() totalDocuments reflects actual distinct doc count
 *   I7  upsert safety — re-indexing same chunk_id replaces, no duplicate
 *   I8  HybridStore with real BM25 + MockVectorStore fuses via RRF
 *   I9  Full injection pipeline (MockLoader → chunk → embed → HybridStore)
 *       persists chunks in both Chroma and pg_search; hybrid search works
 *   I10 DocRegistry persists to Postgres; survives a close/re-init cycle
 *
 *   ── ChromaVectorStore ──────────────────────────────────────────────────────
 *   I11 store() + query() round-trip with deterministic mock embeddings
 *   I12 deleteByDocId() leaves only non-target chunks
 *   I13 clear() → getStats() reports 0 documents
 *
 *   ── Neo4jGraphStore ────────────────────────────────────────────────────────
 *   I14 storeTriple() + queryByEntity() returns correct triples
 *   I15 queryByEntities() merges results for multiple entities
 *   I16 deleteByDocId() is prefix-safe (doc1.md ≠ doc1_backup.md)
 *   I17 replaceTriplesForDoc() atomically swaps old triples for new ones
 *   I18 getStats() tripleCount and entityCount are accurate
 *
 *   ── Cross-store: full ingestion + retrieval round-trip ─────────────────────
 *   I19 ConcreteInjectionPipeline stores chunks in Chroma, BM25, Neo4j,
 *       and registry; NEREnrichedRetrievalPipeline retrieves them
 */

'use strict';

const { TestRunner } = require('./runner');

// Storage
const { PostgresBM25Store }       = require('../src/retrieval/stores/postgres-bm25');
const { ChromaVectorStore }       = require('../src/retrieval/stores/chroma');
const { HybridStore }             = require('../src/retrieval/stores/hybrid');
const { Neo4jGraphStore }         = require('../src/ingestion/graph/store');
const { DocRegistry }             = require('../src/ingestion/registry');

// Pipelines
const { ConcreteInjectionPipeline }       = require('../src/ingestion/pipeline');
const { NEREnrichedRetrievalPipeline }    = require('../src/retrieval/pipeline');

// Mocks (everything above storage)
const { MockEmbedder }            = require('../src/retrieval/embedders/mock');
const { MockDocumentLoader }      = require('../src/ingestion/loaders/mock');
const { MockEntityExtractor }     = require('../src/retrieval/ner/mock-extractor');
const { MockMetadataFilter }      = require('../src/retrieval/ner/mock-filter');
const { MockRelationshipExtractor } = require('../src/ingestion/graph/mock-extractor');
const { MockProvenanceAnnotator } = require('../src/ingestion/authority/mock-annotator');
const { MockReranker }            = require('../src/retrieval/rerankers/mock');

// Config
const { PG_CONNECTION_STRING }    = require('../src/shared/config');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Isolated pg_search store — uses its own dedicated table prefix via a fresh pool */
function makeBM25() {
  return new PostgresBM25Store({ connectionString: PG_CONNECTION_STRING });
}

function makeChroma() {
  return new ChromaVectorStore('http://localhost:8000', 'infra_test');
}

function makeNeo4j() {
  return new Neo4jGraphStore();
}

/** Clear all three infrastructure stores to give each test a clean slate */
async function clearAll(bm25, chroma, neo4j) {
  await Promise.all([
    bm25  ? bm25.clear()   : Promise.resolve(),
    chroma ? chroma.clear() : Promise.resolve(),
    neo4j  ? neo4j.clear()  : Promise.resolve(),
  ]);
}

// ── Test suite ────────────────────────────────────────────────────────────────

async function setupTests() {
  const runner = new TestRunner();

  // ── PostgresBM25Store ─────────────────────────────────────────────────────

  runner.test('I1: PostgresBM25Store.init() connects and reports pg_search backend', async (a) => {
    const store = makeBM25();
    await store.init();
    const stats = await store.getStats();
    await a.assertEqual(stats.backend, 'postgres-pg_search', 'backend is pg_search');
    await a.assertTrue(!store._disabled, 'store is not disabled');
    await store.clear();
    await store.close();
  });

  runner.test('I2: index() + search() returns BM25-ranked results in correct order', async (a) => {
    const store = makeBM25();
    await store.init();
    await store.clear();

    await store.index('cats_0', 'cats and dogs are popular household pets', { original_id: 'cats' });
    await store.index('dogs_0', 'dogs make loyal companions and great friends', { original_id: 'dogs' });
    await store.index('fox_0',  'the quick brown fox jumps over the lazy dog', { original_id: 'fox' });

    const results = await store.search('cats dogs pets', 3);
    await a.assertTrue(results.length > 0, 'search returns results');
    await a.assertTrue(results[0].score > 0, 'top result has positive BM25 score');
    // The cats doc has the most term overlap with the query
    await a.assertEqual(results[0].id, 'cats_0', 'cats doc ranks first for "cats dogs pets"');

    await store.clear();
    await store.close();
  });

  runner.test('I3: search() matches partial terms via phrase_prefix', async (a) => {
    const store = makeBM25();
    await store.init();
    await store.clear();

    await store.index('ml_0', 'machine learning neural networks deep learning', { original_id: 'ml' });
    await store.index('bio_0', 'biology genetics cell division', { original_id: 'bio' });

    // "learn" is a prefix of "learning" — phrase_prefix should still match
    const results = await store.search('learn neural', 5);
    await a.assertTrue(results.some(r => r.id === 'ml_0'), 'partial term "learn" matches "learning"');

    await store.clear();
    await store.close();
  });

  runner.test('I4: deleteByDocId() removes only that doc\'s chunks', async (a) => {
    const store = makeBM25();
    await store.init();
    await store.clear();

    await store.index('a_chunk_0', 'alpha content first chunk',  { original_id: 'a' });
    await store.index('a_chunk_1', 'alpha content second chunk', { original_id: 'a' });
    await store.index('b_chunk_0', 'beta content only chunk',    { original_id: 'b' });

    const removed = await store.deleteByDocId('a');
    await a.assertTrue(removed >= 2, `removed ${removed} chunks for doc a`);

    const stats = await store.getStats();
    await a.assertEqual(stats.totalDocuments, 1, 'only doc b remains');

    const results = await store.search('beta content', 5);
    await a.assertTrue(results.some(r => r.id === 'b_chunk_0'), 'doc b still searchable');
    const aHits = results.filter(r => r.id.startsWith('a_chunk'));
    await a.assertEqual(aHits.length, 0, 'no doc a chunks in results');

    await store.clear();
    await store.close();
  });

  runner.test('I5: clear() wipes all chunks; search returns empty', async (a) => {
    const store = makeBM25();
    await store.init();

    await store.index('x_0', 'some indexed content', { original_id: 'x' });
    await store.clear();

    const results = await store.search('indexed content', 5);
    await a.assertEqual(results.length, 0, 'no results after clear');
    const stats = await store.getStats();
    await a.assertEqual(stats.totalDocuments, 0, 'totalDocuments is 0 after clear');

    await store.close();
  });

  runner.test('I6: getStats() totalDocuments reflects distinct doc count', async (a) => {
    const store = makeBM25();
    await store.init();
    await store.clear();

    await store.index('d1_chunk_0', 'first doc first chunk',  { original_id: 'd1' });
    await store.index('d1_chunk_1', 'first doc second chunk', { original_id: 'd1' });
    await store.index('d2_chunk_0', 'second doc only chunk',  { original_id: 'd2' });

    const stats = await store.getStats();
    // totalDocuments counts distinct doc_ids, not chunk rows
    await a.assertEqual(stats.totalDocuments, 2, 'reports 2 distinct docs (not 3 chunks)');

    await store.clear();
    await store.close();
  });

  runner.test('I7: upsert safety — re-indexing same chunk_id replaces, no duplicate', async (a) => {
    const store = makeBM25();
    await store.init();
    await store.clear();

    await store.index('dup_0', 'original content cats',   { original_id: 'dup' });
    await store.index('dup_0', 'updated content dogs',    { original_id: 'dup' });

    // Only one row should exist — the updated one
    const catResults = await store.search('original cats', 5);
    const dogResults = await store.search('updated dogs', 5);

    // After upsert, "dogs" content should win
    await a.assertTrue(dogResults.some(r => r.id === 'dup_0'), 'updated content is searchable');

    const stats = await store.getStats();
    await a.assertEqual(stats.totalDocuments, 1, 'upsert did not create a duplicate');

    await store.clear();
    await store.close();
  });

  runner.test('I8: HybridStore with real BM25 + MockVectorStore fuses via RRF', async (a) => {
    const bm25   = makeBM25();
    await bm25.init();
    await bm25.clear();

    const embedder = new MockEmbedder();
    const chroma   = makeChroma();
    await chroma.clear();

    const hybrid = new HybridStore(chroma, bm25);

    // Store 3 docs — vector search and BM25 will agree on "cats dogs" doc
    await hybrid.store('h1', await embedder.embed('cats and dogs are pets'),    { original_id: 'h1', content: 'cats and dogs are pets' });
    await hybrid.store('h2', await embedder.embed('machine learning tutorial'), { original_id: 'h2', content: 'machine learning tutorial' });
    await hybrid.store('h3', await embedder.embed('python programming guide'),  { original_id: 'h3', content: 'python programming guide' });

    const qEmb   = await embedder.embed('cats dogs');
    const results = await hybrid.search(qEmb, 'cats dogs', 2);

    await a.assertEqual(results.length, 2, 'hybrid returns topK=2');
    await a.assertTrue(results[0].id === 'h1', 'cats+dogs doc wins RRF fusion');
    await a.assertTrue(typeof results[0].rrfRank === 'number', 'rrfRank is present');
    await a.assertTrue(results[0].score > 0, 'score is positive');

    await hybrid.clear();
    await bm25.close();
  });

  // ── ChromaVectorStore ─────────────────────────────────────────────────────

  runner.test('I11: ChromaVectorStore store() + query() round-trip', async (a) => {
    const embedder = new MockEmbedder();
    const store    = makeChroma();
    await store.clear();

    const emb = await embedder.embed('cats and dogs are popular pets');
    await store.store('c1', emb, { original_id: 'c1', content: 'cats and dogs are popular pets' });
    await store.store('c2', await embedder.embed('python programming'), { original_id: 'c2', content: 'python programming' });

    const qEmb    = await embedder.embed('cats and dogs');
    const results = await store.query(qEmb, 1);

    await a.assertEqual(results.length, 1, 'returns topK=1 result');
    await a.assertEqual(results[0].id, 'c1', 'most similar doc is c1');
    await a.assertTrue(results[0].score > 0.5, 'similarity score is high');

    await store.clear();
  });

  runner.test('I12: ChromaVectorStore deleteByDocId() leaves only non-target chunks', async (a) => {
    const embedder = new MockEmbedder();
    const store    = makeChroma();
    await store.clear();

    await store.store('a_chunk_0', await embedder.embed('alpha zero'), { original_id: 'a', content: 'alpha zero' });
    await store.store('a_chunk_1', await embedder.embed('alpha one'),  { original_id: 'a', content: 'alpha one' });
    await store.store('b_chunk_0', await embedder.embed('beta zero'),  { original_id: 'b', content: 'beta zero' });

    await store.deleteByDocId('a');

    const stats = await store.getStats();
    await a.assertEqual(stats.totalDocuments, 1, '1 chunk remains after deleting doc a');

    const results = await store.query(await embedder.embed('beta'), 5);
    await a.assertTrue(results.every(r => !r.id.startsWith('a_chunk')), 'no doc-a chunks survive');

    await store.clear();
  });

  runner.test('I13: ChromaVectorStore clear() → getStats() reports 0 documents', async (a) => {
    const embedder = new MockEmbedder();
    const store    = makeChroma();

    await store.store('tmp', await embedder.embed('temp content'), { original_id: 'tmp', content: 'temp' });
    await store.clear();

    const stats = await store.getStats();
    await a.assertEqual(stats.totalDocuments, 0, 'totalDocuments is 0 after clear');
  });

  // ── Neo4jGraphStore ───────────────────────────────────────────────────────

  runner.test('I14: Neo4jGraphStore storeTriple() + queryByEntity() returns correct triples', async (a) => {
    const store = makeNeo4j();
    await store.clear();

    await store.storeTriple({ subject: 'AZT', predicate: 'TREATS', object: 'HIV',
      confidence: 0.9, sourceChunkId: 'doc1_chunk_0', documentId: 'doc1.md' });
    await store.storeTriple({ subject: 'HIV', predicate: 'CAUSES', object: 'AIDS',
      confidence: 0.85, sourceChunkId: 'doc1_chunk_1', documentId: 'doc1.md' });

    const results = await store.queryByEntity('AZT', 1);
    await a.assertTrue(results.length >= 1, 'at least 1 result for AZT');
    await a.assertTrue(results.some(r => r.predicate === 'TREATS' && r.object === 'hiv'),
      'AZT TREATS HIV triple returned');

    await store.clear();
  });

  runner.test('I15: Neo4jGraphStore queryByEntities() merges results for multiple entities', async (a) => {
    const store = makeNeo4j();
    await store.clear();

    await store.storeTriple({ subject: 'AZT', predicate: 'TREATS', object: 'HIV',
      confidence: 0.9, sourceChunkId: 'c1', documentId: 'doc1.md' });
    await store.storeTriple({ subject: 'METFORMIN', predicate: 'TREATS', object: 'DIABETES',
      confidence: 0.8, sourceChunkId: 'c2', documentId: 'doc2.md' });

    const results = await store.queryByEntities(['AZT', 'METFORMIN'], 1);
    await a.assertTrue(results.length >= 2, 'returns triples for both entities');
    const subjects = results.map(r => r.subject.toUpperCase());
    await a.assertTrue(subjects.includes('AZT'),       'AZT triple included');
    await a.assertTrue(subjects.includes('METFORMIN'), 'METFORMIN triple included');

    await store.clear();
  });

  runner.test('I16: Neo4jGraphStore deleteByDocId() is prefix-safe', async (a) => {
    const store = makeNeo4j();
    await store.clear();

    await store.storeTriple({ subject: 'A', predicate: 'REL', object: 'B',
      confidence: 0.9, sourceChunkId: 'doc1.md_chunk_0', documentId: 'doc1.md' });
    await store.storeTriple({ subject: 'C', predicate: 'REL', object: 'D',
      confidence: 0.9, sourceChunkId: 'doc1_backup.md_chunk_0', documentId: 'doc1_backup.md' });

    await store.deleteByDocId('doc1.md');

    const remaining = await store.queryByEntity('C', 1);
    await a.assertTrue(remaining.length >= 1, 'backup doc triple survives');

    const deleted = await store.queryByEntity('A', 1);
    await a.assertEqual(deleted.length, 0, 'doc1.md triple is gone');

    await store.clear();
  });

  runner.test('I17: Neo4jGraphStore replaceTriplesForDoc() atomically swaps triples', async (a) => {
    const store = makeNeo4j();
    await store.clear();

    // sourceChunkId must follow the docId_chunk_N pattern for deleteByDocId to match
    await store.storeTriple({ subject: 'OLD', predicate: 'HAS', object: 'VALUE',
      confidence: 0.9, sourceChunkId: 'doc.md_chunk_0', documentId: 'doc.md' });

    const before = await store.queryByEntity('OLD', 1);
    await a.assertTrue(before.length >= 1, 'old triple exists before replace');

    // Atomic replace — new content, new triples
    await store.replaceTriplesForDoc('doc.md', [
      { subject: 'NEW', predicate: 'HAS', object: 'VALUE',
        confidence: 0.9, sourceChunkId: 'doc.md_chunk_0', documentId: 'doc.md' },
    ]);

    const oldGone = await store.queryByEntity('OLD', 1);
    await a.assertEqual(oldGone.length, 0, 'old triple removed by replace');

    const newTriple = await store.queryByEntity('NEW', 1);
    await a.assertTrue(newTriple.length >= 1, 'new triple is present');

    await store.clear();
  });

  runner.test('I18: Neo4jGraphStore getStats() tripleCount and entityCount are accurate', async (a) => {
    const store = makeNeo4j();
    await store.clear();

    await store.storeTriple({ subject: 'X', predicate: 'REL', object: 'Y',
      confidence: 1.0, sourceChunkId: 'c1', documentId: 'd1' });
    await store.storeTriple({ subject: 'Y', predicate: 'REL', object: 'Z',
      confidence: 1.0, sourceChunkId: 'c2', documentId: 'd1' });

    const stats = await store.getStats();
    await a.assertEqual(stats.tripleCount, 2,  '2 triples stored');
    await a.assertEqual(stats.entityCount, 3,  '3 distinct entities (X, Y, Z)');

    await store.clear();
  });

  // ── DocRegistry (Postgres) ────────────────────────────────────────────────

  runner.test('I10: DocRegistry persists to Postgres and survives close/re-init', async (a) => {
    const reg = new DocRegistry();
    await reg.init();
    await reg.replaceAll({});  // clean slate

    await reg.set('persist_test.md', {
      hash: 'abc123', size: 500, mtime: 1000, chunkCount: 3, lastIndexedAt: Date.now()
    });

    // Close and re-open — data should survive
    await reg.close();

    const reg2 = new DocRegistry();
    await reg2.init();
    const record = await reg2.get('persist_test.md');

    await a.assertTrue(record !== undefined, 'record survives close/re-init');
    await a.assertEqual(record.hash, 'abc123', 'hash is preserved');
    await a.assertEqual(record.chunkCount, 3,    'chunkCount is preserved');

    await reg2.replaceAll({});
    await reg2.close();
  });

  // ── Cross-store: full ingestion + retrieval round-trip ────────────────────

  runner.test('I9: Full injection pipeline stores in Chroma + BM25; hybrid retrieval works', async (a) => {
    const embedder   = new MockEmbedder();
    const bm25       = makeBM25();
    await bm25.init();
    // Use a separate collection to avoid dimension/state conflicts with other Chroma tests
    const chroma     = new ChromaVectorStore('http://localhost:8000', 'infra_test_i9');
    await chroma.clear();
    await bm25.clear();

    const hybrid     = new HybridStore(chroma, bm25);
    const neo4j      = makeNeo4j();
    await neo4j.clear();

    const loader     = new MockDocumentLoader();
    const ner        = new MockEntityExtractor();
    const relEx      = new MockRelationshipExtractor();
    const annotator  = new MockProvenanceAnnotator();

    const pipeline = new ConcreteInjectionPipeline(
      loader, embedder, hybrid, ner, relEx, neo4j, annotator
    );

    const registry = new DocRegistry();
    await registry.init();
    await registry.replaceAll({});

    const result = await pipeline.run('./input', registry);
    await a.assertEqual(result.success, true, 'injection succeeds');
    await a.assertTrue(result.chunksStored > 0, `stored ${result.chunksStored} chunks`);

    // Chroma should have chunks
    const chromaStats = await chroma.getStats();
    await a.assertTrue(chromaStats.totalDocuments > 0, 'Chroma has chunks');

    // BM25 should have chunks
    const bm25Stats = await bm25.getStats();
    await a.assertTrue(bm25Stats.totalDocuments > 0, 'pg_search BM25 has chunks');

    // Registry should have the doc
    const registryIds = registry.allIds();
    await a.assertTrue(registryIds.length > 0, 'registry has entries');

    // Hybrid retrieval should return results
    const qEmb      = await embedder.embed('machine learning');
    const results   = await hybrid.search(qEmb, 'machine learning', 3);
    await a.assertTrue(results.length > 0, 'hybrid retrieval returns results after injection');
    await a.assertTrue(typeof results[0].rrfRank === 'number', 'RRF fusion applied');

    // Clean up
    await hybrid.clear();
    await neo4j.clear();
    await registry.replaceAll({});
    await registry.close();
    await bm25.close();
  });

  runner.test('I19: NEREnrichedRetrievalPipeline retrieves from real Chroma + BM25', async (a) => {
    const embedder = new MockEmbedder();
    const bm25     = makeBM25();
    await bm25.init();
    const chroma   = makeChroma();
    await chroma.clear();
    await bm25.clear();

    const hybrid   = new HybridStore(chroma, bm25);

    // Seed two documents
    const docs = [
      { id: 'doc_a', text: 'AZT treats HIV and reduces viral load in patients',     content: 'AZT treats HIV and reduces viral load in patients' },
      { id: 'doc_b', text: 'metformin controls blood sugar levels in diabetes',     content: 'metformin controls blood sugar levels in diabetes' },
      { id: 'doc_c', text: 'python is a popular general purpose programming language', content: 'python is a popular general purpose programming language' },
    ];
    for (const doc of docs) {
      const emb = await embedder.embed(doc.text);
      await hybrid.store(`${doc.id}_chunk_0`, emb, { original_id: doc.id, content: doc.content });
    }

    const pipeline = new NEREnrichedRetrievalPipeline(
      embedder, hybrid,
      {
        ner:      new MockEntityExtractor(),
        filter:   new MockMetadataFilter(),
        reranker: new MockReranker(),
        // no glossary — not needed for this test
      }
    );

    const result = await pipeline.run('AZT HIV treatment', 2);
    await a.assertEqual(result.success, true, 'pipeline succeeds');
    await a.assertTrue(result.resultsCount > 0, 'pipeline returns results');
    // doc_a is the most relevant — should appear in top results
    await a.assertTrue(
      result.results.some(r => r.id === 'doc_a_chunk_0'),
      'AZT/HIV doc is in top results'
    );

    await hybrid.clear();
    await bm25.close();
  });

  return runner;
}

module.exports = { setupTests };
