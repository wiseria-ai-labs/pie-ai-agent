import { getInstance, listInstances, firstModelForProvider, type DecryptedInstance } from "./instances";
import { getLastModelSelection } from "./last-model-selection";
import { getCachedEntitlement } from "./managed-account";

export interface Selection {
  instanceId: string;
  model: string;
}

/**
 * 账号已登录但没订阅（entitlement 缓存存在且 plan !== "active"）时，managed
 * instance 不可选——选中必然 401，与 ModelPicker 隐藏官方分组保持一致。
 * 缓存未水合（null）时不跳过，保持旧行为，避开启动时序依赖。
 */
function selectable(inst: DecryptedInstance | null): inst is DecryptedInstance {
  if (!inst) return false;
  if (inst.provider !== "managed") return true;
  const ent = getCachedEntitlement(inst.apiKey);
  return ent === null || ent.plan === "active";
}

/**
 * 按 D3 优先级解析 (instanceId, model)：
 *   1) session 自带的 (instanceId, model)，且 instance 仍存在且可选
 *   2) 全局 last_model_selection，且 instance 仍存在且可选
 *   3) 第一个可选 instance 的 provider 第一个可用 model（firstModelForProvider）
 *   4) 零配置 → null（Composer 显示「去设置页加 Provider」空态）
 * session 入参来自 SessionMeta（instanceId/model 均可缺省）。
 */
export async function resolveSelection(session: {
  instanceId?: string;
  model?: string;
}): Promise<Selection | null> {
  // 1) session 自带且 instance 仍存在
  if (session.instanceId) {
    const inst = await getInstance(session.instanceId);
    if (selectable(inst)) {
      const model = session.model ?? (await firstModelForProvider(inst.provider, inst.id));
      if (model) return { instanceId: inst.id, model };
    }
  }
  // 2) 全局上次选择（instance 仍存在）
  const last = await getLastModelSelection();
  if (last) {
    const inst = await getInstance(last.instanceId);
    if (selectable(inst)) return { instanceId: inst.id, model: last.model };
  }
  // 3) 第一个可选的 instance 的 provider 第一个 model
  const all = await listInstances();
  for (const inst of all) {
    if (!selectable(inst)) continue;
    const model = await firstModelForProvider(inst.provider, inst.id);
    if (model) return { instanceId: inst.id, model };
  }
  // 4) 零配置
  return null;
}
