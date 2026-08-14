import { test, expect } from "bun:test";
import { doctor } from "../src/doctor";

// 探不到 agent 的桩：默认 detectAgents 会问 login shell 要 PATH，测试不该依赖真机装了什么。
// ADR 0007：doctor 不再做 skill 网络声明健康检查（metadata.pie 整套下线），listSkills
// 注入点随之移除——doctor 只接 opts。
const noAgents = { detect: () => [] };

test("agent 检测走 detectAgents，探不到不压 ok（menubar 裸 PATH 误报回归）", async () => {
  const found = await doctor({
    detect: () => [
      { id: "codex-terminal", label: "Codex", kind: "terminal", path: "/usr/local/bin/codex" },
    ] as never,
  });
  expect(found.lines.some((l) => l.includes("codex-terminal → /usr/local/bin/codex"))).toBe(true);

  const none = await doctor(noAgents);
  expect(none.lines.some((l) => l === "agents: none detected")).toBe(true);
  // 一个 agent 都没装 ≠ daemon 不健康：ok 与有无 agent 无关
  expect(none.ok).toBe(found.ok);
});

test("non-Windows platform produces no Windows-check noise", async () => {
  const win: string[] = [];
  const r = await doctor({
    platform: "darwin",
    detect: () => [],
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
  const r = await doctor({
    platform: "win32",
    detect: () => [],
    windowsChecks: async () => ({ ok: false, lines: ["Chrome native-messaging: HKCU key present — SHADOWS ..."] }),
  });
  expect(r.lines.some((l) => l.includes("HKCU key present"))).toBe(true);
  // A failing Windows verdict drags the overall ok to false.
  expect(r.ok).toBe(false);
});
