import { test, expect, describe } from "bun:test";
import {
  parseRegQueryDefault,
  parseMappedDrives,
  classifyInstallPath,
  checkNmManifest,
  runWindowsDoctor,
  NM_HOST_NAME,
  EXPECTED_ORIGIN,
  EDGE_STORE_EXT_ID,
  EDGE_STORE_ORIGIN,
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

  test("parses localized value-name column identically to English (中文 (默认) 回归)", () => {
    // A localized `reg` MUI translates the default value name; Simplified Chinese prints `(默认)`.
    // Anchoring on the English `(Default)` string made a healthy key parse as null → doctor
    // falsely claiming the HKLM key was MISSING and silently killing the HKCU-shadow check.
    const path = "C:\\Program Files\\Pie Link\\ai.wiseria.pie.json";
    const english = `    (Default)    REG_SZ    ${path}`;
    const chinese = `    (默认)    REG_SZ    ${path}`;
    const expandChinese = `    (默认)    REG_EXPAND_SZ    ${path}`;
    expect(parseRegQueryDefault(english)).toBe(path);
    expect(parseRegQueryDefault(chinese)).toBe(path);
    expect(parseRegQueryDefault(expandChinese)).toBe(path);
    // All three resolve to the exact same path.
    expect(parseRegQueryDefault(chinese)).toBe(parseRegQueryDefault(english));
  });

  test("returns null when the key/value is absent", () => {
    // reg.exe prints the error to stderr; stdout has no value line.
    expect(parseRegQueryDefault("ERROR: The system was unable to find the specified registry key")).toBeNull();
    expect(parseRegQueryDefault("")).toBeNull();
    // A localized key header alone (no REG_ value row) must not be mistaken for a value.
    expect(
      parseRegQueryDefault(
        [
          "",
          `HKEY_LOCAL_MACHINE\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NM_HOST_NAME}`,
          "",
        ].join("\r\n"),
      ),
    ).toBeNull();
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
    expect(v.hasEdgeStoreOrigin).toBe(false);
    expect(v.parseError).toBeUndefined();
  });

  test("both store origins detected", () => {
    const v = checkNmManifest("C:\\app\\ai.wiseria.pie.json", {
      fileExists: () => true,
      readFile: () =>
        JSON.stringify({
          path: "C:\\Program Files\\Pie Link\\pie-host.bat",
          allowed_origins: [EXPECTED_ORIGIN, EDGE_STORE_ORIGIN],
        }),
    });
    expect(v.hasExpectedOrigin).toBe(true);
    expect(v.hasEdgeStoreOrigin).toBe(true);
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
    expect(v.hasEdgeStoreOrigin).toBe(false);
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
    expect(r.lines.some((l) => l.includes("no sandbox on Windows"))).toBe(true);
    expect(r.checks.some((c) => c.id === "sandbox")).toBe(false);
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

  test("EXT_ID is the pinned Chrome store id", () => {
    expect(EXT_ID).toBe("gpccjhdgjkmalnepmeclooflliiocfed");
  });

  test("EDGE_STORE_EXT_ID is the Edge Add-ons store id", () => {
    expect(EDGE_STORE_EXT_ID).toBe("gbfdgfkpglimajnjedphgakmhaplgobf");
  });

  test("Chrome-only allowed_origins stays ok with a WARN for the missing Edge origin", async () => {
    const r = await runWindowsDoctor(healthyDeps());
    expect(r.ok).toBe(true);
    expect(r.lines.some((l) => l.includes("WARN: allowed_origins is missing"))).toBe(true);
    expect(r.lines.some((l) => l.includes(EDGE_STORE_ORIGIN))).toBe(true);
  });

  test("both store origins → ok and no Edge-origin WARN", async () => {
    const r = await runWindowsDoctor(
      healthyDeps({
        readFile: () =>
          JSON.stringify({
            name: NM_HOST_NAME,
            path: "C:\\Program Files\\Pie Link\\pie-host.bat",
            allowed_origins: [EXPECTED_ORIGIN, EDGE_STORE_ORIGIN],
          }),
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.lines.some((l) => l.includes("WARN: allowed_origins is missing"))).toBe(false);
    expect(r.lines.some((l) => l.includes("Chrome and Edge store ids"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Structured `checks` array for `--json` (#406). The tray renders these.
// Windows no longer emits a sandbox check (skill scripts run unsandboxed).
// ---------------------------------------------------------------------------

describe("runWindowsDoctor checks (--json)", () => {
  function findCheck(checks: { id: string }[], id: string) {
    return checks.find((c) => c.id === id);
  }

  test("all-healthy → every check ok, covers install_path / vc_runtime / NM", async () => {
    const r = await runWindowsDoctor(healthyDeps());
    const ids = r.checks.map((c) => c.id).sort();
    expect(ids).toEqual(["install_path", "nm_chrome", "nm_edge", "vc_runtime"]);
    expect(r.checks.every((c) => c.status === "ok")).toBe(true);
    // ok detail carries the HKLM manifest path for verification.
    expect(findCheck(r.checks, "nm_chrome")!.detail).toContain("HKLM ->");
  });

  test("pipe/agents probes never leak into checks", async () => {
    const r = await runWindowsDoctor(healthyDeps({ probePipe: async () => "not-running" }));
    expect(r.checks.some((c) => c.id === "pipe" || c.id === "agents" || c.id === "sandbox")).toBe(
      false,
    );
    expect(r.checks.length).toBe(4);
  });

  test("no sandbox check even when doctor is otherwise healthy", async () => {
    const r = await runWindowsDoctor(healthyDeps());
    expect(findCheck(r.checks, "sandbox")).toBeUndefined();
    expect(r.lines.some((l) => /no sandbox on Windows/i.test(l))).toBe(true);
  });

  test("network install path → install_path check is error with the reason", async () => {
    const r = await runWindowsDoctor(healthyDeps({ execPath: "\\\\vmshare\\Pie Link\\pie.exe" }));
    const c = findCheck(r.checks, "install_path")!;
    expect(c.status).toBe("error");
    expect(c.detail).toContain("network location");
  });

  test("missing VC++ runtime → vc_runtime check is error", async () => {
    const r = await runWindowsDoctor(
      healthyDeps({ fileExists: (p) => !p.toLowerCase().includes("vcruntime140") && p.includes("Pie Link") }),
    );
    expect(findCheck(r.checks, "vc_runtime")!.status).toBe("error");
  });

  test("HKCU shadow → nm_chrome check is error and detail names the shadow path", async () => {
    const r = await runWindowsDoctor(
      healthyDeps({
        regQueryDefault: (key) =>
          key.startsWith("HKCU") && key.includes("Google")
            ? "C:\\pie\\ai.wiseria.pie.json"
            : key.startsWith("HKLM")
              ? "C:\\Program Files\\Pie Link\\ai.wiseria.pie.json"
              : null,
      }),
    );
    const c = findCheck(r.checks, "nm_chrome")!;
    expect(c.status).toBe("error");
    expect(c.detail).toContain("C:\\pie\\ai.wiseria.pie.json");
    // Edge is untouched → still ok.
    expect(findCheck(r.checks, "nm_edge")!.status).toBe("ok");
  });

  test("HKLM missing → nm check error, both browsers", async () => {
    const r = await runWindowsDoctor(healthyDeps({ regQueryDefault: () => null }));
    expect(findCheck(r.checks, "nm_chrome")!.status).toBe("error");
    expect(findCheck(r.checks, "nm_edge")!.status).toBe("error");
    expect(findCheck(r.checks, "nm_chrome")!.detail).toContain("HKLM key missing");
  });

  test("broken manifest (missing host wrapper) → nm check error", async () => {
    const r = await runWindowsDoctor(
      healthyDeps({
        fileExists: (p) =>
          p.endsWith("ai.wiseria.pie.json") || p.toLowerCase().includes("vcruntime140"),
      }),
    );
    expect(findCheck(r.checks, "nm_chrome")!.status).toBe("error");
    expect(findCheck(r.checks, "nm_chrome")!.detail).toContain("host wrapper missing");
  });
});
