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

const noAgents = () => [];

test("lists skills with invalid network declarations as a warning line", async () => {
  const r = await doctor(
    () => [
      skill({ name: "net-skill", invalidNetwork: ["not a domain!", "例え.テスト"] }),
      skill({ name: "clean-skill" }),
    ],
    noAgents,
  );
  const line = r.lines.find((l) => l.includes("net-skill"));
  expect(line).toBeDefined();
  expect(line).toContain("2 invalid network domain(s) ignored");
  expect(line).toContain("not a domain!");
  expect(line).toContain("例え.テスト");
  // clean skill 不产生 warning 行
  expect(r.lines.some((l) => l.includes("clean-skill"))).toBe(false);
});

test("invalid network declarations do not flip ok (断网是安全兜底不是故障)", async () => {
  const withInvalid = await doctor(() => [skill({ name: "x", invalidNetwork: ["bad!"] })], noAgents);
  const withNone = await doctor(() => [skill({ name: "x" })], noAgents);
  // ok 只由 IPC 在场决定，两者相同（不受 invalidNetwork 影响）
  expect(withInvalid.ok).toBe(withNone.ok);
});

test("agent 检测走 detectAgents，探不到不压 ok（menubar 裸 PATH 误报回归）", async () => {
  const found = await doctor(() => [], () => [
    { id: "codex-terminal", label: "Codex", kind: "terminal", path: "/usr/local/bin/codex" },
  ] as never);
  expect(found.lines.some((l) => l.includes("codex-terminal → /usr/local/bin/codex"))).toBe(true);

  const none = await doctor(() => [], noAgents);
  expect(none.lines.some((l) => l === "agents: none detected")).toBe(true);
  // 一个 agent 都没装 ≠ daemon 不健康：ok 与有无 agent 无关
  expect(none.ok).toBe(found.ok);
});
