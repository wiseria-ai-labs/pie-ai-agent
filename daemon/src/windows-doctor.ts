// Windows-only `pie doctor` checks (spec docs/specs/2026-08-05-daemon-windows-support.md
// §2.4 F5 + §4.8). Every check here targets a real failure mode observed during the
// 2026-08-09 Windows 11 acceptance run and surfaces an actionable line; a normal user can't
// self-diagnose most of these, which is the whole reason doctor exists.
//
// The orchestrator (`runWindowsDoctor`) is fully injectable so the parsing / classification /
// verdict logic can be asserted hermetically from `bun test` on mac/Linux — the platform gate
// lives in `doctor.ts`, this module only runs when already on win32.
import { existsSync, readFileSync } from "fs";

/** Native-messaging host name (registry subkey leaf + manifest json basename). */
export const NM_HOST_NAME = "ai.wiseria.pie";
/** Chrome Web Store id (pinned in the extension manifest `key`; keyed unpacked shares it). */
export const EXT_ID = "gpccjhdgjkmalnepmeclooflliiocfed";
/** Edge Add-ons store id (Edge rejects `key`; store assigns a stable id). Issue #35. */
export const EDGE_STORE_EXT_ID = "gbfdgfkpglimajnjedphgakmhaplgobf";
/** allowed_origins entry the Chrome store / keyed unpacked build uses. */
export const EXPECTED_ORIGIN = `chrome-extension://${EXT_ID}/`;
/** allowed_origins entry the Edge Add-ons store build uses. */
export const EDGE_STORE_ORIGIN = `chrome-extension://${EDGE_STORE_EXT_ID}/`;

/** The two browsers whose native-messaging host keys the installer writes (HKLM, machine-wide). */
export interface NmBrowser {
  /** Stable check id surfaced in `--json` (`nm_chrome` / `nm_edge`) — a key, not display text. */
  id: string;
  name: string;
  hklmKey: string;
  hkcuKey: string;
}

export const NM_BROWSERS: NmBrowser[] = [
  {
    id: "nm_chrome",
    name: "Chrome",
    hklmKey: `HKLM\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NM_HOST_NAME}`,
    hkcuKey: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NM_HOST_NAME}`,
  },
  {
    id: "nm_edge",
    name: "Edge",
    hklmKey: `HKLM\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NM_HOST_NAME}`,
    hkcuKey: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NM_HOST_NAME}`,
  },
];

/**
 * A single structured doctor check, consumed by `pie doctor --json` (the Windows tray renders
 * these into plain-language lines and localises the title by `id`; #406). `id` is a STABLE key,
 * never user-facing text; `detail` is the raw technical detail (English, never translated) and is
 * only meaningful on non-`ok` checks — the tray shows it under abnormal items for screenshots.
 *
 * `status` is decoupled from the doctor `ok` verdict on purpose so the tray can flag an
 * individual check as `error` without keying its title off the overall `ok`. See #406.
 */
export type DoctorCheckStatus = "ok" | "warn" | "error";
export interface DoctorCheck {
  id: string;
  status: DoctorCheckStatus;
  detail: string;
}

// ---------------------------------------------------------------------------
// Pure parsers / classifiers (unit-tested directly)
// ---------------------------------------------------------------------------

/**
 * Extract the default value from `reg query "<key>" /ve` stdout. The value line looks like
 * `    (Default)    REG_SZ    C:\path\to\ai.wiseria.pie.json`. Returns null when the key/value is
 * absent (reg prints an error to stderr and no value line). Both REG_SZ and REG_EXPAND_SZ
 * are accepted.
 *
 * The value-name column is matched as `\S+` rather than the literal `(Default)`: on a localized
 * Windows the `reg` MUI translates it (Simplified Chinese prints `(默认)`, etc.), and anchoring on
 * the English string made a successful `/ve` query parse as null → doctor falsely reporting the
 * HKLM key MISSING and silently disabling the HKCU-shadow check (the most valuable probe here).
 * `/ve` queries only the default value, so stdout carries at most one REG_SZ/REG_EXPAND_SZ row —
 * matching the type column is unambiguous regardless of the value name's language.
 */
export function parseRegQueryDefault(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*\S+\s+REG_(?:SZ|EXPAND_SZ)\s+(.*)$/i);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * Parse mapped network-drive letters from `net use` stdout. Connected entries look like
 * `OK           Z:        \\server\share            Microsoft Windows Network`; we capture the
 * `X:` local column that is followed by a `\\...` remote. Returns the drive letters upper-cased.
 */
export function parseMappedDrives(stdout: string): Set<string> {
  const out = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/(?:^|\s)([A-Za-z]):\s+\\\\/);
    if (m) out.add(m[1].toUpperCase());
  }
  return out;
}

export interface InstallPathVerdict {
  isNetwork: boolean;
  reason: string;
}

/**
 * Classify whether the daemon exe sits on a network location (F5): a UNC path, a Parallels
 * shared-folder redirect (`C:\Mac\...` / `\\Mac\...`), or a mapped network drive. The elevation
 * chain breaks with ERROR_BAD_NETPATH from any of these, so the fix is always "reinstall to a
 * local disk". `mappedDrives` is the set of drive letters (upper-case) reported by `net use`.
 */
export function classifyInstallPath(execPath: string, mappedDrives: Set<string> = new Set()): InstallPathVerdict {
  const p = execPath ?? "";
  // Local device-namespace prefixes (\\?\ and \\.\) are NOT network — unless they wrap UNC.
  if (/^\\\\[?.]\\/.test(p)) {
    if (/^\\\\[?.]\\UNC\\/i.test(p)) return { isNetwork: true, reason: "UNC path (\\\\?\\UNC\\...)" };
    return { isNetwork: false, reason: "local device path" };
  }
  // Parallels redirect (drive form C:\Mac\... or UNC form \\Mac\...): checked before generic UNC.
  if (/^[a-z]:\\Mac\\/i.test(p) || /^\\\\Mac\\/i.test(p))
    return { isNetwork: true, reason: "Parallels shared folder (\\Mac\\...)" };
  // Plain UNC: \\server\share\...
  if (/^\\\\/.test(p)) return { isNetwork: true, reason: "UNC network path (\\\\server\\share\\...)" };
  // Mapped network drive: the exe's drive letter appears in `net use`.
  const drive = p.match(/^([a-z]):/i);
  if (drive && mappedDrives.has(drive[1].toUpperCase())) {
    return { isNetwork: true, reason: `mapped network drive ${drive[1].toUpperCase()}:` };
  }
  return { isNetwork: false, reason: "local disk" };
}

export interface ManifestVerdict {
  /** The manifest json exists and parsed. */
  jsonExists: boolean;
  /** Parse failure detail (json unreadable / invalid), if any. */
  parseError?: string;
  /** The `path` (host wrapper) declared in the manifest, or null. */
  hostPath: string | null;
  /** The host-wrapper path exists on disk. */
  hostPathExists: boolean;
  /** `allowed_origins` contains the Chrome store EXT_ID origin. */
  hasExpectedOrigin: boolean;
  /** `allowed_origins` contains the Edge Add-ons store origin. Missing is a
   *  warn on new installs, not an error — old Pie Link json only had Chrome. */
  hasEdgeStoreOrigin: boolean;
}

/**
 * Validate a native-messaging manifest at `jsonPath`: the json exists + parses, its `path`
 * (host wrapper) exists on disk, and `allowed_origins` carries the Chrome store origin. IO is
 * injected (`fileExists` / `readFile`) so this is unit-testable off-Windows.
 */
export function checkNmManifest(
  jsonPath: string,
  io: { fileExists(p: string): boolean; readFile(p: string): string },
): ManifestVerdict {
  if (!io.fileExists(jsonPath)) {
    return {
      jsonExists: false,
      hostPath: null,
      hostPathExists: false,
      hasExpectedOrigin: false,
      hasEdgeStoreOrigin: false,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(io.readFile(jsonPath));
  } catch (e) {
    return {
      jsonExists: true,
      parseError: e instanceof Error ? e.message : String(e),
      hostPath: null,
      hostPathExists: false,
      hasExpectedOrigin: false,
      hasEdgeStoreOrigin: false,
    };
  }
  const obj = (parsed ?? {}) as { path?: unknown; allowed_origins?: unknown };
  const hostPath = typeof obj.path === "string" ? obj.path : null;
  const origins = Array.isArray(obj.allowed_origins) ? obj.allowed_origins : [];
  return {
    jsonExists: true,
    hostPath,
    hostPathExists: hostPath != null && io.fileExists(hostPath),
    hasExpectedOrigin: origins.some((o) => o === EXPECTED_ORIGIN),
    hasEdgeStoreOrigin: origins.some((o) => o === EDGE_STORE_ORIGIN),
  };
}

// ---------------------------------------------------------------------------
// Injectable IO surface + orchestrator
// ---------------------------------------------------------------------------

export type PipeProbeResult = "running" | "not-running" | "error";

export interface WindowsDoctorDeps {
  /** Daemon exe location (F5 install-path check). Default: process.execPath. */
  execPath: string;
  /** Named-pipe IPC address (informational + probe target). */
  pipePath: string;
  /** Read a registry key's `(Default)` value; null when the key is absent. */
  regQueryDefault(key: string): string | null;
  fileExists(p: string): boolean;
  readFile(p: string): string;
  /** Drive letters (upper-case) currently mapped to network shares (`net use`). */
  mappedDrives(): Set<string>;
  /** Best-effort named-pipe reachability probe. */
  probePipe(): Promise<PipeProbeResult>;
}

/**
 * Run the Windows-specific doctor checks and return lines + an `ok` verdict.
 *
 * `ok` is flipped to false only by genuine, actionable faults: a missing HKLM NM key, an HKCU
 * shadow key, a broken manifest, a network install path, or an unreachable-but-erroring pipe.
 * States that are acceptable-by-design do NOT flip ok: a not-running daemon (expected — it's
 * launched lazily), or an HKCU key that is merely absent (the normal, healthy case).
 */
export async function runWindowsDoctor(depsOverride: Partial<WindowsDoctorDeps> = {}): Promise<{
  ok: boolean;
  lines: string[];
  checks: DoctorCheck[];
}> {
  const deps = { ...defaultWindowsDoctorDeps(), ...depsOverride };
  const lines: string[] = [];
  // Structured checks for `--json` (#406). Built ALONGSIDE `lines` from the same branches so the
  // two never diverge; the human-readable `lines` output stays byte-for-byte unchanged. The pipe
  // and agent probes are deliberately excluded — the tray must not surface "not running" (lazy
  // launch, benign) or agent detection (unrelated to the Windows tray diagnostics).
  const checks: DoctorCheck[] = [];
  let ok = true;

  // --- Named pipe reachability: distinguish "not running" (lazy launch, benign) from a fault.
  lines.push(`named pipe: ${deps.pipePath}`);
  try {
    const probe = await deps.probePipe();
    if (probe === "running") {
      lines.push("  reachable: daemon is running");
    } else if (probe === "not-running") {
      lines.push("  not running: daemon will be launched on demand when the extension connects");
    } else {
      lines.push("  UNREACHABLE: pipe exists but the connection errored (possible fault)");
      ok = false;
    }
  } catch (e) {
    lines.push(`  probe failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // --- F5: install path must be on a local disk.
  const installVerdict = classifyInstallPath(deps.execPath, safeMappedDrives(deps));
  if (installVerdict.isNetwork) {
    lines.push(`install path: ${deps.execPath}`);
    lines.push(`  ERROR: on a network location (${installVerdict.reason}) — elevation breaks with`);
    lines.push("  ERROR_BAD_NETPATH. Reinstall Pie Link to a local disk (default: Program Files).");
    ok = false;
    checks.push({
      id: "install_path",
      status: "error",
      detail: `${deps.execPath} — on a network location (${installVerdict.reason})`,
    });
  } else {
    lines.push(`install path: ${deps.execPath} (${installVerdict.reason})`);
    checks.push({ id: "install_path", status: "ok", detail: deps.execPath });
  }

  // Windows skill scripts run unsandboxed (passthrough). Informational — not a structured check.
  lines.push("skill scripts: run as the signed-in user (no sandbox on Windows)");

  // --- Native-messaging registry keys: HKLM (installed) + HKCU (shadow) for Chrome + Edge.
  for (const b of NM_BROWSERS) {
    const check = checkNmBrowser(b, deps, lines, (flip) => {
      if (flip) ok = false;
    });
    checks.push(check);
  }

  return { ok, lines, checks };
}

/**
 * Per-browser native-messaging key check. HKCU is read FIRST because Chrome/Edge resolve HKCU
 * before HKLM: an HKCU key silently shadows the installer's HKLM key and routes the browser to a
 * (usually stale/missing) per-user host — an almost-unfindable failure a user hit on 2026-08-09.
 * So an HKCU key that exists is ALWAYS a warning, even when it points somewhere valid.
 */
function checkNmBrowser(
  b: NmBrowser,
  deps: WindowsDoctorDeps,
  lines: string[],
  flipOk: (flip: boolean) => void,
): DoctorCheck {
  const hkcu = deps.regQueryDefault(b.hkcuKey);
  const hklm = deps.regQueryDefault(b.hklmKey);
  // Collect error details in the same order the lines are pushed; the check is `error` iff any
  // fault is found. `ok` detail carries the HKLM manifest path (screenshot / verification aid).
  const errors: string[] = [];
  let okDetail = "";

  // HKCU shadow — the marquee check. Report even when its manifest resolves fine.
  if (hkcu != null) {
    lines.push(`${b.name} native-messaging: HKCU key present — SHADOWS the machine-wide HKLM key`);
    lines.push(`  ${b.name} reads HKCU before HKLM, so the browser launches the HKCU host, not Pie's.`);
    lines.push(`  HKCU points at: ${hkcu}`);
    lines.push(`  Remove it: reg delete "${b.hkcuKey}" /f`);
    flipOk(true);
    errors.push(`HKCU key shadows HKLM (points at: ${hkcu})`);
  }

  // HKLM presence — what the installer writes.
  if (hklm == null) {
    lines.push(`${b.name} native-messaging: HKLM key MISSING — install is incomplete, reinstall Pie Link`);
    flipOk(true);
    errors.push("HKLM key missing — install incomplete");
  } else {
    lines.push(`${b.name} native-messaging: HKLM key present -> ${hklm}`);
    const m = checkNmManifest(hklm, { fileExists: deps.fileExists, readFile: deps.readFile });
    if (!m.jsonExists) {
      lines.push(`  ERROR: manifest json not found at ${hklm}`);
      flipOk(true);
      errors.push(`manifest json not found at ${hklm}`);
    } else if (m.parseError) {
      lines.push(`  ERROR: manifest json is unreadable/invalid: ${m.parseError}`);
      flipOk(true);
      errors.push(`manifest json unreadable/invalid: ${m.parseError}`);
    } else {
      if (!m.hostPathExists) {
        lines.push(`  ERROR: host wrapper missing: ${m.hostPath ?? "(no path field)"}`);
        flipOk(true);
        errors.push(`host wrapper missing: ${m.hostPath ?? "(no path field)"}`);
      }
      if (!m.hasExpectedOrigin) {
        lines.push(`  ERROR: allowed_origins is missing ${EXPECTED_ORIGIN}`);
        flipOk(true);
        errors.push(`allowed_origins is missing ${EXPECTED_ORIGIN}`);
      }
      if (!m.hasEdgeStoreOrigin) {
        // Warn only: old Pie Link json only listed the Chrome origin. Edge
        // Add-ons users need a reinstall to pick up EDGE_STORE_ORIGIN. Chrome
        // still connects, so this must not flip `ok`.
        lines.push(`  WARN: allowed_origins is missing ${EDGE_STORE_ORIGIN} (reinstall Pie Link to connect the Edge store build)`);
      }
      if (m.hostPathExists && m.hasExpectedOrigin) {
        lines.push(
          m.hasEdgeStoreOrigin
            ? "  manifest OK (host wrapper present, allowed_origins carries the Chrome and Edge store ids)"
            : "  manifest OK (host wrapper present, allowed_origins carries the extension id)",
        );
        okDetail = `HKLM -> ${hklm}`;
      }
    }
  }

  return errors.length > 0
    ? { id: b.id, status: "error", detail: errors.join("; ") }
    : { id: b.id, status: "ok", detail: okDetail };
}

function safeMappedDrives(deps: WindowsDoctorDeps): Set<string> {
  try {
    return deps.mappedDrives();
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// Default (real-Windows) IO wiring
// ---------------------------------------------------------------------------

export function defaultWindowsDoctorDeps(): WindowsDoctorDeps {
  return {
    execPath: process.execPath,
    pipePath: `\\\\.\\pipe\\${NM_HOST_NAME}`,
    regQueryDefault: (key) => defaultRegQueryDefault(key),
    fileExists: (p) => existsSync(p),
    readFile: (p) => readFileSync(p, "utf8"),
    mappedDrives: () => defaultMappedDrives(),
    probePipe: () => defaultProbePipe(`\\\\.\\pipe\\${NM_HOST_NAME}`),
  };
}

function defaultRegQueryDefault(key: string): string | null {
  try {
    const r = Bun.spawnSync(["reg", "query", key, "/ve"], { stdin: "ignore", timeout: 3000, windowsHide: true });
    if (r.exitCode !== 0) return null;
    return parseRegQueryDefault(r.stdout.toString());
  } catch {
    return null;
  }
}

function defaultMappedDrives(): Set<string> {
  try {
    const r = Bun.spawnSync(["net", "use"], { stdin: "ignore", timeout: 3000, windowsHide: true });
    return parseMappedDrives(r.stdout.toString());
  } catch {
    return new Set();
  }
}

async function defaultProbePipe(pipePath: string): Promise<PipeProbeResult> {
  const net = await import("net");
  return new Promise<PipeProbeResult>((resolve) => {
    let settled = false;
    const done = (v: PipeProbeResult) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    const sock = net.connect(pipePath);
    sock.setTimeout(2000);
    sock.on("connect", () => done("running"));
    sock.on("timeout", () => done("error"));
    sock.on("error", (e: NodeJS.ErrnoException) => {
      // ENOENT / ECONNREFUSED = no server listening on the pipe → daemon not running.
      done(e.code === "ENOENT" || e.code === "ECONNREFUSED" ? "not-running" : "error");
    });
  });
}
