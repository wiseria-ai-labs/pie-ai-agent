import { test, expect } from "bun:test";
import { doctor } from "../src/doctor";
import type { SkillSummary } from "../../src/types/local-bridge";

function skill(over: Partial<SkillSummary>): SkillSummary {
  return {
    name: "s",
    description: "d",
    runnableScripts: [],
    declaredCaps: { network: [], write: [] },
    files: [],
    ...over,
  };
}

test("lists skills with invalid network declarations as a warning line", async () => {
  const r = await doctor(() => [
    skill({ name: "net-skill", invalidNetwork: ["not a domain!", "例え.テスト"] }),
    skill({ name: "clean-skill" }),
  ]);
  const line = r.lines.find((l) => l.includes("net-skill"));
  expect(line).toBeDefined();
  expect(line).toContain("2 invalid network domain(s) ignored");
  expect(line).toContain("not a domain!");
  expect(line).toContain("例え.テスト");
  // clean skill 不产生 warning 行
  expect(r.lines.some((l) => l.includes("clean-skill"))).toBe(false);
});

test("invalid network declarations do not flip ok (断网是安全兜底不是故障)", async () => {
  const withInvalid = await doctor(() => [skill({ name: "x", invalidNetwork: ["bad!"] })]);
  const withNone = await doctor(() => [skill({ name: "x" })]);
  // ok 只由 socket + claude CLI 决定，两者相同（不受 invalidNetwork 影响）
  expect(withInvalid.ok).toBe(withNone.ok);
});

test("non-Windows platform produces no Windows-check noise", async () => {
  const win: string[] = [];
  const r = await doctor(() => [], {
    platform: "darwin",
    windowsChecks: async () => {
      win.push("SHOULD-NOT-RUN");
      return { ok: false, lines: ["SHOULD-NOT-RUN"] };
    },
  });
  expect(win).toEqual([]);
  expect(r.lines.some((l) => l.includes("SHOULD-NOT-RUN"))).toBe(false);
  expect(r.lines.some((l) => l.includes("native-messaging"))).toBe(false);
});

test("win32 platform appends Windows checks and factors their ok verdict", async () => {
  const r = await doctor(() => [], {
    platform: "win32",
    windowsChecks: async () => ({ ok: false, lines: ["Chrome native-messaging: HKCU key present — SHADOWS ..."] }),
  });
  expect(r.lines.some((l) => l.includes("HKCU key present"))).toBe(true);
  // A failing Windows verdict drags the overall ok to false.
  expect(r.ok).toBe(false);
});
