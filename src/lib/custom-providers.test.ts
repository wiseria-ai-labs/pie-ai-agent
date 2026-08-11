import { describe, it, expect, beforeEach } from "vitest";
import { _resetForTests } from "@/lib/idb/db";
import { _resetKeyForTests } from "@/lib/crypto";
import { getConfig } from "@/lib/idb/config-store";
import { createInstance, getInstance } from "@/lib/instances";
import {
  saveCustomProvider,
  getCustomProvider,
  listCustomProviders,
  addCustomProviderModel,
  updateCustomProviderModel,
  removeCustomProviderModel,
  updateCustomProvider,
  getInstancesUsingCustomProvider,
  deleteCustomProvider,
  backfillCustomProviderInstances,
  CUSTOM_PREFIX,
  type CustomModelMeta,
} from "./custom-providers";

beforeEach(async () => {
  await _resetForTests();
  _resetKeyForTests();
});

const meta = (id: string, over: Partial<CustomModelMeta> = {}): CustomModelMeta => ({
  id,
  displayName: undefined,
  vision: false,
  tools: true,
  maxContextTokens: 256_000,
  ...over,
});

describe("custom provider model helpers", () => {
  it("addCustomProviderModel appends a model to the provider entity", async () => {
    const id = await saveCustomProvider({ name: "X", baseUrl: "https://x.ai/v1", models: [] });
    await addCustomProviderModel(id, meta("gpt-4o", { vision: true }));
    const cp = await getCustomProvider(id);
    expect(cp!.models.map((m) => m.id)).toEqual(["gpt-4o"]);
    expect(cp!.models[0].vision).toBe(true);
    expect(cp!.models[0].tools).toBe(true);
  });

  it("addCustomProviderModel is idempotent on duplicate id (does not overwrite)", async () => {
    const id = await saveCustomProvider({ name: "X", baseUrl: "https://x.ai/v1", models: [meta("a")] });
    await addCustomProviderModel(id, meta("a", { vision: true }));
    const cp = await getCustomProvider(id);
    expect(cp!.models).toHaveLength(1);
    expect(cp!.models[0].vision).toBe(false);
  });

  it("updateCustomProviderModel replaces meta for matching id, preserves id + order", async () => {
    const id = await saveCustomProvider({
      name: "X",
      baseUrl: "https://x.ai/v1",
      models: [meta("a"), meta("b")],
    });
    await updateCustomProviderModel(id, "a", meta("a", { vision: true, maxContextTokens: 8000 }));
    const cp = await getCustomProvider(id);
    const a = cp!.models.find((m) => m.id === "a")!;
    expect(a.vision).toBe(true);
    expect(a.maxContextTokens).toBe(8000);
    expect(cp!.models.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("updateCustomProviderModel no-ops when id absent", async () => {
    const id = await saveCustomProvider({ name: "X", baseUrl: "https://x.ai/v1", models: [meta("a")] });
    await updateCustomProviderModel(id, "ghost", meta("ghost"));
    const cp = await getCustomProvider(id);
    expect(cp!.models.map((m) => m.id)).toEqual(["a"]);
  });

  it("removeCustomProviderModel drops the matching model", async () => {
    const id = await saveCustomProvider({
      name: "X",
      baseUrl: "https://x.ai/v1",
      models: [meta("a"), meta("b")],
    });
    await removeCustomProviderModel(id, "a");
    const cp = await getCustomProvider(id);
    expect(cp!.models.map((m) => m.id)).toEqual(["b"]);
  });

  it("addCustomProviderModel throws for unknown provider", async () => {
    await expect(addCustomProviderModel("nope", meta("a"))).rejects.toThrow();
  });
});

describe("custom provider CRUD + persistence (IDB config store)", () => {
  it("saveCustomProvider writes entity and index atomically (both visible)", async () => {
    const id = await saveCustomProvider({ name: "X", baseUrl: "https://x.ai/v1/", models: [meta("a")] });
    // index visible
    const idx = await getConfig<string[]>("custom_providers_index");
    expect(idx).toEqual([id]);
    // entity visible at config key
    const entity = await getConfig<{ id: string; baseUrl: string }>(`custom_provider_${id}`);
    expect(entity!.id).toBe(id);
    // trailing slash trimmed
    expect(entity!.baseUrl).toBe("https://x.ai/v1");
    // and via the public getter
    const cp = await getCustomProvider(id);
    expect(cp!.name).toBe("X");
  });

  it("listCustomProviders returns all saved providers in index order", async () => {
    const a = await saveCustomProvider({ name: "A", baseUrl: "https://a/v1", models: [] });
    const b = await saveCustomProvider({ name: "B", baseUrl: "https://b/v1", models: [] });
    const all = await listCustomProviders();
    expect(all.map((p) => p.id)).toEqual([a, b]);
  });

  it("getCustomProvider returns null for unknown id", async () => {
    expect(await getCustomProvider("nope")).toBeNull();
  });

  describe("wire protocol persistence (#415)", () => {
    it("saveCustomProvider persists wire: 'responses' and reads it back", async () => {
      const id = await saveCustomProvider({ name: "R", baseUrl: "https://r/v1", models: [], wire: "responses" });
      expect((await getCustomProvider(id))!.wire).toBe("responses");
    });

    it("legacy data (no wire) reads back undefined", async () => {
      const id = await saveCustomProvider({ name: "C", baseUrl: "https://c/v1", models: [] });
      expect((await getCustomProvider(id))!.wire).toBeUndefined();
    });

    it("updateCustomProvider can set and then clear wire", async () => {
      const id = await saveCustomProvider({ name: "X", baseUrl: "https://x/v1", models: [] });
      await updateCustomProvider(id, { wire: "responses" });
      expect((await getCustomProvider(id))!.wire).toBe("responses");
      await updateCustomProvider(id, { wire: undefined });
      expect((await getCustomProvider(id))!.wire).toBeUndefined();
    });

    it("updateCustomProvider without a wire key leaves it untouched", async () => {
      const id = await saveCustomProvider({ name: "X", baseUrl: "https://x/v1", models: [], wire: "responses" });
      await updateCustomProvider(id, { name: "renamed" });
      const cp = await getCustomProvider(id);
      expect(cp!.name).toBe("renamed");
      expect(cp!.wire).toBe("responses");
    });
  });

  it("deleteCustomProvider removes entity + index entry when unreferenced", async () => {
    const id = await saveCustomProvider({ name: "X", baseUrl: "https://x.ai/v1", models: [] });
    await deleteCustomProvider(id);
    expect(await getCustomProvider(id)).toBeNull();
    expect(await getConfig<string[]>("custom_providers_index")).toEqual([]);
    expect(await getConfig(`custom_provider_${id}`)).toBeUndefined();
  });
});

describe("instance reference checks (via listInstances)", () => {
  it("getInstancesUsingCustomProvider finds instances whose provider is custom:<id>", async () => {
    const id = await saveCustomProvider({ name: "X", baseUrl: "https://x.ai/v1", models: [] });
    const iid = await createInstance({
      provider: `${CUSTOM_PREFIX}${id}`,
      nickname: "my-inst",
      apiKey: "sk-123",
    });
    // an unrelated instance on a builtin provider
    await createInstance({ provider: "openai", nickname: "other", apiKey: "sk-999" });

    const refs = await getInstancesUsingCustomProvider(id);
    expect(refs).toHaveLength(1);
    expect(refs[0].id).toBe(iid);
    expect(refs[0].nickname).toBe("my-inst");
  });

  it("deleteCustomProvider throws when a referencing instance exists", async () => {
    const id = await saveCustomProvider({ name: "X", baseUrl: "https://x.ai/v1", models: [] });
    await createInstance({ provider: `${CUSTOM_PREFIX}${id}`, nickname: "i", apiKey: "sk-1" });
    await expect(deleteCustomProvider(id)).rejects.toThrow(/still reference it/);
    // entity untouched
    expect(await getCustomProvider(id)).not.toBeNull();
  });
});

// #3 — entity-model mutations must mirror the id list onto referencing
// instances: ModelPicker/firstModelForProvider only read instance.customModels,
// so an entity-only write left the model unselectable in the Composer.
describe("entity-model ↔ instance.customModels dual-write (#3)", () => {
  it("addCustomProviderModel appends the id to referencing instances", async () => {
    const id = await saveCustomProvider({ name: "X", baseUrl: "https://x.ai/v1", models: [] });
    const iid = await createInstance({ provider: `${CUSTOM_PREFIX}${id}`, nickname: "i", apiKey: "sk-1" });
    const other = await createInstance({ provider: "openai", nickname: "o", apiKey: "sk-2" });

    await addCustomProviderModel(id, meta("gpt-x"));

    expect((await getInstance(iid))!.customModels).toEqual(["gpt-x"]);
    // unrelated instance untouched
    expect((await getInstance(other))!.customModels).toBeUndefined();
  });

  it("addCustomProviderModel heals an instance missing an id the entity already has", async () => {
    // Pre-fix state: entity has the model, instance doesn't.
    const id = await saveCustomProvider({ name: "X", baseUrl: "https://x.ai/v1", models: [meta("a")] });
    const iid = await createInstance({ provider: `${CUSTOM_PREFIX}${id}`, nickname: "i", apiKey: "sk-1" });

    await addCustomProviderModel(id, meta("a", { vision: true }));

    // Entity meta not overwritten (idempotent), but the instance got the id.
    expect((await getCustomProvider(id))!.models[0].vision).toBe(false);
    expect((await getInstance(iid))!.customModels).toEqual(["a"]);
  });

  it("removeCustomProviderModel removes the id from referencing instances", async () => {
    const id = await saveCustomProvider({ name: "X", baseUrl: "https://x.ai/v1", models: [] });
    const iid = await createInstance({
      provider: `${CUSTOM_PREFIX}${id}`,
      nickname: "i",
      apiKey: "sk-1",
      customModels: ["a", "b"],
    });

    await removeCustomProviderModel(id, "a");

    expect((await getInstance(iid))!.customModels).toEqual(["b"]);
  });

  it("backfill unions entity models into referencing instances (startup repair)", async () => {
    const id = await saveCustomProvider({
      name: "X",
      baseUrl: "https://x.ai/v1",
      models: [meta("a"), meta("b")],
    });
    const iid = await createInstance({
      provider: `${CUSTOM_PREFIX}${id}`,
      nickname: "i",
      apiKey: "sk-1",
      customModels: ["b", "legacy"],
    });

    await backfillCustomProviderInstances();

    // Existing ids (incl. instance-only legacy ids) preserved, missing entity ids appended.
    expect((await getInstance(iid))!.customModels).toEqual(["b", "legacy", "a"]);
    // Idempotent: second run writes nothing new.
    await backfillCustomProviderInstances();
    expect((await getInstance(iid))!.customModels).toEqual(["b", "legacy", "a"]);
  });
});

describe("entity rename ↔ instance.nickname mirror", () => {
  it("updateCustomProvider name change mirrors onto referencing instances' nickname", async () => {
    const id = await saveCustomProvider({ name: "X", baseUrl: "https://x.ai/v1", models: [] });
    const iid = await createInstance({ provider: `${CUSTOM_PREFIX}${id}`, nickname: "X", apiKey: "sk-1" });
    const other = await createInstance({ provider: "openai", nickname: "o", apiKey: "sk-2" });

    await updateCustomProvider(id, { name: "Y" });

    expect((await getInstance(iid))!.nickname).toBe("Y");
    // unrelated instance untouched
    expect((await getInstance(other))!.nickname).toBe("o");
  });

  it("non-name patches (baseUrl/models) leave nicknames alone", async () => {
    const id = await saveCustomProvider({ name: "X", baseUrl: "https://x.ai/v1", models: [] });
    const iid = await createInstance({ provider: `${CUSTOM_PREFIX}${id}`, nickname: "nick", apiKey: "sk-1" });

    await updateCustomProvider(id, { baseUrl: "https://y.ai/v1" });
    await updateCustomProvider(id, { models: [meta("a")] });

    expect((await getInstance(iid))!.nickname).toBe("nick");
  });

  it("backfill overwrites a drifted nickname with the entity name (startup repair)", async () => {
    // Pre-mirror state: entity was renamed but the instance kept the frozen copy.
    const id = await saveCustomProvider({ name: "New", baseUrl: "https://x.ai/v1", models: [] });
    const iid = await createInstance({ provider: `${CUSTOM_PREFIX}${id}`, nickname: "Old", apiKey: "sk-1" });

    await backfillCustomProviderInstances();

    expect((await getInstance(iid))!.nickname).toBe("New");
    // Idempotent second run.
    await backfillCustomProviderInstances();
    expect((await getInstance(iid))!.nickname).toBe("New");
  });
});
