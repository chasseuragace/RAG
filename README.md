```mermaid
flowchart TB
    subgraph UserZone["👤 User / Frontend"]
        REST["REST endpoints:\n/ask (agentic Q&A)\n/inject  /inject-incremental  /clear (corpus management)\n/retrieve (diagnostic: direct hybrid search, no agentic loop)\n/capture-fixture (expert mode: golden dataset capture)"]
        WSc["WebSocket — bidirectional command channel\n(same operations as REST, plus streaming agent events)"]
        SSE["GET /events — server-sent event stream\n(metrics, injection progress, retrieval events, errors)"]
    end

    subgraph API["🔌 API Layer"]
        Server["RAGServer (HTTP + WebSocket + SSE)"]
        Health["/health  /metrics  /stats  — dashboard.html redirect at /"]
    end

    subgraph Ingestion["📥 Ingestion (ConcreteInjectionPipeline)"]
        direction TB
        Loader["DocumentLoader (RealDocumentLoader / MockDocumentLoader)"]
        Chunker["chunkText (paragraph→sentence→word boundary, overlap)"]
        Annotator["MockProvenanceAnnotator → authority_signal on every chunk"]
        NERTag["MockEntityExtractor — NER-tag chunk metadata (opt-in)"]
        RelExtract["MockRelationshipExtractor — extract SPO triples (opt-in)"]
        Embedder["Embedder (GeminiEmbedder real / MockEmbedder mock)"]
        Registry["DocRegistry\n(Postgres doc_registry table — upsert/delete per doc_id;\nJSON file fallback when Postgres unavailable)"]
    end

    subgraph Storage["💾 Storage Layer\n(all stores support deleteByDocId for incremental sync)"]
        Chroma["ChromaVectorStore\n(dense vectors; deleteByDocId cleans stale chunks on re-ingest)"]
        BM25db["PostgresBM25Store\n(pg_search BM25 / Tantivy — bm25_chunks table;\ndeleteByDocId removes by doc_id column)"]
        Neo4j["Neo4jGraphStore\n(SPO triples; replaceTriplesForDoc is atomic delete+insert;\napoc.path.expand for depth-N traversal)"]
        Postgres["PostgreSQL\n• threads + messages  (conversation history)\n• doc_registry         (incremental sync state)\n• bm25_chunks          (pg_search BM25 index)"]
        Glossary["PostgresAcronymGlossary\n(manually maintained lookup table;\nnot populated by ingestion — requires explicit register() calls)"]
    end

    subgraph RetrievalA["🔍 /retrieve — NEREnrichedRetrievalPipeline\n(diagnostic endpoint — same expand→NER→filter→hybrid steps\nas UnifiedP but no graph traversal, no agentic loop;\nuse for direct search testing and benchmarking)"]
        direction TB
        QPA["1. PostgresAcronymGlossary.expand(query)"]
        NERA["2. MockEntityExtractor.extract(expandedQuery)"]
        FilterA["3. MockMetadataFilter.build(entities) → post-filter candidates"]
        HybridA["4. HybridStore: Chroma (dense) + PostgresBM25Store (BM25) + RRF\n   candidateK = topK × 4"]
        RerankerA["5. AuthorityAwareReranker\n   (CrossEncoderReranker real / MockReranker mock)\n   → final ranked results"]
    end

    subgraph AgenticLoop["🧠 AgenticRetrievalPipeline — primary /ask pipeline\n(Coordinator loop, bounded by maxIterations + latencyBudget)"]
        direction TB
        ColdStart["Cold-start guard: if results=[] → force initial search via ExecN\nbefore first judge pass (avoids wasting a judge call on empty context)"]
        BuildCtx["Coordinator._buildContext()\n• add user message to thread (deduped by sessionId+query key)\n• build ContextWindowManager.buildContext() over thread history\n  + reranked results + graphFacts → contextPayload\n• summarisation fires here if token budget exceeded"]
        JudgeN["Judge.evaluate(observation) → RetrievalAssessment\n• evaluates already-windowed context (after BuildCtx)\n• RetrievalJudge: heuristic (always fast)\n• LLMJudge: wraps heuristic, escalates to LLM only in gray zone 0.4–0.7\n  to fill ambiguousTerms / conflictingEvidence / unsupportedClaims"]
        PolicyN["Policy.resolve() → Decision  (action + rationale + evidence)\n• HeuristicRetrievalPolicy (mock)\n• LLMPolicy (real) — falls back to heuristic on inference failure"]
        ExecN["RetrievalExecutor.execute(decision)\n• search / increase_topk → UnifiedP.retrieve() + reranker\n• rewrite_query → LLMQueryRewriter / HeuristicQueryRewriter → re-search\n• answer / stop → exit loop\nAttaches expandedQuery + entities + graphFacts to Observation"]
        Rewriter["LLMQueryRewriter (real) / HeuristicQueryRewriter (mock)"]
        UnifiedP["UnifiedRetrievalPipeline.retrieve()\n1. PostgresAcronymGlossary.expand(query)\n2. MockEntityExtractor.extract(expandedQuery)\n3. MockMetadataFilter.build(entities)\n4. Parallel: HybridStore (dense+BM25+RRF) + Neo4jGraphStore.queryByEntities\n5. MockContextFuser.fuse(graphPaths, vectorChunks) → candidates + graphFacts\nNote: reranking happens in ExecN after retrieve(), not inside UnifiedP"]
        GenerateN["Coordinator._generateAnswer()\n• calls inference.generateChat(contextPayload.messages)\n• persists assistant message to PostgresThreadManager\n• returns answer string (null if inference not wired)"]
    end

    subgraph ContextMgmt["💬 Context & Thread Management"]
        direction TB
        ThreadMgr["PostgresThreadManager\n(graceful degradation: self-disables if Postgres unreachable)\nvia createThreadManager() factory"]
        CtxWindow["ContextWindowManager\n(token-budget windowing over thread messages + RAG context)"]
        Summarizer["MessageSummarizer\n(summarises old messages when token budget exceeded;\ncalled inside ContextWindowManager, not separately)"]
        TokCtr["TokenCounter (tiktoken / char-count fallback)"]
    end

    subgraph Inference["🤖 Inference Layer"]
        direction TB
        Novita["NovitaInference (DeepSeek-R1, fetch + AbortSignal)"]
        MockInf["MockInference (deterministic, no API key)"]
    end

    subgraph Evaluation["🧪 Evaluation (EXPERT_MODE only)"]
        GoldenDS["GoldenDataset\n(captureFixture: runs full agentic loop, saves trace + assessment;\nreplay: re-runs saved fixtures through any policy for regression testing)"]
        Replay["ReplayHarness"]
    end

    subgraph Observability["📊 Observability"]
        Events["ServerEvents\n(in-process EventEmitter bus + rolling metrics log;\nfan-out to both SSE stream and WebSocket clients)"]
    end

    %% ── User ↔ API ───────────────────────────────────────────────────────
    UserZone -->|"HTTP request / WS message"| Server
    Server --> Health
    WSc -->|"bidirectional — same ops as REST"| Server
    Events -.->|"push events"| WSc

    %% ── /clear ───────────────────────────────────────────────────────────
    %% /clear wipes vector store (Chroma), graph store (Neo4j), and
    %% doc_registry. Thread/conversation history is NOT cleared.
    Server -->|"/clear → store.clear() + graphStore.clear() + registry.replaceAll({})"| Chroma
    Server -.->|"/clear"| Neo4j
    Server -.->|"/clear"| Registry

    %% ── Ingestion (/inject full rebuild; /inject-incremental delta sync) ─
    Server -->|"/inject  /inject-incremental"| Loader
    Loader --> Chunker --> Annotator --> NERTag --> RelExtract --> Embedder
    Embedder -->|"embedBatch → store chunks (real: Gemini embed)"| Chroma
    Embedder -->|"index chunks (bm25_chunks upsert)"| BM25db
    RelExtract -->|"storeTriples / replaceTriplesForDoc (atomic)"| Neo4j
    Embedder --> Registry
    Registry -.->|"upsert/delete doc_registry rows"| Postgres
    BM25db -.->|"backed by (same PG instance)"| Postgres
    %% Incremental sync: deleteByDocId fires on changed/removed docs before re-embed
    Registry -.->|"deleteByDocId on changed/removed docs"| Chroma
    Registry -.->|"deleteByDocId on changed/removed docs"| BM25db
    Registry -.->|"deleteByDocId on changed/removed docs"| Neo4j

    %% ── /retrieve (diagnostic — no agentic loop) ──────────────────────
    Server -->|"/retrieve"| QPA
    QPA --> NERA --> FilterA --> HybridA --> RerankerA
    HybridA -.->|"dense query"| Chroma
    HybridA -.->|"keyword query"| BM25db
    QPA -.->|"embed query (real: Gemini)"| HybridA
    QPA -.->|"lookup"| Glossary
    RerankerA -->|"ranked results response"| Server

    %% ── /ask — unified agentic pipeline ──────────────────────────────
    Server -->|"/ask sessionId topK"| ColdStart
    ColdStart -->|"initial search if results=[]"| ExecN
    ColdStart --> BuildCtx
    BuildCtx --> JudgeN --> PolicyN
    PolicyN -->|"rewrite_query"| Rewriter
    Rewriter --> ExecN
    PolicyN -->|"search / increase_topk"| ExecN
    ExecN --> UnifiedP
    UnifiedP -.->|"dense + BM25 + RRF"| Chroma
    UnifiedP -.->|"BM25 keyword"| BM25db
    UnifiedP -.->|"queryByEntities (apoc.path)"| Neo4j
    UnifiedP -.->|"expand query"| Glossary
    UnifiedP -->|"candidates + expandedQuery + entities + graphFacts"| ExecN
    ExecN -->|"reranker.rerank(query, candidates)"| ExecN
    ExecN -->|"Observation.withResults().withEnrichment() → next iteration"| BuildCtx
    BuildCtx --> ThreadMgr
    ThreadMgr -.->|"getOrCreate / addMessage (user turn)"| Postgres
    ThreadMgr --> CtxWindow
    CtxWindow --> Summarizer
    CtxWindow --> TokCtr
    PolicyN -->|"answer"| GenerateN
    GenerateN -->|"generateChat() (real)"| Novita
    GenerateN -.->|"mock mode"| MockInf
    GenerateN -.->|"addMessage (assistant turn)"| Postgres
    GenerateN -->|"answer + sources + graphFacts + sessionId + trace"| Server
    PolicyN -->|"stop"| Server
    Server --> UserZone

    %% ── /capture-fixture ─────────────────────────────────────────────
    Server -->|"/capture-fixture (EXPERT_MODE)"| GoldenDS
    GoldenDS -->|"captureFixture: run full agentic loop"| AgenticLoop
    GoldenDS --> Replay

    %% ── SSE + observability fan-in ───────────────────────────────────
    Events -.->|"stream"| SSE
    Ingestion --> Events
    RetrievalA --> Events
    AgenticLoop --> Events
    ContextMgmt --> Events
    Inference --> Events

    classDef external fill:#f9f,stroke:#333,stroke-width:2px;
    classDef storage fill:#bbf,stroke:#333;
    classDef loop fill:#ffd,stroke:#333,stroke-width:2px;
    class REST,WSc,SSE external;
    class Chroma,BM25db,Neo4j,Postgres,Glossary storage;
    class ColdStart,BuildCtx,JudgeN,PolicyN,ExecN,GenerateN loop;
```
