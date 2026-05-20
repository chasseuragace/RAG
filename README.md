# RAG System – Production‑Ready with WebSocket, Chunking & Conversation History

## Overview

A complete, single‑file RAG (Retrieval‑Augmented Generation) implementation with **real integrations** (Gemini embeddings, Chroma vector DB, Novita DeepSeek inference), **WebSocket telemetry**, **automatic chunking** of large Markdown files, and **conversation memory** per session.  
Designed to be extended by a frontend dashboard: inject documents, monitor progress in real time, and chat with full RAG + history.

```
✅ Real mode: Gemini Embeddings + Chroma + Novita DeepSeek
✅ Mock mode for testing (no external APIs)
✅ WebSocket & SSE real‑time events
✅ Injection = clear + chunk + embed + store (no duplicates)
✅ Conversation history (JSON file based)
✅ REST API + WebSocket commands
```

---

## 🏗️ Architecture

### Components

```
┌────────────────────────────────────────────────────────────────────┐
│                       RAG System (Current)                          │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  INJECTION PIPELINE (triggered by frontend or API)                │
│  ┌────────────┐    ┌────────────┐    ┌───────────┐    ┌────────┐ │
│  │ Clear DB   │ →  │ Load .md   │ →  │ Chunk     │ →  │ Embed  │ │
│  │ (Chroma)   │    │ (input/)   │    │ (overlap) │    │(Gemini)│ │
│  └────────────┘    └────────────┘    └───────────┘    └────────┘ │
│                                                           ↓        │
│                                                    ┌────────────┐ │
│                                                    │ Store in   │ │
│                                                    │ Chroma     │ │
│                                                    └────────────┘ │
│                                                                    │
│  RETRIEVAL + INFERENCE (RAG Chat)                                 │
│  ┌────────────┐    ┌────────────┐    ┌───────────┐    ┌────────┐ │
│  │ User Query │ →  │ Embed      │ →  │ Chroma    │ →  │ Context│ │
│  │ + history  │    │ (Gemini)   │    │ Search    │    │ Chunks │ │
│  └────────────┘    └────────────┘    └───────────┘    └────────┘ │
│                                                           ↓        │
│                                                    ┌────────────┐ │
│                                                    │ Novita     │ │
│                                                    │ DeepSeek   │ │
│                                                    │ Answer     │ │
│                                                    └────────────┘ │
│                                                                    │
│  TELEMETRY (WebSocket / SSE)                                       │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ Events: injection:start/complete, embedding:complete,      │  │
│  │ vectorstore:stored/queried, retrieval:complete, error, ... │  │
│  └─────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

### Key Directories (hardcoded)

- **`./input/`** – Place your `.md` files here. Injection reads from this folder.
- **`./conversations/`** – JSON files storing chat history per `sessionId`.

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
# Clone / create the single file (rag-server.js)
npm install ws   # optional, for WebSocket support
mkdir input conversations
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
| POST   | `/inject`      | **Clear Chroma + read ./input + chunk + embed + store**                    |
| POST   | `/clear`       | Clear vector store **without** re‑injecting                                 |
| POST   | `/retrieve`    | Retrieve relevant chunks (no LLM) – body: `{query, topK?}`                 |
| POST   | `/ask`         | Full RAG with conversation history – body: `{query, sessionId?, topK?}`    |

**Example `/inject` call (clears and injects from `./input`):**
```bash
curl -X POST http://localhost:3000/inject
```

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
| `request:clear`           | `{"type":"request:clear"}`                               | `{"type":"clear:result"}`                |
| `request:retrieve`        | `{"type":"request:retrieve","query":"AI","topK":5}`      | Retrieved chunks                         |
| `request:ask`             | `{"type":"request:ask","query":"What is RAG?","sessionId":"user123","topK":3}` | Answer + sources + sessionId |
| `ping`                    | `{"type":"ping"}`                                        | `{"type":"pong","timestamp":...}`        |

All server events are broadcast to all connected WebSocket clients (e.g., `injection:start`, `embedding:complete`, `error`).

---

## 🧠 Feature Details

### 1. Injection Pipeline (Idempotent)

- **Clears** the entire Chroma collection.
- Recursively reads all `.md` files from `./input/`.
- **Chunks** each file using:
  - `CHUNK_SIZE` (default 1000 characters)
  - `CHUNK_OVERLAP` (default 200)
  - Paragraph‑ and sentence‑aware cut points.
- Embeds each chunk with **Gemini Embedding API**.
- Stores each chunk as a separate document in Chroma (metadata includes original file, chunk index).

Trigger via `POST /inject` or WebSocket `request:inject`.

### 2. RAG Chat with Conversation History

- `POST /ask` or WebSocket `request:ask` accepts `sessionId`.
- If `sessionId` is new, a JSON file `./conversations/<sessionId>.json` is created.
- The last 10 messages (user + assistant) are sent as conversation context to the LLM.
- **Retrieval** – query embedded with Gemini, fetch top‑K chunks from Chroma.
- **LLM** – Novita DeepSeek receives: system prompt (with retrieved chunks), conversation history, and the current user query.
- The assistant’s answer is appended to the conversation file.

### 3. WebSocket Telemetry

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
| `GEMINI_API_KEY`     | (required for real)    | Google Gemini API key                          |
| `AI_STUDIO_API_KEY`  | (alternative)          | Same as Gemini key                             |
| `NOVITA_API_KEY`     | (required for real)    | Novita AI API key for DeepSeek                 |
| `PORT` (or `--port`) | `3000`                 | HTTP/WebSocket server port                     |

You can also set `--real` flag to use real APIs; without it, the server runs in **mock mode** (deterministic embeddings, in‑memory store, mock LLM).

---

## 🧪 Testing

### Run Mock Test Suite (no external dependencies)
```bash
node rag-server.js --test
```
All tests (document loading, embedding consistency, vector search, pipelines) should pass.

### Run Real Integration Tests (requires Chroma, Gemini, Novita)
```bash
node rag-server.js --real-test
```
Tests real connectivity: Chroma heartbeat, embedding generation, storing/querying, and Novita inference.

---

## 📂 Directory Structure (after server start)

```
.
├── rag-server.js
├── input/                     # Place your .md files here
│   ├── doc1.md
│   └── doc2.md
├── conversations/             # Auto‑created, JSON chat logs
│   ├── user123.json
│   └── anon_1623456789.json
└── (optional) package.json    # if you install ws
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

All core classes are exported for custom scripts:

```javascript
const { 
  RAGServer, serverEvents, 
  GeminiEmbedder, ChromaVectorStore, NovitaInference,
  ConversationStore, chunkText 
} = require('./rag-server.js');
```

Example: Manually run injection from a script:

```javascript
const server = new RAGServer(3000, true);
await server.initialize();
await server.injectionPipeline.run('./input');
```

---

## 📊 Performance Notes (Real Mode)

- **Chunking** – adds ~1‑5ms per document (negligible).
- **Gemini embedding** – ~200‑500ms per chunk (batched for efficiency).
- **Chroma query** – <50ms for small collections.
- **Novita DeepSeek** – ~1‑3s per answer (depends on context size).
- **WebSocket** – adds <1ms overhead per event.

---

## ❓ FAQ

**Q: Why does `/inject` clear everything first?**  
A: To avoid duplicates and stale data. The input directory is the single source of truth. Every injection is a full refresh.

**Q: How do I change the chunk size?**  
A: Set `RAG_CHUNK_SIZE` env variable or modify the constants at the top of the file.

**Q: Can I use a different LLM?**  
A: Yes – replace `NovitaInference` with another class that implements `generateAnswer()`.

**Q: Does the server support streaming answers?**  
A: Not yet – answers are returned as a single JSON field. Streaming can be added by extending the WebSocket protocol.

**Q: Where are conversation histories stored?**  
A: `./conversations/<sessionId>.json`. You can delete them to reset.

**Q: How to run without Chroma (mock mode)?**  
A: Omit the `--real` flag: `node rag-server.js --server`. It uses in‑memory store and mock embeddings.

---

## 🧾 License & Status

**Status:** Production‑ready for dashboard integration.  
**Future enhancements:** streaming answers, file watching (auto‑inject on change), multi‑user auth, advanced chunking strategies.

---

## ✅ How to use the dashboard


2. **Start your RAG server** (real or mock):
   ```bash
   node rag-server.js --server --real   # or --server for mock mode
   ```
3. **Open the dashboard** in a browser: `http://localhost:3000/dashboard.html` (or just double‑click the file if served via file:// – but WebSocket will only work if the page is served from the same origin; easiest: open `http://localhost:3000` and navigate to `/dashboard.html` or use a simple static file server).

   > If you double‑click the HTML file, the browser may block WebSocket connections due to mixed content. Serve it via the same port using a tiny static server or simply place it in the same directory and access via `http://localhost:3000/dashboard.html` (the RAG server does **not** serve static files by default; you can use `npx serve .` on port 8080 and point the dashboard to `ws://localhost:3000`).  

   **Simplest fix** – serve the dashboard with the RAG server’s own HTTP server: modify `rag-server.js` to serve static files for `/dashboard.html`. But for quick testing, just open the HTML file and accept the mixed‑content warning? Alternatively, run a separate static server:
   ```bash
   npx serve . -p 8080
   ```
   Then open `http://localhost:8080/dashboard.html` – the WebSocket will connect to `ws://localhost:3000` (no CORS issues).

4. **Interact**:
   - **Inject** – clears Chroma, reads `./input/*.md`, chunks, embeds, stores.
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

*Updated: 2026-05-20*  
*Corresponds to `rag-server.js` with WebSocket, chunking, conversation history, and real API integrations.*