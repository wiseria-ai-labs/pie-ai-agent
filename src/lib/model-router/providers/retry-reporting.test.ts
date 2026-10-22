/**
 * Every provider back-end must DESCRIBE a failed request (status, kind,
 * Retry-After) and never retry it itself — the agent loop owns the retry
 * policy (src/lib/agent/llm-retry.ts). A hidden provider-side retry would
 * multiply attempts (5 loop retries × N) and stall the panel silently.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelConfig } from "@/lib/model-router";
import type { StreamEvent } from "../types";
import { streamChatOpenAICompat } from "./_shared/openai-compat-core";
import { streamChatAnthropicSdk } from "./_shared/anthropic-sdk-core";
import { streamChat as streamGemini } from "./gemini";
import { streamChat as streamOpenAI } from "./openai";

type Gen = (cfg: ModelConfig) => AsyncGenerator<StreamEvent>;
const msgs = [{ role: "user" as const, content: "hi" }];

const BACKENDS: Array<[string, ModelConfig, Gen]> = [
  ["openai-compat", { provider: "openrouter", model: "m", apiKey: "k", baseUrl: "https://openrouter.ai/api/v1" }, (c) => streamChatOpenAICompat(c, msgs)],
  ["anthropic-sdk", { provider: "anthropic", model: "m", apiKey: "k", baseUrl: "https://api.anthropic.com" }, (c) => streamChatAnthropicSdk(c, msgs)],
  ["gemini", { provider: "gemini", model: "m", apiKey: "k", baseUrl: "https://generativelanguage.googleapis.com" }, (c) => streamGemini(c, msgs)],
  ["openai-responses", { provider: "openai", model: "m", apiKey: "k", baseUrl: "https://api.openai.com/v1" }, (c) => streamOpenAI(c, msgs)],
];

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

afterEach(() => vi.restoreAllMocks());

describe.each(BACKENDS)("%s — failure reporting", (_name, cfg, run) => {
  it("503 + Retry-After → one request, status + retryAfterMs on the error", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => json(503, { error: { message: "overloaded" } }, { "retry-after": "4" }));
    const events = await collect(run(cfg));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const err = events.find((e) => e.type === "error") as Extract<StreamEvent, { type: "error" }>;
    expect(err).toMatchObject({ status: 503, kind: "http", retryAfterMs: 4000 });
  });

  it("429 → kind ratelimit with status", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      json(429, { error: { message: "Too many requests per minute" } }),
    );
    const err = (await collect(run(cfg))).find((e) => e.type === "error");
    expect(err).toMatchObject({ status: 429, kind: "ratelimit" });
  });

  it("429 with a daily-quota body → kind budget (not retried by the loop)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      json(429, { error: { message: "Quota exceeded for GenerateRequestsPerDayPerProject" } }),
    );
    const err = (await collect(run(cfg))).find((e) => e.type === "error");
    expect(err).toMatchObject({ status: 429, kind: "budget" });
  });

  it("400 → kind http with status 400", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => json(400, { error: { message: "bad request" } }));
    const err = (await collect(run(cfg))).find((e) => e.type === "error");
    expect(err).toMatchObject({ status: 400 });
  });

  it("network failure → kind network, one request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new TypeError("Failed to fetch");
    });
    const err = (await collect(run(cfg))).find((e) => e.type === "error");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err).toMatchObject({ kind: "network" });
  });
});
