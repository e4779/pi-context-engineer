import type { Usage } from "@earendil-works/pi-ai";

/** Reject incomplete/non-numeric reports rather than converting unknown usage to zero. */
export function readUsage(value: unknown): Usage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  if (!["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every(key => valid(usage[key]))) return undefined;
  if (!usage.cost || typeof usage.cost !== "object") return undefined;
  const cost = usage.cost as Record<string, unknown>;
  if (!["input", "output", "cacheRead", "cacheWrite", "total"].every(key => valid(cost[key]))) return undefined;
  return {
    input: usage.input as number, output: usage.output as number,
    cacheRead: usage.cacheRead as number, cacheWrite: usage.cacheWrite as number, totalTokens: usage.totalTokens as number,
    ...(valid(usage.reasoning) ? { reasoning: usage.reasoning } : {}),
    ...(valid(usage.cacheWrite1h) ? { cacheWrite1h: usage.cacheWrite1h } : {}),
    cost: { input: cost.input as number, output: cost.output as number, cacheRead: cost.cacheRead as number, cacheWrite: cost.cacheWrite as number, total: cost.total as number },
  };
}

/** Sum observed provider usage only; absence is unknown, never fabricated zero. */
export function mergeUsage(...values: Array<Usage | undefined>): Usage | undefined {
  const observed = values.filter((value): value is Usage => value !== undefined);
  if (observed.length === 0) return undefined;
  const sum = (field: "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens") =>
    observed.reduce((total, value) => total + value[field], 0);
  const optional = (field: "reasoning" | "cacheWrite1h") => observed.some(value => value[field] !== undefined)
    ? { [field]: observed.reduce((total, value) => total + (value[field] ?? 0), 0) } : {};
  const cost = (field: keyof Usage["cost"]) => observed.reduce((total, value) => total + value.cost[field], 0);
  return {
    input: sum("input"), output: sum("output"), cacheRead: sum("cacheRead"), cacheWrite: sum("cacheWrite"),
    totalTokens: sum("totalTokens"), ...optional("reasoning"), ...optional("cacheWrite1h"),
    cost: { input: cost("input"), output: cost("output"), cacheRead: cost("cacheRead"), cacheWrite: cost("cacheWrite"), total: cost("total") },
  };
}
