import { test, expect } from "bun:test";
import { homedir } from "os";
import {
  AGENT_CANDIDATES,
  WINDOWS_AGENT_CANDIDATES,
  agentCandidatesFor,
  candidateAppLaunch,
  candidateIsInteractive,
  detectAgents,
} from "../src/agents";
import { DSH_WEB_ARGV, DSH_WEB_ORIGIN } from "../src/handoff-dsh";
import { parseShellPath } from "../src/user-path-darwin";
import {
  parseWherePath,
  isWindowsAppsStub,
  parseRegQueryPath,
  mergeWindowsPath,
} from "../src/user-path-win32";

test("parseShellPath: takes the last line (rc 噪音在前面)", () => {
  const stdout = "Last login: whatever\n/usr/bin:/opt/homebrew/bin\n";
  expect(parseShellPath(stdout, "/fallback")).toBe("/usr/bin:/opt/homebrew/bin");
});

test("parseShellPath: 空输出（shell 挂了/超时）回落 fallback", () => {
  expect(parseShellPath("", "/usr/bin:/bin")).toBe("/usr/bin:/bin");
  expect(parseShellPath("   \n  \n", "/usr/bin:/bin")).toBe("/usr/bin:/bin");
});

test("parseShellPath: 单行正常输出", () => {
  expect(parseShellPath("/a:/b\n", "/fallback")).toBe("/a:/b");
});

test("候选表 10 条，品牌分组、每组 app 在前（= HandoffCard 预选顺序）", () => {
  expect(AGENT_CANDIDATES.map((c) => c.id)).toEqual([
    "claude-app", "claude-terminal",
    "codex-app", "codex-terminal",
    "cursor-app", "cursor-terminal",
    "opencode-terminal", "pi-terminal",
    "dsh-app", "dsh-terminal",
  ]);
});

test("候选表字段齐备：terminal 有 bin；app 有 appPaths 或 bin（DSH Web UI 走同一二进制）", () => {
  for (const c of AGENT_CANDIDATES) {
    if (c.kind === "terminal") expect(c.bin).toBeDefined();
    else expect((c.appPaths?.length ?? 0) > 0 || !!c.bin).toBe(true);
  }
});

test("terminal：有 argv 的必须含 {prompt}；没有 argv 的是仅 headless，且必须有 headlessArgv", () => {
  for (const c of AGENT_CANDIDATES) {
    if (c.kind !== "terminal") continue;
    if (c.argv?.length) {
      expect(c.argv.some((a) => a.includes("{prompt}"))).toBe(true);
    } else {
      expect(c.headlessArgv?.length).toBeGreaterThan(0);
      expect(c.headlessArgv?.some((a) => a.includes("{prompt}"))).toBe(true);
    }
  }
});

test("每条 terminal 候选都有 headlessArgv 且含 {prompt}（run_local_agent 多后端前提）", () => {
  for (const c of AGENT_CANDIDATES) {
    if (c.kind !== "terminal") continue;
    expect(c.headlessArgv?.length).toBeGreaterThan(0);
    expect(c.headlessArgv?.some((a) => a.includes("{prompt}"))).toBe(true);
  }
});

test("app 候选没有 headlessArgv（app 无 CLI，不能作 headless 后端）", () => {
  for (const c of AGENT_CANDIDATES) {
    if (c.kind === "app") expect(c.headlessArgv).toBeUndefined();
  }
});

test("各家 headless 契约（已查实的命令 + 跳权限 flag）", () => {
  const byId = Object.fromEntries(AGENT_CANDIDATES.map((c) => [c.id, c]));
  expect(byId["claude-terminal"].headlessArgv).toEqual(["-p", "--dangerously-skip-permissions", "{prompt}"]);
  expect(byId["codex-terminal"].headlessArgv).toEqual(["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "{prompt}"]);
  expect(byId["cursor-terminal"].headlessArgv).toEqual(["-p", "--force", "{prompt}"]);
  expect(byId["opencode-terminal"].headlessArgv).toEqual(["run", "--auto", "{prompt}"]);
  expect(byId["pi-terminal"].headlessArgv).toEqual(["-p", "{prompt}"]);
  expect(byId["dsh-terminal"].headlessArgv).toEqual(["--profile", "headless", "{prompt}"]);
  expect(byId["dsh-terminal"].argv).toBeUndefined();
});

test("app 候选必须有 convention（无深链或深链回落靠引导文件）；webUi 例外不靠约定文件预填", () => {
  for (const c of [...AGENT_CANDIDATES, ...WINDOWS_AGENT_CANDIDATES]) {
    if (c.kind !== "app") continue;
    if (c.webUi) {
      expect(c.convention).toBeUndefined();
      continue;
    }
    expect(c.convention).toBeDefined();
  }
});

test("每条 app 候选必须有深链（ADR 0013）；webUi 是唯一例外（无 deeplink.template）", () => {
  for (const c of [...AGENT_CANDIDATES, ...WINDOWS_AGENT_CANDIDATES]) {
    if (c.kind !== "app") continue;
    if (c.webUi) {
      expect(c.deeplink).toBeUndefined();
      expect(c.webUi.origin).toBeTruthy();
      expect(c.webUi.argv.length).toBeGreaterThan(0);
      continue;
    }
    expect(c.deeplink?.template, c.id).toBeTruthy();
    expect(c.deeplink!.template).toContain("{prompt}");
    if (!c.deeplink!.afterOpen) expect(c.deeplink!.template).toContain("{dir}");
  }
});

test("candidateIsInteractive：app 与有 argv 的 terminal 为真；仅 headless 的 dsh-terminal 为假", () => {
  const byId = Object.fromEntries(AGENT_CANDIDATES.map((c) => [c.id, c]));
  expect(candidateIsInteractive(byId["dsh-app"])).toBe(true);
  expect(candidateIsInteractive(byId["dsh-terminal"])).toBe(false);
  expect(candidateIsInteractive(byId["claude-terminal"])).toBe(true);
  expect(candidateIsInteractive(byId["claude-app"])).toBe(true);
});

test("dsh 两条 verified:true（mac 真机过），检测靠同一 dsh 二进制，Windows 表不含 DSH", () => {
  const byId = Object.fromEntries(AGENT_CANDIDATES.map((c) => [c.id, c]));
  expect(byId["dsh-app"].verified).toBe(true);
  expect(byId["dsh-terminal"].verified).toBe(true);
  expect(byId["dsh-app"].bin).toBe("dsh");
  expect(byId["dsh-terminal"].bin).toBe("dsh");
  expect(byId["dsh-app"].binPaths).toContain("~/.local/bin/dsh");
  expect(byId["dsh-terminal"].binPaths).toContain("~/.local/bin/dsh");
  expect(byId["dsh-app"].webUi).toEqual({ origin: DSH_WEB_ORIGIN, argv: DSH_WEB_ARGV });
  expect(WINDOWS_AGENT_CANDIDATES.some((c) => c.id.startsWith("dsh-"))).toBe(false);
});

test("candidateAppLaunch：webUi → web，deeplink → deeplink，其余 app → open-a，terminal 不给", () => {
  const byId = Object.fromEntries(AGENT_CANDIDATES.map((c) => [c.id, c]));
  expect(candidateAppLaunch(byId["dsh-app"])).toBe("web");
  expect(candidateAppLaunch(byId["claude-app"])).toBe("deeplink");
  expect(candidateAppLaunch(byId["cursor-app"])).toBe("deeplink");
  expect(candidateAppLaunch(byId["claude-terminal"])).toBeUndefined();
  expect(candidateAppLaunch({ kind: "app" })).toBe("open-a");
});

test("claude-app / codex-app 有目录+预填深链；cursor-app 是打开后再发 prompt 深链", () => {
  const byId = Object.fromEntries(AGENT_CANDIDATES.map((c) => [c.id, c]));
  expect(byId["claude-app"].deeplink?.template).toBe("claude://code/new?q={prompt}&folder={dir}");
  expect(byId["codex-app"].deeplink?.template).toBe("codex://new?prompt={prompt}&path={dir}");
  expect(byId["cursor-app"].deeplink?.template).toBe(
    "cursor://anysphere.cursor-deeplink/prompt?text={prompt}",
  );
  expect(byId["cursor-app"].deeplink?.afterOpen).toBe(true);
});

test("Windows 三家 App 深链与 mac 同构", () => {
  const byId = Object.fromEntries(WINDOWS_AGENT_CANDIDATES.map((c) => [c.id, c]));
  expect(byId["claude-app"].deeplink?.template).toBe("claude://code/new?q={prompt}&folder={dir}");
  expect(byId["codex-app"].deeplink?.template).toBe("codex://new?prompt={prompt}&path={dir}");
  expect(byId["cursor-app"].deeplink?.afterOpen).toBe(true);
});

test("opencode 走 --prompt flag，其余 terminal 走位置参数", () => {
  const byId = Object.fromEntries(AGENT_CANDIDATES.map((c) => [c.id, c]));
  expect(byId["opencode-terminal"].argv).toEqual(["--prompt", "{prompt}"]);
  expect(byId["claude-terminal"].argv).toEqual(["{prompt}"]);
  // 产品拍板（2026-07-14 验收）：交棒到手即跑，代价 = 该 codex 会话无审批无沙箱
  expect(byId["codex-terminal"].argv).toEqual(["--dangerously-bypass-approvals-and-sandbox", "{prompt}"]);
  // 不带 --trust：真机实测交互式 TUI 下报 "--trust can only be used with --print/headless mode"
  expect(byId["cursor-terminal"].argv).toEqual(["{prompt}"]);
  expect(byId["pi-terminal"].argv).toEqual(["{prompt}"]);
  expect(byId["cursor-terminal"].bin).toBe("cursor-agent"); // 注意：不是 "cursor"（那是 IDE 启动器）
});

test("detectAgents 带出绝对路径（terminal = which 解出的，app = 命中的 bundle 路径）", () => {
  const detected = detectAgents({
    which: (bin) => (bin === "codex" ? "/Users/x/.local/bin/codex" : null),
    exists: (p) => p === "/Applications/Claude.app",
  });
  expect(detected.map((a) => a.id)).toEqual(["claude-app", "codex-terminal"]);
  expect(detected.find((a) => a.id === "codex-terminal")!.path).toBe("/Users/x/.local/bin/codex");
  expect(detected.find((a) => a.id === "claude-app")!.path).toBe("/Applications/Claude.app");
});

test("detectAgents returns empty when nothing installed", () => {
  expect(detectAgents({ which: () => null, exists: () => false })).toEqual([]);
});

test("app 候选按 appPaths 优先级探，命中第一个存在的", () => {
  // 只装了 ChatGPT.app（Codex 与 ChatGPT 合并后的常态）
  const detected = detectAgents({
    which: () => null,
    exists: (p) => p === "/Applications/ChatGPT.app",
  });
  const codexApp = detected.find((a) => a.id === "codex-app");
  expect(codexApp?.path).toBe("/Applications/ChatGPT.app");
});

test("两个 app 路径都在时，取表里排第一的", () => {
  const detected = detectAgents({
    which: () => null,
    exists: (p) => p === "/Applications/Codex.app" || p === "/Applications/ChatGPT.app",
  });
  expect(detected.find((a) => a.id === "codex-app")?.path).toBe("/Applications/Codex.app");
});

test("terminal 候选 PATH 找不到时回落 binPaths 知名安装路径（常规安装但 rc 没配 PATH）", () => {
  const home = homedir();
  const detected = detectAgents({
    which: () => null,
    exists: (p) => p === `${home}/.opencode/bin/opencode`,
  });
  const oc = detected.find((a) => a.id === "opencode-terminal");
  expect(oc?.path).toBe(`${home}/.opencode/bin/opencode`);
});

test("PATH 命中优先于 binPaths 回落（用户自装位置说了算）", () => {
  const detected = detectAgents({
    which: (bin) => (bin === "opencode" ? "/custom/bin/opencode" : null),
    exists: () => true,
  });
  expect(detected.find((a) => a.id === "opencode-terminal")?.path).toBe("/custom/bin/opencode");
});

// ---- Windows 检测适配（#364, spec §4.7）----

test("isWindowsAppsStub: WindowsApps 别名 stub 认出（正/反斜杠、大小写不敏感）", () => {
  expect(isWindowsAppsStub("C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe")).toBe(true);
  expect(isWindowsAppsStub("C:/Users/x/AppData/Local/Microsoft/windowsapps/python.exe")).toBe(true);
  expect(isWindowsAppsStub("C:\\Program Files\\nodejs\\claude.cmd")).toBe(false);
});

test("parseWherePath: 取第一个非 WindowsApps stub 的绝对路径", () => {
  const stdout =
    "C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\claude.exe\r\n" +
    "C:\\Program Files\\nodejs\\claude.cmd\r\n";
  expect(parseWherePath(stdout)).toBe("C:\\Program Files\\nodejs\\claude.cmd");
});

test("parseWherePath: 全是 stub → null（视为未装）", () => {
  const stdout = "C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe\r\n";
  expect(parseWherePath(stdout)).toBeNull();
});

test("parseWherePath: 空输出（where exit 1，未装）→ null", () => {
  expect(parseWherePath("")).toBeNull();
  expect(parseWherePath("\r\n  \r\n")).toBeNull();
});

test("parseWherePath: 跳过 .ps1，同组优先 .cmd（npm 全局三件套）", () => {
  const stdout =
    "C:\\Users\\x\\AppData\\Roaming\\npm\\opencode\r\n" +
    "C:\\Users\\x\\AppData\\Roaming\\npm\\opencode.cmd\r\n" +
    "C:\\Users\\x\\AppData\\Roaming\\npm\\opencode.ps1\r\n";
  expect(parseWherePath(stdout)).toBe("C:\\Users\\x\\AppData\\Roaming\\npm\\opencode.cmd");
});

test("parseWherePath: 只有 .ps1 → 视为不可用", () => {
  expect(parseWherePath("C:\\Users\\x\\AppData\\Roaming\\npm\\opencode.ps1\r\n")).toBeNull();
});

test("parseRegQueryPath: 从 reg query 输出取 Path 值（REG_EXPAND_SZ / REG_SZ 都认）", () => {
  const expand =
    "\r\nHKEY_CURRENT_USER\\Environment\r\n" +
    "    Path    REG_EXPAND_SZ    C:\\Users\\x\\bin;C:\\tools\r\n\r\n";
  expect(parseRegQueryPath(expand)).toBe("C:\\Users\\x\\bin;C:\\tools");
  const sz = "    Path    REG_SZ    C:\\Windows;C:\\Windows\\System32\r\n";
  expect(parseRegQueryPath(sz)).toBe("C:\\Windows;C:\\Windows\\System32");
});

test("parseRegQueryPath: 无 Path 值 → 空串", () => {
  expect(parseRegQueryPath("HKEY_CURRENT_USER\\Environment\r\n    TEMP    REG_SZ    C:\\Temp\r\n")).toBe("");
  expect(parseRegQueryPath("")).toBe("");
});

test("mergeWindowsPath: env 打头 + 注册表补充，大小写不敏感去重", () => {
  const merged = mergeWindowsPath("C:\\Windows;C:\\proc-only", [
    "C:\\Users\\x\\bin;C:\\windows", // C:\windows 与 env 的 C:\Windows 大小写重复 → 去掉
    "C:\\tools;;  ;C:\\Users\\x\\bin", // 空段忽略；C:\Users\x\bin 已见 → 去掉
  ]);
  expect(merged).toBe("C:\\Windows;C:\\proc-only;C:\\Users\\x\\bin;C:\\tools");
});

test("mergeWindowsPath: 全空来源 → 空串", () => {
  expect(mergeWindowsPath("", ["", ""])).toBe("");
});

test("agentCandidatesFor: win32 → Windows 表；其余 → mac 表", () => {
  expect(agentCandidatesFor("win32")).toBe(WINDOWS_AGENT_CANDIDATES);
  expect(agentCandidatesFor("darwin")).toBe(AGENT_CANDIDATES);
  expect(agentCandidatesFor("linux")).toBe(AGENT_CANDIDATES);
});

test("Windows 表品牌分组、app 在前；不含 mac 路径", () => {
  expect(WINDOWS_AGENT_CANDIDATES.map((c) => c.id)).toEqual([
    "claude-app",
    "claude-terminal",
    "codex-app",
    "codex-terminal",
    "cursor-app",
    "cursor-terminal",
    "opencode-terminal",
  ]);
  for (const c of WINDOWS_AGENT_CANDIDATES) {
    if (c.kind === "terminal") expect(c.verified).not.toBe(false);
    if (c.kind === "app") {
      expect(c.appPaths?.every((p) => !p.startsWith("/Applications/"))).toBe(true);
      expect(c.appPaths?.every((p) => p.endsWith(".exe"))).toBe(true);
    }
  }
  expect(WINDOWS_AGENT_CANDIDATES.find((c) => c.id === "cursor-app")?.verified).toBe(true);
  expect(WINDOWS_AGENT_CANDIDATES.find((c) => c.id === "codex-app")?.verified).toBe(true);
});

test("detectAgents(win32): where 命中即纳入", () => {
  const detected = detectAgents({
    platform: "win32",
    which: (bin) =>
      bin === "codex" ? "C:\\Users\\x\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe" : null,
    exists: () => false,
  });
  expect(detected.map((a) => a.id)).toEqual(["codex-terminal"]);
  expect(detected[0].path).toBe("C:\\Users\\x\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe");
});

test("detectAgents(win32): where 命中 opencode", () => {
  const detected = detectAgents({
    platform: "win32",
    which: (bin) => (bin === "opencode" ? "C:\\Users\\x\\scoop\\shims\\opencode.exe" : null),
    exists: () => false,
  });
  expect(detected.map((a) => a.id)).toEqual(["opencode-terminal"]);
  expect(detected[0].path).toBe("C:\\Users\\x\\scoop\\shims\\opencode.exe");
});

test("detectAgents(win32): which miss 回落 npm 全局 .cmd（PATHEXT 缺失时 where 会漏）", () => {
  const detected = detectAgents({
    platform: "win32",
    which: () => null,
    exists: (p) => p.replace(/\\/g, "/").endsWith("AppData/Roaming/npm/opencode.cmd"),
  });
  expect(detected.map((a) => a.id)).toEqual(["opencode-terminal"]);
  expect(detected[0].path.replace(/\\/g, "/")).toMatch(/AppData\/Roaming\/npm\/opencode\.cmd$/);
});

test("detectAgents(win32): which miss 回落官方安装器 binPaths", () => {
  const detected = detectAgents({
    platform: "win32",
    which: () => null,
    exists: (p) => p.replace(/\\/g, "/").endsWith("OpenAI/Codex/bin/codex.exe"),
  });
  expect(detected.map((a) => a.id)).toEqual(["codex-terminal"]);
  expect(detected[0].path.replace(/\\/g, "/")).toMatch(/OpenAI\/Codex\/bin\/codex\.exe$/);
});

test("detectAgents(win32, includeUnverified): 仍按 where 解绝对路径", () => {
  const detected = detectAgents({
    platform: "win32",
    includeUnverified: true,
    which: (bin) => (bin === "claude" ? "C:\\Program Files\\nodejs\\claude.cmd" : null),
    exists: () => false,
  });
  expect(detected.map((a) => a.id)).toEqual(["claude-terminal"]);
  expect(detected[0].path).toBe("C:\\Program Files\\nodejs\\claude.cmd");
});

test("detectAgents(darwin): mac 表不受 verified 过滤影响（历史条目无字段 = 已验证）", () => {
  const detected = detectAgents({
    platform: "darwin",
    which: (bin) => (bin === "claude" ? "/Users/x/.local/bin/claude" : null),
    exists: () => false,
  });
  expect(detected.map((a) => a.id)).toContain("claude-terminal");
});

test("detectAgents(darwin): dsh 已 verified，bin 在 PATH 即默认检出", () => {
  const detected = detectAgents({
    platform: "darwin",
    which: (bin) => (bin === "dsh" ? "/Users/x/.local/bin/dsh" : null),
    exists: () => false,
  });
  expect(detected.map((a) => a.id)).toEqual(["dsh-app", "dsh-terminal"]);
});

test("detectAgents: PIE_INCLUDE_UNVERIFIED_AGENTS=1 与 includeUnverified 同效", () => {
  const prev = process.env.PIE_INCLUDE_UNVERIFIED_AGENTS;
  process.env.PIE_INCLUDE_UNVERIFIED_AGENTS = "1";
  try {
    const detected = detectAgents({
      platform: "darwin",
      which: (bin) => (bin === "dsh" ? "/Users/x/.local/bin/dsh" : null),
      exists: () => false,
    });
    expect(detected.map((a) => a.id)).toEqual(["dsh-app", "dsh-terminal"]);
  } finally {
    if (prev === undefined) delete process.env.PIE_INCLUDE_UNVERIFIED_AGENTS;
    else process.env.PIE_INCLUDE_UNVERIFIED_AGENTS = prev;
  }
});

test("detectAgents(darwin, includeUnverified): 同一 dsh bin 同时检出 app + terminal", () => {
  const detected = detectAgents({
    platform: "darwin",
    includeUnverified: true,
    which: (bin) => (bin === "dsh" ? "/Users/x/.local/bin/dsh" : null),
    exists: () => false,
  });
  expect(detected.map((a) => a.id)).toEqual(["dsh-app", "dsh-terminal"]);
  expect(detected[0].path).toBe("/Users/x/.local/bin/dsh");
  expect(detected[1].path).toBe("/Users/x/.local/bin/dsh");
});

test("detectAgents(darwin, includeUnverified): which miss 回落 ~/.local/bin/dsh", () => {
  const home = homedir();
  const detected = detectAgents({
    platform: "darwin",
    includeUnverified: true,
    which: () => null,
    exists: (p) => p === `${home}/.local/bin/dsh`,
  });
  expect(detected.map((a) => a.id)).toEqual(["dsh-app", "dsh-terminal"]);
  expect(detected[0].path).toBe(`${home}/.local/bin/dsh`);
});

test("detectAgents(win32): ~ 展开后的 Cursor.exe 算已装；/Applications/Cursor.app 不算", () => {
  const home = homedir();
  const cursorExe = `${home}/AppData/Local/Programs/cursor/Cursor.exe`;
  const detected = detectAgents({
    platform: "win32",
    includeUnverified: true,
    which: () => null,
    exists: (p) => p === cursorExe || p === "/Applications/Cursor.app",
  });
  expect(detected.find((a) => a.id === "cursor-app")?.path).toBe(cursorExe);
  expect(detected.some((a) => a.path.includes("/Applications/"))).toBe(false);
});

test("detectAgents(win32): 已验证 app 默认纳入；路径 miss 则不出现", () => {
  const home = homedir();
  const cursorExe = `${home}/AppData/Local/Programs/cursor/Cursor.exe`;
  const chatgptExe = `${home}/AppData/Local/Programs/ChatGPT/ChatGPT.exe`;
  const exists = (p: string) => p === cursorExe || p === chatgptExe;
  const shown = detectAgents({ platform: "win32", which: () => null, exists });
  expect(shown.map((a) => a.id)).toEqual(["codex-app", "cursor-app"]);

  const none = detectAgents({ platform: "win32", which: () => null, exists: () => false });
  expect(none.map((a) => a.id)).not.toContain("cursor-app");
  expect(none.map((a) => a.id)).not.toContain("codex-app");
});
