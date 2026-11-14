// Overlay memory prefetch (spec §5.5).
//
// The overlay starts a pick the moment it opens (page title / URL / selection)
// — the user's typing time is the budget. At send time the result is reused
// when the typed task still looks like the prefetched one; a very different
// task means the pick is stale, so one more pick runs with the real text.
//
// Pure helpers only: the caller owns the actual `startMemoryPrefetch` call.

/** How long send may block on the pick before giving up (ms). */
export const MEMORY_SEND_WAIT_MS = 1200;

const CJK_RE = /[㐀-鿿豈-﫿]/;

/** Latin words + CJK character bigrams — works for both script families. */
function tokenSet(text: string): Set<string> {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  // Latin / digits: word runs of length ≥ 2.
  for (const m of lower.matchAll(/[a-z0-9]{2,}/g)) out.add(m[0]!);
  // CJK: bigrams (unigrams would overlap almost everything).
  const cjk = Array.from(lower).filter((ch) => CJK_RE.test(ch));
  for (let i = 0; i + 1 < cjk.length; i++) out.add(cjk[i]! + cjk[i + 1]!);
  if (cjk.length === 1 && out.size === 0) out.add(cjk[0]!);
  return out;
}

/** Jaccard overlap of the two task texts. */
export function taskSimilarity(a: string, b: string): number {
  const A = tokenSet(a);
  const B = tokenSet(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Reuse the prefetched pick unless the typed task shares NOTHING with what the
 * prefetch was asked about (spec: "任务文本差异大时再补跑一次"). The bar is
 * deliberately low: the prefetch ran on the page/selection the user is looking
 * at, and a short instruction about the same subject only overlaps a little.
 * A clearly unrelated question (no shared content token) is what a rerun is
 * for; the chip's "不对" is the user-facing correction for a bad reuse.
 */
export function shouldReuseMemoryPick(prefetchedTask: string, typedTask: string): boolean {
  if (!prefetchedTask.trim()) return false;
  const a = prefetchedTask.trim();
  const b = typedTask.trim();
  if (a === b) return true;
  return taskSimilarity(a, b) > 0;
}
