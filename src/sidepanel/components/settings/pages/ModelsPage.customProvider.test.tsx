/**
 * ModelsPage × custom provider 编辑卡 — 集成测试（真 fake-IDB，不 mock lib）。
 *
 * 卡内直接编辑 provider 实体字段（名称 / baseURL / wire），Save 必须走
 * updateCustomProvider 落实体（baseUrl 严禁成为 instance 字段 — 架构不变量），
 * 保存后列表行的 provider 名称即时同步；builtin 卡保持锁死现状。
 */
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { saveCustomProvider, getCustomProvider, CUSTOM_PREFIX } from "@/lib/custom-providers";
import { createInstance, listInstances } from "@/lib/instances";
import { _resetForTests } from "@/lib/idb/db";
import { _resetKeyForTests } from "@/lib/crypto";
import ModelsPage from "./ModelsPage";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

beforeEach(async () => {
  await _resetForTests();
  _resetKeyForTests();
});

async function seedCustom() {
  const cpId = await saveCustomProvider({
    name: "Proxy",
    baseUrl: "https://proxy.example/v1",
    models: [{ id: "m-1", vision: false, tools: true, maxContextTokens: 8_000 }],
  });
  await createInstance({
    provider: `${CUSTOM_PREFIX}${cpId}`,
    nickname: "Proxy",
    apiKey: "sk-x",
    customModels: ["m-1"],
  });
  return cpId;
}

describe("ModelsPage custom provider entity editing", () => {
  it("edit card: name/baseUrl/wire editable, Save lands on the entity and syncs the list name", async () => {
    const cpId = await seedCustom();
    render(<ModelsPage />);
    fireEvent.click(await screen.findByText("Proxy"));

    // Entity fields prefilled from the stored provider (locked row replaced).
    const nameInput = await screen.findByDisplayValue("Proxy");
    const urlInput = screen.getByDisplayValue("https://proxy.example/v1");
    expect(screen.queryByText(/LOCKED/)).toBeNull();

    fireEvent.change(nameInput, { target: { value: "Proxy2" } });
    fireEvent.change(urlInput, { target: { value: "https://proxy2.example/v1" } });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "responses" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));

    await waitFor(async () => {
      const cp = await getCustomProvider(cpId);
      expect(cp?.name).toBe("Proxy2");
      expect(cp?.baseUrl).toBe("https://proxy2.example/v1");
      expect(cp?.wire).toBe("responses");
    });
    // reload picked up the new entity name for the collapsed list row.
    expect(await screen.findByText("Proxy2")).toBeTruthy();
    // Invariant: baseUrl never lands on the instance record.
    const inst = (await listInstances())[0] as unknown as Record<string, unknown>;
    expect("baseUrl" in inst).toBe(false);
  });

  it("invalid baseUrl draft disables Save (canSaveGate)", async () => {
    await seedCustom();
    render(<ModelsPage />);
    fireEvent.click(await screen.findByText("Proxy"));
    const urlInput = await screen.findByDisplayValue("https://proxy.example/v1");
    fireEvent.change(urlInput, { target: { value: "not-a-url" } });
    const save = screen.getByRole("button", { name: /^Save$/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    // Restoring a valid URL re-enables Save.
    fireEvent.change(urlInput, { target: { value: "https://ok.example" } });
    expect(save.disabled).toBe(false);
  });

  it("builtin card unchanged: locked provider row, no entity fields", async () => {
    await createInstance({ provider: "anthropic", nickname: "Anthropic", apiKey: "sk-a" });
    render(<ModelsPage />);
    fireEvent.click(await screen.findByText("Anthropic"));
    await screen.findByText(/LOCKED/);
    expect(screen.queryByPlaceholderText(/api\.example\.com/i)).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("custom provider 刷新模型：GET /v1/models 写进实例 fetchedModels（#468）", async () => {
    await seedCustom();
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: true, status: 200,
      json: async () => ({ data: [{ id: "m-2" }] }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<ModelsPage />);
    fireEvent.click(await screen.findByText("Proxy"));
    fireEvent.click(await screen.findByText(/↻ refresh/i));

    expect(await screen.findByText("m-2")).toBeTruthy();
    expect(fetchMock.mock.calls[0]![0]).toBe("https://proxy.example/v1/models");
    expect((await listInstances())[0].fetchedModels?.map((m) => m.id)).toEqual(["m-2"]);
  });

  it("custom provider 刷新失败静默：不弹错，保留原清单", async () => {
    await seedCustom();
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: false, status: 404,
      json: async () => ({}),
      text: async () => "not found",
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<ModelsPage />);
    fireEvent.click(await screen.findByText("Proxy"));
    fireEvent.click(await screen.findByText(/↻ refresh/i));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(screen.queryByText(/not found/i)).toBeNull();
    expect((await listInstances())[0].fetchedModels).toBeUndefined();
  });
});
