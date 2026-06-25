/**
 * Delta (incremental sync) tests — self-contained, no external services.
 * Covers the orphan-chunk case: a file that shrinks must not leave behind
 * chunks from its previous, larger version.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const { DocumentLoader } = require('../src/core/interfaces');
const { DocRegistry } = require('../src/core/registry');
const { MockEmbedder } = require('../src/embedders/mock');
const { MockVectorStore } = require('../src/stores/mock');
const { ConcreteInjectionPipeline } = require('../src/pipelines/injection');

async function runDeltaTests() {
  const assert = (cond, msg) => {
    if (!cond) { console.error(`  ✗ ${msg}`); throw new Error(`FAIL: ${msg}`); }
    console.log(`  ✓ ${msg}`);
  };
  const tmpRegistry = path.join(os.tmpdir(), `rag-delta-${process.pid}.json`);
  if (fs.existsSync(tmpRegistry)) fs.unlinkSync(tmpRegistry);

  const registry = new DocRegistry(tmpRegistry);
  const store = new MockVectorStore();
  const embedder = new MockEmbedder();

  // Loader whose returned documents we can mutate between runs.
  let currentDocs = [];
  const loader = new (class extends DocumentLoader {
    async loadDocuments() {
      return currentDocs.map(d => ({
        id: d.id, content: d.content,
        metadata: { file: d.id, path: d.id, size: d.content.length, mtime: 0 }
      }));
    }
  })();
  const pipeline = new ConcreteInjectionPipeline(loader, embedder, store);
  const countChunks = (docId) => [...store.docs.values()].filter(v => v.metadata.original_id === docId).length;

  console.log('\n[delta] Round 1: index a large doc (multiple chunks)');
  currentDocs = [{ id: 'doc1.md', content: 'A'.repeat(2500) }]; // > CHUNK_SIZE => several chunks
  await pipeline.runIncremental('/x', registry);
  const initialChunks = countChunks('doc1.md');
  assert(initialChunks >= 3, `large doc split into ${initialChunks} chunks (expected >= 3)`);
  assert(registry.get('doc1.md').chunkCount === initialChunks, 'registry records the chunk count');

  console.log('\n[delta] Round 2: re-run with no changes (should skip embedding)');
  const callsBefore = embedder.getCallCount();
  const r2 = await pipeline.runIncremental('/x', registry);
  assert(embedder.getCallCount() === callsBefore, 'unchanged doc triggered zero new embeddings');
  assert(r2.unchanged === 1 && r2.changed === 0 && r2.added === 0, 'diff classified the doc as unchanged');
  assert(countChunks('doc1.md') === initialChunks, 'chunk count unchanged');

  console.log('\n[delta] Round 3: file shrinks — orphan chunks must be removed');
  currentDocs = [{ id: 'doc1.md', content: 'tiny content' }]; // single chunk now
  const r3 = await pipeline.runIncremental('/x', registry);
  assert(r3.changed === 1, 'diff classified the doc as changed');
  assert(countChunks('doc1.md') === 1, `shrunk doc has exactly 1 chunk, ${initialChunks - 1} orphans removed`);

  console.log('\n[delta] Round 4: file removed — chunks and registry entry deleted');
  currentDocs = [];
  const r4 = await pipeline.runIncremental('/x', registry);
  assert(r4.removed === 1, 'diff classified the doc as removed');
  assert(countChunks('doc1.md') === 0, 'removed doc has no surviving chunks');
  assert(store.docs.size === 0, 'store is empty after removal');
  assert(registry.get('doc1.md') === undefined, 'registry entry deleted');

  console.log('\n[delta] Round 5: full run() rebuilds the registry to match');
  currentDocs = [{ id: 'a.md', content: 'alpha content' }, { id: 'b.md', content: 'beta content' }];
  await pipeline.run('/x', registry);
  assert(countChunks('a.md') === 1 && countChunks('b.md') === 1, 'full run embedded both docs');
  assert(!!registry.get('a.md') && !!registry.get('b.md'), 'registry populated by full run');

  console.log('\n[delta] Round 6: incremental right after full run re-embeds nothing');
  const callsBeforeInc = embedder.getCallCount();
  const r6 = await pipeline.runIncremental('/x', registry);
  assert(r6.added === 0 && r6.changed === 0 && r6.unchanged === 2, 'all docs classified unchanged');
  assert(embedder.getCallCount() === callsBeforeInc, 'zero embeddings after a full run (no double work)');

  fs.unlinkSync(tmpRegistry);
  console.log('\n✅ All delta tests passed\n');
}

module.exports = { runDeltaTests };
