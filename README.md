# RAG System — Production‑Ready with WebSocket, Chunking & Conversation History

## Overview

A modular RAG (Retrieval‑Augmented Generation) implementation with **real integrations** (Gemini embeddings, Chroma vector DB, Novita DeepSeek inference), **WebSocket telemetry**, **automatic chunking** of large Markdown files, **incremental (differential) sync** so only changed files are re‑embedded, and **conversation memory** per session.

The system features a **Planner–Executor–Judge agentic retrieval loop** with bounded iteration, explicit reasoning, and now **full context awareness** — the agentic loop sees conversation history and retrieved documents via a `ContextWindowManager` and `PostgresThreadManager`.

```
✅ Real mode: Gemini Embeddings + Chroma + Novita DeepSeek
✅ Mock mode for testing (no external APIs)
✅ WebSocket & SSE real‑time events
✅ Full inject (clear + chunk + embed + store) — escape hatch
✅ Incremental sync — hash‑diff, re‑embed only the delta, no retrieval blackout
✅ Conversation history (Postgres‑backed thread manager, file‑based fallback)
✅ REST API + WebSocket commands
✅ Hybrid search (vector + BM25 + RRF fusion)
✅ Reranking (cross‑encoder / mock heuristic / authority‑aware)
✅ Agentic retrieval (Planner–Executor–Judge architecture, bounded iteration)
✅ Context‑aware agentic loop (thread history + RAG context in judge/policy prompts)
✅ Graceful degradation (Postgres unavailable → in‑memory fallback)
✅ AbortController cancellation (client disconnect frees resources)
```

---

## 🏗️ Architecture

### System Overview

The RAG server is composed of five major subsystems, each with internal components:

```
┌─────────────────────────────────────────────────────────────────────┐
│                         RAGServer                                   │
│  rag-server.js  →  HTTP + WebSocket + SSE                          │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  INJECTION SUBSYSTEM                                        │   │
│  │  ConcreteInjectionPipeline                                  │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────┐              │   │
│  │  │ Loaders  │→│ Chunker  │→│  NER + Rel   │→│ Embedder   │→│  │
│  │  │(mock/real)│ │(chunkText)│ │  Extractor   │ │(Gemini/    │  │
│  │  └──────────┘  └──────────┘  └──────────────┘ │ Mock)      │  │
│  │                                         └──────────────┘  │  │
│  │                                    ┌──────────────────────┘  │
│  │                                    ▼                          │
│  │                           ┌──────────────────┐               │
│  │                           │  Vector Store     │               │
│  │                           │  (Chroma/Mock)    │               │
│  │                           │  + BM25 (inline)  │               │
│  │                           │  + Graph (Neo4j)  │               │
│  │                           │  + Hybrid (RRF)   │               │
│  │                           └──────────────────┘               │
│  │                                    │                          │
│  │                                    ▼                          │
│  │                           ┌──────────────────┐               │
│  │                           │  DocRegistry      │               │
│  │                           │  (doc-registry.json)            │
│  │                           └──────────────────────────────────┘
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  RETRIEVAL SUBSYSTEM                                        │   │
│  │  NEREnrichedRetrievalPipeline                               │   │
│  │  ┌─────────────┐  ┌────────────┐  ┌─────────────────────┐ │   │
│  │  │ Acronym      │→│ NER        │→│ Metadata Filter     │ │   │
│  │  │ Glossary     │ │ Extractor  │ │ (entity‑based post‑  │ │   │
│  │  │ (expansion)  │ │ (DRUG,     │ │  filter on candidates)│ │   │
│  │  └─────────────┘  │ DISEASE,   │ └─────────────────────┘ │   │
│  │                   │ BIOMARKER) │                          │   │
│  │                   └────────────┘                          │   │
│  │                          │                                │   │
│  │                          ▼                                │   │
│  │  ┌─────────────────────────────────────────────────────┐  │   │
│  │  │ HybridStore (vector + BM25 + RRF fusion)          │  │   │
│  │  │ → candidateK = topK × 4                            │  │   │
│  │  └─────────────────────────────────────────────────────┘  │   │
│  │                          │                                │   │
│  │                          ▼                                │   │
│  │  ┌─────────────────────────────────────────────────────┐  │   │
│  │  │ Reranker (AuthorityAwareReranker)                  │  │   │
│  │  │ semanticScore (cross‑encoder) + authorityScore     │  │   │
│  │  └─────────────────────────────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  GRAPH RAG SUBSYSTEM                                        │   │
│  │  GraphRAGPipeline                                           │   │
│  │  ┌──────────────┐  ┌──────────────────┐  ┌───────────────┐ │   │
│  │  │ Entity       │→│ Graph Traversal  │→│ Context Fusion │ │   │
│  │  │ Extraction   │ │ (Neo4j apoc.path)│ │ (confidence‑   │ │   │
│  │  │ (NER on query)│ │ graphDepth=1..2  │ │  tagged facts) │ │   │
│  │  └──────────────┘  └──────────────────┘  └───────┬───────┘ │   │
│  │                                                   │          │   │
│  │                                                   ▼          │   │
│  │  ┌─────────────────────────────────────────────────────┐  │   │
│  │  │ AuthorityAwareReranker (graph confidence + vector) │  │   │
│  │  └─────────────────────────────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  UNIFIED PIPELINE                                           │   │
│  │  UnifiedRetrievalPipeline                                   │   │
│  │  ┌─────────────────────────────────────────────────────┐    │   │
│  │  │ Runs Graph RAG + Hybrid Retrieval in parallel,     │    │   │
│  │  │ fuses results, reranks → single ranked result set  │    │   │
│  │  └─────────────────────────────────────────────────────┘    │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  AGENTIC LOOP (AgenticRetrievalPipeline → Coordinator)     │   │
│  │                                                             │   │
│  │  ┌─────────────────────────────────────────────────────┐    │   │
│  │  │  Coordinator.run(observation, goal)                  │    │   │
│  │  │                                                     │    │   │
│  │  │  ┌─────────────────────────────────────────────┐   │    │   │
│  │  │  │ 1. _buildContext(obs)                        │   │    │   │
│  │  │  │    ├─ PostgresThreadManager.getOrCreate()    │   │    │   │
│  │  │  │    ├─ Add user query as message             │   │    │   │
│  │  │  │    ├─ Map rerankedResults → RAG context docs│   │    │   │
│  │  │  │    ├─ ContextWindowManager.buildContext()    │   │    │   │
│  │  │  │    │   (system prompt + RAG + recent msgs)  │   │    │   │
│  │  │  │    └─ Attach contextPayload to observation   │   │    │   │
│  │  │  └─────────────────────────────────────────────┘   │    │   │
│  │  │                                                     │    │   │
│  │  │  ┌─────────────────────────────────────────────┐   │    │   │
│  │  │  │ 2. judge.evaluate(obs) → RetrievalAssessment│   │    │   │
│  │  │  │    quality, completeness, consistency,       │   │    │   │
│  │  │  │    sourceDiversity, missingEvidence          │   │    │   │
│  │  │  └─────────────────────────────────────────────┘   │    │   │
│  │  │                                                     │    │   │
│  │  │  ┌─────────────────────────────────────────────┐   │    │   │
│  │  │  │ 3. policy.resolve(assessment, goal, trace, obs)│ │    │   │
│  │  │  │    → Decision { action, rationale, evidence } │   │    │   │
│  │  │  │    Actions: search | increase_topk |          │   │    │   │
│  │  │  │              rewrite_query | answer | stop     │   │    │   │
│  │  │  └─────────────────────────────────────────────┘   │    │   │
│  │  │                                                     │    │   │
│  │  │  ┌─────────────────────────────────────────────┐   │    │   │
│  │  │  │ 4. If answer/stop → return                   │   │    │   │
│  │  │  │    Otherwise → executor.execute(decision, obs)│   │    │   │
│  │  │  │    → Observation.withResults(reranked)       │   │    │   │
│  │  │  │    → Loop (bounded by maxIterations)         │   │    │   │
│  │  │  └─────────────────────────────────────────────┘   │    │   │
│  │  └─────────────────────────────────────────────────────┘    │   │
│  │                                                             │   │
│  │  Policies (all extend RetrievalPolicy):                     │   │
│  │  ┌─────────────────┐ ┌──────────┐ ┌───────────┐ ┌──────┐ │   │
│  │  │ HeuristicPolicy  │ │ LLMPolicy│ │ Balanced  │ │Aggr- │ │   │
│  │  │ (rule‑based)     │ │(LLM‑driven)│ │(prod default)│ │sive│ │   │
│  │  └─────────────────┘ └──────────┘ └───────────┘ └──────┘ │   │
│  │                                                             │   │
│  │  Judges:                                                   │   │
│  │  ┌─────────────────┐ ┌─────────────────────────────────┐ │   │
│  │  │ RetrievalJudge   │ │ LLMJudge                        │ │   │
│  │  │ (heuristic score)│ │ (LLM evaluates evidence)        │ │   │
│  │  └─────────────────┘ └─────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  CONTEXT & THREAD MANAGEMENT                                │   │
│  │                                                             │   │
│  │  ┌─────────────────────────────────────────────────────┐    │   │
│  │  │  PostgresThreadManager                              │    │   │
│  │  │  ├─ getOrCreate(sessionId) → Thread                │    │   │
│  │  │  ├─ addMessage(sessionId, Message)                  │    │   │
│  │  │  ├─ getThread(sessionId) → Thread with history     │    │   │
│  │  │  ├─ updateSummary(sessionId, summary, index)       │    │   │
│  │  │  ├─ listThreads(filters) → [{ sessionId, ... }]    │    │   │
│  │  │  └─ close() → pool.end()                            │    │   │
│  │  │                                                     │    │   │
│  │  │  Graceful degradation when Postgres unavailable:    │    │   │
│  │  │  ├─ _init() catches error → sets _disabled flag   │    │   │
│  │  │  ├─ getOrCreate() → in‑memory Thread (empty)       │    │   │
│  │  │  ├─ addMessage() → no‑op                            │    │   │
│  │  │  └─ listThreads() → returns []                      │    │   │
│  │  └─────────────────────────────────────────────────────┘    │   │
│  │                                                             │   │
│  │  ┌─────────────────────────────────────────────────────┐    │   │
│  │  │  ContextWindowManager                               │    │   │
│  │  │  ├─ Token counting (tiktoken → char/4 fallback)    │    │   │
│  │  │  ├─ Budget: modelContextWindow - (system + RAG +   │    │   │
│  │  │  │         responseTokens) = messageBudget          │    │   │
│  │  │  ├─ If messageBudget ≤ 0 → warn, floor to 4000    │    │   │
│  │  │  ├─ Backward‑fit messages within budget             │    │   │
│  │  │  └─ Summarize older messages (MessageSummarizer)   │    │   │
│  │  └─────────────────────────────────────────────────────┘    │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  INFERENCE SUBSYSTEM                                        │   │
│  │  ┌────────────────────┐  ┌──────────────────────────────┐  │   │
│  │  │ NovitaInference    │  │ MockInference                 │  │   │
│  │  │ (real DeepSeek)    │  │ (deterministic, no API key)   │  │   │
│  │  │ → fetch() with     │  │ → returns "[Mock] ..."        │  │   │
│  │  │   AbortSignal      │  │                               │  │   │
│  │  └────────────────────┘  └──────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  OBSERVABILITY & TELEMETRY                                  │   │
│  │  ┌─────────────────────────────────────────────────────┐    │   │
│  │  │  ServerEvents (shared event bus + metrics)          │    │   │
│  │  │  Events: injection:*, retrieval:*, agentic:*,       │    │   │
│  │  │          rerank:*, hybrid:search, bm25:search,      │    │   │
│  │  │          error, client:connected                     │    │   │
│  │  └─────────────────────────────────────────────────────┘    │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  EVALUATION SUBSYSTEM                                       │   │
│  │  ┌────────────────────┐  ┌──────────────────────────────┐  │   │
│  │  │ GoldenDataset      │  │ ReplayHarness                 │  │   │
│  │  │ (fixture storage +  │  │ (offline policy evaluation    │  │   │
│  │  │  captureFixture)    │  │  passes observation to        │  │   │
│  │  │                     │  │  policy.resolve)              │  │   │
│  │  └────────────────────┘  └──────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  RELIABILITY                                                  │   │
│  │  ├─ AbortController per request (client disconnect → cancel)│   │
│  │  ├─ SIGTERM/SIGINT → server.stop() (closes all resources)  │   │
│  │  └─ PostgresThreadManager.close() on shutdown              │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### Main Request Flow (`/ask`)

```
POST /ask  { query, sessionId?, topK? }
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│  RAGServer.handleRequest()                               │
│  ├─ Parse body, extract query + sessionId + topK        │
│  ├─ Create AbortController, wire to req.close           │
│  └─ Call AgenticRetrievalPipeline.run(query, topK,      │
│       sessionId, abortSignal)                            │
└────────────────────────┬────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────┐
│  AgenticRetrievalPipeline.run()                          │
│  ├─ Generate/persist sessionId                           │
│  ├─ Create Observation.create(query, topK, goal, sid)   │
│  └─ Call coordinator.run(observation, goal)              │
└────────────────────────┬────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────┐
│  Coordinator.run(observation, goal)                      │
│  For each iteration (up to maxIterations):              │
│  ├─ _buildContext(obs)                                   │
│  │  ├─ threadManager.getOrCreate(sessionId)             │
│  │  ├─ Add user query to thread (iteration 0)           │
│  │  ├─ Map results → RAG context docs                    │
│  │  └─ contextWindowManager.buildContext(                │
│  │       thread, systemPrompt, ragContext, maxTokens)   │
│  ├─ judge.evaluate(obs) → RetrievalAssessment            │
│  ├─ policy.resolve(assessment, goal, trace, obs)        │
│  │  → Decision { action, rationale, evidence }          │
│  ├─ If answer/stop → return result                       │
│  └─ executor.execute(decision, obs) → new Observation   │
│       with results + incremented iteration               │
│                                                         │
│  Final pass (if max iterations exhausted):              │
│  ├─ judge.evaluate(obs) → finalAssessment                │
│  ├─ policy.resolve(finalAssessment, goal, trace, obs)   │
│  └─ Return { assessment, decision, trace, finalAction } │
└────────────────────────┬────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────┐
│  If decision.action === 'answer':                        │
│  ├─ inference.generateChat(contextPayload.messages)     │
│  │  (with AbortSignal from client disconnect)           │
│  ├─ Store assistant answer in thread                     │
│  └─ Return { answer, sources, sessionId, ... }          │
└─────────────────────────────────────────────────────────┘
```

### Incremental Sync Flow (`/inject-incremental`)

```
POST /inject-incremental
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│  ConcreteInjectionPipeline.runIncremental()              │
│  ├─ Load all .md files from ./input                      │
│  ├─ Diff each file against doc-registry.json by SHA256  │
│  ├─ Classify: added / changed / unchanged / removed      │
│  ├─ For removed files: delete chunks + registry entry    │
│  ├─ For changed files: delete old chunks, re‑embed      │
│  ├─ For added files: chunk + embed + store               │
│  ├─ For unchanged files: skip entirely                   │
│  └─ Update doc-registry.json to mirror current state     │
└─────────────────────────────────────────────────────────┘
```

### Key Design Principles

1. **Bounded agentic loop** — The Coordinator iterates at most `maxIterations` times (default 2). The policy decides when to stop.
2. **Separation of concerns** — Judge evaluates evidence, Policy decides the action, Executor performs retrieval. None crosses into the other's domain.
3. **Graceful degradation** — If Postgres is unavailable, thread management falls back to in‑memory structures. The system keeps running without persistent conversation history.
4. **Resource cleanup** — Every expensive operation accepts an `AbortSignal`. Client disconnects cancel in‑flight work at every async boundary.
5. **Incremental sync** — The registry is the source of truth. Only changed files are re‑embedded. Retrieval never goes dark during updates.

### 4. Unified Pipeline — Combining All Paths

The unified pipeline runs graph traversal and hybrid search in parallel, then fuses the results:

```
Query
    │
    ├──► GraphRAGPipeline (graph traversal + context fusion)
    │       → graphFacts, graphPaths, confidence scores
    │
    ├──► NEREnrichedRetrievalPipeline (NER + hybrid + rerank)
    │       → vector search results with entity filtering
    │
    ├──► ContextFusion (merge graph + vector results)
    │       → Combined result set with confidence tags
    │
    └──► AuthorityAwareReranker (rerank fused results)
            → Final ranked results
```

### 5. Agentic Retrieval Loop (Coordinator)

The `/ask` endpoint uses a bounded Planner–Executor–Judge architecture:

```
Observation { query, sessionId, results, rerankedResults, previousActions, iteration, contextPayload }
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│  Coordinator.run(observation, goal)                          │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 1. _buildContext(obs)                                │   │
│  │    ├─ Fetch or create thread via PostgresThreadManager│   │
│  │    ├─ Add user query as message to thread          │   │
│  │    ├─ Map rerankedResults → RAG context docs       │   │
│  │    ├─ Call ContextWindowManager.buildContext()        │   │
│  │    │   (system prompt + RAG context + recent msgs) │   │
│  │    └─ Attach contextPayload to observation           │   │
│  └─────────────────────────────────────────────────────┘   │
│           │                                                   │
│           ▼                                                   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 2. judge.evaluate(obs) → RetrievalAssessment         │   │
│  │    quality (relevance), completeness (term coverage),│   │
│  │    consistency (score variance), sourceDiversity,    │   │
│  │    missingEvidence { missingConcepts, ambiguousTerms,│   │
│  │      conflictingEvidence, unsupportedClaims }        │   │
│  └─────────────────────────────────────────────────────┘   │
│           │                                                   │
│           ▼                                                   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 3. policy.resolve(assessment, goal, trace, obs)      │   │
│  │    → Decision { action, rationale, evidence }        │   │
│  │    Actions: search | increase_topk | rewrite_query  │   │
│  │              | answer | stop                          │   │
│  └─────────────────────────────────────────────────────┘   │
│           │                                                   │
│           ▼                                                   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 4. If answer/stop → return result                    │   │
│  │    Otherwise → executor.execute(decision, obs)       │   │
│  │    → Observation.withResults(reranked)               │   │
│  │    → Loop (bounded by maxIterations)                  │   │
│  └─────────────────────────────────────────────────────┘   │
│           │                                                   │
│           ▼                                                   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 5. If answer → inference.generateChat()              │   │
│  │    (in /ask HTTP handler, after agentic loop)        │   │
│  │    → Final answer stored in thread + returned       │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 6. Context‑Aware Chat Layer

The system maintains per‑session conversation threads and builds optimized context windows for LLM calls:

```
┌─────────────────────────────────────────────────────────────┐
│  ContextWindowManager.buildContext(thread, systemPrompt,      │
│                                   ragContext, responseTokens)│
│                                                              │
│  1. Count tokens: systemPrompt + RAG context + response │
│  2. Compute messageBudget = modelContextWindow - used       │
│  3. If messageBudget <= 0 → warn, use 4000‑token floor     │
│  4. Backward‑fit recent messages within budget              │
│  5. Optionally summarize older messages (MessageSummarizer) │
│  6. Return: { messages: [...], totalTokens, summaryUsed }   │
└─────────────────────────────────────────────────────────────┘
```

### 7. Thread & Session Management

```
┌─────────────────────────────────────────────────────────────┐
│  PostgresThreadManager (primary)                             │
│  ├─ getOrCreate(sessionId) → Thread with messages          │
│  ├─ addMessage(sessionId, Message)                           │
│  ├─ getThread(sessionId) → Thread with full history        │
│  ├─ updateSummary(sessionId, summary, lastSummarizedIndex) │
│  ├─ listThreads(filters) → [{ sessionId, summary, ... }]   │
│  └─ close() → pool.end()                                     │
│                                                              │
│  Graceful degradation: if Postgres is unavailable:          │
│  ├─ _init() catches connection error → sets _disabled flag │
│  ├─ getOrCreate() → returns in‑memory Thread (empty)       │
│  ├─ addMessage() → no‑op                                     │
│  └─ listThreads() → returns []                                │
└─────────────────────────────────────────────────────────────┘
```

### 8. AbortController Cancellation

Every expensive operation supports cancellation via `AbortSignal`:

```
Client disconnects (ws close / req close)
    │
    ▼
AbortController.abort()
    │
    ▼
Signal propagated through full async chain:
  AgenticRetrievalPipeline.run()
    → GraphRAGPipeline.run()
    → NEREnrichedRetrievalPipeline.run()
    → UnifiedRetrievalPipeline.retrieve()
    → inference.generateChat()  (passed to fetch() signal option)
    → threadManager.getOrCreate/addMessage/getThread()
    → contextWindowManager.buildContext()
    → injectionPipeline.run() / runIncremental()
    → GoldenDataset.captureFixture()
    │
    ▼
Each layer checks signal.throwIfAborted() at entry points
    │
    ▼
AbortError caught silently → no response sent → resources freed
```

---

## 📂 Source Layout

```
rag-server.js                           # CLI entry: parse argv → dispatch
src/
├── api/
│   └── server.js                       # RAGServer: HTTP + WebSocket + SSE
├── agentic/
│   ├── coordinator.js                  # Coordinator: runs the Planner–Executor–Judge loop
│   ├── assessment.js                   # RetrievalAssessment (quality, completeness, consistency, diversity)
│   ├── decision.js                     # Decision { action, rationale, evidence, priority }
│   ├── executor.js                     # RetrievalExecutor: hybrid search + rerank
│   ├── judge.js                        # RetrievalJudge (heuristic) + LLMJudge (LLM‑backed)
│   ├── observation.js                  # Observation: shared state (query, results, sessionId, contextPayload)
│   ├── pipeline.js                     # AgenticRetrievalPipeline: wires Coordinator + strategy
│   ├── policy.js                       # RetrievalPolicy abstract base
│   ├── query-rewriter.js              # LLMQueryRewriter (query expansion)
│   ├── trace.js                        # Trace + TraceEvent (event log for observability)
│   ├── strategies/
│   │   └── heuristic.js                # HeuristicRetrievalStrategy (composes planner+executor+judge)
│   └── policies/
│       ├── heuristic.js                # HeuristicRetrievalPolicy (rule‑based)
│       ├── llm.js                      # LLMPolicy (LLM‑driven decision making)
│       ├── balanced.js                 # BalancedPolicy (production default)
│       ├── aggressive.js               # AggressiveRetrievalPolicy (max recall)
│       └── lowlatency.js               # LowLatencyRetrievalPolicy (speed over quality)
├── inference/
│   ├── mock.js                         # MockInference (deterministic, no API key)
│   └── novita.js                       # NovitaInference (real DeepSeek via Novita API)
├── ingestion/
│   ├── pipeline.js                     # ConcreteInjectionPipeline + runIncremental()
│   ├── registry.js                     # DocRegistry + hashContent (diff classifier)
│   ├── authority/
│   │   └── mock-annotator.js           # MockProvenanceAnnotator (authority_signal)
│   ├── graph/
│   │   ├── store.js                    # Neo4jGraphStore (graph triples + relationships)
│   │   ├── mock-extractor.js           # MockEntityExtractor
│   │   └── mock-store.js               # MockGraphStore
│   └── loaders/
│       ├── mock.js                     # MockDocumentLoader
│       └── real.js                     # RealDocumentLoader
├── retrieval/
│   ├── pipeline.js                     # NEREnrichedRetrievalPipeline (NER + hybrid + rerank)
│   ├── graph-rag.js                    # GraphRAGPipeline (graph traversal + vector + fusion)
│   ├── unified-pipeline.js             # UnifiedRetrievalPipeline (graph + hybrid + NER)
│   ├── authority/
│   │   └── mock-scorer.js              # StaticDictionaryScorer (baseline scoring)
│   ├── graph/
│   │   └── mock-fuser.js               # MockContextFuser (confidence‑tagged fact fusion)
│   ├── ner/
│   │   ├── glossary.js                 # AcronymGlossary (acronym expansion)
│   │   ├── mock-extractor.js           # MockEntityExtractor (DRUG, DISEASE, BIOMARKER)
│   │   ├── mock-filter.js              # MockMetadataFilter (post‑filter by entity)
│   │   └── mock-glossary.js            # MockAcronymGlossary
│   ├── embedders/
│   │   ├── mock.js                     # MockEmbedder (deterministic, content‑correlated)
│   │   └── gemini.js                   # GeminiEmbedder (real embeddings)
│   ├── stores/
│   │   ├── mock.js                     # MockVectorStore (in‑memory)
│   │   ├── chroma.js                   # ChromaVectorStore (persistent vector DB)
│   │   ├── bm25.js                     # BM25Store (inline keyword index)
│   │   └── hybrid.js                   # HybridStore (vector + BM25 + RRF fusion)
│   └── rerankers/
│       ├── mock.js                     # MockReranker (word‑overlap heuristic)
│       ├── real.js                     # CrossEncoderReranker (semantic reranking)
│       └── authority-aware.js          # AuthorityAwareReranker (scorer + semantic)
├── session/
│   ├── postgres-thread-manager.js      # PostgresThreadManager (primary, with graceful degradation)
│   ├── thread-manager-factory.js       # createThreadManager() factory
│   └── conversation.js                 # ConversationStore (file‑based fallback)
├── shared/
│   ├── chunker.js                      # chunkText (paragraph/sentence‑aware splitting)
│   ├── config.js                       # Environment constants (MODEL_CONTEXT_WINDOW, etc.)
│   ├── events.js                       # ServerEvents bus + metrics
│   ├── interfaces.js                   # Thread, Message, Observation, RetrievalPolicy, Decision
│   ├── token-counter.js                # TokenCounter (tiktoken fallback → char/4)
│   ├── message-summarizer.js           # MessageSummarizer (compresses old messages)
│   └── context-window-manager.js       # ContextWindowManager (budget‑aware message fitting)
└── evaluation/
    ├── golden-dataset.js               # GoldenDataset fixture management
    ├── replay.js                       # ReplayHarness offline policy evaluation
    └── capture.js                      # captureFixture helper
tests/
├── runner.js                           # TestRunner + Assert
├── mock.test.js                        # --test (chunking, embedding, store basics)
├── advanced.test.js                    # --advanced-test (reranking, agentic, hybrid, Coordinator)
├── context.test.js                     # --context-test (TokenCounter, ContextWindowManager, Thread/Message, Postgres graceful degradation)
├── phase2-3.test.js                    # --phase23-test (policies, rationale, evidence)
├── phase5.test.js                      # --phase5-test (LLMPolicy, GoldenDataset, ReplayHarness)
├── unified.test.js                     # --unified-test (architecture validation)
├── real.test.js                        # --real-test (live integration)
├── delta.test.js                       # --delta-test (incremental sync)
└── chroma.test.js                      # --chroma-test (Chroma delete‑by‑doc‑id)
```

---

## 🔑 Key Data Structures

### Observation
Shared state that flows through the agentic loop:
```
{
  query,           // current search query
  sessionId,       // thread/session identifier
  results,         // raw retrieval results
  rerankedResults, // reranked results (primary source for context)
  previousActions, // [{ type, query, resultCount, topScore, iteration }]
  iteration,       // current loop iteration (0‑indexed)
  topScore,        // highest relevance score
  assessment,      // RetrievalAssessment from judge
  decision,        // Decision from policy
  thread,          // Thread object with conversation history
  contextPayload,  // { messages, totalTokens, summaryUsed, recentMessageCount }
  goal             // { objective, latencyBudget, maxIterations, minimumQuality }
}
```

### Thread
Per‑session conversation history:
```
{
  id,                // sessionId
  messages: [        // ordered conversation
    { role: 'user'|'assistant'|'system', content, metadata, timestamp }
  ],
  summary,           // compressed summary of older messages
  lastSummarizedIndex // index up to which messages have been summarized
}
```

### Decision
Action chosen by the policy:
```
{
  action: 'search' | 'increase_topk' | 'rewrite_query' | 'answer' | 'stop',
  rationale: 'string explaining why',
  evidence: { ... },
  priority: 'normal' | 'high' | 'low'
}
```

---

## 📡 Endpoints & Commands

### REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Server info, configuration |
| GET | `/health` | Health check, mode, connected clients |
| GET | `/metrics` | Real‑time server metrics |
| GET | `/stats` | Vector store statistics |
| GET | `/events` | SSE real‑time event stream |
| POST | `/inject` | Full rebuild: clear + chunk + NER tag + embed + store |
| POST | `/inject-incremental` | Differential sync: hash‑diff, re‑embed only delta |
| POST | `/clear` | Clear vector store + graph store + registry |
| POST | `/retrieve` | Hybrid retrieval (vector + BM25 + RRF) |
| POST | `/ask` | Agentic RAG with conversation history |
| POST | `/capture-fixture` | Capture a golden test fixture (expert mode) |

### WebSocket Commands

| Command | Payload | Response |
|---------|---------|----------|
| `request:metrics` | `{"type":"request:metrics"}` | `{"type":"metrics","data":{...}}` |
| `request:event-log` | `{"type":"request:event-log"}` | `{"type":"event-log","data":[...]}` |
| `request:stats` | `{"type":"request:stats"}` | `{"type":"stats","data":{...}}` |
| `request:inject` | `{"type":"request:inject"}` | `{"type":"inject:result","data":{...}}` |
| `request:inject-incremental` | `{"type":"request:inject-incremental"}` | `{"type":"inject:result","data":{...}}` |
| `request:clear` | `{"type":"request:clear"}` | `{"type":"clear:result","data":{...}}` |
| `request:retrieve` | `{"type":"request:retrieve","query":"...","topK":5}` | `{"type":"retrieve:result","data":{...}}` |
| `request:ask` | `{"type":"request:ask","query":"...","sessionId":"...","topK":3}` | `{"type":"ask:result","data":{...}}` |
| `request:capture-fixture` | `{...fixture config...}` | `{"type":"capture-fixture:result","data":{...}}` |
| `ping` | `{"type":"ping"}` | `{"type":"pong","timestamp":...}` |

---

## 🧪 Testing

| Command | Description |
|---------|-------------|
| `node rag-server.js --test` | Mock unit tests (chunking, embedding, store, registry) |
| `node rag-server.js --advanced-test` | Agentic loop, reranking, hybrid search, Coordinator |
| `node rag-server.js --context-test` | TokenCounter, ContextWindowManager, Thread/Message, Postgres graceful degradation |
| `node rag-server.js --phase23-test` | Policy branches, rationale, evidence |
| `node rag-server.js --phase5-test` | LLMPolicy, GoldenDataset, ReplayHarness |
| `node rag-server.js --unified-test` | Architecture validation (mock‑only) |
| `node rag-server.js --real-test` | Live integration (requires Chroma + APIs) |
| `node rag-server.js --delta-test` | Incremental sync edge cases |
| `node rag-server.js --chroma-test` | Chroma delete‑by‑doc‑id (requires running Chroma) |

All 97 tests pass in mock mode with no external dependencies.

---

## ⚙️ Configuration

| Environment Variable | Default | Description |
|----------------------|---------|-------------|
| `RAG_INPUT_DIR` | `./input` | Folder containing `.md` files |
| `RAG_CHUNK_SIZE` | `1000` | Max characters per chunk |
| `RAG_CHUNK_OVERLAP` | `200` | Overlap between chunks |
| `RAG_REGISTRY_FILE` | `./data/doc-registry.json` | Incremental sync registry |
| `PG_CONNECTION_STRING` | `postgresql://postgres:postgres@localhost:5432/rag` | Postgres connection |
| `NEO4J_URI` | `bolt://localhost:7687` | Neo4j graph store |
| `NEO4J_USER` | `neo4j` | Neo4j username |
| `NEO4J_PASSWORD` | `neo4j` | Neo4j password |
| `MODEL_CONTEXT_WINDOW` | `128000` | LLM context window size |
| `SYSTEM_TOKEN_BUDGET` | `500` | Tokens reserved for system prompt |
| `RESPONSE_MAX_TOKENS` | `1000` | Max tokens for LLM response |
| `MIN_MESSAGES_TO_KEEP` | `3` | Minimum messages to retain in context |
| `BASE_SYSTEM_PROMPT` | `'You are a helpful retrieval assistant.'` | System prompt for LLM calls |
| `GEMINI_API_KEY` | — | Google Gemini API key (real mode) |
| `AI_STUDIO_API_KEY` | — | Alternative Gemini key |
| `NOVITA_API_KEY` | — | Novita AI API key (real mode) |
| `RAG_EXPERT_MODE` | `false` | Enable `/capture-fixture` endpoint |
| `PORT` / `--port` | `3000` | HTTP/WebSocket server port |

---

## 🛡️ Reliability Features

### Graceful Degradation
If Postgres is unavailable at startup, `PostgresThreadManager` sets an internal `_disabled` flag. All thread operations become no‑ops or return empty in‑memory structures. The server starts and runs — just without persistent conversation history.

### AbortController Cancellation
Every expensive async operation accepts an optional `AbortSignal`. When a client disconnects, the signal is aborted and all in‑flight operations check the signal at their entry points, throwing `AbortError` which is caught silently. No wasted inference tokens, no orphaned DB queries, no responses sent to dead connections.

### Context Budget Protection
`ContextWindowManager` guards against negative message budgets (when RAG context + system prompt + response tokens exceed the model's context window). When the budget is exceeded, it warns and falls back to a 4000‑token minimum message budget.

### Clean Shutdown
`SIGTERM` and `SIGINT` handlers call `server.stop()`, which closes the HTTP server, WebSocket server, Postgres connection pool, and Neo4j graph store in sequence.

---

## 🔌 Integration with a Frontend Dashboard

The server is ready for dashboard consumption:

- **WebSocket** → `ws://localhost:3000` for real‑time events (progress, errors, stats)
- **REST** → `POST /inject`, `POST /ask`, `POST /retrieve` for all operations
- **SSE** → `GET /events` for a streaming alternative to WebSocket
- **Session continuity** → pass `sessionId` in `/ask` payload to maintain conversation history

---

## 🧾 License & Status

**Status:** Proof‑of‑concept / exploration. Suitable for dashboard integration and local experimentation, not yet hardened for production (no auth, no per‑doc transactional atomicity).

**Future enhancements:** file watching (auto‑incremental on change), an indexing `status` (pending/indexed/failed), streaming answers, multi‑user auth, advanced chunking strategies.

---

Refer to [System Evaluation Report](Report.md)

*Updated: 2026-08-06*
