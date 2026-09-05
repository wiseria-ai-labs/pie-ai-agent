import { doctor } from "./doctor";

export async function runCli(argv: string[]): Promise<number> {
  const cmd = argv[0];
  switch (cmd) {
    case "daemon": {
      const { startDaemon } = await import("./daemon");
      await startDaemon();
      return 0; // 常驻，正常不返回
    }
    case "host": {
      const { runHost } = await import("./host");
      await runHost();
      return 0;
    }
    case "doctor": {
      const r = await doctor();
      // `--json` (#406): structured `{ ok, checks }` to stdout for the Windows tray; the
      // human-readable lines still go to stderr so the two streams never mix. The default
      // (no-flag) path is byte-for-byte unchanged — lines to stderr, exit code by `ok`.
      if (argv[1] === "--json") {
        for (const l of r.lines) console.error(l);
        console.log(JSON.stringify({ ok: r.ok, checks: r.checks }));
        return r.ok ? 0 : 1;
      }
      for (const l of r.lines) console.error(l);
      return r.ok ? 0 : 1;
    }
    case "windows-install":
    case "windows-uninstall":
    case "windows-status": {
      // Legacy: leftover srt-sandbox account / WFP teardown on machines that installed an
      // older Pie Link. The GUI installer no longer provisions a sandbox (Windows skill
      // scripts run unsandboxed). install/uninstall stay best-effort and always return 0;
      // status returns the readiness verdict (ready→0 / not ready→1).
      const { runWindowsSandboxSetup } = await import("./windows-sandbox-setup");
      const action = cmd.slice("windows-".length) as "install" | "uninstall" | "status";
      const r = await runWindowsSandboxSetup(action);
      console.error(`[pie] windows-${action}: ${r.skipped ? "skipped" : r.ok ? "ok" : "not-ok"} — ${r.detail}`);
      return action === "status" ? (r.ok ? 0 : 1) : 0;
    }
    case "--version":
    case "version": {
      const { DAEMON_VERSION } = await import("./version");
      console.log(DAEMON_VERSION);
      return 0;
    }
    default:
      console.error(
        `unknown command: ${cmd ?? "(none)"}. usage: pie <daemon|host|doctor|version> (legacy: windows-install|windows-uninstall|windows-status)`,
      );
      return 2;
  }
}

if (import.meta.main) {
  runCli(Bun.argv.slice(2)).then((code) => process.exit(code));
}
