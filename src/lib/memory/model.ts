// src/lib/memory/model.ts
//
// 记忆层用的是**固定模型**，不跟随用户当前对话的模型，设置里也不提供切换
// （spec §5.5 已拍板）。唯一切换点是 `resolveMemoryModel()`：
//
//   开发期：取第一个 provider === "deepseek" 的 instance，model 固定
//           `deepseek-flash`。没有 → 只保留画像注入和 remember / forget。
//   上线前：翻到 managed 的 `default`，并把 MEMORY_REQUIRES_SUBSCRIPTION 打开
//           （未订阅用户记忆页显示开通入口）。
//
// 挑选 / 整理都显式**不开启 thinking**：本仓库的 wire 实现只有入参里带
// thinking 才会开，这里不带即为关。

import { listInstances, resolveModelConfig } from "@/lib/instances";
import { streamChat, type ModelConfig } from "@/lib/model-router";
import type { AgentMessage } from "@/lib/model-router/types";
import { MEMORY_PICK_HARD_TIMEOUT_MS } from "./types";

/** 记忆功能仅对 Pie Pro 官方订阅用户开放（spec §5.5）。 */
export const MEMORY_REQUIRES_SUBSCRIPTION = true;

let requiresSubscriptionOverride: boolean | null = null;

/** Test-only：覆盖订阅门控开关，供纯本地记忆单测使用。传 null 恢复默认。 */
export function _setMemoryRequiresSubscriptionForTests(v: boolean | null): void {
  requiresSubscriptionOverride = v;
}

const DEV_PROVIDER = "deepseek";
const DEV_MODEL = "deepseek-flash";
const MANAGED_MODEL = "default";

/** 记忆模型是否可用（仅当 MEMORY_REQUIRES_SUBSCRIPTION 被关闭的纯本地测试模式使用）。 */
export async function resolveMemoryModel(): Promise<ModelConfig | null> {
  const gated = memoryRequiresSubscription();
  const all = await listInstances();
  const provider = gated ? "managed" : DEV_PROVIDER;
  const inst = all.find((i) => i.provider === provider);
  if (!inst) return null;
  return resolveModelConfig(inst.id, gated ? MANAGED_MODEL : DEV_MODEL);
}

/** 订阅门控开关是否已生效（未订阅用户显示开通引导，到期用户切换只读保留）。 */
export function memoryRequiresSubscription(): boolean {
  return requiresSubscriptionOverride ?? MEMORY_REQUIRES_SUBSCRIPTION;
}

export interface CallMemoryModelOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * 一次性调用（非流式消费）：返回整段文本，超时 / 失败 / abort 返回 null。
 * 记忆层所有模型调用（挑选 / 整理 / 精简）都过这里。
 */
export async function callMemoryModel(
  model: ModelConfig,
  messages: AgentMessage[],
  opts: CallMemoryModelOptions = {},
): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? MEMORY_PICK_HARD_TIMEOUT_MS;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort();
      resolve(null);
    }, timeoutMs);
  });

  const run = (async (): Promise<string | null> => {
    let text = "";
    try {
      for await (const ev of streamChat(model, messages, ctrl.signal)) {
        if (ev.type === "text-delta") text += ev.text;
        else if (ev.type === "error") return null;
      }
      return text.trim() ? text : null;
    } catch {
      return null;
    }
  })();

  try {
    return await Promise.race([run, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
