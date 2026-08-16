import { test, expect } from "bun:test";
import { homedir } from "os";
import {
  normalizeDisplayIcon,
  isRejectedWinAppPath,
  exeFromUninstallEntry,
  resolveUninstallApp,
  parseRegQueryDump,
} from "../src/windows-uninstall";
import { detectAgents } from "../src/agents";

test("normalizeDisplayIcon: 剥引号和 icon index", () => {
  expect(normalizeDisplayIcon(`"C:\\Program Files\\cursor\\Cursor.exe",0`)).toBe(
    "C:\\Program Files\\cursor\\Cursor.exe",
  );
  expect(normalizeDisplayIcon("C:\\p\\Cursor.exe")).toBe("C:\\p\\Cursor.exe");
});

test("isRejectedWinAppPath: Parallels / WindowsApps 拒", () => {
  expect(isRejectedWinAppPath("C:\\Mac\\Home\\Applications\\Cursor.app")).toBe(true);
  expect(isRejectedWinAppPath("\\\\Mac\\Home\\Cursor.exe")).toBe(true);
  expect(isRejectedWinAppPath("C:\\Program Files\\WindowsApps\\OpenAI.Codex_1\\app\\ChatGPT.exe")).toBe(
    true,
  );
  expect(isRejectedWinAppPath("C:\\Program Files\\cursor\\Cursor.exe")).toBe(false);
});

test("exeFromUninstallEntry: DisplayIcon 优先", () => {
  const p = exeFromUninstallEntry(
    {
      displayName: "Cursor",
      installLocation: "C:\\Program Files\\cursor\\",
      displayIcon: "C:\\Program Files\\cursor\\Cursor.exe,0",
    },
    ["Cursor.exe"],
  );
  expect(p).toBe("C:\\Program Files\\cursor\\Cursor.exe");
});

test("exeFromUninstallEntry: 无 Icon 则 InstallLocation + exe", () => {
  const p = exeFromUninstallEntry(
    { displayName: "Cursor", installLocation: "C:\\Program Files\\cursor\\", displayIcon: "" },
    ["Cursor.exe"],
  );
  expect(p).toBe("C:\\Program Files\\cursor\\Cursor.exe");
});

test("resolveUninstallApp: DisplayName 精确匹配，Cursor (Mac) 不算", () => {
  const entries = [
    {
      displayName: "Cursor (Mac)",
      installLocation: "C:\\Mac\\Home\\Applications",
      displayIcon: "C:\\Mac\\Home\\Applications\\Cursor.app",
    },
    {
      displayName: "Cursor",
      installLocation: "C:\\Program Files\\cursor\\",
      displayIcon: "C:\\Program Files\\cursor\\Cursor.exe",
    },
  ];
  const exists = (p: string) => p === "C:\\Program Files\\cursor\\Cursor.exe";
  expect(resolveUninstallApp(entries, ["Cursor"], ["Cursor.exe"], exists)).toBe(
    "C:\\Program Files\\cursor\\Cursor.exe",
  );
});

test("parseRegQueryDump: 多 key 块", () => {
  const dump = [
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{guid}_is1",
    "    DisplayName    REG_SZ    Cursor",
    "    InstallLocation    REG_SZ    C:\\Program Files\\cursor\\",
    "    DisplayIcon    REG_SZ    C:\\Program Files\\cursor\\Cursor.exe",
    "",
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Other",
    "    DisplayName    REG_SZ    Other App",
  ].join("\r\n");
  const entries = parseRegQueryDump(dump);
  expect(entries).toEqual([
    {
      displayName: "Cursor",
      installLocation: "C:\\Program Files\\cursor\\",
      displayIcon: "C:\\Program Files\\cursor\\Cursor.exe",
    },
    { displayName: "Other App", installLocation: "", displayIcon: "" },
  ]);
});

test("detectAgents(win32): Uninstall 命中 Program Files，覆盖 appPaths miss", () => {
  const detected = detectAgents({
    platform: "win32",
    includeUnverified: true,
    which: () => null,
    exists: (p) => p === "C:\\Program Files\\cursor\\Cursor.exe",
    uninstall: [
      {
        displayName: "Cursor",
        installLocation: "C:\\Program Files\\cursor\\",
        displayIcon: "C:\\Program Files\\cursor\\Cursor.exe",
      },
    ],
  });
  expect(detected.find((a) => a.id === "cursor-app")?.path).toBe(
    "C:\\Program Files\\cursor\\Cursor.exe",
  );
});

test("detectAgents(win32): 无 Uninstall 时回落 appPaths", () => {
  const cursorExe = `${homedir()}/AppData/Local/Programs/cursor/Cursor.exe`;
  const detected = detectAgents({
    platform: "win32",
    includeUnverified: true,
    which: () => null,
    exists: (p) => p === cursorExe,
    uninstall: [],
  });
  expect(detected.find((a) => a.id === "cursor-app")?.path).toBe(cursorExe);
});
