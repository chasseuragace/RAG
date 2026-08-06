/**
 * Live Chroma test for the one capability the mock can't prove: filtered
 * delete-by-doc-id (DELETE where original_id == X). Requires a running Chroma
 * (docker compose up). Uses deterministic dummy vectors — no Gemini needed.
 *
 * Run: node rag-server.js --chroma-test
 */
const { ChromaVectorStore } = require('../src/retrieval/stores/chroma');

// Tiny deterministic embedding so we don't need a real embedder.
function vec(seed, dim = 8) {
  return Array.from({ length: dim }, (_, i) => Math.sin(seed * 7.1 + i) * 0.5 + 0.5);
}

async function runChromaTests() {
  const assert = (cond, msg) => {
    if (!cond) { console.error(`  ✗ ${msg}`); throw new Error(`FAIL: ${msg}`); }
    console.log(`  ✓ ${msg}`);
  };

  const store = new ChromaVectorStore('http://localhost:8000', 'rag_delete_test');

  console.log('\n[chroma] Setup: clear test collection');
  await store.clear();

  console.log('\n[chroma] Store 3 chunks across 2 docs (a:2, b:1)');
  await store.store('a_chunk_0', vec(1), { original_id: 'a', content: 'alpha 0' });
  await store.store('a_chunk_1', vec(2), { original_id: 'a', content: 'alpha 1' });
  await store.store('b_chunk_0', vec(3), { original_id: 'b', content: 'beta 0' });
  let stats = await store.getStats();
  assert(stats.totalDocuments === 3, `store holds 3 chunks (got ${stats.totalDocuments})`);

  console.log('\n[chroma] deleteByDocId("a") — only doc a chunks should go');
  await store.deleteByDocId('a');
  stats = await store.getStats();
  assert(stats.totalDocuments === 1, `1 chunk remains after deleting doc a (got ${stats.totalDocuments})`);

  const res = await store.query(vec(3), 5);
  assert(res.length === 1 && res[0].id === 'b_chunk_0', 'remaining chunk is b_chunk_0');
  assert(res.every(r => r.id.indexOf('a_chunk') !== 0), 'no doc-a chunks survive the filtered delete');

  console.log('\n[chroma] Orphan case: doc a re-added with fewer chunks');
  await store.store('a_chunk_0', vec(4), { original_id: 'a', content: 'A0' });
  await store.store('a_chunk_1', vec(5), { original_id: 'a', content: 'A1' });
  await store.store('a_chunk_2', vec(6), { original_id: 'a', content: 'A2' });
  assert((await store.getStats()).totalDocuments === 4, 'a has 3 chunks again (b + a*3 = 4)');
  await store.deleteByDocId('a');                                  // delete-before-insert
  await store.store('a_chunk_0', vec(7), { original_id: 'a', content: 'A0 only' });
  stats = await store.getStats();
  assert(stats.totalDocuments === 2, `shrunk doc leaves no orphans (b + a*1 = 2, got ${stats.totalDocuments})`);

  console.log('\n[chroma] Teardown: drop test collection');
  await store.clear();

  console.log('\n✅ All Chroma delete tests passed\n');
}

module.exports = { runChromaTests };
