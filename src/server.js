/**
 * RAGServer — HTTP + WebSocket transport wiring the pipelines together.
 * Selects mock vs real implementations via the `isReal` flag.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const { INPUT_DIR, CHUNK_SIZE, CHUNK_OVERLAP, CONVERSATIONS_DIR, EXPERT_MODE } = require('./config');
const { serverEvents } = require('./events');
const { ConversationStore } = require('./core/conversation');
const { DocRegistry } = require('./core/registry');
const { GoldenDataset } = require('./core/golden-dataset');
const { MockDocumentLoader } = require('./loaders/mock');
const { RealDocumentLoader } = require('./loaders/real');
const { MockEmbedder } = require('./embedders/mock');
const { GeminiEmbedder } = require('./embedders/gemini');
const { MockVectorStore } = require('./stores/mock');
const { ChromaVectorStore } = require('./stores/chroma');
const { BM25Store } = require('./stores/bm25');
const { HybridStore } = require('./stores/hybrid');
const { MockReranker } = require('./rerankers/mock');
const { CrossEncoderReranker } = require('./rerankers/real');
const { NovitaInference } = require('./inference/novita');
const { MockInference } = require('./inference/mock');
const { LLMJudge } = require('./agentic/judge');
const { LLMQueryRewriter } = require('./agentic/query-rewriter');
const { ConcreteInjectionPipeline } = require('./pipelines/injection');
const { NEREnrichedRetrievalPipeline } = require('./pipelines/retrieval');
const { AgenticRetrievalPipeline } = require('./pipelines/agentic-retrieval');
const { GraphRAGPipeline } = require('./pipelines/graph-rag');
const { RetrievalObjectives } = require('./core/interfaces');
// NER / graph components
const { MockEntityExtractor } = require('./ner/mock-extractor');
const { MockAcronymGlossary } = require('./ner/mock-glossary');
const { MockMetadataFilter } = require('./ner/mock-filter');
const { MockGraphStore } = require('./graph/mock-store');
const { MockRelationshipExtractor } = require('./graph/mock-extractor');
const { MockContextFuser } = require('./graph/mock-fuser');
// Authority components
const { MockProvenanceAnnotator } = require('./authority/mock-annotator');
const { StaticDictionaryScorer } = require('./authority/mock-scorer');
const { AuthorityAwareReranker } = require('./rerankers/authority-aware');

// public/ lives at the project root, one level above src/
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// WebSocket optional
let WebSocketServer;
try {
  const WebSocket = require('ws');
  WebSocketServer = WebSocket.Server;
} catch (err) {
  console.warn('⚠️  ws package not installed. Install with: npm install ws');
  console.warn('WebSocket support disabled.\n');
}

class RAGServer {
  constructor(port = 3000, isReal = false) {
    this.port = port;
    this.isReal = isReal;
    this.expertMode = EXPERT_MODE;
    this.injectionPipeline = null;
    this.retrievalPipeline = null;  // NEREnrichedRetrievalPipeline
    this.agenticPipeline   = null;  // AgenticRetrievalPipeline (agentic loop)
    this.graphRagPipeline  = null;  // GraphRAGPipeline (dual-path, used by /ask)
    this.inference  = null;
    this.store      = null;
    this.hybridStore = null;
    this.bm25Store  = null;
    this.reranker   = null;
    this.graphStore = null;
    this.registry   = null;
    this.server     = null;
    this.wsServer   = null;
    this.clients    = new Set();
  }

  async initialize() {
    this.registry = new DocRegistry();

    // ── Shared NER / graph / authority components (same interfaces for both modes) ──
    const ner          = new MockEntityExtractor();
    const glossary     = new MockAcronymGlossary();
    const filter       = new MockMetadataFilter();
    const relExtractor = new MockRelationshipExtractor();
    const graphStore   = new MockGraphStore();
    const fuser        = new MockContextFuser();
    const annotator    = new MockProvenanceAnnotator();
    const scorer       = new StaticDictionaryScorer();
    this.graphStore    = graphStore;

    if (this.isReal) {
      const embedder  = new GeminiEmbedder();
      const store     = new ChromaVectorStore();
      const bm25      = new BM25Store();
      const hybrid    = new HybridStore(store, bm25);
      const loader    = new RealDocumentLoader();
      const baseReranker  = new CrossEncoderReranker();
      const reranker  = new AuthorityAwareReranker(scorer, { semanticReranker: baseReranker });
      this.inference  = new NovitaInference();
      const judge     = new LLMJudge(this.inference);
      const queryRewriter = new LLMQueryRewriter(this.inference);

      // Injection: chunk → annotate authority → NER tag → rel extract → embed → store
      this.injectionPipeline = new ConcreteInjectionPipeline(
        loader, embedder, hybrid, ner, relExtractor, graphStore, annotator
      );

      // Retrieval: acronym expand → NER filter → hybrid search → authority-aware rerank
      this.retrievalPipeline = new NEREnrichedRetrievalPipeline(
        embedder, hybrid, { ner, glossary, filter, reranker }
      );

      // Agentic loop (multi-iteration quality control)
      this.agenticPipeline = new AgenticRetrievalPipeline(
        embedder, hybrid, reranker,
        { objective: RetrievalObjectives.BALANCED, latencyBudget: 5000, maxIterations: 2, minimumQuality: 0.5 },
        null, judge, queryRewriter
      );

      // Graph-RAG: dual-path parallel retrieval + context fusion + authority-aware rerank
      this.graphRagPipeline = new GraphRAGPipeline(
        embedder, hybrid, graphStore,
        { ner, glossary, filter, fuser, reranker, graphDepth: 1, candidateK: 20 }
      );

      this.store      = hybrid;
      this.hybridStore = hybrid;
      this.bm25Store  = bm25;
      this.reranker   = reranker;

    } else {
      const embedder  = new MockEmbedder();
      const store     = new MockVectorStore();
      const bm25      = new BM25Store();
      const hybrid    = new HybridStore(store, bm25);
      const loader    = new MockDocumentLoader();
      const baseReranker  = new MockReranker();
      const reranker  = new AuthorityAwareReranker(scorer, { semanticReranker: baseReranker });
      this.inference  = new MockInference();

      // Injection: chunk → annotate authority → NER tag → rel extract → embed → store
      this.injectionPipeline = new ConcreteInjectionPipeline(
        loader, embedder, hybrid, ner, relExtractor, graphStore, annotator
      );

      // Retrieval: acronym expand → NER filter → hybrid search → authority-aware rerank
      this.retrievalPipeline = new NEREnrichedRetrievalPipeline(
        embedder, hybrid, { ner, glossary, filter, reranker }
      );

      // Agentic loop
      this.agenticPipeline = new AgenticRetrievalPipeline(
        embedder, hybrid, reranker,
        { objective: RetrievalObjectives.BALANCED, latencyBudget: 5000, maxIterations: 2, minimumQuality: 0.5 }
      );

      // Graph-RAG: dual-path parallel retrieval + context fusion + authority-aware rerank
      this.graphRagPipeline = new GraphRAGPipeline(
        embedder, hybrid, graphStore,
        { ner, glossary, filter, fuser, reranker, graphDepth: 1, candidateK: 20 }
      );

      this.store      = hybrid;
      this.hybridStore = hybrid;
      this.bm25Store  = bm25;
      this.reranker   = reranker;

      await this.injectionPipeline.run('/mock', this.registry);
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
        const graphStats = await this.graphStore.getStats();
        ws.send(JSON.stringify({ type: 'stats', data: { ...stats, graph: graphStats } }));
        break;
      case 'request:inject':
        // Full rebuild: clear + inject from INPUT_DIR. The pipeline rebuilds the
        // registry to mirror what it embedded, so the next incremental run skips
        // unchanged files instead of re-embedding the whole corpus.
        const injectResult = await this.injectionPipeline.run(INPUT_DIR, this.registry);
        ws.send(JSON.stringify({ type: 'inject:result', data: injectResult }));
        break;
      case 'request:inject-incremental':
        // Differential sync: only re-embed added/changed files, drop removed.
        const incResult = await this.injectionPipeline.runIncremental(INPUT_DIR, this.registry);
        ws.send(JSON.stringify({ type: 'inject:result', data: incResult }));
        break;
      case 'request:clear':  // legacy direct clear (still works)
        await this.store.clear();
        await this.graphStore.clear();
        this._resetRegistry();
        ws.send(JSON.stringify({ type: 'clear:result', data: { success: true } }));
        break;
      case 'request:retrieve':
        const retrieval = await this.retrievalPipeline.run(payload.query, payload.topK || 5);
        ws.send(JSON.stringify({ type: 'retrieve:result', data: retrieval }));
        break;
      case 'request:ask':
        const sessionId = payload.sessionId || `anon_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
        const conv = ConversationStore.getOrCreate(sessionId);
        const history = conv.getHistory(10);
        const topK = payload.topK || 3;
        // Use GraphRAGPipeline: dual-path (graph traversal + NER-filtered hybrid)
        const graphRagResult = await this.graphRagPipeline.run(payload.query, topK);
        if (!graphRagResult.success) throw new Error(graphRagResult.error);
        // Build context docs from vector chunks for inference
        const contextDocs = graphRagResult.vectorChunks.map(r => ({
          id: r.id,
          content: r.metadata?.content || '',
          metadata: r.metadata
        }));
        // Pass the full fused context string (graph facts + text passages) to inference
        const answer = await this.inference.generateAnswer(
          payload.query, contextDocs, history,
          { fusedContext: graphRagResult.combinedContext }
        );
        conv.addMessage('user', payload.query);
        conv.addMessage('assistant', answer);
        ws.send(JSON.stringify({
          type: 'ask:result',
          data: {
            success: true,
            query:          payload.query,
            expandedQuery:  graphRagResult.expandedQuery,
            entities:       graphRagResult.entities,
            answer,
            sources:        graphRagResult.vectorChunks,
            graphFacts:     graphRagResult.context.graphFacts,
            graphPaths:     graphRagResult.graphPaths,
            sessionId,
          }
        }));
        break;
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        break;
      case 'request:capture-fixture': {
        if (!this.expertMode) {
          ws.send(JSON.stringify({ type: 'capture-fixture:result', data: { success: false, error: 'Expert mode is disabled.' } }));
          break;
        }
        try {
          const { id, description, query, topK, expectedAction, humanJudgment, pipelineMode, tags, captureChunks } = payload;
          const dataset = new GoldenDataset();
          const fixture = await dataset.captureFixture({
            id, description, pipeline: this.agenticPipeline,
            query, topK: topK || 3,
            expectedAction, humanJudgment,
            pipelineMode: pipelineMode || (this.isReal ? 'real' : 'mock'),
            tags: tags || [],
            captureChunks: captureChunks || false,
          });
          ws.send(JSON.stringify({ type: 'capture-fixture:result', data: { success: true, fixture } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'capture-fixture:result', data: { success: false, error: err.message } }));
        }
        break;
      }
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
    const publicDir = PUBLIC_DIR;
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
        const dashboardPath = path.join(PUBLIC_DIR, 'dashboard.html');
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
      res.end(JSON.stringify({ status: 'healthy', mode: this.isReal ? 'real' : 'mock', expertMode: this.expertMode, connectedClients: this.clients.size }));
    }
    else if (url === '/metrics' && req.method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify(serverEvents.getMetrics(), null, 2));
    }
    else if (url === '/stats' && req.method === 'GET') {
      Promise.all([this.store.getStats(), this.graphStore.getStats()])
        .then(([storeStats, graphStats]) => res.end(JSON.stringify({ ...storeStats, graph: graphStats }, null, 2)))
        .catch(e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
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
      // Full rebuild: clear + inject from INPUT_DIR. The pipeline rebuilds the
      // registry to match, so a later incremental sync won't re-embed everything.
      this.injectionPipeline.run(INPUT_DIR, this.registry).then(result => {
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
      Promise.all([this.store.clear(), this.graphStore.clear()])
        .then(() => { this._resetRegistry(); res.end(JSON.stringify({ success: true })); })
        .catch(e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
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
          const sid  = sessionId || `http_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
          const conv = ConversationStore.getOrCreate(sid);
          const history = conv.getHistory(10);

          // Dual-path: graph traversal + NER-filtered hybrid retrieval
          const graphRagResult = await this.graphRagPipeline.run(query, topK);
          if (!graphRagResult.success) throw new Error(graphRagResult.error);

          const contextDocs = graphRagResult.vectorChunks.map(r => ({
            id: r.id,
            content: r.metadata?.content || '',
            metadata: r.metadata
          }));
          const answer = await this.inference.generateAnswer(
            query, contextDocs, history,
            { fusedContext: graphRagResult.combinedContext }
          );
          conv.addMessage('user', query);
          conv.addMessage('assistant', answer);

          res.writeHead(200);
          res.end(JSON.stringify({
            success: true,
            query,
            expandedQuery: graphRagResult.expandedQuery,
            entities:      graphRagResult.entities,
            answer,
            sources:       graphRagResult.vectorChunks,
            graphFacts:    graphRagResult.context.graphFacts,
            sessionId:     sid,
          }, null, 2));
        } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
      });
    }
    else if (url === '/capture-fixture' && req.method === 'POST') {
      if (!this.expertMode) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Expert mode is disabled. Set RAG_EXPERT_MODE=true to enable.' }));
        return;
      }
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const { id, description, query, topK, expectedAction, humanJudgment, pipelineMode, tags, captureChunks } = JSON.parse(body);
          const dataset = new GoldenDataset();
          const fixture = await dataset.captureFixture({
            id, description, pipeline: this.agenticPipeline,
            query, topK: topK || 3,
            expectedAction, humanJudgment,
            pipelineMode: pipelineMode || (this.isReal ? 'real' : 'mock'),
            tags: tags || [],
            captureChunks: captureChunks || false,
          });
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, fixture }, null, 2));
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
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

module.exports = { RAGServer };
