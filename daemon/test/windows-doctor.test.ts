import { test, expect, describe } from "bun:test";
import {
  parseRegQueryDefault,
  parseMappedDrives,
  classifyInstallPath,
  checkNmManifest,
  runWindowsDoctor,
  NM_HOST_NAME,
  EXPECTED_ORIGIN,
  EXT_ID,
  type WindowsDoctorDeps,
} from "../src/windows-doctor";

describe("parseRegQueryDefault", () => {
  test("extracts the (Default) REG_SZ value", () => {
    const out = [
      "",
      `HKEY_LOCAL_MACHINE\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NM_HOST_NAME}`,
      "    (Default)    REG_SZ    C:\\Program Files\\Pie Link\\ai.wiseria.pie.json",
      "",
    ].join("\r\n");
    expect(parseRegQueryDefault(out)).toBe("C:\\Program Files\\Pie Link\\ai.wiseria.pie.json");
  });

  test("accepts REG_EXPAND_SZ", () => {
    const out = "    (Default)    REG_EXPAND_SZ    %LOCALAPPDATA%\\PieLink\\ai.wiseria.pie.json";
    expect(parseRegQueryDefault(out)).toBe("%LOCALAPPDATA%\\PieLink\\ai.wiseria.pie.json");
  });

  test("returns null when the key/value is absent", () => {
    // reg.exe prints the error to stderr; stdout has no (Default) line.
    expect(parseRegQueryDefault("ERROR: The system was unable to find the specified registry key")).toBeNull();
    expect(parseRegQueryDefault("")).toBeNull();
  });
});

describe("parseMappedDrives", () => {
  test("captures connected network drive letters", () => {
    const out = [
      "New connections will be remembered.",
      "",
      "Status       Local     Remote                    Network",
      "-------------------------------------------------------------------------------",
      "OK           Z:        \\\\server\\share           Microsoft Windows Network",
      "OK           Y:        \\\\nas\\media              Microsoft Windows Network",
      "The command completed successfully.",
    ].join("\r\n");
    const drives = parseMappedDrives(out);
    expect(drives.has("Z")).toBe(true);
    expect(drives.has("Y")).toBe(true);
    expect(drives.size).toBe(2);
  });

  test("empty when there are no mapped drives", () => {
    expect(parseMappedDrives("There are no entries in the list.").size).toBe(0);
  });
});

describe("classifyInstallPath (F5)", () => {
  test("local Program Files is not a network path", () => {
    const v = classifyInstallPath("C:\\Program Files\\Pie Link\\pie.exe");
    expect(v.isNetwork).toBe(false);
  });

  test("UNC path flagged", () => {
    const v = classifyInstallPath("\\\\server\\share\\Pie Link\\pie.exe");
    expect(v.isNetwork).toBe(true);
    expect(v.reason).toContain("UNC");
  });

  test("Parallels C:\\Mac redirect flagged", () => {
    const v = classifyInstallPath("C:\\Mac\\Home\\Desktop\\pie.exe");
    expect(v.isNetwork).toBe(true);
    expect(v.reason).toContain("Parallels");
  });

  test("\\\\Mac share flagged as Parallels", () => {
    const v = classifyInstallPath("\\\\Mac\\Home\\pie.exe");
    expect(v.isNetwork).toBe(true);
    expect(v.reason).toContain("Parallels");
  });

  test("mapped network drive flagged", () => {
    const v = classifyInstallPath("Z:\\Pie Link\\pie.exe", new Set(["Z"]));
    expect(v.isNetwork).toBe(true);
    expect(v.reason).toContain("Z:");
  });

  test("local drive not in the mapped set is fine", () => {
    const v = classifyInstallPath("D:\\Pie Link\\pie.exe", new Set(["Z"]));
    expect(v.isNetwork).toBe(false);
  });

  test("local device-namespace path is not network", () => {
    const v = classifyInstallPath("\\\\?\\C:\\Program Files\\Pie Link\\pie.exe");
    expect(v.isNetwork).toBe(false);
  });

  test("device-namespace-wrapped UNC is network", () => {
    const v = classifyInstallPath("\\\\?\\UNC\\server\\share\\pie.exe");
    expect(v.isNetwork).toBe(true);
  });
});

describe("checkNmManifest", () => {
  const goodJson = JSON.stringify({
    name: NM_HOST_NAME,
    path: "C:\\Program Files\\Pie Link\\pie-host.bat",
    type: "stdio",
    allowed_origins: [EXPECTED_ORIGIN],
  });

  test("valid manifest passes all sub-checks", () => {
    const v = checkNmManifest("C:\\app\\ai.wiseria.pie.json", {
      fileExists: () => true,
      readFile: () => goodJson,
    });
    expect(v.jsonExists).toBe(true);
    expect(v.hostPathExists).toBe(true);
    expect(v.hasExpectedOrigin).toBe(true);
    expect(v.parseError).toBeUndefined();
  });

  test("missing json reported", () => {
    const v = checkNmManifest("C:\\gone.json", { fileExists: () => false, readFile: () => "" });
    expect(v.jsonExists).toBe(false);
  });

  test("invalid json reported", () => {
    const v = checkNmManifest("C:\\bad.json", { fileExists: () => true, readFile: () => "{not json" });
    expect(v.jsonExists).toBe(true);
    expect(v.parseError).toBeDefined();
  });

  test("missing host wrapper detected", () => {
    const v = checkNmManifest("C:\\app\\m.json", {
      // json exists, but the host wrapper path does not.
      fileExists: (p) => p.endsWith("m.json"),
      readFile: () => goodJson,
    });
    expect(v.hostPathExists).toBe(false);
  });

  test("wrong allowed_origins detected", () => {
    const v = checkNmManifest("C:\\app\\m.json", {
      fileExists: () => true,
      readFile: () =>
        JSON.stringify({ path: "C:\\pie-host.bat", allowed_origins: ["chrome-extension://someoneelse/"] }),
    });
    expect(v.hasExpectedOrigin).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Orchestrator: build a healthy baseline deps object, then perturb one axis per test.
// ---------------------------------------------------------------------------

function healthyDeps(over: Partial<WindowsDoctorDeps> = {}): WindowsDoctorDeps {
  const manifestJson = JSON.stringify({
    name: NM_HOST_NAME,
    path: "C:\\Program Files\\Pie Link\\pie-host.bat",
    allowed_origins: [EXPECTED_ORIGIN],
  });
  const knownFiles = new Set([
    "C:\\Windows\\System32\\vcruntime140.dll",
    "C:\\Program Files\\Pie Link\\ai.wiseria.pie.json",
    "C:\\Program Files\\Pie Link\\pie-host.bat",
  ]);
  return {
    execPath: "C:\\Program Files\\Pie Link\\pie.exe",
    pipePath: `\\\\.\\pipe\\${NM_HOST_NAME}`,
    vcRuntimePath: "C:\\Windows\\System32\\vcruntime140.dll",
    regQueryDefault: (key) =>
      key.startsWith("HKLM") ? "C:\\Program Files\\Pie Link\\ai.wiseria.pie.json" : null,
    fileExists: (p) => knownFiles.has(p),
    readFile: () => manifestJson,
    mappedDrives: () => new Set(),
    sandboxReady: async () => ({ ready: true }),
    probePipe: async () => "running",
    ...over,
  };
}

describe("runWindowsDoctor orchestrator", () => {
  test("all-healthy → ok true", async () => {
    const r = await runWindowsDoctor(healthyDeps());
    expect(r.ok).toBe(true);
    expect(r.lines.some((l) => l.includes("Chrome native-messaging: HKLM key present"))).toBe(true);
    expect(r.lines.some((l) => l.includes("manifest OK"))).toBe(true);
    expect(r.lines.some((l) => l.includes("sandbox facility: ready"))).toBe(true);
  });

  test("HKCU shadow → warned and ok flipped even when it resolves fine", async () => {
    const r = await runWindowsDoctor(
      healthyDeps({
        regQueryDefault: (key) =>
          key.startsWith("HKCU") && key.includes("Google")
            ? "C:\\pie\\ai.wiseria.pie.json" // stale hand-deployed shadow
            : key.startsWith("HKLM")
              ? "C:\\Program Files\\Pie Link\\ai.wiseria.pie.json"
              : null,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.lines.some((l) => l.includes("HKCU key present — SHADOWS"))).toBe(true);
    expect(r.lines.some((l) => l.includes("C:\\pie\\ai.wiseria.pie.json"))).toBe(true);
    expect(r.lines.some((l) => l.includes("reg delete"))).toBe(true);
  });

  test("HKLM missing → incomplete-install warning + ok flipped", async () => {
    const r = await runWindowsDoctor(healthyDeps({ regQueryDefault: () => null }));
    expect(r.ok).toBe(false);
    expect(r.lines.some((l) => l.includes("HKLM key MISSING"))).toBe(true);
  });

  test("network install path → ERROR + ok flipped", async () => {
    const r = await runWindowsDoctor(
      healthyDeps({ execPath: "\\\\vmshare\\Pie Link\\pie.exe" }),
    );
    expect(r.ok).toBe(false);
    expect(r.lines.some((l) => l.includes("ERROR_BAD_NETPATH"))).toBe(true);
  });

  test("missing VC++ runtime → ERROR + ok flipped", async () => {
    const r = await runWindowsDoctor(
      healthyDeps({ fileExists: (p) => !p.toLowerCase().includes("vcruntime140") && p.includes("Pie Link") }),
    );
    expect(r.ok).toBe(false);
    expect(r.lines.some((l) => l.includes("VCRUNTIME140.dll): MISSING"))).toBe(true);
  });

  test("sandbox NOT ready → warned but ok NOT flipped (fail-closed degrade)", async () => {
    const r = await runWindowsDoctor(
      healthyDeps({ sandboxReady: async () => ({ ready: false, reason: "egress not blocked" }) }),
    );
    expect(r.ok).toBe(true);
    expect(r.lines.some((l) => l.includes("sandbox facility: NOT ready"))).toBe(true);
    expect(r.lines.some((l) => l.includes("Only run_skill_script is affected"))).toBe(true);
  });

  test("daemon not running → reported as not-running, ok NOT flipped", async () => {
    const r = await runWindowsDoctor(healthyDeps({ probePipe: async () => "not-running" }));
    expect(r.ok).toBe(true);
    expect(r.lines.some((l) => l.includes("not running"))).toBe(true);
  });

  test("pipe error → treated as fault, ok flipped", async () => {
    const r = await runWindowsDoctor(healthyDeps({ probePipe: async () => "error" }));
    expect(r.ok).toBe(false);
    expect(r.lines.some((l) => l.includes("UNREACHABLE"))).toBe(true);
  });

  test("broken manifest (missing host wrapper) → ERROR + ok flipped", async () => {
    const r = await runWindowsDoctor(
      healthyDeps({
        // json exists but the host wrapper does not, and vcruntime is present.
        fileExists: (p) =>
          p.endsWith("ai.wiseria.pie.json") || p.toLowerCase().includes("vcruntime140"),
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.lines.some((l) => l.includes("host wrapper missing"))).toBe(true);
  });

  test("EXT_ID is the pinned extension id", () => {
    expect(EXT_ID).toBe("gpccjhdgjkmalnepmeclooflliiocfed");
  });
});
