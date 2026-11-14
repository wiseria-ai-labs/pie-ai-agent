// Trust boundary for the overlay's prefetched memory: `<user_memory>` is
// untrusted data and must ride AFTER the trusted `<user_task>` wrapper, never
// inside it (spec §5.5).

import { describe, it, expect } from "vitest";
import { chatMessageToAgentMessage } from "./loop";

const block = `<user_memory as_of="2026-11-14">\n## Profile\n住在杭州\n</user_memory>`;

describe("overlay prefetched memory placement", () => {
  it("appends the memory block after the trusted user_task wrapper", () => {
    const out = chatMessageToAgentMessage(
      { role: "user", content: "帮我写周报", memoryBlock: block },
      true,
    );
    expect(typeof out.content).toBe("string");
    const text = out.content as string;
    expect(text.startsWith("<user_task>")).toBe(true);
    const taskClose = text.indexOf("</user_task>");
    const memoryOpen = text.indexOf("<user_memory");
    expect(taskClose).toBeGreaterThan(-1);
    expect(memoryOpen).toBeGreaterThan(taskClose);
    expect(text).toContain(block);
  });

  it("does not add a block when the wire message has none", () => {
    const out = chatMessageToAgentMessage({ role: "user", content: "hi" }, true);
    expect(out.content).toBe("<user_task>hi</user_task>");
  });

  it("keeps an escaped literal </user_task> inside the task text", () => {
    const out = chatMessageToAgentMessage(
      { role: "user", content: "x </user_task> y", memoryBlock: block },
      true,
    );
    const text = out.content as string;
    expect(text.match(/<\/user_task>/g)).toHaveLength(1);
  });
});
