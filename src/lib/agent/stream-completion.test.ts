import { describe, it, expect } from "vitest";
import { classifyStreamCompletion } from "./stream-completion";

describe("classifyStreamCompletion", () => {
  it("正常结束 → ok", () => {
    expect(classifyStreamCompletion({ stopReason: "end", hasToolCalls: false, hasText: true })).toBe("ok");
  });
  it("有 tool call（即使 length）→ ok", () => {
    expect(classifyStreamCompletion({ stopReason: "length", hasToolCalls: true, hasText: false })).toBe("ok");
  });
  it("length 截断 + 无 tool + 无文本 → truncated-empty", () => {
    expect(classifyStreamCompletion({ stopReason: "length", hasToolCalls: false, hasText: false })).toBe("truncated-empty");
  });
  it("length 截断 + 无 tool + 有部分文本 → truncated-partial", () => {
    expect(classifyStreamCompletion({ stopReason: "length", hasToolCalls: false, hasText: true })).toBe("truncated-partial");
  });
  it("有文本正常结束（stopReason undefined，provider 没报）→ ok（不误判）", () => {
    expect(classifyStreamCompletion({ stopReason: undefined, hasToolCalls: false, hasText: true })).toBe("ok");
  });
  it("空完成：stopReason undefined + 无 tool + 无文本 → empty（#413 静默吞掉）", () => {
    expect(classifyStreamCompletion({ stopReason: undefined, hasToolCalls: false, hasText: false })).toBe("empty");
  });
  it("空完成：stopReason end + 无 tool + 无文本 → empty", () => {
    expect(classifyStreamCompletion({ stopReason: "end", hasToolCalls: false, hasText: false })).toBe("empty");
  });
  it("空完成：stopReason tool_calls 但实际无 call + 无文本 → empty", () => {
    expect(classifyStreamCompletion({ stopReason: "tool_calls", hasToolCalls: false, hasText: false })).toBe("empty");
  });
});
