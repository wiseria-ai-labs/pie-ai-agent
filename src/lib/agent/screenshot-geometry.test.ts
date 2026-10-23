import { beforeEach, describe, expect, it } from "vitest";
import {
  __clearScreenshotGeometryForTest,
  GEOMETRY_TTL_MS,
  getScreenshotGeometry,
  invalidateScreenshotGeometry,
  mapScreenshotPoint,
  recordScreenshotGeometry,
  type ScreenshotGeometry,
  type ViewportProbe,
} from "./screenshot-geometry";

const T0 = 1_000_000;

function probe(over: Partial<ViewportProbe> = {}): ViewportProbe {
  return { url: "https://docs.google.com/document/d/x/edit", cssWidth: 1280, cssHeight: 720, dpr: 1, scrollX: 0, scrollY: 0, ...over };
}

function geometry(over: Partial<ScreenshotGeometry> = {}): ScreenshotGeometry {
  return { ...probe(), imageWidth: 1280, imageHeight: 720, capturedAt: T0, ...over };
}

beforeEach(() => __clearScreenshotGeometryForTest());

describe("mapScreenshotPoint — coordinate mapping", () => {
  it("DPR 1, image resized (1920 css → 1568 px): scales up to CSS px", () => {
    // 1920x1080 viewport at DPR 1 → raw 1920x1080 → resized to 1568x882.
    const g = geometry({ cssWidth: 1920, cssHeight: 1080, imageWidth: 1568, imageHeight: 882 });
    const r = mapScreenshotPoint(g, { x: 784, y: 441 }, probe({ cssWidth: 1920, cssHeight: 1080 }), T0);
    expect(r).toEqual({ ok: true, x: 960, y: 540 });
  });

  it("DPR 2: raw capture is 2× the viewport, mapping still lands on CSS px", () => {
    // 1440x900 CSS at DPR 2 → raw 2880x1800 → resized to 1568x980.
    const g = geometry({ cssWidth: 1440, cssHeight: 900, dpr: 2, imageWidth: 1568, imageHeight: 980 });
    const r = mapScreenshotPoint(g, { x: 1568 / 4, y: 980 / 2 }, probe({ cssWidth: 1440, cssHeight: 900, dpr: 2 }), T0);
    expect(r).toEqual({ ok: true, x: 360, y: 450 });
  });

  it("no resize (image == viewport) is the identity", () => {
    const r = mapScreenshotPoint(geometry(), { x: 100, y: 200 }, probe(), T0);
    expect(r).toEqual({ ok: true, x: 100, y: 200 });
  });

  it("the far edge is clamped inside the viewport", () => {
    const r = mapScreenshotPoint(geometry(), { x: 1280, y: 720 }, probe(), T0);
    expect(r).toEqual({ ok: true, x: 1279, y: 719 });
  });

  it.each([
    [-1, 10],
    [10, -1],
    [1281, 10],
    [10, 721],
    [Number.NaN, 10],
  ])("out of bounds (%s,%s) → error", (x, y) => {
    const r = mapScreenshotPoint(geometry(), { x, y }, probe(), T0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/outside the screenshot/);
  });
});

describe("mapScreenshotPoint — staleness", () => {
  it("no geometry → tells the model to take capture_visible_tab", () => {
    const r = mapScreenshotPoint(undefined, { x: 1, y: 1 }, probe(), T0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/take capture_visible_tab again/i);
  });

  it("expires after the TTL", () => {
    expect(mapScreenshotPoint(geometry(), { x: 1, y: 1 }, probe(), T0 + GEOMETRY_TTL_MS).ok).toBe(true);
    const r = mapScreenshotPoint(geometry(), { x: 1, y: 1 }, probe(), T0 + GEOMETRY_TTL_MS + 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("take capture_visible_tab again");
  });

  it.each([
    ["navigation", { url: "https://docs.google.com/document/d/other/edit" }, /navigated/],
    ["resize", { cssWidth: 1000 }, /resized/],
    ["window scroll", { scrollY: 300 }, /scrolled/],
  ] as const)("%s since capture → error", (_label, over, re) => {
    const r = mapScreenshotPoint(geometry(), { x: 1, y: 1 }, probe(over), T0);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(re);
      expect(r.error).toContain("take capture_visible_tab again");
    }
  });

  it("probe failure → error (can't verify)", () => {
    const r = mapScreenshotPoint(geometry(), { x: 1, y: 1 }, null, T0);
    expect(r.ok).toBe(false);
  });
});

describe("geometry store", () => {
  it("is keyed per session + tab and can be invalidated", () => {
    recordScreenshotGeometry("S1", 7, geometry());
    expect(getScreenshotGeometry("S1", 7)).toBeDefined();
    expect(getScreenshotGeometry("S2", 7)).toBeUndefined();
    expect(getScreenshotGeometry("S1", 8)).toBeUndefined();
    invalidateScreenshotGeometry("S1", 7);
    expect(getScreenshotGeometry("S1", 7)).toBeUndefined();
  });
});
