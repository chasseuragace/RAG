# Refactor Plan — Folder Structure

## Mental Model Decision

**Phase-first, Capability-second.**

Not Clean Architecture. Not type-based (current).

### Why not Clean Architecture

Clean Architecture's four rings (entities → use-cases → adapters → frameworks) are designed
for *business transaction* systems. The vocabulary is wrong for a pipeline: "application
layer" and "infrastructure layer" tell you nothing about whether something runs at ingest
time or query time. The decodingai.com article (2025) specifically documents this trap:
forcing an AI pipeline into CA buckets produces confusion, not clarity.

### Why not the current type-based layout

The current structure groups by *what a module is*:

```
embedders/  stores/  loaders/  rerankers/  ner/  graph/  authority/  pipelines/
```

This is legible for a single-purpose library. It breaks down when the system has two
distinct runtime phases because phase boundaries are invisible. A new contributor cannot
tell whether `ner/mock-extractor.js` runs during document indexing, during query time, or
both. `pipelines/` becomes a catch-all because there is no better home.

### Why phase-first works here

The system has exactly two operational phases with different SLA contracts:

| Phase | Trigger | Latency contract | Can fail slowly? |
|---|---|---|---|
| **Ingestion** | Offline / async / on demand | Minutes | Yes |
| **Retrieval** | Every user query | < 2 s | No |

A developer fixing a latency bug opens `retrieval/`. A developer tuning entity tagging
opens `ingestion/`. No disambiguation needed.

Production RAG literature (unstructured.io, redis.io, Azure) consistently names this the
canonical split.

---

## Proposed Tree (annotated)

```
rag-system/
├── src/
│   │
│   ├── shared/                     ← Pure contracts + cross-cutting utilities.
│   │   │                             No phase-specific logic. No external I/O.
│   │   ├── interfaces.js           ← ALL abstract base classes (was core/interfaces.js)
│   │   ├── chunker.js              ← Text splitting logic (used by ingestion only, but
│   │   │                             small enough to stay shared for testability)
│   │   ├── events.js               ← ServerEvents bus (was src/events.js)
│   │   └── config.js               ← Env vars + dir bootstrap (was src/config.js)
│   │
│   ├── ingestion/                  ← Everything that runs OFFLINE to build the KB.
│   │   │                             Triggered by /inject. Slow path. Can be async.
│   │   ├── pipeline.js             ← ConcreteInjectionPipeline (was pipelines/injection.js)
│   │   ├── loaders/
│   │   │   ├── mock.js
│   │   │   └── real.js
│   │   ├── ner/                    ← Entity tagging AT INGEST TIME
│   │   │   ├── mock-extractor.js
│   │   │   └── mock-glossary.js    ← Glossary used at ingest for term normalisation
│   │   ├── graph/                  ← Relationship extraction → triple store
│   │   │   ├── mock-extractor.js
│   │   │   └── mock-store.js
│   │   ├── authority/              ← Provenance annotation (stamps authority_signal on chunks)
│   │   │   └── mock-annotator.js
│   │   └── registry.js             ← DocRegistry (was core/registry.js)
│   │
│   ├── retrieval/                  ← Everything that runs ON EVERY USER QUERY.
│   │   │                             Fast path. Latency-sensitive.
│   │   ├── pipeline.js             ← NEREnrichedRetrievalPipeline +
│   │   │                             HybridRetrievalPipeline (was pipelines/retrieval.js)
│   │   ├── graph-rag.js            ← GraphRAGPipeline (was pipelines/graph-rag.js)
│   │   ├── embedders/
│   │   │   ├── mock.js
│   │   │   └── gemini.js
│   │   ├── stores/                 ← Vector + BM25 + hybrid stores
│   │   │   ├── mock.js
│   │   │   ├── chroma.js
│   │   │   ├── bm25.js
│   │   │   └── hybrid.js
│   │   ├── ner/                    ← Query-time NER: entity extraction + metadata filtering
│   │   │   ├── mock-extractor.js   ← SAME CLASS as ingestion/ner/mock-extractor.js
│   │   │   ├── mock-filter.js      ← Metadata filter (query-time only)
│   │   │   └── mock-glossary.js    ← Acronym expansion (query-time only)
│   │   ├── graph/
│   │   │   └── mock-fuser.js       ← ContextFuser (query-time only)
│   │   ├── rerankers/
│   │   │   ├── mock.js
│   │   │   ├── real.js
│   │   │   └── authority-aware.js
│   │   └── authority/
│   │       └── mock-scorer.js      ← AuthorityScorer (reads authority_signal at query time)
│   │
│   ├── agentic/                    ← Multi-step reasoning loop. Sits on top of retrieval.
│   │   │                             Could eventually become its own service.
│   │   ├── pipeline.js             ← AgenticRetrievalPipeline (was pipelines/agentic-retrieval.js)
│   │   ├── coordinator.js
│   │   ├── executor.js
│   │   ├── judge.js
│   │   ├── assessment.js
│   │   ├── decision.js
│   │   ├── observation.js
│   │   ├── policy.js
│   │   ├── trace.js
│   │   ├── query-rewriter.js
│   │   ├── replay.js
│   │   ├── policies/
│   │   │   ├── heuristic.js
│   │   │   ├── balanced.js
│   │   │   ├── aggressive.js
│   │   │   ├── lowlatency.js
│   │   │   └── llm.js
│   │   ├── strategies/
│   │   │   └── heuristic.js
│   │   └── lib/
│   │       └── llm-json.js
│   │
│   ├── inference/                  ← LLM generation. Final step. No retrieval logic here.
│   │   ├── mock.js
│   │   └── novita.js
│   │
│   ├── evaluation/                 ← Offline quality measurement. Not in the hot path.
│   │   ├── golden-dataset.js       ← was core/golden-dataset.js
│   │   └── replay.js               ← ReplayHarness (was agentic/replay.js — it's eval, not agentic)
│   │
│   ├── api/                        ← HTTP + WebSocket transport. Thin wiring only.
│   │   └── server.js               ← was src/server.js
│   │
│   └── session/                    ← Conversation state management.
│       └── conversation.js         ← was core/conversation.js
│
├── data/
├── input/
├── logs/
├── public/
├── tests/
└── ...
```

---

## The Dual-Use NER Problem (and Resolution)

`MockEntityExtractor` is used in BOTH phases:
- Ingestion: tag chunks with entities → stored in metadata
- Retrieval: extract entities from the query → build metadata filter

**Resolution:** The class lives in ONE place: `shared/` (or we pick one phase directory
and symlink/re-export). The mock implementations are identical — the same regex patterns
work for both. Duplication would be wrong.

**Chosen approach:** Keep the mock extractor class in ONE canonical location
(`retrieval/ner/mock-extractor.js` — because its primary hot-path use is query-time).
The ingestion pipeline imports it from there. This is the simplest, no symlinks needed.

The `MockAcronymGlossary` follows the same rule: canonical home in `retrieval/ner/`,
imported by ingestion if ever needed there.

---

## File-by-File Mapping (Current → New)

| Current path | New path | Notes |
|---|---|---|
| `src/config.js` | `src/shared/config.js` | |
| `src/events.js` | `src/shared/events.js` | |
| `src/core/interfaces.js` | `src/shared/interfaces.js` | |
| `src/core/chunker.js` | `src/shared/chunker.js` | |
| `src/core/registry.js` | `src/ingestion/registry.js` | Only used by injection pipeline |
| `src/core/conversation.js` | `src/session/conversation.js` | |
| `src/core/golden-dataset.js` | `src/evaluation/golden-dataset.js` | |
| `src/loaders/mock.js` | `src/ingestion/loaders/mock.js` | |
| `src/loaders/real.js` | `src/ingestion/loaders/real.js` | |
| `src/authority/mock-annotator.js` | `src/ingestion/authority/mock-annotator.js` | Ingest-time only |
| `src/authority/mock-scorer.js` | `src/retrieval/authority/mock-scorer.js` | Query-time only |
| `src/ner/mock-extractor.js` | `src/retrieval/ner/mock-extractor.js` | Canonical; ingestion imports from here |
| `src/ner/mock-glossary.js` | `src/retrieval/ner/mock-glossary.js` | Canonical |
| `src/ner/mock-filter.js` | `src/retrieval/ner/mock-filter.js` | Query-time only |
| `src/ner/interfaces.js` | *(deleted)* | Was a thin re-export; interfaces.js is in shared/ |
| `src/graph/mock-extractor.js` | `src/ingestion/graph/mock-extractor.js` | Ingest-time only |
| `src/graph/mock-store.js` | `src/ingestion/graph/mock-store.js` | Ingest-time only |
| `src/graph/mock-fuser.js` | `src/retrieval/graph/mock-fuser.js` | Query-time only |
| `src/embedders/mock.js` | `src/retrieval/embedders/mock.js` | |
| `src/embedders/gemini.js` | `src/retrieval/embedders/gemini.js` | |
| `src/stores/mock.js` | `src/retrieval/stores/mock.js` | |
| `src/stores/chroma.js` | `src/retrieval/stores/chroma.js` | |
| `src/stores/bm25.js` | `src/retrieval/stores/bm25.js` | |
| `src/stores/hybrid.js` | `src/retrieval/stores/hybrid.js` | |
| `src/rerankers/mock.js` | `src/retrieval/rerankers/mock.js` | |
| `src/rerankers/real.js` | `src/retrieval/rerankers/real.js` | |
| `src/rerankers/authority-aware.js` | `src/retrieval/rerankers/authority-aware.js` | |
| `src/pipelines/injection.js` | `src/ingestion/pipeline.js` | |
| `src/pipelines/retrieval.js` | `src/retrieval/pipeline.js` | |
| `src/pipelines/graph-rag.js` | `src/retrieval/graph-rag.js` | |
| `src/pipelines/agentic-retrieval.js` | `src/agentic/pipeline.js` | |
| `src/agentic/replay.js` | `src/evaluation/replay.js` | It's eval, not agentic logic |
| `src/agentic/*` (rest) | `src/agentic/*` (same) | Folder stays, replay moves out |
| `src/inference/*` | `src/inference/*` | No change |
| `src/server.js` | `src/api/server.js` | |

---

## What This Achieves

**Navigation speed:** "I need to fix query latency" → open `retrieval/`. "I need to add a
new document source" → open `ingestion/loaders/`. "I need to understand the scoring
formula" → open `retrieval/authority/`. No ambiguity.

**Onboarding clarity:** The two phases map directly to the architecture diagrams we drew.
A new contributor reads the diagram, opens the folder, and finds exactly what the diagram
says should be there.

**Swappability preserved:** Every module is still behind an interface. The folder move
doesn't change any of that. `mock-*.js` files are still drop-in swappable for real
implementations.

**No overengineering:** This is NOT Clean Architecture. There are no artificial
`domain/application/infrastructure` layers. The only rule is: does it run at ingest time,
at query time, in the agentic loop, in evaluation, or is it shared? That's it.

---

## What Does NOT Change

- Interface contracts in `shared/interfaces.js`
- Internal logic of every module
- The server's dependency injection pattern
- Test files (paths will update, logic stays)
- The agentic loop internals (coordinator, judge, policy, etc.)
