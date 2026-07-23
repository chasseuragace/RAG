# RAG System – Production‑Ready(For the Dashboard!) with WebSocket, Chunking & Conversation History

## Overview

A modular RAG (Retrieval‑Augmented Generation) implementation with **real integrations** (Gemini embeddings, Chroma vector DB, Novita DeepSeek inference), **WebSocket telemetry**, **automatic chunking** of large Markdown files, **incremental (differential) sync** so only changed files are re‑embedded, and **conversation memory** per session.  
Designed to be extended by a frontend dashboard: inject documents, monitor progress in real time, and chat with full RAG + history.

```
✅ Real mode: Gemini Embeddings + Chroma + Novita DeepSeek
✅ Mock mode for testing (no external APIs)
✅ WebSocket & SSE real‑time events
✅ Full inject (clear + chunk + embed + store) — escape hatch
✅ Incremental sync — hash‑diff, re‑embed only the delta, no retrieval blackout
✅ Conversation history (JSON file based)
✅ REST API + WebSocket commands
✅ Hybrid search (vector + BM25 + RRF fusion)
✅ Reranking (cross‑encoder / mock heuristic)
✅ Agentic retrieval (Planner–Executor–Judge architecture, bounded iteration, explicit reasoning)
```

> **Layout:** the implementation lives under `src/` (config, events, core, loaders,
> embedders, stores, inference, pipelines, server) with tests under `tests/`.
> `rag-server.js` is a thin CLI entry point that parses argv and dispatches.

---

## 🏗️ Architecture

### Components

```
┌────────────────────────────────────────────────────────────────────┐
│                       RAG System (Current)                          │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  INJECTION PIPELINE (triggered by frontend or API)                │
│                                                                    │
│  Full rebuild  (/inject):                                         │
│  ┌────────────┐    ┌────────────┐    ┌───────────┐    ┌────────┐ │
│  │ Clear DB   │ →  │ Load .md   │ →  │ Chunk     │ →  │ Embed  │ │
│  │ (Chroma)   │    │ (input/)   │    │ (overlap) │    │(Gemini)│ │
│  └────────────┘    └────────────┘    └───────────┘    └────────┘ │
│                                                                    │
│  Incremental  (/inject-incremental):                              │
│  ┌────────────┐    ┌────────────────────┐    ┌──────────────────┐ │
│  │ Load .md   │ →  │ Diff vs registry   │ →  │ For each delta:  │ │
│  │ (input/)   │    │ (SHA256 hash)      │    │ delete old chunks│ │
│  └────────────┘    │ added/changed/     │    │ then embed+store │ │
│                    │ unchanged/removed  │    │ (no global clear)│ │
│                    └────────────────────┘    └──────────────────┘ │
│       ↑ doc-registry.json = source of truth ↑          ↓          │
│                                                    ┌────────────┐ │
│                                                    │ Hybrid     │ │
│                                                    │ Vector +   │ │
│                                                    │ BM25 Store │ │
│                                                    └────────────┘ │
│                                                                    │
│  AGENTIC RETRIEVAL (RAG Chat)                                     │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ Observation                                                 │  │
│  │   { query, results, topScore, previousActions }             │  │
│  └──────────────────────────┬──────────────────────────────────┘  │
│                             │                                      │
│                             ▼                                      │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ ConstrainedPlanner                                          │  │
│  │   Finite action space: search | increase_topk |             │  │
│  │   rewrite_query | answer | stop                             │  │
│  │   Each action includes explicit reason                       │  │
│  └──────────────────────────┬──────────────────────────────────┘  │
│                             │                                      │
│                             ▼                                      │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ RetrievalExecutor                                           │  │
│  │   Executes chosen action:                                   │  │
│  │   - search: hybrid search + rerank                          │  │
│  │   - increase_topk: expand recall                            │  │
│  │   - rewrite_query: expand query terms                       │  │
│  └──────────────────────────┬──────────────────────────────────┘  │
│                             │                                      │
│                             ▼                                      │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ RetrievalJudge                                              │  │
│  │   Evidence completeness check:                              │  │
│  │   retrievalQuality (0-1 heuristic)                          │  │
│  │   missingEvidence (what's absent, not hallucinated)          │  │
│  │   sufficient: true/false                                    │  │
│  └──────────────────────────┬──────────────────────────────────┘  │
│                             │                                      │
│          ┌────────────────────┴────────────────────┐            │
│          │                                         │            │
│   sufficient → return                     insufficient → loop   │
│                                                       │         │
│                                                       ▼         │
│                                                    ┌────────┐  │
│                                                    │ Novita │  │
│                                                    │ DeepSeek│ │
│                                                    │ Answer │  │
│                                                    └────────┘  │
│  TELEMETRY                                                        │
│  Events: agentic:strategy:start, agentic:action,                 │
│  agentic:search, agentic:judge, agentic:strategy:complete,       │
│  rerank:complete, hybrid:search, bm25:search, error, ...         │
└────────────────────────────────────────────────────────────────────┘
```

### Key Directories (hardcoded)

- **`./input/`** – Place your `.md` files here. Injection reads from this folder.
- **`./conversations/`** – JSON files storing chat history per `sessionId`.
- **`./data/doc-registry.json`** – Registry of what is embedded (`docId → {hash, size, mtime, chunkCount, lastIndexedAt}`); the source of truth used by incremental sync.

### Source Layout

```
rag-server.js                 # CLI entry: parse argv → dispatch
src/
├── config.js                 # env vars + directory bootstrap
├── events.js                 # ServerEvents bus + metrics (shared singleton)
├── core/
│   ├── chunker.js            # deterministic per-doc chunking
│   ├── registry.js           # DocRegistry + hashContent (diff classifier)
│   ├── conversation.js       # ConversationStore (per-session history)
│   └── interfaces.js         # abstract base classes (the seams)
├── agentic/
│   ├── observation.js        # shared state between planner/executor/judge
│   ├── planner.js            # ConstrainedPlanner: finite action space
│   ├── executor.js           # RetrievalExecutor: hybrid search + rerank
│   ├── judge.js              # RetrievalJudge: evidence completeness
│   └── strategies/
│       ├── heuristic.js      # HeuristicRetrievalStrategy: composes planner+executor+judge
│       └── stub.js           # StubRetrievalStrategy: deterministic test doubles
├── loaders/   mock.js real.js
├── embedders/ mock.js gemini.js                 # real mode uses Gemini
├── stores/    mock.js chroma.js                 # real mode uses Chroma
├── stores/    bm25.js                           # inline BM25 index
├── stores/    hybrid.js                         # vector + BM25 + RRF fusion
├── rerankers/ mock.js real.js                   # mock heuristic / cross-encoder
├── inference/ mock.js novita.js                 # mock / Novita DeepSeek
├── pipelines/ injection.js                      # full rebuild + incremental
│              retrieval.js                      # single-stage retrieval
│              agentic-retrieval.js              # orchestrates Strategy for multi-step loop
└── server.js                 # HTTP + WebSocket wiring
tests/
├── runner.js                 # TestRunner + Assert
├── mock.test.js              # --test  (mock unit tests)
├── delta.test.js             # --delta-test  (incremental sync)
├── chroma.test.js            # --chroma-test
├── real.test.js              # --real-test  (live integration)
└── advanced.test.js          # --advanced-test (reranking / agentic / hybrid)
```

---

## 🚀 Quick Start

### Prerequisites

1. **Node.js** (v18+ recommended)
2. **ChromaDB** – Run with Docker:
   ```bash
   docker run -d -p 8000:8000 chromadb/chroma
   ```
3. **API Keys** (set as environment variables)
   - `GEMINI_API_KEY` or `AI_STUDIO_API_KEY` (for embeddings)
   - `NOVITA_API_KEY` (for DeepSeek inference)

### Install & Run

```bash
npm install        # installs ws (for WebSocket support)
# ./input, ./conversations and ./data are auto-created on first run.
# Place your .md files inside ./input/

# Start the server in REAL mode
export GEMINI_API_KEY="your_key"
export NOVITA_API_KEY="your_key"
node rag-server.js --server --real
```

Server runs at `http://localhost:3000` (or custom port with `--port`).

---

## 📡 Endpoints & Commands

### REST API

| Method | Endpoint       | Description                                                                 |
|--------|----------------|-----------------------------------------------------------------------------|
| GET    | `/`            | Server info, configuration (input dir, chunk size)                         |
| GET    | `/health`      | Health check, mode (real/mock), connected clients                          |
| GET    | `/metrics`     | Real‑time server metrics (requests, latencies, errors, uptime)             |
| GET    | `/stats`       | Vector store statistics (number of stored chunks)                          |
| GET    | `/events`      | Server‑Sent Events (SSE) – real‑time event stream                          |
| POST   | `/inject`             | **Full rebuild** – clear Chroma + read ./input + chunk + embed + store (rebuilds the registry to match) |
| POST   | `/inject-incremental` | **Differential sync** – hash‑diff vs registry, re‑embed only added/changed files, delete removed ones (no global clear) |
| POST   | `/clear`              | Clear vector store **without** re‑injecting (also wipes the registry)       |
| POST   | `/retrieve`           | **Hybrid retrieval** – vector + BM25 fused with RRF – body: `{query, topK?}`              |
| POST   | `/ask`                | **Agentic RAG** – multi-step retrieval + rerank + conversation history – body: `{query, sessionId?, topK?}`    |

**Example full rebuild (clears and injects everything from `./input`):**
```bash
curl -X POST http://localhost:3000/inject
```

**Example incremental sync (re‑embeds only what changed since last run):**
```bash
curl -X POST http://localhost:3000/inject-incremental
# → { "added": 2, "changed": 5, "unchanged": 93, "removed": 1, "chunksStored": 18, ... }
```
Use `/inject-incremental` for routine/daily refreshes; reserve `/inject` for first‑time loads or when you want to force a clean rebuild.

**Example `/ask` with session memory:**
```bash
curl -X POST http://localhost:3000/ask \
  -H "Content-Type: application/json" \
  -d '{"query": "What is RAG?", "sessionId": "user123", "topK": 3}'
```
Response includes `answer`, `sources`, and `sessionId`.

### WebSocket Commands

Connect to `ws://localhost:3000` and send JSON messages:

| Command type              | Payload example                                          | Response                                 |
|---------------------------|----------------------------------------------------------|------------------------------------------|
| `request:metrics`         | `{"type":"request:metrics"}`                             | `{"type":"metrics","data":{...}}`        |
| `request:event-log`       | `{"type":"request:event-log"}`                           | Last 1000 events                         |
| `request:stats`           | `{"type":"request:stats"}`                               | Vector store stats                       |
| `request:inject`          | `{"type":"request:inject"}`                              | `{"type":"inject:result","data":{...}}`  |
| `request:inject-incremental` | `{"type":"request:inject-incremental"}`               | `{"type":"inject:result","data":{added,changed,unchanged,removed,...}}` |
| `request:clear`           | `{"type":"request:clear"}`                               | `{"type":"clear:result"}`                |
| `request:retrieve`        | `{"type":"request:retrieve","query":"AI","topK":5}`      | Retrieved chunks                         |
| `request:ask`             | `{"type":"request:ask","query":"What is RAG?","sessionId":"user123","topK":3}` | Answer + sources + sessionId |
| `ping`                    | `{"type":"ping"}`                                        | `{"type":"pong","timestamp":...}`        |

All server events are broadcast to all connected WebSocket clients (e.g., `injection:start`, `embedding:complete`, `error`).

---

## 🧠 Feature Details

### 1. Injection — Full Rebuild

- **Clears** the entire Chroma collection.
- Recursively reads all `.md` files from `./input/`.
- **Chunks** each file using:
  - `CHUNK_SIZE` (default 1000 characters)
  - `CHUNK_OVERLAP` (default 200)
  - Paragraph‑ and sentence‑aware cut points.
- Embeds each chunk with **Gemini Embedding API**.
- Stores each chunk as a separate document in Chroma (metadata includes original file, chunk index, `original_id`).
- **Rebuilds `doc-registry.json`** to mirror exactly what was embedded, so a subsequent incremental run sees everything as unchanged (no double work).

Trigger via `POST /inject` or WebSocket `request:inject`.

### 1b. Injection — Incremental (Differential) Sync

For routine refreshes where only some files change, this avoids re‑embedding the whole corpus:

- Loads `./input` and **diffs each file against the registry by SHA256 content hash**, classifying into `added / changed / unchanged / removed`.
- **Unchanged** files are skipped entirely (no embedding cost).
- **Changed** files: old chunks are deleted first (`deleteByDocId` via `original_id`), then the new version is chunked, embedded and stored. Deleting first means that when a file *shrinks* (fewer chunks than before), no orphan chunks survive.
- **Removed** files: their chunks and registry entry are deleted.
- The store is **never globally cleared**, so retrieval stays available throughout — no blackout window.

Chunk IDs are stable (`{docId}_chunk_{index}`) and chunking is deterministic per document, so a single file change ripples only that file's chunks.

Trigger via `POST /inject-incremental` or WebSocket `request:inject-incremental`.

### 2. RAG Chat with Conversation History

- `POST /ask` or WebSocket `request:ask` accepts `sessionId`.
- If `sessionId` is new, a JSON file `./conversations/<sessionId>.json` is created.
- The last 10 messages (user + assistant) are sent as conversation context to the LLM.
- **Retrieval** – query embedded with Gemini, fetch top‑K chunks from Chroma.
- **LLM** – Novita DeepSeek receives: system prompt (with retrieved chunks), conversation history, and the current user query.
- The assistant’s answer is appended to the conversation file.

### 2. Agentic Retrieval Architecture

`POST /ask` (and WebSocket `request:ask`) now uses a **Planner–Executor–Judge** architecture instead of a fixed loop.

```
Observation { query, results, topScore, previousActions }
      │
      ▼
   Planner
      │
      ▼
   Action (search | increase_topk | rewrite_query | answer | stop)
      │
      ▼
   Executor
      │
      ▼
   Observation (updated with new results)
      │
      ▼
   Judge
      │
      ├── sufficient → return
      ├── low score → Planner chooses increase_topk
      ├── few results → Planner chooses rewrite_query
      └── exhausted → stop
```

**Components:**

| Component | Responsibility |
|-----------|---------------|
| **Observation** | Shared state: query, retrieved results, scores, previous actions, iteration count |
| **ConstrainedPlanner** | Decides the next action from a finite set: `search`, `increase_topk`, `rewrite_query`, `answer`, `stop` |
| **RetrievalExecutor** | Performs the chosen action: runs hybrid search, expands topK, rewrites query, or no-ops |
| **RetrievalJudge** | Evaluates evidence completeness: reports `retrievalQuality`, `missingEvidence`, and `sufficient` — without hallucinating details the corpus doesn't contain |
| **HeuristicRetrievalStrategy** | Composes Planner + Executor + Judge into a bounded iteration loop (max 4 steps by default) |

**Why this matters:**

Each component has one job. The Planner doesn't execute retrieval. The Judge doesn't decide the next action. This makes the system **observable, testable, and bounded** while still adapting retrieval instead of following a fixed pipeline.

**Planner action space:**

| Action | Trigger |
|--------|---------|
| `search` | Initial retrieval |
| `increase_topk` | Low relevance score or insufficient results after rewrite |
| `rewrite_query` | Few results and query hasn't been expanded yet |
| `answer` | Sufficient evidence found |
| `stop` | Max iterations reached OR no results at all |

**Judge output example:**
```json
{
  "sufficient": false,
  "quality": 0.45,
  "missing": ["only_1_document_found", "uncovered_query_terms: refunds, international"],
  "reason": "quality=0.45 below 0.60, docs=1 < 2"
}
```

**Key design rules:**
- The Judge **only reports what is missing** from the current context. It cannot hallucinate corpus content it hasn't seen.
- Every action includes an explicit `reason` for observability and debugging.
- The loop is bounded by `maxSteps` to prevent runaway execution.

Response includes `retrievalQuality`, `missingEvidence`, `finalAction`, and `steps`:
```json
{
  "retrievalQuality": 0.72,
  "missingEvidence": [],
  "finalAction": { "type": "answer", "reason": "sufficient_evidence: 3 docs, topScore=0.82" },
  "steps": [
    { "type": "search", "query": "deep learning", "resultCount": 3, "reason": "initial retrieval" }
  ]
}
```

### 5. WebSocket Telemetry

All pipeline steps emit events that can be consumed by a dashboard:
- `injection:start`, `injection:documents-loaded`, `injection:chunks-created`, `injection:embeddings-generated`, `injection:document-stored`, `injection:complete`
- `retrieval:start`, `retrieval:query-embedded`, `retrieval:complete`
- `embedding:complete`, `embedding:batch`
- `vectorstore:stored`, `vectorstore:queried`, `vectorstore:cleared`
- `error`, `client:connected`

Events are also available via SSE at `/events`.

---

## ⚙️ Configuration (Environment Variables)

| Variable             | Default                | Description                                    |
|----------------------|------------------------|------------------------------------------------|
| `RAG_INPUT_DIR`      | `./input`              | Folder containing `.md` files to inject       |
| `RAG_CHUNK_SIZE`     | `1000`                 | Max characters per chunk                      |
| `RAG_CHUNK_OVERLAP`  | `200`                  | Overlap between consecutive chunks            |
| `RAG_REGISTRY_FILE`  | `./data/doc-registry.json` | Path to the incremental-sync registry      |
| `GEMINI_API_KEY`     | (required for real)    | Google Gemini API key                          |
| `AI_STUDIO_API_KEY`  | (alternative)          | Same as Gemini key                             |
| `NOVITA_API_KEY`     | (required for real)    | Novita AI API key for DeepSeek                 |
| `PORT` (or `--port`) | `3000`                 | HTTP/WebSocket server port                     |

You can also set `--real` flag to use real APIs; without it, the server runs in **mock mode** (deterministic embeddings, in‑memory store, mock LLM).

---

## 🧪 Testing

### Run Mock Test Suite (no external dependencies)
```bash
node rag-server.js --test       # or: npm test
```
Tests chunking, embedding consistency, vector search, `deleteByDocId`, and the registry diff classifier.

### Run Advanced Tests (agentic, hybrid, reranking — no external dependencies)
```bash
node rag-server.js --advanced-test
```
Covers:
- `MockEmbedder` content-correlation and determinism
- `BM25Store` indexing, deletion, determinism
- `HybridStore` RRF fusion and delegation
- `MockReranker` word-overlap reordering
- `ConstrainedPlanner` decision branches (answer / increase_topk / rewrite_query / stop)
- `RetrievalJudge` evidence completeness without hallucination
- `AgenticRetrievalPipeline` with `StubRetrievalStrategy`:
  - immediate answer when strategy returns `finalAction`
  - explicit stop when strategy returns `stop`
  - multi-step action accumulation with explicit `reason` fields
  - empty-corpus graceful handling
  - determinism across identical cloned stores
- `HeuristicRetrievalStrategy` returns explicit `finalAction`, `retrievalQuality`, and `missingEvidence`

### Run Delta (Incremental Sync) Tests (no external dependencies)
```bash
node rag-server.js --delta-test  # or: npm run test:delta
```
Self-contained suite covering the delta path: large-doc chunking, zero re‑embed on unchanged files, **orphan-chunk removal when a file shrinks**, removal handling, and that a full `run()` populates the registry so the next incremental does no double work.

### Run Chroma Delete Test (requires only a running Chroma)
```bash
docker compose up -d                 # start Chroma on :8000
node rag-server.js --chroma-test     # or: npm run test:chroma
```
Verifies the one capability the mock can't prove: live filtered **delete‑by‑doc‑id** (`DELETE where original_id == X`), including the orphan case when a doc is re‑added with fewer chunks. Uses dummy vectors, so no Gemini/Novita keys are needed.

### Run Real Integration Tests (requires Chroma, Gemini, Novita)
```bash
node rag-server.js --real-test
```
Tests real connectivity: Chroma heartbeat, embedding generation, storing/querying, and Novita inference.

---

## 📂 Directory Structure (after server start)

```
.
├── rag-server.js              # CLI entry point
├── src/                       # implementation (see Source Layout above)
├── tests/                     # mock, delta, real test suites
├── public/
│   └── dashboard.html         # built-in monitoring/control UI
├── input/                     # Place your .md files here
│   ├── doc1.md
│   └── doc2.md
├── conversations/             # Auto‑created, JSON chat logs
│   ├── user123.json
│   └── anon_1623456789.json
├── data/
│   └── doc-registry.json      # Auto‑created, incremental-sync source of truth
└── package.json
```

---

## 🔌 Integration with a Frontend Dashboard

The server is ready to be consumed by a React/Vue/Svelte dashboard:

- **Connect WebSocket** to `ws://localhost:3000` to receive real‑time events (progress bars, error notifications, stats).
- **Call `request:inject`** via WebSocket or `POST /inject` – the server clears existing data, chunks, embeds, and stores everything from `./input`.
- **Display conversation** – send `request:ask` with a `sessionId`; the server maintains history.
- **Show metrics** – poll `GET /metrics` or subscribe to WebSocket `request:metrics`.

No extra endpoints needed – the current API already supports all dashboard needs.

---

## 🛠️ Development & Extension

Common classes are re‑exported from the entry point for quick scripts:

```javascript
const { RAGServer, serverEvents, ConversationStore, DocRegistry, chunkText } = require('./rag-server.js');
```

…or import any module directly from `src/`:

```javascript
const { GeminiEmbedder } = require('./src/embedders/gemini');
const { ChromaVectorStore } = require('./src/stores/chroma');
const { NovitaInference } = require('./src/inference/novita');
const { BM25Store } = require('./src/stores/bm25');
const { HybridStore } = require('./src/stores/hybrid');
const { MockReranker } = require('./src/rerankers/mock');
const { AgenticRetrievalPipeline } = require('./src/pipelines/agentic-retrieval');
const { HeuristicRetrievalStrategy } = require('./src/agentic/strategies/heuristic');
const { ConstrainedPlanner } = require('./src/agentic/planner');
const { RetrievalJudge } = require('./src/agentic/judge');
```

Example: manually run a full inject, then an incremental sync, from a script:

```javascript
const { RAGServer } = require('./rag-server.js');
const server = new RAGServer(3000, true);
await server.initialize();
await server.injectionPipeline.run('./input', server.registry);            // full rebuild
await server.injectionPipeline.runIncremental('./input', server.registry); // delta only
```

### Custom Agentic Strategies

The agentic retrieval pipeline is composed of three interchangeable components:

```javascript
const { ConstrainedPlanner } = require('./src/agentic/planner');
const { RetrievalExecutor } = require('./src/agentic/executor');
const { RetrievalJudge } = require('./src/agentic/judge');

// Create a custom strategy (pluggable heuristics, LLM-backed, or hybrid)
class MyStrategy {
  constructor(embedder, hybridStore, reranker) {
    this.planner = new ConstrainedPlanner({ minResultsForAnswer: 3, lowScoreThreshold: 0.4 });
    this.executor = new RetrievalExecutor(embedder, hybridStore, reranker);
    this.judge = new RetrievalJudge({ sufficientThreshold: 0.7 });
  }
  async run(observation, maxIterations) {
    // planner.decide → executor.execute → judge.evaluate → loop
  }
}
```

Replace the default `HeuristicRetrievalStrategy` with your own by passing it to `AgenticRetrievalPipeline`.

---

## 📊 Performance Notes (Real Mode)

- **Chunking** – adds ~1‑5ms per document (negligible).
- **Gemini embedding** – ~200‑500ms per chunk (batched for efficiency).
- **BM25 indexing** – O(n) per document, very fast.
- **Hybrid search (RRF)** – vector + keyword search, no extra latency beyond both queries.
- **Reranker (cross-encoder)** – adds ~50‑200ms per batch.
- **Agentic loop (2 steps)** – roughly 2–4× retrieval + rerank cost.
- **Chroma query** – <50ms for small collections.
- **Novita DeepSeek** – ~1‑3s per answer (depends on context size).
- **WebSocket** – adds <1ms overhead per event.

---

## ❓ FAQ

**Q: Why does `/inject` clear everything first?**  
A: It's the full‑rebuild escape hatch — a guaranteed clean slate from `./input`. For routine refreshes prefer `/inject-incremental`, which re‑embeds only changed files and never clears the store.

**Q: Should I re‑embed everything every day?**  
A: No. Use `/inject-incremental`. It hash‑diffs `./input` against `./data/doc-registry.json` and only re‑embeds added/changed files (deleting chunks for removed ones). If 35 of 100 files change, you embed ~35 files, not 100 — and retrieval never goes dark during the update.

**Q: What happens if the registry and the vector store drift apart?**  
A: Run a full `/inject` — it rebuilds both from `./input` and re‑syncs the registry to match. `/clear` wipes both as well.

**Q: How do I change the chunk size?**  
A: Set `RAG_CHUNK_SIZE` env variable or modify the constants at the top of the file.

**Q: Can I use a different LLM?**  
A: Yes – replace `NovitaInference` with another class that implements `generateAnswer()`.

**Q: Can I use a different reranker?**  
A: Yes – the server uses `CrossEncoderReranker` in real mode (REST endpoint) and `MockReranker` in mock mode. Swap the rerankers directory to change behavior.

**Q: Why hybrid search instead of pure vector search?**  
A: Pure vector search is semantic but can miss keyword matches. The system now uses **Reciprocal Rank Fusion (RRF)** to combine vector similarity with BM25 keyword scores for better recall.

**Q: What does the agentic retrieval loop do?**  
A: `/ask` uses a **Planner–Executor–Judge** architecture. The `ConstrainedPlanner` chooses from a finite action space (`search`, `increase_topk`, `rewrite_query`, `answer`, `stop`) based on evidence state. The `RetrievalExecutor` performs the action. The `RetrievalJudge` evaluates evidence completeness and reports `retrievalQuality`, `missingEvidence`, and `sufficient` without hallucinating. The response includes a `steps` array documenting each action with its explicit `reason`.

**Q: Why isn't the agentic loop just a fixed heuristic?**  
A: It is heuristic-driven today, but the architecture separates Planner, Executor, and Judge behind stable interfaces. You can swap `HeuristicRetrievalStrategy` for an LLM-backed strategy later without changing the pipeline, tests, or API.

**Q: How do you test agentic scenarios deterministically?**  
A: Two techniques: (1) `StubRetrievalStrategy` lets tests pre-program the exact action sequence the strategy returns, so tests verify the pipeline's reactions without depending on embedding quality. (2) `MockEmbedder` now produces **content-correlated** embeddings — texts with shared vocabulary get similar vectors — making retrieval and judge outcomes predictable.

**Q: Does the server support streaming answers?**  
A: Not yet – answers are returned as a single JSON field. Streaming can be added by extending the WebSocket protocol.

**Q: Where are conversation histories stored?**  
A: `./conversations/<sessionId>.json`. You can delete them to reset.

**Q: How to run without Chroma (mock mode)?**  
A: Omit the `--real` flag: `node rag-server.js --server`. It uses in‑memory store and mock embeddings.

---

## 🧾 License & Status

**Status:** Proof‑of‑concept / exploration. Suitable for dashboard integration and local experimentation, not yet hardened for production (no auth, no indexing `status` column, per‑doc rather than transactional atomicity).  
**Future enhancements:** file watching (auto‑incremental on change), an indexing `status` (pending/indexed/failed) so queries only see fully‑indexed docs, streaming answers, multi‑user auth, advanced chunking strategies.

---

## ✅ How to use the dashboard

The dashboard lives at **`public/dashboard.html`** and is served directly by the RAG server.

1. **Start your RAG server** (real or mock):
   ```bash
   node rag-server.js --server --real   # or --server for mock mode
   ```
2. **Open the dashboard** in a browser: `http://localhost:3000/` (which redirects to `/dashboard.html`). Because the page is served from the same origin as the server, the WebSocket connects to `ws://localhost:3000` with no CORS or mixed‑content issues.

3. **Interact**:
   - **Inject** – full rebuild: clears Chroma, reads `./input/*.md`, chunks, embeds, stores.
   - **Retrieve** – test retrieval without LLM.
   - **Ask** – full RAG with conversation history (sessionId stored in `./conversations/`).
   - **Clear** – only clears vector store (no re‑injection).

All events appear in the timeline in real time, metrics update every 2 seconds, and the last answer is displayed.

---

## 🔧 Customisation

- Change WebSocket/HTTP port – edit `getPort()` inside the script (default `3000`).
- The dashboard assumes the RAG server runs on the same host as the page (or you can hardcode `localhost`). For production, replace `window.location.hostname` with your server IP.

The dashboard is fully self‑contained, no build step required. It matches the server’s exact WebSocket protocol (`request:inject`, `request:ask`, `request:retrieve`, etc.) and handles all events emitted by your updated server.


Refer to [System Evaluation Report](Report.md)

*Updated: 2026-07-23*  
*Corresponds to the modular `src/` layout with WebSocket, chunking, conversation history, incremental (differential) sync, hybrid BM25+vector retrieval (RRF), reranking, agentic multi-step retrieval with Planner-Executor-Judge architecture, and real API integrations.*