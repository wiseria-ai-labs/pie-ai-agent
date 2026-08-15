import { dispatchCaptureVisibleTab, type CaptureContext, type CaptureOutcome } from "./screenshot";

export type SeekMediaResult = {
  ok: boolean;
  reason?: "no_video" | "seek_failed" | "seek_timeout";
  currentTime?: number;
  duration?: number | null;
  paused?: boolean;
  videoWidth?: number;
  videoHeight?: number;
};

type CaptureFailReason = Extract<CaptureOutcome, { ok: false }>["reason"];
type CaptureOk = Extract<CaptureOutcome, { ok: true }>;

export type VideoFrameOutcome =
  | { ok: true; value: CaptureOk["value"]; meta: { currentTime: number; duration: number | null } }
  | {
      ok: false;
      reason: CaptureFailReason | "no_video" | "seek_failed" | "seek_timeout" | "blank_or_drm_frame";
      meta?: { currentTime?: number; duration?: number | null };
    };

/**
 * Injected via executeScript — MUST be self-contained (no closures).
 * Picks the largest <video> in this frame, optionally seeks, waits for seeked.
 */
export function seekPrimaryMedia(timeSeconds: number | null): Promise<SeekMediaResult> | SeekMediaResult {
  const videos = Array.from(document.querySelectorAll("video"));
  if (videos.length === 0) return { ok: false, reason: "no_video" };

  let best = videos[0]!;
  let bestArea = -1;
  for (const v of videos) {
    const r = v.getBoundingClientRect();
    const area = Math.max(0, r.width) * Math.max(0, r.height);
    const px = (v.videoWidth || 0) * (v.videoHeight || 0);
    const score = area > 0 ? area : px;
    if (score >= bestArea) {
      best = v;
      bestArea = score;
    }
  }

  const duration = Number.isFinite(best.duration) ? best.duration : null;
  const snapshot = (): SeekMediaResult => ({
    ok: true,
    currentTime: best.currentTime,
    duration,
    paused: best.paused,
    videoWidth: best.videoWidth,
    videoHeight: best.videoHeight,
  });

  if (timeSeconds == null || !Number.isFinite(timeSeconds)) return snapshot();

  const target =
    duration != null && duration > 0
      ? Math.max(0, Math.min(timeSeconds, Math.max(0, duration - 0.05)))
      : Math.max(0, timeSeconds);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: SeekMediaResult) => {
      if (settled) return;
      settled = true;
      best.removeEventListener("seeked", onSeeked);
      best.removeEventListener("error", onError);
      resolve(result);
    };
    const onSeeked = () => finish(snapshot());
    const onError = () => finish({ ok: false, reason: "seek_failed", currentTime: best.currentTime, duration });
    best.addEventListener("seeked", onSeeked);
    best.addEventListener("error", onError);
    try {
      best.currentTime = target;
    } catch {
      finish({ ok: false, reason: "seek_failed", currentTime: best.currentTime, duration });
      return;
    }
    setTimeout(() => {
      if (Math.abs(best.currentTime - target) < 1.25) finish(snapshot());
      else finish({ ok: false, reason: "seek_timeout", currentTime: best.currentTime, duration });
    }, 4000);
  });
}

/** Sample a JPEG/PNG blob down to 16×16 and treat near-black as DRM / unpainted. */
export async function isMostlyBlackImage(blob: Blob, threshold = 14): Promise<boolean> {
  try {
    const bmp = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(16, 16);
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    ctx.drawImage(bmp, 0, 0, 16, 16);
    const data = ctx.getImageData(0, 0, 16, 16).data;
    let sum = 0;
    const pixels = data.length / 4;
    for (let i = 0; i < data.length; i += 4) sum += data[i]! + data[i + 1]! + data[i + 2]!;
    return sum / (pixels * 3) < threshold;
  } catch {
    return false;
  }
}

function pickBestSeek(results: Array<SeekMediaResult | undefined>): SeekMediaResult {
  const found = results.filter((r): r is SeekMediaResult => !!r);
  const ok = found.filter((r) => r.ok);
  if (ok.length === 0) return found[0] ?? { ok: false, reason: "no_video" };
  return ok.sort((a, b) => (b.videoWidth ?? 0) * (b.videoHeight ?? 0) - (a.videoWidth ?? 0) * (a.videoHeight ?? 0))[0]!;
}

export async function dispatchCaptureVideoFrame(
  ctx: CaptureContext,
  args: { timeSeconds?: unknown } = {},
): Promise<VideoFrameOutcome> {
  const raw = args.timeSeconds;
  const timeSeconds =
    raw === undefined || raw === null
      ? null
      : typeof raw === "number" && Number.isFinite(raw)
        ? raw
        : null;
  if (raw !== undefined && raw !== null && timeSeconds === null) {
    return { ok: false, reason: "seek_failed" };
  }

  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(ctx.pinnedTabId);
  } catch {
    return { ok: false, reason: "pinned-tab-not-visible" };
  }
  if (!tab.active) return { ok: false, reason: "pinned-tab-not-visible" };

  let injections: Array<{ result?: SeekMediaResult }> = [];
  try {
    injections = (await chrome.scripting.executeScript({
      target: { tabId: ctx.pinnedTabId, allFrames: true },
      func: seekPrimaryMedia,
      args: [timeSeconds],
    })) as Array<{ result?: SeekMediaResult }>;
  } catch {
    return { ok: false, reason: "no_video" };
  }

  const seek = pickBestSeek(injections.map((r) => r.result));
  if (!seek.ok) {
    return {
      ok: false,
      reason: seek.reason ?? "no_video",
      meta: { currentTime: seek.currentTime, duration: seek.duration ?? null },
    };
  }

  const capture = await dispatchCaptureVisibleTab(ctx);
  if (!capture.ok) return capture;

  const bytes = atob(capture.value.data);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  const blob = new Blob([arr], { type: capture.value.mediaType });
  if (await isMostlyBlackImage(blob)) {
    return {
      ok: false,
      reason: "blank_or_drm_frame",
      meta: { currentTime: seek.currentTime, duration: seek.duration ?? null },
    };
  }

  return {
    ok: true,
    value: capture.value,
    meta: { currentTime: seek.currentTime ?? 0, duration: seek.duration ?? null },
  };
}
