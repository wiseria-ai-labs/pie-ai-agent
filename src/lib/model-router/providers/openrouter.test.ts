import { describe, it, expect, vi } from "vitest";
import { streamChat } from "./openrouter";
import type { ModelConfig } from "@/lib/model-router";

describe("openrouter wrapper", () => {
  it("attaches HTTP-Referer and X-OpenRouter-Title headers", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            c.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
    const config: ModelConfig = {
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
      apiKey: "k",
      baseUrl: "https://openrouter.ai/api",
    };
    for await (const _ of streamChat(config, [{ role: "user", content: "hi" }])) { /* drain */ }
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["HTTP-Referer"]).toMatch(/github\.com/);
    expect(headers["X-OpenRouter-Title"]).toBe("Vailie");
    fetchMock.mockRestore();
  });
});
