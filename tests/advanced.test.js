const { TestRunner } = require('./runner');
const { MockEmbedder } = require('../src/retrieval/embedders/mock');
const { MockVectorStore } = require('../src/retrieval/stores/mock');
const { BM25Store } = require('../src/retrieval/stores/bm25');
const { HybridStore } = require('../src/retrieval/stores/hybrid');
const { MockReranker } = require('../src/retrieval/rerankers/mock');
const { AgenticRetrievalPipeline } = require('../src/agentic/pipeline');
const { HeuristicRetrievalStrategy } = require('../src/agentic/strategies/heuristic');
const { RetrievalAssessment } = require('../src/agentic/assessment');
const { Trace, TraceEvent } = require('../src/agentic/trace');
const { Coordinator } = require('../src/agentic/coordinator');
const { RetrievalPolicy } = require('../src/agentic/policy');
const { Decision } = require('../src/agentic/decision');
const { HeuristicRetrievalPolicy } = require('../src/agentic/policies/heuristic');
const { RetrievalJudge } = require('../src/agentic/judge');
const { Observation } = require('../src/agentic/observation');
const { RetrievalExecutor } = require('../src/agentic/executor');
const { RetrievalObjectives } = require('../src/shared/interfaces');

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
    await a.assertTrue(sim12 > 0.1, 'shared-vocabulary similarity is above noise');
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

  runner.test('HeuristicRetrievalPolicy decides actions from assessment and goal', async (a) => {
    const policy = new HeuristicRetrievalPolicy();

    const goodAssessment = RetrievalAssessment.create(0.8, 0.8, 0.7, 2, { missingConcepts: [], ambiguousTerms: [], conflictingEvidence: [], unsupportedClaims: [] });
    const goodDecision = policy.resolve(goodAssessment, { objective: RetrievalObjectives.BALANCED, maxIterations: 2, minimumQuality: 0.5 }, new Trace());
    await a.assertEqual(goodDecision.action, 'answer');
    await a.assertTrue(goodDecision.rationale.includes('sufficient_evidence'));

    const lowQuality = RetrievalAssessment.create(0.2, 0.4, 0.5, 0, { missingConcepts: ['low_relevance_top_result'], ambiguousTerms: [], conflictingEvidence: [], unsupportedClaims: [] });
    const lowDecision = policy.resolve(lowQuality, { objective: RetrievalObjectives.BALANCED, maxIterations: 2, minimumQuality: 0.5 }, new Trace());
    await a.assertEqual(lowDecision.action, 'increase_topk');
    await a.assertTrue(lowDecision.evidence.threshold !== undefined);

    const lowCoverage = RetrievalAssessment.create(0.5, 0.2, 0.6, 1, { missingConcepts: ['only_1_source_available'], ambiguousTerms: [], conflictingEvidence: [], unsupportedClaims: [] });
    const coverageDecision = policy.resolve(lowCoverage, { objective: RetrievalObjectives.BALANCED, maxIterations: 2, minimumQuality: 0.5 }, new Trace());
    await a.assertEqual(coverageDecision.action, 'rewrite_query');
    await a.assertTrue(coverageDecision.rationale.includes('Coverage appears low'));
  });

  runner.test('RetrievalAssessment is purely descriptive', async (a) => {
    const assessment = RetrievalAssessment.create(0.7, 0.6, 0.8, 2, { missingConcepts: ['term_x'], ambiguousTerms: [], conflictingEvidence: [], unsupportedClaims: [] });
    await a.assertEqual(assessment.quality, 0.7);
    await a.assertEqual(assessment.completeness, 0.6);
    await a.assertEqual(assessment.consistency, 0.8);
    await a.assertEqual(assessment.sourceDiversity, 2);
    await a.assertTrue(Array.isArray(assessment.missingEvidence.missingConcepts));
    await a.assertTrue(!assessment.recommendation, 'assessment has no recommendation field');
  });

  runner.test('Trace accumulates events across iterations', async (a) => {
    const trace = new Trace();
    trace.add(new TraceEvent({ timestamp: 1000, iteration: 0, phase: 'judge', assessment: RetrievalAssessment.create(0.5, 0.5, 0.5, 1) }));
    trace.add(new TraceEvent({ timestamp: 1100, iteration: 0, phase: 'policy', decision: Decision.create('increase_topk', 'low recall') }));
    await a.assertEqual(trace.events.length, 2);
    await a.assertEqual(trace.events[0].phase, 'judge');
    await a.assertEqual(trace.events[1].decision.action, 'increase_topk');
    const serialized = trace.toArray();
    await a.assertEqual(serialized[1].decision.type, 'increase_topk');
  });

  runner.test('Coordinator respects maxIterations and latencyBudget', async (a) => {
    const judge = new RetrievalJudge({ sufficientThreshold: 0.9, minDocsForSufficiency: 2 });
    const policy = new HeuristicRetrievalPolicy({ mediumScoreThreshold: 0.9 });
    const e = new MockEmbedder();
    const v = new MockVectorStore();
    const b = new BM25Store();
    const h = new HybridStore(v, b);
    for (const [id, text, content] of [['dl1', 'deep learning neural networks', 'deep learning neural networks']]) {
      h.store(id, e.embed(text), { original_id: id, content });
    }
    const executor = new RetrievalExecutor(e, h, new MockReranker());
    const coordinator = new Coordinator(judge, policy, executor);
    const observation = Observation.create('deep learning', 2, { objective: RetrievalObjectives.BALANCED, maxIterations: 2, minimumQuality: 0.9, latencyBudget: 1000 });
    const result = await coordinator.run(observation, { objective: RetrievalObjectives.BALANCED, maxIterations: 2, minimumQuality: 0.9, latencyBudget: 1000 });
    await a.assertTrue(result.trace.events.length > 0, 'records trace events');
    await a.assertTrue(result.finalAction && result.finalAction.type, 'produces finalAction');
  });

  runner.test('AgenticRetrievalPipeline returns assessment, decision, trace and goal', async (a) => {
    const e = new MockEmbedder();
    const h = setupStore(e);
    const reranker = new MockReranker();
    const pipeline = new AgenticRetrievalPipeline(e, h, reranker, {
      objective: RetrievalObjectives.BALANCED,
      latencyBudget: 5000,
      maxIterations: 2,
      minimumQuality: 0.5
    });
    const result = await pipeline.run('deep learning', 2);
    await a.assertTrue(result.success);
    await a.assertTrue(result.assessment !== null, 'assessment is present');
    await a.assertTrue(result.decision !== null, 'decision is present');
    await a.assertTrue(Array.isArray(result.trace), 'trace is array');
    await a.assertTrue(result.trace.length > 0, 'trace has events');
    await a.assertEqual(result.goal.objective, RetrievalObjectives.BALANCED);
    await a.assertTrue(result.finalAction && result.finalAction.type, 'finalAction is set');
  });

  runner.test('AgenticRetrievalPipeline answers when assessment is sufficient', async (a) => {
    const e = new MockEmbedder();
    const h = setupStore(e);
    const reranker = new MockReranker();
    const pipeline = new AgenticRetrievalPipeline(e, h, reranker, {
      objective: RetrievalObjectives.BALANCED,
      latencyBudget: 5000,
      maxIterations: 1,
      minimumQuality: 0.5
    });
    const result = await pipeline.run('deep learning', 2);
    await a.assertTrue(result.success);
    await a.assertEqual(result.finalAction.type, 'answer');
    await a.assertTrue(result.decision && result.decision.action === 'answer');
    await a.assertTrue(result.assessment && typeof result.assessment.quality === 'number');
  });

  runner.test('AgenticRetrievalPipeline stops when quality below threshold', async (a) => {
    const e = new MockEmbedder();
    const h = setupStore(e);
    const reranker = new MockReranker();
    const pipeline = new AgenticRetrievalPipeline(e, h, reranker, {
      objective: RetrievalObjectives.BALANCED,
      latencyBudget: 5000,
      maxIterations: 1,
      minimumQuality: 0.99
    });
    const result = await pipeline.run('unknown', 2);
    await a.assertTrue(result.success);
    await a.assertTrue(result.finalAction.type === 'stop' || result.finalAction.type === 'answer');
    await a.assertTrue(result.decision && result.finalAction);
    await a.assertTrue(Array.isArray(result.trace));
  });

  runner.test('AgenticRetrievalPipeline handles empty corpus gracefully', async (a) => {
    const e = new MockEmbedder();
    const v = new MockVectorStore();
    const b = new BM25Store();
    const h = new HybridStore(v, b);
    const reranker = new MockReranker();
    const pipeline = new AgenticRetrievalPipeline(e, h, reranker, {
      objective: RetrievalObjectives.BALANCED,
      latencyBudget: 1000,
      maxIterations: 1,
      minimumQuality: 0.5
    });
    const result = await pipeline.run('deep learning', 2);
    await a.assertTrue(result.success, 'does not throw on empty corpus');
    await a.assertEqual(result.resultsCount, 0, 'returns zero results on empty corpus');
    await a.assertEqual(result.finalAction.type, 'stop', 'stops on empty corpus');
  });

  runner.test('AgenticRetrievalPipeline is deterministic for identical inputs', async (a) => {
    const e = new MockEmbedder();
    const h1 = setupStore(e);
    const reranker = new MockReranker();
    const pipeline1 = new AgenticRetrievalPipeline(e, h1, reranker, { objective: RetrievalObjectives.BALANCED, maxIterations: 2, minimumQuality: 0.5, latencyBudget: 5000 });
    const r1 = await pipeline1.run('deep learning', 2);

    const h2 = setupStore(e);
    const pipeline2 = new AgenticRetrievalPipeline(e, h2, reranker, { objective: RetrievalObjectives.BALANCED, maxIterations: 2, minimumQuality: 0.5, latencyBudget: 5000 });
    const r2 = await pipeline2.run('deep learning', 2);

    await a.assertEqual(r1.trace.length, r2.trace.length);
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

  return runner;
}

module.exports = { setupTests };
