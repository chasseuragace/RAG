# Golden Dataset — Intent, Purpose, and Usage Guide

This document explains what the golden dataset is, why it exists, what goes in it,
how to build it, and how to use it. Read this before touching `golden-decisions.json`
or calling `captureFixture`.

---

## The problem it solves

You have a retrieval pipeline. You change something — swap the policy, tune a
threshold, upgrade to LLMPolicy. How do you know the change didn't break anything?

Unit tests tell you the code still runs correctly. They do not tell you whether the
system still makes **good retrieval decisions**. Those are different things. You can
have 100% passing unit tests and a policy that now decides to stop retrieving on
every query.

The golden dataset is the answer to that second question. It is a collection of
**human-verified retrieval judgments** — moments where you looked at what the system
retrieved, decided whether it was good enough, and saved that judgment permanently.

When you change anything policy-related, you run `ReplayHarness.run(newPolicy, dataset)`
and it tells you: "17 of 20 of your past judgments still hold." If it drops to 10,
something regressed.

---

## The mental model

Think of it like a test suite, but for decisions instead of code:

```
Unit tests      → tests/*.test.js            → "does the code work correctly?"
Golden dataset  → data/golden-decisions.json → "does the policy make good decisions?"
```

Your test suite protects the code. The golden dataset protects the **behavior**.

---

## What a golden fixture actually is

Each fixture records one moment in time:

- **What the user asked** (`sourceQuery`)
- **What the pipeline retrieved** — captured as assessment metrics (`quality`,
  `completeness`, `consistency`, `sourceDiversity`, `missingEvidence`)
- **What actions had already been taken** (`traceActions`) — e.g. a query rewrite
  happened before this assessment
- **What the policy should decide** (`expectedAction`) — set by you, the human
- **Why you made that judgment** (`humanJudgment`) — your reasoning, in plain text
- **Which pipeline produced the numbers** (`capturedWith: 'mock' | 'real'`) — so
  you know how much to trust the assessment values

The `expectedAction` is the gold label. It is **not** derived from any policy or
heuristic. It is what *you* decided was correct after looking at the retrieved chunks.

---

## The difference between mock and real captures

`captureFixture` works with any pipeline — mock or real. The fixture it produces is
only as trustworthy as the pipeline that produced it.

| | Mock pipeline | Real pipeline |
|---|---|---|
| Embedder | Word-overlap heuristic | Gemini semantic embeddings |
| Vector store | In-memory mock | Chroma |
| Assessment values | Approximate but deterministic | Semantically grounded |
| Useful for | Building the workflow, structural testing | Production evaluation |
| `capturedWith` tag | `"mock"` | `"real"` |

**Right now everything is mocked.** Fixtures captured in mock mode are structurally
real — they come from an actual retrieval run against the actual indexed documents,
not hand-typed numbers. But the similarity scores are based on word overlap, not true
semantic understanding. They are good enough to build and validate the evaluation
infrastructure. When you switch to the real pipeline, you capture new fixtures over
them and they become production-grade benchmarks.

You do not need to delete mock fixtures when you switch to real. Just add real ones
alongside them. The `capturedWith` field tells you which is which.

---

## How to build the golden dataset

### The workflow

1. Run a query through the pipeline and get a result
2. Look at the retrieved chunks — read them
3. Ask yourself: given only these chunks, can this question be answered?
4. Decide the correct action: `answer`, `increase_topk`, `rewrite_query`, or `stop`
5. Call `captureFixture` with your judgment
6. The fixture is saved to `golden-decisions.json` automatically

```js
const { GoldenDataset } = require('./src/core/golden-dataset');
const { AgenticRetrievalPipeline } = require('./src/pipelines/agentic-retrieval');

const dataset = new GoldenDataset();
const pipeline = new AgenticRetrievalPipeline(embedder, store, reranker, goal);

const fixture = await dataset.captureFixture({
  pipeline,
  query:          'what did Parang name the rabbit',
  topK:           3,
  expectedAction: 'answer',
  humanJudgment:  'Chunk containing "Well, Bingo. That\'s your name now." was retrieved. Direct answer.',
  tags:           ['domain:story', 'query-type:factual'],
  pipelineMode:   'mock',   // or 'real' when using the real pipeline
});
```

That's it. The assessment values are captured from the actual retrieval run.
You never type quality or completeness numbers by hand.

### What to capture

Capture moments that cover the decision space:

- **Queries with clear, direct answers** → should produce `answer`
- **Queries that need multiple chunks** → should produce `increase_topk`
- **Vague or ambiguous queries** → should produce `rewrite_query`
- **Queries about things not in the corpus** → should produce `stop`
- **Queries after a prior rewrite** → set `traceActions: ['rewrite_query']`

You do not need dozens of fixtures to start. Five to ten well-chosen ones covering
each action type give you a meaningful regression baseline.

### When to capture in production

You said it well: "capture when I'm running in production and I like the answers."

That is correct. When the real pipeline is running and the system makes a decision
you agree with, capture it. When you catch the system making a wrong decision, capture
it with the *correct* `expectedAction` — that becomes a regression fixture.

Over time, `golden-decisions.json` becomes a record of your domain knowledge: a log
of cases where you as the domain expert said "yes, this is what good retrieval looks
like in this system."

---

## How to use the golden dataset for evaluation

### Compare two policies

```js
const { ReplayHarness } = require('./src/agentic/replay');
const { HeuristicRetrievalPolicy } = require('./src/agentic/policies/heuristic');
const { LLMPolicy } = require('./src/agentic/policies/llm');

const harness = new ReplayHarness();
const dataset = new GoldenDataset();

const heuristicReport = await harness.run(new HeuristicRetrievalPolicy(), dataset);
const llmReport       = await harness.run(new LLMPolicy(inference), dataset);

console.log('Heuristic match rate:', heuristicReport.matchRate);  // e.g. 0.85
console.log('LLM match rate:',       llmReport.matchRate);        // e.g. 0.90
```

If LLMPolicy scores higher than the heuristic on your domain fixtures, it is making
better decisions on cases you personally verified. That is a meaningful result.

### Detect regressions after a change

```js
// Before your change — commit the report somewhere
const before = await harness.run(policy, dataset);

// After your change
const after = await harness.run(policy, dataset);

if (after.matchRate < before.matchRate) {
  console.warn('Regression: match rate dropped from', before.matchRate, 'to', after.matchRate);
}
```

### Filter by tag

```js
// Only evaluate on out-of-domain queries
const report = await harness.run(policy, dataset, 'query-type:out-of-domain');

// Only evaluate on real-pipeline captures
const report = await harness.run(policy, dataset, 'captured-with:real');
```

---

## What the current `golden-decisions.json` contains

The records currently in the file are **mechanical placeholders**. They use
hand-typed abstract numbers that have no connection to the actual corpus. They exist
to verify the plumbing — that `LLMPolicy` parses responses correctly, that
`ReplayHarness` reconstructs traces, that match rates compute correctly.

They are **not** domain golden fixtures. Do not use them to evaluate whether the
system makes good retrieval decisions. Their purpose is unit-testing the infrastructure,
not benchmarking behavior.

When you start capturing real fixtures (mock or real pipeline), those will be the ones
that matter for evaluation. The placeholders can stay — they continue to serve their
mechanical testing purpose.

---

## Golden fixtures for the current corpus

The current corpus is `input/doc1.md` — a short story about a man named Parang who
gets lost in a jungle and is guided home by a white rabbit he names Bingo.

Below are what real domain fixtures should look like once captured. The assessment
numbers below are illustrative (what you'd expect from a real run) — not hand-typed
for production use.

**Direct factual question — `answer`**
Query: *"what did Parang name the rabbit"*
Reasoning: The chunk containing `"Well, Bingo. That's your name now."` is a direct
answer. One chunk is sufficient.

**Multi-part narrative question — `increase_topk`**
Query: *"how did Parang find his way out of the jungle"*
Reasoning: The answer spans two events — the rabbit guiding him, and following the
river home. A single chunk captures only one of them. More results needed.

**Out-of-domain query — `stop`**
Query: *"what magic spell did Parang use to escape"*
Reasoning: The story contains no magic. Even after increasing topK the results will
not answer this. Stop early.

**Ambiguous query — `rewrite_query`**
Query: *"what was the animal in the forest"*
Reasoning: The story mentions several animals (the rabbit, the distant howling
creature, insects). The query is underspecified. A rewrite to "white rabbit Bingo"
would surface the right chunks.

**Post-rewrite, good result — `answer`**
Query: *"white rabbit Bingo jungle guide"*  (after a prior rewrite)
traceActions: `["rewrite_query"]`
Reasoning: The rewrite resolved the ambiguity. Both the rabbit's appearance and its
guidance behaviour were retrieved. Sufficient to answer.

These are the queries to start with when you run `captureFixture` for the first time.

---

## Field reference

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Stable identifier. Use kebab-case. Never reuse a deleted id. |
| `description` | string | yes | One sentence describing what this fixture tests. |
| `sourceQuery` | string | yes | The exact query string that was run. |
| `assessment` | object | yes | Assessment values from the actual retrieval run. Never hand-typed in production fixtures. |
| `goal` | object | yes | The RetrievalGoal used for this run. |
| `traceActions` | string[] | yes | Prior actions already in the trace before this assessment. Empty array if first iteration. |
| `expectedAction` | string | yes | The correct decision. Set by a human. One of: `answer`, `increase_topk`, `rewrite_query`, `stop`. |
| `humanJudgment` | string | yes | Why you chose that expectedAction. Plain text. |
| `tags` | string[] | yes | Grouping labels. Use `domain:X`, `query-type:X`, `captured-with:mock`, `captured-with:real`, `verified-by:human`. |
| `capturedWith` | string | yes | `"mock"` or `"real"`. Set automatically by `captureFixture`. |
| `retrievedChunks` | object[] | no | Optional snapshot of the top chunks at capture time. Useful for auditing. |
| `createdAt` | number | auto | Epoch ms. Set automatically. |

---

## Rules for maintaining the dataset

- **Never hand-type `assessment` values for production fixtures.** Use `captureFixture`.
- **Never derive `expectedAction` from a policy.** It is a human judgment.
- **Always fill in `humanJudgment`.** Without it, the fixture is unauditable.
- **Do not delete fixtures unless the corpus changes** in a way that makes the query
  unanswerable or the expected answer genuinely different.
- **When you update a corpus** (add/change documents), re-capture affected fixtures
  and note which ones changed. Old fixture values may no longer reflect real retrieval.
- **Tag everything.** Tags are how you slice the dataset for targeted evaluation.
