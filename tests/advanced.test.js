const { TestRunner } = require('./runner');
const { MockEmbedder } = require('../src/embedders/mock');
const { MockVectorStore } = require('../src/stores/mock');
const { BM25Store } = require('../src/stores/bm25');
const { HybridStore } = require('../src/stores/hybrid');
const { MockReranker } = require('../src/rerankers/mock');
const { AgenticRetrievalPipeline } = require('../src/pipelines/agentic-retrieval');
const { HeuristicRetrievalStrategy } = require('../src/agentic/strategies/heuristic');
const { StubRetrievalStrategy } = require('../src/agentic/strategies/stub');
const { ConstrainedPlanner } = require('../src/agentic/planner');
const { RetrievalJudge } = require('../src/agentic/judge');
const { Observation } = require('../src/agentic/observation');

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

function setupStore(embedder) {
  const v = new MockVectorStore();
  const b = new BM25Store();
  const h = new HybridStore(v, b);
  const docs = [
    ['dl1', 'deep learning neural networks explained', 'deep learning neural networks explained'],
    ['dl2', 'machine learning algorithms and models', 'machine learning algorithms and models'],
    ['dl3', 'python tutorial for beginners', 'python tutorial for beginners'],
  ];
  for (const [id, text, content] of docs) {
    h.store(id, embedder.embed(text), { original_id: id, content });
  }
  return h;
}

async function setupTests() {
  const runner = new TestRunner();

  runner.test('MockEmbedder produces content-correlated embeddings', async (a) => {
    const embedder = new MockEmbedder();
    const v1 = await embedder.embed('deep learning neural networks explained');
    const v2 = await embedder.embed('machine learning algorithms and models');
    const v3 = await embedder.embed('python tutorial for beginners');
    const sim12 = cosine(v1, v2);
    const sim13 = cosine(v1, v3);
    await a.assertTrue(sim12 > sim13, `similar texts (${sim12.toFixed(3)}) score higher than unrelated (${sim13.toFixed(3)})`);
    await a.assertTrue(sim12 > 0.05, 'shared-vocabulary similarity is above noise');
    const v1b = await embedder.embed('deep learning neural networks explained');
    await a.assertEqual(v1[0], v1b[0], 'same text produces identical embedding');
    await a.assertEqual(v1.length, 384, 'embedding dimension is 384');
  });

  runner.test('MockEmbedder is deterministic across separate instances', async (a) => {
    const e1 = new MockEmbedder();
    const e2 = new MockEmbedder();
    const v1 = await e1.embed('machine learning algorithms and models');
    const v2 = await e2.embed('machine learning algorithms and models');
    for (let i = 0; i < v1.length; i++) await a.assertEqual(v1[i], v2[i], `dim ${i} matches across instances`);
  });

  runner.test('BM25Store indexes and retrieves by keyword relevance', async (a) => {
    const bm25 = new BM25Store();
    await bm25.index('d1', 'cats and dogs are popular pets', { original_id: 'd1' });
    await bm25.index('d2', 'the quick brown fox jumps over the lazy dog', { original_id: 'd2' });
    await bm25.index('d3', 'dogs make great companions and loyal friends', { original_id: 'd3' });
    const results = await bm25.search('dogs pets', 2);
    await a.assertEqual(results.length, 2);
    const ids = results.map(r => r.id).sort();
    await a.assertEqual(ids[0], 'd1');
    await a.assertEqual(ids[1], 'd3');
    await a.assertTrue(results[0].score > 0);
  });

  runner.test('BM25Store deleteByDocId removes postings and recalculates stats', async (a) => {
    const bm25 = new BM25Store();
    await bm25.index('d1', 'cats and dogs', { original_id: 'd1' });
    await bm25.index('d2', 'dogs and cats', { original_id: 'd2' });
    const removed = await bm25.deleteByDocId('d1');
    await a.assertTrue(removed >= 1);
    const stats = await bm25.getStats();
    await a.assertEqual(stats.totalDocuments, 1);
  });

  runner.test('HybridStore fuses vector and BM25 results with RRF', async (a) => {
    const embedder = new MockEmbedder();
    const v = new MockVectorStore();
    const b = new BM25Store();
    const h = new HybridStore(v, b);
    await h.store('d1', await embedder.embed('cats and dogs are pets'), { original_id: 'd1', content: 'cats and dogs' });
    await h.store('d2', await embedder.embed('dogs and cats friendship'), { original_id: 'd2', content: 'dogs and cats friendship' });
    await h.store('d3', await embedder.embed('the quick brown fox'), { original_id: 'd3', content: 'the quick fox' });
    const results = await h.search(await embedder.embed('dogs'), 'dogs', 2);
    await a.assertEqual(results.length, 2);
    await a.assertTrue(results.some(r => r.id === 'd1'));
    await a.assertTrue(results.some(r => r.id === 'd2'));
    await a.assertTrue(typeof results[0].score === 'number');
    await a.assertTrue(results[0].rrfRank >= 1);
  });

  runner.test('HybridStore delegates clear and getStats to both stores', async (a) => {
    const embedder = new MockEmbedder();
    const v = new MockVectorStore();
    const b = new BM25Store();
    const h = new HybridStore(v, b);
    await h.store('d1', await embedder.embed('alpha'), { original_id: 'd1', content: 'alpha' });
    let stats = await h.getStats();
    await a.assertEqual(stats.totalDocuments, 1);
    await a.assertEqual(stats.bm25Documents, 1);
    await h.clear();
    stats = await h.getStats();
    await a.assertEqual(stats.totalDocuments, 0);
    await a.assertEqual(stats.bm25Documents, 0);
  });

  runner.test('MockReranker changes rank order based on word overlap', async (a) => {
    const reranker = new MockReranker();
    const docs = [
      { id: 'd1', score: 0.95, metadata: { content: 'unrelated astronomy facts about stars', original_id: 'd1' } },
      { id: 'd2', score: 0.85, metadata: { content: 'cats and dogs information for pet owners', original_id: 'd2' } },
      { id: 'd3', score: 0.75, metadata: { content: 'about feline animals and their habits', original_id: 'd3' } },
    ];
    const reranked = await reranker.rerank('cats dogs', docs);
    await a.assertEqual(reranked[0].id, 'd2');
    await a.assertTrue(reranked[0].score > reranked[1].score);
    await a.assertTrue(reranked[0].rerankReason.includes('overlap'));
  });

  runner.test('ConstrainedPlanner decides actions based on evidence state', async (a) => {
    const planner = new ConstrainedPlanner({ minResultsForAnswer: 2, lowScoreThreshold: 0.3, mediumScoreThreshold: 0.5 });

    const noResults = await planner.decide({ query: 'test', results: [], rerankedResults: [], previousActions: [{ type: 'search' }], topScore: 0, iteration: 1 });
    await a.assertEqual(noResults.type, 'stop');

    const lowScore = await planner.decide({ query: 'test', results: [{ score: 0.2 }], rerankedResults: [{ score: 0.2 }], previousActions: [], topScore: 0.2 });
    await a.assertEqual(lowScore.type, 'increase_topk');

    const sufficient = await planner.decide({ query: 'test', results: [{ score: 0.8 }, { score: 0.6 }], rerankedResults: [{ score: 0.8 }, { score: 0.6 }], previousActions: [], topScore: 0.8 });
    await a.assertEqual(sufficient.type, 'answer');
  });

  runner.test('RetrievalJudge evaluates evidence without hallucinating', async (a) => {
    const judge = new RetrievalJudge({ sufficientThreshold: 0.6, minDocsForSufficiency: 2 });

    const empty = await judge.evaluate({ query: 'deep learning', results: [], rerankedResults: [] });
    await a.assertTrue(!empty.sufficient);
    await a.assertTrue(empty.missing.includes('no_retrieved_documents'));

    const partial = await judge.evaluate({ query: 'deep learning', results: [{ score: 0.9, metadata: { content: 'deep learning neural networks' } }], rerankedResults: [{ score: 0.9, metadata: { content: 'deep learning neural networks' } }] });
    await a.assertTrue(!partial.sufficient);
    await a.assertTrue(partial.missing.includes('only_1_document_found'));

    const good = await judge.evaluate({ query: 'deep learning', results: [{ score: 0.8 }, { score: 0.6 }], rerankedResults: [{ score: 0.8 }, { score: 0.6 }] });
    await a.assertTrue(good.sufficient);
    await a.assertTrue(good.quality > 0.6);
  });

  runner.test('AgenticRetrievalPipeline answers immediately when strategy returns finalAction', async (a) => {
    const e = new MockEmbedder();
    const h = setupStore(e);
    const reranker = new MockReranker();
    const strategy = new StubRetrievalStrategy([
      { finalAction: { type: 'answer', reason: 'sufficient_evidence: 2 docs, topScore=0.85' }, retrievalQuality: 0.85, missingEvidence: [], rerankedResults: [
        { id: 'dl1', score: 0.85, metadata: { content: 'deep learning neural networks explained', original_id: 'dl1' }, rerankReason: 'overlap=2,factor=1.00' },
        { id: 'dl2', score: 0.72, metadata: { content: 'machine learning algorithms and models', original_id: 'dl2' }, rerankReason: 'overlap=1,factor=0.50' },
      ], steps: [{ type: 'search', query: 'deep learning', resultCount: 2, reason: 'init' }] },
    ]);
    const pipeline = new AgenticRetrievalPipeline(e, h, reranker, strategy, 4);
    const result = await pipeline.run('deep learning', 2);
    await a.assertTrue(result.success);
    await a.assertEqual(result.finalAction.type, 'answer');
    await a.assertEqual(result.finalAction.reason, 'sufficient_evidence: 2 docs, topScore=0.85');
    await a.assertTrue(result.retrievalQuality, 0.85);
    await a.assertEqual(result.resultsCount, 2, 'returns results from strategy');
    await a.assertEqual(result.steps.length, 1, 'records the single search step');
  });

  runner.test('AgenticRetrievalPipeline stops when strategy returns stop action', async (a) => {
    const e = new MockEmbedder();
    const h = setupStore(e);
    const reranker = new MockReranker();
    const strategy = new StubRetrievalStrategy([
      { finalAction: { type: 'stop', reason: 'no_results_after_retrieval' }, retrievalQuality: 0, missingEvidence: ['no_retrieved_documents'], steps: [] },
    ]);
    const pipeline = new AgenticRetrievalPipeline(e, h, reranker, strategy, 4);
    const result = await pipeline.run('unknown topic xyz', 2);
    await a.assertTrue(result.success);
    await a.assertEqual(result.finalAction.type, 'stop');
    await a.assertEqual(result.finalAction.reason, 'no_results_after_retrieval');
    await a.assertTrue(Array.isArray(result.missingEvidence));
  });

  runner.test('AgenticRetrievalPipeline records multi-step actions from strategy', async (a) => {
    const e = new MockEmbedder();
    const h = setupStore(e);
    const reranker = new MockReranker();
    const strategy = new StubRetrievalStrategy([
      { steps: [{ type: 'search', reason: 'initial retrieval' }] },
      { steps: [{ type: 'increase_topk', reason: 'low relevance' }] },
      { steps: [{ type: 'search', reason: 'expanded recall' }] },
      { finalAction: { type: 'answer', reason: 'sufficient_evidence' }, retrievalQuality: 0.75, missingEvidence: [] },
    ]);
    const pipeline = new AgenticRetrievalPipeline(e, h, reranker, strategy, 4);
    const result = await pipeline.run('deep learning', 2);
    await a.assertTrue(result.success);
    await a.assertEqual(result.finalAction.type, 'answer');
    await a.assertTrue(result.steps.length >= 3, 'records multiple action steps');
    const actionTypes = result.steps.map(s => s.type);
    await a.assertTrue(actionTypes.includes('search'), 'includes search action');
    await a.assertTrue(actionTypes.includes('increase_topk'), 'includes increase_topk action');
    await a.assertTrue(result.steps.some(s => s.reason), 'each step has a reason');
  });

  runner.test('AgenticRetrievalPipeline handles empty corpus gracefully', async (a) => {
    const e = new MockEmbedder();
    const v = new MockVectorStore();
    const b = new BM25Store();
    const h = new HybridStore(v, b);
    const reranker = new MockReranker();
    const strategy = new HeuristicRetrievalStrategy(e, h, reranker);
    const pipeline = new AgenticRetrievalPipeline(e, h, reranker, strategy, 2);
    const result = await pipeline.run('deep learning', 2);
    await a.assertTrue(result.success, 'does not throw on empty corpus');
    await a.assertTrue(result.steps.length > 0, 'records at least one step');
    await a.assertTrue(result.finalAction && result.finalAction.type === 'stop', 'stops on empty corpus');
  });

  runner.test('AgenticRetrievalPipeline is deterministic for identical inputs', async (a) => {
    const e = new MockEmbedder();
    const h1 = setupStore(e);
    const reranker = new MockReranker();
    const strategy1 = new HeuristicRetrievalStrategy(e, h1, reranker);
    const pipeline1 = new AgenticRetrievalPipeline(e, h1, reranker, strategy1, 2);
    const r1 = await pipeline1.run('deep learning', 2);

    const h2 = setupStore(e);
    const strategy2 = new HeuristicRetrievalStrategy(e, h2, reranker);
    const pipeline2 = new AgenticRetrievalPipeline(e, h2, reranker, strategy2, 2);
    const r2 = await pipeline2.run('deep learning', 2);

    await a.assertEqual(r1.steps.length, r2.steps.length);
    await a.assertEqual(r1.finalAction.type, r2.finalAction.type);
    await a.assertEqual(r1.resultsCount, r2.resultsCount);
  });

  runner.test('BM25Store is deterministic across multiple runs', async (a) => {
    const bm25 = new BM25Store();
    await bm25.index('d1', 'reproducibility is key to scientific experiments', { original_id: 'd1' });
    await bm25.index('d2', 'random numbers should be deterministic in tests', { original_id: 'd2' });
    const run1 = await bm25.search('reproducibility deterministic tests', 2);
    const run2 = await bm25.search('reproducibility deterministic tests', 2);
    await a.assertEqual(run1[0].id, run2[0].id);
    await a.assertEqual(run1[0].score, run2[0].score);
  });

  runner.test('HybridStore search is deterministic for fixed inputs', async (a) => {
    const e = new MockEmbedder();
    const v = new MockVectorStore();
    const b = new BM25Store();
    const h = new HybridStore(v, b);
    await h.store('d1', await e.embed('alpha beta gamma'), { original_id: 'd1', content: 'alpha beta gamma' });
    await h.store('d2', await e.embed('delta epsilon zeta'), { original_id: 'd2', content: 'delta epsilon zeta' });
    const r1 = await h.search(await e.embed('alpha'), 'alpha', 1);
    const r2 = await h.search(await e.embed('alpha'), 'alpha', 1);
    await a.assertEqual(r1[0].id, r2[0].id);
    await a.assertEqual(r1[0].score, r2[0].score);
  });

  runner.test('HeuristicRetrievalStrategy returns explicit finalAction and quality', async (a) => {
    const e = new MockEmbedder();
    const h = setupStore(e);
    const reranker = new MockReranker();
    const strategy = new HeuristicRetrievalStrategy(e, h, reranker, { sufficientThreshold: 0.15, minDocsForAnswer: 1, minDocsForSufficiency: 1 });
    const obs = await strategy.run(Observation.create('deep learning', 2), 2);
    await a.assertTrue(obs.finalAction && obs.finalAction.type, 'finalAction is set');
    await a.assertTrue(typeof obs.retrievalQuality === 'number', 'retrievalQuality is numeric');
    await a.assertTrue(Array.isArray(obs.missingEvidence), 'missingEvidence is array');
  });

  return runner;
}

module.exports = { setupTests };
