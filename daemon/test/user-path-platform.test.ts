import { test, expect } from "bun:test";

test("darwin PATH 源码不提 Windows 注册表 / where", async () => {
  const src = await Bun.file(new URL("../src/user-path-darwin.ts", import.meta.url)).text();
  expect(src).not.toContain("HKCU");
  expect(src).not.toContain("HKLM");
  expect(src).not.toContain("reg query");
  expect(src).not.toContain("where");
  expect(src).not.toContain("PATHEXT");
});

test("win32 PATH 源码不提 login shell", async () => {
  const src = await Bun.file(new URL("../src/user-path-win32.ts", import.meta.url)).text();
  expect(src).not.toContain("echo $PATH");
  expect(src).not.toContain("login");
  expect(src).not.toContain("/bin/zsh");
});

test("darwin update 源码不提 windows 发布物", async () => {
  const src = await Bun.file(new URL("../src/update-darwin.ts", import.meta.url)).text();
  expect(src).not.toContain("win32");
  expect(src).not.toContain("setup.exe");
  expect(src).not.toContain("latest.windows");
});

test("darwin skill 解释器不提 Windows python / .sh 拒绝", async () => {
  const src = await Bun.file(new URL("../src/skill-interpreter-darwin.ts", import.meta.url)).text();
  expect(src).not.toContain("win32");
  expect(src).not.toContain("where.exe");
  expect(src).not.toContain("WindowsApps");
});

test("posix srt 沙箱不拼 cmd.exe 命令串", async () => {
  const src = await Bun.file(new URL("../src/skill-sandbox.ts", import.meta.url)).text();
  expect(src).not.toContain("buildWindowsCommand");
  expect(src).not.toContain("srt-win.exe");
});
