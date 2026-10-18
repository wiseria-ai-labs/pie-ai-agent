import { describe, it, expect, vi, afterEach } from "vitest";
import { streamChatOpenAICompat, _toWireMessagesForTest } from "./openai-compat-core";
import type { StreamEvent } from "@/lib/model-router/types";

function sse(chunks: unknown[], done = true): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : "");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
async function collect(gen: AsyncGenerator<StreamEvent>) { const out: StreamEvent[] = []; for await (const e of gen) out.push(e); return out; }
const cfg = { provider: "custom:x", model: "gemini-3.5-flash-lite", apiKey: "k",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" } as any;
const tools = [{ name: "click", description: "d", parameters: { type: "object", properties: {} } }] as any;

afterEach(() => vi.restoreAllMocks());

describe("Gemini OpenAI-compat quirks", () => {
  it("finish_reason 'stop' with a tool call still yields the tool call (no index, empty id, signature)", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(sse([
      { choices: [{ index: 0, finish_reason: "stop", delta: { role: "assistant", tool_calls: [
        { id: "", type: "function", function: { name: "click", arguments: "{\"ref\":\"e5\"}" },
          extra_content: { google: { thought_signature: "SIG123" } } } ] } }] },
    ]));
    const ev = await collect(streamChatOpenAICompat(cfg, [{ role: "user", content: "hi" }], undefined, tools));
    expect(fetchMock.mock.calls[0][0]).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    const start = ev.find((e) => e.type === "tool-call-start") as any;
    expect(start.name).toBe("click");
    expect(start.id).not.toBe("");
    expect(start.thoughtSignature).toBe("SIG123");
    expect(ev.some((e) => e.type === "tool-call-end")).toBe(true);
    expect(ev.at(-1)).toMatchObject({ type: "done", stopReason: "tool_calls" });
  });

  it("plain text with 'stop' stays a normal end", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sse([
      { choices: [{ index: 0, finish_reason: "stop", delta: { role: "assistant", content: "Привіт" } }] },
    ]));
    const ev = await collect(streamChatOpenAICompat(cfg, [{ role: "user", content: "hi" }], undefined, tools));
    expect(ev.at(-1)).toMatchObject({ type: "done", stopReason: "end" });
  });

  it("legacy '#' base URL still resolves to the right endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(sse([
      { choices: [{ index: 0, finish_reason: "stop", delta: { content: "ok" } }] }]));
    await collect(streamChatOpenAICompat({ ...cfg, baseUrl: cfg.baseUrl + "/chat/completions#" }, [{ role: "user", content: "hi" }]));
    expect(fetchMock.mock.calls[0][0]).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
  });

  it("echoes real signatures and adds the skip placeholder only for Gemini", () => {
    const msgs = [{ role: "assistant", content: [
      { type: "tool_use", id: "a", name: "click", input: {}, thoughtSignature: "REAL" },
    ] }, { role: "assistant", content: [
      { type: "tool_use", id: "b", name: "click", input: {} },
      { type: "tool_use", id: "c", name: "click", input: {} },
    ] }] as any;
    const g = _toWireMessagesForTest(msgs, true);
    expect(g[0].tool_calls![0].extra_content?.google.thought_signature).toBe("REAL");
    expect(g[1].tool_calls![0].extra_content?.google.thought_signature).toBe("skip_thought_signature_validator");
    expect(g[1].tool_calls![1].extra_content).toBeUndefined();
    const o = _toWireMessagesForTest(msgs, false);
    expect(o[1].tool_calls![0].extra_content).toBeUndefined();
  });
});
