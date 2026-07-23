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

## Golden dataset vs production — they are completely separate

The golden dataset **never runs in production**. It has no role in the live request
path. Here is the split:

```
Production:   user query → pipeline → policy decides → answer returned to user
Evaluation:   golden fixture → ReplayHarness → policy decides → compare to your label
```

The golden set answers: *"does the policy still make the decisions I verified were
correct?"* It is purely an offline regression test.

---

## How does LLMPolicy know what "good enough" is in production?

`LLMPolicy` does not consult the golden dataset during production. What it receives
in its prompt is:

- The current assessment numbers (`quality`, `completeness`, `consistency`,
  `sourceDiversity`, `missingEvidence`)
- The goal parameters (`objective`, `minimumQuality`, `maxIterations`)
- Prior actions already taken this iteration
- The valid action vocabulary (`answer`, `increase_topk`, `rewrite_query`, `stop`)

The LLM uses its own trained judgment — implicit in the model weights — to decide
whether those numbers warrant answering or iterating. You are not explicitly teaching
it your domain rules; you are relying on its general reasoning capability about
information sufficiency.

**This is both the strength and the weakness:**

- Strength: it can reason about combinations of signals a heuristic threshold
  cannot capture
- Weakness: the judgment is implicit, can drift between model versions, and is
  not inspectable

**The golden dataset is how you catch the weakness.** You capture cases where you
know what "good enough" looks like for your domain. When the LLM makes a different
call, the ReplayHarness flags it. The golden set is the specification of what
"good enough" means in *your* system — and LLMPolicy is measured against it.

To see exactly what the LLM receives, read `_buildPrompt()` in
`src/agentic/policies/llm.js`.

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

### The correct workflow

The capture flow is: **ask first, decide to save second.** Not the other way around.

1. Go to the Console and type a real user query, click **Ask**
2. Read the returned answer and sources
3. Look at what the system decided (`finalAction` in the event log)
4. Decide: was that the right call given what was retrieved?
5. If yes — click **⊕ Save as Fixture** at the bottom of the Last Answer card
6. A small inline panel opens with three fields:
   - **Fixture ID** — a stable kebab-case name you choose
   - **Expected Action** — pre-filled with what the system decided; change it if the system was wrong
   - **Your Judgment** — one sentence explaining why the expected action is correct
7. Click **Save Fixture** — done

The system re-runs the query in the background, captures the real assessment values
from that run, and saves everything to `data/golden-decisions.json`. You never type
quality or completeness numbers by hand.

### When to save

Save when the system made a decision you agree with — that becomes a positive fixture.
Save when the system made a wrong decision you caught — set the *correct*
`expectedAction` and that becomes a regression fixture.

You do not need to save every query. Five to ten well-chosen fixtures covering
each action type (`answer`, `increase_topk`, `rewrite_query`, `stop`) give you
a meaningful regression baseline.

### Programmatic capture (scripts / tests)

`GoldenDataset.captureFixture()` is also available directly for scripted capture:

```js
const { GoldenDataset } = require('./src/core/golden-dataset');
const dataset = new GoldenDataset();

await dataset.captureFixture({
  id:             'parang-rabbit-name',
  pipeline,                            // AgenticRetrievalPipeline instance
  query:          'what did Parang name the rabbit',
  topK:           3,
  expectedAction: 'answer',
  humanJudgment:  'Chunk with "Well, Bingo." directly answers the question.',
  tags:           ['domain:story', 'query-type:factual'],
  pipelineMode:   'mock',
});
```

### What to capture

Cover the full decision space:

- **Queries with clear, direct answers** → `answer`
- **Queries that need multiple chunks** → `increase_topk`
- **Vague or ambiguous queries** → `rewrite_query`
- **Queries about things not in the corpus** → `stop`
- **Queries after a prior rewrite** → set `traceActions: ['rewrite_query']`

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
