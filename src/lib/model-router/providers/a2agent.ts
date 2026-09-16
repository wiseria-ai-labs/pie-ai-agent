import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ToolDefinition, StreamEvent } from "@/lib/model-router/types";
import { streamChatOpenAICompat } from "./_shared/openai-compat-core";

// A2Agent (a2agent.me) is an OpenAI-compatible API gateway aggregating
// DeepSeek / Qwen / GLM / Kimi / MiniMax behind one key for overseas users (#446).
// It speaks the OpenAI Chat Completions wire: Bearer auth,
// POST /v1/chat/completions, SSE streaming (incl. `delta.tool_calls` chunks and
// `reasoning_content`). No hooks needed — the core's default
// `Authorization: Bearer ${apiKey}` already matches the gateway.
export async function* streamChat(
  config: ModelConfig,
  messages: AgentMessage[],
  signal?: AbortSignal,
  tools?: ToolDefinition[],
): AsyncGenerator<StreamEvent> {
  yield* streamChatOpenAICompat(config, messages, signal, tools);
}
