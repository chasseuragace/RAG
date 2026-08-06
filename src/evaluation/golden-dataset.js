/**
 * GoldenDataset — file-backed store of labelled retrieval judgment fixtures.
 *
 * Same pattern as DocRegistry: JSON file on disk, load on construct, _save() on write.
 * Lives at data/golden-decisions.json by default (configurable via GOLDEN_DATASET_FILE env).
 *
 * PURPOSE
 * -------
 * The golden dataset protects policy behavior across changes. Each fixture records:
 *   - A real query run against real (or mock) indexed documents
 *   - The assessment values produced by that actual retrieval run
 *   - A human judgment: "given these results, the policy should decide X"
 *
 * When you change anything policy-related (swap LLMPolicy in, tune thresholds, add a
 * new policy), run ReplayHarness.run(newPolicy, dataset) to verify your past judgments
 * still hold. A drop in match rate means a regression.
 *
 * Read data/GOLDEN_DATASET_README.md for the full intent, workflow, and field reference.
 *
 * Each record shape:
 * {
 *   id:               string   — stable kebab-case identifier
 *   description:      string   — one sentence describing what this fixture tests
 *   sourceQuery:      string   — the exact query string that was run
 *   assessment: {
 *     quality, completeness, consistency, sourceDiversity,
 *     missingEvidence: { missingConcepts[], ambiguousTerms[], conflictingEvidence[], unsupportedClaims[] }
 *   },
 *   goal:             object   — RetrievalGoal used for this run
 *   traceActions:     string[] — prior action types already in the trace (empty = first iteration)
 *   expectedAction:   string   — human-set correct decision: answer|increase_topk|rewrite_query|stop
 *   humanJudgment:    string   — why you chose that expectedAction (plain text, required)
 *   capturedWith:     string   — 'mock' or 'real' — which pipeline produced the numbers
 *   retrievedChunks:  object[] — optional snapshot of top chunks at capture time
 *   tags:             string[] — grouping labels: domain:X, query-type:X, captured-with:mock, etc.
 *   createdAt:        number   — epoch ms, set automatically
 * }
 */
const fs = require('fs');
const path = require('path');
const { GOLDEN_DATASET_FILE } = require('../shared/config');

class GoldenDataset {
  constructor(filePath = GOLDEN_DATASET_FILE) {
    this.filePath = filePath;
    this.records = this._load();
  }

  _load() {
    if (fs.existsSync(this.filePath)) {
      try { return JSON.parse(fs.readFileSync(this.filePath, 'utf8')); } catch (e) { return []; }
    }
    return [];
  }

  _save() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.records, null, 2));
  }

  /** Add or replace a fixture by id. */
  upsert(record) {
    if (!record.id) throw new Error('GoldenDataset.upsert: record must have an id');
    const idx = this.records.findIndex(r => r.id === record.id);
    const full = { ...record, createdAt: record.createdAt || Date.now() };
    if (idx >= 0) this.records[idx] = full;
    else this.records.push(full);
    this._save();
    return full;
  }

  get(id) { return this.records.find(r => r.id === id) || null; }

  remove(id) {
    this.records = this.records.filter(r => r.id !== id);
    this._save();
  }

  /** Return all records, optionally filtered by tag. */
  all(tag = null) {
    if (!tag) return [...this.records];
    return this.records.filter(r => Array.isArray(r.tags) && r.tags.includes(tag));
  }

  count() { return this.records.length; }

  /** Replace entire dataset (used by seed scripts). */
  replaceAll(records) {
    this.records = records.map(r => ({ ...r, createdAt: r.createdAt || Date.now() }));
    this._save();
  }

  /**
   * Run a query through a pipeline and save the resulting assessment as a fixture.
   *
   * This is the primary way to build domain-grounded golden fixtures. The assessment
   * values are captured from the actual retrieval run — you never hand-type quality
   * or completeness numbers.
   *
   * @param {object} options
   * @param {string}   options.id             — stable kebab-case fixture id
   * @param {string}   options.description    — one sentence describing what this tests
   * @param {object}   options.pipeline       — AgenticRetrievalPipeline (mock or real)
   * @param {string}   options.query          — the query to run
   * @param {number}   options.topK           — number of results to retrieve (default: 3)
   * @param {string}   options.expectedAction — your judgment: answer|increase_topk|rewrite_query|stop
   * @param {string}   options.humanJudgment  — why you chose that action (plain text, required)
   * @param {string}   options.pipelineMode   — 'mock' or 'real' (default: 'mock')
   * @param {string[]} options.tags           — grouping labels
   * @param {boolean}  options.captureChunks  — whether to snapshot retrieved chunks (default: false)
   *
   * @returns {Promise<object>} the saved fixture record
   *
   * Example:
   *   const fixture = await dataset.captureFixture({
   *     id:             'parang-rabbit-name',
   *     description:    'Direct factual question — rabbit name is in the text',
   *     pipeline,
   *     query:          'what did Parang name the rabbit',
   *     topK:           3,
   *     expectedAction: 'answer',
   *     humanJudgment:  'Chunk with "Well, Bingo." was retrieved. Direct answer.',
   *     pipelineMode:   'mock',
   *     tags:           ['domain:story', 'query-type:factual'],
   *   });
   */
   async captureFixture({
     id,
     description = '',
     pipeline,
     query,
     topK = 3,
     expectedAction,
     humanJudgment,
     pipelineMode = 'mock',
     tags = [],
     captureChunks = false,
   }, abortSignal = null) {
     if (!id)             throw new Error('captureFixture: id is required');
     if (!pipeline)       throw new Error('captureFixture: pipeline is required');
     if (!query)          throw new Error('captureFixture: query is required');
     if (!expectedAction) throw new Error('captureFixture: expectedAction is required');
     if (!humanJudgment)  throw new Error('captureFixture: humanJudgment is required — explain why expectedAction is correct');

     const validActions = ['answer', 'increase_topk', 'rewrite_query', 'stop'];
     if (!validActions.includes(expectedAction)) {
       throw new Error(`captureFixture: expectedAction must be one of ${validActions.join(', ')}`);
     }

     if (abortSignal) abortSignal.throwIfAborted();

     // Run the actual retrieval
     const result = await pipeline.run(query, topK, null, abortSignal);

    if (!result.success) {
      throw new Error(`captureFixture: pipeline run failed — ${result.error}`);
    }

    if (!result.assessment) {
      throw new Error('captureFixture: pipeline did not return an assessment. Ensure AgenticRetrievalPipeline is used.');
    }

    // Extract prior trace actions from the pipeline result
    const traceActions = (result.trace || [])
      .filter(e => e.phase === 'execute')
      .map(e => e.action?.type || 'unknown');

    const record = {
      id,
      description,
      sourceQuery: query,
      assessment: {
        quality:          result.assessment.quality,
        completeness:     result.assessment.completeness,
        consistency:      result.assessment.consistency,
        sourceDiversity:  result.assessment.sourceDiversity,
        missingEvidence:  result.assessment.missingEvidence,
      },
      goal: result.goal || {},
      traceActions,
      expectedAction,
      humanJudgment,
      capturedWith: pipelineMode,
      tags: [
        ...tags,
        `captured-with:${pipelineMode}`,
        ...(tags.includes('verified-by:human') ? [] : ['verified-by:human']),
      ],
      ...(captureChunks ? { retrievedChunks: (result.results || []).map(r => ({ id: r.id, relevance: r.score, content: r.metadata?.content || '' })) } : {}),
    };

    return this.upsert(record);
  }
}

module.exports = { GoldenDataset };
