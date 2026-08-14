import { test, expect } from "bun:test";
import {
  fakeSkillSandbox,
  buildSpawnEnv,
  selectSkillSandbox,
  passthroughSkillSandbox,
  realSkillSandbox,
} from "../src/skill-sandbox";
import type { SandboxSettings } from "../src/skill-sandbox";

// 只测接口契约 + fakeSkillSandbox。真 OS 强制（写限/敏感读拒/断网/按域名放行）走
// 真机清单（scratch-skill-sandbox-realmachine.ts / spike 决策记录），CI 碰不到 sandbox-exec。

test("fakeSkillSandbox forwards args to impl and returns its result", async () => {
  const seen: { argv: string[]; cwd: string; env: Record<string, string>; settings: SandboxSettings }[] = [];
  const sb = fakeSkillSandbox(async (argv, cwd, env, settings) => {
    seen.push({ argv, cwd, env, settings });
    return { stdout: "ok", stderr: "", exitCode: 0, timedOut: false, truncated: false };
  });
  const r = await sb.run(
    ["node", "x.js"],
    "/tmp/skill",
    { A: "1" },
    { allowWrite: ["/tmp/skill/workspace"], denyRead: ["/Users/me/.ssh"] },
  );
  expect(r.stdout).toBe("ok");
  expect(r.exitCode).toBe(0);
  expect(seen).toHaveLength(1);
  expect(seen[0].argv).toEqual(["node", "x.js"]);
  expect(seen[0].cwd).toBe("/tmp/skill");
  expect(seen[0].settings.allowWrite).toEqual(["/tmp/skill/workspace"]);
});

// D7 env 白名单擦除 —— spawn 层判定（PR #19 真机验收 FAIL 的回归防线）。
// 直接测 buildSpawnEnv（runViaSrt 里真正决定 Bun.spawn env 的那步），不被 fakeSkillSandbox 短路。
// 背景坑：srt 0.0.67 在 mac/linux 返回的 wrapped.env 就是全量 process.env，若展开进 spawn env，
// 白名单会被整个 process.env 覆盖回去，各类 token/凭据在网络全放沙箱里外泄。

test("buildSpawnEnv (mac/linux) uses ONLY the whitelist — process.env / wrapped.env sentinels never leak", () => {
  const whitelist = { PATH: "/usr/bin", HOME: "/home/me", PIE_WORKSPACE: "/ws" };
  // wrapped.env 在 mac/linux 就是全量 process.env（含哨兵），必须被丢弃。
  const procEnv = {
    PATH: "/host/bin",
    AWS_SECRET_ACCESS_KEY: "leak-canary",
    GITHUB_TOKEN: "leak-canary",
    OPENAI_API_KEY: "leak-canary",
    PIE_EVAL_API_KEY: "leak-canary",
  };
  const wrappedEnv = { ...procEnv };

  const env = buildSpawnEnv(false, whitelist, procEnv, wrappedEnv);

  // 白名单原样、且被完整保留（PATH 用白名单值，不被 process.env 覆盖）。
  expect(env).toEqual(whitelist);
  expect(env.PATH).toBe("/usr/bin");
  // 哨兵一个都不能出现。
  expect("AWS_SECRET_ACCESS_KEY" in env).toBe(false);
  expect("GITHUB_TOKEN" in env).toBe(false);
  expect("OPENAI_API_KEY" in env).toBe(false);
  expect("PIE_EVAL_API_KEY" in env).toBe(false);
});

test("buildSpawnEnv (win32) keeps process.env + wrapped.env for the broker (srt-win proxy/CA config)", () => {
  const whitelist = { PATH: "C:\\pie", PIE_WORKSPACE: "C:\\ws" };
  const procEnv = { PATH: "C:\\host", SOME_HOST_VAR: "keep" };
  // win32 的 wrapped.env 是 srt-win 生成的代理/CA 配置，broker 进程需要它。
  const wrappedEnv = { HTTP_PROXY: "http://127.0.0.1:9", NODE_EXTRA_CA_CERTS: "C:\\ca.pem" };

  const env = buildSpawnEnv(true, whitelist, procEnv, wrappedEnv);

  // broker env = process.env 叠加 wrapped.env（沙箱子进程 env 另经 cmd 内联 set 链，不看这里）。
  expect(env.SOME_HOST_VAR).toBe("keep");
  expect(env.HTTP_PROXY).toBe("http://127.0.0.1:9");
  expect(env.NODE_EXTRA_CA_CERTS).toBe("C:\\ca.pem");
});

// 平台后端选择：Windows 放弃 srt 改 passthrough（无沙箱 + 风险披露），mac/linux 保留 srt。
test("selectSkillSandbox: win32 → passthrough, others → srt", () => {
  expect(selectSkillSandbox("win32")).toBe(passthroughSkillSandbox);
  expect(selectSkillSandbox("darwin")).toBe(realSkillSandbox);
  expect(selectSkillSandbox("linux")).toBe(realSkillSandbox);
});

// passthrough 真跑一个进程、捕获 stdout + exitCode（无沙箱，直 spawn）。
test("passthroughSkillSandbox actually spawns and captures stdout", async () => {
  const r = await passthroughSkillSandbox.run(
    [process.execPath, "-e", "console.log('PASSTHROUGH_OK')"],
    process.cwd(),
    {},
    { allowWrite: [], allowedDomains: [], denyRead: [] },
  );
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain("PASSTHROUGH_OK");
  expect(r.timedOut).toBe(false);
});

// passthrough 非零退出如实透传（skill-exec 据此报 script_error）。
test("passthroughSkillSandbox surfaces non-zero exit + stderr", async () => {
  const r = await passthroughSkillSandbox.run(
    [process.execPath, "-e", "console.error('boom'); process.exit(3)"],
    process.cwd(),
    {},
    { allowWrite: [], allowedDomains: [], denyRead: [] },
  );
  expect(r.exitCode).toBe(3);
  expect(r.stderr).toContain("boom");
});
