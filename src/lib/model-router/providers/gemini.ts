import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ToolDefinition, StreamEvent } from "@/lib/model-router/types";
import { readSSELines } from "@/lib/model-router/sse";

interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
  functionCall?: { name: string; args: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; response: { content: string } };
  /** Gemini 3: opaque signature attached to functionCall parts; must be echoed back. */
  thoughtSignature?: string;
}

/** Google-documented placeholder for function calls whose real signature is unavailable. */
const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";
interface GeminiContent {
  role: "user" | "model" | "function";
  parts: GeminiPart[];
}

function toGeminiContents(messages: AgentMessage[]): GeminiContent[] {
  // First pass: build id → name from all assistant tool_use blocks
  const idToName = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== "assistant" || typeof msg.content === "string") continue;
    for (const block of msg.content) {
      if (block.type === "tool_use") idToName.set(block.id, block.name);
    }
  }

  const result: GeminiContent[] = [];
  for (const msg of messages) {
    if (msg.role === "system") continue; // hoisted to systemInstruction below
    const role: GeminiContent["role"] = msg.role === "assistant" ? "model" : "user";

    if (typeof msg.content === "string") {
      result.push({ role, parts: [{ text: msg.content }] });
      continue;
    }

    const parts: GeminiPart[] = [];
    let signedFirstCall = false;
    for (const block of msg.content) {
      if (block.type === "text") parts.push({ text: block.text });
      else if (block.type === "image") {
        parts.push({ inline_data: { mime_type: block.source.mediaType, data: block.source.data } });
      } else if (block.type === "tool_use" && msg.role === "assistant") {
        const args: Record<string, unknown> = typeof block.input === "string"
          ? (JSON.parse(block.input) as Record<string, unknown>)
          : (block.input ?? {}) as Record<string, unknown>;
        // Gemini 3 rejects history whose function calls lack a thought signature
        // (400 "Function call is missing a thought_signature"). Echo the real one;
        // otherwise sign the first call of the turn with the skip placeholder
        // (for parallel calls only the first part carries a signature).
        const sig = block.thoughtSignature ?? (signedFirstCall ? undefined : SKIP_THOUGHT_SIGNATURE);
        signedFirstCall = true;
        parts.push({ functionCall: { name: block.name, args }, ...(sig ? { thoughtSignature: sig } : {}) });
      } else if (block.type === "tool_result" && msg.role === "user") {
        // Gemini wants tool results in role:"function" content. Parallel calls
        // must be answered in ONE content with as many functionResponse parts
        // as there were functionCall parts, so merge consecutive results.
        const part: GeminiPart = { functionResponse: { name: idToName.get(block.toolUseId) ?? block.toolUseId, response: { content: block.content } } };
        const last = result[result.length - 1];
        if (last && last.role === "function") last.parts.push(part);
        else result.push({ role: "function", parts: [part] });
        continue;
      }
      // remote_tool is Responses-wire only — drop on Gemini.
    }
    if (parts.length > 0) result.push({ role, parts });
  }
  return result;
}

function extractSystemInstruction(messages: AgentMessage[]): string | undefined {
  const sys = messages.find((m) => m.role === "system");
  return sys && typeof sys.content === "string" ? sys.content : undefined;
}

/**
 * Gemini's `parameters` field takes an OpenAPI-style Schema subset and rejects
 * JSON-Schema-only keywords with 400 `Unknown name "additionalProperties"`.
 * Strip them recursively (property *names* inside `properties` are kept).
 */
const UNSUPPORTED_SCHEMA_KEYS = new Set(["additionalProperties", "$schema"]);
function toGeminiSchema(schema: unknown, isPropertiesMap = false): unknown {
  if (Array.isArray(schema)) return schema.map((s) => toGeminiSchema(s));
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (!isPropertiesMap && UNSUPPORTED_SCHEMA_KEYS.has(k)) continue;
    out[k] = toGeminiSchema(v, !isPropertiesMap && k === "properties");
  }
  return out;
}

function toGeminiTools(tools: ToolDefinition[]): { function_declarations: Array<{ name: string; description: string; parameters: unknown }> } {
  return {
    function_declarations: tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: toGeminiSchema(t.parameters),
    })),
  };
}

export async function* streamChat(
  config: ModelConfig,
  messages: AgentMessage[],
  signal?: AbortSignal,
  tools?: ToolDefinition[],
): AsyncGenerator<StreamEvent> {
  const baseUrl = config.baseUrl!.replace(/\/$/, "");
  const url = `${baseUrl}/v1beta/models/${encodeURIComponent(config.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(config.apiKey)}`;

  const body: Record<string, unknown> = {
    contents: toGeminiContents(messages),
  };
  const sys = extractSystemInstruction(messages);
  if (sys) body.systemInstruction = { parts: [{ text: sys }] };
  if (tools && tools.length > 0) body.tools = [toGeminiTools(tools)];
  if (config.maxTokens != null) body.generationConfig = { maxOutputTokens: config.maxTokens };

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) return;
    yield { type: "error", error: `Network error: ${e instanceof Error ? e.message : "Failed to connect to Gemini API"}` };
    return;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      yield { type: "error", error: "Invalid Gemini API key" };
    } else if (response.status === 429) {
      yield { type: "error", error: "Gemini rate limit exceeded" };
    } else {
      yield { type: "error", error: `Gemini API error (${response.status}): ${text}` };
    }
    return;
  }

  let usage: Extract<StreamEvent, { type: "done" }>["usage"];
  let toolCallIndex = 0;
  // Ids must be unique across the whole conversation: idToName maps
  // tool_result → function name, and a per-stream counter ("gemini_call_0"
  // every step) made later calls overwrite earlier names.
  const idPrefix = `gemini_call_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let stopReason: "end" | "tool_calls" | "length" | undefined;

  try {
    for await (const sse of readSSELines(response, signal)) {
      if (signal?.aborted) return;
      try {
        const data = JSON.parse(sse.data);
        const candidate = data.candidates?.[0];
        if (!candidate) continue;
        const parts: GeminiPart[] = candidate.content?.parts ?? [];
        for (const p of parts) {
          if (p.text) {
            yield { type: "text-delta", text: p.text };
          } else if (p.functionCall) {
            const id = p.functionCall.id || `${idPrefix}_${toolCallIndex}`;
            yield {
              type: "tool-call-start", id, index: toolCallIndex, name: p.functionCall.name,
              ...(p.thoughtSignature ? { thoughtSignature: p.thoughtSignature } : {}),
            };
            const argsJson = JSON.stringify(p.functionCall.args ?? {});
            if (argsJson !== "{}") yield { type: "tool-call-delta", index: toolCallIndex, argsDelta: argsJson };
            yield { type: "tool-call-end", index: toolCallIndex };
            toolCallIndex++;
            stopReason = "tool_calls";
          }
        }
        if (candidate.finishReason === "STOP" && stopReason !== "tool_calls") stopReason = "end";
        else if (candidate.finishReason === "MAX_TOKENS") stopReason = "length";
        if (data.usageMetadata) {
          const meta = data.usageMetadata;
          const cached: number = meta.cachedContentTokenCount ?? 0;
          usage = {
            inputTokens: meta.promptTokenCount ?? 0,
            outputTokens: meta.candidatesTokenCount ?? 0,
            // Same contract as the other cores: attach only on real cache
            // activity so the UI can hide the stat when unsupported.
            ...(cached > 0
              ? { cachedTokens: cached, promptTotalTokens: meta.promptTokenCount ?? 0 }
              : {}),
          };
        }
      } catch {
        // skip unparseable
      }
    }
    yield { type: "done", stopReason, usage };
  } catch (e) {
    if (signal?.aborted) return;
    yield { type: "error", error: `Stream interrupted: ${e instanceof Error ? e.message : "Unknown error"}` };
  }
}

export const _toGeminiContentsForTest = toGeminiContents;
export const _toGeminiToolsForTest = toGeminiTools;
