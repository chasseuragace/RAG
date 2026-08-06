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

    subgraph Storage["💾 Storage Layer\n(all stores implement deleteByDocId for incremental sync)"]
        Chroma["ChromaVectorStore\n(dense vectors; deleteByDocId cleans stale chunks on re-ingest)"]
        BM25db["PostgresBM25Store\n(pg_search BM25 / Tantivy — bm25_chunks table;\ndeleteByDocId removes by doc_id column)"]
        Neo4j["Neo4jGraphStore\n(SPO triples; replaceTriplesForDoc is atomic delete+insert;\napoc.path.expand for depth-N traversal)"]
        Postgres["PostgreSQL\n• threads + messages  (conversation history)\n• doc_registry         (incremental sync state)\n• bm25_chunks          (pg_search BM25 index)"]
        Glossary["PostgresAcronymGlossary\n(manually maintained lookup table;\nnot populated by ingestion — requires explicit register() calls)"]
    end

    Reranker["AuthorityAwareReranker  ← shared component\n(real: wraps CrossEncoderReranker + StaticDictionaryScorer;\nmock: wraps MockReranker + StaticDictionaryScorer)\nSame instance injected into both /retrieve and ExecN"]

    subgraph RetrievalA["🔍 /retrieve — NEREnrichedRetrievalPipeline\n(diagnostic endpoint — no graph traversal, no agentic loop)\nSteps 1–3 are independently implemented from UnifiedP but\nuse the same injected collaborators (ner, glossary, filter objects)"]
        direction TB
        QPA["1. glossary.expand(query)"]
        NERA["2. ner.extract(expandedQuery)"]
        FilterA["3. filter.build(entities) → post-filter candidates"]
        HybridA["4. HybridStore: Chroma (dense) + PostgresBM25Store (BM25) + RRF\n   candidateK = topK × 4"]
    end

    subgraph AgenticLoop["🧠 AgenticRetrievalPipeline — primary /ask pipeline\n(Coordinator loop, bounded by maxIterations + latencyBudget)"]
        direction TB
        ColdStart["Cold-start guard\nif obs.results=[] AND obs.rerankedResults=[]\n  → force one ExecN search before the counted loop begins\nelse → enter loop directly at BuildCtx\n(every fresh /ask hits the search branch;\nthe skip-search branch is only exercised by pre-seeded Observations)"]
        BuildCtx["Coordinator._buildContext()\n• add user message to thread (deduped by sessionId+query)\n• ContextWindowManager.buildContext() over thread history\n  + reranked results + graphFacts → contextPayload\n• summarisation fires here when token budget exceeded"]
        JudgeN["Judge.evaluate(observation) → RetrievalAssessment\n• runs AFTER BuildCtx — always sees windowed context\n• RetrievalJudge: heuristic\n• LLMJudge: wraps heuristic, escalates to LLM in gray zone 0.4–0.7"]
        PolicyN["Policy.resolve() → Decision  (action + rationale + evidence)\n• HeuristicRetrievalPolicy (mock) / LLMPolicy (real)\nDecision.action ∈ { answer | stop | search | increase_topk | rewrite_query }"]
        ExecN["RetrievalExecutor.execute(decision)\n• search / increase_topk → UnifiedP.retrieve() then Reranker.rerank()\n• rewrite_query → QueryRewriter → re-search via UnifiedP\n• answer / stop → no-op, loop exits before reaching here\nAttaches expandedQuery + entities + graphFacts to Observation"]
        Rewriter["LLMQueryRewriter (real) / HeuristicQueryRewriter (mock)"]
        UnifiedP["UnifiedRetrievalPipeline.retrieve()\n1. glossary.expand(query)   — same collaborator object as /retrieve\n2. ner.extract(expandedQuery) — same collaborator object as /retrieve\n3. filter.build(entities)     — same collaborator object as /retrieve\n4. Parallel: HybridStore (dense+BM25+RRF) ‖ Neo4jGraphStore.queryByEntities\n5. ContextFuser.fuse → candidates + graphFacts\nReranking is NOT done here — ExecN applies Reranker after retrieve()"]
        TimeoutGuard["Latency budget check\n(checked at end of each iteration, after ExecN completes)\nif remainingBudget < 50ms → force stop regardless of policy\nanswer/stop decisions bypass this — they exit before this check"]
        GenerateN["Coordinator._generateAnswer()\n• inference.generateChat(contextPayload.messages)\n• calls ThreadMgr.addMessage(assistant turn)\n  (same ThreadMgr — same graceful degradation protection)\n• returns answer string (null if inference not wired)"]
    end

    subgraph ContextMgmt["💬 Context & Thread Management"]
        direction TB
        ThreadMgr["PostgresThreadManager\n(graceful degradation: self-disables if Postgres unreachable)\nvia createThreadManager() factory"]
        CtxWindow["ContextWindowManager\n(token-budget windowing over thread messages + RAG context)"]
        Summarizer["MessageSummarizer\n(summarises old messages when token budget exceeded;\ncalled inside ContextWindowManager)"]
        TokCtr["TokenCounter (tiktoken / char-count fallback)"]
    end

    subgraph Inference["🤖 Inference Layer"]
        direction TB
        Novita["NovitaInference (DeepSeek-R1, fetch + AbortSignal)"]
        MockInf["MockInference (deterministic, no API key)"]
    end

    subgraph Evaluation["🧪 Evaluation (EXPERT_MODE only)"]
        GoldenDS["GoldenDataset\ncaptureFixture: runs full agentic loop → saves trace + assessment\n(expensive: hits all storage + inference)"]
        Replay["ReplayHarness\nreplay: calls policy.resolve() with saved assessment+trace\nno storage, no retrieval, no inference — policy-logic only"]
    end

    subgraph Observability["📊 Observability"]
        Events["ServerEvents\n(in-process EventEmitter bus + rolling metrics log;\nfan-out to SSE stream AND WebSocket clients)"]
    end

    %% ── User ↔ API ───────────────────────────────────────────────────────
    UserZone -->|"HTTP request"| Server
    Server --> Health
    WSc -->|"bidirectional commands (same ops as REST)"| Server
    Events -.->|"push events to connected clients"| WSc

    %% ── /clear ───────────────────────────────────────────────────────────
    %% this.store = HybridStore → .clear() internally calls
    %% vectorStore.clear() (Chroma) AND bm25Store.clear() (bm25_chunks).
    %% Thread/conversation history in Postgres is NOT cleared.
    Server -->|"/clear → HybridStore.clear() → Chroma + BM25 wiped"| Chroma
    Server -.->|"/clear (via HybridStore.clear())"| BM25db
    Server -.->|"/clear → graphStore.clear()"| Neo4j
    Server -.->|"/clear → registry.replaceAll({})"| Registry

    %% ── Ingestion (/inject full rebuild; /inject-incremental delta sync) ─
    Server -->|"/inject  /inject-incremental"| Loader
    Loader --> Chunker --> Annotator --> NERTag --> RelExtract --> Embedder
    Embedder -->|"embedBatch → upsert vectors (real: Gemini)"| Chroma
    Embedder -->|"index chunks → bm25_chunks upsert"| BM25db
    RelExtract -->|"storeTriples / replaceTriplesForDoc (atomic)"| Neo4j
    Embedder --> Registry
    Registry -.->|"upsert/delete doc_registry rows"| Postgres
    BM25db -.->|"backed by (same PG instance)"| Postgres
    Registry -.->|"deleteByDocId on changed/removed docs"| Chroma
    Registry -.->|"deleteByDocId on changed/removed docs"| BM25db
    Registry -.->|"deleteByDocId / replaceTriplesForDoc"| Neo4j

    %% ── /retrieve (diagnostic — no agentic loop) ──────────────────────
    Server -->|"/retrieve"| QPA
    QPA --> NERA --> FilterA --> HybridA
    HybridA -.->|"dense query"| Chroma
    HybridA -.->|"keyword query"| BM25db
    QPA -.->|"embed query (real: Gemini)"| HybridA
    QPA -.->|"expand"| Glossary
    HybridA -->|"candidates"| Reranker
    Reranker -->|"ranked results response"| Server

    %% ── /ask — unified agentic pipeline ──────────────────────────────
    %% Every fresh /ask arrives with results=[] so the cold-start
    %% search branch always fires on normal traffic.
    Server -->|"/ask  sessionId  topK"| ColdStart
    ColdStart -->|"results=[] (every fresh /ask)"| ExecN
    ColdStart -->|"results pre-seeded (Replay/test only)"| BuildCtx
    ExecN -->|"Observation.withResults().withEnrichment()"| BuildCtx
    BuildCtx --> JudgeN --> PolicyN

    %% PolicyN exits immediately on terminal decisions (before timeout check)
    PolicyN -->|"answer"| GenerateN
    PolicyN -->|"stop"| Server

    %% PolicyN dispatches search-type decisions through ExecN
    PolicyN -->|"search / increase_topk"| ExecN
    PolicyN -->|"rewrite_query"| Rewriter
    Rewriter --> ExecN

    %% ExecN calls UnifiedP then Reranker, then loops back
    ExecN --> UnifiedP
    UnifiedP -.->|"dense + BM25 + RRF"| Chroma
    UnifiedP -.->|"BM25 keyword"| BM25db
    UnifiedP -.->|"queryByEntities (apoc.path)"| Neo4j
    UnifiedP -.->|"expand query"| Glossary
    UnifiedP -->|"candidates + expandedQuery + entities + graphFacts"| ExecN
    ExecN -->|"Reranker.rerank(query, candidates)"| Reranker
    Reranker -->|"reranked results"| ExecN

    %% After ExecN completes: timeout check, then loop back to BuildCtx
    ExecN --> TimeoutGuard
    TimeoutGuard -->|"budget ok → next iteration"| BuildCtx
    TimeoutGuard -->|"budget exhausted → force stop"| Server

    %% Context & thread management (inside the loop via BuildCtx)
    BuildCtx --> ThreadMgr
    ThreadMgr -.->|"getOrCreate / addMessage (user turn)"| Postgres
    ThreadMgr --> CtxWindow
    CtxWindow --> Summarizer
    CtxWindow --> TokCtr

    %% GenerateN routes through ThreadMgr (same graceful degradation)
    GenerateN -->|"generateChat() (real)"| Novita
    GenerateN -.->|"mock mode"| MockInf
    GenerateN -->|"ThreadMgr.addMessage (assistant turn)"| ThreadMgr
    GenerateN -->|"answer + sources + graphFacts + sessionId + trace"| Server
    Server --> UserZone

    %% ── /capture-fixture + Replay ─────────────────────────────────────
    Server -->|"/capture-fixture (EXPERT_MODE)"| GoldenDS
    GoldenDS -->|"captureFixture: run full agentic loop\n(hits all storage + inference)"| AgenticLoop
    GoldenDS --> Replay
    Replay -->|"harness.run(): policy.resolve(savedAssessment, goal, trace)\nno retrieval, no inference, no storage"| PolicyN

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
    classDef shared fill:#efe,stroke:#393,stroke-width:2px;
    class REST,WSc,SSE external;
    class Chroma,BM25db,Neo4j,Postgres,Glossary storage;
    class ColdStart,BuildCtx,JudgeN,PolicyN,ExecN,TimeoutGuard,GenerateN loop;
    class Reranker shared;
```
