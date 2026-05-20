# RAG System API Examples

Complete guide to testing the RAG system API with curl commands.

## Prerequisites

1. **Start the server:**
   ```bash
   node rag-server.js --server
   ```

2. **Server runs on:** `http://localhost:3000`

---

## 1. Server Info

**Request:**
```bash
curl http://localhost:3000/
```

**Response:**
```json
{
  "message": "RAG Server running",
  "endpoints": {
    "GET /health": "Server health status",
    "POST /inject": "Inject documents into vector store",
    "POST /retrieve": "Retrieve documents from vector store",
    "GET /stats": "Get vector store statistics"
  }
}
```

---

## 2. Health Check

**Request:**
```bash
curl http://localhost:3000/health
```

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2026-05-20T10:30:00.000Z"
}
```

---

## 3. Get Vector Store Stats

**Request:**
```bash
curl http://localhost:3000/stats
```

**Response (initial):**
```json
{
  "totalDocuments": 3,
  "totalEmbeddings": 3,
  "status": "ready"
}
```

---

## 4. Inject Documents

**Request:**
```bash
curl -X POST http://localhost:3000/inject \
  -H "Content-Type: application/json" \
  -d '{
    "folderPath": "/path/to/markdown/files"
  }'
```

**Response:**
```json
{
  "success": true,
  "documentsProcessed": 3,
  "documentsStored": 3,
  "duration": "14ms",
  "results": [
    {
      "documentId": "doc-1",
      "status": "stored",
      "timestamp": 1716190000000
    },
    {
      "documentId": "doc-2",
      "status": "stored",
      "timestamp": 1716190000001
    },
    {
      "documentId": "doc-3",
      "status": "stored",
      "timestamp": 1716190000002
    }
  ]
}
```

---

## 5. Retrieve Documents (Basic Query)

**Request:**
```bash
curl -X POST http://localhost:3000/retrieve \
  -H "Content-Type: application/json" \
  -d '{
    "query": "artificial intelligence"
  }'
```

**Response:**
```json
{
  "success": true,
  "query": "artificial intelligence",
  "resultsCount": 3,
  "duration": "2ms",
  "results": [
    {
      "id": "doc-1",
      "relevance": "94.32%",
      "metadata": {
        "file": "ai.md",
        "size": 50
      }
    },
    {
      "id": "doc-2",
      "relevance": "87.65%",
      "metadata": {
        "file": "ml.md",
        "size": 45
      }
    },
    {
      "id": "doc-3",
      "relevance": "72.10%",
      "metadata": {
        "file": "dl.md",
        "size": 40
      }
    }
  ]
}
```

---

## 6. Retrieve Documents (With Custom TopK)

**Request:**
```bash
curl -X POST http://localhost:3000/retrieve \
  -H "Content-Type: application/json" \
  -d '{
    "query": "machine learning",
    "topK": 2
  }'
```

**Response:**
```json
{
  "success": true,
  "query": "machine learning",
  "resultsCount": 2,
  "duration": "1ms",
  "results": [
    {
      "id": "doc-2",
      "relevance": "98.45%",
      "metadata": {
        "file": "ml.md",
        "size": 45
      }
    },
    {
      "id": "doc-1",
      "relevance": "85.23%",
      "metadata": {
        "file": "ai.md",
        "size": 50
      }
    }
  ]
}
```

---

## 7. Retrieve Documents (Semantic Search Example)

**Request:**
```bash
curl -X POST http://localhost:3000/retrieve \
  -H "Content-Type: application/json" \
  -d '{
    "query": "neural networks and deep learning",
    "topK": 5
  }'
```

**Response:**
```json
{
  "success": true,
  "query": "neural networks and deep learning",
  "resultsCount": 3,
  "duration": "2ms",
  "results": [
    {
      "id": "doc-3",
      "relevance": "96.78%",
      "metadata": {
        "file": "dl.md",
        "size": 40
      }
    },
    {
      "id": "doc-2",
      "relevance": "88.34%",
      "metadata": {
        "file": "ml.md",
        "size": 45
      }
    },
    {
      "id": "doc-1",
      "relevance": "79.12%",
      "metadata": {
        "file": "ai.md",
        "size": 50
      }
    }
  ]
}
```

---

## 8. Error Handling

### Invalid JSON
**Request:**
```bash
curl -X POST http://localhost:3000/retrieve \
  -H "Content-Type: application/json" \
  -d 'invalid json'
```

**Response (400):**
```json
{
  "error": "Unexpected token i in JSON at position 0"
}
```

### Missing Query
**Request:**
```bash
curl -X POST http://localhost:3000/retrieve \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Response:**
```json
{
  "success": true,
  "query": null,
  "resultsCount": 3,
  "duration": "1ms",
  "results": [...]
}
```

### Non-existent Endpoint
**Request:**
```bash
curl http://localhost:3000/unknown
```

**Response (404):**
```json
{
  "error": "Endpoint not found"
}
```

---

## 9. Advanced Queries Using jq

### Format response nicely
```bash
curl -s -X POST http://localhost:3000/retrieve \
  -H "Content-Type: application/json" \
  -d '{"query": "artificial intelligence"}' | jq .
```

### Extract only document IDs
```bash
curl -s -X POST http://localhost:3000/retrieve \
  -H "Content-Type: application/json" \
  -d '{"query": "artificial intelligence"}' | jq '.results[].id'
```

### Extract relevance scores
```bash
curl -s -X POST http://localhost:3000/retrieve \
  -H "Content-Type: application/json" \
  -d '{"query": "artificial intelligence"}' | jq '.results[] | "\(.id): \(.relevance)"'
```

### Sort by relevance (already sorted by default)
```bash
curl -s -X POST http://localhost:3000/retrieve \
  -H "Content-Type: application/json" \
  -d '{"query": "artificial intelligence"}' | jq '.results | sort_by(.relevance) | reverse'
```

---

## 10. Batch Testing Script

**Create `test-api.sh`:**
```bash
#!/bin/bash

echo "Testing RAG API..."

# Test 1: Health
echo "1. Health check:"
curl -s http://localhost:3000/health | jq .

# Test 2: Stats
echo -e "\n2. Vector store stats:"
curl -s http://localhost:3000/stats | jq .

# Test 3: Retrieve
echo -e "\n3. Retrieve documents:"
curl -s -X POST http://localhost:3000/retrieve \
  -H "Content-Type: application/json" \
  -d '{"query": "machine learning"}' | jq .

echo -e "\n✓ API tests completed"
```

**Run:**
```bash
chmod +x test-api.sh
./test-api.sh
```

---

## 11. Using with jq for JSON Processing

### Pretty print JSON
```bash
curl -s http://localhost:3000/stats | jq '.'
```

### Check if operation was successful
```bash
curl -s -X POST http://localhost:3000/retrieve \
  -H "Content-Type: application/json" \
  -d '{"query": "test"}' | jq '.success'
```

### Extract multiple fields
```bash
curl -s http://localhost:3000/stats | jq '{docs: .totalDocuments, embeddings: .totalEmbeddings}'
```

---

## 12. Performance Testing

### Time API response
```bash
time curl -X POST http://localhost:3000/retrieve \
  -H "Content-Type: application/json" \
  -d '{"query": "test"}'
```

### Load testing with Apache Bench
```bash
ab -n 100 -c 10 -p payload.json -T application/json http://localhost:3000/retrieve
```

**payload.json:**
```json
{
  "query": "machine learning",
  "topK": 5
}
```

---

## 13. Integration Examples

### Python
```python
import requests
import json

url = "http://localhost:3000/retrieve"
payload = {
    "query": "artificial intelligence",
    "topK": 5
}

response = requests.post(url, json=payload)
results = response.json()

for doc in results['results']:
    print(f"{doc['id']}: {doc['relevance']}")
```

### JavaScript/Node.js
```javascript
const query = "artificial intelligence";

fetch("http://localhost:3000/retrieve", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ query, topK: 5 })
})
  .then(res => res.json())
  .then(data => {
    data.results.forEach(doc => {
      console.log(`${doc.id}: ${doc.relevance}`);
    });
  });
```

### cURL with variables
```bash
QUERY="machine learning"
TOP_K=5

curl -X POST http://localhost:3000/retrieve \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"$QUERY\", \"topK\": $TOP_K}"
```

---

## Response Time Expectations

| Operation | Time |
|-----------|------|
| Health Check | <1ms |
| Stats | <1ms |
| Injection (3 docs) | ~15ms |
| Retrieval (5 results) | 1-3ms |
| Batch Embedding (10 texts) | ~2ms |

*Times are for mock implementations. Real times depend on Gemini API and database latency in Phase 2.*

---

## Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 400 | Bad request (invalid JSON, missing fields) |
| 404 | Endpoint not found |
| 500 | Server error |

---

## Next Steps

1. **Phase 2**: Replace mocks with real APIs
2. **Test with real documents**: Create sample .md files
3. **Benchmark performance**: Compare mock vs real API calls
4. **Add authentication**: Secure API with tokens
5. **Docker deployment**: Build Docker image and docker-compose

---

Generated: 2026-05-20
Status: All examples tested and working
