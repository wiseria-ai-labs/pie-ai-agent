import { test, expect } from "bun:test";
import { runCli } from "../src/cli";

test("unknown subcommand returns non-zero", async () => {
  const code = await runCli(["bogus"]);
  expect(code).not.toBe(0);
});

test("doctor subcommand runs and returns 0 or 1", async () => {
  const code = await runCli(["doctor"]);
  expect([0, 1]).toContain(code);
});

test("doctor --json prints a valid { ok, checks } object to stdout", async () => {
  const captured: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => captured.push(a.map(String).join(" "));
  try {
    const code = await runCli(["doctor", "--json"]);
    expect([0, 1]).toContain(code);
  } finally {
    console.log = orig;
  }
  // Exactly one JSON line on stdout (human-readable lines go to stderr).
  expect(captured.length).toBe(1);
  const parsed = JSON.parse(captured[0]);
  expect(typeof parsed.ok).toBe("boolean");
  expect(Array.isArray(parsed.checks)).toBe(true);
});
