import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { interpreterFor, pickWindowsPython, runSkillScript } from "../src/skill-exec";
import type { SkillExecDeps } from "../src/skill-exec";
import { fakeSkillSandbox } from "../src/skill-sandbox";
import { setLogEnabled } from "../src/log";

setLogEnabled(false);

const SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const identityEnv: SkillExecDeps["buildEnv"] = (extra) => ({ ...extra });

function fixture() {
  const base = join(import.meta.dir, ".tmp-win-" + Math.random().toString(36).slice(2));
  const skillsRoot = join(base, "skills");
  const sessionsDir = join(base, "sessions");
  const dir = join(skillsRoot, "web-fetch");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: web-fetch\ndescription: d\n---\nb\n`);
  writeFileSync(join(dir, "scripts", "fetch.ts"), "export default () => 1;");
  return { base, skillsRoot, sessionsDir, auditPath: join(base, "audit.jsonl") };
}

// interpreterFor 的 Windows 分支 + python 探测的纯逻辑（spec §4.8，实测发现 F4）。
// 真机沙箱行为走 need-human-test；此处只测可在 mac/linux 上判定的平台分支与解析规则。

// ── .ts/.js/.mjs：三平台一致（内嵌 Bun）─────────────────────────────────────
test("interpreterFor: .ts/.js/.mjs → [execPath, run] on both platforms", () => {
  for (const platform of ["win32", "darwin"] as const) {
    for (const entry of ["a.ts", "b.js", "c.mjs", "d.cjs"]) {
      expect(interpreterFor(entry, { platform })).toEqual([process.execPath, "run"]);
    }
  }
});

// ── .sh：mac 走 bash；Windows 明确不支持 ────────────────────────────────────
test("interpreterFor: .sh → bash on darwin", () => {
  expect(interpreterFor("run.sh", { platform: "darwin" })).toEqual(["bash"]);
});

test("interpreterFor: .sh → unsupported_script error on win32", () => {
  expect(() => interpreterFor("run.sh", { platform: "win32" })).toThrow();
  try {
    interpreterFor("run.sh", { platform: "win32" });
  } catch (e) {
    expect((e as { code?: string }).code).toBe("unsupported_script");
    expect((e as Error).message).toMatch(/\.ts/i); // 引导作者提供 ts 版本
  }
});

// ── .py：mac 走 python3；Windows 探测全局 python ────────────────────────────
test("interpreterFor: .py → python3 on darwin", () => {
  expect(interpreterFor("s.py", { platform: "darwin" })).toEqual(["python3"]);
});

test("interpreterFor: .py on win32 → resolved global python path", () => {
  const found = "C:\\Python312\\python.exe";
  expect(interpreterFor("s.py", { platform: "win32", findPython: () => found })).toEqual([found]);
});

test("interpreterFor: .py on win32 with no global python → no_python error guiding all-users install", () => {
  try {
    interpreterFor("s.py", { platform: "win32", findPython: () => null });
    throw new Error("should have thrown");
  } catch (e) {
    expect((e as { code?: string }).code).toBe("no_python");
    expect((e as Error).message).toMatch(/all users/i);
  }
});

// ── pickWindowsPython（F4：排除 WindowsApps Store 别名 stub）─────────────────
test("pickWindowsPython: excludes \\WindowsApps\\ Store alias stubs", () => {
  const candidates = [
    "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe",
    "C:\\Python312\\python.exe",
  ];
  expect(pickWindowsPython(candidates)).toBe("C:\\Python312\\python.exe");
});

test("pickWindowsPython: only WindowsApps stub → null (treated as no python)", () => {
  expect(
    pickWindowsPython(["C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe"]),
  ).toBeNull();
});

test("pickWindowsPython: exclusion is case-insensitive on the WindowsApps segment", () => {
  expect(pickWindowsPython(["C:\\x\\windowsapps\\python.exe"])).toBeNull();
});

test("pickWindowsPython: trims blank lines and picks first real candidate", () => {
  expect(pickWindowsPython(["", "  ", "C:\\tools\\python\\python.exe", ""])).toBe(
    "C:\\tools\\python\\python.exe",
  );
});

test("pickWindowsPython: empty input → null", () => {
  expect(pickWindowsPython([])).toBeNull();
});

// ── 沙箱设施就绪检查（spec §3.2 / F6，fail-closed）──────────────────────────
test("readinessCheck not ready → sandbox_not_ready, before run", async () => {
  const f = fixture();
  let ran = false;
  const sandbox = fakeSkillSandbox(async () => {
    ran = true;
    return { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false };
  });
  try {
    await runSkillScript(
      { name: "web-fetch", entry: "fetch.ts", sessionId: SID },
      { sandbox, now: () => 1, buildEnv: identityEnv, ...f, readinessCheck: async () => ({ ready: false, reason: "WFP fence absent" }) },
    );
    throw new Error("should have thrown");
  } catch (e) {
    expect((e as { code?: string }).code).toBe("sandbox_not_ready");
    expect((e as Error).message).toMatch(/重装|reinstall|未就绪/);
  }
  expect(ran).toBe(false);
  rmSync(f.base, { recursive: true, force: true });
});

test("readinessCheck ready → run proceeds normally", async () => {
  const f = fixture();
  const sandbox = fakeSkillSandbox(async () => ({ stdout: "OK", stderr: "", exitCode: 0, timedOut: false, truncated: false }));
  const r = await runSkillScript(
    { name: "web-fetch", entry: "fetch.ts", sessionId: SID },
    { sandbox, now: () => 1, buildEnv: identityEnv, ...f, readinessCheck: async () => ({ ready: true }) },
  );
  expect(r.output).toBe("OK");
  rmSync(f.base, { recursive: true, force: true });
});

test("default readinessCheck (non-Windows host) → ready, run proceeds without injection", async () => {
  const f = fixture();
  const sandbox = fakeSkillSandbox(async () => ({ stdout: "OK", stderr: "", exitCode: 0, timedOut: false, truncated: false }));
  // 不注入 readinessCheck：默认走 checkWindowsSandboxReady，在非 win32 宿主上恒 ready
  const r = await runSkillScript(
    { name: "web-fetch", entry: "fetch.ts", sessionId: SID },
    { sandbox, now: () => 1, buildEnv: identityEnv, ...f },
  );
  expect(r.output).toBe("OK");
  rmSync(f.base, { recursive: true, force: true });
});
