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
        
        await this.vectorStore.store(doc.id, embedding, {
          ...doc.metadata,
          content: doc.content
        });
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
      await this.vectorStore.store(doc.id, embedding, {
        ...doc.metadata,
        content: doc.content
      });
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
// CONCRETE REAL IMPLEMENTATIONS FOR PHASE 2
// ============================================================================

/**
 * Real document loader to load files from local directory
 */
class RealDocumentLoader extends DocumentLoader {
  async loadDocuments(folderPath) {
    const resolvedPath = path.resolve(folderPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Directory does not exist: ${folderPath}`);
    }
    const stats = fs.statSync(resolvedPath);
    if (!stats.isDirectory()) {
      throw new Error(`Path is not a directory: ${folderPath}`);
    }

    const documents = [];
    const readDir = (dir) => {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const fullPath = path.join(dir, file);
        const fileStat = fs.statSync(fullPath);
        if (fileStat.isDirectory()) {
          readDir(fullPath);
        } else if (file.endsWith('.md')) {
          const content = fs.readFileSync(fullPath, 'utf8');
          const relativePath = path.relative(resolvedPath, fullPath);
          documents.push({
            id: relativePath,
            content: content,
            metadata: {
              file: file,
              path: relativePath,
              size: fileStat.size,
              mtime: fileStat.mtimeMs
            }
          });
        }
      }
    };

    readDir(resolvedPath);
    return documents;
  }
}

/**
 * Real Gemini embedder using Google Generative Language API
 */
class GeminiEmbedder extends Embedder {
  constructor(apiKey = null) {
    super();
    this.apiKey = apiKey || process.env.GEMINI_API_KEY || process.env.AI_STUDIO_API_KEY;
    if (!this.apiKey) {
      throw new Error('Gemini API key is required. Set GEMINI_API_KEY or AI_STUDIO_API_KEY env variable.');
    }
    this.callCount = 0;
  }

  async embed(text) {
    this.callCount++;
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1/models/gemini-embedding-2:embedContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: { parts: [{ text }] }
        })
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini Embedding API error: ${response.status} - ${errText}`);
    }

    const data = await response.json();
    if (!data.embedding || !data.embedding.values) {
      throw new Error(`Invalid Gemini API response: ${JSON.stringify(data)}`);
    }
    return data.embedding.values;
  }

  async embedBatch(texts) {
    this.callCount += texts.length;
    const chunkSize = 100;
    const results = [];

    for (let i = 0; i < texts.length; i += chunkSize) {
      const chunk = texts.slice(i, i + chunkSize);
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1/models/gemini-embedding-2:batchEmbedContents?key=${this.apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requests: chunk.map(text => ({
              model: 'models/gemini-embedding-2',
              content: { parts: [{ text }] }
            }))
          })
        }
      );

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Gemini Batch Embedding API error: ${response.status} - ${errText}`);
      }

      const data = await response.json();
      if (!data.embeddings || !Array.isArray(data.embeddings)) {
        throw new Error(`Invalid Gemini Batch API response: ${JSON.stringify(data)}`);
      }
      results.push(...data.embeddings.map(e => e.values));
    }

    return results;
  }

  getCallCount() {
    return this.callCount;
  }
}

/**
 * Chroma Vector Store integration
 */
class ChromaVectorStore extends VectorStore {
  constructor(baseUrl = 'http://localhost:8000', collectionName = 'rag_documents', tenant = 'default_tenant', database = 'default_database') {
    super();
    this.baseUrl = baseUrl;
    this.collectionName = collectionName;
    this.tenant = tenant;
    this.database = database;
    this.collectionId = null;
  }

  async _ensureCollection() {
    if (this.collectionId) return this.collectionId;

    try {
      const hb = await fetch(`${this.baseUrl}/api/v2/heartbeat`);
      if (!hb.ok) throw new Error(`Heartbeat failed: ${hb.status}`);
    } catch (err) {
      throw new Error(`Cannot connect to Chroma DB at ${this.baseUrl}. Is the Docker container running? Details: ${err.message}`);
    }

    const response = await fetch(`${this.baseUrl}/api/v2/tenants/${this.tenant}/databases/${this.database}/collections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: this.collectionName,
        metadata: { "hnsw:space": "cosine" },
        get_or_create: true
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Chroma create collection error: ${response.status} - ${errText}`);
    }

    const data = await response.json();
    this.collectionId = data.id;
    return this.collectionId;
  }

  async store(id, embedding, metadata) {
    const colId = await this._ensureCollection();
    const content = metadata.content || '';
    
    // Copy metadata and exclude content
    const chromaMetadata = { ...metadata };
    delete chromaMetadata.content;

    const url = `${this.baseUrl}/api/v2/tenants/${this.tenant}/databases/${this.database}/collections/${colId}/add`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: [id],
        embeddings: [embedding],
        metadatas: [chromaMetadata],
        documents: [content]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Chroma add document error: ${response.status} - ${errText}`);
    }
  }

  async query(queryEmbedding, topK = 5) {
    const colId = await this._ensureCollection();

    const url = `${this.baseUrl}/api/v2/tenants/${this.tenant}/databases/${this.database}/collections/${colId}/query`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query_embeddings: [queryEmbedding],
        n_results: topK,
        include: ['metadatas', 'documents', 'distances']
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Chroma query error: ${response.status} - ${errText}`);
    }

    const data = await response.json();
    const results = [];

    if (data.ids && data.ids[0]) {
      for (let i = 0; i < data.ids[0].length; i++) {
        const id = data.ids[0][i];
        const distance = data.distances[0][i];
        const metadata = data.metadatas[0][i] || {};
        const document = data.documents[0][i] || '';

        // Cosine similarity is 1 - cosine distance
        const score = 1 - distance;

        results.push({
          id,
          score,
          metadata: {
            ...metadata,
            content: document
          }
        });
      }
    }

    return results;
  }

  async clear() {
    try {
      await fetch(`${this.baseUrl}/api/v2/heartbeat`);
    } catch (err) {
      return; // DB not available, nothing to clear
    }

    // Delete collection via v2 endpoint
    const url = `${this.baseUrl}/api/v2/tenants/${this.tenant}/databases/${this.database}/collections/${this.collectionName}`;
    await fetch(url, { method: 'DELETE' });
    this.collectionId = null;
  }

  async getStats() {
    try {
      const colId = await this._ensureCollection();
      const url = `${this.baseUrl}/api/v2/tenants/${this.tenant}/databases/${this.database}/collections/${colId}/count`;
      const response = await fetch(url, { method: 'GET' });
      if (!response.ok) {
        return { totalDocuments: 0, status: 'error', error: response.statusText };
      }
      const count = await response.json();
      return {
        totalDocuments: count,
        status: 'ready'
      };
    } catch (error) {
      return { totalDocuments: 0, status: 'error', error: error.message };
    }
  }
}

/**
 * Novita AI DeepSeek LLM Inference Integration
 */
class NovitaInference {
  constructor(apiKey = null, model = 'deepseek/deepseek-v4-pro') {
    this.apiKey = apiKey || process.env.NOVITA_API_KEY;
    this.model = model;
    if (!this.apiKey) {
      throw new Error('Novita API key is required. Set NOVITA_API_KEY env variable.');
    }
  }

  async generateAnswer(query, contextDocuments) {
    const contextText = contextDocuments
      .map((doc, idx) => `[Document ${idx + 1}] (Source: ${doc.metadata.file || doc.id})\n${doc.metadata.content || doc.content || ''}`)
      .join('\n\n');

    const systemPrompt = `You are a helpful AI assistant. You are given a user query and relevant context documents.
Use ONLY the provided context to answer the user's question. If the context does not contain enough information to answer, state that you don't know based on the context.

Context:
${contextText}`;

    const response = await fetch('https://api.novita.ai/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: query }
        ],
        temperature: 0.1,
        max_tokens: 1000
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Novita Inference API error: ${response.status} - ${errText}`);
    }

    const data = await response.json();
    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      throw new Error(`Invalid Novita API response: ${JSON.stringify(data)}`);
    }

    return data.choices[0].message.content;
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

// ============================================================================
// HTTP SERVER
// ============================================================================

class RAGServer {
  constructor(port = 3000, isReal = false) {
    this.port = port;
    this.isReal = isReal;
    this.injectionPipeline = null;
    this.retrievalPipeline = null;
    this.inference = null;
    this.server = null;
    this.store = null;
  }

  async initialize() {
    if (this.isReal) {
      const embedder = new GeminiEmbedder();
      const store = new ChromaVectorStore();
      const loader = new RealDocumentLoader();
      this.inference = new NovitaInference();
      
      this.injectionPipeline = new ConcreteInjectionPipeline(loader, embedder, store);
      this.retrievalPipeline = new ConcreteRetrievalPipeline(embedder, store);
      this.store = store;
    } else {
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
  }

  handleRequest(req, res) {
    res.setHeader('Content-Type', 'application/json');

    if (req.url === '/' && req.method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify({
        message: `RAG Server running (${this.isReal ? 'Real Service Mode' : 'Mock Mode'})`,
        endpoints: {
          'GET /health': 'Server health status',
          'POST /inject': 'Inject documents into vector store (body: {folderPath})',
          'POST /retrieve': 'Retrieve documents from vector store (body: {query, topK?})',
          'POST /ask': 'Ask a question using the full RAG pipeline (body: {query, topK?})',
          'GET /stats': 'Get vector store statistics'
        }
      }, null, 2));
    }

    else if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'healthy', mode: this.isReal ? 'real' : 'mock', timestamp: new Date().toISOString() }));
    }

    else if (req.url === '/stats' && req.method === 'GET') {
      this.store.getStats().then(stats => {
        res.writeHead(200);
        res.end(JSON.stringify(stats, null, 2));
      }).catch(err => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      });
    }

    else if (req.url === '/inject' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body);
          const defaultPath = this.isReal ? './examples' : '/mock';
          const result = await this.injectionPipeline.run(payload.folderPath || defaultPath);
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

    else if (req.url === '/ask' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body);
          if (!payload.query) {
            throw new Error('Query is required');
          }
          const topK = payload.topK || 3;
          
          // 1. Retrieve context
          const retrievalResult = await this.retrievalPipeline.run(payload.query, topK);
          if (!retrievalResult.success) {
            throw new Error(retrievalResult.error || 'Retrieval failed');
          }

          const contextDocs = retrievalResult.results.map(r => ({
            id: r.id,
            content: r.metadata.content || '',
            metadata: r.metadata
          }));

          // 2. Inference
          let answer = '';
          if (this.inference) {
            answer = await this.inference.generateAnswer(payload.query, contextDocs);
          } else {
            answer = `Mock RAG Answer: Based on ${contextDocs.length} documents, the answer is generated. Chunks found: ${contextDocs.map(d => d.id).join(', ')}`;
          }

          res.writeHead(200);
          res.end(JSON.stringify({
            success: true,
            query: payload.query,
            answer: answer,
            sources: retrievalResult.results
          }, null, 2));
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
      console.log(`\n🚀 RAG Server running in ${this.isReal ? 'REAL' : 'MOCK'} mode on http://localhost:${this.port}`);
      console.log(`\n📚 Available Endpoints:`);
      console.log(`   GET  /             - Server info`);
      console.log(`   GET  /health       - Health check`);
      console.log(`   GET  /stats        - Vector store statistics`);
      console.log(`   POST /inject       - Inject documents (body: {folderPath})`);
      console.log(`   POST /retrieve     - Retrieve documents (body: {query, topK?})`);
      console.log(`   POST /ask          - Ask a question (body: {query, topK?})`);
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

  else if (args.includes('--real-test')) {
    try {
      const runner = await setupRealTests();
      const allPassed = await runner.run();
      process.exit(allPassed ? 0 : 1);
    } catch (error) {
      console.error('Real test initialization failed:', error.message);
      process.exit(1);
    }
  }

  else if (args.includes('--server')) {
    const port = args.includes('--port') ? parseInt(args[args.indexOf('--port') + 1]) : 3000;
    const isReal = args.includes('--real');
    const server = new RAGServer(port, isReal);
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
  node rag-server.js --test          Run mock test suite
  node rag-server.js --real-test     Run live integration test suite
  node rag-server.js --server        Start HTTP server in mock mode (port 3000)
  node rag-server.js --server --real Start HTTP server in real mode (Chroma, Gemini, Novita)
  node rag-server.js --server --port 8080  Use custom port

ARCHITECTURE:
  ├─ Abstract Classes (DocumentLoader, Embedder, VectorStore, Retriever)
  ├─ Mock & Real Implementations (Gemini, Chroma, DeepSeek via Novita)
  ├─ Concrete Pipelines (InjectionPipeline, RetrievalPipeline)
  ├─ Test Suites (Mock tests and live Integration tests)
  └─ HTTP Server (REST API endpoints including POST /ask)
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
  // Implementations (Mock)
  MockDocumentLoader,
  MockEmbedder,
  MockVectorStore,
  MockRetriever,
  // Implementations (Real)
  RealDocumentLoader,
  GeminiEmbedder,
  ChromaVectorStore,
  NovitaInference,
  ConcreteInjectionPipeline,
  ConcreteRetrievalPipeline,
  // Test runner
  TestRunner,
  setupTests,
  setupRealTests,
  // Server
  RAGServer
};
