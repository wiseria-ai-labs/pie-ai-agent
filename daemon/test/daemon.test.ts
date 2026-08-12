import { test, expect } from "bun:test";
import { unlinkSync } from "node:fs";
import { handleMessage, pipeAlreadyServed, processSocketChunk } from "../src/daemon";
import { PROTOCOL_VERSION } from "../../src/types/local-bridge";
import { setLogEnabled } from "../src/log";

setLogEnabled(false); // hermetic：不让 handleMessage 的 log 写真实 ~/.pie/logs

test("hello returns protocolVersion + capabilities", async () => {
  const out = await handleMessage(
    JSON.stringify({ id: "1", method: "hello", params: { protocolVersion: PROTOCOL_VERSION } }),
  );
  const res = JSON.parse(out);
  expect(res.id).toBe("1");
  expect(res.ok).toBe(true);
  expect(res.result.protocolVersion).toBe(PROTOCOL_VERSION);
  expect(res.result.capabilities).toContain("run_local_agent");
  expect(res.result.capabilities).toContain("handoff_to_agent");
});

test("unknown method returns structured error", async () => {
  const out = await handleMessage(JSON.stringify({ id: "2", method: "nope", params: {} }));
  const res = JSON.parse(out);
  expect(res.ok).toBe(false);
  expect(res.error.code).toBe("unknown_method");
});

// #403：check_update 是 dispatch 里认得的 method（真实网络在单测里必然失败 → 结构化
// 错误，而不是回 unknown_method）。证明布线在，且失败走 check_update_failed 而非泄漏。
test("check_update is a known method (network failure → structured error, not unknown_method)", async () => {
  const out = await handleMessage(JSON.stringify({ id: "u1", method: "check_update", params: {} }));
  const res = JSON.parse(out);
  expect(res.id).toBe("u1");
  if (res.ok) {
    // 若测试环境恰好能出网并命中 latest.json，结果形状也必须合规。
    expect(typeof res.result.current).toBe("string");
    expect(typeof res.result.supported).toBe("boolean");
  } else {
    expect(res.error.code).toBe("check_update_failed");
  }
});

// apply_update 同理是认得的 method；非 macOS / 校验失败都走 apply_update_failed，
// 绝不回 unknown_method。
test("apply_update is a known method (aborts with structured error, not unknown_method)", async () => {
  const out = await handleMessage(JSON.stringify({ id: "u2", method: "apply_update", params: {} }));
  const res = JSON.parse(out);
  expect(res.id).toBe("u2");
  expect(res.ok).toBe(false);
  expect(res.error.code).toBe("apply_update_failed");
});

// ── D10 版本闸：v1 客户端拒 run_skill_script（授权模型破坏，引导升级扩展）───────
test("run_skill_script from a v1 client is rejected with protocol_too_old", async () => {
  const out = await handleMessage(
    JSON.stringify({ id: "p1", method: "run_skill_script", params: { name: "x", entry: "y.ts", sessionId: "s" } }),
    { clientProtocol: 1 },
  );
  const res = JSON.parse(out);
  expect(res.ok).toBe(false);
  expect(res.error.code).toBe("protocol_too_old");
  expect(res.error.message).toMatch(/update/i);
});

test("run_skill_script from a current client passes the version gate (falls through to real dispatch)", async () => {
  // clientProtocol = 当前版本 → 不被版本闸拦；skill 不存在 → 走到真实执行报 unknown_skill
  // （证明闸放行了、错误来自下游而非版本判定）。
  const out = await handleMessage(
    JSON.stringify({ id: "p2", method: "run_skill_script", params: { name: "nope-skill", entry: "y.ts", sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" } }),
    { clientProtocol: PROTOCOL_VERSION },
  );
  const res = JSON.parse(out);
  expect(res.ok).toBe(false);
  expect(res.error.code).not.toBe("protocol_too_old");
});

test("processSocketChunk threads the hello protocolVersion into subsequent run_skill_script (v1 → rejected)", async () => {
  const written: string[] = [];
  // hello(v1) + run_skill_script in one chunk; the run must see clientProtocol=1 and be rejected.
  const chunk =
    JSON.stringify({ id: "h", method: "hello", params: { protocolVersion: 1 } }) +
    "\n" +
    JSON.stringify({ id: "r", method: "run_skill_script", params: { name: "x", entry: "y.ts", sessionId: "s" } }) +
    "\n";
  const { pending, clientProtocol } = processSocketChunk("", chunk, (out) => written.push(out));
  await pending;
  expect(clientProtocol).toBe(1);
  const runResp = written.map((w) => JSON.parse(w)).find((r) => r.id === "r");
  expect(runResp.ok).toBe(false);
  expect(runResp.error.code).toBe("protocol_too_old");
});

// Finding 2: Unix STREAM socket doesn't preserve message boundaries — a
// request's JSON can be split across two `data` events. Without per-connection
// carry buffering, each half-line fails JSON.parse independently and the
// caller's request never resolves. processSocketChunk is the pure, testable
// core of the socket `data` handler wired in startDaemon().
test("processSocketChunk: a line split across two chunks dispatches exactly once, after reassembly", async () => {
  const written: string[] = [];
  let carry = "";

  // First chunk: request JSON cut mid-method-name, no trailing newline yet —
  // must NOT dispatch anything.
  const r1 = processSocketChunk(carry, '{"id":"x","method":"hel', (out) => written.push(out));
  carry = r1.carry;
  await r1.pending;
  expect(written).toHaveLength(0);
  expect(carry).toBe('{"id":"x","method":"hel');

  // Second chunk completes the line — now it must dispatch exactly once, and
  // handleMessage must see the fully reassembled JSON (a valid `hello`).
  const r2 = processSocketChunk(carry, 'lo","params":{"protocolVersion":1}}\n', (out) => written.push(out));
  carry = r2.carry;
  await r2.pending;

  expect(carry).toBe("");
  expect(written).toHaveLength(1);
  const res = JSON.parse(written[0]);
  expect(res.id).toBe("x");
  expect(res.ok).toBe(true);
  expect(res.result.protocolVersion).toBe(PROTOCOL_VERSION);
});

test("processSocketChunk: two complete lines in one chunk both dispatch, in order", async () => {
  const written: string[] = [];
  const chunk = '{"id":"a","method":"hello","params":{}}\n{"id":"b","method":"nope","params":{}}\n';
  const { carry, pending } = processSocketChunk("", chunk, (out) => written.push(out));
  await pending;
  expect(carry).toBe("");
  expect(written).toHaveLength(2);
  expect(JSON.parse(written[0]).id).toBe("a");
  expect(JSON.parse(written[1]).id).toBe("b");
});

test("processSocketChunk: independent carry state per connection (no cross-talk)", async () => {
  const writtenA: string[] = [];
  const writtenB: string[] = [];

  // Connection A sends a partial line...
  const a1 = processSocketChunk("", '{"id":"conn-a","method":"hel', (out) => writtenA.push(out));
  await a1.pending;
  // ...while connection B, with its own independent carry, sends a totally
  // different partial line. Passing "" (B's own fresh carry) proves the two
  // don't share state — a shared/global carry would corrupt one with the other.
  const b1 = processSocketChunk("", '{"id":"conn-b","method":"wor', (out) => writtenB.push(out));
  await b1.pending;

  expect(writtenA).toHaveLength(0);
  expect(writtenB).toHaveLength(0);

  const a2 = processSocketChunk(a1.carry, 'lo","params":{"protocolVersion":1}}\n', (out) => writtenA.push(out));
  await a2.pending;
  const b2 = processSocketChunk(b1.carry, 'ld","params":{}}\n', (out) => writtenB.push(out));
  await b2.pending;

  expect(writtenA).toHaveLength(1);
  expect(JSON.parse(writtenA[0]).id).toBe("conn-a");
  expect(writtenB).toHaveLength(1);
  expect(JSON.parse(writtenB[0]).id).toBe("conn-b");
});

test("hello advertises list_agents capability", async () => {
  const out = JSON.parse(
    await handleMessage(
      JSON.stringify({ id: "la0", method: "hello", params: { protocolVersion: PROTOCOL_VERSION } }),
    ),
  );
  expect(out.result.capabilities).toContain("list_agents");
});

test("list_agents returns ALL candidates with installed flag (shape only — detection machine-dependent)", async () => {
  const out = JSON.parse(
    await handleMessage(JSON.stringify({ id: "la1", method: "list_agents", params: {} })),
  );
  expect(out.ok).toBe(true);
  // 全部候选恒定返回（未安装的也在，settings 页靠它渲染"未安装"态）
  expect(out.result.agents.map((a: { id: string }) => a.id)).toEqual([
    "claude-app",
    "claude-terminal",
    "codex-app",
    "codex-terminal",
    "cursor-app",
    "cursor-terminal",
    "opencode-terminal",
    "pi-terminal",
  ]);
  for (const a of out.result.agents) {
    expect(typeof a.label).toBe("string");
    expect(typeof a.installed).toBe("boolean");
    expect(["app", "terminal"]).toContain(a.kind); // #270: wire 加法字段
    expect(typeof a.headless).toBe("boolean"); // #307: run_local_agent 后端可选性
  }
  // headless 恰为「terminal 候选」（app 无 CLI）——run_local_agent 卡片据此选后端。
  const byId = Object.fromEntries(
    out.result.agents.map((a: { id: string; headless: boolean }) => [a.id, a.headless]),
  );
  expect(byId["claude-terminal"]).toBe(true);
  expect(byId["opencode-terminal"]).toBe(true);
  expect(byId["pi-terminal"]).toBe(true);
  expect(byId["claude-app"]).toBe(false);
  expect(byId["codex-app"]).toBe(false);
  expect(byId["cursor-app"]).toBe(false);
});

// ── makeBackpressureWriter ──────────────────────────────────────────────────
// 真机案例：32 个 ~/.agents skill 的 list_skills 响应 >8KB，裸 socket.write
// 只送出首个内核缓冲块（8192B），余量被丢弃 → 客户端永远收不到完整行。
// 写出器必须缓存余量并在 drain 时续写，且按字节切（响应含多字节 UTF-8）。

import { makeBackpressureWriter } from "../src/daemon";

/** fake socket：每次 write 最多吞 capacity 字节，收到的字节全记账 */
function fakeSocket(capacity: number) {
  const chunks: Uint8Array[] = [];
  return {
    received: () => {
      const total = chunks.reduce((a, c) => a + c.length, 0);
      const all = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { all.set(c, off); off += c.length; }
      return new TextDecoder().decode(all);
    },
    write: (bytes: Uint8Array) => {
      const n = Math.min(bytes.length, capacity);
      chunks.push(bytes.slice(0, n));
      return n;
    },
  };
}

test("backpressure writer: partial write queues remainder, drain delivers the rest byte-exact", () => {
  const sock = fakeSocket(8192);
  const w = makeBackpressureWriter(sock.write);
  const big = JSON.stringify({ id: "t", result: { skills: Array.from({ length: 40 }, (_, i) => ({ name: `skill-${i}`, description: "描述——多字节🥧".repeat(20) })) } }) + "\n";
  w.write(big);
  expect(w.pendingBytes()).toBeGreaterThan(0); // 首块之外的余量在排队
  while (w.pendingBytes() > 0) w.drain(); // 每次 drain 模拟一次内核缓冲腾空
  expect(sock.received()).toBe(big); // 逐字节还原，多字节字符未被切坏
});

test("backpressure writer: writes while backlogged stay queued and keep order", () => {
  const sock = fakeSocket(10);
  const w = makeBackpressureWriter(sock.write);
  w.write("first-response\n");
  w.write("second-response\n"); // 有积压：只排队，不与余量交错
  while (w.pendingBytes() > 0) w.drain();
  expect(sock.received()).toBe("first-response\nsecond-response\n");
});

test("backpressure writer: small write with room passes straight through", () => {
  const sock = fakeSocket(8192);
  const w = makeBackpressureWriter(sock.write);
  w.write("ok\n");
  expect(w.pendingBytes()).toBe(0);
  expect(sock.received()).toBe("ok\n");
});

test("pipeAlreadyServed：无人监听时为 false，有人监听时为 true", async () => {
  const path = `/tmp/pie-probe-${process.pid}.sock`;
  expect(await pipeAlreadyServed(path)).toBe(false); // 没有这个端点

  const server = Bun.listen({ unix: path, socket: { data() {} } });
  try {
    expect(await pipeAlreadyServed(path)).toBe(true);
  } finally {
    server.stop(true);
    try {
      unlinkSync(path);
    } catch {
      /* 已被 stop 清掉 */
    }
  }
});
