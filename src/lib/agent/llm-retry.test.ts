import { describe, it, expect } from "vitest";
import {
  DEFAULT_LLM_RETRY_POLICY,
  abortableSleep,
  classifyLlmError,
  computeRetryDelay,
  type LlmErrorEvent,
} from "./llm-retry";

const ev = (e: Partial<LlmErrorEvent>): LlmErrorEvent => ({ type: "error", error: "x", ...e });

describe("classifyLlmError", () => {
  it.each([
    [{ status: 429, kind: "ratelimit" }, "ratelimit"],
    [{ status: 500, kind: "http" }, "server"],
    [{ status: 502 }, "server"],
    [{ status: 503, kind: "http" }, "server"],
    [{ status: 504 }, "server"],
    [{ status: 529 }, "server"], // Anthropic "overloaded"
    [{ status: 408 }, "timeout"],
    [{ kind: "network" }, "network"],
    [{ kind: "timeout" }, "timeout"],
    [{ kind: "ratelimit" }, "ratelimit"],
    [{ kind: "http" }, "server"], // in-stream error frame, no status
  ] as const)("retries %j as %s", (e, reason) => {
    expect(classifyLlmError(ev(e as Partial<LlmErrorEvent>))).toMatchObject({ retryable: true, reason });
  });

  it.each([
    [{ status: 400, kind: "http" }],
    [{ status: 401, kind: "auth" }],
    [{ status: 403, kind: "http" }],
    [{ status: 404, kind: "http" }],
    [{ status: 422, kind: "http" }],
    [{ status: 429, kind: "budget" }], // daily quota / billing — won't clear in seconds
    [{ kind: "auth" }],
    [{}], // untyped local error (unknown provider, bad config)
  ] as const)("does not retry %j", (e) => {
    expect(classifyLlmError(ev(e as Partial<LlmErrorEvent>)).retryable).toBe(false);
  });

  it("passes the Retry-After hint through", () => {
    expect(classifyLlmError(ev({ status: 429, retryAfterMs: 5000 })).retryAfterMs).toBe(5000);
  });
});

describe("computeRetryDelay", () => {
  const p = DEFAULT_LLM_RETRY_POLICY;
  it("doubles from a 2s base with equal jitter", () => {
    expect(computeRetryDelay(1, p, undefined, () => 0)).toBe(1000);
    expect(computeRetryDelay(1, p, undefined, () => 1)).toBe(2000);
    expect(computeRetryDelay(2, p, undefined, () => 1)).toBe(4000);
    expect(computeRetryDelay(3, p, undefined, () => 1)).toBe(8000);
    expect(computeRetryDelay(4, p, undefined, () => 0.5)).toBe(12000);
  });
  it("caps at 30s", () => {
    expect(computeRetryDelay(5, p, undefined, () => 1)).toBe(30000);
    expect(computeRetryDelay(10, p, undefined, () => 1)).toBe(30000);
  });
  it("treats Retry-After as a floor", () => {
    expect(computeRetryDelay(1, p, 10_000, () => 1)).toBe(10_000);
    expect(computeRetryDelay(5, p, 1_000, () => 1)).toBe(30_000);
  });
  it("defaults to 5 retries, 2s base, 30s cap", () => {
    expect(p).toMatchObject({ maxRetries: 5, baseDelayMs: 2000, maxDelayMs: 30000 });
  });
});

describe("abortableSleep", () => {
  it("resolves early on abort", async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    const p = abortableSleep(10_000, ac.signal);
    ac.abort();
    await p;
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it("resolves immediately when already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await abortableSleep(10_000, ac.signal);
  });
});
