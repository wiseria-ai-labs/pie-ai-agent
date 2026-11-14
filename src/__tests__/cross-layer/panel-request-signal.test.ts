import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Cross-layer guard: every `requestFromPanel(...)` call in the agent layer must
 * pass the task's AbortSignal.
 *
 * Why: a HITL card suspends the tool inside an awaited promise. If the user
 * presses Stop, the loop aborts — but a call that never received the signal
 * keeps waiting forever (the 2.0 real-device bug: the turn stuck on
 * "正在调用" with no way out). The type system can't catch this (signal is
 * optional on PanelRequestOptions), so it is enforced by scanning source.
 */

const ROOT = path.resolve(__dirname, "../../..");

const FILES = [
  "src/lib/agent/loop.ts",
  "src/lib/agent/tools/browser-data.ts",
  "src/lib/agent/tools/skill-script.ts",
  "src/lib/cdp-input-onboarding.ts",
  "src/lib/local-file-request.ts",
];

/** Extract the full argument text of every `requestFromPanel(...)` call. */
function callSites(source: string): string[] {
  const needle = "requestFromPanel(";
  const out: string[] = [];
  let i = 0;
  while ((i = source.indexOf(needle, i)) !== -1) {
    let depth = 0;
    let j = i + needle.length - 1; // index of "("
    for (; j < source.length; j += 1) {
      const ch = source[j];
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push(source.slice(i, j + 1));
    i = j + 1;
  }
  return out;
}

describe("panel-request call sites thread the abort signal", () => {
  it("every requestFromPanel(...) call in the agent layer passes `signal`", () => {
    let total = 0;
    for (const rel of FILES) {
      const source = fs.readFileSync(path.join(ROOT, rel), "utf-8");
      const sites = callSites(source);
      total += sites.length;
      for (const site of sites) {
        expect(
          /\bsignal\b/.test(site),
          `${rel}: requestFromPanel call is missing a signal — Stop would hang this card:\n${site}`,
        ).toBe(true);
      }
    }
    // Guard the extractor itself: a broken scan must not pass vacuously.
    expect(total).toBeGreaterThanOrEqual(8);
  });

  it("pinpoints the loop's own call sites (sketch of what is enforced)", () => {
    const source = fs.readFileSync(path.join(ROOT, "src/lib/agent/loop.ts"), "utf-8");
    const sites = callSites(source);
    expect(sites.length).toBeGreaterThanOrEqual(5);
    for (const site of sites) expect(site).toContain("signal");
  });
});
