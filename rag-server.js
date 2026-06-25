#!/usr/bin/env node

/**
 * RAG System with WebSocket Telemetry
 * - Real mode: Gemini embeddings, Chroma, Novita DeepSeek
 * - Injection: clear + chunk + embed + store (no duplicates)
 * - Conversation history (JSON file based) for /ask endpoint
 * - Hardcoded input directory: ./input (can be changed via RAG_INPUT_DIR env)
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');

// WebSocket optional
let WebSocketServer;
try {
  const WebSocket = require('ws');
  WebSocketServer = WebSocket.Server;
} catch (err) {
  console.warn('⚠️  ws package not installed. Install with: npm install ws');
  console.warn('WebSocket support disabled.\n');
}

// ============================================================================
// CONFIGURATION
// ============================================================================
const INPUT_DIR = process.env.RAG_INPUT_DIR || './input';
const CHUNK_SIZE = parseInt(process.env.RAG_CHUNK_SIZE) || 1000;      // characters
const CHUNK_OVERLAP = parseInt(process.env.RAG_CHUNK_OVERLAP) || 200;
const CONVERSATIONS_DIR = './conversations';
const REGISTRY_FILE = process.env.RAG_REGISTRY_FILE || './data/doc-registry.json';
// Ensure directories exist
if (!fs.existsSync(INPUT_DIR)) fs.mkdirSync(INPUT_DIR, { recursive: true });
if (!fs.existsSync(CONVERSATIONS_DIR)) fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
if (!fs.existsSync(path.dirname(REGISTRY_FILE))) fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true });

// ============================================================================
// EVENT SYSTEM (unchanged)
// ============================================================================
class ServerEvents extends EventEmitter {
  constructor() {
    super();
    this.metrics = { startTime: Date.now(), requestsTotal: 0, injectionTotal: 0, retrievalTotal: 0, embeddingsTotal: 0, averageEmbeddingTime: 0, averageRetrievalTime: 0, averageInjectionTime: 0, lastRequest: null, lastInjection: null, lastRetrieval: null, errors: [], connectedClients: 0 };
    this.eventLog = [];
    this.maxLogSize = 1000;
  }
  logEvent(eventType, data = {}) {
    const event = { timestamp: Date.now(), type: eventType, data };
    this.eventLog.push(event);
    if (this.eventLog.length > this.maxLogSize) this.eventLog.shift();
    switch (eventType) {
      case 'request:start': this.metrics.requestsTotal++; this.metrics.lastRequest = Date.now(); break;
      case 'injection:start': this.metrics.injectionTotal++; this.metrics.lastInjection = Date.now(); break;
      case 'retrieval:start': this.metrics.retrievalTotal++; this.metrics.lastRetrieval = Date.now(); break;
      case 'embedding:complete': this.metrics.embeddingsTotal++; break;
      case 'error': this.metrics.errors.push({ timestamp: Date.now(), ...data }); if (this.metrics.errors.length > 100) this.metrics.errors.shift(); break;
    }
    this.emit('event', event);
  }
  getMetrics() { const uptime = Date.now() - this.metrics.startTime; return { ...this.metrics, uptime, uptimeFormatted: this._formatUptime(uptime) }; }
  _formatUptime(ms) { const s = Math.floor(ms/1000), m = Math.floor(s/60), h = Math.floor(m/60), d = Math.floor(h/24); if (d) return `${d}d ${h%24}h`; if (h) return `${h}h ${m%60}m`; if (m) return `${m}m ${s%60}s`; return `${s}s`; }
  incrementConnectedClients(delta = 1) { this.metrics.connectedClients = Math.max(0, this.metrics.connectedClients + delta); this.logEvent('client:connected', { clientCount: this.metrics.connectedClients }); }
}
const serverEvents = new ServerEvents();

// ============================================================================
// CONVERSATION STORAGE (JSON file per session)
// ============================================================================
class ConversationStore {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.filePath = path.join(CONVERSATIONS_DIR, `${sessionId}.json`);
    this.messages = this._load();
  }
  _load() {
    if (fs.existsSync(this.filePath)) {
      try { return JSON.parse(fs.readFileSync(this.filePath, 'utf8')); } catch(e) { return []; }
    }
    return [];
  }
  _save() { fs.writeFileSync(this.filePath, JSON.stringify(this.messages, null, 2)); }
  addMessage(role, content) {
    this.messages.push({ role, content, timestamp: Date.now() });
    this._save();
  }
  getHistory(limit = 10) {
    return this.messages.slice(-limit);
  }
  clear() { this.messages = []; this._save(); }
  static getOrCreate(sessionId) { return new ConversationStore(sessionId); }
}

// ============================================================================
// DOC REGISTRY  (source of truth for what is in the vector store)
// ----------------------------------------------------------------------------
// JSON-file backed map: docId -> { hash, size, mtime, chunkCount, lastIndexedAt }
// Used by the incremental injection pipeline to diff incoming files against
// what has already been embedded, so only the delta is re-embedded.
// ============================================================================
function hashContent(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

class DocRegistry {
  constructor(filePath = REGISTRY_FILE) {
    this.filePath = filePath;
    this.docs = this._load();
  }
  _load() {
    if (fs.existsSync(this.filePath)) {
      try { return JSON.parse(fs.readFileSync(this.filePath, 'utf8')); } catch (e) { return {}; }
    }
    return {};
  }
  _save() { fs.writeFileSync(this.filePath, JSON.stringify(this.docs, null, 2)); }
  get(docId) { return this.docs[docId]; }
  set(docId, record) { this.docs[docId] = record; this._save(); }
  remove(docId) { delete this.docs[docId]; this._save(); }
  allIds() { return Object.keys(this.docs); }
  /**
   * Classify loaded documents against the registry by content hash.
   * Mutates each loaded doc with `_hash` so callers don't re-hash.
   * Returns { added, changed, unchanged, removed }.
   */
  diff(loadedDocs) {
    const incoming = new Set(loadedDocs.map(d => d.id));
    const added = [], changed = [], unchanged = [];
    for (const doc of loadedDocs) {
      doc._hash = hashContent(doc.content);
      const prev = this.docs[doc.id];
      if (!prev) added.push(doc);
      else if (prev.hash !== doc._hash) changed.push(doc);
      else unchanged.push(doc);
    }
    const removed = Object.keys(this.docs).filter(id => !incoming.has(id));
    return { added, changed, unchanged, removed };
  }
}

// ============================================================================
// TEXT CHUNKING UTILITY
// ============================================================================
function chunkText(text, maxSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  if (text.length <= maxSize) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxSize;
    if (end >= text.length) {
      chunks.push(text.slice(start));
      break;
    }
    // try to cut at paragraph or sentence boundary
    let cut = text.lastIndexOf('\n\n', end);
    if (cut <= start) cut = text.lastIndexOf('. ', end);
    if (cut <= start) cut = text.lastIndexOf(' ', end);
    if (cut <= start) cut = end;
    chunks.push(text.slice(start, cut));
    start = cut - overlap;
    if (start < 0) start = 0;
  }
  return chunks;
}

// ============================================================================
// ABSTRACT BASE CLASSES
// ============================================================================
class DocumentLoader { async loadDocuments(folderPath) { throw new Error('not implemented'); } }
class Embedder { async embed(text) { throw new Error('not implemented'); } async embedBatch(texts) { throw new Error('not implemented'); } }
class VectorStore { async store(id, embedding, metadata) { throw new Error('not implemented'); } async query(queryEmbedding, topK) { throw new Error('not implemented'); } async clear() { throw new Error('not implemented'); } async deleteByDocId(docId) { throw new Error('not implemented'); } async getStats() { throw new Error('not implemented'); } }
class InjectionPipeline { constructor(loader, embedder, store) { this.loader = loader; this.embedder = embedder; this.store = store; } async run(folderPath) { throw new Error('not implemented'); } }
class RetrievalPipeline { constructor(embedder, store) { this.embedder = embedder; this.store = store; } async run(query, topK) { throw new Error('not implemented'); } }

// ============================================================================
// MOCK IMPLEMENTATIONS (unchanged but updated to support chunking if needed)
// ============================================================================
class MockDocumentLoader extends DocumentLoader {
  constructor(mockDocs = null) {
    super();
    this.mockDocuments = mockDocs || [
      { id: 'ai.md', content: 'Artificial Intelligence is transforming technology.', metadata: { file: 'ai.md' } },
      { id: 'ml.md', content: 'Machine Learning is a subset of AI.', metadata: { file: 'ml.md' } },
      { id: 'dl.md', content: 'Deep Learning uses neural networks.', metadata: { file: 'dl.md' } }
    ];
  }
  async loadDocuments(folderPath) { return this.mockDocuments; }
}

class MockEmbedder extends Embedder {
  constructor() { super(); this.callCount = 0; this.cache = new Map(); }
  _hashString(str) { let hash = 0; for (let i = 0; i < str.length; i++) hash = ((hash << 5) - hash) + str.charCodeAt(i); return hash & hash; }
  async embed(text) {
    this.callCount++;
    if (this.cache.has(text)) return this.cache.get(text);
    const seed = this._hashString(text);
    const embedding = Array(384).fill(0).map((_, i) => { const r = Math.sin(seed + i * 12.9898) * 43758.5453; return r - Math.floor(r); });
    this.cache.set(text, embedding);
    serverEvents.logEvent('embedding:complete', { textLength: text.length });
    return embedding;
  }
  async embedBatch(texts) { return Promise.all(texts.map(t => this.embed(t))); }
  getCallCount() { return this.callCount; }
}

class MockVectorStore extends VectorStore {
  constructor() { super(); this.docs = new Map(); this.queryCount = 0; }
  async store(id, embedding, metadata) { this.docs.set(id, { embedding, metadata }); serverEvents.logEvent('vectorstore:stored', { id }); }
  _cosineSimilarity(a,b) { let dot=0, normA=0, normB=0; for(let i=0;i<a.length;i++) { dot+=a[i]*b[i]; normA+=a[i]*a[i]; normB+=b[i]*b[i]; } normA=Math.sqrt(normA); normB=Math.sqrt(normB); return normA&&normB?dot/(normA*normB):0; }
  async query(q, topK=5) { const start=Date.now(); this.queryCount++; const results=[]; for(const[id,{embedding,metadata}] of this.docs) results.push({id,score:this._cosineSimilarity(q,embedding),metadata}); const sorted=results.sort((a,b)=>b.score-a.score).slice(0,topK); serverEvents.logEvent('vectorstore:queried',{count:sorted.length,duration:Date.now()-start}); return sorted; }
  async clear() { this.docs.clear(); this.queryCount=0; serverEvents.logEvent('vectorstore:cleared',{}); }
  async deleteByDocId(docId) {
    let removed = 0;
    for (const [id, { metadata }] of this.docs) {
      if (metadata && metadata.original_id === docId) { this.docs.delete(id); removed++; }
    }
    serverEvents.logEvent('vectorstore:deleted', { docId, removed });
    return removed;
  }
  async getStats() { return { totalDocuments: this.docs.size, queryCount: this.queryCount }; }
}

// ============================================================================
// REAL IMPLEMENTATIONS (with chunking support in pipeline)
// ============================================================================
class RealDocumentLoader extends DocumentLoader {
  async loadDocuments(folderPath) {
    const resolved = path.resolve(folderPath);
    if (!fs.existsSync(resolved)) throw new Error(`Directory does not exist: ${folderPath}`);
    if (!fs.statSync(resolved).isDirectory()) throw new Error(`Not a directory: ${folderPath}`);
    const docs = [];
    const readDir = (dir) => {
      for (const file of fs.readdirSync(dir)) {
        const full = path.join(dir, file);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) readDir(full);
        else if (file.endsWith('.md')) {
          const content = fs.readFileSync(full, 'utf8');
          const rel = path.relative(resolved, full);
          docs.push({
            id: rel,
            content: content,
            metadata: { file, path: rel, size: stat.size, mtime: stat.mtimeMs }
          });
        }
      }
    };
    readDir(resolved);
    serverEvents.logEvent('documents:loaded', { folderPath, count: docs.length });
    return docs;
  }
}

class GeminiEmbedder extends Embedder {
  constructor(apiKey = null) {
    super();
    this.apiKey = apiKey || process.env.GEMINI_API_KEY || process.env.AI_STUDIO_API_KEY;
    if (!this.apiKey) throw new Error('Gemini API key required');
    this.callCount = 0;
  }
  async embed(text) {
    this.callCount++;
    const start = Date.now();
    const res = await fetch(`https://generativelanguage.googleapis.com/v1/models/gemini-embedding-2:embedContent?key=${this.apiKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { parts: [{ text }] } })
    });
    if (!res.ok) throw new Error(`Gemini API error: ${res.status}`);
    const data = await res.json();
    const embedding = data.embedding.values;
    serverEvents.logEvent('embedding:complete', { textLength: text.length, duration: Date.now()-start });
    return embedding;
  }
  async embedBatch(texts) {
    const start = Date.now();
    const chunkSize = 100;
    const results = [];
    for (let i = 0; i < texts.length; i += chunkSize) {
      const chunk = texts.slice(i, i+chunkSize);
      const res = await fetch(`https://generativelanguage.googleapis.com/v1/models/gemini-embedding-2:batchEmbedContents?key=${this.apiKey}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: chunk.map(t => ({ model: 'models/gemini-embedding-2', content: { parts: [{ text: t }] } })) })
      });
      if (!res.ok) throw new Error(`Gemini batch error: ${res.status}`);
      const data = await res.json();
      results.push(...data.embeddings.map(e => e.values));
    }
    serverEvents.logEvent('embedding:batch', { count: texts.length, duration: Date.now()-start });
    return results;
  }
  getCallCount() { return this.callCount; }
}

class ChromaVectorStore extends VectorStore {
  constructor(baseUrl='http://localhost:8000', collectionName='rag_documents', tenant='default_tenant', database='default_database') {
    super();
    this.baseUrl = baseUrl;
    this.collectionName = collectionName;
    this.tenant = tenant;
    this.database = database;
    this.collectionId = null;
  }
  async _ensureCollection() {
    if (this.collectionId) return this.collectionId;
    await fetch(`${this.baseUrl}/api/v2/heartbeat`).catch(() => { throw new Error('Chroma unreachable'); });
    const res = await fetch(`${this.baseUrl}/api/v2/tenants/${this.tenant}/databases/${this.database}/collections`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: this.collectionName, metadata: { "hnsw:space": "cosine" }, get_or_create: true })
    });
    if (!res.ok) throw new Error(`Chroma collection error: ${res.status}`);
    const data = await res.json();
    this.collectionId = data.id;
    return this.collectionId;
  }
  async store(id, embedding, metadata) {
    const colId = await this._ensureCollection();
    const content = metadata.content || '';
    const chromaMeta = { ...metadata };
    delete chromaMeta.content;
    const res = await fetch(`${this.baseUrl}/api/v2/tenants/${this.tenant}/databases/${this.database}/collections/${colId}/add`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id], embeddings: [embedding], metadatas: [chromaMeta], documents: [content] })
    });
    if (!res.ok) throw new Error(`Chroma add error: ${res.status}`);
    serverEvents.logEvent('vectorstore:stored', { id });
  }
  async query(queryEmbedding, topK=5) {
    const start = Date.now();
    const colId = await this._ensureCollection();
    const res = await fetch(`${this.baseUrl}/api/v2/tenants/${this.tenant}/databases/${this.database}/collections/${colId}/query`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query_embeddings: [queryEmbedding], n_results: topK, include: ['metadatas', 'documents', 'distances'] })
    });
    if (!res.ok) throw new Error(`Chroma query error: ${res.status}`);
    const data = await res.json();
    const results = [];
    if (data.ids && data.ids[0]) {
      for (let i = 0; i < data.ids[0].length; i++) {
        results.push({
          id: data.ids[0][i],
          score: 1 - data.distances[0][i],
          metadata: { ...(data.metadatas[0][i] || {}), content: data.documents[0][i] || '' }
        });
      }
    }
    serverEvents.logEvent('vectorstore:queried', { count: results.length, duration: Date.now()-start });
    return results;
  }
  async clear() {
    try {
      await fetch(`${this.baseUrl}/api/v2/tenants/${this.tenant}/databases/${this.database}/collections/${this.collectionName}`, { method: 'DELETE' });
    } catch(e) {}
    this.collectionId = null;
    serverEvents.logEvent('vectorstore:cleared', {});
  }
  async deleteByDocId(docId) {
    const colId = await this._ensureCollection();
    const res = await fetch(`${this.baseUrl}/api/v2/tenants/${this.tenant}/databases/${this.database}/collections/${colId}/delete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ where: { original_id: docId } })
    });
    if (!res.ok) throw new Error(`Chroma delete error: ${res.status}`);
    serverEvents.logEvent('vectorstore:deleted', { docId });
  }
  async getStats() {
    try {
      const colId = await this._ensureCollection();
      const res = await fetch(`${this.baseUrl}/api/v2/tenants/${this.tenant}/databases/${this.database}/collections/${colId}/count`);
      if (!res.ok) return { totalDocuments: 0, status: 'error' };
      const count = await res.json();
      return { totalDocuments: count, status: 'ready' };
    } catch(e) { return { totalDocuments: 0, status: 'error', error: e.message }; }
  }
}

class NovitaInference {
  constructor(apiKey = null, model = 'deepseek/deepseek-v4-pro') {
    this.apiKey = apiKey || process.env.NOVITA_API_KEY;
    this.model = model;
    if (!this.apiKey) throw new Error('Novita API key required');
  }
  async generateAnswer(query, contextDocuments, conversationHistory = []) {
    const start = Date.now();
    const contextText = contextDocuments.map((doc, idx) =>
      `[Document ${idx+1}] (${doc.metadata.file || doc.id})\n${doc.metadata.content || ''}`
    ).join('\n\n');
    const systemPrompt = `You are a helpful AI assistant. Use ONLY the provided context to answer. If unknown, say so.\n\nContext:\n${contextText}`;
    const messages = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory,
      { role: 'user', content: query }
    ];
    const res = await fetch('https://api.novita.ai/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, messages, temperature: 0.1, max_tokens: 1000 })
    });
    if (!res.ok) throw new Error(`Novita error: ${res.status}`);
    const data = await res.json();
    const answer = data.choices[0].message.content;
    serverEvents.logEvent('inference:complete', { queryLength: query.length, contextDocs: contextDocuments.length, duration: Date.now()-start });
    return answer;
  }
}

// ============================================================================
// CONCRETE PIPELINES (with clearing and chunking)
// ============================================================================
class ConcreteInjectionPipeline extends InjectionPipeline {
  async run(folderPath) {
    const start = Date.now();
    serverEvents.logEvent('injection:start', { folderPath });
    try {
      // 1. Clear existing vectors
      await this.store.clear();
      serverEvents.logEvent('injection:cleared', {});

      // 2. Load raw documents (whole files)
      const docs = await this.loader.loadDocuments(folderPath);
      if (!docs.length) throw new Error('No documents found');
      serverEvents.logEvent('injection:documents-loaded', { count: docs.length });

      // 3. Chunk each document
      const chunks = [];
      for (const doc of docs) {
        const textChunks = chunkText(doc.content, CHUNK_SIZE, CHUNK_OVERLAP);
        for (let i = 0; i < textChunks.length; i++) {
          chunks.push({
            id: `${doc.id}_chunk_${i}`,
            content: textChunks[i],
            metadata: {
              ...doc.metadata,
              chunk_index: i,
              total_chunks: textChunks.length,
              original_id: doc.id
            }
          });
        }
      }
      serverEvents.logEvent('injection:chunks-created', { totalChunks: chunks.length });

      // 4. Embed all chunks
      const texts = chunks.map(c => c.content);
      const embeddings = await this.embedder.embedBatch(texts);
      serverEvents.logEvent('injection:embeddings-generated', { count: embeddings.length });

      // 5. Store each chunk
      for (let i = 0; i < chunks.length; i++) {
        await this.store.store(chunks[i].id, embeddings[i], { ...chunks[i].metadata, content: chunks[i].content });
        serverEvents.logEvent('injection:document-stored', { id: chunks[i].id, progress: `${i+1}/${chunks.length}` });
      }

      const duration = Date.now() - start;
      serverEvents.logEvent('injection:complete', { documentsProcessed: docs.length, chunksStored: chunks.length, duration });
      return { success: true, documentsProcessed: docs.length, chunksStored: chunks.length, duration: `${duration}ms` };
    } catch (err) {
      serverEvents.logEvent('error', { stage: 'injection', message: err.message });
      return { success: false, error: err.message, duration: `${Date.now() - start}ms` };
    }
  }

  // Chunk + embed + store a single document. Caller is responsible for
  // deleting any previous chunks of this doc first (see runIncremental).
  async _indexDoc(doc) {
    const textChunks = chunkText(doc.content, CHUNK_SIZE, CHUNK_OVERLAP);
    const chunks = textChunks.map((content, i) => ({
      id: `${doc.id}_chunk_${i}`,
      content,
      metadata: { ...doc.metadata, chunk_index: i, total_chunks: textChunks.length, original_id: doc.id }
    }));
    const embeddings = await this.embedder.embedBatch(chunks.map(c => c.content));
    for (let i = 0; i < chunks.length; i++) {
      await this.store.store(chunks[i].id, embeddings[i], { ...chunks[i].metadata, content: chunks[i].content });
    }
    return chunks.length;
  }

  // Differential sync: only re-embed added/changed docs, delete removed docs.
  // Never clears the whole store, so retrieval stays available throughout.
  async runIncremental(folderPath, registry) {
    const start = Date.now();
    serverEvents.logEvent('injection:start', { folderPath, mode: 'incremental' });
    try {
      const docs = await this.loader.loadDocuments(folderPath);
      const { added, changed, unchanged, removed } = registry.diff(docs);
      serverEvents.logEvent('injection:diff', {
        added: added.length, changed: changed.length, unchanged: unchanged.length, removed: removed.length
      });

      // 1. Deletions: drop chunks for files no longer present.
      for (const docId of removed) {
        await this.store.deleteByDocId(docId);
        registry.remove(docId);
      }

      // 2. Additions + changes: re-index only the delta.
      //    For changed docs, delete old chunks FIRST so that when a file
      //    shrinks (fewer chunks than before) no orphan chunks survive.
      const changedIds = new Set(changed.map(d => d.id));
      let chunksStored = 0;
      for (const doc of [...added, ...changed]) {
        if (changedIds.has(doc.id)) await this.store.deleteByDocId(doc.id);
        const n = await this._indexDoc(doc);
        registry.set(doc.id, {
          hash: doc._hash,
          size: doc.metadata.size,
          mtime: doc.metadata.mtime,
          chunkCount: n,
          lastIndexedAt: Date.now()
        });
        chunksStored += n;
      }

      const duration = Date.now() - start;
      const result = {
        success: true, mode: 'incremental',
        added: added.length, changed: changed.length,
        unchanged: unchanged.length, removed: removed.length,
        chunksStored, duration: `${duration}ms`
      };
      serverEvents.logEvent('injection:complete', result);
      return result;
    } catch (err) {
      serverEvents.logEvent('error', { stage: 'injection-incremental', message: err.message });
      return { success: false, error: err.message, duration: `${Date.now() - start}ms` };
    }
  }
}

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

// ============================================================================
// HTTP & WEBSOCKET SERVER
// ============================================================================
class RAGServer {
  constructor(port = 3000, isReal = false) {
    this.port = port;
    this.isReal = isReal;
    this.injectionPipeline = null;
    this.retrievalPipeline = null;
    this.inference = null;
    this.store = null;
    this.registry = null;
    this.server = null;
    this.wsServer = null;
    this.clients = new Set();
  }

  async initialize() {
    this.registry = new DocRegistry();
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
      // Pre‑inject mock documents
      await this.injectionPipeline.run('/mock');
      this.store = store;
    }
  }

  setupWebSocket() {
    if (!WebSocketServer) return;
    this.wsServer = new WebSocketServer({ server: this.server });
    this.wsServer.on('connection', (ws) => {
      serverEvents.incrementConnectedClients(1);
      this.clients.add(ws);
      ws.send(JSON.stringify({
        type: 'connection:established',
        data: { timestamp: Date.now(), metrics: serverEvents.getMetrics(), recentEvents: serverEvents.eventLog.slice(-20) }
      }));
      const listener = (event) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'event', data: event })); };
      serverEvents.on('event', listener);
      ws.on('message', async (msg) => {
        try {
          const payload = JSON.parse(msg);
          await this.handleWebSocketMessage(ws, payload);
        } catch(e) { ws.send(JSON.stringify({ type: 'error', data: { message: 'Invalid JSON' } })); }
      });
      ws.on('close', () => { serverEvents.incrementConnectedClients(-1); serverEvents.removeListener('event', listener); this.clients.delete(ws); });
    });
  }

  async handleWebSocketMessage(ws, payload) {
    switch (payload.type) {
      case 'request:metrics':
        ws.send(JSON.stringify({ type: 'metrics', data: serverEvents.getMetrics() }));
        break;
      case 'request:event-log':
        ws.send(JSON.stringify({ type: 'event-log', data: serverEvents.eventLog }));
        break;
      case 'request:stats':
        const stats = await this.store.getStats();
        ws.send(JSON.stringify({ type: 'stats', data: stats }));
        break;
      case 'request:inject':
        // Full rebuild: clear + inject from INPUT_DIR. Registry is reset so it
        // never points at chunks the clear just removed.
        const injectResult = await this.injectionPipeline.run(INPUT_DIR);
        this._resetRegistry();
        ws.send(JSON.stringify({ type: 'inject:result', data: injectResult }));
        break;
      case 'request:inject-incremental':
        // Differential sync: only re-embed added/changed files, drop removed.
        const incResult = await this.injectionPipeline.runIncremental(INPUT_DIR, this.registry);
        ws.send(JSON.stringify({ type: 'inject:result', data: incResult }));
        break;
      case 'request:clear':  // legacy direct clear (still works)
        await this.store.clear();
        this._resetRegistry();
        ws.send(JSON.stringify({ type: 'clear:result', data: { success: true } }));
        break;
      case 'request:retrieve':
        const retrieval = await this.retrievalPipeline.run(payload.query, payload.topK || 5);
        ws.send(JSON.stringify({ type: 'retrieve:result', data: retrieval }));
        break;
      case 'request:ask':
        // Expect payload: { query, sessionId, topK? }
        const sessionId = payload.sessionId || `anon_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
        const conv = ConversationStore.getOrCreate(sessionId);
        const history = conv.getHistory(10);
        // 1. Retrieve context
        const retrievalAsk = await this.retrievalPipeline.run(payload.query, payload.topK || 3);
        if (!retrievalAsk.success) throw new Error(retrievalAsk.error);
        const contextDocs = retrievalAsk.results.map(r => ({ id: r.id, content: r.metadata.content || '', metadata: r.metadata }));
        // 2. Generate answer with history
        const answer = await this.inference.generateAnswer(payload.query, contextDocs, history);
        // 3. Store in history
        conv.addMessage('user', payload.query);
        conv.addMessage('assistant', answer);
        ws.send(JSON.stringify({
          type: 'ask:result',
          data: { success: true, query: payload.query, answer, sources: retrievalAsk.results, sessionId }
        }));
        break;
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        break;
      default:
        ws.send(JSON.stringify({ type: 'error', data: { message: `Unknown type: ${payload.type}` } }));
    }
  }

  handleRequest(req, res) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    const url = req.url;

    // --- static files ---
    const publicDir = path.join(__dirname, 'public');
    const cleanUrl = url.split('?')[0];
    const filePath = path.join(publicDir, cleanUrl);
    if (filePath.startsWith(publicDir) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };
        const contentType = mimeTypes[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        fs.createReadStream(filePath).pipe(res);
        return;
    }

    // --- API endpoints ---
    if (url === '/' && req.method === 'GET') {
        const dashboardPath = path.join(__dirname, 'public', 'dashboard.html');
        if (fs.existsSync(dashboardPath)) {
            res.writeHead(302, { 'Location': '/dashboard.html' });
            res.end();
            return;
        }
        res.writeHead(200);
        res.end(JSON.stringify({ message: 'RAG Server', dashboard: '/dashboard.html' }, null, 2));
        return;
    }
    else if (url === '/health' && req.method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'healthy', mode: this.isReal ? 'real' : 'mock', connectedClients: this.clients.size }));
    }
    else if (url === '/metrics' && req.method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify(serverEvents.getMetrics(), null, 2));
    }
    else if (url === '/stats' && req.method === 'GET') {
      this.store.getStats().then(stats => res.end(JSON.stringify(stats, null, 2))).catch(e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
    }
    else if (url === '/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      serverEvents.incrementConnectedClients(1);
      res.write(`data: ${JSON.stringify({ type: 'sse:connected', metrics: serverEvents.getMetrics() })}\n\n`);
      const listener = (event) => { res.write(`data: ${JSON.stringify({ type: 'event', data: event })}\n\n`); };
      serverEvents.on('event', listener);
      req.on('close', () => { serverEvents.removeListener('event', listener); serverEvents.incrementConnectedClients(-1); res.end(); });
    }
    else if (url === '/inject' && req.method === 'POST') {
      // Full rebuild: clear + inject from INPUT_DIR (reset registry to match).
      this.injectionPipeline.run(INPUT_DIR).then(result => {
        this._resetRegistry();
        res.writeHead(200);
        res.end(JSON.stringify(result, null, 2));
      }).catch(err => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      });
    }
    else if (url === '/inject-incremental' && req.method === 'POST') {
      // Differential sync: only re-embed the delta vs the registry.
      this.injectionPipeline.runIncremental(INPUT_DIR, this.registry).then(result => {
        res.writeHead(200);
        res.end(JSON.stringify(result, null, 2));
      }).catch(err => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      });
    }
    else if (url === '/clear' && req.method === 'POST') {
      this.store.clear().then(() => { this._resetRegistry(); res.end(JSON.stringify({ success: true })); }).catch(e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
    }
    else if (url === '/retrieve' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const { query, topK } = JSON.parse(body);
          const result = await this.retrievalPipeline.run(query, topK || 5);
          res.writeHead(200);
          res.end(JSON.stringify(result, null, 2));
        } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
      });
    }
    else if (url === '/ask' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const { query, sessionId, topK = 3 } = JSON.parse(body);
          const sid = sessionId || `http_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
          const conv = ConversationStore.getOrCreate(sid);
          const history = conv.getHistory(10);
          // 1. Retrieve
          const retrieval = await this.retrievalPipeline.run(query, topK);
          if (!retrieval.success) throw new Error(retrieval.error);
          const contextDocs = retrieval.results.map(r => ({ id: r.id, content: r.metadata.content || '', metadata: r.metadata }));
          // 2. Generate
          const answer = await this.inference.generateAnswer(query, contextDocs, history);
          // 3. Save
          conv.addMessage('user', query);
          conv.addMessage('assistant', answer);
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, query, answer, sources: retrieval.results, sessionId: sid }, null, 2));
        } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
      });
    }
    else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  }

  start() {
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    this.setupWebSocket();
    this.server.listen(this.port, () => {
      console.log(`\n🚀 RAG Server running on http://localhost:${this.port} [${this.isReal ? 'REAL' : 'MOCK'}]`);
      console.log(`📂 Input directory: ${INPUT_DIR}`);
      console.log(`✂️  Chunk size: ${CHUNK_SIZE} (overlap: ${CHUNK_OVERLAP})`);
      console.log(`💬 Conversation storage: ${CONVERSATIONS_DIR}`);
      console.log(`📡 WebSocket: ${WebSocketServer ? `ws://localhost:${this.port}` : 'disabled'}`);
      console.log(`📡 SSE events: http://localhost:${this.port}/events\n`);
    });
  }
  stop() { if (this.server) this.server.close(); }

  // After a full clear/inject the store no longer matches the registry, so wipe
  // it. The next incremental run then treats every file as newly added.
  _resetRegistry() {
    if (!this.registry) return;
    this.registry.docs = {};
    this.registry._save();
  }
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
// DELTA (INCREMENTAL SYNC) TESTS — self-contained, no external services
// ============================================================================
async function runDeltaTests() {
  const assert = (cond, msg) => {
    if (!cond) { console.error(`  ✗ ${msg}`); throw new Error(`FAIL: ${msg}`); }
    console.log(`  ✓ ${msg}`);
  };
  const os = require('os');
  const tmpRegistry = path.join(os.tmpdir(), `rag-delta-${process.pid}.json`);
  if (fs.existsSync(tmpRegistry)) fs.unlinkSync(tmpRegistry);

  const registry = new DocRegistry(tmpRegistry);
  const store = new MockVectorStore();
  const embedder = new MockEmbedder();

  // Loader whose returned documents we can mutate between runs.
  let currentDocs = [];
  const loader = new (class extends DocumentLoader {
    async loadDocuments() {
      return currentDocs.map(d => ({
        id: d.id, content: d.content,
        metadata: { file: d.id, path: d.id, size: d.content.length, mtime: 0 }
      }));
    }
  })();
  const pipeline = new ConcreteInjectionPipeline(loader, embedder, store);
  const countChunks = (docId) => [...store.docs.values()].filter(v => v.metadata.original_id === docId).length;

  console.log('\n[delta] Round 1: index a large doc (multiple chunks)');
  currentDocs = [{ id: 'doc1.md', content: 'A'.repeat(2500) }]; // > CHUNK_SIZE => several chunks
  await pipeline.runIncremental('/x', registry);
  const initialChunks = countChunks('doc1.md');
  assert(initialChunks >= 3, `large doc split into ${initialChunks} chunks (expected >= 3)`);
  assert(registry.get('doc1.md').chunkCount === initialChunks, 'registry records the chunk count');

  console.log('\n[delta] Round 2: re-run with no changes (should skip embedding)');
  const callsBefore = embedder.getCallCount();
  const r2 = await pipeline.runIncremental('/x', registry);
  assert(embedder.getCallCount() === callsBefore, 'unchanged doc triggered zero new embeddings');
  assert(r2.unchanged === 1 && r2.changed === 0 && r2.added === 0, 'diff classified the doc as unchanged');
  assert(countChunks('doc1.md') === initialChunks, 'chunk count unchanged');

  console.log('\n[delta] Round 3: file shrinks — orphan chunks must be removed');
  currentDocs = [{ id: 'doc1.md', content: 'tiny content' }]; // single chunk now
  const r3 = await pipeline.runIncremental('/x', registry);
  assert(r3.changed === 1, 'diff classified the doc as changed');
  assert(countChunks('doc1.md') === 1, `shrunk doc has exactly 1 chunk, ${initialChunks - 1} orphans removed`);

  console.log('\n[delta] Round 4: file removed — chunks and registry entry deleted');
  currentDocs = [];
  const r4 = await pipeline.runIncremental('/x', registry);
  assert(r4.removed === 1, 'diff classified the doc as removed');
  assert(countChunks('doc1.md') === 0, 'removed doc has no surviving chunks');
  assert(store.docs.size === 0, 'store is empty after removal');
  assert(registry.get('doc1.md') === undefined, 'registry entry deleted');

  fs.unlinkSync(tmpRegistry);
  console.log('\n✅ All delta tests passed\n');
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--delta-test')) {
    try { await runDeltaTests(); process.exit(0); }
    catch (e) { console.error('\n❌ Delta tests failed:', e.message); process.exit(1); }
  } else if (args.includes('--test')) {
    const runner = await setupTests();
    const ok = await runner.run();
    process.exit(ok ? 0 : 1);
  } else if (args.includes('--real-test')) {
    try {
      const runner = await setupRealTests();
      const ok = await runner.run();
      process.exit(ok ? 0 : 1);
    } catch(e) { console.error(e); process.exit(1); }
  } else if (args.includes('--server')) {
    const port = args.includes('--port') ? parseInt(args[args.indexOf('--port')+1]) : 3000;
    const isReal = args.includes('--real');
    const server = new RAGServer(port, isReal);
    await server.initialize();
    server.start();
  } else {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║   RAG System with WebSocket + Chunking + Conversation       ║
╚══════════════════════════════════════════════════════════════╝

Usage:
  node rag-server.js --test               Run mock tests
  node rag-server.js --delta-test         Run incremental-sync (delta) tests
  node rag-server.js --real-test          Run real integration tests
  node rag-server.js --server             Start mock server (port 3000)
  node rag-server.js --server --real      Start real server (Gemini+Chroma+Novita)
  node rag-server.js --server --port 8080 Use custom port

Environment variables:
  RAG_INPUT_DIR     = ./input   (directory with .md files)
  RAG_CHUNK_SIZE    = 1000      (characters per chunk)
  RAG_CHUNK_OVERLAP = 200
  GEMINI_API_KEY    = ...
  NOVITA_API_KEY    = ...
    `);
  }
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

module.exports = { RAGServer, serverEvents, ConversationStore, DocRegistry, chunkText };