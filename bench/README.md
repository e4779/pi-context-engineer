# Context Engineer benchmark harness

This directory contains two deliberately separate suites: a deterministic context-plumbing regression suite and an opt-in Pi agent-effectiveness harness.

The default suite measures whether CE reduces data entering Main while preserving a deterministic plumbing result. Its known markers are not model answers and cannot establish agent effectiveness or non-inferiority.

## Run

```bash
npm run bench
```

The existing Pi/Fabric smoke tests are also plumbing/integration checks (including marker retention), not effectiveness evaluations. Pass any configured model explicitly only when you intentionally want to run them:

```bash
CE_RUN_E2E=1 PI_MODEL=openai-codex/gpt-5.6-luna npm run bench:e2e
```

The smoke-test runner disables auto-discovered extensions and loads CE/Fabric explicitly. Separately, `npm run bench` runs every descriptor in `bench/cases/` locally in two simulated modes:

- **baseline**: the complete simulated Pi/Fabric tool result is returned to Main.
- **CE**: the result is written to the addressable store, then only a handle, bounded preview, and task-specific selection/summary are returned.

These cases exercise deterministic storage, selection, compression, and exact marker plumbing only; they do not run an agent or score an answer.

The runner writes `.tmp/context-benchmark.json`. It performs one warmup and three measured iterations by default, reports median and p95 wall time, and retains every sample in the JSON result. Override these with `CE_BENCHMARK_WARMUP` and `CE_BENCHMARK_ITERATIONS`.

For the retained v0.5.0 release artifact (the v0.4.0 artifact remains frozen):

```bash
PI_MODEL=openai-codex/gpt-5.6-luna CE_BENCHMARK_WARMUP=1 CE_BENCHMARK_ITERATIONS=30 CE_BENCHMARK_OUT=bench/results/v0.5.0.json npm run bench
```

The machine-readable contract is `bench/result.schema.json`. Retained workload evidence is `bench/results/v0.5.0.json`; `bench/results/v0.4.0.json` is the byte-identical comparison baseline. Results record sourceCommit/dirty state, Node/Pi/Fabric versions, model/provider, Main input/output/injected tokens, internal model tokens, logical offload bytes, selected bytes retrieved, wall time, deterministic plumbing checks, and all per-iteration samples. The retained JSON uses legacy field names for compatibility; see `bench/result.schema.json` for the non-effectiveness disclaimer.

The v0.5 static policy benchmark is separate from the frozen workload benchmark:

```bash
POLICY_BENCHMARK_OUT=bench/results/v0.5.0-quantitative-policy.json npm run bench:policy
```

It runs symbolic `Math.min`, alias, conditional, and `Math.max` caps plus unknown, over-budget, and legacy-safe parity cases. Its report records sourceCommit, dirty state, runtime/model provenance, deterministic policy decision checks, decisions, bounds, and analysis timing; `bench/policy-result.schema.json` defines its retained contract. It does not replace or mutate the retained v0.4 workload artifact.

## Metrics

Each deterministic row captures Main context tokens, tool-result tokens, child-model tokens, wall time, disk bytes, plumbing-check status, and completion. Derived metrics are:

```text
mainTokensPrevented = baseline Main tokens - CE Main tokens
contextEfficiency = mainTokensPrevented / (extraInternalTokens + mainTokensInjected)
legacy qualityAdjustedSavings = mainTokensPrevented when the deterministic plumbing check succeeds, otherwise 0 (not answer-quality savings)
```

The cases use deterministic local workloads and a deterministic model stub for the hierarchical-summary case. They are suitable for regression and relative plumbing comparisons, not claims about a particular provider/model's answer quality. Do not infer non-inferiority from marker retention. Provider-backed Pi/Fabric runs belong in the separate suite below.

Add a deterministic plumbing workload by placing a JSON descriptor in `bench/cases/` and extending `makePayload`/`ceMetrics` only when the workload needs a new execution shape.

## Opt-in Pi agent effectiveness

`bench/effectiveness.ts` runs the same multi-file tasks in paired CE-off and CE-on ephemeral workspaces using the real Pi JSON event stream. Hidden validators keep expected answers out of prompts; cases include late-position evidence, exact handle recovery, and an intentionally stale-handle failure that must be reported honestly. It scores final answers/task outcomes, not marker retention, and records model input/output/cache tokens and cost when exposed, nested Usage when safely attributable, latency, model/tool/recovery/retry counts, and explicit `unavailable` fields when providers omit measurements.

The paired fixture uses the shipped `auto` policy with a 16 KB threshold and a 2 KB preview. Required facts are split across files and the prompt does not supply an exact retrieval needle. These small read/recovery tasks do not establish broad coding-agent non-inferiority or semantic-summary quality. It is never run by default and can make provider calls. With the installed Fabric captured-tools provider, nested `ToolResult.usage` is not present in the native event/result shape; the harness therefore adds only `childUsage` from fixture `context-events.jsonl` events explicitly marked `usageInParent: false`. Random nested IDs are not used for attribution, and incomplete/malformed telemetry leaves Usage fields partial or unavailable.

```bash
CE_RUN_EFFECTIVENESS=1 PI_MODEL=openai-codex/gpt-5.6-luna npm run bench:effectiveness
```

Use `CE_EFFECTIVENESS_ITERATIONS`, `CE_EFFECTIVENESS_TIMEOUT_MS`, `CE_EFFECTIVENESS_OUT`, and `CE_EFFECTIVENESS_FAIL_ON_FAILURE=1` as needed. The JSON contract is `bench/effectiveness-result.schema.json`. New reports default to `.tmp/context-effectiveness.json`, outside tracked `bench/results/`. Do not run this command in offline verification or CI unless paid/provider use is explicitly approved.

The deterministic, no-provider check uses the same fixture writer, mode selector, validators, event accounting, and aggregation:

```bash
npm run verify:effectiveness  # also included in npm test
```

The verifier also checks the current explicit `summary_input_budget_exceeded` contract: overflow reports zero model calls and an exact recovery handle rather than a prefix-only fallback.

## Regression note

Deterministic benchmark output is informational, not a merge gate: wall time and model-backed summaries vary by machine and provider. CI runs `npm run bench` with `continue-on-error: true` and always uploads `.tmp/context-benchmark.json`. The effectiveness suite is opt-in and its provider results must not be treated as CI defaults. Track plumbing regressions by diffing retained artifacts (`bench/results/*.json` against `bench/result.schema.json`); assess agent effectiveness only from paired hidden-validator reports.
