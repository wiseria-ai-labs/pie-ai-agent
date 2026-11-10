import { afterEach, describe, expect, it, vi } from "vitest";
import { abortableSleep, fetchWithRetry, parseRetryAfter, retryTiming } from "./fetch-retry";
import { streamChatOpenAICompat } from "./openai-compat-core";
import { streamChat as streamChatGemini } from "../gemini";

const res = (status: number, body = "", headers: Record<string, string> = {}) =>
  new Response(body, { status, headers });

function stubFetch(...responses: Array<Response | Error>) {
  const f = vi.fn(async () => {
    const r = responses.shift()!;
    if (r instanceof Error) throw r;
    return r;
  });
  vi.stubGlobal("fetch", f);
  return f;
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("fetchWithRetry", () => {
  it.each([429, 500, 502, 503, 504])("retries %i then succeeds", async (status) => {
    const f = stubFetch(res(status), res(200, "ok"));
    const r = await fetchWithRetry("u", {});
    expect(r.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403, 404])("does not retry %i", async (status) => {
    const f = stubFetch(res(status), res(200));
    expect((await fetchWithRetry("u", {})).status).toBe(status);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("retries network errors, gives up after 3 retries and rethrows", async () => {
    const f = stubFetch(...Array.from({ length: 4 }, () => new TypeError("Failed to fetch")));
    await expect(fetchWithRetry("u", {})).rejects.toThrow("Failed to fetch");
    expect(f).toHaveBeenCalledTimes(4);
  });

  it("returns the last non-ok response after 3 retries", async () => {
    const f = stubFetch(res(503), res(503), res(503), res(503, "still down"));
    const r = await fetchWithRetry("u", {});
    expect(await r.text()).toBe("still down");
    expect(f).toHaveBeenCalledTimes(4);
  });

  it.each([
    '{"error":{"message":"Quota exceeded for metric: GenerateRequestsPerDayPerProjectPerModel"}}',
    '{"error":{"code":"insufficient_quota"}}',
    '{"error":{"type":"exceeded_current_quota_error"}}',
    '{"error":{"type":"budget_exceeded"}}',
  ])("does not retry daily-quota 429: %s", async (body) => {
    const f = stubFetch(res(429, body), res(200));
    const r = await fetchWithRetry("u", {});
    expect(r.status).toBe(429);
    expect(await r.text()).toBe(body); // body still readable by the caller
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("retries Gemini per-minute 429 (body mentions billing + 'Quota exceeded for metric')", async () => {
    const body = JSON.stringify({ error: {
      code: 429,
      message: "You exceeded your current quota, please check your plan and billing details. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10",
      status: "RESOURCE_EXHAUSTED",
      details: [{ violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" }] }],
    } });
    const f = stubFetch(res(429, body), res(200, "ok"));
    expect((await fetchWithRetry("u", {})).status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("honors Retry-After, capped at 30 s", async () => {
    const sleep = vi.spyOn(retryTiming, "sleep");
    stubFetch(res(429, "", { "retry-after": "2" }), res(503, "", { "retry-after": "120" }), res(200));
    await fetchWithRetry("u", {});
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, 30_000]);
  });

  it("parses HTTP-date Retry-After and ignores garbage", () => {
    expect(parseRetryAfter(new Date(Date.now() + 5000).toUTCString())).toBeGreaterThan(3000);
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it("abort during backoff ends immediately without another request", async () => {
    const ac = new AbortController();
    vi.spyOn(retryTiming, "sleep").mockImplementation((_ms, signal) => {
      ac.abort();
      return Promise.reject(signal?.reason);
    });
    const f = stubFetch(res(503), res(200));
    await expect(fetchWithRetry("u", { signal: ac.signal })).rejects.toBeDefined();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("real sleep rejects as soon as the signal aborts", async () => {
    const ac = new AbortController();
    const p = abortableSleep(60_000, ac.signal);
    ac.abort();
    await expect(p).rejects.toBeDefined();
  });
});

describe("providers use fetchWithRetry only before stream bytes", () => {
  const cfg = { provider: "openrouter", model: "m", apiKey: "k", baseUrl: "https://x" } as const;

  it("openai-compat: 503 then stream succeeds", async () => {
    const f = stubFetch(
      res(503),
      res(200, 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'),
    );
    const events = [];
    for await (const e of streamChatOpenAICompat(cfg, [{ role: "user", content: "x" }])) events.push(e);
    expect(f).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual({ type: "text-delta", text: "hi" });
  });

  it("openai-compat: error after stream bytes is not retried", async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
        c.error(new Error("connection reset"));
      },
    });
    const f = stubFetch(new Response(body, { status: 200 }));
    const events = [];
    for await (const e of streamChatOpenAICompat(cfg, [{ role: "user", content: "x" }])) events.push(e);
    expect(f).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ type: "error", kind: "network" });
  });

  it("gemini: 500 is retried", async () => {
    const f = stubFetch(res(500), res(500), res(500), res(500, "boom"));
    const events = [];
    for await (const e of streamChatGemini({ provider: "gemini", model: "g", apiKey: "k", baseUrl: "https://g" }, [{ role: "user", content: "x" }])) events.push(e);
    expect(f).toHaveBeenCalledTimes(4);
    expect(events.at(-1)).toMatchObject({ type: "error" });
  });
});
