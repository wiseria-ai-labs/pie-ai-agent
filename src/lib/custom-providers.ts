import type { ProviderRef } from "@/lib/model-router";
import { listInstances, updateInstance } from "@/lib/instances";
import { getConfig, setConfig } from "@/lib/idb/config-store";
import { txMulti, STORES } from "@/lib/idb/db";
import { publishChange } from "@/lib/store-bus";

export interface StoredCustomProvider {
  id: string;
  name: string;
  baseUrl: string;
  models: CustomModelMeta[];
  /**
   * Wire protocol for this provider's endpoints (#415). Absent (`undefined`) =
   * `/v1/chat/completions` (OpenAI-compat, the default and all legacy data).
   * `"responses"` = `/v1/responses` — required by proxies fronting gpt-5.x,
   * where chat/completions rejects function tools + reasoning_effort together.
   * Provider-level, not per-model: point two providers at the same baseUrl to
   * mix wires.
   */
  wire?: "responses";
  createdAt: number;
  updatedAt: number;
}

export interface CustomModelMeta {
  id: string;
  displayName?: string;
  vision: boolean;
  tools: boolean;
  maxContextTokens: number;
}

export interface CustomProviderInstanceRef {
  id: string;
  nickname: string;
  model: string;
}

export const CUSTOM_PREFIX = "custom:";

const INDEX_KEY = "custom_providers_index";
const ENTITY_KEY = (id: string) => `custom_provider_${id}`;

export function providerRefToId(ref: ProviderRef): string | null {
  if (!ref.startsWith(CUSTOM_PREFIX)) return null;
  return ref.slice(CUSTOM_PREFIX.length);
}

async function readIndex(): Promise<string[]> {
  return ((await getConfig<string[]>(INDEX_KEY)) ?? []).slice();
}

export async function listCustomProviders(): Promise<StoredCustomProvider[]> {
  const idx = await readIndex();
  const out: StoredCustomProvider[] = [];
  for (const id of idx) {
    const stored = await getConfig<StoredCustomProvider>(ENTITY_KEY(id));
    if (stored) out.push(stored);
  }
  return out;
}

export async function getCustomProvider(id: string): Promise<StoredCustomProvider | null> {
  return (await getConfig<StoredCustomProvider>(ENTITY_KEY(id))) ?? null;
}

export async function saveCustomProvider(input: {
  name: string;
  baseUrl: string;
  models: CustomModelMeta[];
  wire?: "responses";
}): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const entity: StoredCustomProvider = {
    id,
    name: input.name,
    baseUrl: input.baseUrl.replace(/\/$/, ""),
    models: input.models,
    ...(input.wire && { wire: input.wire }),
    createdAt: now,
    updatedAt: now,
  };
  const idx = await readIndex();
  idx.push(id);
  // Write entity + index in a single multi-put transaction so they commit
  // all-or-nothing (a crash between two separate writes would otherwise leave
  // an orphan entity that listCustomProviders can't see, or an index pointing
  // at a missing entity). Both records use the config `{ key, value }` shape —
  // mirrors config-store record shape; one txMulti to keep entity+index atomic.
  await txMulti([STORES.config], "readwrite", (m) => {
    m[STORES.config].put({ key: ENTITY_KEY(id), value: entity });
    m[STORES.config].put({ key: INDEX_KEY, value: idx });
  });
  // setConfig is bypassed above, so emit its config changes manually.
  publishChange("config", "put", ENTITY_KEY(id));
  publishChange("config", "put", INDEX_KEY);
  return id;
}

export async function updateCustomProvider(
  id: string,
  patch: Partial<{ name: string; baseUrl: string; models: CustomModelMeta[]; wire: "responses" | undefined }>,
): Promise<void> {
  const stored = await getConfig<StoredCustomProvider>(ENTITY_KEY(id));
  if (!stored) throw new Error(`Custom provider ${id} not found`);
  const next: StoredCustomProvider = {
    ...stored,
    ...(patch.name !== undefined && { name: patch.name }),
    ...(patch.baseUrl !== undefined && { baseUrl: patch.baseUrl.replace(/\/$/, "") }),
    ...(patch.models !== undefined && { models: patch.models }),
    // `wire` is presence-keyed, not value-keyed: passing `wire: undefined`
    // clears it (switch back to chat/completions), so honour any `wire` key
    // in the patch — including an explicit undefined.
    ...("wire" in patch && { wire: patch.wire }),
    updatedAt: Date.now(),
  };
  await setConfig(ENTITY_KEY(id), next);
  if (patch.name !== undefined && patch.name !== stored.name) {
    await syncInstancesNickname(id, patch.name);
  }
}

/** A custom-provider instance's nickname is seeded from the entity name at
 *  create time and is not independently editable in the UI — but ModelPicker
 *  renders it as the provider name. Renames must therefore mirror onto every
 *  referencing instance or the picker shows the old name forever (#3 family).
 *  Idempotent: only writes on drift. */
async function syncInstancesNickname(cpId: string, name: string): Promise<void> {
  const ref = `${CUSTOM_PREFIX}${cpId}`;
  const insts = await listInstances();
  for (const inst of insts) {
    if (inst.provider !== ref) continue;
    if (inst.nickname === name) continue;
    await updateInstance(inst.id, { nickname: name });
  }
}

/** ModelPicker / firstModelForProvider only read `instance.customModels` —
 *  the provider entity's model list is invisible to them (#3: a model added in
 *  Settings showed up there but could never be selected in the Composer).
 *  Every entity-model mutation therefore mirrors the id list onto all
 *  instances referencing this provider. Idempotent: only writes on drift. */
async function syncInstancesCustomModels(
  cpId: string,
  transform: (models: string[]) => string[],
): Promise<void> {
  const ref = `${CUSTOM_PREFIX}${cpId}`;
  const insts = await listInstances();
  for (const inst of insts) {
    if (inst.provider !== ref) continue;
    const cur = inst.customModels ?? [];
    const next = transform(cur);
    if (next.length === cur.length && next.every((x, i) => x === cur[i])) continue;
    await updateInstance(inst.id, { customModels: next });
  }
}

/** Append a model to a custom provider's model list. Idempotent on model id
 *  (a duplicate id is ignored, never overwritten — use updateCustomProviderModel
 *  to change an existing model's meta). */
export async function addCustomProviderModel(
  id: string,
  meta: CustomModelMeta,
): Promise<void> {
  const stored = await getCustomProvider(id);
  if (!stored) throw new Error(`Custom provider ${id} not found`);
  if (!stored.models.some((m) => m.id === meta.id)) {
    await updateCustomProvider(id, { models: [...stored.models, meta] });
  }
  // Runs even when the entity already had the id, so re-adding a model heals
  // pre-fix instances whose customModels never received it.
  await syncInstancesCustomModels(id, (models) =>
    models.includes(meta.id) ? models : [...models, meta.id],
  );
}

/** Replace an existing model's meta (matched by id; id itself is preserved).
 *  No-op when the id is absent. */
export async function updateCustomProviderModel(
  id: string,
  modelId: string,
  meta: CustomModelMeta,
): Promise<void> {
  const stored = await getCustomProvider(id);
  if (!stored) throw new Error(`Custom provider ${id} not found`);
  if (!stored.models.some((m) => m.id === modelId)) return;
  await updateCustomProvider(id, {
    models: stored.models.map((m) => (m.id === modelId ? { ...meta, id: modelId } : m)),
  });
}

/** Remove a model from a custom provider (matched by id). */
export async function removeCustomProviderModel(id: string, modelId: string): Promise<void> {
  const stored = await getCustomProvider(id);
  if (!stored) throw new Error(`Custom provider ${id} not found`);
  await updateCustomProvider(id, { models: stored.models.filter((m) => m.id !== modelId) });
  await syncInstancesCustomModels(id, (models) => models.filter((m) => m !== modelId));
}

/** Startup repair (#3): reconcile every referencing instance with its custom
 *  provider entity — union the entity model ids into instance.customModels
 *  (pre-dual-write versions persisted Settings-added models on the entity
 *  only) and overwrite drifted nicknames with the entity name (pre-mirror
 *  renames froze the create-time copy that ModelPicker renders). Idempotent
 *  and cheap (writes only on drift), so it runs on every boot without a
 *  sentinel; errors are swallowed — a failed repair must not block startup. */
export async function backfillCustomProviderInstances(): Promise<void> {
  try {
    const cps = await listCustomProviders();
    for (const cp of cps) {
      if (cp.models.length > 0) {
        const ids = cp.models.map((m) => m.id);
        await syncInstancesCustomModels(cp.id, (models) => {
          const merged = [...models];
          for (const mid of ids) if (!merged.includes(mid)) merged.push(mid);
          return merged;
        });
      }
      await syncInstancesNickname(cp.id, cp.name);
    }
  } catch {
    // Non-fatal: the dual-write path still heals on the next model edit.
  }
}

export async function getInstancesUsingCustomProvider(id: string): Promise<CustomProviderInstanceRef[]> {
  const ref = `${CUSTOM_PREFIX}${id}`;
  // Instances now live in the IDB `instances` store; read them through the
  // instances module rather than the legacy `instances_index` / `instance_*`
  // keys. Reference semantics unchanged: an instance references this custom
  // provider iff its `provider` ref equals `custom:<id>`.
  const insts = await listInstances();
  return insts
    .filter((i) => i.provider === ref)
    .map((i) => ({
      id: i.id,
      nickname: i.nickname ?? "",
      model: (i as { model?: string }).model ?? "",
    }));
}

export async function deleteCustomProvider(id: string): Promise<void> {
  const instances = await getInstancesUsingCustomProvider(id);
  if (instances.length > 0) {
    throw new Error(
      `Cannot delete custom provider: ${instances.length} instance(s) still reference it. Delete those instances first.`,
    );
  }
  const idx = (await readIndex()).filter((x) => x !== id);
  // Delete entity + update index in one transaction so they commit
  // all-or-nothing. Index record uses the config `{ key, value }` shape —
  // mirrors config-store record shape; one txMulti to keep entity+index atomic.
  await txMulti([STORES.config], "readwrite", (m) => {
    m[STORES.config].delete(ENTITY_KEY(id));
    m[STORES.config].put({ key: INDEX_KEY, value: idx });
  });
  // setConfig/removeConfig are bypassed above, so emit config changes manually.
  publishChange("config", "remove", ENTITY_KEY(id));
  publishChange("config", "put", INDEX_KEY);
}
