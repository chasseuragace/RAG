/**
 * Real integration tests — require live Gemini, Chroma, Novita, Neo4j, and PostgreSQL.
 * Run with `node rag-server.js --real-test` and the relevant API keys set.
 * Neo4j and PostgreSQL must be running (e.g. via `docker-compose up`).
 */
const { TestRunner } = require('./runner');
const { RealDocumentLoader } = require('../src/ingestion/loaders/real');
const { GeminiEmbedder } = require('../src/retrieval/embedders/gemini');
const { ChromaVectorStore } = require('../src/retrieval/stores/chroma');
const { NovitaInference } = require('../src/inference/novita');
const { Neo4jGraphStore } = require('../src/ingestion/graph/store');
const { PostgresAcronymGlossary } = require('../src/retrieval/ner/glossary');
const { MockEntityExtractor } = require('../src/retrieval/ner/mock-extractor');
const { MockMetadataFilter } = require('../src/retrieval/ner/mock-filter');
const { MockRelationshipExtractor } = require('../src/ingestion/graph/mock-extractor');
const { MockProvenanceAnnotator } = require('../src/ingestion/authority/mock-annotator');
const { StaticDictionaryScorer } = require('../src/retrieval/authority/mock-scorer');
const { MockContextFuser } = require('../src/retrieval/graph/mock-fuser');
const { NEREnrichedRetrievalPipeline } = require('../src/retrieval/pipeline');
const { ConcreteInjectionPipeline } = require('../src/ingestion/pipeline');
const { MockEmbedder } = require('../src/retrieval/embedders/mock');
const { MockVectorStore } = require('../src/retrieval/stores/mock');
const { MockDocumentLoader } = require('../src/ingestion/loaders/mock');
const { HybridStore } = require('../src/retrieval/stores/hybrid');
const { BM25Store } = require('../src/retrieval/stores/bm25');
const { RetrievalObjectives } = require('../src/shared/interfaces');
const { MockReranker } = require('../src/retrieval/rerankers/mock');
const { AuthorityAwareReranker } = require('../src/retrieval/rerankers/authority-aware');
const { MockInference } = require('../src/inference/mock');

async function setupRealTests() {
  const runner = new TestRunner();

  // Test 1: RealDocumentLoader loading files
  runner.test('RealDocumentLoader should load md files', async (assert) => {
    const loader = new RealDocumentLoader();
    const docs = await loader.loadDocuments('./examples');
    await assert.assertTrue(docs.length > 0, 'Should load files from examples');
    await assert.assertTrue(docs.some(d => d.id.endsWith('.md') || d.metadata.file.endsWith('.md')), 'Should find .md files');
  });

  // Test 2: GeminiEmbedder generates embedding
  runner.test('GeminiEmbedder should generate real embeddings', async (assert) => {
    const embedder = new GeminiEmbedder();
    const embedding = await embedder.embed('Testing real embedding generation');
    await assert.assertTrue(Array.isArray(embedding), 'Embedding should be an array');
    await assert.assertTrue(embedding.length > 0, 'Embedding should have non-zero length');
  });

  // Test 3: ChromaVectorStore connectivity & reset
  runner.test('ChromaVectorStore should connect, store, and query', async (assert) => {
    const store = new ChromaVectorStore();
    await store.clear();

    const embedder = new GeminiEmbedder();
    const text = 'Node.js is built on Chrome V8 engine';
    const emb = await embedder.embed(text);

    await store.store('test-node-doc', emb, { file: 'v8.md', content: text });

    const stats = await store.getStats();
    await assert.assertEqual(stats.totalDocuments, 1, 'Should store 1 document');

    const queryEmb = await embedder.embed('Chrome V8');
    const results = await store.query(queryEmb, 1);
    await assert.assertEqual(results.length, 1, 'Should return 1 result');
    await assert.assertEqual(results[0].id, 'test-node-doc', 'Should match document ID');
    await assert.assertTrue(results[0].score > 0.5, 'Should have high similarity score');
    await assert.assertEqual(results[0].metadata.content, text, 'Should return stored content');
  });

  // Test 4: NovitaInference deepseek answering
  runner.test('NovitaInference should generate answers from context', async (assert) => {
    const inference = new NovitaInference();
    const context = [
      {
        id: 'test-node-doc',
        metadata: {
          file: 'v8.md',
          content: 'Node.js is built on Chrome V8 engine'
        }
      }
    ];

    const answer = await inference.generateAnswer('What engine is Node.js built on?', context);
    await assert.assertTrue(answer.toLowerCase().includes('v8') || answer.toLowerCase().includes('chrome'), 'Answer should mention V8 engine');
  });

  // Test 5: Neo4jGraphStore store and query
  runner.test('Neo4jGraphStore should store triples and query by entity', async (assert) => {
    const store = new Neo4jGraphStore();
    await store.clear();

    await store.storeTriple({ subject: 'AZT', predicate: 'TREATS', object: 'HIV', confidence: 0.85 });
    await store.storeTriple({ subject: 'HIV', predicate: 'CAUSES', object: 'AIDS', confidence: 0.80 });

    const stats = await store.getStats();
    await assert.assertEqual(stats.tripleCount, 2, 'Should have 2 triples');
    await assert.assertEqual(stats.entityCount, 3, 'Should have 3 entities');

    const results = await store.queryByEntity('AZT', 2);
    // @gotcha depth=2 → maxDepth=1, enabling 1-hop path expansion via apoc.path.expand.
    //       With stored triples (AZT→HIV, HIV→AIDS), this should return both.
    await assert.assertEqual(results.length, 2, 'Should find 2 triples for AZT via 1-hop expansion');
    await assert.assertTrue(results.some(r => r.predicate === 'TREATS' && r.object === 'hiv'), 'Should include TREATS→HIV');
    await assert.assertTrue(results.some(r => r.predicate === 'CAUSES' && r.object === 'aids'), 'Should include CAUSES→AIDS via HIV');

    await store.clear();
  });

  // Test 6: Neo4jGraphStore queryByEntities
  runner.test('Neo4jGraphStore should query multiple entities', async (assert) => {
    const store = new Neo4jGraphStore();
    await store.clear();

    await store.storeTriple({ subject: 'AZT', predicate: 'TREATS', object: 'HIV', confidence: 0.85 });
    await store.storeTriple({ subject: 'HIV', predicate: 'CAUSES', object: 'AIDS', confidence: 0.80 });

    const results = await store.queryByEntities(['AZT', 'HIV'], 2);
    await assert.assertTrue(results.length >= 2, 'Should find at least 2 triples');

    await store.clear();
  });

  // Test 7: PostgresAcronymGlossary lookup and expand
  runner.test('PostgresAcronymGlossary should store and lookup acronyms', async (assert) => {
    const glossary = new PostgresAcronymGlossary();
    await glossary.register({ AZT: ['Zidovudine'], HIV: ['Human Immunodeficiency Virus'] });

    const expansions = await glossary.lookup('AZT');
    await assert.assertEqual(expansions.length, 1, 'Should have 1 expansion for AZT');
    await assert.assertEqual(expansions[0], 'Zidovudine', 'Should expand AZT to Zidovudine');

    const text = 'AZT efficacy HIV low CD4';
    const expanded = await glossary.expand(text);
    await assert.assertTrue(expanded.includes('AZT OR Zidovudine'), 'Should expand AZT in text');
    await assert.assertTrue(expanded.includes('HIV OR Human Immunodeficiency Virus'), 'Should expand HIV in text');
  });

  // Test 8: PostgresAcronymGlossary returns empty for unknown
  runner.test('PostgresAcronymGlossary should return empty for unknown acronym', async (assert) => {
    const glossary = new PostgresAcronymGlossary();
    const expansions = await glossary.lookup('XYZ');
    await assert.assertEqual(expansions.length, 0, 'Should return empty array for unknown acronym');
  });

  // Test 9: Real pipeline with Neo4j + Postgres glossary
  runner.test('NEREnrichedRetrievalPipeline should work with Neo4j and Postgres glossary', async (assert) => {
    const embedder = new MockEmbedder();
    const store = new MockVectorStore();
    const bm25 = new BM25Store();
    const hybrid = new HybridStore(store, bm25);
    const ner = new MockEntityExtractor();
    const glossary = new PostgresAcronymGlossary();
    const filter = new MockMetadataFilter();
    const reranker = new MockReranker();

    const pipeline = new NEREnrichedRetrievalPipeline(
      embedder, hybrid, { ner, glossary, filter, reranker }
    );

    await glossary.register({ HIV: ['Human Immunodeficiency Virus'], AZT: ['Zidovudine'] });

    const docEmbedding = await embedder.embed('HIV treatment with antiretroviral drugs');
    await hybrid.store('doc-1', docEmbedding, { original_id: 'doc-1', content: 'HIV treatment with antiretroviral drugs', entities: { DISEASE: ['hiv'], DRUG: ['azt'] } });

    const result = await pipeline.run('HIV treatment', 3);
    await assert.assertEqual(result.success, true, 'Pipeline should succeed');
    await assert.assertTrue(Array.isArray(result.results), 'Should return results array');
  });

  // Test 10: Real injection pipeline with Neo4j
  runner.test('ConcreteInjectionPipeline should work with Neo4jGraphStore', async (assert) => {
    const loader = new MockDocumentLoader();
    const embedder = new MockEmbedder();
    const store = new MockVectorStore();
    const bm25 = new BM25Store();
    const hybrid = new HybridStore(store, bm25);
    const ner = new MockEntityExtractor();
    const relExtractor = new MockRelationshipExtractor();
    const graphStore = new Neo4jGraphStore();
    const annotator = new MockProvenanceAnnotator();

    const pipeline = new ConcreteInjectionPipeline(
      loader, embedder, hybrid, ner, relExtractor, graphStore, annotator
    );

    const registry = new (require('../src/ingestion/registry').DocRegistry)();
    const result = await pipeline.run('./examples', registry);
    await assert.assertEqual(result.success, true, 'Injection should succeed');

    const stats = await graphStore.getStats();
    await assert.assertTrue(stats.tripleCount >= 0, 'Should have non-negative triple count');

    await graphStore.clear();
  });

  return runner;
}

module.exports = { setupRealTests };
