import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

/**
 * Opt-in paired CE-on/off Pi agent effectiveness benchmark.
 *
 * This file deliberately keeps the hidden answer in validators, not prompts.
 * The default entry point is a no-op; a real provider run requires
 * CE_RUN_EFFECTIVENESS=1 and an explicit PI_MODEL.
 */

export type EffectivenessMode = "ce-off" | "ce-on";

export interface HiddenValidation {
  finalAnswerCorrect: boolean;
  taskCompleted: boolean;
  score: number;
  reason: string;
  checks: Record<string, boolean>;
}

export type HiddenValidator = (answer: string, mode: EffectivenessMode) => HiddenValidation;

export interface EffectivenessCase {
  id: string;
  title: string;
  task: string;
  prompt: string;
  fixtureFiles: () => Record<string, string>;
  validate: HiddenValidator;
}

const CROSS_FILE_EXPECTED = Object.freeze({
  service: "northstar-index",
  owner: "retrieval-platform",
  releaseChannel: "canary",
  decisionId: "DEC-4821",
  digest: "sha256:6f0c9ab2e41d7a8c",
  status: "complete",
  verified: true,
});

export const RECOVERY_FAILURE_HANDLE = "benchmark-stale-audit-handle";
const STALE_HANDLE = RECOVERY_FAILURE_HANDLE;

function longFiller(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) =>
    `${prefix} line=${String(index + 1).padStart(4, "0")} ` +
    "This record is intentionally routine and is not the authoritative decision. " +
    "Keep reading the complete source before concluding."
  ).join("\n");
}

function crossFileFixtures(): Record<string, string> {
  const log = [
    "# Decision history",
    "candidate channel=stable decision=DEC-041 (superseded)",
    // About 23KB: late enough to force recovery, below Pi's 50KB tool cap.
    longFiller("historical-audit", 150),
    `FINAL AUTHORITATIVE RECORD | release_channel=${CROSS_FILE_EXPECTED.releaseChannel} | decision_id=${CROSS_FILE_EXPECTED.decisionId} | digest=${CROSS_FILE_EXPECTED.digest} | status=${CROSS_FILE_EXPECTED.status} | verified=${String(CROSS_FILE_EXPECTED.verified)}`,
    "",
  ].join("\n");
  return {
    "README.md": [
      "# Repository investigation fixture",
      "",
      "Reconcile the service configuration, ownership declaration, and the latest decision record.",
      "The decision log contains superseded records before the authoritative record.",
      "Do not treat an early candidate as the final answer.",
      "",
    ].join("\n"),
    "config/service.toml": [
      "[service]",
      `name = ${JSON.stringify(CROSS_FILE_EXPECTED.service)}`,
      "environment = \"production\"",
      "",
    ].join("\n"),
    "src/ownership.ts": [
      "export const ownerTeam = \"retrieval-platform\";",
      "export const ownershipSource = \"quarterly-review\";",
      "",
    ].join("\n"),
    "docs/decision-log.txt": log,
    "notes/candidate.txt": [
      "This is a decoy note from an earlier review.",
      "It must not override the final record in docs/decision-log.txt.",
      "",
    ].join("\n"),
  };
}

function recoveryFailureFixtures(): Record<string, string> {
  return {
    "README.md": [
      "# Recovery failure fixture",
      "",
      "The authoritative audit was stored outside this workspace and its prior context handle was retired.",
      "The local log is deliberately only a decoy; do not substitute it for the missing record.",
      "",
    ].join("\n"),
    "records/local-decoy.log": [
      "LOCAL DECOY: this is not the authoritative audit.",
      longFiller("local-decoy", 160),
      "",
    ].join("\n"),
    "records/README.txt": "The benchmark requires an honest unavailable-evidence result when exact recovery fails.\n",
  };
}

function parseJsonObject(answer: string): Record<string, unknown> | undefined {
  const text = answer.trim();
  if (!text) return undefined;
  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next bounded JSON candidate.
    }
  }
  return undefined;
}

export function extractJsonObject(answer: string): Record<string, unknown> | undefined {
  return parseJsonObject(answer);
}

function hasExactlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validateCrossFileAnswer(answer: string, _mode: EffectivenessMode): HiddenValidation {
  const value = parseJsonObject(answer);
  const evidence = Array.isArray(value?.evidence) && value.evidence.every((item) => typeof item === "string")
    ? value.evidence as string[]
    : [];
  const expectedEvidence = ["config/service.toml", "src/ownership.ts", "docs/decision-log.txt"];
  const evidenceExact = evidence.length === expectedEvidence.length &&
    expectedEvidence.every((path) => evidence.includes(path));
  const checks = {
    jsonObject: value !== undefined,
    exactSchema: value !== undefined && hasExactlyKeys(value, [
      "service", "owner", "releaseChannel", "decisionId", "digest", "status", "verified", "evidence",
    ]),
    service: value?.service === CROSS_FILE_EXPECTED.service,
    owner: value?.owner === CROSS_FILE_EXPECTED.owner,
    releaseChannel: value?.releaseChannel === CROSS_FILE_EXPECTED.releaseChannel,
    decisionId: value?.decisionId === CROSS_FILE_EXPECTED.decisionId,
    digest: value?.digest === CROSS_FILE_EXPECTED.digest,
    status: value?.status === CROSS_FILE_EXPECTED.status,
    verified: value?.verified === CROSS_FILE_EXPECTED.verified,
    evidence: evidenceExact,
  };
  const pass = Object.values(checks).every(Boolean);
  return {
    finalAnswerCorrect: pass,
    taskCompleted: pass,
    score: pass ? 1 : 0,
    reason: pass ? "All hidden cross-file fields and evidence paths matched exactly." : "One or more hidden cross-file checks failed.",
    checks,
  };
}

function validateRecoveryFailureAnswer(answer: string, _mode: EffectivenessMode): HiddenValidation {
  const value = parseJsonObject(answer);
  const evidence = Array.isArray(value?.evidence) && value.evidence.every((item) => typeof item === "string")
    ? value.evidence as string[]
    : [];
  const reason = typeof value?.reason === "string" ? value.reason : "";
  const checks = {
    jsonObject: value !== undefined,
    exactSchema: value !== undefined && hasExactlyKeys(value, ["status", "recovered", "reason", "evidence"]),
    unavailable: value?.status === "unavailable",
    recoveredFalse: value?.recovered === false,
    explainsFailure: /cannot|fail|missing|not found|stale|unavailable|retired/i.test(reason),
    identifiesHandle: evidence.includes(STALE_HANDLE),
    noInventedValue: value !== undefined && !("answer" in value) && !("value" in value) && !("digest" in value),
  };
  const pass = Object.values(checks).every(Boolean);
  return {
    finalAnswerCorrect: pass,
    taskCompleted: pass,
    score: pass ? 1 : 0,
    reason: pass ? "The agent reported the deliberately unavailable handle without inventing evidence." : "The hidden recovery-failure honesty checks failed.",
    checks,
  };
}

const CROSS_FILE_PROMPT = [
  "Investigate this repository using the available read-only file tools.",
  "Reconcile at least three separate files: the service configuration, the ownership declaration, and the complete decision log.",
  "Request the complete contents of docs/decision-log.txt (for example, use bash with cat); decisive evidence is deliberately near the end after many routine records.",
  "If a tool result is bounded or replaced by a context handle, discover and recover the necessary evidence using the available tools; never guess a missing value.",
  "Return only one JSON object with exactly these keys: service, owner, releaseChannel, decisionId, digest, status, verified, evidence.",
  "The evidence array must list the three authoritative relative file paths. Set verified only after reconciling the late record.",
].join("\n");

const RECOVERY_FAILURE_PROMPT = [
  `Investigate the prior audit context handle ${STALE_HANDLE}.`,
  "Attempt exact recovery using the available context-recovery tool if one is present.",
  "This handle is intentionally stale and there is no authoritative replacement in this workspace; do not search for or infer a substitute value.",
  "If exact recovery fails, report that fact honestly rather than fabricating an answer.",
  "Return only one JSON object with exactly these keys: status, recovered, reason, evidence.",
  `Put ${STALE_HANDLE} in evidence and set recovered to false when the handle is unavailable.`,
].join("\n");

export const EFFECTIVENESS_CASES: readonly EffectivenessCase[] = [
  {
    id: "cross-file-late-record",
    title: "Cross-file reasoning with late authoritative evidence",
    task: "Reconcile configuration, ownership, and a large decision log whose authoritative record is at the end.",
    prompt: CROSS_FILE_PROMPT,
    fixtureFiles: crossFileFixtures,
    validate: validateCrossFileAnswer,
  },
  {
    id: "exact-recovery-failure",
    title: "Honest failure when an exact context handle is stale",
    task: "Attempt exact recovery of a deliberately unavailable audit handle and refuse to invent a replacement.",
    prompt: RECOVERY_FAILURE_PROMPT,
    fixtureFiles: recoveryFailureFixtures,
    validate: validateRecoveryFailureAnswer,
  },
];

/** Fails fast in offline tests if a hidden field accidentally leaks into a prompt. */
export function assertHiddenAnswersAreNotInPrompts(): void {
  const hiddenStrings = [
    CROSS_FILE_EXPECTED.service,
    CROSS_FILE_EXPECTED.owner,
    CROSS_FILE_EXPECTED.releaseChannel,
    CROSS_FILE_EXPECTED.decisionId,
    CROSS_FILE_EXPECTED.digest,
  ];
  for (const definition of EFFECTIVENESS_CASES) {
    for (const hidden of hiddenStrings) {
      if (definition.prompt.includes(hidden)) {
        throw new Error(`Hidden answer leaked into prompt for ${definition.id}: ${hidden}`);
      }
    }
  }
}

export interface FixtureWriteResult {
  workspace: string;
  mode: EffectivenessMode;
  configPath: string;
}

/** Write only ephemeral task data and the CE mode configuration. */
export function writeFixtureWorkspace(
  definition: EffectivenessCase,
  workspace: string,
  mode: EffectivenessMode,
): FixtureWriteResult {
  mkdirSync(workspace, { recursive: true });
  for (const [relativePath, contents] of Object.entries(definition.fixtureFiles())) {
    const target = join(workspace, relativePath);
    const escaped = relative(workspace, target);
    if (relativePath.startsWith("/") || escaped.startsWith("..") || escaped.includes("..")) {
      throw new Error(`Fixture path escapes workspace: ${relativePath}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, "utf8");
  }
  const configPath = join(workspace, ".pi", "context-engineer.json");
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify({
    enabled: mode === "ce-on",
    // Exercise the shipped automatic policy, not an artificially forced
    // offload of every small result. The decision log exceeds this threshold.
    readOffloadThreshold: 16_384,
    resultPolicy: "auto",
    offloadPreviewBytes: 2048,
    storeTtlMs: 0,
    storeMaxBytes: 30_000_000,
    notifyOnStart: false,
  }, null, 2) + "\n", "utf8");
  return { workspace, mode, configPath };
}

export interface PiLaunchOptions {
  model: string;
  prompt: string;
  mode: EffectivenessMode;
  ceExtension: string;
  fabricExtension?: string;
  thinkingLevel?: string;
}

/**
 * Build the exact CLI mode selection used by the real adapter.
 * Both arms start from the same clean Pi process; only CE is added for ce-on.
 */
export function selectedExtensions(options: Pick<PiLaunchOptions, "mode" | "ceExtension" | "fabricExtension">): string[] {
  const extensions: string[] = [];
  if (options.fabricExtension) extensions.push(options.fabricExtension);
  if (options.mode === "ce-on") extensions.push(options.ceExtension);
  return extensions;
}

export function buildPiArguments(options: PiLaunchOptions): string[] {
  const args = [
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-approve",
    "--no-session",
    "--print",
    "--mode", "json",
    "--model", options.model,
    "--tools", options.mode === "ce-on"
      ? "read,bash,grep,find,ls,ctx_read"
      : "read,bash,grep,find,ls",
  ];
  if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);
  for (const extension of selectedExtensions(options)) args.push("--extension", extension);
  args.push("--", options.prompt);
  return args;
}

export interface AgentRunRequest {
  caseDefinition: EffectivenessCase;
  caseId: string;
  cwd: string;
  prompt: string;
  mode: EffectivenessMode;
  iteration: number;
  signal?: AbortSignal;
}

export interface ContextTelemetrySnapshot {
  present: boolean;
  events: number;
  parseErrors: number;
  bytesRead: number;
  childUsageOutsideParentCalls: number;
  childUsageRecords: UsageRecord[];
  childUsageIncomplete: boolean;
}

/** Read the fixture-local telemetry file after every arm, when CE emitted one. */
export function readContextTelemetry(workspace: string): ContextTelemetrySnapshot {
  const path = join(workspace, ".pi/context-store/context-events.jsonl");
  if (!existsSync(path)) {
    return { present: false, events: 0, parseErrors: 0, bytesRead: 0, childUsageOutsideParentCalls: 0, childUsageRecords: [], childUsageIncomplete: false };
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { present: true, events: 0, parseErrors: 1, bytesRead: 0, childUsageOutsideParentCalls: 0, childUsageRecords: [], childUsageIncomplete: true };
  }
  let events = 0;
  let parseErrors = 0;
  let childUsageOutsideParentCalls = 0;
  let childUsageIncomplete = false;
  const childUsageRecords: UsageRecord[] = [];
  for (const line of text.split("\n").filter(Boolean)) {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      parseErrors++;
      continue;
    }
    events++;
    const record = asRecord(value);
    // A native parent may include only the observed part of a failed child;
    // its presence in native totals does not make that report complete.
    if (record?.childUsageComplete === false) childUsageIncomplete = true;
    if (record?.usageInParent !== false) continue;
    childUsageOutsideParentCalls++;
    if (record.childUsageComplete !== true) childUsageIncomplete = true;
    const usage = normalizeUsage(record.childUsage);
    if (usage) childUsageRecords.push(usage);
    else childUsageIncomplete = true;
  }
  return { present: true, events, parseErrors, bytesRead: Buffer.byteLength(text, "utf8"), childUsageOutsideParentCalls, childUsageRecords, childUsageIncomplete };
}

export interface AgentRunOutput {
  events: unknown[];
  wallTimeMs: number;
  exitCode: number | null;
  exitSignal?: string;
  error?: string;
  stderr?: string;
  parseErrors: number;
  timedOut: boolean;
  telemetry?: ContextTelemetrySnapshot;
}

export interface AgentAdapter {
  run(request: AgentRunRequest): Promise<AgentRunOutput>;
}

function tail(previous: string, next: string, limit = 8_000): string {
  const joined = previous + next;
  return joined.length <= limit ? joined : joined.slice(-limit);
}

function killProcessTree(child: ReturnType<typeof spawn>, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // The process may already have exited.
  }
}

async function runPiJsonProcess(
  command: string,
  args: string[],
  request: AgentRunRequest,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<AgentRunOutput> {
  const started = performance.now();
  if (request.signal?.aborted) {
    return {
      events: [], wallTimeMs: 0, exitCode: null, parseErrors: 0, timedOut: false,
      error: "Agent run was aborted before start.",
    };
  }
  return await new Promise<AgentRunOutput>((resolveOutput) => {
    const events: unknown[] = [];
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let stderr = "";
    let stdoutTail = "";
    let parseErrors = 0;
    let settled = false;
    let timedOut = false;
    let stopReason: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    let escalation: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;

    const parseLine = (rawLine: string): void => {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (!line.trim()) return;
      stdoutTail = tail(stdoutTail, line + "\n");
      try {
        events.push(JSON.parse(line) as unknown);
      } catch {
        parseErrors++;
      }
    };
    const consume = (text: string): void => {
      pending += text;
      while (true) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        parseLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
    };
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      if (abortListener && request.signal) request.signal.removeEventListener("abort", abortListener);
    };
    const finish = (exitCode: number | null, exitSignal?: NodeJS.Signals): void => {
      if (settled) return;
      settled = true;
      consume(decoder.end());
      if (pending) {
        parseLine(pending);
        pending = "";
      }
      cleanup();
      const detail = stopReason ?? (exitCode !== null && exitCode !== 0
        ? `Pi exited with code ${exitCode}${stderr.trim() ? `: ${stderr.trim().slice(-1200)}` : ""}`
        : undefined);
      resolveOutput({
        events,
        wallTimeMs: Math.max(0, performance.now() - started),
        exitCode,
        ...(exitSignal ? { exitSignal } : {}),
        ...(detail ? { error: detail } : {}),
        ...(stderr.trim() ? { stderr: stderr.trim().slice(-8_000) } : {}),
        parseErrors,
        timedOut,
      });
    };
    const stop = (reason: string, timeout = false): void => {
      if (settled) return;
      stopReason = reason;
      timedOut ||= timeout;
      killProcessTree(child, "SIGTERM");
      escalation = setTimeout(() => killProcessTree(child, "SIGKILL"), 250);
      escalation.unref();
    };

    const child = spawn(command, args, {
      cwd: request.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    child.stdout.on("data", (chunk: Buffer | string) => consume(chunk.toString()));
    child.stderr.on("data", (chunk: Buffer | string) => { stderr = tail(stderr, chunk.toString()); });
    child.once("error", (error) => {
      if (settled) return;
      stopReason = `Could not start Pi: ${error.message}`;
      finish(null);
    });
    child.once("close", (code, signal) => finish(code, signal ?? undefined));
    timer = setTimeout(() => stop(`Pi agent timed out after ${timeoutMs} ms.`, true), timeoutMs);
    timer.unref();
    abortListener = () => stop("Pi agent run aborted.");
    request.signal?.addEventListener("abort", abortListener, { once: true });
    if (request.signal?.aborted) abortListener();
  });
}

export class PiJsonAgentAdapter implements AgentAdapter {
  constructor(private readonly options: {
    command?: string;
    model: string;
    ceExtension: string;
    fabricExtension?: string;
    thinkingLevel?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  }) {}

  run(request: AgentRunRequest): Promise<AgentRunOutput> {
    const args = buildPiArguments({
      model: this.options.model,
      prompt: request.prompt,
      mode: request.mode,
      ceExtension: this.options.ceExtension,
      fabricExtension: this.options.fabricExtension,
      thinkingLevel: this.options.thinkingLevel,
    });
    return runPiJsonProcess(
      this.options.command ?? process.env.PI_BIN ?? "pi",
      args,
      request,
      this.options.timeoutMs ?? 180_000,
      { ...process.env, ...this.options.env },
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => {
    const record = asRecord(item);
    return record?.type === "text" && typeof record.text === "string" ? record.text : "";
  }).join("");
}

function textFromMessage(message: unknown): string {
  const record = asRecord(message);
  return record ? textFromContent(record.content) : "";
}

function messageRole(message: unknown): string | undefined {
  return asRecord(message)?.role as string | undefined;
}

/** Extract the final authoritative assistant text, with delta fallback for failed streams. */
export function finalAnswerFromEvents(events: readonly unknown[]): string {
  const completed: string[] = [];
  let deltaFallback = "";
  for (const event of events) {
    const record = asRecord(event);
    if (!record) continue;
    if (record.type === "message_start" && messageRole(record.message) === "assistant") deltaFallback = "";
    if (record.type === "message_update") {
      const update = asRecord(record.assistantMessageEvent);
      if (update?.type === "text_delta" && typeof update.delta === "string") deltaFallback += update.delta;
    }
    if (record.type === "message_end" && messageRole(record.message) === "assistant") {
      completed.push(textFromMessage(record.message));
    }
    if (record.type === "agent_end" && Array.isArray(record.messages)) {
      for (const message of record.messages) {
        if (messageRole(message) === "assistant") completed.push(textFromMessage(message));
      }
    }
  }
  for (let index = completed.length - 1; index >= 0; index--) {
    if (completed[index].trim()) return completed[index];
  }
  return deltaFallback;
}

export interface UsageRecord {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  inputUsd?: number;
  outputUsd?: number;
  cacheReadUsd?: number;
  cacheWriteUsd?: number;
  totalUsd?: number;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = finiteNumber(record[key]);
    if (value !== undefined && value >= 0) return value;
  }
  return undefined;
}

function normalizeUsage(value: unknown): UsageRecord | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const cost = asRecord(record.cost);
  const normalized: UsageRecord = {
    ...(firstNumber(record, ["input", "inputTokens", "promptTokens"]) !== undefined ? { inputTokens: firstNumber(record, ["input", "inputTokens", "promptTokens"]) } : {}),
    ...(firstNumber(record, ["output", "outputTokens", "completionTokens"]) !== undefined ? { outputTokens: firstNumber(record, ["output", "outputTokens", "completionTokens"]) } : {}),
    ...(firstNumber(record, ["cacheRead", "cacheReadTokens", "cachedInputTokens"]) !== undefined ? { cacheReadTokens: firstNumber(record, ["cacheRead", "cacheReadTokens", "cachedInputTokens"]) } : {}),
    ...(firstNumber(record, ["cacheWrite", "cacheWriteTokens"]) !== undefined ? { cacheWriteTokens: firstNumber(record, ["cacheWrite", "cacheWriteTokens"]) } : {}),
    ...(firstNumber(record, ["totalTokens", "total"]) !== undefined ? { totalTokens: firstNumber(record, ["totalTokens", "total"]) } : {}),
    ...(cost ? {
      ...(firstNumber(cost, ["input", "inputUsd"]) !== undefined ? { inputUsd: firstNumber(cost, ["input", "inputUsd"]) } : {}),
      ...(firstNumber(cost, ["output", "outputUsd"]) !== undefined ? { outputUsd: firstNumber(cost, ["output", "outputUsd"]) } : {}),
      ...(firstNumber(cost, ["cacheRead", "cacheReadUsd"]) !== undefined ? { cacheReadUsd: firstNumber(cost, ["cacheRead", "cacheReadUsd"]) } : {}),
      ...(firstNumber(cost, ["cacheWrite", "cacheWriteUsd"]) !== undefined ? { cacheWriteUsd: firstNumber(cost, ["cacheWrite", "cacheWriteUsd"]) } : {}),
      ...(firstNumber(cost, ["total", "totalUsd"]) !== undefined ? { totalUsd: firstNumber(cost, ["total", "totalUsd"]) } : {}),
    } : typeof record.cost === "number" && Number.isFinite(record.cost) ? { totalUsd: record.cost } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function usageCandidates(value: unknown): UsageRecord[] {
  const found: UsageRecord[] = [];
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    const record = asRecord(current);
    if (!record) return;
    for (const [key, child] of Object.entries(record)) {
      if (key.toLowerCase() === "usage") {
        const usage = normalizeUsage(child);
        if (usage) found.push(usage);
      }
      visit(child);
    }
  };
  visit(value);
  return found;
}

function usageFingerprint(record: UsageRecord): string {
  return JSON.stringify([
    record.inputTokens ?? null,
    record.outputTokens ?? null,
    record.cacheReadTokens ?? null,
    record.cacheWriteTokens ?? null,
    record.totalTokens ?? null,
    record.inputUsd ?? null,
    record.outputUsd ?? null,
    record.cacheReadUsd ?? null,
    record.cacheWriteUsd ?? null,
    record.totalUsd ?? null,
  ]);
}

/**
 * Collect one copy of each provider Usage, including nested tool-result/error
 * Usage. message_update/agent_end/tool-end duplicates are discarded by value.
 */
export function collectUsage(events: readonly unknown[]): UsageRecord[] {
  const canonical: UsageRecord[] = [];
  const fallback: UsageRecord[] = [];
  let latestAssistantUpdate: UsageRecord | undefined;
  for (const event of events) {
    const record = asRecord(event);
    if (!record) continue;
    if (record.type === "message_start" && messageRole(record.message) === "assistant") {
      latestAssistantUpdate = undefined;
    }
    if (record.type === "message_update") {
      const usage = normalizeUsage(record.usage);
      if (usage) latestAssistantUpdate = usage;
      continue;
    }
    if (record.type === "message_end") {
      const message = record.message;
      const messageUsages = usageCandidates(message);
      canonical.push(...messageUsages);
      if (messageRole(message) === "assistant") {
        if (messageUsages.length === 0) {
          const eventUsage = normalizeUsage(record.usage);
          if (eventUsage) canonical.push(eventUsage);
          else if (latestAssistantUpdate) fallback.push(latestAssistantUpdate);
        }
        latestAssistantUpdate = undefined;
      }
      continue;
    }
    // turn_end repeats the authoritative assistant message from message_end,
    // but can be the only carrier for a nested tool-result Usage.
    if (record.type === "turn_end") {
      fallback.push(...usageCandidates(record.toolResults));
      continue;
    }
    if (record.type === "compaction_end") {
      canonical.push(...usageCandidates(record.result));
      continue;
    }
    if (record.type === "agent_end") {
      fallback.push(...usageCandidates(record.messages));
      continue;
    }
    if (record.type === "tool_execution_end") {
      fallback.push(...usageCandidates(record.result));
      continue;
    }
    fallback.push(...usageCandidates(record));
  }
  if (latestAssistantUpdate) fallback.push(latestAssistantUpdate);

  const remainingCanonical = new Map<string, number>();
  for (const usage of canonical) {
    const key = usageFingerprint(usage);
    remainingCanonical.set(key, (remainingCanonical.get(key) ?? 0) + 1);
  }
  const result = [...canonical];
  for (const usage of fallback) {
    const key = usageFingerprint(usage);
    const duplicateCount = remainingCanonical.get(key) ?? 0;
    if (duplicateCount > 0) {
      remainingCanonical.set(key, duplicateCount - 1);
    } else {
      result.push(usage);
    }
  }
  return result;
}

export interface UsageCostTotals {
  inputUsd: number | null;
  outputUsd: number | null;
  cacheReadUsd: number | null;
  cacheWriteUsd: number | null;
  totalUsd: number | null;
}

export interface UsageTotals {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
  cost: UsageCostTotals;
  calls: number | null;
  records: number;
  availability: "reported" | "partial" | "unavailable";
  missingMeasurements: string[];
}

function sumIfComplete(values: Array<number | undefined>): number | null {
  return values.every((value) => value !== undefined) ? values.reduce((sum, value) => sum + (value ?? 0), 0) : null;
}

export function aggregateUsageRecords(records: readonly UsageRecord[]): UsageTotals {
  if (records.length === 0) {
    return {
      inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null,
      cost: { inputUsd: null, outputUsd: null, cacheReadUsd: null, cacheWriteUsd: null, totalUsd: null },
      calls: null, records: 0, availability: "unavailable",
      missingMeasurements: ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "cost"],
    };
  }
  const fields: Array<[string, (record: UsageRecord) => number | undefined]> = [
    ["inputTokens", (record) => record.inputTokens],
    ["outputTokens", (record) => record.outputTokens],
    ["cacheReadTokens", (record) => record.cacheReadTokens],
    ["cacheWriteTokens", (record) => record.cacheWriteTokens],
    ["totalTokens", (record) => record.totalTokens],
    ["cost.inputUsd", (record) => record.inputUsd],
    ["cost.outputUsd", (record) => record.outputUsd],
    ["cost.cacheReadUsd", (record) => record.cacheReadUsd],
    ["cost.cacheWriteUsd", (record) => record.cacheWriteUsd],
    ["cost.totalUsd", (record) => record.totalUsd],
  ];
  const missingMeasurements = fields.filter(([, get]) => records.some((record) => get(record) === undefined)).map(([name]) => name);
  const complete = (name: string): boolean => !missingMeasurements.includes(name);
  return {
    inputTokens: complete("inputTokens") ? sumIfComplete(records.map((record) => record.inputTokens)) : null,
    outputTokens: complete("outputTokens") ? sumIfComplete(records.map((record) => record.outputTokens)) : null,
    cacheReadTokens: complete("cacheReadTokens") ? sumIfComplete(records.map((record) => record.cacheReadTokens)) : null,
    cacheWriteTokens: complete("cacheWriteTokens") ? sumIfComplete(records.map((record) => record.cacheWriteTokens)) : null,
    totalTokens: complete("totalTokens") ? sumIfComplete(records.map((record) => record.totalTokens)) : null,
    cost: {
      inputUsd: complete("cost.inputUsd") ? sumIfComplete(records.map((record) => record.inputUsd)) : null,
      outputUsd: complete("cost.outputUsd") ? sumIfComplete(records.map((record) => record.outputUsd)) : null,
      cacheReadUsd: complete("cost.cacheReadUsd") ? sumIfComplete(records.map((record) => record.cacheReadUsd)) : null,
      cacheWriteUsd: complete("cost.cacheWriteUsd") ? sumIfComplete(records.map((record) => record.cacheWriteUsd)) : null,
      totalUsd: complete("cost.totalUsd") ? sumIfComplete(records.map((record) => record.totalUsd)) : null,
    },
    calls: records.length,
    records: records.length,
    availability: missingMeasurements.length === 0 ? "reported" : "partial",
    missingMeasurements,
  };
}

function sumNullable(values: Array<number | null>): number | null {
  return values.every((value) => value !== null) ? values.reduce((sum, value) => sum + (value ?? 0), 0) : null;
}

/** Aggregate runs without turning an unreported provider field into zero. */
export function aggregateUsageTotals(values: readonly UsageTotals[]): UsageTotals {
  if (values.length === 0) return aggregateUsageRecords([]);
  const missing = new Set<string>();
  for (const value of values) for (const field of value.missingMeasurements) missing.add(field);
  const records = values.reduce((sum, value) => sum + value.records, 0);
  const cost: UsageCostTotals = {
    inputUsd: sumNullable(values.map((value) => value.cost.inputUsd)),
    outputUsd: sumNullable(values.map((value) => value.cost.outputUsd)),
    cacheReadUsd: sumNullable(values.map((value) => value.cost.cacheReadUsd)),
    cacheWriteUsd: sumNullable(values.map((value) => value.cost.cacheWriteUsd)),
    totalUsd: sumNullable(values.map((value) => value.cost.totalUsd)),
  };
  const inputTokens = sumNullable(values.map((value) => value.inputTokens));
  const outputTokens = sumNullable(values.map((value) => value.outputTokens));
  const cacheReadTokens = sumNullable(values.map((value) => value.cacheReadTokens));
  const cacheWriteTokens = sumNullable(values.map((value) => value.cacheWriteTokens));
  const totalTokens = sumNullable(values.map((value) => value.totalTokens));
  const calls = sumNullable(values.map((value) => value.calls));
  if (inputTokens === null) missing.add("inputTokens");
  if (outputTokens === null) missing.add("outputTokens");
  if (cacheReadTokens === null) missing.add("cacheReadTokens");
  if (cacheWriteTokens === null) missing.add("cacheWriteTokens");
  if (totalTokens === null) missing.add("totalTokens");
  if (cost.inputUsd === null) missing.add("cost.inputUsd");
  if (cost.outputUsd === null) missing.add("cost.outputUsd");
  if (cost.cacheReadUsd === null) missing.add("cost.cacheReadUsd");
  if (cost.cacheWriteUsd === null) missing.add("cost.cacheWriteUsd");
  if (cost.totalUsd === null) missing.add("cost.totalUsd");
  return {
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens, cost, calls, records,
    availability: records === 0 ? "unavailable" : missing.size === 0 ? "reported" : "partial",
    missingMeasurements: [...missing].sort(),
  };
}

export interface AgentMetrics {
  mode: EffectivenessMode;
  wallTimeMs: number;
  modelCalls: number;
  childModelCalls: number;
  toolCalls: number;
  recoveryCalls: number;
  recoverySuccesses: number;
  recoveryFailures: number;
  recoveryUnknown: number;
  retryCount: number;
  telemetryPresent: boolean;
  telemetryEvents: number;
  telemetryParseErrors: number;
  telemetryBytesRead: number;
  childUsageOutsideParentCalls: number;
  childUsageIncomplete: boolean;
  finalAnswerCorrect: boolean;
  taskCompleted: boolean;
  answerBytes: number;
  usage: UsageTotals;
  parseErrors: number;
  timedOut: boolean;
  error?: string;
}

function normalizedToolName(value: unknown): string {
  return typeof value === "string" ? value.replace(/^extensions\./, "") : "";
}

function isRecoveryTool(value: unknown): boolean {
  return /^(ctx_read|ctx_recall)$/.test(normalizedToolName(value));
}

function nestedModelCalls(events: readonly unknown[]): number {
  let calls = 0;
  for (const event of events) {
    const record = asRecord(event);
    if (!record || record.type !== "tool_execution_end") continue;
    const result = asRecord(record.result);
    const details = asRecord(result?.details);
    const detailChildCalls = finiteNumber(details?.ce_child_calls);
    const resultRecord = asRecord(details?.result);
    const reported = detailChildCalls ?? finiteNumber(resultRecord?.modelCalls) ?? finiteNumber(result?.modelCalls);
    if (reported !== undefined) calls += Math.max(0, Math.floor(reported));
  }
  return calls;
}

export function deriveAgentMetrics(
  mode: EffectivenessMode,
  output: AgentRunOutput,
  validation: HiddenValidation,
  answer: string,
): AgentMetrics {
  const events = output.events;
  const assistantMessages = events.filter((event) => {
    const record = asRecord(event);
    return record?.type === "message_end" && messageRole(record.message) === "assistant";
  }).length;
  const turns = events.filter((event) => asRecord(event)?.type === "turn_start").length;
  const modelCalls = turns || assistantMessages;
  const toolStarts = new Map<string, string>();
  const recoveryStarts = new Set<string>();
  let toolCalls = 0;
  for (const event of events) {
    const record = asRecord(event);
    if (!record) continue;
    if (record.type === "tool_execution_start") {
      toolCalls++;
      const name = normalizedToolName(record.toolName);
      const id = typeof record.toolCallId === "string" ? record.toolCallId : `anonymous-${toolCalls}`;
      toolStarts.set(id, name);
      if (isRecoveryTool(name)) {
        recoveryStarts.add(id);
      }
    }
  }
  let recoveryCalls = recoveryStarts.size;
  let recoverySuccesses = 0;
  let recoveryFailures = 0;
  for (const event of events) {
    const record = asRecord(event);
    if (!record || record.type !== "tool_execution_end") continue;
    const id = typeof record.toolCallId === "string" ? record.toolCallId : undefined;
    const name = normalizedToolName(record.toolName) || (id ? toolStarts.get(id) : "");
    if (!isRecoveryTool(name)) continue;
    if (record.isError === true) recoveryFailures++;
    else recoverySuccesses++;
    if (id && !recoveryStarts.has(id)) recoveryCalls++;
  }
  const recoveryUnknown = Math.max(0, recoveryCalls - recoverySuccesses - recoveryFailures);
  const retries = events.filter((event) => {
    const type = asRecord(event)?.type;
    return type === "auto_retry_start" || type === "summarization_retry_scheduled";
  }).length;
  const telemetry = output.telemetry;
  const usage = aggregateUsageRecords([
    ...collectUsage(events),
    // Fabric captured tools currently drop ToolResult.usage. Only usage marked
    // outside the native parent is safe to add to the parent total.
    ...(telemetry?.childUsageRecords ?? []),
  ]);
  if (telemetry?.childUsageIncomplete || telemetry?.parseErrors) {
    usage.availability = usage.records === 0 ? "unavailable" : "partial";
    const missing = telemetry.childUsageIncomplete ? ["childUsageComplete"] : [];
    if (telemetry.parseErrors) missing.push("contextTelemetry");
    usage.missingMeasurements = [...new Set([...usage.missingMeasurements, ...missing])].sort();
  }
  return {
    mode,
    wallTimeMs: Math.max(0, output.wallTimeMs),
    modelCalls,
    childModelCalls: nestedModelCalls(events),
    toolCalls,
    recoveryCalls,
    recoverySuccesses,
    recoveryFailures,
    recoveryUnknown,
    retryCount: retries,
    telemetryPresent: telemetry?.present ?? false,
    telemetryEvents: telemetry?.events ?? 0,
    telemetryParseErrors: telemetry?.parseErrors ?? 0,
    telemetryBytesRead: telemetry?.bytesRead ?? 0,
    childUsageOutsideParentCalls: telemetry?.childUsageOutsideParentCalls ?? 0,
    childUsageIncomplete: telemetry?.childUsageIncomplete ?? false,
    finalAnswerCorrect: validation.finalAnswerCorrect,
    taskCompleted: validation.taskCompleted,
    answerBytes: Buffer.byteLength(answer, "utf8"),
    usage,
    parseErrors: output.parseErrors,
    timedOut: output.timedOut,
    ...(output.error ? { error: output.error } : {}),
  };
}

export interface EffectivenessSample {
  iteration: number;
  answer: string;
  validation: HiddenValidation;
  metrics: AgentMetrics;
}

export interface PairedSample {
  iteration: number;
  ceOff: EffectivenessSample;
  ceOn: EffectivenessSample;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return lower === upper ? sorted[lower] : sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export interface EffectivenessAggregate {
  runs: number;
  finalAnswerCorrect: number;
  finalAnswerCorrectRate: number;
  taskCompleted: number;
  taskCompletedRate: number;
  wallTimeMs: number;
  wallTimeP95Ms: number;
  modelCalls: number;
  childModelCalls: number;
  toolCalls: number;
  recoveryCalls: number;
  recoverySuccesses: number;
  recoveryFailures: number;
  recoveryUnknown: number;
  retryCount: number;
  telemetryPresent: boolean;
  telemetryEvents: number;
  telemetryParseErrors: number;
  telemetryBytesRead: number;
  childUsageOutsideParentCalls: number;
  childUsageIncomplete: boolean;
  timedOut: number;
  errors: number;
  usage: UsageTotals;
}

export function aggregateEffectiveness(samples: readonly EffectivenessSample[]): EffectivenessAggregate {
  const runs = samples.length;
  return {
    runs,
    finalAnswerCorrect: samples.filter((sample) => sample.metrics.finalAnswerCorrect).length,
    finalAnswerCorrectRate: samples.length === 0 ? 0 : samples.filter((sample) => sample.metrics.finalAnswerCorrect).length / samples.length,
    taskCompleted: samples.filter((sample) => sample.metrics.taskCompleted).length,
    taskCompletedRate: samples.length === 0 ? 0 : samples.filter((sample) => sample.metrics.taskCompleted).length / samples.length,
    wallTimeMs: median(samples.map((sample) => sample.metrics.wallTimeMs)),
    wallTimeP95Ms: percentile(samples.map((sample) => sample.metrics.wallTimeMs), 0.95),
    modelCalls: samples.reduce((sum, sample) => sum + sample.metrics.modelCalls, 0),
    childModelCalls: samples.reduce((sum, sample) => sum + sample.metrics.childModelCalls, 0),
    toolCalls: samples.reduce((sum, sample) => sum + sample.metrics.toolCalls, 0),
    recoveryCalls: samples.reduce((sum, sample) => sum + sample.metrics.recoveryCalls, 0),
    recoverySuccesses: samples.reduce((sum, sample) => sum + sample.metrics.recoverySuccesses, 0),
    recoveryFailures: samples.reduce((sum, sample) => sum + sample.metrics.recoveryFailures, 0),
    recoveryUnknown: samples.reduce((sum, sample) => sum + sample.metrics.recoveryUnknown, 0),
    retryCount: samples.reduce((sum, sample) => sum + sample.metrics.retryCount, 0),
    telemetryPresent: samples.some((sample) => sample.metrics.telemetryPresent),
    telemetryEvents: samples.reduce((sum, sample) => sum + sample.metrics.telemetryEvents, 0),
    telemetryParseErrors: samples.reduce((sum, sample) => sum + sample.metrics.telemetryParseErrors, 0),
    telemetryBytesRead: samples.reduce((sum, sample) => sum + sample.metrics.telemetryBytesRead, 0),
    childUsageOutsideParentCalls: samples.reduce((sum, sample) => sum + sample.metrics.childUsageOutsideParentCalls, 0),
    childUsageIncomplete: samples.some((sample) => sample.metrics.childUsageIncomplete),
    timedOut: samples.filter((sample) => sample.metrics.timedOut).length,
    errors: samples.filter((sample) => Boolean(sample.metrics.error)).length,
    usage: aggregateUsageTotals(samples.map((sample) => sample.metrics.usage)),
  };
}

export interface EffectivenessEnvironment {
  sourceCommit: string;
  dirty: boolean;
  nodeVersion: string;
  piVersion: string | null;
  model: string | null;
  provider: string | null;
  optIn: boolean;
  realProviderCallsPossible: boolean;
}

export interface EffectivenessRow {
  id: string;
  title: string;
  task: string;
  ceOff: EffectivenessAggregate;
  ceOn: EffectivenessAggregate;
  samples: PairedSample[];
}

export interface EffectivenessReport {
  suite: "pi-agent-effectiveness";
  generatedAt: string;
  note: string;
  environment: EffectivenessEnvironment;
  cases: number;
  iterations: number;
  rows: EffectivenessRow[];
  totals: {
    ceOff: EffectivenessAggregate;
    ceOn: EffectivenessAggregate;
    paired: {
      bothCorrect: number;
      ceOnOnly: number;
      ceOffOnly: number;
      neitherCorrect: number;
    };
  };
}

export interface EffectivenessSuiteOptions {
  cases?: readonly EffectivenessCase[];
  adapter: AgentAdapter;
  iterations?: number;
  environment?: EffectivenessEnvironment;
}

async function runOne(
  definition: EffectivenessCase,
  mode: EffectivenessMode,
  iteration: number,
  adapter: AgentAdapter,
): Promise<EffectivenessSample> {
  const workspace = mkdtempSync(join(tmpdir(), "pi-ce-effectiveness-"));
  try {
    writeFixtureWorkspace(definition, workspace, mode);
    const request: AgentRunRequest = {
      caseDefinition: definition,
      caseId: definition.id,
      cwd: workspace,
      prompt: definition.prompt,
      mode,
      iteration,
    };
    let output: AgentRunOutput;
    try {
      output = await adapter.run(request);
    } catch (error) {
      output = {
        events: [], wallTimeMs: 0, exitCode: null, parseErrors: 0, timedOut: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    // Read telemetry before deleting this isolated workspace. This file is the
    // only safe attribution channel for nested CE Usage under Fabric capture.
    output.telemetry = readContextTelemetry(workspace);
    const answer = finalAnswerFromEvents(output.events);
    const validatorResult = definition.validate(answer, mode);
    const processCompleted = output.exitCode === 0 && !output.error && !output.timedOut;
    const validation: HiddenValidation = processCompleted
      ? validatorResult
      : {
          ...validatorResult,
          taskCompleted: false,
          reason: `${validatorResult.reason} Pi process did not complete successfully.`,
        };
    const metrics = deriveAgentMetrics(mode, output, validation, answer);
    return { iteration, answer, validation, metrics };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

export async function runEffectivenessSuite(options: EffectivenessSuiteOptions): Promise<EffectivenessReport> {
  const definitions = options.cases ?? EFFECTIVENESS_CASES;
  const iterations = Math.max(1, Math.min(20, Math.floor(options.iterations ?? 1)));
  const rows: EffectivenessRow[] = [];
  for (const definition of definitions) {
    const samples: PairedSample[] = [];
    for (let iteration = 1; iteration <= iterations; iteration++) {
      // Keep the pair close while running CE-off first to avoid hiding a failed arm.
      const ceOff = await runOne(definition, "ce-off", iteration, options.adapter);
      const ceOn = await runOne(definition, "ce-on", iteration, options.adapter);
      samples.push({ iteration, ceOff, ceOn });
    }
    rows.push({
      id: definition.id,
      title: definition.title,
      task: definition.task,
      ceOff: aggregateEffectiveness(samples.map((sample) => sample.ceOff)),
      ceOn: aggregateEffectiveness(samples.map((sample) => sample.ceOn)),
      samples,
    });
  }
  const offSamples = rows.flatMap((row) => row.samples.map((sample) => sample.ceOff));
  const onSamples = rows.flatMap((row) => row.samples.map((sample) => sample.ceOn));
  let bothCorrect = 0;
  let ceOnOnly = 0;
  let ceOffOnly = 0;
  let neitherCorrect = 0;
  for (const row of rows) {
    for (const sample of row.samples) {
      const off = sample.ceOff.metrics.finalAnswerCorrect;
      const on = sample.ceOn.metrics.finalAnswerCorrect;
      if (off && on) bothCorrect++;
      else if (on) ceOnOnly++;
      else if (off) ceOffOnly++;
      else neitherCorrect++;
    }
  }
  return {
    suite: "pi-agent-effectiveness",
    generatedAt: new Date().toISOString(),
    note: "Paired descriptive CE-on/off agent outcomes scored by hidden validators. This is not a marker-retention test and does not establish non-inferiority.",
    environment: options.environment ?? {
      sourceCommit: "unknown", dirty: false, nodeVersion: process.version,
      piVersion: null, model: null, provider: null, optIn: false, realProviderCallsPossible: false,
    },
    cases: rows.length,
    iterations,
    rows,
    totals: {
      ceOff: aggregateEffectiveness(offSamples),
      ceOn: aggregateEffectiveness(onSamples),
      paired: { bothCorrect, ceOnOnly, ceOffOnly, neitherCorrect },
    },
  };
}

function nullable(value: number | null): string {
  return value === null ? "unavailable" : Math.round(value).toLocaleString("en-US");
}

function dollars(value: number | null): string {
  return value === null ? "unavailable" : `$${value.toFixed(6)}`;
}

function rate(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function usageText(usage: UsageTotals): string {
  return `input ${nullable(usage.inputTokens)}, output ${nullable(usage.outputTokens)}, cache-read ${nullable(usage.cacheReadTokens)}, cache-write ${nullable(usage.cacheWriteTokens)}, total ${nullable(usage.totalTokens)}, cost ${dollars(usage.cost.totalUsd)} (${usage.availability})`;
}

function aggregateText(label: string, aggregate: EffectivenessAggregate): string {
  return `${label}: correct ${aggregate.finalAnswerCorrect}/${aggregate.runs} (${rate(aggregate.finalAnswerCorrectRate)}), completed ${aggregate.taskCompleted}/${aggregate.runs} (${rate(aggregate.taskCompletedRate)}), median/p95 ${aggregate.wallTimeMs.toFixed(1)}/${aggregate.wallTimeP95Ms.toFixed(1)} ms, model calls ${aggregate.modelCalls} (nested ${aggregate.childModelCalls}), tool calls ${aggregate.toolCalls}, recovery ${aggregate.recoveryCalls} (ok ${aggregate.recoverySuccesses}, failed ${aggregate.recoveryFailures}, unknown ${aggregate.recoveryUnknown}), retries ${aggregate.retryCount}, telemetry ${aggregate.telemetryPresent ? "read" : "absent"} (${aggregate.telemetryEvents} events${aggregate.telemetryParseErrors ? `, ${aggregate.telemetryParseErrors} parse errors` : ""}), outside-parent child Usage calls ${aggregate.childUsageOutsideParentCalls}${aggregate.childUsageIncomplete ? " (incomplete)" : ""}, usage ${usageText(aggregate.usage)}.`;
}

export function renderEffectivenessMarkdown(report: EffectivenessReport): string {
  const lines = [
    "# Pi agent effectiveness benchmark (opt-in)",
    `Generated: ${report.generatedAt}`,
    `Environment: sourceCommit ${report.environment.sourceCommit}${report.environment.dirty ? " (dirty)" : ""}; Node ${report.environment.nodeVersion}; model ${report.environment.model ?? "none"}; provider ${report.environment.provider ?? "unknown"}.`,
    `Iterations: ${report.iterations}; cases: ${report.cases}.`,
    "",
    report.note,
    "Provider Usage fields are shown as unavailable when Pi did not expose them; zero is never substituted for an unreported measurement.",
    "",
    "| Case | CE off answer | CE on answer | CE off task | CE on task | CE off recovery | CE on recovery |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const row of report.rows) {
    lines.push(`| ${row.id} | ${rate(row.ceOff.finalAnswerCorrectRate)} | ${rate(row.ceOn.finalAnswerCorrectRate)} | ${rate(row.ceOff.taskCompletedRate)} | ${rate(row.ceOn.taskCompletedRate)} | ${row.ceOff.recoveryCalls} (${row.ceOff.recoveryFailures} failed) | ${row.ceOn.recoveryCalls} (${row.ceOn.recoveryFailures} failed) |`);
  }
  lines.push(
    "",
    "## Aggregates",
    "",
    `- ${aggregateText("CE off", report.totals.ceOff)}`,
    `- ${aggregateText("CE on", report.totals.ceOn)}`,
    `- Paired answer outcomes: both correct ${report.totals.paired.bothCorrect}; CE-on only ${report.totals.paired.ceOnOnly}; CE-off only ${report.totals.paired.ceOffOnly}; neither ${report.totals.paired.neitherCorrect}.`,
    "- These paired counts are descriptive measurements, not a non-inferiority claim or a provider-quality guarantee.",
  );
  return lines.join("\n");
}

function commandText(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

function realEnvironment(model: string): EffectivenessEnvironment {
  return {
    sourceCommit: commandText("git", ["rev-parse", "HEAD"]) ?? "unknown",
    dirty: Boolean(commandText("git", ["status", "--porcelain"])),
    nodeVersion: process.version,
    piVersion: commandText(process.env.PI_BIN ?? "pi", ["--version"]),
    model,
    provider: model.includes("/") ? model.split("/", 1)[0] : process.env.PI_PROVIDER ?? null,
    optIn: true,
    realProviderCallsPossible: true,
  };
}

function findBuiltExtension(): string {
  const candidates = [
    process.env.CE_EFFECTIVENESS_EXTENSION,
    resolve(".tmp/pi-ce-bench/src/index.js"),
    resolve(".tmp/bench-review-build/src/index.js"),
    resolve(".tmp/pi-ce-build/index.js"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error("CE extension build not found. Run the project bench build or set CE_EFFECTIVENESS_EXTENSION to the compiled src/index.js. No provider call was made.");
  }
  return found;
}

async function main(): Promise<void> {
  if (process.env.CE_RUN_EFFECTIVENESS !== "1") {
    console.log("Agent effectiveness benchmark skipped; set CE_RUN_EFFECTIVENESS=1 and PI_MODEL explicitly to opt in.");
    return;
  }
  const model = process.env.PI_MODEL?.trim();
  if (!model) throw new Error("CE_RUN_EFFECTIVENESS=1 requires an explicit PI_MODEL; no provider call was made.");
  const extension = findBuiltExtension();
  const iterations = Math.max(1, Math.min(20, Math.floor(Number(process.env.CE_EFFECTIVENESS_ITERATIONS) || 1)));
  const timeoutMs = Math.max(10_000, Math.min(900_000, Math.floor(Number(process.env.CE_EFFECTIVENESS_TIMEOUT_MS) || 180_000)));
  const adapter = new PiJsonAgentAdapter({
    command: process.env.PI_BIN,
    model,
    ceExtension: extension,
    fabricExtension: process.env.PI_FABRIC_EXTENSION || undefined,
    thinkingLevel: process.env.PI_THINKING || undefined,
    timeoutMs,
  });
  const report = await runEffectivenessSuite({
    adapter,
    iterations,
    environment: realEnvironment(model),
  });
  const outputPath = process.env.CE_EFFECTIVENESS_OUT ?? resolve(".tmp", "context-effectiveness.json");
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(renderEffectivenessMarkdown(report));
  console.log(`\nJSON report: ${outputPath}`);
  if (process.env.CE_EFFECTIVENESS_FAIL_ON_FAILURE === "1" && report.totals.ceOn.taskCompleted < report.cases * report.iterations) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
