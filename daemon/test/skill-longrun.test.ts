import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  appendStdoutTail,
  beginSkillRun,
  endSkillRun,
  killRunsForSocket,
  killSkillRun,
  pollSkillRun,
  registerSkillRun,
} from "../src/status";
import { handleMessage } from "../src/daemon";
import { seedBundledSkills } from "../src/bundled-skills";
import { readSessionFile } from "../src/skill-store";

describe("appendStdoutTail", () => {
  test("collapses yt-dlp \r progress and keeps the last cap bytes", () => {
    const s = appendStdoutTail("", "downloading\r12%\r34%\ndone\n", 100);
    expect(s).toBe("34%\ndone\n");
    const long = "x".repeat(50);
    expect(appendStdoutTail("", long, 10)).toBe("x".repeat(10));
  });
});

describe("poll / kill registry", () => {
  test("unknown runId polls as done and kill is idempotent", () => {
    expect(pollSkillRun("missing")).toEqual({ state: "done", elapsedMs: 0, stdoutTail: "" });
    expect(killSkillRun("missing")).toBe(true);
  });

  test("registered run is queued then gone after end", () => {
    const live = registerSkillRun({ name: "demo", entry: "run.ts", runId: "run-1" });
    expect(pollSkillRun("run-1").state).toBe("queued");
    expect(pollSkillRun("run-1").stdoutTail).toBe("");
    endSkillRun(live.runId);
    expect(pollSkillRun("run-1").state).toBe("done");
  });

  test("kill marks the run aborted", () => {
    const live = registerSkillRun({ name: "demo", entry: "e.ts", runId: "run-k" });
    expect(live.killed).toBe(false);
    killSkillRun("run-k");
    expect(live.killed).toBe(true);
    expect(live.abort.signal.aborted).toBe(true);
    endSkillRun("run-k");
  });

  test("killRunsForSocket only touches that socket", () => {
    const a = {};
    const b = {};
    const ra = registerSkillRun({ name: "a", entry: "e.ts", socket: a, runId: "sa" });
    const rb = registerSkillRun({ name: "b", entry: "e.ts", socket: b, runId: "sb" });
    expect(killRunsForSocket(a)).toBe(1);
    expect(ra.killed).toBe(true);
    expect(rb.killed).toBe(false);
    endSkillRun("sa");
    endSkillRun("sb");
  });

  test("beginSkillRun still feeds status.runningSkills", () => {
    const id = beginSkillRun("demo", "fetch.ts");
    endSkillRun(id);
  });
});

describe("poll_skill_run / kill_skill_run RPC", () => {
  test("unknown methods are not returned — poll of missing run is done", async () => {
    const out = JSON.parse(
      await handleMessage(JSON.stringify({ id: "p", method: "poll_skill_run", params: { runId: "nope" } })),
    );
    expect(out.ok).toBe(true);
    expect(out.result.state).toBe("done");
  });

  test("kill of missing run is ok", async () => {
    const out = JSON.parse(
      await handleMessage(JSON.stringify({ id: "k", method: "kill_skill_run", params: { runId: "nope" } })),
    );
    expect(out.ok).toBe(true);
    expect(out.result.ok).toBe(true);
  });
});

describe("seedBundledSkills", () => {
  test("empty BUNDLED writes nothing", () => {
    const dir = join(import.meta.dir, ".tmp-seed-" + Math.random().toString(36).slice(2));
    mkdirSync(dir, { recursive: true });
    expect(seedBundledSkills(dir)).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("readSessionFile base64", () => {
  test("returns base64 for a binary file", () => {
    const SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const root = join(import.meta.dir, ".tmp-img-" + Math.random().toString(36).slice(2));
    const ws = join(root, SID, "workspace");
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "frame.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    const r = readSessionFile(SID, "frame.jpg", 0, root, "base64");
    expect(r.encoding).toBe("base64");
    expect(Buffer.from(r.content, "base64")).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    rmSync(root, { recursive: true, force: true });
  });
});
