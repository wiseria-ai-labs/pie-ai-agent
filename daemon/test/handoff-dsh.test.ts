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

function dshWorkspaceBody(created: boolean, path: string, workspaceId = "ws-1") {
  return {
    type: "server-response",
    rpcId: "r2",
    result: {
      ok: true,
      value: {
        workspace: {
          workspaceId,
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

function dshSessionCreateBody(sessionId = "sess-1") {
  return {
    type: "server-response",
    rpcId: "r3",
    result: { ok: true, value: { sessionId } },
  };
}

function dshSessionPromptBody() {
  return {
    type: "server-response",
    rpcId: "r4",
    result: { ok: true, value: { accepted: true } },
  };
}

function dshWorkspaceListBody(path: string, sessionIds: string[], workspaceId = "ws-1") {
  return {
    type: "server-response",
    rpcId: "r-wsl",
    result: {
      ok: true,
      value: {
        items: [{
          workspaceId,
          path,
          title: "handoff",
          sessionIds,
          createdAt: "2026-08-21T00:00:00Z",
          updatedAt: "2026-08-21T00:00:00Z",
        }],
        archivedSessionIds: [],
      },
    },
  };
}

function dshSessionListBody(items: { sessionId: string; blank: boolean; cwd?: string }[]) {
  return {
    type: "server-response",
    rpcId: "r-sl",
    result: {
      ok: true,
      value: {
        items: items.map((s) => ({
          sessionId: s.sessionId,
          updatedAt: 0,
          running: false,
          blank: s.blank,
          ...(s.cwd !== undefined ? { cwd: s.cwd } : {}),
        })),
      },
    },
  };
}

function dshRefused(message: string) {
  return {
    type: "server-response",
    rpcId: "r-err",
    result: { ok: false, error: { message } },
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
    sleep: async () => {},
    now: () => 0,
    agentPath: "/Users/x/.local/bin/dsh",
    origin: DSH_WEB_ORIGIN,
    argv: DSH_WEB_ARGV,
    ...overrides,
  };
}

/**
 * Happy-path DSH RPC after probe.
 * 默认：Web UI 已 mint 一条 blank session（connectWorkspace），代发打进它，不再 session.create。
 */
function happyDshFetch(
  fetches: { url: string; body: Record<string, unknown> }[],
  extras?: {
    describe?: () => Promise<Response> | Response;
    uiBlank?: { sessionId: string; cwd: string } | null;
    sessionCreate?: (body: Record<string, unknown>) => Response;
    sessionPrompt?: (body: Record<string, unknown>) => Response;
  },
) {
  let createdPath = "";
  return async (url: string, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    fetches.push({ url: String(url), body });
    if (String(url).endsWith("/api/host.describe")) {
      return extras?.describe ? extras.describe() : jsonRes(dshDescribeBody());
    }
    if (String(url).endsWith("/api/workspace.create")) {
      const path = (body.payload as { path?: string } | undefined)?.path ?? "";
      createdPath = path;
      return jsonRes(dshWorkspaceBody(true, path));
    }
    const blank = extras?.uiBlank === undefined
      ? { sessionId: "sess-ui", cwd: createdPath }
      : extras.uiBlank;
    if (String(url).endsWith("/api/workspace.list")) {
      const cwd = blank?.cwd ?? createdPath;
      return jsonRes(dshWorkspaceListBody(cwd, blank ? [blank.sessionId] : []));
    }
    if (String(url).endsWith("/api/session.list")) {
      return jsonRes(dshSessionListBody(
        blank ? [{ sessionId: blank.sessionId, blank: true, cwd: blank.cwd || createdPath }] : [],
      ));
    }
    if (String(url).endsWith("/api/session.create")) {
      return extras?.sessionCreate?.(body) ?? jsonRes(dshSessionCreateBody());
    }
    if (String(url).endsWith("/api/session.prompt")) {
      return extras?.sessionPrompt?.(body) ?? jsonRes(dshSessionPromptBody());
    }
    return jsonRes({}, 404);
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

test("探活命中：打开 UI 后把 brief 代发进 Web UI 已选中的 blank session，不再自己 mint", async () => {
  const fetches: { url: string; body: Record<string, unknown> }[] = [];
  const detached: { cmd: string; args: string[]; cwd: string }[] = [];
  const spawns: { cmd: string; args: string[]; cwd: string }[] = [];
  const dir = "/tmp/pie-handoffs/2026-08-21-continue-the-report";
  const brief = "Continue the report";
  await launchDshWebHandoff(dir, brief, baseIo({
    fetch: happyDshFetch(fetches, {
      sessionPrompt: (body) => {
        expect(body).toMatchObject({
          type: "client-request",
          method: "session.prompt",
          payload: {
            sessionId: "sess-ui",
            mode: "queue",
            content: [{ type: "text", text: brief }],
          },
        });
        return jsonRes(dshSessionPromptBody());
      },
    }),
    detachSpawn: (cmd, args, cwd) => { detached.push({ cmd, args, cwd }); },
    spawn: async (cmd, args, cwd) => {
      spawns.push({ cmd, args, cwd });
      return { stdout: "", exitCode: 0 };
    },
  }));
  expect(detached).toHaveLength(0);
  const methods = fetches.map((f) => f.body.method);
  expect(methods).toEqual([
    "host.describe",
    "workspace.create",
    "workspace.list",
    "session.list",
    "session.prompt",
  ]);
  expect(methods).not.toContain("session.create");
  expect(fetches.find((f) => f.body.method === "workspace.create")?.body).toMatchObject({
    payload: { path: dir },
  });
  expect(spawns).toEqual([{ cmd: "open", args: [DSH_WEB_ORIGIN], cwd: dir }]);
});

test("探活未命中：detach `dsh web` 后轮询，再登记 workspace 并代发", async () => {
  let describes = 0;
  const fetches: { url: string; body: Record<string, unknown> }[] = [];
  const detached: { cmd: string; args: string[]; cwd: string }[] = [];
  const dir = "/tmp/pie-handoffs/brief";
  await launchDshWebHandoff(dir, "brief", baseIo({
    fetch: happyDshFetch(fetches, {
      describe: () => {
        describes++;
        if (describes === 1) throw new Error("fetch failed");
        return jsonRes(dshDescribeBody());
      },
    }),
    detachSpawn: (cmd, args, cwd) => { detached.push({ cmd, args, cwd }); },
  }));
  expect(detached).toEqual([{
    cmd: "/Users/x/.local/bin/dsh",
    args: [...DSH_WEB_ARGV],
    cwd: dir,
  }]);
  expect(describes).toBeGreaterThanOrEqual(2);
  expect(fetches.map((f) => f.body.method).filter((m) => m !== "host.describe")).toEqual([
    "workspace.create",
    "workspace.list",
    "session.list",
    "session.prompt",
  ]);
  expect(fetches.map((f) => f.body.method)).not.toContain("session.create");
});

test("Web UI 没有 blank session：超时后自己 session.create 再代发", async () => {
  const fetches: { url: string; body: Record<string, unknown> }[] = [];
  await launchDshWebHandoff("/tmp/x", "brief", baseIo({
    fetch: happyDshFetch(fetches, {
      uiBlank: null,
      sessionCreate: (body) => {
        expect(body).toMatchObject({ payload: { workspaceId: "ws-1" } });
        return jsonRes(dshSessionCreateBody("sess-ours"));
      },
      sessionPrompt: (body) => {
        expect(body).toMatchObject({
          payload: { sessionId: "sess-ours", mode: "queue" },
        });
        return jsonRes(dshSessionPromptBody());
      },
    }),
    sessionWaitMs: 0,
  }));
  expect(fetches.map((f) => f.body.method)).toContain("session.create");
  expect(fetches.find((f) => f.body.method === "session.prompt")?.body).toMatchObject({
    payload: { sessionId: "sess-ours" },
  });
});

test("session.create 失败：不代发（浏览器可能已打开）", async () => {
  const fetches: { url: string; body: Record<string, unknown> }[] = [];
  await expect(
    launchDshWebHandoff("/tmp/x", "brief", baseIo({
      fetch: happyDshFetch(fetches, {
        uiBlank: null,
        sessionCreate: () => jsonRes(dshRefused("workspace-attach-failed")),
      }),
      sessionWaitMs: 0,
    })),
  ).rejects.toThrow(/session\.create refused: workspace-attach-failed/);
  expect(fetches.map((f) => f.body.method)).not.toContain("session.prompt");
});

test("session.prompt 失败：不把失败当成功", async () => {
  await expect(
    launchDshWebHandoff("/tmp/x", "brief", baseIo({
      fetch: happyDshFetch([], {
        sessionPrompt: () => jsonRes(dshRefused("model-unavailable")),
      }),
    })),
  ).rejects.toThrow(/session\.prompt refused: model-unavailable/);
});

test("非 dsh 占用端口：拒绝对不明服务写 workspace，也不 detach", async () => {
  const detached: unknown[] = [];
  await expect(
    launchDshWebHandoff("/tmp/x", "x", baseIo({
      fetch: async () => jsonRes({ hello: "nginx" }),
      detachSpawn: () => { detached.push(1); },
    })),
  ).rejects.toThrow(/not DeepSeek Harness/);
  expect(detached).toHaveLength(0);
});

test("冷启动超时：描述性错误，不无限挂", async () => {
  let t = 0;
  await expect(
    launchDshWebHandoff("/tmp/x", "x", baseIo({
      fetch: async () => { throw new Error("fetch failed"); },
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
      sleep: async (ms) => { t += ms; },
      now: () => t,
      readyTimeoutMs: 20_000,
      pollIntervalMs: 250,
    })),
  ).rejects.toThrow(/not DeepSeek Harness/);
  expect(t).toBeLessThan(20_000);
});
