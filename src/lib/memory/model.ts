// src/lib/memory/model.ts
//
// 记忆功能订阅门控开关。挑选 / 整理 / 精简模型均运行在云端，客户端保留
// 订阅门控与测试覆盖钩子。

/** 记忆功能仅对 Pie Pro 官方订阅用户开放（spec §5.5）。 */
export const MEMORY_REQUIRES_SUBSCRIPTION = true;

let requiresSubscriptionOverride: boolean | null = null;

/** Test-only：覆盖订阅门控开关，供纯本地记忆单测使用。传 null 恢复默认。 */
export function _setMemoryRequiresSubscriptionForTests(v: boolean | null): void {
  requiresSubscriptionOverride = v;
}

/** 订阅门控开关是否已生效（未订阅用户显示开通引导，到期用户切换只读保留）。 */
export function memoryRequiresSubscription(): boolean {
  return requiresSubscriptionOverride ?? MEMORY_REQUIRES_SUBSCRIPTION;
}
