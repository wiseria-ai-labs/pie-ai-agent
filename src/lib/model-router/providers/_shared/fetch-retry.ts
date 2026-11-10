// Transient-error retry for the hand-rolled fetch providers (openai-compat
// core, openai /v1/responses, native Gemini). Anthropic-wire providers go
// through @anthropic-ai/sdk, whose built-in `maxRetries` (default 2) already
// covers 408/409/429/5xx + connection errors with Retry-After — not wrapped
// here to avoid double retry.
//
// Retries happen only around the initial request: once a 2xx response is
// returned the caller starts reading the stream, and nothing is replayed.

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
/** 429 bodies that mean "quota gone", not "slow down": retrying just delays the error. */
const NON_RETRYABLE_429 = /PerDay|per_day|insufficient_quota|exceeded_current_quota|budget_exceeded/i;
const MAX_RETRY_AFTER_MS = 30_000;

/** setTimeout that rejects with the abort reason the moment `signal` aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(signal!.reason); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export const retryTiming = {
  maxRetries: 3,
  baseMs: 1000,
  /** Overridden to a no-op in src/test/setup.ts so the suite never waits. */
  sleep: abortableSleep,
};

/** Retry-After in ms (delta-seconds or HTTP-date), capped at 30 s; undefined if absent/unparseable. */
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(value) - Date.now();
  if (!Number.isFinite(ms)) return undefined;
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

async function isRetryable(response: Response): Promise<boolean> {
  if (!RETRYABLE_STATUS.has(response.status)) return false;
  if (response.status !== 429) return true;
  const text = await response.clone().text().catch(() => "");
  return !NON_RETRYABLE_429.test(text);
}

/**
 * fetch with up to `retryTiming.maxRetries` retries on 429/5xx/network errors,
 * exponential backoff + jitter, honoring Retry-After. Returns the final
 * Response (possibly non-ok, body unread); throws the final network error or
 * the abort reason — callers keep their existing `catch → if aborted return` path.
 */
export async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  const signal = init.signal ?? undefined;
  for (let attempt = 0; ; attempt++) {
    let response: Response | undefined;
    let error: unknown;
    try {
      response = await fetch(url, init);
    } catch (e) {
      if (signal?.aborted) throw e;
      error = e;
    }
    const last = attempt >= retryTiming.maxRetries;
    if (response && (last || !(await isRetryable(response)))) return response;
    if (!response && last) throw error;
    const backoff = retryTiming.baseMs * 2 ** attempt * (0.5 + Math.random() / 2);
    const delay = (response && parseRetryAfter(response.headers.get("retry-after"))) ?? backoff;
    await response?.body?.cancel().catch(() => {});
    await retryTiming.sleep(delay, signal);
  }
}
