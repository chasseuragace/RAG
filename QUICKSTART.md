# Quick Start Guide

## 30-Second Setup

### 1. Extract the package
```bash
unzip rag-system.zip
cd rag-system
```

### 2. Run tests (verify everything works)
```bash
node rag-server.js --test
```

**Expected output:**
```
✅ 8/8 Tests Passing
📊 RESULTS: 8 passed, 0 failed
```

### 3. Start the server
```bash
node rag-server.js --server
```

**Expected output:**
```
🚀 RAG Server running on http://localhost:3000
```

### 4. Test the API (in another terminal)
```bash
# Health check
curl http://localhost:3000/health

# Retrieve documents
curl -X POST http://localhost:3000/retrieve \
  -H "Content-Type: application/json" \
  -d '{"query": "artificial intelligence"}'
```

---

## 5 Minutes - Full Understanding

1. **Read** `README.md` (comprehensive overview)
2. **Look at** `rag-server.js` lines 1-100 (architecture)
3. **Run** `node rag-server.js --test` (see tests pass)
4. **Check** `examples/api-examples.md` (API reference)

---

## 15 Minutes - Hands-On Testing

1. **Terminal 1: Start server**
   ```bash
   node rag-server.js --server
   ```

2. **Terminal 2: Run API tests**
   ```bash
   cd examples
   bash test-injection.sh
   bash test-retrieval.sh
   ```

3. **Explore the API**
   ```bash
   # Get stats
   curl http://localhost:3000/stats | jq .
   
   # Try different queries
   curl -X POST http://localhost:3000/retrieve \
     -H "Content-Type: application/json" \
     -d '{"query": "machine learning"}'
   ```

---

## 30 Minutes - Understand the Code

### Key Files
- `rag-server.js` - Single file with everything (1000+ lines)
  - Lines 1-150: Abstract base classes
  - Lines 150-400: Mock implementations
  - Lines 400-700: Concrete implementations
  - Lines 700-900: Test suite
  - Lines 900-1000+: HTTP server

### Main Classes
1. **Abstract Classes** (interfaces you implement against)
   - `DocumentLoader` - Load documents
   - `Embedder` - Embed text
   - `VectorStore` - Store/retrieve vectors
   - `InjectionPipeline` - Orchestrate injection
   - `RetrievalPipeline` - Orchestrate retrieval

2. **Mock Classes** (for testing without APIs)
   - `MockDocumentLoader` - Returns test documents
   - `MockEmbedder` - Generates consistent embeddings
   - `MockVectorStore` - In-memory vector database
   - `MockRetriever` - Queries vectors

3. **Concrete Classes** (actual implementations)
   - `ConcreteInjectionPipeline` - Full injection workflow
   - `ConcreteRetrievalPipeline` - Full retrieval workflow

### Data Flow
```
Documents → Load → Embed → Store in Vector DB
                              ↓
                           Query → Embed → Search → Results
```

---

## Next: Phase 2 Implementation

When you're ready to connect real APIs, follow the phase 2 guide in README.md:

1. **Replace MockEmbedder** with GeminiEmbedder (uses gemini-embedding-2 API)
2. **Replace MockDocumentLoader** with RealDocumentLoader (reads actual MD files)
3. **Replace MockVectorStore** with ChromaVectorStore (Docker Chroma instance)
4. **Add Docker Compose** for infrastructure
5. **Add inference integration** (Novita AI for LLM responses)

---

## Environment Setup (for Phase 2)

Add to your `.zshrc` or `.bashrc`:
```bash
export AI_STUDIO_API_KEY="your-gemini-api-key-here"
export NOVITA_API_KEY="your-novita-api-key-here"
```

---

## Troubleshooting

### "Port 3000 already in use"
```bash
node rag-server.js --server --port 8080
```

### "Tests failing"
Make sure you have Node.js 18+:
```bash
node --version  # Should be v18.0.0 or higher
```

### "jq not installed"
For pretty JSON output (optional):
```bash
# macOS
brew install jq

# Ubuntu/Debian
sudo apt-get install jq

# Windows (WSL)
sudo apt-get install jq
```

---

## Project Structure

```
rag-system/
├── rag-server.js           # Main implementation (no dependencies)
├── package.json            # Node.js config
├── README.md               # Full documentation
├── QUICKSTART.md           # This file
├── .gitignore              # Git config
└── examples/
    ├── test-injection.sh   # Test injection API
    ├── test-retrieval.sh   # Test retrieval API
    └── api-examples.md     # API reference with curl examples
```

---

## What's Included

✅ **Zero Dependencies** - Only Node.js built-ins
✅ **8 Passing Tests** - Comprehensive test coverage
✅ **Abstract Architecture** - Extensible design
✅ **HTTP Server** - Ready to deploy
✅ **Complete Documentation** - README + examples
✅ **Production Ready (Phase 1)** - Well-tested code

---

## Common Tasks

### Run only tests
```bash
node rag-server.js --test
```

### Run server on custom port
```bash
node rag-server.js --server --port 8080
```

### Test injection endpoint
```bash
curl -X POST http://localhost:3000/inject \
  -H "Content-Type: application/json" \
  -d '{"folderPath": "/path/to/docs"}'
```

### Test retrieval endpoint
```bash
curl -X POST http://localhost:3000/retrieve \
  -H "Content-Type: application/json" \
  -d '{"query": "your query here", "topK": 5}'
```

### Get vector store stats
```bash
curl http://localhost:3000/stats
```

---

## Performance Expectations

- **Injection (3 documents)**: ~15ms
- **Retrieval (similarity search)**: 1-3ms
- **Health check**: <1ms

These are fast because they're mocks. Real API calls will be slower.

---

## Support & Next Steps

1. **Phase 1 (you are here)**: POC with mocks ✅
2. **Phase 2**: Connect real APIs (Gemini, Chroma, Novita)
3. **Phase 3**: File watching, metadata extraction, CLI
4. **Phase 4**: Production deployment, monitoring, scaling

---

**Status**: ✅ Phase 1 Complete - All tests passing, ready for Phase 2

Generated: 2026-05-20
