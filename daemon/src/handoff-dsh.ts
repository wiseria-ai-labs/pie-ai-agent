/**
 * DeepSeek Harness App 交棒：本机 loopback Web UI（默认 127.0.0.1:3080）。
 * 无官方深链（ADR 0013 例外）：探活 → 必要时 detach 拉起 → workspace.create →
 * session.create → session.prompt 代发 brief → 打开浏览器。
 * 界面不会自动切到新 session（无 workspace.select）；任务已经在跑。
 */
import type { SpawnFn, DetachSpawnFn } from "./spawn";
import { windowsOpenDeeplink } from "./handoff-win32";

export const DSH_WEB_ORIGIN = "http://127.0.0.1:3080";
/** 冷启动：`dsh web`。0.1.0-rc.5 的 `dsh web --help` 只有 `--host` / `--port` / `--trusted-host`，多传会立刻退出。 */
export const DSH_WEB_ARGV = ["web"] as const;
export const DSH_READY_TIMEOUT_MS = 20_000;
export const DSH_POLL_INTERVAL_MS = 250;
export const DSH_FETCH_TIMEOUT_MS = 2_000;
/** 等 Web UI 给新 workspace 挂上 blank session（connectWorkspace）再代发，避免自己再 mint 一条。 */
export const DSH_SESSION_WAIT_MS = 5_000;

export type DshFetch = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<Response>;

export interface DshHandoffIO {
  fetch: DshFetch;
  detachSpawn: DetachSpawnFn;
  spawn: SpawnFn;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  agentPath: string;
  origin: string;
  argv: readonly string[];
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
  sessionWaitMs?: number;
  /** 打开浏览器的方式随平台：win32 = `cmd /c start "" <url>`，其余 = `open <url>`。缺省 process.platform。 */
  platform?: NodeJS.Platform;
}

type Probe = "dsh" | "down" | "other";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function clientRequest(method: string, payload: unknown) {
  return {
    type: "client-request" as const,
    rpcId: crypto.randomUUID(),
    method,
    payload,
  };
}

function isServerOk(json: unknown): json is {
  type: "server-response";
  result: { ok: true; value: Record<string, unknown> };
} {
  if (!isRecord(json) || json.type !== "server-response") return false;
  const result = json.result;
  if (!isRecord(result) || result.ok !== true) return false;
  return isRecord(result.value);
}

/** host.describe 的 200 + envelope 才算 dsh；别的服务即使 200 也不能写 workspace。 */
export function isDshHostDescribe(json: unknown): boolean {
  if (!isServerOk(json)) return false;
  const v = json.result.value;
  return (
    typeof v.version === "string" &&
    typeof v.cwd === "string" &&
    typeof v.attachedSessions === "number" &&
    typeof v.canOpenPath === "boolean"
  );
}

async function dshPost(
  fetchFn: DshFetch,
  origin: string,
  method: string,
  payload: unknown,
): Promise<{ httpOk: boolean; json: unknown }> {
  const body = clientRequest(method, payload);
  const res = await fetchFn(`${origin}/api/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(DSH_FETCH_TIMEOUT_MS),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { httpOk: res.ok, json };
}

async function probe(fetchFn: DshFetch, origin: string): Promise<Probe> {
  try {
    const { httpOk, json } = await dshPost(fetchFn, origin, "host.describe", {});
    if (httpOk && isDshHostDescribe(json)) return "dsh";
    return "other";
  } catch {
    return "down";
  }
}

function occupiedPortError(origin: string): Error {
  return new Error(
    `${origin} answered but is not DeepSeek Harness; refusing to register a workspace there`,
  );
}

async function waitUntilDsh(io: DshHandoffIO): Promise<void> {
  const timeout = io.readyTimeoutMs ?? DSH_READY_TIMEOUT_MS;
  const interval = io.pollIntervalMs ?? DSH_POLL_INTERVAL_MS;
  const deadline = io.now() + timeout;
  while (io.now() < deadline) {
    const status = await probe(io.fetch, io.origin);
    if (status === "dsh") return;
    if (status === "other") throw occupiedPortError(io.origin);
    await io.sleep(interval);
  }
  throw new Error(
    `DeepSeek Harness Web UI did not become ready at ${io.origin} within ${timeout}ms`,
  );
}

async function dshCall(
  fetchFn: DshFetch,
  origin: string,
  method: string,
  payload: unknown,
): Promise<Record<string, unknown>> {
  let httpOk: boolean;
  let json: unknown;
  try {
    ({ httpOk, json } = await dshPost(fetchFn, origin, method, payload));
  } catch (e) {
    throw new Error(
      `DeepSeek Harness ${method} failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!httpOk) {
    throw new Error(`DeepSeek Harness ${method} returned a non-200 HTTP status`);
  }
  if (isRecord(json) && isRecord(json.result) && json.result.ok === false) {
    const err = isRecord(json.result.error) ? json.result.error.message : undefined;
    throw new Error(
      `DeepSeek Harness ${method} refused${typeof err === "string" ? `: ${err}` : ""}`,
    );
  }
  if (!isServerOk(json)) {
    throw new Error(`DeepSeek Harness ${method} returned an unexpected response`);
  }
  return json.result.value;
}

async function workspaceCreate(fetchFn: DshFetch, origin: string, path: string): Promise<string> {
  const value = await dshCall(fetchFn, origin, "workspace.create", { path });
  const workspace = value.workspace;
  if (
    typeof value.created !== "boolean" ||
    !isRecord(workspace) ||
    typeof workspace.workspaceId !== "string" ||
    workspace.workspaceId === ""
  ) {
    throw new Error("DeepSeek Harness workspace.create returned an unexpected response");
  }
  // created: false = 同路径幂等，也算成功。
  return workspace.workspaceId;
}

async function sessionCreate(
  fetchFn: DshFetch,
  origin: string,
  workspaceId: string,
): Promise<string> {
  const value = await dshCall(fetchFn, origin, "session.create", { workspaceId });
  if (typeof value.sessionId !== "string" || value.sessionId === "") {
    throw new Error("DeepSeek Harness session.create returned an unexpected response");
  }
  return value.sessionId;
}

/**
 * Web UI 的 connectWorkspace 会给新 workspace mint 一条 blank session 并 sessions.open。
 * 代发必须打进那条，否则会多一条「工作中」session，界面却停在空白的。
 */
async function findBlankSession(
  fetchFn: DshFetch,
  origin: string,
  workspaceId: string,
  dir: string,
): Promise<string | null> {
  const wsList = await dshCall(fetchFn, origin, "workspace.list", {});
  const workspaces = wsList.items;
  if (!Array.isArray(workspaces)) return null;
  const ws = workspaces.find((w) => isRecord(w) && w.workspaceId === workspaceId);
  if (!isRecord(ws) || !Array.isArray(ws.sessionIds)) return null;
  const sessList = await dshCall(fetchFn, origin, "session.list", {});
  const sessions = sessList.items;
  if (!Array.isArray(sessions)) return null;
  for (const s of sessions) {
    if (!isRecord(s) || s.blank !== true || typeof s.sessionId !== "string") continue;
    if (!ws.sessionIds.includes(s.sessionId)) continue;
    if (typeof s.cwd === "string" && s.cwd !== dir) continue;
    return s.sessionId;
  }
  return null;
}

async function resolveHandoffSession(
  io: DshHandoffIO,
  workspaceId: string,
  dir: string,
): Promise<string> {
  const timeout = io.sessionWaitMs ?? DSH_SESSION_WAIT_MS;
  const interval = io.pollIntervalMs ?? DSH_POLL_INTERVAL_MS;
  const deadline = io.now() + timeout;
  while (io.now() < deadline) {
    try {
      const id = await findBlankSession(io.fetch, io.origin, workspaceId, dir);
      if (id) return id;
    } catch {
      // 轮询期 list 失败当还没就绪，超时后再自己 session.create。
    }
    if (io.now() >= deadline) break;
    await io.sleep(interval);
  }
  return sessionCreate(io.fetch, io.origin, workspaceId);
}

async function sessionPrompt(
  fetchFn: DshFetch,
  origin: string,
  sessionId: string,
  text: string,
): Promise<void> {
  const value = await dshCall(fetchFn, origin, "session.prompt", {
    sessionId,
    mode: "queue",
    content: [{ type: "text", text }],
  });
  if (value.accepted !== true) {
    throw new Error("DeepSeek Harness session.prompt returned an unexpected response");
  }
}

export function defaultDshSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function launchDshWebHandoff(
  dir: string,
  context: string,
  io: DshHandoffIO,
): Promise<void> {
  const status = await probe(io.fetch, io.origin);
  if (status === "other") {
    throw occupiedPortError(io.origin);
  }
  if (status === "down") {
    io.detachSpawn(io.agentPath, [...io.argv], dir);
    await waitUntilDsh(io);
  }
  const workspaceId = await workspaceCreate(io.fetch, io.origin, dir);
  // 先打开 UI：cold start / reload 会 connectWorkspace → mint blank 并选中。
  // 再代发进那条 blank，界面就会停在工作中的 session。
  const launch =
    (io.platform ?? process.platform) === "win32"
      ? windowsOpenDeeplink(io.origin)
      : { cmd: "open", args: [io.origin] };
  const opened = await io.spawn(launch.cmd, launch.args, dir);
  if (opened.exitCode !== 0) {
    const detail = (opened.stderr ?? "").trim().slice(0, 200);
    throw new Error(
      detail
        ? `failed to open the DeepSeek Harness Web UI: ${detail}`
        : "failed to open the DeepSeek Harness Web UI",
    );
  }
  const sessionId = await resolveHandoffSession(io, workspaceId, dir);
  await sessionPrompt(io.fetch, io.origin, sessionId, context);
}
