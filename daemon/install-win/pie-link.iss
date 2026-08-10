; daemon/install-win/pie-link.iss -- Pie Link Windows installer (Inno Setup 6).
; Authoritative design: docs/specs/2026-08-05-daemon-windows-support.md 4.2 / 4.5 + F1 / F5.
;
; Payload -> %ProgramFiles%\Pie Link\ (MUST be a local disk; F5: a network path breaks the
; elevation chain with ERROR_BAD_NETPATH):
;   pie.exe        bun-windows-x64 compiled daemon (also serves `host` / `windows-*` subcommands)
;   pie-host.bat   native-messaging wrapper (Chrome spawns it -> `pie.exe host`; .bat verified
;                  on a real machine 2026-08-08 -- no separate pie-host.exe needed)
;   PieTray.exe    minimal tray app (daemon/tray-win, C# net48)
;   srt-win.exe    @anthropic-ai/sandbox-runtime Windows backend (companion file, no vendored
;                  fallback in a bun single-binary; spec 6.1)
;   vc_redist.x64.exe  extracted to {tmp}, silent-installed first (F1: srt-win dynamically links
;                  VCRUNTIME140.dll and dies silently at loader stage without it)
;
; [Registry] writes the Chrome + Edge native-messaging host keys and the Run key (tray autostart
; at login). These are HKLM (machine-wide), NOT HKCU: this is an admin/machine-wide install (WFP +
; local account are machine-scoped), and when a standard user elevates with a *different* admin's
; credentials, HKCU + {localappdata} resolve to the admin's hive/profile -- Chrome runs as the
; standard user and would never find a per-user NM manifest. HKLM NM host keys are read by Chrome
; and Edge for every user, so the manifest json is written to {app} (Program Files, world-readable)
; and both keys + the Run value live under HKLM. [Code] on ssPostInstall: vc_redist (silent) ->
; `pie.exe windows-install` (installs the sandbox facility; failure/cancel does NOT block the
; install, only degrades script execution -- spec 3.2 fail-closed) -> start the tray. Uninstall
; reverses everything and calls `pie.exe windows-uninstall`.
;
; Build (CI or local): iscc /DMyAppVersion=<x.y.z> [ /DDistDir=<staging> ] pie-link.iss
;   DistDir defaults to ..\dist (daemon/dist) and must contain pie.exe, PieTray.exe, srt-win.exe,
;   vc_redist.x64.exe. pie-host.bat is taken from this script's own directory.

#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif
#ifndef DistDir
  #define DistDir "..\dist"
#endif
; Fixed extension id (from the pinned `key` in the extension manifest.json; store build and
; unpacked build share this id). Verified on a real machine 2026-08-08.
#define ExtId "gpccjhdgjkmalnepmeclooflliiocfed"
#define NmHostName "ai.wiseria.pie"

[Setup]
AppId={{7E4B1C9A-6F2D-4E7A-9C3B-1D2E3F4A5B6C}
AppName=Pie Link
AppVersion={#MyAppVersion}
AppPublisher=Wiseria
AppPublisherURL=https://github.com/WiseriaAI/pie-ai-agent
DefaultDirName={autopf}\Pie Link
DisableProgramGroupPage=yes
DisableDirPage=yes
; Sandbox install (machine-level WFP + local account) and Program Files both require admin.
PrivilegesRequired=admin
; x64-only first release (spec decision 2); arm64 devices run via the OS x64 emulation layer.
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#DistDir}
OutputBaseFilename=pie-link-setup-{#MyAppVersion}
Compression=lzma2/max
SolidCompression=yes
UninstallDisplayName=Pie Link
UninstallDisplayIcon={app}\PieTray.exe
WizardStyle=modern
; We stop the tray / daemon ourselves in [Code] (taskkill), so Inno need not police running apps.
CloseApplications=no
; --- Code signing (spec decision 9 / 5): first release is unsigned (SmartScreen friction accepted).
; When a cert is available, wire signing via ISCC:
;   SignTool=mysign $f     (define `mysign` in Inno's Tool settings / CI) and sign pie.exe /
;   PieTray.exe before packaging. Left as a placeholder here on purpose.

; No custom SetupIconFile yet: the tray icon is code-drawn (amber pie); the branded .ico asset
; lands with #379 and will be referenced here (SetupIconFile + PieTray resource) at that point.

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "{#DistDir}\pie.exe";           DestDir: "{app}"; Flags: ignoreversion
Source: "{#DistDir}\PieTray.exe";        DestDir: "{app}"; Flags: ignoreversion
Source: "{#DistDir}\srt-win.exe";        DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourcePath}\pie-host.bat";    DestDir: "{app}"; Flags: ignoreversion
Source: "{#DistDir}\vc_redist.x64.exe";  DestDir: "{tmp}"; Flags: deleteafterinstall

[Icons]
; Start-menu entry so users have a graphical way to relaunch the tray after they quit it (parity
; with mac's /Applications/Pie Link.app -- #405). {autoprograms} under this admin/machine-wide
; install (PrivilegesRequired=admin) resolves to {commonprograms} (all-users Start menu), matching
; the machine-wide semantics of the HKLM Run key -- NOT the elevating admin's private Start menu.
; Inno removes the shortcut on uninstall automatically. Uses PieTray.exe's own icon resource (a
; branded .ico lands with #379); no desktop shortcut by design (see #405). Single-instance is
; enforced in PieTray.cs (a named mutex), so a second click just no-ops onto the running tray.
Name: "{autoprograms}\Pie Link"; Filename: "{app}\PieTray.exe"

[Registry]
; Native-messaging host manifest path -> Chrome + Edge, machine-wide (HKLM, read for every user;
; we are elevated). Points at the world-readable manifest json under {app} (see WriteNativeManifest).
Root: HKLM; Subkey: "Software\Google\Chrome\NativeMessagingHosts\{#NmHostName}"; ValueType: string; ValueData: "{code:GetManifestPath}"; Flags: uninsdeletekey
Root: HKLM; Subkey: "Software\Microsoft\Edge\NativeMessagingHosts\{#NmHostName}"; ValueType: string; ValueData: "{code:GetManifestPath}"; Flags: uninsdeletekey
; Login autostart: Run key launches the tray (icon appears = ready). HKLM so it fires for whichever
; user logs in, independent of the elevating account. The daemon is started lazily by the host
; fallback launch when the extension connects (spec 4.4).
Root: HKLM; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "PieLink"; ValueData: """{app}\PieTray.exe"""; Flags: uninsdeletevalue

[UninstallDelete]
; Native-messaging manifest json lives under {app} (written in [Code]); remove it explicitly (the
; [Files] payload is auto-removed, but the json is created at runtime so Inno doesn't track it).
Type: files; Name: "{app}\{#NmHostName}.json"

[Code]
// The NM manifest json lives beside the payload in {app} (Program Files) so it is machine-wide
// and world-readable -- reachable by Chrome/Edge regardless of which user runs the browser or
// which admin account performed the elevated install (see the [Registry] rationale above).
function GetManifestPath(Param: String): String;
begin
  Result := ExpandConstant('{app}') + '\' + '{#NmHostName}' + '.json';
end;

// JSON-escape a Windows path (backslashes must be doubled inside a JSON string literal).
function JsonPath(const P: String): String;
begin
  Result := P;
  StringChangeEx(Result, '\', '\\', True);
end;

// Write the native-messaging host manifest pointing at the installed pie-host.bat wrapper.
// {app} already exists (the [Files] payload landed there), so no ForceDirectories needed.
procedure WriteNativeManifest();
var
  HostBat, Json: String;
begin
  HostBat := ExpandConstant('{app}\pie-host.bat');
  Json :=
    '{' + #13#10 +
    '  "name": "{#NmHostName}",' + #13#10 +
    '  "description": "Pie local daemon bridge host",' + #13#10 +
    '  "path": "' + JsonPath(HostBat) + '",' + #13#10 +
    '  "type": "stdio",' + #13#10 +
    '  "allowed_origins": ["chrome-extension://{#ExtId}/"]' + #13#10 +
    '}' + #13#10;
  SaveStringToFile(GetManifestPath(''), Json, False);
end;

// Best-effort sandbox facility install: vc_redist (F1) first, then `pie.exe windows-install`.
// Failures are logged, never fatal (spec 3.2 fail-closed): the bridge / skills / handoff still
// work; only `run_skill_script` degrades until the facility is present.
procedure InstallSandboxFacility();
var
  Code: Integer;
begin
  if Exec(ExpandConstant('{tmp}\vc_redist.x64.exe'), '/install /quiet /norestart', '',
          SW_HIDE, ewWaitUntilTerminated, Code) then
    Log('vc_redist exit=' + IntToStr(Code))
  else
    Log('vc_redist failed to launch (continuing)');

  if Exec(ExpandConstant('{app}\pie.exe'), 'windows-install', '',
          SW_HIDE, ewWaitUntilTerminated, Code) then
    Log('windows-install exit=' + IntToStr(Code))
  else
    Log('windows-install failed to launch (sandbox degraded; install continues)');
end;

// Start the tray immediately after install as the invoking (non-elevated) user, matching the
// login autostart context. nowait: the wizard's finish page is not blocked.
procedure StartTray();
var
  Code: Integer;
begin
  ExecAsOriginalUser(ExpandConstant('{app}\PieTray.exe'), '', '', SW_SHOW, ewNoWait, Code);
end;

// Chrome / Edge resolve the native-messaging host path from HKCU *before* HKLM. A stale HKCU key
// for our host (a hand-deployed dev build, or a hypothetical past per-user install form) therefore
// silently shadows the machine-wide HKLM key this installer writes: the browser launches whatever
// dead path the HKCU key names and "Pie Link" shows connected-but-broken with no visible cause.
// This happened during real-machine acceptance (PR #382 -- a Gate 0 `C:\pie\` deployment kept
// answering via its HKCU key even after uninstall). We proactively clear the residue here.
//
// Tradeoff (spec note in #392): the obvious `[Registry]` HKCU `deletekey` would resolve to the
// *elevating admin's* hive under a standard-user + admin-credential elevation -- not the hive of
// the user who actually runs the browser, which is exactly the account whose stale key does the
// shadowing. So we clear it via `reg delete` under ExecAsOriginalUser (the same original-caller
// context as StartTray), which targets the real browser user's HKCU. A missing key just yields a
// nonzero exit, which is fine -- this is best-effort cleanup, never fatal. (#365 gives `pie doctor`
// the complementary *detection*; this is the installer-side *prevention*.)
procedure ClearShadowingHkcuKeys();
var
  Code: Integer;
begin
  ExecAsOriginalUser(ExpandConstant('{sys}\reg.exe'),
    'delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\{#NmHostName}" /f',
    '', SW_HIDE, ewWaitUntilTerminated, Code);
  ExecAsOriginalUser(ExpandConstant('{sys}\reg.exe'),
    'delete "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\{#NmHostName}" /f',
    '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

// Upgrade path: the payload we are about to overwrite ({app}\PieTray.exe, {app}\pie.exe) is
// locked while the tray / daemon run, and CloseApplications=no means Inno will not police them
// for us. Without this, "installed + tray running" (or "+ daemon resident after the extension
// connected") re-installs hit DeleteFile error 5 on the locked exe and, under
// /VERYSILENT /SUPPRESSMSGBOXES, silently roll the whole install back (Abort default). This is
// symmetric with the taskkill pair in CurUninstallStepChanged, but must fire BEFORE [Files] copies:
// PrepareToInstall is the last [Code] hook that runs before [InstallDelete]/[Files] (ssInstall /
// ssPostInstall are both too late). Best-effort: taskkill on a not-running image returns 128, which
// is the normal first-install case, so both exit codes are ignored -- returning any non-empty string
// here would ABORT the install.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
begin
  Result := '';
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/f /im PieTray.exe', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/f /im pie.exe', '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    ClearShadowingHkcuKeys();
    WriteNativeManifest();
    InstallSandboxFacility();
    StartTray();
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Code: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    // Stop the tray first, then tear down the sandbox facility (a short-lived pie.exe run),
    // then kill any remaining daemon so {app}\pie.exe unlocks for deletion.
    Exec(ExpandConstant('{sys}\taskkill.exe'), '/f /im PieTray.exe', '', SW_HIDE, ewWaitUntilTerminated, Code);
    if FileExists(ExpandConstant('{app}\pie.exe')) then
      Exec(ExpandConstant('{app}\pie.exe'), 'windows-uninstall', '', SW_HIDE, ewWaitUntilTerminated, Code);
    Exec(ExpandConstant('{sys}\taskkill.exe'), '/f /im pie.exe', '', SW_HIDE, ewWaitUntilTerminated, Code);
  end;
end;
