import { DAEMON_VERSION } from "./version";
import type { PollSkillRunResult, StatusResult } from "../../src/types/local-bridge";

// 进程模块态：daemon 单进程常驻，状态随进程生命周期存在。
const startedAtMs = Date.now();
const extSockets = new Set<unknown>();

export const STDOUT_TAIL_CAP = 8 * 1024;

/** yt-dlp / ffmpeg 用 \\r 刷进度行；折叠后再截尾。纯函数供单测。 */
export function appendStdoutTail(prev: string, chunk: string, cap = STDOUT_TAIL_CAP): string {
  const normalized = (prev + chunk).replace(/[^\n\r]*\r/g, "");
  return normalized.length > cap ? normalized.slice(-cap) : normalized;
}

export interface LiveSkillRun {
  runId: string;
  socket: unknown;
  name: string;
  entry: string;
  queuedAt: number;
  startedAt: number;
  state: "queued" | "running";
  stdoutTail: string;
  abort: AbortController;
  killed: boolean;
}

const running = new Map<string, LiveSkillRun>();

/** socket 层：某连接发过 hello（= 扩展 host） → 记为扩展连接。 */
export function markExtensionSocket(s: unknown): void {
  extSockets.add(s);
}
/** socket 关闭 → 移除（顶栏 app 从未 mark，无害）。 */
export function dropSocket(s: unknown): void {
  extSockets.delete(s);
}

export function registerSkillRun(p: {
  runId?: string;
  socket?: unknown;
  name: string;
  entry: string;
}): LiveSkillRun {
  const runId = p.runId && p.runId.length > 0 ? p.runId : crypto.randomUUID();
  const now = Date.now();
  const run: LiveSkillRun = {
    runId,
    socket: p.socket,
    name: p.name,
    entry: p.entry,
    queuedAt: now,
    startedAt: now,
    state: "queued",
    stdoutTail: "",
    abort: new AbortController(),
    killed: false,
  };
  running.set(runId, run);
  return run;
}

/** skill 脚本开跑 → 登记，返回 runId。保留给既有 status 单测。 */
export function beginSkillRun(name: string, entry: string): string {
  return registerSkillRun({ name, entry }).runId;
}

export function markSkillRunRunning(runId: string): void {
  const r = running.get(runId);
  if (!r) return;
  r.state = "running";
  r.startedAt = Date.now();
}

export function appendSkillRunStdout(runId: string, chunk: string): void {
  const r = running.get(runId);
  if (!r) return;
  r.stdoutTail = appendStdoutTail(r.stdoutTail, chunk);
}

/** skill 脚本结束（finally 里调，幂等）。 */
export function endSkillRun(id: string): void {
  running.delete(id);
}

export function getSkillRun(runId: string): LiveSkillRun | undefined {
  return running.get(runId);
}

export function pollSkillRun(runId: string): PollSkillRunResult {
  const r = running.get(runId);
  if (!r) return { state: "done", elapsedMs: 0, stdoutTail: "" };
  return {
    state: r.state,
    elapsedMs: Date.now() - r.startedAt,
    stdoutTail: r.stdoutTail,
  };
}

/** 幂等：未知 runId 也当成功。 */
export function killSkillRun(runId: string): boolean {
  const r = running.get(runId);
  if (!r) return true;
  r.killed = true;
  try {
    r.abort.abort();
  } catch {
    /* already aborted */
  }
  return true;
}

/** 断连收尸：杀掉该 socket 发起的全部 in-flight / queued run。 */
export function killRunsForSocket(socket: unknown): number {
  let n = 0;
  for (const r of running.values()) {
    if (r.socket === socket) {
      r.killed = true;
      try {
        r.abort.abort();
      } catch {
        /* already aborted */
      }
      n++;
    }
  }
  return n;
}

export function getStatus(): StatusResult {
  return {
    version: DAEMON_VERSION,
    uptimeSec: Math.floor((Date.now() - startedAtMs) / 1000),
    extensionConnected: extSockets.size > 0,
    runningSkills: [...running.values()].map((r) => ({ name: r.name, startedAt: r.startedAt })),
    pid: process.pid,
  };
}
