/**
 * Centralized configuration + one-time directory bootstrap.
 * Reading env happens here so the rest of the code imports plain constants.
 */
const fs = require('fs');
const path = require('path');

const INPUT_DIR = process.env.RAG_INPUT_DIR || './input';
const CHUNK_SIZE = parseInt(process.env.RAG_CHUNK_SIZE) || 1000;      // characters
const CHUNK_OVERLAP = parseInt(process.env.RAG_CHUNK_OVERLAP) || 200;
const CONVERSATIONS_DIR = './conversations';
const REGISTRY_FILE = process.env.RAG_REGISTRY_FILE || './data/doc-registry.json';
const GOLDEN_DATASET_FILE = process.env.RAG_GOLDEN_DATASET_FILE || './data/golden-decisions.json';

// Ensure directories exist
if (!fs.existsSync(INPUT_DIR)) fs.mkdirSync(INPUT_DIR, { recursive: true });
if (!fs.existsSync(CONVERSATIONS_DIR)) fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
if (!fs.existsSync(path.dirname(REGISTRY_FILE))) fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true });

module.exports = { INPUT_DIR, CHUNK_SIZE, CHUNK_OVERLAP, CONVERSATIONS_DIR, REGISTRY_FILE, GOLDEN_DATASET_FILE };
