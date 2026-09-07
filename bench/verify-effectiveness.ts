import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore } from "../src/store.js";
import { ceToolMap } from "../src/tools.js";
import { evaluateProgram } from "../src/wrapper.js";
import ts from "typescript";
import { smokeScenarios } from "./e2e.js";
import {
  EFFECTIVENESS_CASES,
  RECOVERY_FAILURE_HANDLE,
  type AgentAdapter,
  type AgentRunOutput,
  type AgentRunRequest,
  type EffectivenessCase,
  type EffectivenessMode,
  aggregateUsageRecords,
  assertHiddenAnswersAreNotInPrompts,
  deriveAgentMetrics,
  buildPiArguments,
  readContextTelemetry,
  runEffectivenessSuite,
  selectedExtensions,
  writeFixtureWorkspace,
} from "./effectiveness.js";

function parentUsage(seed: number): Record<string, unknown> {
  return {
    input: 100 + seed,
    output: 20 + seed,
    cacheRead: 30 + seed,
    cacheWrite: 2,
    totalTokens: 152 + seed * 2,
    cost: {
      input: 0.001 + seed / 1_000_000,
      output: 0.002,
      cacheRead: 0.0003,
      cacheWrite: 0.0001,
      total: 0.0034 + seed / 1_000_000,
    },
  };
}

function nestedUsage(seed: number): Record<string, unknown> {
  return {
    input: 7 + seed,
    output: 3,
    cacheRead: 1,
    cacheWrite: 0,
    totalTokens: 11 + seed,
    cost: { input: 0.00007, output: 0.00003, cacheRead: 0.00001, cacheWrite: 0, total: 0.00011 },
  };
}

function answerFor(caseId: string): string {
  if (caseId === "cross-file-late-record") {
    return JSON.stringify({
      service: "northstar-index",
      owner: "retrieval-platform",
      releaseChannel: "canary",
      decisionId: "DEC-4821",
      digest: "sha256:6f0c9ab2e41d7a8c",
      status: "complete",
      verified: true,
      evidence: ["config/service.toml", "src/ownership.ts", "docs/decision-log.txt"],
    });
  }
  return JSON.stringify({
    status: "unavailable",
    recovered: false,
    reason: `The handle ${RECOVERY_FAILURE_HANDLE} was not found; exact recovery failed.`,
    evidence: [RECOVERY_FAILURE_HANDLE],
  });
}

function writeMockTelemetry(request: AgentRunRequest, usage: Record<string, unknown>): void {
  const path = join(request.cwd, ".pi", "context-store", "context-events.jsonl");
  mkdirSync(join(request.cwd, ".pi", "context-store"), { recursive: true });
  const event = {
    version: 2,
    timestamp: new Date(0).toISOString(),
    sessionId: `mock-${request.iteration}`,
    strategy: "ISOLATE",
    tool: "ctx_read",
    sourceBytes: 12_000,
    visibleBytes: 500,
    sourceTokens: 3_000,
    visibleTokens: 125,
    savedTokens: 2_875,
    internalTokensProcessed: 0,
    mainTokensPrevented: 2_875,
    mainTokensInjected: 125,
    storeTokensWritten: 3_000,
    childUsage: usage,
    childUsageComplete: true,
    usageInParent: false,
  };
  writeFileSync(path, JSON.stringify(event) + "\n", "utf8");
}

/** A deterministic Pi-event stand-in; no provider or model is contacted. */
class FixtureAgentAdapter implements AgentAdapter {
  async run(request: AgentRunRequest): Promise<AgentRunOutput> {
    const answer = answerFor(request.caseId);
    const parent = parentUsage(request.iteration);
    const nested = nestedUsage(request.iteration);
    const toolId = `tool-${request.mode}-${request.caseId}-${request.iteration}`;
    const events: unknown[] = [
      { type: "agent_start" },
      { type: "turn_start" },
      {
        type: "tool_execution_start",
        toolCallId: `inspect-${toolId}`,
        toolName: "bash",
        args: { command: "cat fixture" },
      },
      {
        type: "tool_execution_end",
        toolCallId: `inspect-${toolId}`,
        toolName: "bash",
        result: { content: [{ type: "text", text: "fixture output" }] },
        isError: false,
      },
    ];
    if (request.mode === "ce-on") {
      events.push(
        { type: "tool_execution_start", toolCallId: toolId, toolName: "ctx_read", args: { id: "handle" } },
        {
          type: "tool_execution_end",
          toolCallId: toolId,
          toolName: "ctx_read",
          result: { content: [{ type: "text", text: request.caseId === "exact-recovery-failure" ? "not found" : "late evidence" }] },
          isError: request.caseId === "exact-recovery-failure",
        },
      );
      // This mirrors current Fabric capture: nested ToolResult.usage is not
      // present in the event stream, so only the telemetry file carries it.
      writeMockTelemetry(request, nested);
    } else {
      // A native parent usageInParent=true event must not be added again.
      writeMockTelemetry(request, { ...nested, input: 999_999, totalTokens: 999_999 });
      const telemetryPath = join(request.cwd, ".pi", "context-store", "context-events.jsonl");
      const line = JSON.parse(readFileSync(telemetryPath, "utf8")) as Record<string, unknown>;
      line.usageInParent = true;
      writeFileSync(telemetryPath, JSON.stringify(line) + "\n", "utf8");
    }
    const assistant = { role: "assistant", content: [{ type: "text", text: answer }], usage: parent };
    events.push(
      { type: "message_end", message: assistant },
      { type: "turn_end", message: assistant, toolResults: [] },
      { type: "agent_end", messages: [assistant] },
    );
    if (request.caseId === "exact-recovery-failure") {
      events.push({ type: "auto_retry_start", attempt: 1, maxAttempts: 2 });
    }
    return { events, wallTimeMs: 12 + request.iteration, exitCode: 0, parseErrors: 0, timedOut: false };
  }
}

class WrongAnswerAdapter implements AgentAdapter {
  async run(_request: AgentRunRequest): Promise<AgentRunOutput> {
    const message = { role: "assistant", content: [{ type: "text", text: JSON.stringify({ service: "northstar-index" }) }] };
    return {
      events: [
        { type: "agent_start" },
        { type: "turn_start" },
        { type: "message_end", message },
        { type: "agent_end", messages: [message] },
      ],
      wallTimeMs: 1,
      exitCode: 0,
      parseErrors: 0,
      timedOut: false,
    };
  }
}

function testSmokeContracts(): void {
  for (const scenario of smokeScenarios) {
    const diagnostics = ts.transpileModule(`async function smoke() { ${scenario.program} }`, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022 } }).diagnostics ?? [];
    assert.equal(diagnostics.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0, `${scenario.name}: generated TypeScript must parse`);
    const decision = evaluateProgram(scenario.program, { strict: scenario.strict ?? false });
    assert.equal(decision.tier === "BLOCK", scenario.strict === true, `${scenario.name}: policy matches the isolated fixture configuration`);
    assert.equal(scenario.assert(scenario.prompt, [], "/nonexistent-smoke-workspace"), false, `${scenario.name}: echoed prompt is not execution evidence`);
  }
  const summary = smokeScenarios.find(scenario => scenario.name.includes("summary"))!;
  assert.ok(summary.program.includes("maxInputTokens: 2048") && summary.program.includes("maxChunks: 4"));
  assert.ok(smokeScenarios.find(scenario => scenario.name.includes("numeric"))!.program.includes("Number(raw.output)"));
}

function testModeSelection(): void {
  const common = { ceExtension: "/tmp/ce.js", fabricExtension: "/tmp/fabric.js" };
  assert.deepEqual(selectedExtensions({ ...common, mode: "ce-off" }), ["/tmp/fabric.js"]);
  assert.deepEqual(selectedExtensions({ ...common, mode: "ce-on" }), ["/tmp/fabric.js", "/tmp/ce.js"]);
  const off = buildPiArguments({ ...common, mode: "ce-off", model: "mock/provider", prompt: "safe prompt" });
  const on = buildPiArguments({ ...common, mode: "ce-on", model: "mock/provider", prompt: "safe prompt" });
  assert.equal(off.includes("/tmp/ce.js"), false);
  assert.equal(on.includes("/tmp/ce.js"), true);
  assert.equal(off.some((argument) => argument.includes("ctx_read")), false);
  assert.equal(on.some((argument) => argument.includes("ctx_read")), true);
  assert.equal(off.includes("--no-extensions"), true);
  assert.equal(on.includes("--no-extensions"), true);
}

function testFixtureShape(): void {
  const definition = EFFECTIVENESS_CASES.find((item) => item.id === "cross-file-late-record")!;
  const files = definition.fixtureFiles();
  const log = files["docs/decision-log.txt"];
  const late = log.indexOf("FINAL AUTHORITATIVE RECORD");
  assert.ok(late > 20_000, `late evidence was only ${late} bytes into the fixture`);
  assert.equal(log.includes("northstar-index"), false, "service must be discovered from a separate file");
  assert.equal(log.includes("retrieval-platform"), false, "ownership must be discovered from a separate file");
  assert.equal(definition.prompt.includes("FINAL AUTHORITATIVE RECORD"), false, "do not hand the agent a retrieval needle");
  assert.equal(definition.prompt.includes("northstar-index"), false);
  assert.equal(definition.prompt.includes("DEC-4821"), false);

  const workspace = mkdtempSync(join(tmpdir(), "pi-ce-effectiveness-verify-"));
  try {
    writeFixtureWorkspace(definition, workspace, "ce-on");
    const config = JSON.parse(readFileSync(join(workspace, ".pi", "context-engineer.json"), "utf8")) as Record<string, unknown>;
    assert.equal(config.enabled, true);
    assert.equal(config.readOffloadThreshold, 16_384);
    assert.equal(config.resultPolicy, "auto");
    assert.equal(config.offloadPreviewBytes, 2048);
    writeFixtureWorkspace(definition, workspace, "ce-off");
    const offConfig = JSON.parse(readFileSync(join(workspace, ".pi", "context-engineer.json"), "utf8")) as Record<string, unknown>;
    assert.equal(offConfig.enabled, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

async function testSummaryOverflowContract(): Promise<void> {
  const workspace = mkdtempSync(join(tmpdir(), "pi-ce-summary-overflow-"));
  try {
    const store = new ContextStore(workspace, ".pi/context-store", { ttlMs: 0, maxBytes: 1_000_000 });
    const handle = store.write("overflow", "offline-test", "source-data-" + "x".repeat(12_000));
    const probe = store.read(handle.id, { offset: 0, length: 0 });
    assert.equal(probe.ok, true, "offline verifier must use a real ReadResult with ok=true");
    const summarize = ceToolMap.get("ctx_summarize");
    assert.ok(summarize, "ctx_summarize registration is required");
    let modelCalls = 0;
    const result = await summarize!.handler({
      id: handle.id,
      mode: "model",
      maxInputTokens: 1_024,
      maxChunks: 1,
      maxCalls: 128,
    }, {
      store,
      workspaceRoot: workspace,
      maxReturnBytes: 16_384,
      callTool: async () => ({}),
      spawnAgent: async () => { modelCalls++; return ""; },
      modelCall: async () => { modelCalls++; return ""; },
    });
    const record = result as Record<string, unknown>;
    assert.equal(record.code, "summary_input_budget_exceeded");
    assert.equal(record.modelCalls, 0);
    assert.equal(modelCalls, 0);
    assert.equal(record.complete, false);
    assert.equal(record.coveredBytes, 0);
    assert.equal((record.recovery as Record<string, unknown>).id, handle.id);
    assert.equal(record.totalBytes, probe.totalBytes);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function testNestedCallMetric(): void {
  const metrics = deriveAgentMetrics(
    "ce-on",
    { events: [{ type: "turn_start" }, { type: "tool_execution_end", result: { details: { ce_child_calls: 3 } } }], wallTimeMs: 1, exitCode: 0, parseErrors: 0, timedOut: false },
    { finalAnswerCorrect: true, taskCompleted: true, score: 1, reason: "fixture", checks: { fixture: true } },
    "{}",
  );
  assert.equal(metrics.modelCalls, 1);
  assert.equal(metrics.childModelCalls, 3);
}

function testTelemetryAvailabilityLabels(): void {
  const workspace = mkdtempSync(join(tmpdir(), "pi-ce-telemetry-"));
  try {
    const path = join(workspace, ".pi", "context-store", "context-events.jsonl");
    mkdirSync(join(workspace, ".pi", "context-store"), { recursive: true });
    writeFileSync(path, [
      "not-json",
      JSON.stringify({ usageInParent: false, childUsageComplete: false }),
      JSON.stringify({ usageInParent: true, childUsageComplete: true, childUsage: parentUsage(9) }),
    ].join("\n") + "\n", "utf8");
    const snapshot = readContextTelemetry(workspace);
    assert.equal(snapshot.present, true);
    assert.equal(snapshot.parseErrors, 1);
    assert.equal(snapshot.childUsageOutsideParentCalls, 1);
    assert.equal(snapshot.childUsageRecords.length, 0);
    assert.equal(snapshot.childUsageIncomplete, true);
    writeFileSync(path, JSON.stringify({ usageInParent: true, childUsageComplete: false, childUsage: parentUsage(9) }) + "\n");
    const nativePartial = readContextTelemetry(workspace);
    assert.equal(nativePartial.childUsageIncomplete, true, "native partial reports must not look complete");
    assert.equal(nativePartial.childUsageRecords.length, 0, "native usage must not be added twice");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

async function testSummaryReductionContract(): Promise<void> {
  const workspace = mkdtempSync(join(tmpdir(), "pi-ce-summary-reduction-"));
  try {
    const store = new ContextStore(workspace, ".pi/context-store", { ttlMs: 0, maxBytes: 1_000_000 });
    const handle = store.write("reduction", "offline-test", "source-data-" + "x".repeat(5_000));
    const probe = store.read(handle.id, { offset: 0, length: 0 });
    assert.equal(probe.ok, true);
    const summarize = ceToolMap.get("ctx_summarize");
    assert.ok(summarize);
    let modelCalls = 0;
    const prompts: string[] = [];
    const result = await summarize!.handler({
      id: handle.id,
      mode: "model",
      maxTokens: 64,
      maxInputTokens: 1_024,
      maxChunks: 3,
      maxCalls: 5,
    }, {
      store,
      workspaceRoot: workspace,
      maxReturnBytes: 16_384,
      callTool: async () => ({}),
      spawnAgent: async () => { modelCalls++; return "partial"; },
      modelCall: async (prompt: string) => { prompts.push(prompt); modelCalls++; return "partial"; },
    });
    const record = result as Record<string, unknown>;
    assert.equal(record.code, undefined);
    assert.equal(record.modelCalls, 5, "three leaves plus two binary reductions");
    assert.equal(modelCalls, 5);
    assert.equal(record.chunks, 3);
    assert.equal(record.complete, true);
    assert.equal(record.coveredBytes, probe.totalBytes);
    assert.equal(record.totalBytes, probe.totalBytes);
    assert.equal(prompts.length, 5);
    assert.equal(prompts.every((prompt) => prompt.includes("--- SOURCE DATA ---")), true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  assertHiddenAnswersAreNotInPrompts();
  testSmokeContracts();
  testModeSelection();
  testFixtureShape();
  testNestedCallMetric();
  testTelemetryAvailabilityLabels();
  await testSummaryOverflowContract();
  await testSummaryReductionContract();

  const report = await runEffectivenessSuite({
    cases: EFFECTIVENESS_CASES,
    iterations: 2,
    adapter: new FixtureAgentAdapter(),
  });
  assert.equal(report.suite, "pi-agent-effectiveness");
  assert.equal(report.cases, 2);
  assert.equal(report.iterations, 2);
  assert.equal(report.totals.ceOff.finalAnswerCorrect, 4);
  assert.equal(report.totals.ceOn.finalAnswerCorrect, 4);
  assert.equal(report.totals.ceOn.taskCompleted, 4);
  assert.equal(report.totals.ceOn.recoveryCalls, 4);
  assert.equal(report.totals.ceOn.recoverySuccesses, 2);
  assert.equal(report.totals.ceOn.recoveryFailures, 2);
  assert.equal(report.totals.ceOn.retryCount, 2);
  assert.equal(report.totals.ceOn.childUsageOutsideParentCalls, 4);
  assert.equal(report.totals.ceOn.usage.inputTokens, 2 * (101 + 102) + 2 * (8 + 9), "parent plus only outside-parent child Usage is counted");
  assert.equal(report.totals.ceOff.usage.inputTokens, 2 * (100 + 1) + 2 * (100 + 2), "usageInParent=true telemetry is not added");
  assert.equal(report.totals.ceOn.usage.availability, "reported");
  assert.equal(report.totals.ceOff.usage.availability, "reported");
  assert.equal(report.totals.paired.bothCorrect, 4);

  const wrong = await runEffectivenessSuite({
    cases: [EFFECTIVENESS_CASES[0]],
    iterations: 1,
    adapter: new WrongAnswerAdapter(),
  });
  assert.equal(wrong.totals.ceOn.finalAnswerCorrect, 0, "partial JSON is not marker retention or a correct answer");
  assert.equal(wrong.totals.ceOn.taskCompleted, 0);
  assert.equal(wrong.totals.ceOn.usage.availability, "unavailable");
  assert.equal(wrong.rows[0].ceOn.recoveryCalls, 0);

  const usage = aggregateUsageRecords([{ inputTokens: 10, outputTokens: 2 }]);
  assert.equal(usage.inputTokens, 10);
  assert.equal(usage.outputTokens, 2);
  assert.equal(usage.cacheReadTokens, null);
  assert.equal(usage.availability, "partial");
  console.log("effectiveness verifier: offline fixtures, hidden validators, mode selection, telemetry Usage, nested calls, recovery counts, and summary contracts passed");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
