# Quick Start Guide

## Prerequisites

- **Node.js** (v18+ recommended)
- **ChromaDB** (optional, for real mode):
  ```bash
  docker run -d -p 8000:8000 chromadb/chroma
  ```
- **API Keys** (optional, for real mode):
  - `GEMINI_API_KEY` or `AI_STUDIO_API_KEY` (embeddings)
  - `NOVITA_API_KEY` (DeepSeek inference)

## 30-Second Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Run tests (verify everything works)
```bash
node rag-server.js --test
```

### 3. Start the server (mock mode)
```bash
node rag-server.js --server
```

### 4. Test the API
```bash
curl http://localhost:3000/health

curl -X POST http://localhost:3000/retrieve \
  -H "Content-Type: application/json" \
  -d '{"query": "artificial intelligence"}'
```

## Run Advanced Tests

```bash
node rag-server.js --advanced-test
```

Tests reranking, hybrid BM25+vector search, and agentic retrieval.

## Start Real Server

```bash
export GEMINI_API_KEY="your-key"
export NOVITA_API_KEY="your-key"
node rag-server.js --server --real
```

## Where Things Are

| Concern | Location |
|---|---|
| Entry point | `rag-server.js` |
| Implementation | `src/` (modular) |
| Tests | `tests/` |
| Input docs | `./input/` |
| Conversation history | `./conversations/` |
| Incremental-sync registry | `./data/doc-registry.json` |
| Dashboard | `public/dashboard.html` |

## Common Commands

```bash
node rag-server.js --test               # run mock tests
node rag-server.js --advanced-test      # run hybrid / rerank / agentic tests
node rag-server.js --delta-test         # run incremental-sync tests
node rag-server.js --server             # start mock server
node rag-server.js --server --real      # start real server
```

For full details, read [README.md](README.md).
