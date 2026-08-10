import type { StreamEvent } from "@/lib/model-router/types";

type StopReason = Extract<StreamEvent, { type: "done" }>["stopReason"];

export type StreamCompletionKind = "ok" | "truncated-empty" | "truncated-partial" | "empty";

/**
 * 判定一次 LLM 流式输出的收尾性质。识别两类坏收尾：
 * - 被 max_tokens 上限截断（`stopReason === "length"`，anthropic-wire 的 max_tokens /
 *   openai-compat 的 finish_reason="length" 都映射成它）。
 * - 「空完成」：没有 tool call、也没有任何文本产出。这通常意味着上游/中转在扣费后失败，
 *   却被静默当成一次空回复（见 #413）——不再冒充成功，交由 loop 报错。
 * 纯函数，无副作用。
 */
export function classifyStreamCompletion(input: {
  stopReason: StopReason;
  hasToolCalls: boolean;
  hasText: boolean;
}): StreamCompletionKind {
  if (input.hasToolCalls) return "ok"; // 有 tool call 一律继续（含 length + tool_calls）
  if (input.stopReason === "length") return input.hasText ? "truncated-partial" : "truncated-empty";
  if (!input.hasText) return "empty"; // stop/undefined 且啥都没产出
  return "ok";
}
