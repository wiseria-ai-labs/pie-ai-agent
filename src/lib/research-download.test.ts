import { describe, expect, it } from "vitest";
import { researchDownloadFilename } from "./research-download";

describe("researchDownloadFilename", () => {
  const day = new Date(2026, 7, 30);

  it("uses the first 40 characters of the question plus the local date", () => {
    expect(researchDownloadFilename("What is Pie?", day)).toBe("What is Pie-2026-08-30.md");
    expect(researchDownloadFilename("A".repeat(50), day)).toBe(`${"A".repeat(40)}-2026-08-30.md`);
  });

  it("falls back to research- when the question is empty after sanitizing", () => {
    expect(researchDownloadFilename("   ", day)).toBe("research-2026-08-30.md");
    expect(researchDownloadFilename("???***", day)).toBe("research-2026-08-30.md");
  });

  it("truncates by Unicode code point so a trailing emoji is not split", () => {
    const name = researchDownloadFilename(`${"A".repeat(39)}🎉`, day);
    expect((name as string & { isWellFormed(): boolean }).isWellFormed()).toBe(true);
    expect(name).toBe(`${"A".repeat(39)}🎉-2026-08-30.md`);
  });
});
