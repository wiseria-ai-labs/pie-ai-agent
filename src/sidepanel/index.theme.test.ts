import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// Reads the raw CSS so the token contract can't silently regress.
const css = readFileSync(path.resolve(__dirname, "./index.css"), "utf8");

describe("design tokens (@theme)", () => {
  it("defines the 3-tier semantic radius scale (additive, not overriding Tailwind defaults)", () => {
    expect(css).toContain("--radius-chip: 6px");
    expect(css).toContain("--radius-control: 10px");
    expect(css).toContain("--radius-card: 16px");
    expect(css).toContain("--radius-field: 11px");
    expect(css).toContain("--radius-pill: 999px");
  });

  it("defines the motion duration + easing tokens", () => {
    expect(css).toContain("--ease-standard: cubic-bezier(0.32, 0.72, 0, 1)");
    expect(css).toContain("--duration-fast: 140ms");
    expect(css).toContain("--duration-base: 200ms");
    expect(css).toContain("--duration-slow: 260ms");
  });

  it("defines the type scale tokens", () => {
    expect(css).toContain("--text-caps: 11px");
    expect(css).toContain("--text-caps--line-height: 16px");
    expect(css).toContain("--text-caption: 12px");
    expect(css).toContain("--text-caption--line-height: 16px");
    expect(css).toContain("--text-body: 13px");
    expect(css).toContain("--text-body--line-height: 19px");
    expect(css).toContain("--text-body-lg: 14px");
    expect(css).toContain("--text-body-lg--line-height: 21px");
    expect(css).toContain("--text-h3: 16px");
    expect(css).toContain("--text-h3--line-height: 22px");
    expect(css).toContain("--text-h2: 18px");
    expect(css).toContain("--text-h2--line-height: 24px");
    expect(css).toContain("--text-display: 22px");
    expect(css).toContain("--text-display--line-height: 26px");
  });

  it("defines the two elevation tokens", () => {
    expect(css).toContain("--shadow-pop: 0 8px 24px rgba(0, 0, 0, 0.18)");
    expect(css).toContain("--shadow-overlay: 0 16px 48px rgba(0, 0, 0, 0.32)");
  });

  it("defines the user-bubble color token for both themes", () => {
    expect(css).toContain("--c-bubble: #E9EEF4"); // light
    expect(css).toContain("--c-bubble: #22303E"); // dark
    expect(css).toContain("--color-bubble: var(--c-bubble)");
  });
});

describe("Sky Peach palette (v2.0.0 redesign)", () => {
  it("uses the sky-blue accent in light and dark", () => {
    expect(css).toContain("--c-accent: #2F8BFF");       // light
    expect(css).toContain("--c-accent-strong: #1D6BD6"); // light
    expect(css).toContain("--c-accent: #6FB3FF");       // dark
  });
  it("uses restrained amber for warning", () => {
    expect(css).toContain("--c-warning: #C9821E");
    expect(css).toContain("--c-warning-fg: #B0781E");
  });
  it("maps the new utilities in @theme", () => {
    for (const m of ["--color-fg-4", "--color-warning-fg", "--color-danger-fg",
                     "--color-surface-deep", "--color-overlay-strong", "--color-brand-peach"]) {
      expect(css).toContain(`${m}: var(`);
    }
  });
  it("keeps brand peach decorative-only (defined, never a bg-* semantic)", () => {
    expect(css).toContain("--c-brand-peach: #FF9FB2");
  });
});
