/**
 * Mock unit tests — no external services. Exercises chunking, the mock
 * embedder/store, deleteByDocId, and the registry diff classifier.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const { TestRunner } = require('./runner');
const { chunkText } = require('../src/shared/chunker');
const { DocRegistry, hashContent } = require('../src/ingestion/registry');
const { MockEmbedder } = require('../src/retrieval/embedders/mock');
const { MockVectorStore } = require('../src/retrieval/stores/mock');

async function setupTests() {
  const runner = new TestRunner();

  runner.test('chunkText returns a single chunk for short text', async (a) => {
    const c = chunkText('hello world', 1000, 200);
    await a.assertEqual(c.length, 1, 'short text => 1 chunk');
  });

  runner.test('chunkText splits long text into multiple chunks', async (a) => {
    const c = chunkText('A'.repeat(2500), 1000, 200);
    await a.assertTrue(c.length >= 3, 'long text => 3+ chunks');
  });

  runner.test('MockEmbedder produces deterministic 384-dim vectors', async (a) => {
    const e = new MockEmbedder();
    const v1 = await e.embed('hello');
    const v2 = await e.embed('hello');
    await a.assertEqual(v1.length, 384, 'embedding is 384-dim');
    await a.assertTrue(v1.every((x, i) => x === v2[i]), 'same text => same vector');
  });

  runner.test('MockVectorStore stores and retrieves by similarity', async (a) => {
    const e = new MockEmbedder();
    const s = new MockVectorStore();
    await s.store('d1', await e.embed('cats and dogs'), { original_id: 'd1', content: 'cats and dogs' });
    const res = await s.query(await e.embed('cats and dogs'), 1);
    await a.assertEqual(res[0].id, 'd1', 'returns the stored doc');
    await a.assertTrue(res[0].score > 0.99, 'identical query => near-perfect score');
  });

  runner.test('deleteByDocId removes only the matching doc chunks', async (a) => {
    const e = new MockEmbedder();
    const s = new MockVectorStore();
    await s.store('a_chunk_0', await e.embed('x'), { original_id: 'a' });
    await s.store('a_chunk_1', await e.embed('y'), { original_id: 'a' });
    await s.store('b_chunk_0', await e.embed('z'), { original_id: 'b' });
    const removed = await s.deleteByDocId('a');
    const stats = await s.getStats();
    await a.assertEqual(removed, 2, 'removes both chunks of doc a');
    await a.assertEqual(stats.totalDocuments, 1, 'only doc b remains');
  });

  runner.test('DocRegistry.diff classifies added/unchanged/changed/removed', async (a) => {
    const tmp = path.join(os.tmpdir(), `reg-mock-${process.pid}.json`);
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    const reg = new DocRegistry(tmp);

    let d = reg.diff([{ id: 'f', content: 'v1' }]);
    await a.assertEqual(d.added.length, 1, 'unseen file => added');

    reg.set('f', { hash: hashContent('v1') });
    d = reg.diff([{ id: 'f', content: 'v1' }]);
    await a.assertEqual(d.unchanged.length, 1, 'same content => unchanged');

    d = reg.diff([{ id: 'f', content: 'v2' }]);
    await a.assertEqual(d.changed.length, 1, 'new content => changed');

    d = reg.diff([]);
    await a.assertEqual(d.removed.length, 1, 'missing file => removed');

    fs.unlinkSync(tmp);
  });

  return runner;
}

module.exports = { setupTests };
