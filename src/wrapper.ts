/**
 * Enforcement policy for Fabric code-mode programs.
 *
 * The analyzer supplies data-flow severity. By default, uncertain source-bearing
 * returns execute under the runtime boundary guard; strict mode blocks them.
 * Default preflight is advisory even for estimated oversize or unknown values.
 * Fabric retains authoritative validation; CE guards the actual model boundary.
 */

import { analyzeProgram, type AnalysisResult } from "./analyzer.js";
import type { ContextBoundaryPolicy } from "./quantitative-policy.js";

export interface WrapperOptions {
  /** When true, uncertain source returns and soft warnings are blocked. Default: false. */
  strict?: boolean;
  /** Legacy compatibility setting; reduction/cost is now the primary policy. */
  maxUnprocessedToolCalls?: number;
  /**
   * Estimated-return advisory budget; enforced only by explicit blocking modes. Default: 4000.
   * Maps to ~16KB at ~4 chars/token (ASCII-biased); prefer byte budgets at the boundary.
   */
  maxReturnTokens?: number;
  /**
   * Block statically unbounded source returns before execution. Default: false.
   * When false, the runtime boundary guard executes the task and offloads only
   * if the actual result is large. `strict: true` always enables blocking.
   */
  blockUnboundedReturns?: boolean;
  /**
   * Optional quantitative budgets for additive v0.5 policy decisions.
   * Single policy source: maxBytes also unifies the runtime offload budget
   * (see resolveRuntimeByteBudget); token estimates are ~bytes/4 ASCII-biased.
   */
  quantitativePolicy?: ContextBoundaryPolicy;
}

export interface ExecResult {
  ok: boolean;
  blocked: boolean;
  analysis: AnalysisResult;
  result?: unknown;
  warning?: string;
  error?: string;
}

export function evaluateProgram(
  program: string,
  opts: WrapperOptions = {},
): { tier: "BLOCK" | "WARN" | "PASS"; analysis: AnalysisResult; guidance: string } {
  const analysis = analyzeProgram(program, {
    maxUnprocessedToolCalls: opts.maxUnprocessedToolCalls,
    maxReturnTokens: opts.maxReturnTokens,
    quantitativePolicy: opts.quantitativePolicy,
  });
  const strict = opts.strict ?? false;

  if (!analysis.ok) {
    // Static estimates cannot decide what the agent needs or what a program
    // will actually return. Default to advice even for zero-source projections
    // and estimated oversize values; Fabric owns syntax/execution validation.
    if (strict || (opts.blockUnboundedReturns === true && analysis.hardBlock)) {
      return {
        tier: "BLOCK",
        analysis,
        guidance: formatBlockGuidance(analysis.reasons, analysis.metrics),
      };
    }
    return {
      tier: "WARN",
      analysis,
      guidance: formatRuntimeGuardWarning(analysis.metrics),
    };
  }

  return { tier: "PASS", analysis, guidance: "" };
}

/** Analyze, then delegate to the real executor unless the policy blocks. */
export async function wrappedExec(
  program: string,
  realExec: (program: string) => Promise<unknown>,
  opts: WrapperOptions = {},
): Promise<ExecResult> {
  const decision = evaluateProgram(program, opts);
  if (decision.tier === "BLOCK") {
    return { ok: false, blocked: true, analysis: decision.analysis, error: decision.guidance };
  }

  const result = await realExec(program);
  if (decision.tier === "WARN") {
    return { ok: true, blocked: false, analysis: decision.analysis, result, warning: decision.guidance };
  }
  return { ok: true, blocked: false, analysis: decision.analysis, result };
}

function formatBlockGuidance(reasons: string[], metrics: AnalysisResult["metrics"]): string {
  return [
    "fabric_exec BLOCKED by context-engineer — return does not satisfy the configured context policy.",
    "",
    ...reasons.map((reason) => `  • ${reason}`),
    "",
    `  • transformations: ${metrics.transformationCount}, reduced: ${metrics.returnIsReduced}, bounded: ${metrics.provablyBounded}, est. retention upper bound: ${metrics.estimatedRetentionRatio === null ? "?" : Math.round(metrics.estimatedRetentionRatio * 100) + "%"}, est. return tokens: ${metrics.estimatedReturnTokens ?? "?"}`,
    "",
    "Fastest fixes:",
    "  • project scalars:  return { lines: r.split('\\n').length }",
    "  • compress inline:  return extensions.ctx_summarize({ text, mode: 'structural', maxTokens: 400 })",
    "  • offload + preview: return extensions.ctx_offload({ key: 'label', source: 'bash', data })",
  ].join("\n");
}

function formatRuntimeGuardWarning(metrics: AnalysisResult["metrics"]): string {
  return "[context-engineer] Static " + metrics.returnTaint +
    " return diagnostic is advisory in runtime-guard mode; the actual result will stay visible if small " +
    "or be offloaded if large. Set strict=true or blockUnboundedReturns=true to fail closed.";
}

/**
 * One-line post-execution nudge for oversized (but executed) returns.
 * Uses byte budgets; token estimate is ~bytes/4 ASCII-biased.
 */
export function runtimeAdvisoryLine(bytes: number): string {
  const estimatedTokens = Math.ceil(bytes / 4);
  return `[context-engineer] ${bytes} bytes (~${estimatedTokens} tokens at ~4 chars/token, ASCII-biased) reached the model boundary — consider scalar projections or extensions.ctx_summarize({ text, mode: "structural", maxTokens }).`;
}
