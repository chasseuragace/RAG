/**
 * RAGServer — HTTP + WebSocket transport wiring the pipelines together.
 * Selects mock vs real implementations via the `isReal` flag.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const { INPUT_DIR, CHUNK_SIZE, CHUNK_OVERLAP, CONVERSATIONS_DIR, EXPERT_MODE, NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD, PG_CONNECTION_STRING, MODEL_CONTEXT_WINDOW, SYSTEM_TOKEN_BUDGET, RESPONSE_MAX_TOKENS, MIN_MESSAGES_TO_KEEP, SUMMARY_MAX_TOKENS, BASE_SYSTEM_PROMPT } = require('../shared/config');
const { serverEvents } = require('../shared/events');
const { DocRegistry } = require('../ingestion/registry');
const { GoldenDataset } = require('../evaluation/golden-dataset');
const { MockDocumentLoader } = require('../ingestion/loaders/mock');
const { RealDocumentLoader } = require('../ingestion/loaders/real');
const { MockEmbedder } = require('../retrieval/embedders/mock');
const { GeminiEmbedder } = require('../retrieval/embedders/gemini');
const { ChromaVectorStore } = require('../retrieval/stores/chroma');
const { BM25Store } = require('../retrieval/stores/bm25');
const { PostgresBM25Store } = require('../retrieval/stores/postgres-bm25');
const { HybridStore } = require('../retrieval/stores/hybrid');
const { MockReranker } = require('../retrieval/rerankers/mock');
const { CrossEncoderReranker } = require('../retrieval/rerankers/real');
const { NovitaInference } = require('../inference/novita');
const { MockInference } = require('../inference/mock');
const { LLMJudge } = require('../agentic/judge');
const { LLMQueryRewriter } = require('../agentic/query-rewriter');
const { ConcreteInjectionPipeline } = require('../ingestion/pipeline');
const { NEREnrichedRetrievalPipeline } = require('../retrieval/pipeline');
const { AgenticRetrievalPipeline } = require('../agentic/pipeline');
const { GraphRAGPipeline } = require('../retrieval/graph-rag');
const { RetrievalObjectives } = require('../shared/interfaces');
// NER / graph components
const { MockEntityExtractor } = require('../retrieval/ner/mock-extractor');
const { PostgresAcronymGlossary } = require('../retrieval/ner/glossary');
const { MockMetadataFilter } = require('../retrieval/ner/mock-filter');
const { Neo4jGraphStore } = require('../ingestion/graph/store');
const { MockRelationshipExtractor } = require('../ingestion/graph/mock-extractor');
const { MockContextFuser } = require('../retrieval/graph/mock-fuser');
// Authority components
const { MockProvenanceAnnotator } = require('../ingestion/authority/mock-annotator');
const { StaticDictionaryScorer } = require('../retrieval/authority/mock-scorer');
const { AuthorityAwareReranker } = require('../retrieval/rerankers/authority-aware');
const { UnifiedRetrievalPipeline } = require('../retrieval/unified-pipeline');
const { createThreadManager } = require('../session/thread-manager-factory');
const { TokenCounter } = require('../shared/token-counter');
const { MessageSummarizer } = require('../shared/message-summarizer');
const { ContextWindowManager } = require('../shared/context-window-manager');

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
    this.unifiedPipeline = null;
    this.registry   = null;
    this.server     = null;
    this.wsServer   = null;
    this.clients    = new Set();
    this.threadManager = null;
    this.contextWindowManager = null;
  }

  async initialize() {
    this.registry = new DocRegistry();
    await this.registry.init();

    // ── Shared NER / graph / authority components (same interfaces for both modes) ──
    const ner          = new MockEntityExtractor();
    const glossary     = new PostgresAcronymGlossary(PG_CONNECTION_STRING);
    const filter       = new MockMetadataFilter();
    const relExtractor = new MockRelationshipExtractor();
    const graphStore   = new Neo4jGraphStore(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);
    const fuser        = new MockContextFuser();
    const annotator    = new MockProvenanceAnnotator();
    const scorer       = new StaticDictionaryScorer();
    this.graphStore    = graphStore;

    // ── Inference (shared between mock and real modes) ──
    this.inference = this.isReal ? new NovitaInference() : new MockInference();

    // ── Context-aware chat (before pipelines so they can use thread/context managers) ──
    this.threadManager = createThreadManager();
    const tokenCounter = new TokenCounter();
    await tokenCounter.init();
    const summarizer = new MessageSummarizer(this.inference);
    this.contextWindowManager = new ContextWindowManager({
      tokenCounter,
      summarizer,
      threadManager: this.threadManager,
      modelContextWindow: MODEL_CONTEXT_WINDOW,
      systemTokenBudget: SYSTEM_TOKEN_BUDGET,
      responseTokenBudget: RESPONSE_MAX_TOKENS,
      minMessagesToKeep: MIN_MESSAGES_TO_KEEP,
    });

    if (this.isReal) {
      const embedder  = new GeminiEmbedder();
      const store     = new ChromaVectorStore();
      const bm25      = new PostgresBM25Store();
      await bm25.init();
      const hybrid    = new HybridStore(store, bm25);
      const loader    = new RealDocumentLoader();
      const baseReranker  = new CrossEncoderReranker();
      const reranker  = new AuthorityAwareReranker(scorer, { semanticReranker: baseReranker });
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
      this.unifiedPipeline = new UnifiedRetrievalPipeline({
        embedder,
        hybridStore: hybrid,
        graphStore,
        contextFuser: fuser,
        ner,
        glossary,
        filter,
        minGraphConfidence: 0.6,
        graphDepth: 2,
        candidateK: 20,
      });
      this.agenticPipeline = new AgenticRetrievalPipeline(
        embedder, hybrid, reranker,
        { objective: RetrievalObjectives.BALANCED, latencyBudget: 5000, maxIterations: 2, minimumQuality: 0.5 },
        null, judge, queryRewriter,
        this.unifiedPipeline,
        this.threadManager,
        this.contextWindowManager,
        { systemPrompt: BASE_SYSTEM_PROMPT, responseMaxTokens: RESPONSE_MAX_TOKENS, inference: this.inference }
      );

      // Graph-RAG: dual-path parallel retrieval + context fusion + authority-aware rerank
      // @gotcha `graphDepth: 1` → `maxDepth = 0` in queryByEntity, meaning NO path expansion.
      //       Use depth >= 2 to enable neighbor traversal via apoc.path.expand.
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
      const store     = new ChromaVectorStore();
      const bm25      = new BM25Store();
      const hybrid    = new HybridStore(store, bm25);
      const loader    = new MockDocumentLoader();
      const baseReranker  = new MockReranker();
      const reranker  = new AuthorityAwareReranker(scorer, { semanticReranker: baseReranker });

      // Injection: chunk → annotate authority → NER tag → rel extract → embed → store
      this.injectionPipeline = new ConcreteInjectionPipeline(
        loader, embedder, hybrid, ner, relExtractor, graphStore, annotator
      );

      // Retrieval: acronym expand → NER filter → hybrid search → authority-aware rerank
      this.retrievalPipeline = new NEREnrichedRetrievalPipeline(
        embedder, hybrid, { ner, glossary, filter, reranker }
      );

      // Agentic loop
      this.unifiedPipeline = new UnifiedRetrievalPipeline({
        embedder,
        hybridStore: hybrid,
        graphStore,
        contextFuser: fuser,
        ner,
        glossary,
        filter,
        minGraphConfidence: 0.6,
        graphDepth: 2,
        candidateK: 20,
      });
      this.agenticPipeline = new AgenticRetrievalPipeline(
        embedder, hybrid, reranker,
        { objective: RetrievalObjectives.BALANCED, latencyBudget: 5000, maxIterations: 2, minimumQuality: 0.5 },
        null, null, null,
        this.unifiedPipeline,
        this.threadManager,
        this.contextWindowManager,
        { systemPrompt: BASE_SYSTEM_PROMPT, responseMaxTokens: RESPONSE_MAX_TOKENS, inference: this.inference }
      );

      // Graph-RAG: dual-path parallel retrieval + context fusion + authority-aware rerank
      // @gotcha `graphDepth: 1` → `maxDepth = 0` in queryByEntity, meaning NO path expansion.
      //       Use depth >= 2 to enable neighbor traversal via apoc.path.expand.
      this.graphRagPipeline = new GraphRAGPipeline(
        embedder, hybrid, graphStore,
        { ner, glossary, filter, fuser, reranker, graphDepth: 1, candidateK: 20 }
      );

      this.store      = hybrid;
      this.hybridStore = hybrid;
      this.bm25Store  = bm25;
      this.reranker   = reranker;

await this.injectionPipeline.run('/mock', this.registry);
       // @gotcha Mock mode blocks here until the full mock injection completes.
       //       Real mode returns immediately — the heavy lifting happens on /inject requests.
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
        const ac = new AbortController();
        const abortHandler = () => ac.abort();
        ws.addEventListener('close', abortHandler);
        try {
          const payload = JSON.parse(msg);
          await this.handleWebSocketMessage(ws, payload, ac.signal);
        } catch(e) { if (e.name === 'AbortError') return; if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', data: { message: 'Invalid JSON' } })); }
        ws.removeEventListener('close', abortHandler);
      });
      ws.on('close', () => { serverEvents.incrementConnectedClients(-1); serverEvents.removeListener('event', listener); this.clients.delete(ws); });
    });
  }

  _wsSend(ws, data) {
    if (ws.readyState !== 1) return;
    ws.send(JSON.stringify(data));
  }

  async handleWebSocketMessage(ws, payload, abortSignal = null) {
    switch (payload.type) {
      case 'request:metrics':
        this._wsSend(ws, { type: 'metrics', data: serverEvents.getMetrics() });
        break;
      case 'request:event-log':
        this._wsSend(ws, { type: 'event-log', data: serverEvents.eventLog });
        break;
      case 'request:stats':
        const stats = await this.store.getStats();
        const graphStats = await this.graphStore.getStats();
        this._wsSend(ws, { type: 'stats', data: { ...stats, graph: graphStats } });
        break;
      case 'request:inject':
        const injectResult = await this.injectionPipeline.run(INPUT_DIR, this.registry, abortSignal);
        this._wsSend(ws, { type: 'inject:result', data: injectResult });
        break;
      case 'request:inject-incremental':
        const incResult = await this.injectionPipeline.runIncremental(INPUT_DIR, this.registry, abortSignal);
        this._wsSend(ws, { type: 'inject:result', data: incResult });
        break;
      case 'request:clear':
        await this.store.clear();
        await this.graphStore.clear();
        await this._resetRegistry();
        this._wsSend(ws, { type: 'clear:result', data: { success: true } });
        break;
      case 'request:retrieve':
        const retrieval = await this.retrievalPipeline.run(payload.query, payload.topK || 5, abortSignal);
        this._wsSend(ws, { type: 'retrieve:result', data: retrieval });
        break;
      case 'request:ask': {
        if (ws.readyState !== 1) return;
        const sessionId = payload.sessionId || `anon_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
        const topK = payload.topK || 3;
        const agResult = await this.agenticPipeline.run(payload.query, topK, sessionId, abortSignal);
        if (abortSignal?.aborted) return;
        if (!agResult.success) throw new Error(agResult.error);
        this._wsSend(ws, {
          type: 'ask:result',
          data: {
            success:       true,
            query:         payload.query,
            expandedQuery: agResult.expandedQuery,
            entities:      agResult.entities,
            answer:        agResult.answer,
            sources:       agResult.results,
            graphFacts:    agResult.graphFacts,
            sessionId:     agResult.sessionId,
            assessment:    agResult.assessment,
            finalAction:   agResult.finalAction,
            trace:         agResult.trace,
          }
        });
        break;
      }
      case 'ping':
        this._wsSend(ws, { type: 'pong', timestamp: Date.now() });
        break;
      case 'request:capture-fixture': {
        if (!this.expertMode) {
          this._wsSend(ws, { type: 'capture-fixture:result', data: { success: false, error: 'Expert mode is disabled.' } });
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
           }, abortSignal);
           this._wsSend(ws, { type: 'capture-fixture:result', data: { success: true, fixture } });
        } catch (err) {
          this._wsSend(ws, { type: 'capture-fixture:result', data: { success: false, error: err.message } });
        }
        break;
      }
      default:
        this._wsSend(ws, { type: 'error', data: { message: `Unknown type: ${payload.type}` } });
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
       const ac = new AbortController();
       req.on('close', () => ac.abort());
       this.injectionPipeline.run(INPUT_DIR, this.registry, ac.signal).then(result => {
         if (ac.signal.aborted) return;
         res.writeHead(200);
         res.end(JSON.stringify(result, null, 2));
       }).catch(err => {
         if (ac.signal.aborted) return;
         res.writeHead(500);
         res.end(JSON.stringify({ error: err.message }));
       });
     }
     else if (url === '/inject-incremental' && req.method === 'POST') {
       const ac = new AbortController();
       req.on('close', () => ac.abort());
       this.injectionPipeline.runIncremental(INPUT_DIR, this.registry, ac.signal).then(result => {
         if (ac.signal.aborted) return;
         res.writeHead(200);
         res.end(JSON.stringify(result, null, 2));
       }).catch(err => {
         if (ac.signal.aborted) return;
         res.writeHead(500);
         res.end(JSON.stringify({ error: err.message }));
       });
    }
    else if (url === '/clear' && req.method === 'POST') {
      Promise.all([this.store.clear(), this.graphStore.clear()])
        .then(() => this._resetRegistry())
        .then(() => { res.end(JSON.stringify({ success: true })); })
        .catch(e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
    }
      else if (url === '/retrieve' && req.method === 'POST') {
        const ac = new AbortController();
        req.on('close', () => ac.abort());
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
          try {
            const { query, topK } = JSON.parse(body);
            const result = await this.retrievalPipeline.run(query, topK || 5, ac.signal);
            if (ac.signal.aborted) return;
            res.writeHead(200);
            res.end(JSON.stringify(result, null, 2));
          } catch(e) { if (ac.signal.aborted) return; res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
        });
      }
      else if (url === '/ask' && req.method === 'POST') {
        const ac = new AbortController();
        req.on('close', () => ac.abort());
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
          try {
            const { query, sessionId, topK = 3 } = JSON.parse(body);
            const sid = sessionId || `http_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
            const agResult = await this.agenticPipeline.run(query, topK, sid, ac.signal);
            if (ac.signal.aborted) return;
            if (!agResult.success) throw new Error(agResult.error);
            res.writeHead(200);
            res.end(JSON.stringify({
              success:       true,
              query,
              expandedQuery: agResult.expandedQuery,
              entities:      agResult.entities,
              answer:        agResult.answer,
              sources:       agResult.results,
              graphFacts:    agResult.graphFacts,
              sessionId:     agResult.sessionId,
              assessment:    agResult.assessment,
              finalAction:   agResult.finalAction,
              trace:         agResult.trace,
            }, null, 2));
          } catch(e) { if (ac.signal.aborted) return; res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
        });
      }
     else if (url === '/capture-fixture' && req.method === 'POST') {
       if (!this.expertMode) {
         res.writeHead(403);
         res.end(JSON.stringify({ error: 'Expert mode is disabled. Set RAG_EXPERT_MODE=true to enable.' }));
         return;
       }
       const ac = new AbortController();
       req.on('close', () => ac.abort());
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
           }, ac.signal);
           if (ac.signal.aborted) return;
           res.writeHead(200);
           res.end(JSON.stringify({ success: true, fixture }, null, 2));
         } catch (err) { if (ac.signal.aborted) return; res.writeHead(400); res.end(JSON.stringify({ success: false, error: err.message })); }
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
  async stop() {
    if (this.server) this.server.close();
    if (this.wsServer) this.wsServer.close();
    if (this.threadManager) {
      try {
        await this.threadManager.close();
      } catch (err) {
        console.warn('Error closing thread manager:', err.message);
      }
    }
    if (this.registry) {
      try {
        await this.registry.close();
      } catch (err) {
        console.warn('Error closing registry:', err.message);
      }
    }
    if (this.bm25Store && typeof this.bm25Store.close === 'function') {
      try {
        await this.bm25Store.close();
      } catch (err) {
        console.warn('Error closing BM25 store:', err.message);
      }
    }
    if (this.graphStore && typeof this.graphStore.close === 'function') {
      try {
        await this.graphStore.close();
      } catch (err) {
        console.warn('Error closing graph store:', err.message);
      }
    }
  }

  // After a full clear/inject the store no longer matches the registry, so wipe
  // it. The next incremental run then treats every file as newly added.
  // @gotcha Calling /clear before /inject-incremental forces a full re-embed of
  //       the entire corpus, defeating the purpose of incremental sync.
  async _resetRegistry() {
    if (!this.registry) return;
    await this.registry.replaceAll({});
  }
}

module.exports = { RAGServer };
