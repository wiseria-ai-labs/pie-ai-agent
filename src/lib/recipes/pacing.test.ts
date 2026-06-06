import { describe, it, expect, vi } from "vitest";
import { jitterDelay, pace } from "./pacing";

describe("jitterDelay", () => {
  it("rng=()=>0 returns min (800)", () => {
    expect(jitterDelay(() => 0)).toBe(800);
  });

  it("rng=()=>0.999 returns close to max (2400)", () => {
    const val = jitterDelay(() => 0.999);
    // floor(800 + (2400-800)*0.999) = floor(800 + 1598.4) = 2398
    expect(val).toBeGreaterThanOrEqual(2390);
    expect(val).toBeLessThanOrEqual(2400);
  });

  it("rng=()=>0.5 returns midpoint", () => {
    const val = jitterDelay(() => 0.5);
    expect(val).toBe(1600);
  });

  it("custom min/max respected", () => {
    expect(jitterDelay(() => 0, 100, 200)).toBe(100);
    expect(jitterDelay(() => 1, 100, 200)).toBe(200);
  });
});

describe("pace", () => {
  it("calls sleep with provided ms", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    await pace(1234, sleep);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(1234);
  });

  it("awaits sleep completion", async () => {
    let resolved = false;
    const sleep = vi.fn().mockImplementation(() => new Promise<void>((r) => setTimeout(() => { resolved = true; r(); }, 0)));
    await pace(0, sleep);
    expect(resolved).toBe(true);
  });
});
