import { test, expect } from "bun:test";
import { scheduleDaemonStop, __resetShutdownForTests } from "../src/shutdown";

test("scheduleDaemonStop：回包后再 unload + exit，重复调用不排第二次", async () => {
  __resetShutdownForTests();
  const calls: string[] = [];
  scheduleDaemonStop({
    afterMs: 5,
    unloadKeepAlive: () => calls.push("unload"),
    exit: () => calls.push("exit"),
  });
  scheduleDaemonStop({
    afterMs: 5,
    unloadKeepAlive: () => calls.push("unload2"),
    exit: () => calls.push("exit2"),
  });
  expect(calls).toEqual([]);
  await new Promise((r) => setTimeout(r, 20));
  expect(calls).toEqual(["unload", "exit"]);
  __resetShutdownForTests();
});
