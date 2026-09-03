import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ToolDefinition, StreamEvent } from "@/lib/model-router/types";
import { readSSELines } from "@/lib/model-router/sse";
import { displayProviderName } from "./_shared/openai-compat-core";

/**
 * OpenAI provider — Responses API (`/v1/responses`) wire.
 *
 * 为什么不走 openai-compat-core（chat/completions）：gpt-5.6 起该端点上
 * function tools 与 reasoning_effort≠none 互斥（agent loop 恒带 tools，
 * 等于 reasoning 全关），且 max_tokens 被拒收。OpenAI 官方方向即 Responses；
 * 迁移后 reasoning 默认档与 tools 共存，max_output_tokens 语义回归正常。
 * 其余 OpenAI-compat 家族（openrouter/zhipu/bailian/moonshot/custom/managed）
 * 仍走 chat/completions core，互不影响。
 *
 * 有意不带的参数：`store:false`（BYOK 无状态，全量历史随请求重放，不落
 * OpenAI 侧存储）；不请求 reasoning summary（需 org 认证，未认证会 400，
 * 思考过程展示留给后续迭代）；reasoning effort 走服务端默认。
 */

type ContentPart =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | { type: "input_image"; image_url: string };

type InputItem =
  | { role: string; content: ContentPart[] }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | Record<string, unknown>;

const REMOTE_SERVER_ITEM_TYPES = new Set([
  "mcp_call",
  "web_search_call",
  "file_search_call",
  "code_interpreter_call",
  "shell_call",
  "image_generation_call",
]);

function isRemoteServerItemType(type: unknown): type is string {
  return typeof type === "string" && (REMOTE_SERVER_ITEM_TYPES.has(type) || type.startsWith("openrouter:"));
}

/** Stringify a Responses item field for the StreamEvent / IR (item itself is kept opaque). */
function stringifyRemoteValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (part && typeof part === "object" && "text" in part && typeof (part as { text: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return typeof part === "string" ? part : JSON.stringify(part);
      })
      .join("");
  }
  return JSON.stringify(value);
}

function remoteToolArgs(item: Record<string, unknown>): string {
  if (typeof item.arguments === "string") return item.arguments;
  if (item.arguments != null) return stringifyRemoteValue(item.arguments);
  return JSON.stringify(item.action ?? {});
}

function remoteToolOutput(item: Record<string, unknown>): string {
  return stringifyRemoteValue(item.output ?? item.error ?? "");
}

function pushRemoteToolItem(item: unknown, into: InputItem[]): void {
  if (item == null || typeof item !== "object") return;
  const rec = item as Record<string, unknown>;
  if ("function_call" in rec && "function_call_output" in rec) {
    if (rec.function_call && typeof rec.function_call === "object") {
      into.push(rec.function_call as InputItem);
    }
    if (rec.function_call_output && typeof rec.function_call_output === "object") {
      into.push(rec.function_call_output as InputItem);
    }
    return;
  }
  into.push(rec);
}

function toInputItems(messages: AgentMessage[]): InputItem[] {
  const result: InputItem[] = [];
  for (const msg of messages) {
    const content = msg.content;
    if (typeof content === "string") {
      const partType = msg.role === "assistant" ? "output_text" : "input_text";
      result.push({ role: msg.role, content: [{ type: partType, text: content }] });
      continue;
    }
    if (msg.role === "assistant") {
      const textParts: string[] = [];
      const items: InputItem[] = [];
      for (const block of content) {
        if (block.type === "text") textParts.push(block.text);
        else if (block.type === "tool_use") {
          items.push({
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}),
          });
        } else if (block.type === "remote_tool") {
          pushRemoteToolItem(block.item, items);
        }
      }
      if (textParts.length > 0) result.push({ role: "assistant", content: [{ type: "output_text", text: textParts.join("") }] });
      result.push(...items);
    } else if (msg.role === "user") {
      const parts: ContentPart[] = [];
      const textParts: string[] = [];
      for (const block of content) {
        if (block.type === "text") textParts.push(block.text);
        else if (block.type === "tool_result") {
          result.push({ type: "function_call_output", call_id: block.toolUseId, output: block.content });
        } else if (block.type === "image") {
          parts.push({ type: "input_image", image_url: `data:${block.source.mediaType};base64,${block.source.data}` });
        }
      }
      if (textParts.length > 0) parts.push({ type: "input_text", text: textParts.join("") });
      if (parts.length > 0) result.push({ role: "user", content: parts });
    }
  }
  return result;
}

export async function* streamChat(
  config: ModelConfig,
  messages: AgentMessage[],
  signal?: AbortSignal,
  tools?: ToolDefinition[],
): AsyncGenerator<StreamEvent> {
  const baseUrl = config.baseUrl!.replace(/\/$/, "");
  const endpoint = baseUrl.match(/\/v\d+$/) ? `${baseUrl}/responses` : `${baseUrl}/v1/responses`;
  const name = displayProviderName(config);

  const requestBody: Record<string, unknown> = {
    model: config.model,
    input: toInputItems(messages),
    stream: true,
    store: false,
    ...(config.maxTokens != null && { max_output_tokens: config.maxTokens }),
  };
  if (tools && tools.length > 0) {
    requestBody.tools = tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    requestBody.tool_choice = "auto";
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(requestBody),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) return;
    yield { type: "error", error: `Network error: ${e instanceof Error ? e.message : `Failed to connect to ${name} API`}`, kind: "network" };
    return;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (response.status === 401) {
      yield { type: "error", error: `Invalid ${name} API key`, kind: "auth" };
    } else if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      yield { type: "error", error: `${name} rate limit exceeded${retryAfter ? `. Retry after ${retryAfter}s` : ""}`, kind: "ratelimit" };
    } else {
      yield { type: "error", error: `${name} API error (${response.status}): ${text}`, kind: "http" };
    }
    return;
  }

  // function_call 的流式 args delta 以 item_id（fc_…）为键，tool-call 事件以
  // 递增 index 为键 —— 用 map 桥接两套 id。index 用单调计数器，不能用
  // Map.size：转成 remote 后会从 map 删除，size 回落会撞号。
  const indexByItemId = new Map<string, number>();
  let nextToolIndex = 0;
  /** Still-local function_call item ids (removed when a matching function_call_output arrives). */
  const localItemIds = new Set<string>();
  const fcByCallId = new Map<string, { itemId: string; index: number; item: Record<string, unknown> }>();
  const pendingFcOutputs = new Map<string, Record<string, unknown>>();
  let usage: Extract<StreamEvent, { type: "done" }>["usage"];

  const hasPendingLocalTools = () => localItemIds.size > 0;

  const emitRemoteFromFcOutput = function* (outputItem: Record<string, unknown>): Generator<StreamEvent> {
    const callId = typeof outputItem.call_id === "string" ? outputItem.call_id : "";
    if (!callId) return;
    const fc = fcByCallId.get(callId);
    if (!fc) return;
    const name = typeof fc.item.name === "string" ? fc.item.name : "function_call";
    yield {
      type: "remote-tool",
      callId,
      name,
      args: remoteToolArgs(fc.item),
      output: remoteToolOutput(outputItem),
      item: { function_call: fc.item, function_call_output: outputItem },
    };
    localItemIds.delete(fc.itemId);
    indexByItemId.delete(fc.itemId);
    fcByCallId.delete(callId);
    pendingFcOutputs.delete(callId);
  };
  // Responses API usage: input_tokens INCLUDES the cached portion; the cached
  // count itself lives in input_tokens_details.cached_tokens.
  const readUsage = (
    resp:
      | {
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            input_tokens_details?: { cached_tokens?: number };
          };
        }
      | undefined,
  ) => {
    if (!resp?.usage) return;
    const cached = resp.usage.input_tokens_details?.cached_tokens ?? 0;
    usage = {
      inputTokens: resp.usage.input_tokens ?? 0,
      outputTokens: resp.usage.output_tokens ?? 0,
      ...(cached > 0
        ? { cachedTokens: cached, promptTotalTokens: resp.usage.input_tokens ?? 0 }
        : {}),
    };
  };

  try {
    for await (const sse of readSSELines(response, signal)) {
      if (signal?.aborted) return;
      let data: Record<string, any>;
      try { data = JSON.parse(sse.data); } catch { continue; }
      switch (data.type) {
        case "response.output_text.delta":
          if (data.delta) yield { type: "text-delta", text: data.delta };
          break;
        case "response.output_item.added":
          if (data.item?.type === "function_call") {
            const index = nextToolIndex++;
            const itemId = data.item.id ?? `#${index}`;
            const item = data.item as Record<string, unknown>;
            indexByItemId.set(itemId, index);
            localItemIds.add(itemId);
            if (typeof data.item.call_id === "string") {
              fcByCallId.set(data.item.call_id, { itemId, index, item });
            }
            yield { type: "tool-call-start", id: data.item.call_id, index, name: data.item.name };
            if (data.item.arguments) yield { type: "tool-call-delta", index, argsDelta: data.item.arguments };
          } else if (data.item?.type === "function_call_output") {
            const outputItem = data.item as Record<string, unknown>;
            const callId = typeof outputItem.call_id === "string" ? outputItem.call_id : "";
            if (callId) pendingFcOutputs.set(callId, outputItem);
          }
          break;
        case "response.function_call_arguments.delta": {
          const index = indexByItemId.get(data.item_id);
          if (index !== undefined && data.delta) yield { type: "tool-call-delta", index, argsDelta: data.delta };
          break;
        }
        case "response.output_item.done":
          if (data.item?.type === "function_call") {
            const itemId = data.item.id ?? "";
            const index = indexByItemId.get(itemId);
            if (index !== undefined) yield { type: "tool-call-end", index };
            if (typeof data.item.call_id === "string") {
              const prev = fcByCallId.get(data.item.call_id);
              fcByCallId.set(data.item.call_id, {
                itemId: itemId || prev?.itemId || `#${index ?? 0}`,
                index: index ?? prev?.index ?? 0,
                item: data.item as Record<string, unknown>,
              });
            }
          } else if (data.item?.type === "function_call_output") {
            yield* emitRemoteFromFcOutput(data.item as Record<string, unknown>);
          } else if (isRemoteServerItemType(data.item?.type)) {
            const item = data.item as Record<string, unknown>;
            const name = typeof item.name === "string" ? item.name : String(item.type);
            const callId =
              (typeof item.call_id === "string" && item.call_id) ||
              (typeof item.id === "string" && item.id) ||
              name;
            yield {
              type: "remote-tool",
              callId,
              name,
              args: remoteToolArgs(item),
              output: remoteToolOutput(item),
              item,
            };
          }
          break;
        case "response.completed":
          readUsage(data.response);
          for (const leftover of pendingFcOutputs.values()) yield* emitRemoteFromFcOutput(leftover);
          yield { type: "done", stopReason: hasPendingLocalTools() ? "tool_calls" : "end", usage };
          return;
        case "response.incomplete": {
          readUsage(data.response);
          for (const leftover of pendingFcOutputs.values()) yield* emitRemoteFromFcOutput(leftover);
          const truncated = data.response?.incomplete_details?.reason === "max_output_tokens";
          yield { type: "done", stopReason: truncated ? "length" : hasPendingLocalTools() ? "tool_calls" : "end", usage };
          return;
        }
        case "response.failed":
          yield { type: "error", error: `${name} API error: ${data.response?.error?.message ?? "response failed"}`, kind: "http" };
          return;
        case "error":
          yield { type: "error", error: `${name} API error: ${data.message ?? "unknown stream error"}`, kind: "http" };
          return;
      }
    }
    if (signal?.aborted) return;
    // 流在 response.completed 之前断掉（网络中断等）：兜底收尾，别让 loop 悬死。
    for (const leftover of pendingFcOutputs.values()) yield* emitRemoteFromFcOutput(leftover);
    for (const [, index] of indexByItemId) yield { type: "tool-call-end", index };
    yield { type: "done", stopReason: hasPendingLocalTools() ? "tool_calls" : "end", usage };
  } catch (e) {
    if (signal?.aborted) return;
    yield { type: "error", error: `Stream error: ${e instanceof Error ? e.message : "connection lost"}`, kind: "network" };
  }
}

// Test-only export
export { toInputItems as _toInputItemsForTest };
