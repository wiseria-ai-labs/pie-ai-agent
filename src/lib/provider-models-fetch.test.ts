import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { supportsModelFetch, fetchProviderModels, isLazyModelProvider } from "./provider-models-fetch";
import { saveCustomProvider, CUSTOM_PREFIX } from "@/lib/custom-providers";
import { _resetForTests } from "@/lib/idb/db";

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => "" } as unknown as Response;
}
function fail(status: number) {
  return { ok: false, status, json: async () => ({}), text: async () => "nope" } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  await _resetForTests();
});

describe("supportsModelFetch — capability gate, never a provider id", () => {
  it("OpenAI-compat builtins that serve GET /v1/models are supported", () => {
    for (const id of ["openrouter", "openai", "zhipu", "bailian", "moonshot", "moonshot-cn", "a2agent"] as const) {
      expect(supportsModelFetch(id), id).toBe(true);
    }
  });

  it("Anthropic-wire family, native Gemini and the managed gateway are not", () => {
    // anthropic-wire 家族的 chat 端点是 /anthropic 后缀的 messages wire；gemini 是 native wire；
    // managed 网关没有 /v1/models（实测 404），模型清单来自 entitlement。
    for (const id of ["anthropic", "deepseek", "minimax", "mimo", "stepfun", "gemini", "managed"] as const) {
      expect(supportsModelFetch(id), id).toBe(false);
    }
  });

  it("every custom provider ref is supported (OpenAI-compat convention)", () => {
    expect(supportsModelFetch(`${CUSTOM_PREFIX}whatever`)).toBe(true);
  });
});

describe("isLazyModelProvider — only builtins with an empty curated list", () => {
  it("OpenRouter is lazy (models[] empty, endpoint set)", () => {
    expect(isLazyModelProvider("openrouter")).toBe(true);
  });

  it("builtins with a curated list, custom providers and unsupported wire are not", () => {
    for (const ref of ["openai", "zhipu", "a2agent", "anthropic", `${CUSTOM_PREFIX}cp1`] as const) {
      expect(isLazyModelProvider(ref), ref).toBe(false);
    }
  });
});

describe("fetchProviderModels", () => {
  it("returns null without a network call for unsupported providers", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchProviderModels("anthropic", "sk-ant")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("custom provider fetches its own entity baseUrl with Bearer auth", async () => {
    const fetchMock = vi.fn(async () => ok({ data: [{ id: "m-1" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const cpId = await saveCustomProvider({ name: "Proxy", baseUrl: "https://proxy.example", models: [] });

    const out = await fetchProviderModels(`${CUSTOM_PREFIX}${cpId}`, "sk-x");

    expect(fetchMock).toHaveBeenCalledWith("https://proxy.example/v1/models", {
      headers: { authorization: "Bearer sk-x" },
    });
    expect(out).toEqual([
      { id: "m-1", displayName: undefined, vision: false, tools: true, maxContextTokens: 128_000 },
    ]);
  });

  it("uses the unsaved draft baseUrl override (wizard custom-provider authoring)", async () => {
    const fetchMock = vi.fn(async (_url: string) => ok({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchProviderModels(`${CUSTOM_PREFIX}__draft__`, undefined, {
      baseUrl: "https://draft.example/v1",
    });

    // baseUrl 已带 /v1 → 不再追加 /v1（避免 /v1/v1/models 404）。
    expect(fetchMock.mock.calls[0]![0]).toBe("https://draft.example/v1/models");
  });

  it("uses the endpoint variant's baseUrl (moonshot payg)", async () => {
    const fetchMock = vi.fn(async (_url: string) => ok({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchProviderModels("moonshot", "sk-k", { endpointVariant: "payg" });

    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.moonshot.ai/v1/models");
  });

  it("OpenRouter keeps its context_length / input_modalities enrichment", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ok({
          data: [{ id: "vendor/model", context_length: 200_000, architecture: { input_modalities: ["image"] } }],
        }),
      ),
    );

    const out = await fetchProviderModels("openrouter");

    expect(out).toEqual([{ id: "vendor/model", vision: true, tools: true, maxContextTokens: 200_000 }]);
  });

  it("throws on non-2xx — callers swallow it and keep the existing list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fail(404)));
    await expect(fetchProviderModels("openai", "sk-x")).rejects.toThrow(/404/);
  });
});
