import { test, expect } from "bun:test";
import { detectDarwinAgents } from "../src/detect-darwin";
import { detectWindowsAgents } from "../src/detect-win32";
import type { AgentCandidate } from "../src/agents";

const mixed: AgentCandidate = {
  id: "cursor-app",
  label: "Cursor (App)",
  kind: "app",
  uninstallNames: ["Cursor"],
  uninstallExes: ["Cursor.exe"],
  appxPackagePrefix: "Anysphere.Cursor",
  appxRelExes: ["Cursor.exe"],
  appPaths: ["/Applications/Cursor.app"],
  convention: "AGENTS.md",
};

test("darwin 检测只认 appPaths，忽略 uninstall / appx", () => {
  const found = detectDarwinAgents(
    [mixed],
    (p) => p === "/Applications/Cursor.app",
    () => null,
  );
  expect(found).toHaveLength(1);
  expect(found[0].path).toBe("/Applications/Cursor.app");
});

test("win32 检测不认 /Applications，只走 uninstall / appx / win appPaths", () => {
  const none = detectWindowsAgents(
    [mixed],
    (p) => p === "/Applications/Cursor.app",
    () => null,
    [],
    [],
  );
  expect(none).toHaveLength(0);

  const viaReg = detectWindowsAgents(
    [mixed],
    (p) => p === "C:\\Program Files\\cursor\\Cursor.exe",
    () => null,
    [
      {
        displayName: "Cursor",
        installLocation: "C:\\Program Files\\cursor\\",
        displayIcon: "C:\\Program Files\\cursor\\Cursor.exe",
      },
    ],
    [],
  );
  expect(viaReg[0]?.path).toBe("C:\\Program Files\\cursor\\Cursor.exe");
});
