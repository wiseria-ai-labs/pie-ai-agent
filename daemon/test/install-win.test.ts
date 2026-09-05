import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Structural guards for the Windows installer片 (spec 4.2/4.5 + F5). The full flow is
// real-machine (need-human-test); here we lock the invariants that a string-scan can enforce so
// a future edit can't silently drop the Program-Files target, the registry wiring, or the
// leftover-sandbox uninstall hook. Windows skill scripts run unsandboxed: the installer must
// not restage a sandbox backend.

const dir = join(import.meta.dir, "..", "install-win");
const iss = readFileSync(join(dir, "pie-link.iss"), "utf8");
const bat = readFileSync(join(dir, "pie-host.bat"), "utf8");
const trayCs = readFileSync(
  join(import.meta.dir, "..", "tray-win", "PieTray.cs"),
  "utf8",
);
const releaseYml = readFileSync(
  join(import.meta.dir, "..", "..", ".github", "workflows", "release.yml"),
  "utf8",
);

const EXT_ID = "gpccjhdgjkmalnepmeclooflliiocfed";
const EDGE_EXT_ID = "gbfdgfkpglimajnjedphgakmhaplgobf";

// ── pie-host.bat (native-messaging wrapper) ─────────────────────────────────
test("pie-host.bat forwards to `pie.exe host` next to itself, with CRLF", () => {
  expect(bat).toContain("@echo off");
  // %~dp0 = dir of the bat (trailing backslash) -> pie.exe resolved beside the wrapper.
  expect(bat).toContain('"%~dp0pie.exe" host %*');
  expect(bat).toContain("\r\n"); // Windows line endings
});

// ── [Files]: every payload the installer still ships ────────────────────────
for (const f of ["pie.exe", "PieTray.exe", "pie-host.bat"]) {
  test(`iss [Files] ships ${f}`, () => {
    expect(iss).toContain(f);
  });
}

// ── F5: install to local-disk Program Files, elevated ───────────────────────
test("iss installs into Program Files ({autopf}) on a local disk (F5)", () => {
  expect(iss).toContain("DefaultDirName={autopf}\\Pie Link");
});

test("iss requires admin (Program Files)", () => {
  expect(iss).toMatch(/PrivilegesRequired\s*=\s*admin/);
});

test("iss is x64-only (spec decision 2)", () => {
  expect(iss).toMatch(/ArchitecturesInstallIn64BitMode\s*=\s*x64compatible/);
});

// ── [Registry]: native messaging (Chrome + Edge) + Run key, machine-wide (HKLM) ──
// HKLM (not HKCU): an admin/machine-wide install whose per-user resources must survive a
// standard-user + admin-credential elevation (HKCU/{localappdata} would land in the admin's hive).
test("iss registers the Chrome native-messaging host key under HKLM", () => {
  expect(iss).toMatch(/Root:\s*HKLM;\s*Subkey:\s*"Software\\Google\\Chrome\\NativeMessagingHosts\\/);
});

test("iss registers the Edge native-messaging host key under HKLM", () => {
  expect(iss).toMatch(/Root:\s*HKLM;\s*Subkey:\s*"Software\\Microsoft\\Edge\\NativeMessagingHosts\\/);
});

test("iss writes an HKLM Run key that launches the tray (machine-wide login autostart)", () => {
  expect(iss).toMatch(/Root:\s*HKLM;\s*Subkey:\s*"Software\\Microsoft\\Windows\\CurrentVersion\\Run"/);
  expect(iss).toContain('{app}\\PieTray.exe');
});

test("iss pins the Chrome and Edge store ids in allowed_origins", () => {
  // Both ids are defined once and templated into the origin (iscc expands at compile).
  expect(iss).toContain(`#define ExtId "${EXT_ID}"`);
  expect(iss).toContain(`#define EdgeExtId "${EDGE_EXT_ID}"`);
  expect(iss).toContain("chrome-extension://{#ExtId}/");
  expect(iss).toContain("chrome-extension://{#EdgeExtId}/");
});

test("iss does not allowlist a path-derived unpacked id", () => {
  expect(iss).not.toContain("oalbbnaognpedempboblkimkapdpbhjl");
});

test("iss lands the native-messaging manifest under {app} (world-readable Program Files)", () => {
  // GetManifestPath resolves to {app}\<host>.json, and the manifest points there via {code:GetManifestPath}.
  expect(iss).toMatch(/GetManifestPath[\s\S]*ExpandConstant\('\{app\}'\)/);
  expect(iss).not.toContain("{localappdata}\\PieLink");
});

// ── leftover sandbox teardown on uninstall; installer must not re-provision ──
test("iss does not mention windows-install or vc_redist (no sandbox facility on install)", () => {
  expect(iss).not.toContain("windows-install");
  expect(iss).not.toContain("vc_redist");
});

test("iss does not ship a sandbox backend", () => {
  expect(iss).not.toContain("srt-win.exe");
  expect(iss).not.toContain("InstallSandboxFacility");
});

test("release workflow does not stage srt-win.exe or vc_redist", () => {
  expect(releaseYml).not.toContain("srt-win.exe");
  expect(releaseYml).not.toContain("vc_redist");
});

test("iss calls pie.exe windows-uninstall on uninstall (legacy facility teardown)", () => {
  expect(iss).toContain("'windows-uninstall'");
  expect(iss).toContain("CurUninstallStepChanged");
});

test("iss removes the runtime-written NM manifest json on uninstall", () => {
  // Raw .iss string (pre-iscc): {app}\{#NmHostName}.json templated on the fixed host name.
  expect(iss).toMatch(/\[UninstallDelete\][\s\S]*\{app\}\\\{#NmHostName\}\.json/);
});

// ── #392.1: proactively clear a shadowing HKCU native-messaging key on install ──
// Chrome/Edge read HKCU before HKLM, so a stale HKCU host key silently overrides the machine-wide
// HKLM key this installer writes. Cleared via `reg delete` under ExecAsOriginalUser (targets the
// real browser user's hive, not the elevating admin's -- see the [Code] rationale).
test("iss clears the shadowing HKCU Chrome native-messaging key as the original user", () => {
  expect(iss).toMatch(
    /ExecAsOriginalUser[\s\S]*reg\.exe[\s\S]*delete "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\/,
  );
});

test("iss clears the shadowing HKCU Edge native-messaging key as the original user", () => {
  expect(iss).toMatch(
    /ExecAsOriginalUser[\s\S]*reg\.exe[\s\S]*delete "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\/,
  );
});

test("iss runs the HKCU cleanup at post-install (CurStepChanged), before the manifest write", () => {
  expect(iss).toContain("ClearShadowingHkcuKeys()");
  // Inspect the ssPostInstall body only, so we compare call-sites (not procedure definitions).
  const body = iss.slice(iss.indexOf("if CurStep = ssPostInstall then"));
  const call = body.indexOf("ClearShadowingHkcuKeys();");
  const write = body.indexOf("WriteNativeManifest();");
  expect(call).toBeGreaterThan(-1);
  expect(write).toBeGreaterThan(call);
});

// ── #399: free the payload BEFORE [Files] copies (upgrade-path lock -> silent rollback) ────────
// On "installed + tray/daemon running" re-installs the locked {app}\PieTray.exe / {app}\pie.exe make
// Inno's DeleteFile fail (error 5); under /VERYSILENT /SUPPRESSMSGBOXES this silently rolls the whole
// install back. PrepareToInstall is the last [Code] hook before [InstallDelete]/[Files], so the work
// must live there (symmetric with the uninstall-side pair), not in ssPostInstall (too late).
function prepareToInstallBody(): string {
  const start = iss.indexOf("function PrepareToInstall(");
  expect(start).toBeGreaterThan(-1);
  // Body = from the function header to the next top-level procedure/function declaration.
  const rest = iss.slice(start + 1);
  const nextDecl = rest.search(/\n(?:procedure|function)\s/);
  return nextDecl === -1 ? rest : rest.slice(0, nextDecl);
}

test("iss kills both PieTray.exe and pie.exe in PrepareToInstall (before [Files] copies)", () => {
  const body = prepareToInstallBody();
  expect(body).toMatch(/taskkill\.exe'\),\s*'\/f \/im PieTray\.exe'/);
  expect(body).toMatch(/taskkill\.exe'\),\s*'\/f \/im pie\.exe'/);
});

// The regression the taskkill pair alone did NOT catch (real-machine acceptance): a connected
// extension re-spawns the daemon ~1s after the kill (Chrome -> pie-host.bat -> pie.exe host ->
// pie.exe daemon), so [Files] hits a freshly re-locked pie.exe and rolls back anyway. Windows can't
// delete a running image but can rename it, so the old exes are moved aside and [Files] copies into
// free names. Deleting a stale *.old must come BEFORE the rename or the rename has nowhere to land.
test("iss renames the running payload aside before [Files] (taskkill alone loses the race, #399)", () => {
  const body = prepareToInstallBody();
  const delOld = body.indexOf("DeleteFile(ExpandConstant('{app}\\pie.exe.old'))");
  const renamePie = body.search(/RenameFile\(ExpandConstant\('\{app\}\\pie\.exe'\),\s*ExpandConstant\('\{app\}\\pie\.exe\.old'\)\)/);
  const renameTray = body.search(/RenameFile\(ExpandConstant\('\{app\}\\PieTray\.exe'\),\s*ExpandConstant\('\{app\}\\PieTray\.exe\.old'\)\)/);
  expect(delOld).toBeGreaterThan(-1);
  expect(renamePie).toBeGreaterThan(delOld);
  expect(renameTray).toBeGreaterThan(-1);
  // Both renamed-aside files must be cleaned up on uninstall (Inno doesn't track them).
  expect(iss).toMatch(/Type: files; Name: "\{app\}\\pie\.exe\.old"/);
  expect(iss).toMatch(/Type: files; Name: "\{app\}\\PieTray\.exe\.old"/);
});

// After the rename the OLD daemon is still running off pie.exe.old and still owns the named pipe;
// without a post-copy kill the extension keeps talking to the previous version. Kill after the
// new payload is in place and before StartTray so the new tray does not attach to a stale daemon.
test("iss kills the stale daemon in ssPostInstall, after WriteNativeManifest, before StartTray", () => {
  const start = iss.indexOf("procedure CurStepChanged(");
  expect(start).toBeGreaterThan(-1);
  const body = iss.slice(start);
  const write = body.indexOf("WriteNativeManifest();");
  const kill = body.search(/taskkill\.exe'\),\s*'\/f \/im pie\.exe'/);
  const startTray = body.indexOf("StartTray();");
  expect(write).toBeGreaterThan(-1);
  expect(kill).toBeGreaterThan(write);
  expect(startTray).toBeGreaterThan(kill);
});

test("PieTray has no Repair Sandbox menu item", () => {
  expect(trayCs).not.toContain("repairSandbox");
  expect(trayCs).not.toContain("RepairSandbox");
  expect(trayCs).not.toContain("doctor.sandbox");
  expect(trayCs).not.toContain("doctor.vc_runtime");
});

test("iss keeps CloseApplications=no (killing is done by us, not Inno's restart manager)", () => {
  // Explicit guard: switching to CloseApplications=yes + RestartApplications changes the tray's
  // ExecAsOriginalUser restart semantics and must be a deliberate, test-updating decision.
  expect(iss).toMatch(/CloseApplications\s*=\s*no/);
});

// ── #405: Start-menu shortcut (graphical relaunch entry) + single-instance guard ────────────
// The tray is the only foreground surface Pie Link has on Windows; without a Start-menu entry a
// user who quits it (the tray's own "Quit Pie Link" item) has no non-CLI way to bring it back.
test("iss ships a Start-menu shortcut to the tray under {autoprograms} (all-users, #405)", () => {
  expect(iss).toMatch(/\[Icons\]/);
  // {autoprograms} (not {userprograms}) so an admin-credential elevation lands the shortcut in the
  // all-users Start menu, matching the machine-wide HKLM Run key -- not the elevating admin's hive.
  expect(iss).toMatch(
    /Name:\s*"\{autoprograms\}\\Pie Link";\s*Filename:\s*"\{app\}\\PieTray\.exe"/,
  );
});

test("iss does NOT create a desktop shortcut (#405 explicit non-goal)", () => {
  expect(iss).not.toMatch(/\{autodesktop\}|\{userdesktop\}|\{commondesktop\}/);
});

test("PieTray enforces single-instance via a Global named mutex (#405)", () => {
  // A manual launch entry means a second click could spawn a second tray; a machine-wide Global\
  // mutex makes the second process no-op instead of stacking a second icon that can also kill the daemon.
  // (Two backslashes in the raw source == one runtime backslash in the C# string literal.)
  expect(trayCs).toContain('"Global\\\\ai.wiseria.pie.tray"');
  // The mutex is acquired at startup, capturing whether this process created it.
  expect(trayCs).toMatch(/new Mutex\(true,\s*SingleInstanceMutexName,\s*out createdNew\)/);
  // The second instance must bail out silently (no "already running" dialog) when it didn't create the mutex.
  expect(trayCs).toMatch(/if\s*\(!createdNew\)\s*return;/);
});

test("PieTray tolerates a Global mutex it cannot open without crashing (#407 review)", () => {
  // A Global\ mutex held by another logon session has a default DACL that only grants the creator's
  // session; a second user's tray (fast user switching / HKLM Run) can neither create nor open it, so
  // `new Mutex(...)` throws UnauthorizedAccessException. Without a catch the process dies as a WER CLR
  // crash instead of the intended silent single-instance exit. Guard the try/catch stays in place.
  expect(trayCs).toMatch(/catch\s*\(\s*UnauthorizedAccessException\b/);
  expect(trayCs).toMatch(/catch\s*\(\s*WaitHandleCannotBeOpenedException\b/);
});

// ── #392.2: CI pins the innosetup choco version (ISCC path is hardcoded to "Inno Setup 6") ──
test("release workflow pins the innosetup choco version", () => {
  expect(releaseYml).toMatch(/choco install innosetup --version=6\.\d+\.\d+/);
});

test("release workflow ISCC path matches the pinned Inno Setup 6 major version", () => {
  // Guard the pin<->path coupling: a v7 pin without updating this path would fail to find ISCC.
  const pin = releaseYml.match(/choco install innosetup --version=(\d+)\./);
  expect(pin).not.toBeNull();
  expect(releaseYml).toContain(`Inno Setup ${pin![1]}\\ISCC.exe`);
});

// ── Output name mirrors the release asset the CI job uploads ─────────────────
test("iss output filename is pie-link-setup-<version>", () => {
  expect(iss).toContain("OutputBaseFilename=pie-link-setup-{#MyAppVersion}");
});
