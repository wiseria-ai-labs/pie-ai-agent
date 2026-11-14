import { describe, it, expect } from "vitest";
import { buildSeededTaskContent, prependTimeToLastUserMessage } from "./loop";
import type { AgentMessage } from "../model-router/types";

/**
 * Pie 2.0 记忆层 — 画像注入的位置不变量（spec §5.5）：
 * 画像放进 **user role** 的 `<user_memory as_of>` wrapper，不碰 system role；
 * 位置在 <current_time> 之后、<user_task> 之前。
 */
const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const MEM = '<user_memory as_of="2026-11-14">\n偏好：高铁一等座\n</user_memory>';

describe("buildSeededTaskContent (headless)", () => {
  it("puts the memory block after the time block and before the task wrapper", () => {
    const out = buildSeededTaskContent(NOW, "订高铁", MEM);
    const iTime = out.indexOf("<current_time>");
    const iMem = out.indexOf("<user_memory");
    const iTask = out.indexOf("<user_task>");
    expect(iTime).toBe(0);
    expect(iMem).toBeGreaterThan(iTime);
    expect(iTask).toBeGreaterThan(iMem);
    expect(out).toContain("</user_memory>");
  });

  it("omits the memory block when empty", () => {
    expect(buildSeededTaskContent(NOW, "订高铁", "")).not.toContain("<user_memory");
  });
});

describe("prependTimeToLastUserMessage", () => {
  it("injects time + memory into the last user message only", () => {
    const messages: AgentMessage[] = [
      { role: "system", content: "S" },
      { role: "user", content: "<untrusted_user_message>早期</untrusted_user_message>" },
      { role: "assistant", content: "好的" },
      { role: "user", content: "<user_task>订高铁</user_task>" },
    ];
    const out = prependTimeToLastUserMessage(messages, NOW, MEM);
    expect(out).toHaveLength(4);
    const last = out[3]!.content as string;
    expect(last.indexOf("<current_time>")).toBe(0);
    expect(last.indexOf("<user_memory")).toBeGreaterThan(last.indexOf("<current_time>"));
    expect(last.indexOf("<user_task>")).toBeGreaterThan(last.indexOf("<user_memory"));
    // 早期 user 消息完全不注入
    expect(out[1]!.content).toBe("<untrusted_user_message>早期</untrusted_user_message>");
  });

  it("keeps block order for array content (image attachments)", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", mediaType: "image/png", data: "AAA" } },
          { type: "text", text: "<user_task>看图</user_task>" },
        ],
      },
    ];
    const out = prependTimeToLastUserMessage(messages, NOW, MEM);
    const blocks = out[0]!.content;
    expect(Array.isArray(blocks)).toBe(true);
    if (!Array.isArray(blocks)) return;
    expect(blocks[0]!.type).toBe("text");
    expect((blocks[0] as { text: string }).text).toContain("<current_time>");
    expect(blocks[1]!.type).toBe("text");
    expect((blocks[1] as { text: string }).text).toBe(MEM);
    expect(blocks[2]!.type).toBe("image");
    expect(blocks[3]!.type).toBe("text");
  });
});
