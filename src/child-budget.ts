import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CHILD_MAX_TOKENS_FLAG = "ce-child-max-tokens";
export const CHILD_MAX_TURNS_FLAG = "ce-child-max-turns";

export type BudgetEnforcementMode = "provider" | "stream" | "none";

/**
 * Describes what the child can honestly promise about maxTokens. A Codex
 * stream is deliberately approximate: its API has no supported output-cap
 * field, so cancellation can race already-generated/billed output.
 */
export interface BudgetEnforcementFlags {
  approximate: boolean;
  providerCap: boolean;
  streamGuard: boolean;
  mayOvershoot: boolean;
  usageMayBeUnknown: boolean;
  limitExceeded: boolean;
}

export interface ChildBudgetMetadata {
  mode: BudgetEnforcementMode;
  flags: BudgetEnforcementFlags;
  estimatedTokens?: number;
}

/** Private event metadata consumed by child.ts; never sent in a provider body. */
export const CHILD_BUDGET_METADATA_KEY = "__ce_child_budget";
/** ASCII-biased estimate used only by the Codex streaming fallback. */
export const STREAM_TOKEN_BYTES = 4;

export function flagsForBudgetEnforcement(
  mode: BudgetEnforcementMode,
  limitExceeded = false,
): BudgetEnforcementFlags {
  return {
    approximate: mode === "stream",
    providerCap: mode === "provider",
    streamGuard: mode === "stream",
    mayOvershoot: mode === "stream",
    usageMayBeUnknown: mode === "stream",
    limitExceeded,
  };
}

type Payload = Record<string, unknown>;
type ChildModel = { api?: unknown; compat?: unknown };

function record(value: unknown): Payload | undefined {
  return !!value && typeof value === "object" && !Array.isArray(value) ? value as Payload : undefined;
}

function capField(payload: Payload, key: string, maxTokens: number): Payload {
  const current = payload[key];
  if (current === undefined) return { ...payload, [key]: maxTokens };
  if (typeof current !== "number" || !Number.isFinite(current)) {
    throw new Error(`Pi provider payload field ${key} is not numeric.`);
  }
  return { ...payload, [key]: Math.min(current, maxTokens) };
}

function capTopLevel(payload: Payload, keys: string[], preferred: string, maxTokens: number): Payload {
  let result = { ...payload };
  let found = false;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      result = capField(result, key, maxTokens);
      found = true;
    }
  }
  return found ? result : capField(result, preferred, maxTokens);
}

function capNested(payload: Payload, parent: string, key: string, maxTokens: number): Payload {
  const current = payload[parent];
  if (current !== undefined && !record(current)) throw new Error(`Pi provider payload field ${parent} is not an object.`);
  const nested = current ? { ...record(current) } : {};
  return { ...payload, [parent]: capField(nested, key, maxTokens) };
}

/**
 * Apply the caller's supported maxTokens budget to the provider-specific
 * payload Pi has already built. This is deliberately limited to fields used
 * by pi-ai adapters; it is not an invented CLI/request option.
 */
export function capProviderPayload(payload: unknown, model: ChildModel | undefined, maxTokens: number): unknown {
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) throw new RangeError("maxTokens must be a positive integer.");
  const top = record(payload);
  if (!top) throw new Error("Pi provider payload is not an object.");

  const api = typeof model?.api === "string" ? model.api : undefined;
  // OpenAI Responses rejects values below its documented provider minimum;
  // this matches pi-ai's own adapter clamp while retaining the caller cap for normal values.
  const effectiveMaxTokens = ["openai-responses", "azure-openai-responses"].includes(api ?? "")
    ? Math.max(16, maxTokens)
    : maxTokens;
  switch (api) {
    case "anthropic-messages":
      return capTopLevel(top, ["max_tokens"], "max_tokens", effectiveMaxTokens);
    case "openai-completions": {
      const compat = record(model?.compat);
      const preferred = compat?.maxTokensField === "max_tokens" ? "max_tokens" : "max_completion_tokens";
      return capTopLevel(top, ["max_tokens", "max_completion_tokens"], preferred, effectiveMaxTokens);
    }
    case "openai-codex-responses":
      // The Codex Responses adapter deliberately builds a body without a
      // supported max-output field. Preserve it byte-for-byte; the extension
      // installs an explicitly approximate streaming fallback instead.
      return { ...top };
    case "openai-responses":
    case "azure-openai-responses":
      return capTopLevel(top, ["max_output_tokens"], "max_output_tokens", effectiveMaxTokens);
    case "google-generative-ai":
    case "google-vertex":
      return capNested(top, "config", "maxOutputTokens", maxTokens);
    case "bedrock-converse-stream":
      return capNested(top, "inferenceConfig", "maxTokens", maxTokens);
    case "mistral-conversations":
      return capTopLevel(top, ["maxTokens", "max_tokens"], "maxTokens", maxTokens);
    case "pi-messages":
      return capNested(top, "options", "maxTokens", maxTokens);
    default: {
      // Custom providers may still use one of pi-ai's established field names.
      // If none is present, fail closed rather than silently running uncapped.
      let result = { ...top };
      let found = false;
      for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens", "maxTokens"]) {
        if (Object.prototype.hasOwnProperty.call(top, key)) {
          result = capField(result, key, maxTokens);
          found = true;
        }
      }
      if (found) return result;
      throw new Error(`Unsupported Pi provider payload for maxTokens (api=${api ?? "unknown"}).`);
    }
  }
}

function flagInteger(pi: ExtensionAPI, name: string, fallback?: number): number | undefined {
  const value = pi.getFlag(name);
  if (value === undefined || value === false) return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new RangeError(`--${name} must be a positive integer.`);
  return parsed;
}

export default function childBudgetExtension(pi: ExtensionAPI): void {
  pi.registerFlag(CHILD_MAX_TURNS_FLAG, {
    description: "Maximum turns for an isolated child Pi run",
    type: "string",
    default: "8",
  });
  pi.registerFlag(CHILD_MAX_TOKENS_FLAG, {
    description: "Requested generation budget for an isolated child Pi run (Codex uses an approximate stream guard)",
    type: "string",
  });

  let turnsStarted = 0;
  let enforcement: BudgetEnforcementMode = "none";
  let activeMaxTokens: number | undefined;
  let streamedBytes = 0;
  let estimatedTokens = 0;
  let limitExceeded = false;
  const seenDeltaKinds = new Set<string>();

  const resetBudget = (mode: BudgetEnforcementMode, maxTokens?: number) => {
    enforcement = mode;
    activeMaxTokens = maxTokens;
    streamedBytes = 0;
    estimatedTokens = 0;
    limitExceeded = false;
    seenDeltaKinds.clear();
  };

  const streamDeltaBytes = (value: unknown): number => {
    const event = record(value);
    if (!event || typeof event.type !== "string") return 0;
    const type = event.type;
    const index = typeof event.contentIndex === "number" ? String(event.contentIndex) : "?";
    const deltaKind = `${type.replace(/_(?:delta|end)$/u, "")}:${index}`;
    if (type === "text_delta" || type === "thinking_delta" || type === "toolcall_delta") {
      if (typeof event.delta !== "string") return 0;
      seenDeltaKinds.add(deltaKind);
      return Buffer.byteLength(event.delta, "utf8");
    }
    if (type === "text_end" || type === "thinking_end") {
      if (seenDeltaKinds.has(deltaKind)) return 0;
      seenDeltaKinds.add(deltaKind);
      return typeof event.content === "string" ? Buffer.byteLength(event.content, "utf8") : 0;
    }
    if (type === "toolcall_end") {
      if (seenDeltaKinds.has(deltaKind)) return 0;
      seenDeltaKinds.add(deltaKind);
      const toolCall = record(event.toolCall);
      if (!toolCall) return 0;
      const args = toolCall.arguments;
      if (typeof args === "string") return Buffer.byteLength(args, "utf8");
      try {
        return Buffer.byteLength(JSON.stringify(args ?? ""), "utf8");
      } catch {
        return 0;
      }
    }
    return 0;
  };

  pi.on("turn_start", (_event, ctx) => {
    const maxTurns = flagInteger(pi, CHILD_MAX_TURNS_FLAG, 8)!;
    if (turnsStarted >= maxTurns) {
      // This fires before the next provider request, so retries/tool loops
      // cannot exceed the operation bound. Any resulting abort is surfaced by
      // the parent as a bounded child failure, not as a successful answer.
      ctx.abort();
      return;
    }
    turnsStarted++;
  });

  pi.on("before_provider_request", (event, ctx) => {
    const maxTokens = flagInteger(pi, CHILD_MAX_TOKENS_FLAG);
    if (maxTokens === undefined) {
      resetBudget("none");
      return;
    }

    const api = typeof ctx.model?.api === "string" ? ctx.model.api : undefined;
    if (api === "openai-codex-responses") {
      // The installed Codex Responses adapter does not support a max-output
      // request property. Do not add one: count UTF-8 stream deltas below and
      // cancel once the rough estimate passes the requested budget instead.
      resetBudget("stream", maxTokens);
      return;
    }

    try {
      const capped = capProviderPayload(event.payload, ctx.model, maxTokens);
      resetBudget("provider", maxTokens);
      return capped;
    } catch (error) {
      // Extension errors are otherwise best-effort in Pi. Abort as well so an
      // unknown provider shape can never silently bypass the requested cap.
      resetBudget("none");
      ctx.abort();
      throw error;
    }
  });

  pi.on("message_update", (event, ctx) => {
    if (enforcement !== "stream" || activeMaxTokens === undefined || limitExceeded) return;
    streamedBytes += streamDeltaBytes(event.assistantMessageEvent);
    estimatedTokens = Math.ceil(streamedBytes / STREAM_TOKEN_BYTES);
    if (estimatedTokens > activeMaxTokens) {
      limitExceeded = true;
      // This is intentionally an abort, not a successful partial answer. The
      // parent turns the resulting aborted child into an explicit failure.
      ctx.abort();
    }
  });

  pi.on("agent_end", (event) => {
    const metadata: ChildBudgetMetadata = {
      mode: enforcement,
      flags: flagsForBudgetEnforcement(enforcement, limitExceeded),
      ...(enforcement === "stream" ? { estimatedTokens } : {}),
    };
    // Keep the marker on the JSON event as well as assistant messages. The
    // latter survives runtimes that copy event metadata before serialization;
    // neither marker is placed in a provider request payload.
    const attachMetadata = (value: unknown) => {
      const target = record(value);
      if (!target) return;
      try { target[CHILD_BUDGET_METADATA_KEY] = metadata; } catch { /* a frozen event still gets normal abort behavior */ }
    };
    attachMetadata(event);
    for (const message of event.messages) {
      const assistant = record(message);
      if (assistant?.role === "assistant") attachMetadata(assistant);
    }
  });
}
