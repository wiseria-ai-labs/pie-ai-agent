import { test, expect } from "bun:test";
import { homedir } from "os";
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

test("darwin app 也可以走 bin / binPaths（DSH Web UI 不是 .app bundle）", () => {
  const dshApp: AgentCandidate = {
    id: "dsh-app",
    label: "DeepSeek Harness (App)",
    kind: "app",
    bin: "dsh",
    binPaths: ["~/.local/bin/dsh"],
    verified: false,
  };
  const viaWhich = detectDarwinAgents([dshApp], () => false, (bin) =>
    bin === "dsh" ? "/opt/dsh/dsh" : null,
  );
  expect(viaWhich[0]?.path).toBe("/opt/dsh/dsh");

  const homeBin = `${homedir()}/.local/bin/dsh`;
  const viaBinPath = detectDarwinAgents(
    [dshApp],
    (p) => p === homeBin,
    () => null,
  );
  expect(viaBinPath[0]?.path).toBe(homeBin);
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

test("win32 app 无 appPaths 走 bin / binPaths 回落（DSH Web UI 无安装包、无注册表项）", () => {
  const dsh = {
    id: "dsh-app", label: "DeepSeek Harness (App)", kind: "app" as const,
    bin: "dsh", binPaths: ["~/AppData/Roaming/npm/dsh.cmd"],
    webUi: { origin: "http://127.0.0.1:3080", argv: ["web"] as const },
  };
  expect(detectWindowsAgents([dsh], () => false, () => null, [], [])).toHaveLength(0);
  const viaWhere = detectWindowsAgents(
    [dsh], () => false,
    (bin) => (bin === "dsh" ? "C:\\Users\\x\\AppData\\Roaming\\npm\\dsh.cmd" : null),
    [], [],
  );
  expect(viaWhere.map((a) => a.path)).toEqual(["C:\\Users\\x\\AppData\\Roaming\\npm\\dsh.cmd"]);
  const viaBinPath = detectWindowsAgents(
    [dsh], (p) => p.endsWith("AppData/Roaming/npm/dsh.cmd"), () => null, [], [],
  );
  expect(viaBinPath).toHaveLength(1);
  expect(viaBinPath[0].id).toBe("dsh-app");
});
