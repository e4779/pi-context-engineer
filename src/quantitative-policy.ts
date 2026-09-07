import type { BoundUnit, ResolvedBound } from "./context-effects.js";

export interface ContextBoundaryPolicy {
  readonly maxBytes?: number;
  readonly maxTokens?: number;
  readonly maxCharacters?: number;
}

export type QuantitativeDecision =
  | {
      readonly kind: "within-budget";
      readonly bound: ResolvedBound;
      readonly limit: number;
      readonly unit: BoundUnit;
    }
  | {
      readonly kind: "over-budget";
      readonly bound: ResolvedBound;
      readonly limit: number;
      readonly unit: BoundUnit;
    }
  | {
      readonly kind: "not-comparable";
      readonly reason: string;
    };

/**
 * Single policy source for static preflight and runtime boundary budgets.
 *
 * Static preflight uses maxBytes (8KB), maxTokens (4000), and maxCharacters
 * (8KB) directly via evaluateReturnBudget. The runtime auto-offload threshold
 * defaults to DEFAULT_RUNTIME_OFFLOAD_BYTES (16KB, ~4K tokens) and is kept for
 * backward compatibility; configure `policy.maxBytes` (or legacy
 * `readOffloadThreshold`) to unify both paths on one byte budget.
 *
 * Token estimates throughout the boundary are ~bytes/4 and ASCII-biased
 * (multibyte UTF-8 inflates bytes faster than the 4 chars/token heuristic
 * implies). Prefer byte budgets in messages and treat token counts as heuristic.
 */
export const DEFAULT_CONTEXT_BOUNDARY_POLICY: Required<ContextBoundaryPolicy> = Object.freeze({
  maxBytes: 8192,
  maxTokens: 4000,
  maxCharacters: 8192,
});

/**
 * Default runtime auto-offload budget in UTF-8 bytes. Kept at 16KB so existing
 * behavior is unchanged; it equals 2x DEFAULT_CONTEXT_BOUNDARY_POLICY.maxBytes
 * because static preflight is intentionally conservative (upper-bound) while
 * runtime measures actual bytes. Token equivalent is ~4000 tokens at ~4
 * chars/token (ASCII-biased).
 */
export const DEFAULT_RUNTIME_OFFLOAD_BYTES = 16_384;

/**
 * Resolve the effective runtime byte budget from explicit override, policy,
 * or default. Legacy `readOffloadThreshold` wins when set; otherwise an
 * explicit `policy.maxBytes` unifies static and runtime on one budget.
 */
export function resolveRuntimeByteBudget(
  readOffloadThreshold?: unknown,
  policy?: ContextBoundaryPolicy,
): number {
  const policyBytes = policy?.maxBytes;
  const raw = readOffloadThreshold ?? policyBytes ?? DEFAULT_RUNTIME_OFFLOAD_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_RUNTIME_OFFLOAD_BYTES;
  return Math.max(256, Math.min(1_000_000_000, Math.floor(parsed)));
}

/** Prevent accidental configuration of effectively unbounded policy budgets. */
export const MAX_CONTEXT_BOUNDARY_BUDGET = 1_000_000_000;

export function validateContextBoundaryPolicy(policy: ContextBoundaryPolicy): string[] {
  const errors: string[] = [];
  for (const [key, value] of Object.entries(policy)) {
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0) {
      errors.push(`${key} must be a non-negative safe integer.`);
    } else if (value > MAX_CONTEXT_BOUNDARY_BUDGET) {
      errors.push(`${key} must not exceed ${MAX_CONTEXT_BOUNDARY_BUDGET}.`);
    }
  }
  return errors;
}

const comparableLimits: Readonly<Record<"bytes" | "tokens" | "characters", keyof ContextBoundaryPolicy>> = {
  bytes: "maxBytes",
  tokens: "maxTokens",
  characters: "maxCharacters",
};

function validLimit(limit: number | undefined): limit is number {
  return limit !== undefined && validateContextBoundaryPolicy({ maxBytes: limit }).length === 0;
}

export function evaluateReturnBudget(
  bound: ResolvedBound | undefined,
  policy: ContextBoundaryPolicy = DEFAULT_CONTEXT_BOUNDARY_POLICY,
): QuantitativeDecision {
  if (!bound || bound.kind === "unknown" || bound.value === undefined) {
    return { kind: "not-comparable", reason: "No finite quantitative bound is available." };
  }
  const policyKey = comparableLimits[bound.unit as keyof typeof comparableLimits];
  if (!policyKey) {
    return {
      kind: "not-comparable",
      reason: `A ${bound.unit} bound is structural only and cannot prove context size.`,
    };
  }
  const limit = policy[policyKey];
  if (!validLimit(limit)) {
    return { kind: "not-comparable", reason: `No quantitative budget is configured for ${bound.unit}.` };
  }
  if (!Number.isSafeInteger(bound.value) || bound.value < 0) {
    return { kind: "not-comparable", reason: `The ${bound.unit} bound is not a valid non-negative safe integer.` };
  }
  return bound.value <= limit
    ? { kind: "within-budget", bound, limit, unit: bound.unit }
    : { kind: "over-budget", bound, limit, unit: bound.unit };
}
