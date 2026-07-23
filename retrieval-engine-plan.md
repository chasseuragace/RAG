# Retrieval Engine Roadmap

This document captures the target architecture, phases, and implementation status for the agentic RAG system. It is the source of truth for future work.

---

## Current Architecture

```
RetrievalGoal  (objective, latencyBudget, maxIterations, minimumQuality)
       │
       ▼
Observation  (query, results, rerankedResults, trace)
       │
       ▼
  Coordinator
       │
       ▼
    Judge
       │
       ▼
RetrievalAssessment  (descriptive only: quality, completeness, consistency, sourceDiversity, missingEvidence)
       │
       ▼
    Policy
       │
       ▼
   Decision  (action + rationale + evidence + priority)
       │
       ▼
   Executor
       │
       ▼
Observation'  (updated with Trace)
```

**Key contracts:**
- Judge describes reality. It does not recommend actions.
- Policy decides what to do about that reality.
- Coordinator owns time: respects `goal.latencyBudget` and `goal.maxIterations`.
- Executor executes. It does not make scheduling decisions.
- Trace is the canonical execution record. Events are one projection of it.

---

## Completed

| Phase | Description | Status |
|-------|-------------|--------|
| 0 | Hybrid search (RRF), reranking, BM25, interfaces | ✅ |
| 1 | Assessment + Trace + Goal (RetrievalAssessment, Decision, Coordinator, Policy) | ✅ |
| 2 | Hypothesis-driven Actions (rationale + evidence on every Decision, trace preservation) | ✅ |
| 3 | Additional Policies (AggressiveRetrievalPolicy, LowLatencyPolicy, BalancedPolicy) | ✅ |
| 5 | LLM-backed Strategy (LLMPolicy, GoldenDataset, ReplayHarness) | ✅ |

---

## Phase 1: Assessment + Trace + Goal

**Goal:** Replace numeric `retrievalQuality` with a descriptive `RetrievalAssessment`. Introduce `Trace` and `Decision` value objects. Make `RetrievalGoal` explicit with an enum `objective`.

**New files:**
- `src/agentic/assessment.js` — `RetrievalAssessment`
- `src/agentic/decision.js` — `Decision`
- `src/agentic/trace.js` — `Trace`, `TraceEvent`
- `src/agentic/coordinator.js` — replaces `planner.js`
- `src/agentic/policy.js` — `RetrievalPolicy` interface
- `src/agentic/policies/heuristic.js` — `HeuristicRetrievalPolicy`

**Modified files:**
- `src/agentic/judge.js` — returns `RetrievalAssessment`
- `src/agentic/observation.js` — add `trace`, `goal`
- `src/agentic/strategies/heuristic.js` — wires policy + coordinator
- `src/core/interfaces.js` — add `RetrievalAssessment`, `Decision`, `Trace`, `RetrievalPolicy`, `RetrievalGoal`
- `src/pipelines/agentic-retrieval.js` — expose `trace`, `assessment`, `goal`, `decision` in response
- `src/agentic/planner.js` — deprecated, to be removed after Phase 1

**Tests:**
- Assessment includes all descriptive fields, no `recommendation`
- Decision includes `action`, `rationale`, `evidence`, `priority`
- Trace accumulates events across iterations
- Trace emitted as `serverEvents` projection
- Goal propagates through pipeline → strategy → observation
- Coordinator respects `maxIterations` and `latencyBudget`
- Policy decisions branch on `goal.objective`

**Acceptance criteria:**
- `AgenticRetrievalPipeline.run()` returns `{ ..., assessment, decision, trace, goal }`
- Every trace event has `{ timestamp, iteration, phase, action, assessment, decision, timing }`
- `RetrievalAssessment` has zero policy logic
- `RetrievalObjective` is an enum, not free text

---

## Phase 2: Hypothesis-driven Actions ✅

**Goal:** Every `Decision` carries `rationale` (why) and `evidence` (what data supports it). Actions are explainable from the trace alone.

**Modified files:**
- `src/agentic/policies/heuristic.js` — rationale and evidence on all branches (was already complete)
- `src/agentic/trace.js` — `toArray()` normalises both `Decision`-as-action and plain-action objects; `add()` emits rationale to `serverEvents`
- `src/agentic/executor.js` — fixed `action.type` → `action.action || action.type` (Decision objects use `.action`)
- `src/agentic/coordinator.js` — post-loop final judge+policy pass instead of hardcoded `stop`
- `tests/phase2-3.test.js` — verifies rationale/evidence on all policy branches and trace serialization

**Acceptance criteria:** ✅
- Every `Decision` has non-empty `rationale` and `evidence`
- Trace events preserve rationale across iterations

---

## Phase 3: Additional Policies ✅

**Goal:** Prove policy pluggability by adding policies that produce different decisions for the same assessment.

**New files:**
- `src/agentic/policies/aggressive.js` — `AggressiveRetrievalPolicy` (maximise recall, rewrite first)
- `src/agentic/policies/lowlatency.js` — `LowLatencyPolicy` (answer fast, single topK expansion, no rewrites)
- `src/agentic/policies/balanced.js` — `BalancedPolicy` (production default, replaces heuristic long-term)

**Tests:**
- Each policy produces a distinct decision for the same assessment/goal ✅
- Swapping policy changes pipeline behavior without touching coordinator, executor, or judge ✅

**Acceptance criteria:** ✅
- Swapping policy changes behavior without touching coordinator, executor, or judge

---

## Future (Not Scheduled)

| Item | Description | Blocker |
|------|-------------|---------|
| Phase 4: Capability Registry | Planner asks "what tools exist?" rather than assuming | Need 3+ distinct capabilities |
| Phase 5: LLM-backed Strategy | Replace heuristics with LLM-driven decisions | Golden dataset + evaluation harness |
| ExecutionContext | Expand `RetrievalGoal` into richer execution context (tenant, permissions, feature flags) | Multi-tenancy requirements |
| Replayability | Record and replay Assessment/Decision/Trace against golden dataset | Phase 1-2 complete |

---

## Guiding Principles

1. **Judge describes, Policy decides, Executor executes, Coordinator coordinates.**
2. **Optimize for evaluation and replayability, not LLM integration.**
3. **Value objects (Assessment, Decision, Trace, Goal) carry state. Components transform them.**
4. **Policies encode business tradeoffs. Strategies encode implementation choices.**
5. **Trace is canonical. Events are a projection.**
