import { test, expect } from "bun:test";
import { parseRegKeyLines, parseRegSzValue, resolveAppxApp } from "../src/windows-appx";
import { detectAgents } from "../src/agents";

test("parseRegKeyLines: 只收 HKEY_ 行", () => {
  const stdout = [
    "HKEY_CURRENT_USER\\...\\Packages\\OpenAI.Codex_26.810.6296.0_arm64__2p2nqsd0c76g0",
    "找到 1 匹配。",
  ].join("\r\n");
  expect(parseRegKeyLines(stdout)).toEqual([
    "HKEY_CURRENT_USER\\...\\Packages\\OpenAI.Codex_26.810.6296.0_arm64__2p2nqsd0c76g0",
  ]);
});

test("parseRegSzValue: PackageRootFolder", () => {
  const stdout =
    "    PackageRootFolder    REG_SZ    C:\\Program Files\\WindowsApps\\OpenAI.Codex_1\r\n";
  expect(parseRegSzValue(stdout, "PackageRootFolder")).toBe(
    "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1",
  );
});

test("resolveAppxApp: 前缀匹配 + rel exe", () => {
  const exe =
    "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.810.6296.0_arm64__2p2nqsd0c76g0\\app\\ChatGPT.exe";
  const path = resolveAppxApp(
    [
      {
        id: "OpenAI.Codex_26.810.6296.0_arm64__2p2nqsd0c76g0",
        root: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.810.6296.0_arm64__2p2nqsd0c76g0",
      },
    ],
    "OpenAI.Codex",
    ["app\\ChatGPT.exe", "app\\Codex.exe"],
    (p) => p === exe,
  );
  expect(path).toBe(exe);
});

test("resolveAppxApp: 前缀对不上则空", () => {
  expect(
    resolveAppxApp(
      [{ id: "Anysphere.Cursor_1", root: "C:\\x" }],
      "OpenAI.Codex",
      ["app\\ChatGPT.exe"],
      () => true,
    ),
  ).toBeNull();
});

test("detectAgents(win32): Appx 命中 Store ChatGPT.exe", () => {
  const exe =
    "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.810.6296.0_arm64__2p2nqsd0c76g0\\app\\ChatGPT.exe";
  const detected = detectAgents({
    platform: "win32",
    includeUnverified: true,
    which: () => null,
    exists: (p) => p === exe,
    uninstall: [],
    appx: [
      {
        id: "OpenAI.Codex_26.810.6296.0_arm64__2p2nqsd0c76g0",
        root: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.810.6296.0_arm64__2p2nqsd0c76g0",
      },
    ],
  });
  expect(detected.find((a) => a.id === "codex-app")?.path).toBe(exe);
});
