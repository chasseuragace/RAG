#!/usr/bin/env node

/**
 * RAG System — CLI entry point.
 *
 * The implementation lives under src/ (config, events, core, loaders,
 * embedders, stores, inference, pipelines, server) and tests under tests/.
 * This file only parses argv and dispatches.
 *
 * - Real mode: Gemini embeddings, Chroma, Novita DeepSeek
 * - Injection: full rebuild (/inject) or differential sync (/inject-incremental)
 * - Conversation history (JSON file based) for /ask endpoint
 * - Hardcoded input directory: ./input (override via RAG_INPUT_DIR env)
 */

const { RAGServer } = require('./src/server');
const { serverEvents } = require('./src/events');
const { ConversationStore } = require('./src/core/conversation');
const { DocRegistry } = require('./src/core/registry');
const { chunkText } = require('./src/core/chunker');
const { setupTests } = require('./tests/mock.test');
const { setupRealTests } = require('./tests/real.test');
const { runDeltaTests } = require('./tests/delta.test');

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--delta-test')) {
    try { await runDeltaTests(); process.exit(0); }
    catch (e) { console.error('\n❌ Delta tests failed:', e.message); process.exit(1); }
  } else if (args.includes('--test')) {
    const runner = await setupTests();
    const ok = await runner.run();
    process.exit(ok ? 0 : 1);
  } else if (args.includes('--real-test')) {
    try {
      const runner = await setupRealTests();
      const ok = await runner.run();
      process.exit(ok ? 0 : 1);
    } catch(e) { console.error(e); process.exit(1); }
  } else if (args.includes('--server')) {
    const port = args.includes('--port') ? parseInt(args[args.indexOf('--port')+1]) : 3000;
    const isReal = args.includes('--real');
    const server = new RAGServer(port, isReal);
    await server.initialize();
    server.start();
  } else {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║   RAG System with WebSocket + Chunking + Conversation       ║
╚══════════════════════════════════════════════════════════════╝

Usage:
  node rag-server.js --test               Run mock tests
  node rag-server.js --delta-test         Run incremental-sync (delta) tests
  node rag-server.js --real-test          Run real integration tests
  node rag-server.js --server             Start mock server (port 3000)
  node rag-server.js --server --real      Start real server (Gemini+Chroma+Novita)
  node rag-server.js --server --port 8080 Use custom port

Endpoints:
  POST /inject               Full rebuild (clear + embed everything)
  POST /inject-incremental   Differential sync (only re-embed the delta)
  POST /retrieve             Vector search
  POST /ask                  Retrieve + generate answer with history

Environment variables:
  RAG_INPUT_DIR     = ./input   (directory with .md files)
  RAG_CHUNK_SIZE    = 1000      (characters per chunk)
  RAG_CHUNK_OVERLAP = 200
  RAG_REGISTRY_FILE = ./data/doc-registry.json
  GEMINI_API_KEY    = ...
  NOVITA_API_KEY    = ...
    `);
  }
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

module.exports = { RAGServer, serverEvents, ConversationStore, DocRegistry, chunkText };
