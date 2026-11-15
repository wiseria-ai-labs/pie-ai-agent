// Provider + model selection for the overlay — the same resolution the side
// panel's composer uses (session pin → last_model_selection → first instance),
// so switching in either surface is the same switch.

import { useCallback, useEffect, useState } from "react";
import { getInstance, listInstances, updateInstance, type DecryptedInstance } from "@/lib/instances";
import { resolveSelection } from "@/lib/model-selection-resolver";
import { setLastModelSelection } from "@/lib/last-model-selection";
import { getSessionMeta, updateSessionMeta } from "@/lib/sessions/storage";
import { fetchProviderModels } from "@/lib/provider-models-fetch";
import { getEntitlement } from "@/lib/managed-account";
import { useStoreChange } from "@/sidepanel/hooks/useStoreChange";

export interface OverlayModelSelection {
  instances: DecryptedInstance[];
  currentInstanceId: string | null;
  currentModel: string | null;
  select: (instanceId: string, model: string) => Promise<void>;
  refreshModels: (instanceId: string) => Promise<void>;
}

export function useModelSelection(sessionId: string): OverlayModelSelection {
  const [instances, setInstances] = useState<DecryptedInstance[]>([]);
  const [currentInstanceId, setCurrentInstanceId] = useState<string | null>(null);
  const [currentModel, setCurrentModel] = useState<string | null>(null);

  const reload = useCallback(() => {
    void listInstances().then(setInstances).catch(() => setInstances([]));
    if (!sessionId) return;
    void (async () => {
      const meta = await getSessionMeta(sessionId).catch(() => null);
      const sel = await resolveSelection({ instanceId: meta?.instanceId, model: meta?.model });
      setCurrentInstanceId(sel?.instanceId ?? null);
      setCurrentModel(sel?.model ?? null);
    })().catch(() => {});
  }, [sessionId]);

  useEffect(() => {
    reload();
  }, [reload]);
  useStoreChange("sessions", reload);
  useStoreChange("config", reload);
  useStoreChange("instances", reload);

  const select = useCallback(
    async (instanceId: string, model: string) => {
      setCurrentInstanceId(instanceId);
      setCurrentModel(model);
      // Session pin (the SW snapshots it at task start) + the global default.
      await updateSessionMeta(sessionId, (existing) => ({ ...existing, instanceId, model }));
      void setLastModelSelection({ instanceId, model });
    },
    [sessionId],
  );

  // Lazy provider catalog (openrouter / managed entitlement). Same as the
  // side panel's composer: silent on failure, the cached list stays.
  const refreshModels = useCallback(
    async (instanceId: string) => {
      const inst = instances.find((i) => i.id === instanceId) ?? (await getInstance(instanceId));
      if (!inst) return;
      if (inst.provider === "managed") {
        await getEntitlement(inst.apiKey).catch(() => {});
        return;
      }
      try {
        const fetched = await fetchProviderModels(inst.provider, inst.apiKey || undefined, {
          endpointVariant: inst.endpointVariant,
        });
        if (!fetched) return;
        await updateInstance(instanceId, { fetchedModels: fetched, fetchedAt: Date.now() });
        setInstances(await listInstances());
      } catch {
        // silent; the user can retry from Settings
      }
    },
    [instances],
  );

  return { instances, currentInstanceId, currentModel, select, refreshModels };
}
