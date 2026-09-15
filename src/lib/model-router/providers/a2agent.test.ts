import { describe, it, expect, vi, afterEach } from "vitest";
import { streamChat } from "./a2agent";
import type { ModelConfig } from "@/lib/model-router";

function done(): Response {
  return new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

afterEach(() => vi.restoreAllMocks());

describe("a2agent wrapper (OpenAI-compat gateway, zero-hook)", () => {
  it("posts to api.a2agent.me/v1/chat/completions with Bearer auth", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(done());
    const config: ModelConfig = {
      provider: "a2agent",
      model: "deepseek-v4-pro",
      apiKey: "sk-test",
      baseUrl: "https://api.a2agent.me",
    };
    for await (const _ of streamChat(config, [{ role: "user", content: "hi" }])) {
      /* drain */
    }
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.a2agent.me/v1/chat/completions");
    const h = new Headers((init as RequestInit).headers as HeadersInit);
    expect(h.get("authorization")).toBe("Bearer sk-test");
    // zero-hook wrapper → no provider-specific custom headers (unlike OpenRouter)
    expect(h.get("HTTP-Referer")).toBeNull();
  });
});
