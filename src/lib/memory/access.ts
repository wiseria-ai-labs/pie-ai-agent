// src/lib/memory/access.ts
//
// Pie 2.0 记忆层的订阅门控与访问状态解析：
//   - MEMORY_REQUIRES_SUBSCRIPTION = false → "local_dev"（单测回退）
//   - 有 managed instance 且 entitlement.plan === "active" → "cloud_active"
//   - 未激活/已过期，但本地或历史镜像存在存量记忆 → "readonly_expired"（只读查看/导出/清空）
//   - 未激活且无存量记忆 → "locked"（展示 Pie Pro 开通引导）

import { listInstances } from "@/lib/instances";
import {
  getCachedEntitlement,
  getEntitlement,
  hydrateEntitlementCache,
} from "@/lib/managed-account";
import type { Entitlement } from "@/lib/managed-auth";
import { memoryRequiresSubscription } from "./model";
import {
  getMemoryProfile,
  getMemoryState,
  listMemoryEntries,
} from "./store";
import type { MemoryStateRecord } from "./types";

export type MemoryAccessState =
  | { mode: "cloud_active"; apiKey: string; entitlement: Entitlement }
  | { mode: "readonly_expired"; apiKey: string | null; entitlement: Entitlement | null }
  | { mode: "locked"; apiKey: string | null; entitlement: Entitlement | null }
  | { mode: "local_dev" };

export interface AccessStateOptions {
  /** 是否强制从 /me/entitlement 刷新订阅态（记忆设置页打开时传 true）。 */
  refresh?: boolean;
  /** 内存与 IDB 缓存均未命中时是否允许拉取一次（默认 true）。 */
  fetchIfUncached?: boolean;
}

export async function getManagedMemoryApiKey(): Promise<string | null> {
  try {
    const insts = await listInstances();
    return insts.find((i) => i.provider === "managed" && Boolean(i.apiKey))?.apiKey ?? null;
  } catch {
    return null;
  }
}

export async function getMemoryAccessState(
  opts: AccessStateOptions = {},
): Promise<MemoryAccessState> {
  if (!memoryRequiresSubscription()) {
    return { mode: "local_dev" };
  }

  const apiKey = await getManagedMemoryApiKey();
  let entitlement: Entitlement | null = null;

  if (apiKey) {
    if (opts.refresh) {
      try {
        entitlement = await getEntitlement(apiKey);
      } catch {
        await hydrateEntitlementCache();
        entitlement = getCachedEntitlement(apiKey);
      }
    } else {
      entitlement = getCachedEntitlement(apiKey);
      if (!entitlement) {
        await hydrateEntitlementCache();
        entitlement = getCachedEntitlement(apiKey);
      }
      if (!entitlement && opts.fetchIfUncached !== false) {
        try {
          entitlement = await getEntitlement(apiKey);
        } catch {
          entitlement = null;
        }
      }
    }
  }

  if (apiKey && entitlement?.plan === "active") {
    return { mode: "cloud_active", apiKey, entitlement };
  }

  const [entries, profile, state] = await Promise.all([
    listMemoryEntries({ includeExpired: true }).catch(() => []),
    getMemoryProfile().catch(() => ({ id: "profile" as const, text: "", updatedAt: 0 })),
    getMemoryState().catch((): MemoryStateRecord => ({ id: "state", watermark: 0 })),
  ]);
  const hasRetention =
    entries.length > 0 ||
    profile.text.trim().length > 0 ||
    state.cloudReadOnly === true;

  if (hasRetention) {
    return { mode: "readonly_expired", apiKey, entitlement };
  }
  return { mode: "locked", apiKey, entitlement };
}

export function isMemoryWritableAccess(state: MemoryAccessState): boolean {
  return state.mode === "cloud_active" || state.mode === "local_dev";
}
