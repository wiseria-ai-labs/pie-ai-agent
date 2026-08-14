import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, utimesSync } from "fs";
import { join } from "path";
import { runSkillScript, scanOutputs, buildSandboxEnv, ENV_ALLOWLIST_VERSION } from "../src/skill-exec";
import { fakeSkillSandbox } from "../src/skill-sandbox";
import type { SandboxSettings } from "../src/skill-sandbox";
import type { SkillExecDeps } from "../src/skill-exec";
import { setLogEnabled } from "../src/log";

setLogEnabled(false);

// 固定 UUID 形状 sessionId（assertSessionId 要求）。
const SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

// 测试注入的 env 构建：跳过 buildSandboxEnv 的 login-shell PATH 探测（会 spawn 真 shell，
// 慢且不确定），只把调用方注入的 extra（PIE_*/BUN_BE_BUN）原样透出——env 白名单擦除
// 本身在下面的 buildSandboxEnv 纯函数用例里单测。
const identityEnv: SkillExecDeps["buildEnv"] = (extra) => ({ ...extra });

function fixture() {
  const base = join(import.meta.dir, ".tmp-exec-" + Math.random().toString(36).slice(2));
  const skillsRoot = join(base, "skills");
  const sessionsDir = join(base, "sessions");
  const dir = join(skillsRoot, "web-fetch");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    // metadata.pie 存在也不再被解析（ADR 0007）——沙箱是固定基线，与声明无关。
    `---\nname: web-fetch\ndescription: d\nmetadata:\n  pie:\n    network: [example.com]\n    write: [~/out]\n---\nb\n`,
  );
  writeFileSync(join(dir, "scripts", "fetch.ts"), "export default () => 1;");
  return { base, skillsRoot, sessionsDir, auditPath: join(base, "audit.jsonl") };
}

// ADR 0007：无授权判定——runSkillScript 收到即执行（确认在扩展 SW 层，daemon 前）。
test("runs directly with fixed-baseline sandbox settings; returns stdout", async () => {
  const f = fixture();
  let seen: SandboxSettings | undefined;
  let seenCwd: string | undefined;
  let seenEnv: Record<string, string> | undefined;
  const sandbox = fakeSkillSandbox(async (_argv, cwd, env, settings) => {
    seen = settings;
    seenCwd = cwd;
    seenEnv = env;
    return { stdout: "RESULT", stderr: "", exitCode: 0, timedOut: false, truncated: false };
  });
  const r = await runSkillScript(
    { name: "web-fetch", entry: "fetch.ts", sessionId: SID },
    { sandbox, now: () => 1, buildEnv: identityEnv, ...f },
  );
  expect(r.output).toBe("RESULT");
  // 固定基线：无 allowedDomains 维度（网络全放走 sandbox 内 ask 回调，不经 settings）。
  expect("allowedDomains" in (seen as object)).toBe(false);
  // 可写区 = 仅 session workspace（迁出 skill 目录，按 session 隔离）；不含声明的 ~/out。
  expect(seen!.allowWrite.some((w) => w.endsWith(join(SID, "workspace")))).toBe(true);
  expect(seen!.allowWrite.some((w) => w.endsWith("/web-fetch/workspace"))).toBe(false);
  expect(seen!.allowWrite.some((w) => w.endsWith("/out"))).toBe(false);
  expect(seen!.denyRead.some((d) => d.endsWith("/.ssh"))).toBe(true);
  // cwd = workspace；env 注入 PIE_SKILL_DIR / PIE_WORKSPACE / BUN_BE_BUN
  expect(seenCwd!.endsWith(join(SID, "workspace"))).toBe(true);
  expect(seenEnv!.PIE_WORKSPACE).toBe(seenCwd!);
  expect(seenEnv!.PIE_SKILL_DIR!.endsWith("/web-fetch")).toBe(true);
  expect(seenEnv!.BUN_BE_BUN).toBe("1");
  rmSync(f.base, { recursive: true, force: true });
});

test("no authorization gate — never throws needs_authorization", async () => {
  const f = fixture();
  let runs = 0;
  const sandbox = fakeSkillSandbox(async () => {
    runs++;
    return { stdout: "x", stderr: "", exitCode: 0, timedOut: false, truncated: false };
  });
  // 连跑两次都直接执行（无「首跑弹卡」概念了）。
  await runSkillScript({ name: "web-fetch", entry: "fetch.ts", sessionId: SID }, { sandbox, now: () => 1, buildEnv: identityEnv, ...f });
  const r = await runSkillScript({ name: "web-fetch", entry: "fetch.ts", sessionId: SID }, { sandbox, now: () => 2, buildEnv: identityEnv, ...f });
  expect(r.output).toBe("x");
  expect(runs).toBe(2);
  rmSync(f.base, { recursive: true, force: true });
});

test("audit records the fixed sandbox baseline summary", async () => {
  const f = fixture();
  const sandbox = fakeSkillSandbox(async () => ({ stdout: "ok", stderr: "", exitCode: 0, timedOut: false, truncated: false }));
  await runSkillScript({ name: "web-fetch", entry: "fetch.ts", sessionId: SID }, { sandbox, now: () => 5, buildEnv: identityEnv, ...f });
  const audit = JSON.parse((await Bun.file(f.auditPath).text()).trim());
  expect(audit.sandbox).toEqual({ network: "open", envAllowlist: ENV_ALLOWLIST_VERSION });
  expect("envelope" in audit).toBe(false);
  rmSync(f.base, { recursive: true, force: true });
});

test("entry not in scripts/ → unknown_entry", async () => {
  const f = fixture();
  const sandbox = fakeSkillSandbox(async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false }));
  await expect(
    runSkillScript({ name: "web-fetch", entry: "../../etc/passwd", sessionId: SID }, { sandbox, now: () => 1, buildEnv: identityEnv, ...f }),
  ).rejects.toMatchObject({ code: "unknown_entry" });
  rmSync(f.base, { recursive: true, force: true });
});

test("script non-zero exit → script_error with stderr tail", async () => {
  const f = fixture();
  const sandbox = fakeSkillSandbox(async () => ({ stdout: "", stderr: "boom", exitCode: 2, timedOut: false, truncated: false }));
  await expect(
    runSkillScript({ name: "web-fetch", entry: "fetch.ts", sessionId: SID }, { sandbox, now: () => 1, buildEnv: identityEnv, ...f }),
  ).rejects.toMatchObject({ code: "script_error" });
  rmSync(f.base, { recursive: true, force: true });
});

// ── env 白名单擦除（D7）─────────────────────────────────────────────────────
test("buildSandboxEnv: only whitelisted keys pass through; secrets are erased", () => {
  const env = buildSandboxEnv(
    { BUN_BE_BUN: "1", PIE_SKILL_DIR: "/s", PIE_WORKSPACE: "/w" },
    {
      path: "/opt/homebrew/bin:/usr/bin",
      env: {
        HOME: "/home/u",
        TMPDIR: "/tmp",
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        USER: "u",
        SHELL: "/bin/zsh",
        // 以下必须被擦除
        AWS_SECRET_ACCESS_KEY: "shhh",
        GITHUB_TOKEN: "ghp_x",
        OPENAI_API_KEY: "sk-x",
        PATH: "/should/be/overridden/by/login-shell",
      },
    },
  );
  // login-shell PATH 覆盖了继承的 PATH
  expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
  // 白名单键放行
  expect(env.HOME).toBe("/home/u");
  expect(env.TMPDIR).toBe("/tmp");
  expect(env.LANG).toBe("en_US.UTF-8");
  expect(env.LC_ALL).toBe("en_US.UTF-8");
  expect(env.USER).toBe("u");
  expect(env.SHELL).toBe("/bin/zsh");
  // 注入的 extra 放行
  expect(env.BUN_BE_BUN).toBe("1");
  expect(env.PIE_SKILL_DIR).toBe("/s");
  expect(env.PIE_WORKSPACE).toBe("/w");
  // 凭据全擦
  expect("AWS_SECRET_ACCESS_KEY" in env).toBe(false);
  expect("GITHUB_TOKEN" in env).toBe(false);
  expect("OPENAI_API_KEY" in env).toBe(false);
});

test("buildSandboxEnv: extra overrides collide-named whitelist keys", () => {
  const env = buildSandboxEnv({ HOME: "/injected" }, { path: "/usr/bin", env: { HOME: "/real" } });
  expect(env.HOME).toBe("/injected");
});

// ── 副根污染修复（spec §1.2 / I1）：跑副根 skill 脚本 → 副根目录零写入 ──────────
test("secondary-root skill run → zero writes into the secondary skill dir", async () => {
  const base = join(import.meta.dir, ".tmp-sec-" + Math.random().toString(36).slice(2));
  const primary = join(base, "pie-skills"); // 空主根
  const secondary = join(base, "agents-skills");
  const sessionsDir = join(base, "sessions");
  const skillDir = join(secondary, "web-fetch");
  mkdirSync(join(skillDir, "scripts"), { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: web-fetch\ndescription: d\n---\nb\n`);
  writeFileSync(join(skillDir, "scripts", "fetch.ts"), "export default () => 1;");
  const before = readdirSync(skillDir).sort();

  // 沙箱模拟脚本往 cwd（= workspace）写文件；若 cwd 仍是 skillDir，副根会被污染。
  const sandbox = fakeSkillSandbox(async (_argv, cwd) => {
    writeFileSync(join(cwd, "out.csv"), "x");
    return { stdout: "ok", stderr: "", exitCode: 0, timedOut: false, truncated: false };
  });
  await runSkillScript(
    { name: "web-fetch", entry: "fetch.ts", sessionId: SID },
    { sandbox, now: () => 1, buildEnv: identityEnv, roots: { primary, secondary }, sessionsDir, auditPath: join(base, "a.jsonl") },
  );

  // 副根 skill 目录内容完全不变；尤其没有 workspace/
  expect(readdirSync(skillDir).sort()).toEqual(before);
  expect(existsSync(join(skillDir, "workspace"))).toBe(false);
  // 产物落在 session workspace
  expect(existsSync(join(sessionsDir, SID, "workspace", "out.csv"))).toBe(true);
  rmSync(base, { recursive: true, force: true });
});

// ── outputs 清单（spec D5 / T2.3）────────────────────────────────────────────
test("run returns outputs manifest for files written this run", async () => {
  const f = fixture();
  const sandbox = fakeSkillSandbox(async (_argv, cwd) => {
    writeFileSync(join(cwd, "out.csv"), "hello"); // 5 bytes
    mkdirSync(join(cwd, "sub"), { recursive: true });
    writeFileSync(join(cwd, "sub", "raw.json"), "{}"); // 2 bytes
    return { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false };
  });
  const r = await runSkillScript(
    { name: "web-fetch", entry: "fetch.ts", sessionId: SID },
    { sandbox, now: () => 1, buildEnv: identityEnv, ...f },
  );
  const byPath = Object.fromEntries((r.outputs ?? []).map((o) => [o.path, o.bytes]));
  expect(byPath["out.csv"]).toBe(5);
  expect(byPath[join("sub", "raw.json")]).toBe(2);
  expect(r.outputsTruncated).toBeUndefined();
  rmSync(f.base, { recursive: true, force: true });
});

test("scanOutputs: mtime filter lists only files touched this run", () => {
  const base = join(import.meta.dir, ".tmp-scan-" + Math.random().toString(36).slice(2));
  const ws = join(base, "workspace");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "old.txt"), "old");
  writeFileSync(join(ws, "new.txt"), "new");
  // old.txt 的 mtime 回拨到 1000s；startedAt=2000_000ms 介于两者之间。
  utimesSync(join(ws, "old.txt"), 1000, 1000);
  const { outputs, truncated } = scanOutputs(ws, 2_000_000);
  expect(outputs.map((o) => o.path)).toEqual(["new.txt"]);
  expect(truncated).toBe(false);
  rmSync(base, { recursive: true, force: true });
});

test("scanOutputs: caps at 50 files and sets truncated", () => {
  const base = join(import.meta.dir, ".tmp-cap-" + Math.random().toString(36).slice(2));
  const ws = join(base, "workspace");
  mkdirSync(ws, { recursive: true });
  for (let i = 0; i < 60; i++) writeFileSync(join(ws, `f${i}.txt`), "x");
  const { outputs, truncated } = scanOutputs(ws, 0);
  expect(outputs).toHaveLength(50);
  expect(truncated).toBe(true);
  rmSync(base, { recursive: true, force: true });
});

test("scanOutputs: missing workspace → empty, not throw", () => {
  const { outputs, truncated } = scanOutputs(join(import.meta.dir, "does-not-exist-xyz"), 0);
  expect(outputs).toEqual([]);
  expect(truncated).toBe(false);
});
