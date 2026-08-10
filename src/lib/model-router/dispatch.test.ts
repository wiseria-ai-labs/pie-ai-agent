import { describe, it, expect } from "vitest";
import { streamChatByProvider, dispatchStreamChat } from "./providers";
import { streamChat as openaiChat } from "./providers/openai";
import { streamChatOpenAICompat } from "./providers/_shared/openai-compat-core";
import type { ModelConfig } from "@/lib/model-router";

describe("streamChatByProvider dispatch table", () => {
  it("has a streamChat function for every Provider in the union", () => {
    const expected = ["anthropic", "openai", "openrouter", "zhipu", "bailian", "minimax", "gemini", "deepseek", "mimo", "moonshot", "moonshot-cn"] as const;
    for (const id of expected) {
      expect(typeof streamChatByProvider[id]).toBe("function");
    }
  });
});

describe("dispatchStreamChat — custom provider wire (#415)", () => {
  const base: ModelConfig = { provider: "custom:abc", model: "m", apiKey: "k" };

  it("wire: 'responses' → OpenAI Responses core", () => {
    expect(dispatchStreamChat({ ...base, wire: "responses" })).toBe(openaiChat);
  });

  it("wire undefined → OpenAI-compat (chat/completions) core", () => {
    expect(dispatchStreamChat(base)).toBe(streamChatOpenAICompat);
  });
});
