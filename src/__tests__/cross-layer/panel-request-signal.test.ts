import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * Cross-layer guard: every `requestFromPanel(...)` call and HITL wrapper binding
 * in production source under `src/` must thread the task's `AbortSignal`.
 *
 * Why: a HITL card suspends a tool inside an awaited promise. If the user clicks
 * Stop, the loop aborts its signal — any call site or wrapper binding that drops
 * `signal` leaves the tool and confirm card hanging indefinitely. Because
 * `signal` is optional on `PanelRequestOptions`, TypeScript cannot enforce this.
 */

const SRC_ROOT = resolve(process.cwd(), "src");

function walkNonTestTsFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "__tests__" || e.name === "test") continue;
      out.push(...walkNonTestTsFiles(full));
    } else if (
      (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) &&
      !e.name.endsWith(".test.ts") &&
      !e.name.endsWith(".test.tsx") &&
      !e.name.endsWith(".spec.ts") &&
      !e.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Replace comments (line and block) with spaces while preserving string and
 * template literals, keeping character positions intact for diagnostics.
 */
function stripCommentsPreservingStrings(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];

    // Single-line comment
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }

    // Block comment
    if (ch === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      if (i < source.length) {
        out += "  ";
        i += 2;
      }
      continue;
    }

    // String / template literal — copy verbatim (including escapes)
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < source.length) {
        const c = source[i]!;
        out += c;
        i += 1;
        if (c === "\\") {
          if (i < source.length) {
            out += source[i]!;
            i += 1;
          }
          continue;
        }
        if (c === quote) break;
      }
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
}

/** Extract the full balanced `name(...)` call text for every matching call. */
function extractBalancedCall(source: string, openParenIdx: number, startIdx: number): { text: string; end: number } {
  let depth = 0;
  let j = openParenIdx;
  while (j < source.length) {
    const ch = source[j]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      j += 1;
      while (j < source.length) {
        const c = source[j]!;
        j += 1;
        if (c === "\\") {
          j += 1;
          continue;
        }
        if (c === quote) break;
      }
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
    j += 1;
  }
  return { text: source.slice(startIdx, j + 1), end: j + 1 };
}

function findCallSites(source: string, fnName: string): string[] {
  const re = new RegExp(`\\b${fnName}\\s*(?:<[^>]*>)?\\(`, "g");
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    // Skip function declarations: `function fnName(`
    const prefix = source.slice(Math.max(0, match.index - 20), match.index);
    if (/\bfunction\s+$/.test(prefix)) continue;
    const openParen = source.indexOf("(", match.index);
    const { text, end } = extractBalancedCall(source, openParen, match.index);
    out.push(text);
    re.lastIndex = end;
  }
  return out;
}

const WRAPPERS = ["requestCdpInputConsent", "requestLocalFileFromPanel"] as const;

describe("panel-request call sites and wrapper bindings thread AbortSignal", () => {
  it("every requestFromPanel(...) call in src/ passes `signal`", () => {
    const files = walkNonTestTsFiles(SRC_ROOT);
    const missing: string[] = [];
    let totalCalls = 0;

    for (const file of files) {
      const stripped = stripCommentsPreservingStrings(readFileSync(file, "utf8"));
      const sites = findCallSites(stripped, "requestFromPanel");
      totalCalls += sites.length;
      for (const site of sites) {
        if (!/\bsignal\b/.test(site)) {
          missing.push(`${relative(SRC_ROOT, file)}: ${site}`);
        }
      }
    }

    expect(missing).toEqual([]);
    // Guard against scanner failure or silent drop of call sites (2 wrappers + 1 MCP + 4 in loop.ts).
    expect(totalCalls).toBeGreaterThanOrEqual(7);
  });

  it("every HITL wrapper usage in src/ invokes the wrapper with `signal` (no bare reference)", () => {
    const files = walkNonTestTsFiles(SRC_ROOT);
    const missing: string[] = [];
    let totalWrapperCalls = 0;

    for (const file of files) {
      const rel = relative(SRC_ROOT, file);
      const stripped = stripCommentsPreservingStrings(readFileSync(file, "utf8"));
      const lines = stripped.split("\n");

      for (const wrapper of WRAPPERS) {
        const re = new RegExp(`\\b${wrapper}\\b`, "g");
        let match: RegExpExecArray | null;
        while ((match = re.exec(stripped)) !== null) {
          const idx = match.index;
          // Find current statement/line context to ignore imports and own declaration.
          const lineStart = stripped.lastIndexOf("\n", idx) + 1;
          const lineEnd = stripped.indexOf("\n", idx);
          const line = stripped.slice(lineStart, lineEnd === -1 ? stripped.length : lineEnd);
          const beforeOnLine = stripped.slice(lineStart, idx);

          // Ignore import specifiers (single-line or multi-line `import { ... }`) and function declaration
          if (/\bfunction\s+$/.test(beforeOnLine)) continue;
          if (/^\s*import\b/.test(line)) continue;
          const lookback = stripped.slice(Math.max(0, idx - 200), idx);
          const lastImport = lookback.lastIndexOf("import");
          const lastFrom = lookback.lastIndexOf("from");
          if (lastImport !== -1 && lastImport > lastFrom && !lookback.slice(lastImport).includes(";")) {
            continue;
          }

          // Must be an invocation `wrapper(...)` — not a bare function reference `requestConsent: requestCdpInputConsent`.
          const after = stripped.slice(idx + wrapper.length);
          const parenMatch = /^\s*\(/.exec(after);
          if (!parenMatch) {
            missing.push(`${rel}: bare reference to ${wrapper} without passing { signal } (${lines[stripped.slice(0, idx).split("\n").length - 1]?.trim()})`);
            continue;
          }

          const openParen = idx + wrapper.length + parenMatch[0].length - 1;
          const { text, end } = extractBalancedCall(stripped, openParen, idx);
          totalWrapperCalls += 1;
          if (!/\bsignal\b/.test(text)) {
            missing.push(`${rel}: ${text}`);
          }
          re.lastIndex = end;
        }
      }
    }

    expect(missing).toEqual([]);
    expect(totalWrapperCalls).toBeGreaterThanOrEqual(2);
  });
});
