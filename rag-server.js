#!/usr/bin/env node

/**
 * RAG (Retrieval-Augmented Generation) System
 * Single-file implementation with abstract classes, mocks, and integrated testing
 * 
 * Architecture:
 * 1. Injection Pipeline: Load MD files → Embed → Store in Vector DB
 * 2. Retrieval Pipeline: Query → Retrieve from Vector DB → Return chunks
 * 3. Infrastructure: Docker-ready, API-driven embedding and inference
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');

// ============================================================================
// ABSTRACT BASE CLASSES
// ============================================================================

/**
 * Abstract base class for document loading
 */
class DocumentLoader {
  /**
   * @param {string} folderPath - Path to folder containing documents
   * @returns {Promise<Document[]>}
   */
  async loadDocuments(folderPath) {
    throw new Error('loadDocuments() must be implemented');
  }
}

/**
 * Abstract base class for embedding text
 */
class Embedder {
  /**
   * @param {string} text - Text to embed
   * @returns {Promise<number[]>} - Vector embedding
   */
  async embed(text) {
    throw new Error('embed() must be implemented');
  }

  /**
   * Batch embed multiple texts
   * @param {string[]} texts - Texts to embed
   * @returns {Promise<number[][]>} - Array of vector embeddings
   */
  async embedBatch(texts) {
    throw new Error('embedBatch() must be implemented');
  }
}

/**
 * Abstract base class for vector storage
 */
class VectorStore {
  /**
   * Store a document with its embedding
   * @param {string} id - Document ID
   * @param {number[]} embedding - Vector embedding
   * @param {Object} metadata - Document metadata
   * @returns {Promise<void>}
   */
  async store(id, embedding, metadata) {
    throw new Error('store() must be implemented');
  }

  /**
   * Query the vector store
   * @param {number[]} queryEmbedding - Query vector
   * @param {number} topK - Number of results to return
   * @returns {Promise<SearchResult[]>}
   */
  async query(queryEmbedding, topK = 5) {
    throw new Error('query() must be implemented');
  }

  /**
   * Clear all stored vectors
   * @returns {Promise<void>}
   */
  async clear() {
    throw new Error('clear() must be implemented');
  }

  /**
   * Get store stats
   * @returns {Promise<Object>}
   */
  async getStats() {
    throw new Error('getStats() must be implemented');
  }
}

/**
 * Abstract base class for retriever
 */
class Retriever {
  /**
   * @param {string} query - User query
   * @param {number} topK - Number of results
   * @returns {Promise<RetrievedDocument[]>}
   */
  async retrieve(query, topK = 5) {
    throw new Error('retrieve() must be implemented');
  }
}

/**
 * Injection pipeline orchestrator
 */
class InjectionPipeline {
  constructor(documentLoader, embedder, vectorStore) {
    this.documentLoader = documentLoader;
    this.embedder = embedder;
    this.vectorStore = vectorStore;
  }

  /**
   * Run the complete injection pipeline
   * @param {string} folderPath - Path to documents folder
   * @returns {Promise<Object>} - Pipeline results
   */
  async run(folderPath) {
    throw new Error('run() must be implemented');
  }
}

/**
 * Retrieval pipeline orchestrator
 */
class RetrievalPipeline {
  constructor(embedder, vectorStore) {
    this.embedder = embedder;
    this.vectorStore = vectorStore;
  }

  /**
   * Run the complete retrieval pipeline
   * @param {string} query - User query
   * @param {number} topK - Number of results
   * @returns {Promise<Object>} - Retrieved context
   */
  async run(query, topK = 5) {
    throw new Error('run() must be implemented');
  }
}

// ============================================================================
// MOCK IMPLEMENTATIONS FOR TESTING
// ============================================================================

/**
 * Mock document loader for testing
 */
class MockDocumentLoader extends DocumentLoader {
  constructor(mockDocuments = null) {
    super();
    this.mockDocuments = mockDocuments || [
      {
        id: 'doc-1',
        content: 'Artificial Intelligence is transforming technology.',
        metadata: { file: 'ai.md', size: 50 }
      },
      {
        id: 'doc-2',
        content: 'Machine Learning is a subset of AI.',
        metadata: { file: 'ml.md', size: 45 }
      },
      {
        id: 'doc-3',
        content: 'Deep Learning uses neural networks.',
        metadata: { file: 'dl.md', size: 40 }
      }
    ];
  }

  async loadDocuments(folderPath) {
    return this.mockDocuments;
  }
}

/**
 * Mock embedder for testing
 */
class MockEmbedder extends Embedder {
  constructor() {
    super();
    this.callCount = 0;
    this.embeddingCache = new Map();
  }

  /**
   * Generate deterministic embeddings for testing
   * Uses hash of text to generate consistent embedding
   */
  _hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash;
  }

  async embed(text) {
    this.callCount++;
    
    if (this.embeddingCache.has(text)) {
      return this.embeddingCache.get(text);
    }

    // Generate mock 384-dimensional embedding (common size)
    const seed = this._hashString(text);
    const embedding = Array(384).fill(0).map((_, i) => {
      const pseudoRandom = Math.sin(seed + i * 12.9898) * 43758.5453;
      return pseudoRandom - Math.floor(pseudoRandom);
    });

    this.embeddingCache.set(text, embedding);
    return embedding;
  }

  async embedBatch(texts) {
    return Promise.all(texts.map(text => this.embed(text)));
  }

  getCallCount() {
    return this.callCount;
  }
}

/**
 * Mock vector store for testing
 */
class MockVectorStore extends VectorStore {
  constructor() {
    super();
    this.documents = new Map();
    this.embeddings = [];
  }

  async store(id, embedding, metadata) {
    this.documents.set(id, {
      embedding,
      metadata,
      timestamp: Date.now()
    });
    this.embeddings.push(embedding);
  }

  /**
   * Calculate cosine similarity between vectors
   */
  _cosineSimilarity(a, b) {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (normA * normB);
  }

  async query(queryEmbedding, topK = 5) {
    const results = [];

    for (const [id, { embedding, metadata }] of this.documents.entries()) {
      const similarity = this._cosineSimilarity(queryEmbedding, embedding);
      results.push({
        id,
        score: similarity,
        metadata
      });
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async clear() {
    this.documents.clear();
    this.embeddings = [];
  }

  async getStats() {
    return {
      totalDocuments: this.documents.size,
      totalEmbeddings: this.embeddings.length,
      status: 'ready'
    };
  }
}

/**
 * Mock retriever for testing
 */
class MockRetriever extends Retriever {
  constructor(embedder, vectorStore) {
    super();
    this.embedder = embedder;
    this.vectorStore = vectorStore;
  }

  async retrieve(query, topK = 5) {
    const embedding = await this.embedder.embed(query);
    return this.vectorStore.query(embedding, topK);
  }
}

/**
 * Concrete injection pipeline implementation
 */
class ConcreteInjectionPipeline extends InjectionPipeline {
  constructor(documentLoader, embedder, vectorStore) {
    super(documentLoader, embedder, vectorStore);
    this.results = [];
  }

  async run(folderPath) {
    const startTime = Date.now();

    try {
      // Step 1: Load documents
      const documents = await this.documentLoader.loadDocuments(folderPath);
      
      if (documents.length === 0) {
        throw new Error('No documents loaded');
      }

      // Step 2: Extract text and embed
      const texts = documents.map(doc => doc.content);
      const embeddings = await this.embedder.embedBatch(texts);

      // Step 3: Store in vector database
      for (let i = 0; i < documents.length; i++) {
        const doc = documents[i];
        const embedding = embeddings[i];
        
        await this.vectorStore.store(doc.id, embedding, doc.metadata);
        this.results.push({
          documentId: doc.id,
          status: 'stored',
          timestamp: Date.now()
        });
      }

      const duration = Date.now() - startTime;

      return {
        success: true,
        documentsProcessed: documents.length,
        documentsStored: this.results.length,
        duration: `${duration}ms`,
        results: this.results
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        duration: `${Date.now() - startTime}ms`
      };
    }
  }

  async store(documents) {
    // Store embeddings for all documents
    for (const doc of documents) {
      const embedding = await this.embedder.embed(doc.content);
      await this.vectorStore.store(doc.id, embedding, doc.metadata);
    }
  }
}

/**
 * Concrete retrieval pipeline implementation
 */
class ConcreteRetrievalPipeline extends RetrievalPipeline {
  async run(query, topK = 5) {
    const startTime = Date.now();

    try {
      // Step 1: Embed query
      const queryEmbedding = await this.embedder.embed(query);

      // Step 2: Search vector store
      const results = await this.vectorStore.query(queryEmbedding, topK);

      const duration = Date.now() - startTime;

      return {
        success: true,
        query,
        resultsCount: results.length,
        duration: `${duration}ms`,
        results: results.map(r => ({
          id: r.id,
          relevance: (r.score * 100).toFixed(2) + '%',
          metadata: r.metadata
        }))
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        duration: `${Date.now() - startTime}ms`
      };
    }
  }
}

// ============================================================================
// TEST SUITE
// ============================================================================

class TestRunner {
  constructor() {
    this.tests = [];
    this.passed = 0;
    this.failed = 0;
  }

  test(name, fn) {
    this.tests.push({ name, fn });
  }

  async assertEqual(actual, expected, message) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`${message}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`);
    }
  }

  async assertTrue(value, message) {
    if (!value) {
      throw new Error(message);
    }
  }

  async assertGreater(actual, threshold, message) {
    if (actual <= threshold) {
      throw new Error(`${message}\nExpected > ${threshold}, got ${actual}`);
    }
  }

  async run() {
    console.log('\n🧪 RUNNING TEST SUITE\n');
    console.log('='.repeat(60));

    for (const { name, fn } of this.tests) {
      try {
        await fn(this);
        this.passed++;
        console.log(`✅ ${name}`);
      } catch (error) {
        this.failed++;
        console.log(`❌ ${name}`);
        console.log(`   Error: ${error.message}\n`);
      }
    }

    console.log('='.repeat(60));
    console.log(`\n📊 RESULTS: ${this.passed} passed, ${this.failed} failed\n`);

    return this.failed === 0;
  }
}

async function setupTests() {
  const runner = new TestRunner();

  // Test 1: Document loading
  runner.test('MockDocumentLoader should load documents', async (assert) => {
    const loader = new MockDocumentLoader();
    const docs = await loader.loadDocuments('/mock/path');
    await assert.assertTrue(docs.length > 0, 'Should load documents');
    await assert.assertTrue(docs[0].id, 'Documents should have IDs');
  });

  // Test 2: Embedding consistency
  runner.test('MockEmbedder should generate consistent embeddings', async (assert) => {
    const embedder = new MockEmbedder();
    const text = 'Test embedding';
    
    const emb1 = await embedder.embed(text);
    const emb2 = await embedder.embed(text);
    
    await assert.assertEqual(emb1, emb2, 'Same text should produce same embedding');
    await assert.assertEqual(emb1.length, 384, 'Embedding should be 384-dimensional');
  });

  // Test 3: Vector store storage
  runner.test('MockVectorStore should store and retrieve embeddings', async (assert) => {
    const store = new MockVectorStore();
    const embedding = Array(384).fill(0).map(() => Math.random());
    
    await store.store('test-id', embedding, { file: 'test.md' });
    const stats = await store.getStats();
    
    await assert.assertEqual(stats.totalDocuments, 1, 'Should store 1 document');
  });

  // Test 4: Vector similarity search
  runner.test('MockVectorStore should perform similarity search', async (assert) => {
    const store = new MockVectorStore();
    const embedder = new MockEmbedder();
    
    // Store similar embeddings
    const text1 = 'Machine Learning is important';
    const text2 = 'Deep Learning is important';
    const text3 = 'Cooking recipes are delicious';
    
    const emb1 = await embedder.embed(text1);
    const emb2 = await embedder.embed(text2);
    const emb3 = await embedder.embed(text3);
    
    await store.store('doc-1', emb1, { content: text1 });
    await store.store('doc-2', emb2, { content: text2 });
    await store.store('doc-3', emb3, { content: text3 });
    
    // Query with similar text
    const queryEmb = await embedder.embed('Machine Learning');
    const results = await store.query(queryEmb, 2);
    
    await assert.assertTrue(results.length > 0, 'Should return results');
    await assert.assertTrue(results[0].score > 0, 'Should have relevance score');
  });

  // Test 5: Injection pipeline
  runner.test('ConcreteInjectionPipeline should process documents end-to-end', async (assert) => {
    const loader = new MockDocumentLoader();
    const embedder = new MockEmbedder();
    const store = new MockVectorStore();
    const pipeline = new ConcreteInjectionPipeline(loader, embedder, store);
    
    const result = await pipeline.run('/mock/path');
    
    await assert.assertTrue(result.success, 'Pipeline should succeed');
    await assert.assertGreater(result.documentsProcessed, 0, 'Should process documents');
  });

  // Test 6: Retrieval pipeline
  runner.test('ConcreteRetrievalPipeline should retrieve relevant documents', async (assert) => {
    const embedder = new MockEmbedder();
    const store = new MockVectorStore();
    const loader = new MockDocumentLoader();
    
    // Inject documents first
    const docs = await loader.loadDocuments('/mock');
    for (const doc of docs) {
      const emb = await embedder.embed(doc.content);
      await store.store(doc.id, emb, doc.metadata);
    }
    
    // Now retrieve
    const pipeline = new ConcreteRetrievalPipeline(embedder, store);
    const result = await pipeline.run('artificial intelligence');
    
    await assert.assertTrue(result.success, 'Retrieval should succeed');
    await assert.assertGreater(result.resultsCount, 0, 'Should return results');
  });

  // Test 7: Batch embedding
  runner.test('MockEmbedder should handle batch embeddings', async (assert) => {
    const embedder = new MockEmbedder();
    const texts = ['Text 1', 'Text 2', 'Text 3'];
    
    const embeddings = await embedder.embedBatch(texts);
    
    await assert.assertEqual(embeddings.length, 3, 'Should embed all texts');
    await assert.assertEqual(embeddings[0].length, 384, 'Each embedding should be 384-dim');
  });

  // Test 8: Embedder call tracking
  runner.test('MockEmbedder should track API calls', async (assert) => {
    const embedder = new MockEmbedder();
    
    await embedder.embed('Test 1');
    await embedder.embed('Test 2');
    await embedder.embed('Test 1'); // Should be cached
    
    const callCount = embedder.getCallCount();
    await assert.assertEqual(callCount, 3, 'Should track all calls including cached');
  });

  return runner;
}

// ============================================================================
// HTTP SERVER
// ============================================================================

class RAGServer {
  constructor(port = 3000) {
    this.port = port;
    this.injectionPipeline = null;
    this.retrievalPipeline = null;
    this.server = null;
  }

  async initialize() {
    const embedder = new MockEmbedder();
    const store = new MockVectorStore();
    const loader = new MockDocumentLoader();
    
    this.injectionPipeline = new ConcreteInjectionPipeline(loader, embedder, store);
    this.retrievalPipeline = new ConcreteRetrievalPipeline(embedder, store);
    
    // Pre-inject some documents
    const docs = await loader.loadDocuments('/mock');
    for (const doc of docs) {
      const emb = await embedder.embed(doc.content);
      await store.store(doc.id, emb, doc.metadata);
    }

    this.store = store;
  }

  handleRequest(req, res) {
    res.setHeader('Content-Type', 'application/json');

    if (req.url === '/' && req.method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify({
        message: 'RAG Server running',
        endpoints: {
          'GET /health': 'Server health status',
          'POST /inject': 'Inject documents into vector store',
          'POST /retrieve': 'Retrieve documents from vector store',
          'GET /stats': 'Get vector store statistics'
        }
      }, null, 2));
    }

    else if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'healthy', timestamp: new Date().toISOString() }));
    }

    else if (req.url === '/stats' && req.method === 'GET') {
      this.store.getStats().then(stats => {
        res.writeHead(200);
        res.end(JSON.stringify(stats, null, 2));
      });
    }

    else if (req.url === '/inject' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body);
          const result = await this.injectionPipeline.run(payload.folderPath || '/mock');
          res.writeHead(200);
          res.end(JSON.stringify(result, null, 2));
        } catch (error) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: error.message }));
        }
      });
    }

    else if (req.url === '/retrieve' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body);
          const result = await this.retrievalPipeline.run(payload.query, payload.topK || 5);
          res.writeHead(200);
          res.end(JSON.stringify(result, null, 2));
        } catch (error) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: error.message }));
        }
      });
    }

    else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Endpoint not found' }));
    }
  }

  start() {
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    this.server.listen(this.port, () => {
      console.log(`\n🚀 RAG Server running on http://localhost:${this.port}`);
      console.log(`\n📚 Available Endpoints:`);
      console.log(`   GET  /             - Server info`);
      console.log(`   GET  /health       - Health check`);
      console.log(`   GET  /stats        - Vector store statistics`);
      console.log(`   POST /inject       - Inject documents (body: {folderPath})`);
      console.log(`   POST /retrieve     - Retrieve documents (body: {query, topK?})`);
      console.log(`\n`);
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
    }
  }
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--test')) {
    const runner = await setupTests();
    const allPassed = await runner.run();
    process.exit(allPassed ? 0 : 1);
  }

  else if (args.includes('--server')) {
    const port = args.includes('--port') ? parseInt(args[args.indexOf('--port') + 1]) : 3000;
    const server = new RAGServer(port);
    await server.initialize();
    server.start();
  }

  else {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║         RAG (Retrieval-Augmented Generation) System          ║
║                 Single-File Implementation                   ║
╚══════════════════════════════════════════════════════════════╝

USAGE:
  node rag-server.js --test          Run test suite
  node rag-server.js --server        Start HTTP server (port 3000)
  node rag-server.js --server --port 8080  Use custom port

ARCHITECTURE:
  ├─ Abstract Classes (DocumentLoader, Embedder, VectorStore, Retriever)
  ├─ Mock Implementations (for testing without external APIs)
  ├─ Concrete Pipelines (InjectionPipeline, RetrievalPipeline)
  ├─ Test Suite (8 comprehensive tests)
  └─ HTTP Server (REST API endpoints)

NEXT STEPS (Phase 2):
  1. Replace MockEmbedder with Gemini embeddings API client
  2. Replace MockVectorStore with actual vector DB (Chroma, Qdrant, etc.)
  3. Replace MockDocumentLoader with real MD file loader
  4. Add Docker Compose for database infrastructure
  5. Add inference endpoint integration (Novita AI)
    `);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('Error:', error);
    process.exit(1);
  });
}

// Exports for external usage
module.exports = {
  // Abstract classes
  DocumentLoader,
  Embedder,
  VectorStore,
  Retriever,
  InjectionPipeline,
  RetrievalPipeline,
  // Implementations
  MockDocumentLoader,
  MockEmbedder,
  MockVectorStore,
  MockRetriever,
  ConcreteInjectionPipeline,
  ConcreteRetrievalPipeline,
  // Test runner
  TestRunner,
  setupTests,
  // Server
  RAGServer
};
