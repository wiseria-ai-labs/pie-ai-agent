// src/lib/recipes/pacing.ts

/**
 * Returns a random delay (ms) between min and max using the provided rng.
 * rng defaults to Math.random; inject a deterministic rng for tests.
 */
export function jitterDelay(rng: () => number = Math.random, min = 800, max = 2400): number {
  return Math.floor(min + (max - min) * rng());
}

/**
 * Waits for ms milliseconds using the provided sleep implementation.
 * sleep defaults to setTimeout; inject a mock for tests.
 */
export async function pace(
  ms: number,
  sleep: (m: number) => Promise<void> = (m) => new Promise((r) => setTimeout(r, m)),
): Promise<void> {
  await sleep(ms);
}
