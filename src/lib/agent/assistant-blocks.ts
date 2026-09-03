import type { ContentBlock } from "@/lib/model-router/types";

export type ThinkingContentBlock = Extract<ContentBlock, { type: "thinking" }>;
export interface CompletedToolCall { id: string; name: string; args: unknown; }

/**
 * assistant 轮次内容块组装：thinking（前插，Anthropic 要求） → text → trailing
 * （tool_use / remote_tool，按到达顺序）。
 */
export function assembleAssistantBlocks(
  thinkingBlocks: ThinkingContentBlock[],
  text: string,
  trailing: ContentBlock[] = [],
): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const tb of thinkingBlocks) blocks.push(tb);
  if (text) blocks.push({ type: "text", text });
  blocks.push(...trailing);
  return blocks;
}
