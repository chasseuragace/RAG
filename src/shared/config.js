/**
 * Centralized configuration + one-time directory bootstrap.
 * Reading env happens here so the rest of the code imports plain constants.
 */
const fs = require('fs');
const path = require('path');

const INPUT_DIR = process.env.RAG_INPUT_DIR || './input';
// @gotcha `parseInt(env) || default` treats `0` as falsy, so RAG_CHUNK_SIZE=0
//       silently falls back to 1000. Use a sentinel check if 0 is meaningful.
const CHUNK_SIZE = parseInt(process.env.RAG_CHUNK_SIZE) || 1000;
const CHUNK_OVERLAP = parseInt(process.env.RAG_CHUNK_OVERLAP) || 200;
const CONVERSATIONS_DIR = './conversations';
const REGISTRY_FILE = process.env.RAG_REGISTRY_FILE || './data/doc-registry.json';
const GOLDEN_DATASET_FILE = process.env.RAG_GOLDEN_DATASET_FILE || './data/golden-decisions.json';

const NEO4J_URI = process.env.RAG_NEO4J_URI || 'bolt://localhost:7687';
const NEO4J_USER = process.env.RAG_NEO4J_USER || 'neo4j';
const NEO4J_PASSWORD = process.env.RAG_NEO4J_PASSWORD || 'neo4j_password';
const PG_CONNECTION_STRING = process.env.RAG_PG_CONNECTION_STRING || 'postgresql://rag_user:rag_password@localhost:5432/rag_system';

// Expert mode enables advanced UI panels (capture fixture, replay harness).
// @gotcha Enabled by default — only disabled when explicitly set to the string "false".
//       Empty string, "0", "no", etc. all enable it.
const EXPERT_MODE = process.env.RAG_EXPERT_MODE !== 'false';

// Context Window Management
const MODEL_CONTEXT_WINDOW = parseInt(process.env.RAG_MODEL_CONTEXT_WINDOW) || 128000;
const SYSTEM_TOKEN_BUDGET = parseInt(process.env.RAG_SYSTEM_TOKEN_BUDGET) || 500;
const RESPONSE_MAX_TOKENS = parseInt(process.env.RAG_RESPONSE_MAX_TOKENS) || 1000;
const MIN_MESSAGES_TO_KEEP = parseInt(process.env.RAG_MIN_MESSAGES_TO_KEEP) || 3;
const SUMMARY_MAX_TOKENS = parseInt(process.env.RAG_SUMMARY_MAX_TOKENS) || 200;
const BASE_SYSTEM_PROMPT = process.env.RAG_BASE_SYSTEM_PROMPT || 'You are a helpful AI assistant. Use ONLY the provided context to answer. If unknown, say so.';

// Feature flag for new context-aware chat flow
const USE_NEW_CONTEXT = process.env.USE_NEW_CONTEXT === 'true';

// Ensure directories exist
if (!fs.existsSync(INPUT_DIR)) fs.mkdirSync(INPUT_DIR, { recursive: true });
if (!fs.existsSync(CONVERSATIONS_DIR)) fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
if (!fs.existsSync(path.dirname(REGISTRY_FILE))) fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true });

module.exports = { INPUT_DIR, CHUNK_SIZE, CHUNK_OVERLAP, CONVERSATIONS_DIR, REGISTRY_FILE, GOLDEN_DATASET_FILE, EXPERT_MODE, NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD, PG_CONNECTION_STRING, MODEL_CONTEXT_WINDOW, SYSTEM_TOKEN_BUDGET, RESPONSE_MAX_TOKENS, MIN_MESSAGES_TO_KEEP, SUMMARY_MAX_TOKENS, BASE_SYSTEM_PROMPT, USE_NEW_CONTEXT };
