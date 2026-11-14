import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  MONITOR_HIGHLIGHT_ATTR,
  clearMonitorHighlightInPage,
  paintMonitorHighlightInPage,
} from "./highlight";

const PAGE = `
  <div class="price">¥2,399</div>
  <div class="wrap"><span class="sku">SKU-42</span></div>
`;

const hosts = () =>
  Array.from(document.querySelectorAll<HTMLElement>(`[${MONITOR_HIGHLIGHT_ATTR}]`));

beforeEach(() => {
  document.body.innerHTML = PAGE;
});

afterEach(() => {
  clearMonitorHighlightInPage();
  vi.restoreAllMocks();
});

describe("paintMonitorHighlightInPage", () => {
  it("mounts a shadow-hosted box for the selector match", () => {
    const r = paintMonitorHighlightInPage({ selector: ".price", label: "Pie 会盯住这里" });
    expect(r.found).toBe(true);
    expect(hosts()).toHaveLength(1);
    const root = hosts()[0]!.shadowRoot!;
    const tag = root.querySelector("div:last-child") as HTMLElement;
    expect(tag.textContent).toBe("Pie 会盯住这里");
    // Light DOM stays empty apart from the host → page snapshots see nothing.
    expect(hosts()[0]!.textContent).toBe("");
  });

  it("falls back to the text anchor when the selector no longer matches", () => {
    const r = paintMonitorHighlightInPage({ selector: "#gone", anchorText: "SKU-42", label: "x" });
    expect(r.found).toBe(true);
    expect(hosts()).toHaveLength(1);
  });

  it("falls back to the recorded sample value", () => {
    const r = paintMonitorHighlightInPage({ selector: "#gone", sample: "¥2,399", label: "x" });
    expect(r.found).toBe(true);
  });

  it("reports found:false (and paints nothing) when nothing matches", () => {
    const r = paintMonitorHighlightInPage({ selector: "#gone", anchorText: "nope", label: "x" });
    expect(r.found).toBe(false);
    expect(hosts()).toHaveLength(0);
  });

  it("is idempotent — repainting replaces the previous box", () => {
    paintMonitorHighlightInPage({ selector: ".price", label: "a" });
    paintMonitorHighlightInPage({ selector: ".sku", label: "b" });
    expect(hosts()).toHaveLength(1);
  });

  it("survives an invalid selector", () => {
    expect(() => paintMonitorHighlightInPage({ selector: ">>>", label: "x" })).not.toThrow();
  });

  it("renders the label as text, never as markup", () => {
    paintMonitorHighlightInPage({ selector: ".price", label: "<img src=x onerror=alert(1)>" });
    const tag = hosts()[0]!.shadowRoot!.querySelector("div:last-child") as HTMLElement;
    expect(tag.querySelector("img")).toBeNull();
    expect(tag.textContent).toBe("<img src=x onerror=alert(1)>");
  });
});

describe("clearMonitorHighlightInPage", () => {
  it("removes the box", () => {
    paintMonitorHighlightInPage({ selector: ".price", label: "x" });
    expect(hosts()).toHaveLength(1);
    clearMonitorHighlightInPage();
    expect(hosts()).toHaveLength(0);
  });

  it("is a no-op when nothing is painted", () => {
    expect(() => clearMonitorHighlightInPage()).not.toThrow();
  });
});
