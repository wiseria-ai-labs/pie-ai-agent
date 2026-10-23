// Retry policy for LLM completions requested by the agent loop.
//
// One policy for every provider: providers only *describe* a failure
// (`StreamEvent` error with kind / status / retryAfterMs) and the loop decides
// here whether to try again. Keeping the decision in one place means attempts
// never multiply across layers (the Anthropic SDK's own retries are off) and
// the panel can show "Provider error, retrying 2/5…".

import type { StreamEvent } from "../model-router/types";

export type LlmErrorEvent = Extract<StreamEvent, { type: "error" }>;

export interface LlmRetryPolicy {
  /** Retries after the first attempt. */
  maxRetries: number;
  /** First backoff; doubles on every retry. */
  baseDelayMs: number;
  /** Cap for the exponential backoff. */
  maxDelayMs: number;
  /** A Retry-After longer than this isn't waited out inline — the task is
   *  paused instead so the user decides when to try again. */
  maxRetryAfterMs: number;
  /** An attempt that yields no stream event for this long is abandoned as a
   *  timeout (and retried). Generous: reasoning models can think silently. */
  idleTimeoutMs: number;
}

export const DEFAULT_LLM_RETRY_POLICY: LlmRetryPolicy = {
  maxRetries: 5,
  baseDelayMs: 2_000,
  maxDelayMs: 30_000,
  maxRetryAfterMs: 120_000,
  idleTimeoutMs: 300_000,
};

/** Text appended to the request when the model keeps answering with nothing. */
export const EMPTY_RESPONSE_NUDGE = "Continue the task. Respond with a tool call.";

export type RetryReason = "ratelimit" | "server" | "network" | "timeout" | "empty";

export interface RetryDecision {
  retryable: boolean;
  reason?: RetryReason;
  retryAfterMs?: number;
}

/**
 * Should this provider error be retried?
 *   - retry: 429, 5xx, 408, network errors, timeouts, and in-stream error
 *     frames (no status — an upstream failure after the 200 was sent)
 *   - never: auth, exhausted quota/budget, any other 4xx, and untyped
 *     local errors (unknown provider, bad config)
 */
export function classifyLlmError(ev: LlmErrorEvent): RetryDecision {
  const { kind, status, retryAfterMs } = ev;
  if (kind === "auth" || kind === "budget") return { retryable: false };
  if (status !== undefined) {
    if (status === 429) return { retryable: true, reason: "ratelimit", retryAfterMs };
    if (status === 408) return { retryable: true, reason: "timeout", retryAfterMs };
    if (status >= 500 && status <= 599) return { retryable: true, reason: "server", retryAfterMs };
    return { retryable: false };
  }
  switch (kind) {
    case "ratelimit":
      return { retryable: true, reason: "ratelimit", retryAfterMs };
    case "network":
      return { retryable: true, reason: "network" };
    case "timeout":
      return { retryable: true, reason: "timeout" };
    case "http":
      return { retryable: true, reason: "server" };
    default:
      return { retryable: false };
  }
}

/**
 * Wait before retry number `retry` (1-based).
 * Exponential backoff (base·2^(n-1), capped) with "equal jitter": half the
 * backoff is fixed, the other half random, so concurrent sessions hitting the
 * same provider spread out. A server Retry-After hint is a floor — we never
 * come back sooner than the server asked.
 */
export function computeRetryDelay(
  retry: number,
  policy: Pick<LlmRetryPolicy, "baseDelayMs" | "maxDelayMs">,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, retry - 1));
  const jittered = Math.round(exp / 2 + random() * (exp / 2));
  return retryAfterMs !== undefined ? Math.max(retryAfterMs, jittered) : jittered;
}

export type SleepFn = (ms: number, signal: AbortSignal) => Promise<void>;

/** Resolves after `ms`, or early (without throwing) when `signal` aborts. */
export const abortableSleep: SleepFn = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

let sleepImpl: SleepFn = abortableSleep;

/** The loop's sleep. Swappable so the test suite never waits on real backoff. */
export function retrySleep(ms: number, signal: AbortSignal): Promise<void> {
  return sleepImpl(ms, signal);
}

/** Test hook — replace the backoff sleep; returns a restore function. */
export function setRetrySleepForTests(fn: SleepFn): () => void {
  const prev = sleepImpl;
  sleepImpl = fn;
  return () => {
    sleepImpl = prev;
  };
}

/** Human-readable reason, for logs and the paused summary. */
export function describeRetryReason(reason: RetryReason): string {
  switch (reason) {
    case "ratelimit":
      return "rate limited";
    case "server":
      return "provider error";
    case "network":
      return "network error";
    case "timeout":
      return "timed out";
    case "empty":
      return "empty response";
  }
}
