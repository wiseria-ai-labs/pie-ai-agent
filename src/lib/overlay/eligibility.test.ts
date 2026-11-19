import { describe, it, expect } from "vitest";
import { canHostOverlay } from "./eligibility";

describe("overlay eligibility (restricted-page fallback)", () => {
  it("allows ordinary http(s) pages", () => {
    expect(canHostOverlay("https://mail.example.com/u/0/#drafts", false)).toBe(true);
    expect(canHostOverlay("http://localhost:3000/", false)).toBe(true);
  });

  it("rejects every internal / privileged scheme", () => {
    expect(canHostOverlay("chrome://settings", false)).toBe(false);
    expect(canHostOverlay("edge://version", false)).toBe(false);
    expect(canHostOverlay("chrome-extension://abc/src/sidepanel/index.html", false)).toBe(false);
    expect(canHostOverlay("chrome://newtab", false)).toBe(false);
    expect(canHostOverlay("about:blank", false)).toBe(false);
  });

  it("rejects PDF tabs even on ordinary URLs (sealed viewer)", () => {
    expect(canHostOverlay("https://arxiv.org/pdf/2401.00001", true)).toBe(false);
    // The SW derives `isPdf` from `isPdfTab`, which also flags local PDFs.
    expect(canHostOverlay("file:///Users/me/paper.pdf", true)).toBe(false);
  });

  it("rejects local files (file:// origins cannot be pinned)", () => {
    expect(canHostOverlay("file:///Users/me/notes.html", false)).toBe(false);
  });

  it("rejects tabs without a URL (still loading / not committed)", () => {
    expect(canHostOverlay(undefined, false)).toBe(false);
    expect(canHostOverlay("", false)).toBe(false);
  });
});
