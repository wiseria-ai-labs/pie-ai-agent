import { test, expect } from "bun:test";
import {
  DSH_WEB_ARGV,
  DSH_WEB_ORIGIN,
  isDshHostDescribe,
  launchDshWebHandoff,
  type DshHandoffIO,
} from "../src/handoff-dsh";
import { setLogEnabled } from "../src/log";

setLogEnabled(false);

/** 真机 `POST /api/host.describe` 200 的 value（0.1.0-rc.5；官方 schema 无 `home`）。 */
function dshDescribeValue() {
  return {
    version: "0.0.1",
    cwd: "/tmp",
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
    attachedSessions: 0,
    canOpenPath: true,
  };
}

function dshDescribeBody(value: Record<string, unknown> = dshDescribeValue()) {
  return {
    type: "server-response",
    rpcId: "r1",
    result: {
      ok: true,
      value,
    },
  };
}

function dshWorkspaceBody(created: boolean, path: string) {
  return {
    type: "server-response",
    rpcId: "r2",
    result: {
      ok: true,
      value: {
        workspace: {
          workspaceId: "ws-1",
          path,
          title: "handoff",
          sessionIds: [],
          createdAt: "2026-08-21T00:00:00Z",
          updatedAt: "2026-08-21T00:00:00Z",
        },
        created,
      },
    },
  };
}

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function baseIo(overrides: Partial<DshHandoffIO> = {}): DshHandoffIO {
  return {
    fetch: async () => jsonRes({}, 404),
    detachSpawn: () => {},
    spawn: async () => ({ stdout: "", exitCode: 0 }),
    copyToClipboard: async () => {},
    sleep: async () => {},
    now: () => 0,
    agentPath: "/Users/x/.local/bin/dsh",
    origin: DSH_WEB_ORIGIN,
    argv: DSH_WEB_ARGV,
    ...overrides,
  };
}

test("isDshHostDescribe accepts a real host.describe envelope and rejects lookalikes", () => {
  expect(isDshHostDescribe(dshDescribeBody())).toBe(true);
  expect(isDshHostDescribe({ ok: true })).toBe(false);
  expect(isDshHostDescribe({ type: "server-response", result: { ok: true, value: { version: "1" } } })).toBe(false);
  const withoutCanOpenPath = { ...dshDescribeValue() };
  delete (withoutCanOpenPath as { canOpenPath?: boolean }).canOpenPath;
  expect(isDshHostDescribe(dshDescribeBody(withoutCanOpenPath))).toBe(false);
  expect(isDshHostDescribe(dshDescribeBody({
    version: "0.0.1",
    cwd: "/tmp",
    attachedSessions: 0,
    home: "/Users/x",
  }))).toBe(false);
});

test("冷启动 argv 是 dsh web，不含 rc.5 会立刻退出的 unknown option", () => {
  expect([...DSH_WEB_ARGV]).toEqual(["web"]);
});

test("探活命中：复用已有 Web UI，不 detach 启动，登记 workspace、剪贴板、打开 URL", async () => {
  const fetches: { url: string; body: Record<string, unknown> }[] = [];
  const detached: { cmd: string; args: string[]; cwd: string }[] = [];
  const clips: string[] = [];
  const spawns: { cmd: string; args: string[]; cwd: string }[] = [];
  const dir = "/tmp/pie-handoffs/2026-08-21-continue-the-report";
  await launchDshWebHandoff(dir, "Continue the report", baseIo({
    fetch: async (url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      fetches.push({ url: String(url), body });
      if (String(url).endsWith("/api/host.describe")) return jsonRes(dshDescribeBody());
      if (String(url).endsWith("/api/workspace.create")) {
        const path = (body.payload as { path?: string } | undefined)?.path ?? "";
        return jsonRes(dshWorkspaceBody(false, path));
      }
      return jsonRes({}, 404);
    },
    detachSpawn: (cmd, args, cwd) => { detached.push({ cmd, args, cwd }); },
    copyToClipboard: async (text) => { clips.push(text); },
    spawn: async (cmd, args, cwd) => {
      spawns.push({ cmd, args, cwd });
      return { stdout: "", exitCode: 0 };
    },
  }));
  expect(detached).toHaveLength(0);
  const describe = fetches.find((f) => f.url === `${DSH_WEB_ORIGIN}/api/host.describe`);
  expect(describe?.body).toMatchObject({ type: "client-request", method: "host.describe", payload: {} });
  const create = fetches.find((f) => f.url === `${DSH_WEB_ORIGIN}/api/workspace.create`);
  expect(create?.body).toMatchObject({
    type: "client-request",
    method: "workspace.create",
    payload: { path: dir },
  });
  expect(clips).toEqual(["Continue the report"]);
  expect(spawns).toEqual([{ cmd: "open", args: [DSH_WEB_ORIGIN], cwd: dir }]);
});

test("探活未命中：detach `dsh web` 后轮询，再登记 workspace", async () => {
  let describes = 0;
  const detached: { cmd: string; args: string[]; cwd: string }[] = [];
  const clips: string[] = [];
  const dir = "/tmp/pie-handoffs/brief";
  await launchDshWebHandoff(dir, "brief", baseIo({
    fetch: async (url) => {
      if (String(url).endsWith("/api/host.describe")) {
        describes++;
        if (describes === 1) throw new Error("fetch failed");
        return jsonRes(dshDescribeBody());
      }
      if (String(url).endsWith("/api/workspace.create")) {
        return jsonRes(dshWorkspaceBody(true, "/unused"));
      }
      return jsonRes({}, 404);
    },
    detachSpawn: (cmd, args, cwd) => { detached.push({ cmd, args, cwd }); },
    copyToClipboard: async (text) => { clips.push(text); },
  }));
  expect(detached).toEqual([{
    cmd: "/Users/x/.local/bin/dsh",
    args: [...DSH_WEB_ARGV],
    cwd: dir,
  }]);
  expect(describes).toBeGreaterThanOrEqual(2);
  expect(clips).toEqual(["brief"]);
});

test("非 dsh 占用端口：拒绝对不明服务写 workspace，也不 detach", async () => {
  const detached: unknown[] = [];
  await expect(
    launchDshWebHandoff("/tmp/x", "x", baseIo({
      fetch: async () => jsonRes({ hello: "nginx" }),
      detachSpawn: () => { detached.push(1); },
      copyToClipboard: async () => { throw new Error("clipboard must not run"); },
    })),
  ).rejects.toThrow(/not DeepSeek Harness/);
  expect(detached).toHaveLength(0);
});

test("冷启动超时：描述性错误，不无限挂", async () => {
  let t = 0;
  await expect(
    launchDshWebHandoff("/tmp/x", "x", baseIo({
      fetch: async () => { throw new Error("fetch failed"); },
      copyToClipboard: async () => { throw new Error("clipboard must not run"); },
      sleep: async (ms) => { t += ms; },
      now: () => t,
      readyTimeoutMs: 400,
      pollIntervalMs: 100,
    })),
  ).rejects.toThrow(/did not become ready at http:\/\/127\.0\.0\.1:3080/);
  expect(t).toBeGreaterThanOrEqual(400);
});

test("spawn 之后 probe 变成 other：立刻失败，不空转到超时", async () => {
  let t = 0;
  let describes = 0;
  await expect(
    launchDshWebHandoff("/tmp/x", "x", baseIo({
      fetch: async () => {
        describes++;
        if (describes === 1) throw new Error("down");
        return jsonRes({ hello: "nginx" });
      },
      copyToClipboard: async () => { throw new Error("clipboard must not run"); },
      sleep: async (ms) => { t += ms; },
      now: () => t,
      readyTimeoutMs: 20_000,
      pollIntervalMs: 250,
    })),
  ).rejects.toThrow(/not DeepSeek Harness/);
  expect(t).toBeLessThan(20_000);
});
