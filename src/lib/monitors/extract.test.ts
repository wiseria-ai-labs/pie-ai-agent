import { describe, expect, it, vi } from "vitest";
import {
  classifyHttpFailure,
  extractDirect,
  looksLikeBlockedPage,
  looksLikeLoginUrl,
  type FetchDeps,
} from "./extract";
import type { MonitorTarget } from "./types";

const target: MonitorTarget = { selector: ".price", sample: "¥2,399" };

function deps(over: Partial<FetchDeps> = {}): FetchDeps {
  return {
    fetchImpl: vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        url: "https://shop.example.com/item/1",
        text: async () => '<div class="price">¥1,999</div>',
      }) as unknown as Response,
    ) as unknown as typeof fetch,
    extract: vi.fn(async () => ({ found: true, via: "selector" as const, text: "¥1,999" })),
    ...over,
  };
}

describe("looksLikeLoginUrl", () => {
  it("recognizes common login paths and hosts", () => {
    expect(looksLikeLoginUrl("https://x.com/login")).toBe(true);
    expect(looksLikeLoginUrl("https://x.com/users/sign_in")).toBe(true);
    expect(looksLikeLoginUrl("https://passport.example.com/")).toBe(true);
    expect(looksLikeLoginUrl("https://x.com/products/123")).toBe(false);
    expect(looksLikeLoginUrl("not a url")).toBe(false);
  });
});

describe("classifyHttpFailure", () => {
  it("maps statuses to the pause taxonomy", () => {
    expect(classifyHttpFailure(401, "https://x/", "https://x/")).toBe("login");
    expect(classifyHttpFailure(403, "https://x/", "https://x/")).toBe("login");
    expect(classifyHttpFailure(429, "https://x/", "https://x/")).toBe("blocked");
    expect(classifyHttpFailure(503, "https://x/", "https://x/")).toBe("network");
    expect(classifyHttpFailure(200, "https://x/", "https://x/")).toBeNull();
  });

  it("flags a redirect that lands on a login page", () => {
    expect(classifyHttpFailure(200, "https://x.com/login?next=1", "https://x.com/cart")).toBe("login");
    // Landing somewhere else that isn't a login page is not a failure.
    expect(classifyHttpFailure(200, "https://x.com/item/1", "https://x.com/item/1")).toBeNull();
  });
});

describe("looksLikeBlockedPage", () => {
  it("detects verification walls", () => {
    expect(looksLikeBlockedPage("<html><body>Checking your browser…")).toBe(true);
    expect(looksLikeBlockedPage("<html><body>Just a moment…")).toBe(true);
    expect(looksLikeBlockedPage("<html><body>welcome")).toBe(false);
  });
});

describe("extractDirect", () => {
  it("returns the extracted value in direct mode", async () => {
    const d = deps();
    const r = await extractDirect("https://shop.example.com/item/1", target, d);
    expect(r).toEqual({ ok: true, value: "¥1,999", via: "selector", fetchMode: "direct" });
    expect(d.fetchImpl).toHaveBeenCalledWith(
      "https://shop.example.com/item/1",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("does not classify a page as blocked when the target was found", async () => {
    const d = deps({
      fetchImpl: (async () =>
        ({
          ok: true,
          status: 200,
          url: "https://x/",
          text: async () => "captcha explained in this help article",
        }) as unknown as Response) as unknown as typeof fetch,
    });
    const r = await extractDirect("https://x/", target, d);
    expect(r.ok).toBe(true);
  });

  it("reports not_found when the DOM has no match", async () => {
    const d = deps({
      extract: vi.fn(async () => ({ found: false, via: null, text: "" })),
    });
    const r = await extractDirect("https://x/", target, d);
    expect(r).toEqual({ ok: false, reason: "not_found", detail: expect.any(String) });
  });

  it("reports blocked only after extraction failed", async () => {
    const d = deps({
      fetchImpl: (async () =>
        ({
          ok: true,
          status: 200,
          url: "https://x/",
          text: async () => "Checking your browser before accessing",
        }) as unknown as Response) as unknown as typeof fetch,
      extract: vi.fn(async () => ({ found: false, via: null, text: "" })),
    });
    const r = await extractDirect("https://x/", target, d);
    expect(r).toMatchObject({ ok: false, reason: "blocked" });
  });

  it("reports login on a redirect into a sign-in page", async () => {
    const d = deps({
      fetchImpl: (async () =>
        ({
          ok: true,
          status: 200,
          url: "https://x.com/login?next=/cart",
          text: async () => "<html>sign in</html>",
        }) as unknown as Response) as unknown as typeof fetch,
    });
    const r = await extractDirect("https://x.com/cart", target, d);
    expect(r).toMatchObject({ ok: false, reason: "login" });
  });

  it("reports network when fetch throws", async () => {
    const d = deps({
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    const r = await extractDirect("https://x/", target, d);
    expect(r).toMatchObject({ ok: false, reason: "network" });
  });

  it("reports network when the offscreen parse fails", async () => {
    const d = deps({
      extract: vi.fn(async () => {
        throw new Error("offscreen: no reply");
      }),
    });
    const r = await extractDirect("https://x/", target, d);
    expect(r).toMatchObject({ ok: false, reason: "network" });
  });
});
