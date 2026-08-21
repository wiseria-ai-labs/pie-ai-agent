/**
 * DeepSeek Harness App 交棒：本机 loopback Web UI（默认 127.0.0.1:3080）。
 * 无官方深链（ADR 0013 例外）：探活 → 必要时 detach 拉起 → workspace.create →
 * 剪贴板写入 brief → 打开浏览器。composer 不预填。
 */
import type { SpawnFn, DetachSpawnFn } from "./spawn";

export const DSH_WEB_ORIGIN = "http://127.0.0.1:3080";
/** 官方 README 主路径：`dsh web` 是 `--profile web` 的硬编码别名；`--no-open` 是 web app flag。 */
export const DSH_WEB_ARGV = ["web", "--no-open"] as const;
export const DSH_READY_TIMEOUT_MS = 20_000;
export const DSH_POLL_INTERVAL_MS = 250;
export const DSH_FETCH_TIMEOUT_MS = 2_000;

export type DshFetch = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<Response>;

export interface DshHandoffIO {
  fetch: DshFetch;
  detachSpawn: DetachSpawnFn;
  spawn: SpawnFn;
  copyToClipboard: (text: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  agentPath: string;
  origin: string;
  argv: readonly string[];
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
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
    typeof v.home === "string" &&
    typeof v.attachedSessions === "number"
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

async function workspaceCreate(fetchFn: DshFetch, origin: string, path: string): Promise<void> {
  let httpOk: boolean;
  let json: unknown;
  try {
    ({ httpOk, json } = await dshPost(fetchFn, origin, "workspace.create", { path }));
  } catch (e) {
    throw new Error(
      `DeepSeek Harness workspace.create failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!httpOk) {
    throw new Error("DeepSeek Harness workspace.create returned a non-200 HTTP status");
  }
  if (isRecord(json) && isRecord(json.result) && json.result.ok === false) {
    const err = isRecord(json.result.error) ? json.result.error.message : undefined;
    throw new Error(
      `DeepSeek Harness workspace.create refused${typeof err === "string" ? `: ${err}` : ""}`,
    );
  }
  if (!isServerOk(json) || typeof json.result.value.created !== "boolean") {
    throw new Error("DeepSeek Harness workspace.create returned an unexpected response");
  }
  // created: false = 同路径幂等，也算成功。
}

export async function realCopyToClipboard(text: string): Promise<void> {
  const proc = Bun.spawn(["pbcopy"], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "pipe",
  });
  const stdin = proc.stdin;
  stdin.write(text);
  await stdin.end();
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    const detail = stderr.trim().slice(0, 200);
    throw new Error(
      detail
        ? `failed to copy the handoff brief to the clipboard: ${detail}`
        : "failed to copy the handoff brief to the clipboard",
    );
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
  await workspaceCreate(io.fetch, io.origin, dir);
  await io.copyToClipboard(context);
  const opened = await io.spawn("open", [io.origin], dir);
  if (opened.exitCode !== 0) {
    const detail = (opened.stderr ?? "").trim().slice(0, 200);
    throw new Error(
      detail
        ? `failed to open the DeepSeek Harness Web UI: ${detail}`
        : "failed to open the DeepSeek Harness Web UI",
    );
  }
}
