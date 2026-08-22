import { test, expect, beforeAll } from "bun:test";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { claimIpc, pipeAlreadyServed } from "../src/ipc-listen";
import { computePaths, type Paths } from "../src/paths";
import { setLogEnabled } from "../src/log";

beforeAll(() => setLogEnabled(false));

function unixPaths(ipcPath: string): Paths {
  return {
    ...computePaths("darwin", "/tmp/pie-claim-unused"),
    ipcPath,
    socketPath: ipcPath,
    isPipe: false,
  };
}

function uniqueSock(tag: string): string {
  return `/tmp/pie-claim-${process.pid}-${tag}-${Math.random().toString(16).slice(2)}.sock`;
}

function rmSock(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* 可能已被 stop / claim 清掉 */
  }
}

test("Bun.listen 在 unix socket 上会静默 unlink 抢占，不抛 EADDRINUSE", async () => {
  const path = uniqueSock("steal");
  rmSock(path);
  const a = Bun.listen({ unix: path, socket: { data() {} } });
  let b: ReturnType<typeof Bun.listen> | undefined;
  try {
    // 后来者成功 listen = 把路径抢走；先来者变成不可达僵尸。这就是 mac 互斥不能靠 EADDRINUSE 的事实。
    b = Bun.listen({ unix: path, socket: { data() {} } });
    expect(await pipeAlreadyServed(path)).toBe(true);
  } finally {
    b?.stop(true);
    a.stop(true);
    rmSock(path);
  }
});

test("claimIpc unix：活体在听 → already_running，且原 socket 仍可达", async () => {
  const path = uniqueSock("live");
  rmSock(path);
  const a = Bun.listen({ unix: path, socket: { data() {} } });
  try {
    expect(await claimIpc(unixPaths(path))).toBe("already_running");
    expect(existsSync(path)).toBe(true);
    expect(await pipeAlreadyServed(path)).toBe(true);
  } finally {
    a.stop(true);
    rmSock(path);
  }
});

test("claimIpc unix：只剩陈尸文件（无进程）→ ready 并清掉文件，后续可接管", async () => {
  const path = uniqueSock("stale");
  rmSock(path);
  const corpse = Bun.listen({ unix: path, socket: { data() {} } });
  corpse.stop(true);
  if (!existsSync(path)) writeFileSync(path, "");
  expect(existsSync(path)).toBe(true);
  expect(await pipeAlreadyServed(path)).toBe(false);

  expect(await claimIpc(unixPaths(path))).toBe("ready");
  expect(existsSync(path)).toBe(false);

  const b = Bun.listen({ unix: path, socket: { data() {} } });
  try {
    expect(await pipeAlreadyServed(path)).toBe(true);
  } finally {
    b.stop(true);
    rmSock(path);
  }
});

test("claimIpc unix：没有 socket 文件 → ready", async () => {
  const path = uniqueSock("absent");
  rmSock(path);
  expect(await claimIpc(unixPaths(path))).toBe("ready");
  expect(existsSync(path)).toBe(false);
});

test("claimIpc pipe 分支：连得上 → already_running；连不上 → ready（主判定仍是探活）", async () => {
  const path = uniqueSock("pipe-shape");
  rmSock(path);
  const pipeShape = (ipcPath: string): Paths => ({ ...unixPaths(ipcPath), isPipe: true });

  expect(await claimIpc(pipeShape(path))).toBe("ready");

  const a = Bun.listen({ unix: path, socket: { data() {} } });
  try {
    expect(await claimIpc(pipeShape(path))).toBe("already_running");
    expect(existsSync(path)).toBe(true);
  } finally {
    a.stop(true);
    rmSock(path);
  }
});
