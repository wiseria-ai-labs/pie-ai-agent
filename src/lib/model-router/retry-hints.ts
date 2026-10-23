// Helpers providers use to describe a failed request so the agent loop can
// decide whether to retry it (see src/lib/agent/llm-retry.ts). Providers do
// NOT retry themselves — the loop owns the policy, so attempts never multiply
// across layers and the panel can show "retrying n/N".

/** Retry-After header (delta-seconds or HTTP-date) → ms; undefined when absent/unparseable. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const secs = Number(trimmed);
  if (Number.isFinite(secs)) return secs >= 0 ? Math.round(secs * 1000) : undefined;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/**
 * A 429 whose body says the daily / billing quota is gone. It will not clear
 * in seconds, so it is reported as `kind: "budget"` and never retried.
 */
export function isHardQuotaText(text: string | null | undefined): boolean {
  if (!text) return false;
  return /PerDay|per day|daily limit|budget_exceeded|insufficient_quota|billing|credit balance/i.test(text);
}
