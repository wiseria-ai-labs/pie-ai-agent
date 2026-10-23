import type { ModelConfig } from "@/lib/model-router";
import { isHardQuotaText, parseRetryAfter } from "../../retry-hints";
import type { AgentMessage, ToolDefinition, StreamEvent } from "@/lib/model-router/types";
import { readSSELines } from "@/lib/model-router/sse";
import { createThinkTagSplitter } from "../../think-tag-splitter";

/**
 * Shared OpenAI-compatible Chat Completions streaming core.
 *
 * Used by: openai, openrouter, zhipu, bailian, minimax wrappers.
 *
 * Defensive quirk handling (do not remove without verifying the upstream
 * provider has fixed the wire issue):
 *
 * 1. [DONE] without preceding finish_reason="tool_calls" — Triggered by
 *    ZhiPu (open.bigmodel.cn) and Bailian (dashscope.aliyuncs.com). When
 *    [DONE] arrives with non-empty pendingToolCalls, we flush tool-call-end
 *    events and emit done with stopReason="tool_calls".
 *
 * 2. tool_call function.arguments included in same first chunk as id+name —
 *    Triggered by some OpenRouter routes and zero-arg tools. We accumulate
 *    `initialArgs` from the first chunk and emit a tool-call-delta if non-empty.
 */

/**
 * Sync helper for error display — returns the friendly provider name if
 * available, falling back to the raw provider ref.
 *
 * `providerName` is resolved once at instance-load time by
 * `resolveInstanceToModelConfig`, so no async storage call is needed
 * in the streaming error path.
 */
export function displayProviderName(config: ModelConfig): string {
  return config.providerName ?? config.provider;
}

export interface OpenAICompatHooks {
  /** Headers merged on top of standard `Authorization` + `content-type`. */
  customHeaders?: (config: ModelConfig) => Record<string, string>;
  /** Replaces the default `Authorization: Bearer ${apiKey}`. */
  authHeaders?: (config: ModelConfig) => Record<string, string>;
  /** Extra top-level request-body fields (provider-specific opt-ins).
   *  Merged before `tools`/`tool_choice`, so it cannot clobber them. */
  extraBody?: (config: ModelConfig) => Record<string, unknown>;
}

interface OpenAIWireMessage {
  role: string;
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
    extra_content?: { google: { thought_signature: string } };
  }[];
  tool_call_id?: string;
}

/** Gemini's OpenAI-compat layer (generativelanguage.googleapis.com/.../openai). */
export function isGeminiCompat(baseUrl: string | undefined): boolean {
  return !!baseUrl && /generativelanguage\.googleapis\.com/.test(baseUrl);
}

/** Google-documented placeholder for tool calls whose real signature was lost. */
const GEMINI_SKIP_SIGNATURE = "skip_thought_signature_validator";

function toWireMessages(messages: AgentMessage[], gemini = false): OpenAIWireMessage[] {
  const result: OpenAIWireMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      result.push({ role: "system", content: msg.content });
      continue;
    }
    const content = msg.content;
    if (typeof content === "string") {
      result.push({ role: msg.role, content });
      continue;
    }
    if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: OpenAIWireMessage["tool_calls"] = [];
      for (const block of content) {
        if (block.type === "text") textParts.push(block.text);
        else if (block.type === "tool_use") {
          const call: NonNullable<OpenAIWireMessage["tool_calls"]>[number] = {
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}),
            },
          };
          // Gemini 3 rejects history whose function calls lack a thought
          // signature (400 "Function call is missing a thought_signature").
          // Echo the real one; for the first call of a turn fall back to the
          // documented skip placeholder (parallel calls only sign the first).
          const sig = block.thoughtSignature ?? (gemini && toolCalls.length === 0 ? GEMINI_SKIP_SIGNATURE : undefined);
          if (sig) call.extra_content = { google: { thought_signature: sig } };
          toolCalls.push(call);
        }
        // remote_tool is Responses-wire only — drop on chat/completions.
      }
      const assistantContent = textParts.length > 0 ? textParts.join("") : null;
      const wireMsg: OpenAIWireMessage = { role: "assistant", content: assistantContent };
      if (toolCalls.length > 0) wireMsg.tool_calls = toolCalls;
      result.push(wireMsg);
    } else if (msg.role === "user") {
      const textParts: string[] = [];
      const imageBlocks: Array<{ type: "image_url"; image_url: { url: string } }> = [];
      for (const block of content) {
        if (block.type === "text") textParts.push(block.text);
        else if (block.type === "tool_result") {
          result.push({ role: "tool", content: block.content, tool_call_id: block.toolUseId });
        } else if (block.type === "image") {
          imageBlocks.push({
            type: "image_url",
            image_url: { url: `data:${block.source.mediaType};base64,${block.source.data}` },
          });
        }
      }
      if (imageBlocks.length > 0) {
        const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [...imageBlocks];
        if (textParts.length > 0) parts.push({ type: "text", text: textParts.join("") });
        result.push({ role: "user", content: parts });
      } else if (textParts.length > 0) {
        result.push({ role: "user", content: textParts.join("") });
      }
    }
  }
  return result;
}

function mapStopReason(reason: string | null | undefined): "end" | "tool_calls" | "length" | undefined {
  if (reason === "stop") return "end";
  if (reason === "tool_calls") return "tool_calls";
  if (reason === "length") return "length";
  return undefined;
}

interface PendingToolCall { id: string; name: string; argsAccum: string; }

export async function* streamChatOpenAICompat(
  config: ModelConfig,
  messages: AgentMessage[],
  signal?: AbortSignal,
  tools?: ToolDefinition[],
  hooks?: OpenAICompatHooks,
): AsyncGenerator<StreamEvent> {
  const baseUrl = config.baseUrl!.replace(/#.*$/, "").replace(/\/$/, "");
  const gemini = isGeminiCompat(baseUrl);
  const endpoint = /\/chat\/completions$/.test(baseUrl)
    ? baseUrl
    // `/openai` only counts after a version segment (Gemini `/v1beta/openai`);
    // a bare `/openai` prefix (Groq `api.groq.com/openai`) still needs `/v1`.
    : /\/v\d+[a-z]*\d*(\/openai)?$/.test(baseUrl)
      ? `${baseUrl}/chat/completions`
      : `${baseUrl}/v1/chat/completions`;
  const wireMessages = toWireMessages(messages, gemini);

  const requestBody: Record<string, unknown> = {
    model: config.model,
    messages: wireMessages,
    stream: true,
    stream_options: { include_usage: true },
    ...(config.maxTokens != null && { max_tokens: config.maxTokens }),
    ...(hooks?.extraBody?.(config) ?? {}),
  };
  if (tools && tools.length > 0) {
    requestBody.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    requestBody.tool_choice = "auto";
  }

  const auth = hooks?.authHeaders?.(config) ?? { authorization: `Bearer ${config.apiKey}` };
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...auth,
    ...(hooks?.customHeaders?.(config) ?? {}),
  };

  let response: Response;
  try {
    response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(requestBody), signal });
  } catch (e) {
    if (signal?.aborted) return;
    yield { type: "error", error: `Network error: ${e instanceof Error ? e.message : `Failed to connect to ${displayProviderName(config)} API`}`, kind: "network" };
    return;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const name = displayProviderName(config);
    let errorType: string | undefined;
    try { errorType = JSON.parse(text)?.error?.type; } catch { /* 非 JSON body */ }
    const status = response.status;
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    if (status === 401) {
      yield { type: "error", error: `Invalid ${name} API key`, kind: "auth", status };
    } else if (status === 429) {
      if (errorType === "budget_exceeded") {
        yield { type: "error", error: `${name}: quota exhausted — manage your subscription`, kind: "budget", status };
      } else if (isHardQuotaText(text)) {
        yield { type: "error", error: `${name} quota exceeded: ${text}`, kind: "budget", status };
      } else {
        const retryAfter = response.headers.get("retry-after");
        yield { type: "error", error: `${name} rate limit exceeded${retryAfter ? `. Retry after ${retryAfter}s` : ""}`, kind: "ratelimit", status, retryAfterMs };
      }
    } else {
      yield { type: "error", error: `${name} API error (${status}): ${text}`, kind: "http", status, retryAfterMs };
    }
    return;
  }

  let usage: Extract<StreamEvent, { type: "done" }>["usage"];
  const pendingToolCalls = new Map<number, PendingToolCall>();
  // Gemini compat may omit tool_call `index` and send an empty `id`.
  let autoIndex = 0;
  let lastIndex = -1;
  const splitter = createThinkTagSplitter();
  let thinkingOpen = false;

  try {
    for await (const sse of readSSELines(response, signal)) {
      if (signal?.aborted) return;
      if (sse.data === "[DONE]") {
        if (pendingToolCalls.size > 0) {
          for (const [index] of pendingToolCalls) yield { type: "tool-call-end", index };
          pendingToolCalls.clear();
          for (const seg of splitter.flush()) {
            if (seg.kind === "think") {
              if (!thinkingOpen) { yield { type: "thinking-start", replay: false }; thinkingOpen = true; }
              yield { type: "thinking-delta", text: seg.text };
            } else {
              if (thinkingOpen) { yield { type: "thinking-end" }; thinkingOpen = false; }
              yield { type: "text-delta", text: seg.text };
            }
          }
          if (thinkingOpen) { yield { type: "thinking-end" }; thinkingOpen = false; }
          yield { type: "done", stopReason: "tool_calls", usage };
          return;
        }
        for (const seg of splitter.flush()) {
          if (seg.kind === "think") {
            if (!thinkingOpen) { yield { type: "thinking-start", replay: false }; thinkingOpen = true; }
            yield { type: "thinking-delta", text: seg.text };
          } else {
            if (thinkingOpen) { yield { type: "thinking-end" }; thinkingOpen = false; }
            yield { type: "text-delta", text: seg.text };
          }
        }
        if (thinkingOpen) { yield { type: "thinking-end" }; thinkingOpen = false; }
        yield { type: "done", stopReason: "end", usage };
        return;
      }
      try {
        const data = JSON.parse(sse.data);
        if (data.usage) {
          const u = data.usage;
          // Prompt-cache counters, three known wire shapes: OpenAI-style
          // prompt_tokens_details.cached_tokens (also Moonshot), a flat
          // usage.cached_tokens, and DeepSeek's prompt_cache_hit_tokens.
          const promptTotal: number = u.prompt_tokens ?? 0;
          const cached: number =
            u.prompt_tokens_details?.cached_tokens ??
            u.cached_tokens ??
            u.prompt_cache_hit_tokens ??
            0;
          usage = {
            inputTokens: promptTotal,
            outputTokens: u.completion_tokens ?? 0,
            // Only attach when the provider reported real cache activity —
            // absent lets the UI hide cache stats instead of showing 0%.
            ...(cached > 0
              ? { cachedTokens: cached, promptTotalTokens: promptTotal }
              : {}),
          };
        }
        // 中转/网关在扣费后上游失败时会推 {"error":{...}} 再关流；这条没有
        // choices，不拦住就会被下面的判空 continue 当垃圾行丢掉，最终静默变成
        // 一次空回复（连带真实扣费）。对齐 providers/openai.ts 的既有形状透传。
        if (data.error) {
          const m = typeof data.error === "string" ? data.error : (data.error.message ?? "stream error");
          yield { type: "error", error: `${displayProviderName(config)} API error: ${m}`, kind: "http" };
          return;
        }
        const choice = data.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta;
        const finishReason: string | null = choice.finish_reason;
        const reasoning: string | undefined = delta?.reasoning_content ?? delta?.reasoning;
        if (reasoning) {
          if (!thinkingOpen) { yield { type: "thinking-start", replay: false }; thinkingOpen = true; }
          yield { type: "thinking-delta", text: reasoning };
        }
        if (delta?.content) {
          for (const seg of splitter.feed(delta.content)) {
            if (seg.kind === "think") {
              if (!thinkingOpen) { yield { type: "thinking-start", replay: false }; thinkingOpen = true; }
              yield { type: "thinking-delta", text: seg.text };
            } else {
              if (thinkingOpen) { yield { type: "thinking-end" }; thinkingOpen = false; }
              yield { type: "text-delta", text: seg.text };
            }
          }
        }
        if (delta?.tool_calls) {
          for (const tcd of delta.tool_calls) {
            const index: number =
              typeof tcd.index === "number"
                ? tcd.index
                : tcd.function?.name
                  ? 1000 + autoIndex++ // no index: each named chunk is a new call
                  : lastIndex;         // no index, no name: continuation of the last call
            lastIndex = index;
            const existing = pendingToolCalls.get(index);
            if (!existing) {
              const id: string = tcd.id || `call_${Date.now().toString(36)}_${index}`;
              const name: string = tcd.function?.name ?? "";
              const initialArgs: string = tcd.function?.arguments ?? "";
              const thoughtSignature: string | undefined = tcd.extra_content?.google?.thought_signature || undefined;
              pendingToolCalls.set(index, { id, name, argsAccum: initialArgs });
              yield { type: "tool-call-start", id, index, name, ...(thoughtSignature ? { thoughtSignature } : {}) };
              if (initialArgs) yield { type: "tool-call-delta", index, argsDelta: initialArgs };
            } else {
              const argFragment: string = tcd.function?.arguments ?? "";
              if (argFragment) {
                existing.argsAccum += argFragment;
                yield { type: "tool-call-delta", index, argsDelta: argFragment };
              }
            }
          }
        }
        if (finishReason != null) {
          // Gemini's OpenAI-compat layer ends tool-call streams with
          // finish_reason "stop" (googleapis/python-genai#2868); without this
          // the calls are dropped and the turn looks empty. "length" + pending
          // calls stays a truncation (half-written args must not run).
          if (finishReason === "tool_calls" || (finishReason === "stop" && pendingToolCalls.size > 0)) {
            for (const [index] of pendingToolCalls) yield { type: "tool-call-end", index };
            pendingToolCalls.clear();
            for (const seg of splitter.flush()) {
              if (seg.kind === "think") {
                if (!thinkingOpen) { yield { type: "thinking-start", replay: false }; thinkingOpen = true; }
                yield { type: "thinking-delta", text: seg.text };
              } else {
                if (thinkingOpen) { yield { type: "thinking-end" }; thinkingOpen = false; }
                yield { type: "text-delta", text: seg.text };
              }
            }
            if (thinkingOpen) { yield { type: "thinking-end" }; thinkingOpen = false; }
            yield { type: "done", stopReason: "tool_calls", usage };
            return;
          } else if (finishReason === "stop" || finishReason === "length") {
            for (const seg of splitter.flush()) {
              if (seg.kind === "think") {
                if (!thinkingOpen) { yield { type: "thinking-start", replay: false }; thinkingOpen = true; }
                yield { type: "thinking-delta", text: seg.text };
              } else {
                if (thinkingOpen) { yield { type: "thinking-end" }; thinkingOpen = false; }
                yield { type: "text-delta", text: seg.text };
              }
            }
            if (thinkingOpen) { yield { type: "thinking-end" }; thinkingOpen = false; }
            yield { type: "done", stopReason: mapStopReason(finishReason), usage };
            return;
          }
        }
      } catch {
        // skip unparseable lines
      }
    }
    for (const seg of splitter.flush()) {
      if (seg.kind === "think") {
        if (!thinkingOpen) { yield { type: "thinking-start", replay: false }; thinkingOpen = true; }
        yield { type: "thinking-delta", text: seg.text };
      } else {
        if (thinkingOpen) { yield { type: "thinking-end" }; thinkingOpen = false; }
        yield { type: "text-delta", text: seg.text };
      }
    }
    if (thinkingOpen) { yield { type: "thinking-end" }; thinkingOpen = false; }
    if (pendingToolCalls.size > 0) {
      for (const [index] of pendingToolCalls) yield { type: "tool-call-end", index };
      pendingToolCalls.clear();
      yield { type: "done", stopReason: "tool_calls", usage };
      return;
    }
    yield { type: "done", usage };
  } catch (e) {
    if (signal?.aborted) return;
    yield { type: "error", error: `Stream interrupted: ${e instanceof Error ? e.message : "Unknown error"}`, kind: "network" };
  }
}

export const _toWireMessagesForTest = toWireMessages;
