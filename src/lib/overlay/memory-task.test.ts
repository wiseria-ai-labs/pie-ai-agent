import { describe, it, expect } from "vitest";
import { shouldReuseMemoryPick, taskSimilarity } from "./memory-task";

describe("overlay memory prefetch reuse", () => {
  it("reuses an identical task", () => {
    expect(shouldReuseMemoryPick("帮我写一封请假邮件", "帮我写一封请假邮件")).toBe(true);
  });

  it("reuses when the typed task overlaps the page/selection the pick saw", () => {
    // Prefetch ran with the selection; the typed text is a short instruction
    // on top of the same subject matter → enough overlap.
    const prefetch = "请假申请：因家中有事，需请假两天，请批准。";
    expect(shouldReuseMemoryPick(prefetch, "请假申请怎么写更正式")).toBe(true);
  });

  it("reruns when the typed task drifts away from the prefetched context", () => {
    const prefetch = "会议纪要：Q3 复盘，讨论了留存与增长";
    expect(shouldReuseMemoryPick(prefetch, "帮我订一张去上海的机票")).toBe(false);
    // One shared token is already enough to count as the same matter.
    expect(shouldReuseMemoryPick(prefetch, "帮我整理会议纪要")).toBe(true);
  });

  it("reruns when the prefetch had no task text (no title/selection)", () => {
    expect(shouldReuseMemoryPick("", "随便问一句")).toBe(false);
    expect(shouldReuseMemoryPick("   ", "随便问一句")).toBe(false);
  });

  it("handles Latin text", () => {
    expect(
      shouldReuseMemoryPick("monthly report draft about retention", "help me polish the retention report"),
    ).toBe(true);
    expect(
      shouldReuseMemoryPick("monthly report draft about retention", "book a flight to shanghai"),
    ).toBe(false);
  });

  it("counts CJK bigrams, not raw characters (1-char noise does not dominate)", () => {
    expect(taskSimilarity("天气预报", "天气")).toBeGreaterThan(0);
    expect(taskSimilarity("天气预报", "股票行情")).toBe(0);
  });
});
