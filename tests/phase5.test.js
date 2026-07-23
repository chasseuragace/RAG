/**
 * Phase 5 tests — LLM-backed Policy + Golden Dataset + Replay Harness
 *
 * All tests run with MockInference (no real API key required).
 * The MockInference is extended here with a controllable response so we can
 * test every path: good JSON, malformed JSON, invalid action, and inference error.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const { TestRunner } = require('./runner');
const { LLMPolicy, VALID_ACTIONS } = require('../src/agentic/policies/llm');
const { HeuristicRetrievalPolicy } = require('../src/agentic/policies/heuristic');
const { BalancedPolicy } = require('../src/agentic/policies/balanced');
const { GoldenDataset } = require('../src/core/golden-dataset');
const { ReplayHarness } = require('../src/agentic/replay');
const { RetrievalAssessment } = require('../src/agentic/assessment');
const { Decision } = require('../src/agentic/decision');
const { Trace, TraceEvent } = require('../src/agentic/trace');
const { RetrievalObjectives } = require('../src/core/interfaces');
const { MockEmbedder } = require('../src/embedders/mock');
const { MockVectorStore } = require('../src/stores/mock');
const { BM25Store } = require('../src/stores/bm25');
const { HybridStore } = require('../src/stores/hybrid');
const { MockReranker } = require('../src/rerankers/mock');
const { AgenticRetrievalPipeline } = require('../src/pipelines/agentic-retrieval');

// ─── helpers ─────────────────────────────────────────────────────────────────

const GOAL = {
  objective: RetrievalObjectives.BALANCED,
  maxIterations: 2,
  minimumQuality: 0.5,
  latencyBudget: 5000,
};

function goodAssessment() {
  return RetrievalAssessment.create(0.82, 0.90, 0.75, 3, {
    missingConcepts: [], ambiguousTerms: [], conflictingEvidence: [], unsupportedClaims: [],
  });
}

function weakAssessment() {
  return RetrievalAssessment.create(0.18, 0.30, 0.80, 1, {
    missingConcepts: ['low_relevance_top_result'], ambiguousTerms: [], conflictingEvidence: [], unsupportedClaims: [],
  });
}

function emptyTrace() { return new Trace(); }

function traceWith(...actionTypes) {
  const t = new Trace();
  actionTypes.forEach((type, i) => {
    t.add(new TraceEvent({ timestamp: Date.now(), iteration: i, phase: 'execute', action: Decision.create(type, 'prior') }));
  });
  return t;
}

/**
 * Controllable mock inference for testing LLMPolicy paths.
 * Set .nextResponse before each test.
 */
class ControllableMockInference {
  constructor() { this.nextResponse = null; this.shouldThrow = false; this.callLog = []; }
  async generateAnswer(prompt, _docs, _history) {
    this.callLog.push(prompt);
    if (this.shouldThrow) throw new Error('mock inference failure');
    return this.nextResponse;
  }
  reset() { this.nextResponse = null; this.shouldThrow = false; this.callLog = []; }
}

/** Build a valid LLM JSON response string for a given action. */
function mockLLMResponse(action, rationale = 'test rationale', evidence = { test: true }) {
  return JSON.stringify({ action, rationale, evidence });
}

/** Temp file path for isolated dataset tests. */
function tempDatasetPath() {
  return path.join(os.tmpdir(), `golden-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

/** Build a mock hybrid store populated with the story corpus. */
function setupStore(embedder) {
  const v = new MockVectorStore();
  const b = new BM25Store();
  const h = new HybridStore(v, b);
  for (const [id, text] of [
    ['dl1', 'deep learning neural networks explained'],
    ['dl2', 'machine learning algorithms and models'],
    ['dl3', 'python tutorial for beginners'],
  ]) {
    h.store(id, embedder.embed(text), { original_id: id, content: text });
  }
  return h;
}

// ─── tests ───────────────────────────────────────────────────────────────────

async function setupTests() {
  const runner = new TestRunner();

  // --- VALID_ACTIONS vocabulary ---

  runner.test('VALID_ACTIONS contains all expected action strings', async (a) => {
    for (const action of ['answer', 'increase_topk', 'rewrite_query', 'stop']) {
      await a.assertTrue(VALID_ACTIONS.includes(action), `${action} in VALID_ACTIONS`);
    }
    await a.assertEqual(VALID_ACTIONS.length, 4, 'exactly 4 valid actions');
  });

  // --- LLMPolicy: happy path ---

  runner.test('LLMPolicy returns LLM decision when response is valid JSON', async (a) => {
    const inf = new ControllableMockInference();
    inf.nextResponse = mockLLMResponse('answer', 'quality is high', { quality: 0.82 });
    const policy = new LLMPolicy(inf);

    const decision = await policy.resolve(goodAssessment(), GOAL, emptyTrace());
    await a.assertEqual(decision.action, 'answer');
    await a.assertTrue(decision.rationale.includes('quality is high'));
    await a.assertEqual(decision.evidence.quality, 0.82);
  });

  runner.test('LLMPolicy passes assessment data in the prompt', async (a) => {
    const inf = new ControllableMockInference();
    inf.nextResponse = mockLLMResponse('increase_topk', 'low quality', { quality: 0.18 });
    const policy = new LLMPolicy(inf);

    await policy.resolve(weakAssessment(), GOAL, emptyTrace());
    const prompt = inf.callLog[0];
    await a.assertTrue(prompt.includes('0.18'), 'prompt contains quality value');
    await a.assertTrue(prompt.includes('low_relevance_top_result'), 'prompt contains missingConcepts');
    await a.assertTrue(prompt.includes('BALANCED'), 'prompt contains objective');
  });

  runner.test('LLMPolicy includes prior trace actions in the prompt', async (a) => {
    const inf = new ControllableMockInference();
    inf.nextResponse = mockLLMResponse('answer', 'already tried rewrite');
    const policy = new LLMPolicy(inf);

    await policy.resolve(goodAssessment(), GOAL, traceWith('rewrite_query', 'increase_topk'));
    const prompt = inf.callLog[0];
    await a.assertTrue(prompt.includes('rewrite_query'), 'prior rewrite_query in prompt');
    await a.assertTrue(prompt.includes('increase_topk'), 'prior increase_topk in prompt');
  });

  // --- LLMPolicy: all valid actions round-trip ---

  runner.test('LLMPolicy correctly returns each valid action', async (a) => {
    const inf = new ControllableMockInference();
    const policy = new LLMPolicy(inf);

    for (const action of VALID_ACTIONS) {
      inf.reset();
      inf.nextResponse = mockLLMResponse(action, `chose ${action}`, { reason: action });
      const d = await policy.resolve(goodAssessment(), GOAL, emptyTrace());
      await a.assertEqual(d.action, action, `round-trip for action "${action}"`);
    }
  });

  // --- LLMPolicy: fallback paths ---

  runner.test('LLMPolicy falls back to heuristic on inference error', async (a) => {
    const inf = new ControllableMockInference();
    inf.shouldThrow = true;
    const policy = new LLMPolicy(inf);

    const decision = await policy.resolve(goodAssessment(), GOAL, emptyTrace());
    // Heuristic on good assessment should answer
    await a.assertEqual(decision.action, 'answer', 'fallback decides answer on good assessment');
    await a.assertTrue(decision.rationale.includes('[fallback:'), 'rationale tags fallback usage');
    await a.assertTrue(decision.evidence.fallbackReason.includes('inference_error'), 'evidence records reason');
  });

  runner.test('LLMPolicy falls back on malformed JSON response', async (a) => {
    const inf = new ControllableMockInference();
    inf.nextResponse = 'Sorry, I cannot help with that.';
    const policy = new LLMPolicy(inf);

    const decision = await policy.resolve(goodAssessment(), GOAL, emptyTrace());
    await a.assertTrue(decision.rationale.includes('[fallback:'), 'falls back on non-JSON');
    await a.assertTrue(decision.evidence.fallbackReason.includes('parse_error'));
  });

  runner.test('LLMPolicy falls back on invalid action value in JSON', async (a) => {
    const inf = new ControllableMockInference();
    inf.nextResponse = JSON.stringify({ action: 'hallucinated_action', rationale: 'oops' });
    const policy = new LLMPolicy(inf);

    const decision = await policy.resolve(goodAssessment(), GOAL, emptyTrace());
    await a.assertTrue(decision.rationale.includes('[fallback:'), 'falls back on bad action');
    await a.assertTrue(decision.evidence.fallbackReason.includes('invalid_action'));
  });

  runner.test('LLMPolicy strips markdown fences from LLM response', async (a) => {
    const inf = new ControllableMockInference();
    // Simulate LLM wrapping response in a code fence
    inf.nextResponse = '```json\n' + mockLLMResponse('rewrite_query', 'fenced') + '\n```';
    const policy = new LLMPolicy(inf);

    const decision = await policy.resolve(weakAssessment(), GOAL, emptyTrace());
    await a.assertEqual(decision.action, 'rewrite_query', 'parses through markdown fences');
  });

  runner.test('LLMPolicy accepts response with preamble before JSON', async (a) => {
    const inf = new ControllableMockInference();
    inf.nextResponse = 'Sure! Here is my decision:\n' + mockLLMResponse('stop', 'no docs found');
    const policy = new LLMPolicy(inf);

    const decision = await policy.resolve(weakAssessment(), GOAL, emptyTrace());
    await a.assertEqual(decision.action, 'stop', 'parses JSON after preamble text');
  });

  runner.test('LLMPolicy requires inference instance', async (a) => {
    await a.assertThrows(() => new LLMPolicy(null), 'throws without inference');
  });

  runner.test('LLMPolicy uses custom fallback policy when provided', async (a) => {
    const inf = new ControllableMockInference();
    inf.shouldThrow = true;
    const fallback = new BalancedPolicy();
    const policy = new LLMPolicy(inf, { fallbackPolicy: fallback });

    const decision = await policy.resolve(goodAssessment(), GOAL, emptyTrace());
    await a.assertTrue(decision.rationale.includes('[fallback:BalancedPolicy]'), 'uses named fallback');
  });

  // --- GoldenDataset ---

  runner.test('GoldenDataset loads and persists records', async (a) => {
    const file = tempDatasetPath();
    const ds = new GoldenDataset(file);
    await a.assertEqual(ds.count(), 0, 'empty on init');

    ds.upsert({ id: 'f1', description: 'test fixture', assessment: {}, goal: {}, traceActions: [], expectedAction: 'answer', tags: ['test'] });
    await a.assertEqual(ds.count(), 1);

    // Reload from disk
    const ds2 = new GoldenDataset(file);
    await a.assertEqual(ds2.count(), 1, 'persisted to disk');
    await a.assertEqual(ds2.get('f1').expectedAction, 'answer');
    fs.unlinkSync(file);
  });

  runner.test('GoldenDataset upsert replaces existing record by id', async (a) => {
    const file = tempDatasetPath();
    const ds = new GoldenDataset(file);
    ds.upsert({ id: 'f1', expectedAction: 'answer' });
    ds.upsert({ id: 'f1', expectedAction: 'stop' });
    await a.assertEqual(ds.count(), 1, 'no duplicate');
    await a.assertEqual(ds.get('f1').expectedAction, 'stop', 'value updated');
    fs.unlinkSync(file);
  });

  runner.test('GoldenDataset filters by tag', async (a) => {
    const file = tempDatasetPath();
    const ds = new GoldenDataset(file);
    ds.upsert({ id: 'a', expectedAction: 'answer', tags: ['high-quality'] });
    ds.upsert({ id: 'b', expectedAction: 'stop', tags: ['empty-corpus'] });
    ds.upsert({ id: 'c', expectedAction: 'answer', tags: ['high-quality'] });

    const hq = ds.all('high-quality');
    await a.assertEqual(hq.length, 2);
    const ec = ds.all('empty-corpus');
    await a.assertEqual(ec.length, 1);
    fs.unlinkSync(file);
  });

  runner.test('GoldenDataset.remove deletes a record', async (a) => {
    const file = tempDatasetPath();
    const ds = new GoldenDataset(file);
    ds.upsert({ id: 'r1', expectedAction: 'answer', tags: [] });
    ds.remove('r1');
    await a.assertEqual(ds.count(), 0);
    await a.assertEqual(ds.get('r1'), null);
    fs.unlinkSync(file);
  });

  runner.test('GoldenDataset loads the seeded golden-decisions.json', async (a) => {
    const seededPath = path.join(__dirname, '..', 'data', 'golden-decisions.json');
    const ds = new GoldenDataset(seededPath);
    await a.assertTrue(ds.count() >= 8, `seed file has at least 8 fixtures (got ${ds.count()})`);
    // Verify a known fixture
    const f = ds.get('high-quality-balanced');
    await a.assertTrue(f !== null, 'high-quality-balanced fixture exists');
    await a.assertEqual(f.expectedAction, 'answer');
    await a.assertTrue(Array.isArray(f.tags));
  });

  // --- ReplayHarness ---

  runner.test('ReplayHarness reports 100% match for heuristic policy on its own training cases', async (a) => {
    // Build a small in-memory dataset mirroring the heuristic policy's known decisions
    const file = tempDatasetPath();
    const ds = new GoldenDataset(file);
    ds.replaceAll([
      {
        id: 'r-good', description: 'good → answer', tags: [],
        assessment: { quality: 0.82, completeness: 0.90, consistency: 0.75, sourceDiversity: 3, missingEvidence: { missingConcepts: [], ambiguousTerms: [], conflictingEvidence: [], unsupportedClaims: [] } },
        goal: GOAL, traceActions: [], expectedAction: 'answer',
      },
      {
        id: 'r-low', description: 'low quality → increase_topk', tags: [],
        assessment: { quality: 0.18, completeness: 0.30, consistency: 0.80, sourceDiversity: 1, missingEvidence: { missingConcepts: ['low_relevance_top_result'], ambiguousTerms: [], conflictingEvidence: [], unsupportedClaims: [] } },
        goal: GOAL, traceActions: [], expectedAction: 'increase_topk',
      },
    ]);

    const harness = new ReplayHarness();
    const report = await harness.run(new HeuristicRetrievalPolicy(), ds);

    await a.assertEqual(report.total, 2);
    await a.assertEqual(report.matched, 2);
    await a.assertEqual(report.matchRate, 1.0, 'heuristic matches own cases');
    fs.unlinkSync(file);
  });

  runner.test('ReplayHarness report contains per-fixture result details', async (a) => {
    const file = tempDatasetPath();
    const ds = new GoldenDataset(file);
    ds.upsert({
      id: 'detail-check', description: 'check result shape', tags: [],
      assessment: { quality: 0.82, completeness: 0.90, consistency: 0.75, sourceDiversity: 3, missingEvidence: { missingConcepts: [], ambiguousTerms: [], conflictingEvidence: [], unsupportedClaims: [] } },
      goal: GOAL, traceActions: [], expectedAction: 'answer',
    });

    const harness = new ReplayHarness();
    const report = await harness.run(new HeuristicRetrievalPolicy(), ds);

    await a.assertEqual(report.results.length, 1);
    const r = report.results[0];
    await a.assertEqual(r.id, 'detail-check');
    await a.assertEqual(r.expectedAction, 'answer');
    await a.assertEqual(r.actualAction, 'answer');
    await a.assertTrue(r.matched);
    await a.assertTrue(typeof r.rationale === 'string' && r.rationale.length > 0, 'rationale present');
    await a.assertTrue(r.evidence !== null && typeof r.evidence === 'object', 'evidence present');
    fs.unlinkSync(file);
  });

  runner.test('ReplayHarness handles policy that throws without crashing', async (a) => {
    const file = tempDatasetPath();
    const ds = new GoldenDataset(file);
    ds.upsert({
      id: 'error-case', description: 'policy throws', tags: [],
      assessment: { quality: 0.5, completeness: 0.5, consistency: 0.5, sourceDiversity: 1, missingEvidence: { missingConcepts: [], ambiguousTerms: [], conflictingEvidence: [], unsupportedClaims: [] } },
      goal: GOAL, traceActions: [], expectedAction: 'answer',
    });

    const brokenPolicy = { resolve() { throw new Error('deliberate failure'); } };
    const harness = new ReplayHarness();
    const report = await harness.run(brokenPolicy, ds);

    await a.assertEqual(report.total, 1);
    await a.assertEqual(report.matched, 0);
    await a.assertEqual(report.results[0].actualAction, 'error');
    await a.assertTrue(report.results[0].error.includes('deliberate failure'));
    fs.unlinkSync(file);
  });

  runner.test('ReplayHarness reconstructs trace prior actions correctly', async (a) => {
    const file = tempDatasetPath();
    const ds = new GoldenDataset(file);
    // The heuristic doesn't change based on trace alone, but LLMPolicy prompt does —
    // so we test that traceActions actually arrive inside the policy call.
    const capturedTraces = [];
    const spyPolicy = {
      resolve(assessment, goal, trace) {
        capturedTraces.push(trace.events.filter(e => e.phase === 'execute').map(e => e.action?.action));
        return Decision.create('answer', 'spy', {});
      }
    };

    ds.upsert({
      id: 'trace-check', description: 'prior actions reconstructed', tags: [],
      assessment: { quality: 0.7, completeness: 0.7, consistency: 0.7, sourceDiversity: 2, missingEvidence: { missingConcepts: [], ambiguousTerms: [], conflictingEvidence: [], unsupportedClaims: [] } },
      goal: GOAL, traceActions: ['rewrite_query', 'increase_topk'], expectedAction: 'answer',
    });

    const harness = new ReplayHarness();
    await harness.run(spyPolicy, ds);

    await a.assertEqual(capturedTraces.length, 1, 'policy called once');
    await a.assertEqual(capturedTraces[0][0], 'rewrite_query', 'first prior action reconstructed');
    await a.assertEqual(capturedTraces[0][1], 'increase_topk', 'second prior action reconstructed');
    fs.unlinkSync(file);
  });

  runner.test('ReplayHarness filters by tag', async (a) => {
    const file = tempDatasetPath();
    const ds = new GoldenDataset(file);
    ds.replaceAll([
      { id: 't1', tags: ['group-a'], assessment: { quality: 0.8, completeness: 0.8, consistency: 0.8, sourceDiversity: 2, missingEvidence: { missingConcepts: [], ambiguousTerms: [], conflictingEvidence: [], unsupportedClaims: [] } }, goal: GOAL, traceActions: [], expectedAction: 'answer' },
      { id: 't2', tags: ['group-b'], assessment: { quality: 0.8, completeness: 0.8, consistency: 0.8, sourceDiversity: 2, missingEvidence: { missingConcepts: [], ambiguousTerms: [], conflictingEvidence: [], unsupportedClaims: [] } }, goal: GOAL, traceActions: [], expectedAction: 'answer' },
    ]);

    const harness = new ReplayHarness();
    const report = await harness.run(new HeuristicRetrievalPolicy(), ds, 'group-a');
    await a.assertEqual(report.total, 1, 'only group-a fixtures run');
    await a.assertEqual(report.results[0].id, 't1');
    fs.unlinkSync(file);
  });

  // --- LLMPolicy + ReplayHarness integration ---

  runner.test('LLMPolicy achieves 100% match on seeded golden dataset when inference is correct', async (a) => {
    const seededPath = path.join(__dirname, '..', 'data', 'golden-decisions.json');
    const ds = new GoldenDataset(seededPath);
    const orderedFixtures = ds.all();
    let fixtureIndex = 0;

    // Inference that returns exactly the expected action for each fixture in order.
    // This proves LLMPolicy routes valid JSON through without mangling actions.
    const perfectInference = {
      async generateAnswer(_prompt, _docs, _history) {
        const fixture = orderedFixtures[fixtureIndex++];
        return mockLLMResponse(fixture.expectedAction, `llm chose ${fixture.expectedAction}`, { fixtureId: fixture.id });
      }
    };

    const llmPolicy = new LLMPolicy(perfectInference);
    const harness = new ReplayHarness();
    const report = await harness.run(llmPolicy, ds);

    await a.assertEqual(report.total, ds.count(), 'all fixtures evaluated');
    await a.assertEqual(report.matched, report.total, 'LLMPolicy matches all when inference returns correct actions');
    await a.assertEqual(report.matchRate, 1.0);
  });

  runner.test('LLMPolicy falls back gracefully on every fixture when inference always fails', async (a) => {
    const seededPath = path.join(__dirname, '..', 'data', 'golden-decisions.json');
    const ds = new GoldenDataset(seededPath);

    const alwaysFailInference = {
      async generateAnswer() { throw new Error('always fails'); }
    };
    const policy = new LLMPolicy(alwaysFailInference);
    const harness = new ReplayHarness();
    const report = await harness.run(policy, ds);

    await a.assertEqual(report.total, ds.count(), 'all fixtures processed');
    // Every result should have fallen back (no 'error' action — fallback returns a real action)
    for (const r of report.results) {
      await a.assertTrue(VALID_ACTIONS.includes(r.actualAction),
        `fixture ${r.id}: fallback produced valid action "${r.actualAction}"`);
      await a.assertTrue(r.rationale.includes('[fallback:'),
        `fixture ${r.id}: rationale marks fallback`);
    }
  });

  runner.test('ReplayHarness matchRate is a number between 0 and 1', async (a) => {
    const file = tempDatasetPath();
    const ds = new GoldenDataset(file);
    ds.replaceAll([
      { id: 'x1', tags: [], assessment: { quality: 0.82, completeness: 0.90, consistency: 0.75, sourceDiversity: 3, missingEvidence: { missingConcepts: [], ambiguousTerms: [], conflictingEvidence: [], unsupportedClaims: [] } }, goal: GOAL, traceActions: [], expectedAction: 'answer' },
      { id: 'x2', tags: [], assessment: { quality: 0.82, completeness: 0.90, consistency: 0.75, sourceDiversity: 3, missingEvidence: { missingConcepts: [], ambiguousTerms: [], conflictingEvidence: [], unsupportedClaims: [] } }, goal: GOAL, traceActions: [], expectedAction: 'stop' },  // wrong expected — should mismatch
    ]);
    const harness = new ReplayHarness();
    const report = await harness.run(new HeuristicRetrievalPolicy(), ds);
    await a.assertTrue(report.matchRate >= 0 && report.matchRate <= 1, 'matchRate in [0,1]');
    await a.assertEqual(report.total, 2);
    await a.assertEqual(report.matched + report.mismatched, report.total, 'matched + mismatched = total');
    fs.unlinkSync(file);
  });

  // --- captureFixture ---

  runner.test('captureFixture runs pipeline and saves real assessment values', async (a) => {
    const file = tempDatasetPath();
    const ds = new GoldenDataset(file);
    const e = new MockEmbedder();
    const h = setupStore(e);
    const pipeline = new AgenticRetrievalPipeline(e, h, new MockReranker(), GOAL);

    const fixture = await ds.captureFixture({
      id:             'capture-test-basic',
      description:    'Direct query about Bingo the rabbit',
      pipeline,
      query:          'what did Parang name the rabbit',
      topK:           3,
      expectedAction: 'answer',
      humanJudgment:  'The chunk naming the rabbit was retrieved. Direct answer.',
      pipelineMode:   'mock',
      tags:           ['domain:story', 'query-type:factual'],
    });

    // Assessment values came from the real run — not hand-typed
    await a.assertTrue(typeof fixture.assessment.quality === 'number', 'quality is a number from real run');
    await a.assertTrue(typeof fixture.assessment.completeness === 'number', 'completeness is a number from real run');
    await a.assertTrue(fixture.assessment.quality >= 0 && fixture.assessment.quality <= 1, 'quality in [0,1]');

    // Core fields are present
    await a.assertEqual(fixture.id, 'capture-test-basic');
    await a.assertEqual(fixture.sourceQuery, 'what did Parang name the rabbit');
    await a.assertEqual(fixture.expectedAction, 'answer');
    await a.assertEqual(fixture.humanJudgment, 'The chunk naming the rabbit was retrieved. Direct answer.');
    await a.assertEqual(fixture.capturedWith, 'mock');

    // Tags include auto-added ones
    await a.assertTrue(fixture.tags.includes('captured-with:mock'), 'auto-tag captured-with:mock');
    await a.assertTrue(fixture.tags.includes('verified-by:human'), 'auto-tag verified-by:human');
    await a.assertTrue(fixture.tags.includes('domain:story'), 'user tag preserved');

    // Persisted to disk
    const ds2 = new GoldenDataset(file);
    await a.assertEqual(ds2.get('capture-test-basic').sourceQuery, 'what did Parang name the rabbit', 'persisted');
    fs.unlinkSync(file);
  });

  runner.test('captureFixture traceActions reflect actual pipeline execution', async (a) => {
    const file = tempDatasetPath();
    const ds = new GoldenDataset(file);
    const e = new MockEmbedder();
    const h = setupStore(e);
    const pipeline = new AgenticRetrievalPipeline(e, h, new MockReranker(), { ...GOAL, maxIterations: 2 });

    const fixture = await ds.captureFixture({
      id:             'capture-trace-check',
      description:    'Verify traceActions are captured from run',
      pipeline,
      query:          'deep learning neural networks',
      topK:           2,
      expectedAction: 'answer',
      humanJudgment:  'Relevant chunks retrieved after pipeline ran.',
      pipelineMode:   'mock',
      tags:           [],
    });

    // traceActions should be an array (even if empty on single-iteration runs)
    await a.assertTrue(Array.isArray(fixture.traceActions), 'traceActions is an array');
    fs.unlinkSync(file);
  });

  runner.test('captureFixture with captureChunks saves retrieved chunk content', async (a) => {
    const file = tempDatasetPath();
    const ds = new GoldenDataset(file);
    const e = new MockEmbedder();
    const h = setupStore(e);
    const pipeline = new AgenticRetrievalPipeline(e, h, new MockReranker(), GOAL);

    const fixture = await ds.captureFixture({
      id:             'capture-chunks-test',
      description:    'Verify chunk snapshot is captured',
      pipeline,
      query:          'what did Parang name the rabbit',
      topK:           2,
      expectedAction: 'answer',
      humanJudgment:  'Testing chunk capture.',
      pipelineMode:   'mock',
      tags:           [],
      captureChunks:  true,
    });

    await a.assertTrue(Array.isArray(fixture.retrievedChunks), 'retrievedChunks is an array');
    if (fixture.retrievedChunks.length > 0) {
      const chunk = fixture.retrievedChunks[0];
      await a.assertTrue('id' in chunk, 'chunk has id');
      await a.assertTrue('relevance' in chunk, 'chunk has relevance');
    }
    fs.unlinkSync(file);
  });

  runner.test('captureFixture upserts — re-capturing same id replaces the fixture', async (a) => {
    const file = tempDatasetPath();
    const ds = new GoldenDataset(file);
    const e = new MockEmbedder();
    const h = setupStore(e);
    const pipeline = new AgenticRetrievalPipeline(e, h, new MockReranker(), GOAL);

    await ds.captureFixture({ id: 'upsert-test', description: 'v1', pipeline, query: 'deep learning', topK: 2, expectedAction: 'answer', humanJudgment: 'first capture', pipelineMode: 'mock', tags: [] });
    await ds.captureFixture({ id: 'upsert-test', description: 'v2', pipeline, query: 'deep learning', topK: 2, expectedAction: 'stop',   humanJudgment: 'second capture', pipelineMode: 'mock', tags: [] });

    await a.assertEqual(ds.count(), 1, 'no duplicate on re-capture');
    await a.assertEqual(ds.get('upsert-test').humanJudgment, 'second capture', 'latest capture wins');
    await a.assertEqual(ds.get('upsert-test').expectedAction, 'stop');
    fs.unlinkSync(file);
  });

  runner.test('captureFixture validates required fields', async (a) => {
    const file = tempDatasetPath();
    const ds = new GoldenDataset(file);
    const e = new MockEmbedder();
    const h = setupStore(e);
    const pipeline = new AgenticRetrievalPipeline(e, h, new MockReranker(), GOAL);
    const base = { id: 'v', pipeline, query: 'q', expectedAction: 'answer', humanJudgment: 'j', pipelineMode: 'mock', tags: [] };

    await a.assertThrows(() => ds.captureFixture({ ...base, id: undefined }), 'missing id');
    await a.assertThrows(() => ds.captureFixture({ ...base, pipeline: undefined }), 'missing pipeline');
    await a.assertThrows(() => ds.captureFixture({ ...base, query: undefined }), 'missing query');
    await a.assertThrows(() => ds.captureFixture({ ...base, expectedAction: undefined }), 'missing expectedAction');
    await a.assertThrows(() => ds.captureFixture({ ...base, humanJudgment: undefined }), 'missing humanJudgment');
    await a.assertThrows(() => ds.captureFixture({ ...base, expectedAction: 'not_valid' }), 'invalid action');
    if (fs.existsSync(file)) fs.unlinkSync(file);
  });

  runner.test('captureFixture goal is preserved from pipeline result', async (a) => {
    const file = tempDatasetPath();
    const ds = new GoldenDataset(file);
    const e = new MockEmbedder();
    const h = setupStore(e);
    const pipeline = new AgenticRetrievalPipeline(e, h, new MockReranker(), {
      ...GOAL,
      objective: 'MAXIMIZE_RECALL',
    });

    const fixture = await ds.captureFixture({
      id: 'goal-check', description: 'goal preserved', pipeline,
      query: 'deep learning', topK: 2,
      expectedAction: 'answer', humanJudgment: 'testing goal capture',
      pipelineMode: 'mock', tags: [],
    });

    await a.assertTrue(fixture.goal !== null && typeof fixture.goal === 'object', 'goal is an object');
    fs.unlinkSync(file);
  });

  runner.test('captured fixture can be replayed through ReplayHarness', async (a) => {
    const file = tempDatasetPath();
    const ds = new GoldenDataset(file);
    const e = new MockEmbedder();
    const h = setupStore(e);
    const pipeline = new AgenticRetrievalPipeline(e, h, new MockReranker(), GOAL);

    // Capture a fixture where a direct query should produce 'answer'
    await ds.captureFixture({
      id:             'replay-captured',
      description:    'Captured then replayed through harness',
      pipeline,
      query:          'deep learning neural networks',
      topK:           3,
      expectedAction: 'answer',
      humanJudgment:  'dl1/dl2 chunks are clearly relevant. System should answer.',
      pipelineMode:   'mock',
      tags:           ['domain:story'],
    });

    // Now replay through heuristic policy
    const harness = new ReplayHarness();
    const report = await harness.run(new HeuristicRetrievalPolicy(), ds);

    await a.assertEqual(report.total, 1, 'one fixture');
    await a.assertTrue(report.results[0].matched !== undefined, 'matched field present');
    // The captured fixture used a real run — actual policy decision may or may not match.
    // What we assert here is that the harness ran without error and produced a result.
    await a.assertTrue(VALID_ACTIONS.includes(report.results[0].actualAction), 'actual action is valid');
    fs.unlinkSync(file);
  });

  return runner;
}

module.exports = { setupTests };
