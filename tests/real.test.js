/**
 * Real integration tests — require live Gemini, Chroma, and Novita.
 * Run with `node rag-server.js --real-test` and the relevant API keys set.
 */
const { TestRunner } = require('./runner');
const { RealDocumentLoader } = require('../src/loaders/real');
const { GeminiEmbedder } = require('../src/embedders/gemini');
const { ChromaVectorStore } = require('../src/stores/chroma');
const { NovitaInference } = require('../src/inference/novita');

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
    await store.clear(); // Clear database

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

  return runner;
}

module.exports = { setupRealTests };
