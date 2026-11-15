// Pie 账号 = 唯一一条 provider:"managed" instance（一台设备至多一条）。
// 账号从「模型配置」里独立出来（设置 → 账号），这里是唯一的读写入口：
// 登录成功即落盘，退出登录即删 instance + 清 entitlement 缓存 + 清本地记忆镜像。
import { createInstance, deleteInstance, listInstances, updateInstance } from "./instances";
import { forgetEntitlement } from "./managed-account";
import type { LoginResult } from "./managed-auth";
import { clearAllMemory, setMemoryState } from "./memory/store";

export interface PieAccount {
  instanceId: string;
  apiKey: string;
  email: string;
}

/** 当前登录的 Pie 账号（未登录 → null）。 */
export async function getPieAccount(): Promise<PieAccount | null> {
  const inst = (await listInstances()).find((i) => i.provider === "managed");
  if (!inst?.apiKey) return null;
  return { instanceId: inst.id, apiKey: inst.apiKey, email: inst.nickname };
}

/**
 * 登录成功（Google / 邮箱验证码）后落盘账号。幂等：已有 instance 就更新 key 与
 * 显示邮箱，没有就建一条。不依赖订阅状态——登录了就是登录了。
 */
export async function savePieAccount(res: LoginResult): Promise<PieAccount> {
  const email = res.entitlement.email;
  const existing = (await listInstances()).find((i) => i.provider === "managed");
  if (!existing) {
    const instanceId = await createInstance({ provider: "managed", nickname: email, apiKey: res.apiKey });
    return { instanceId, apiKey: res.apiKey, email };
  }
  if (existing.apiKey !== res.apiKey || existing.nickname !== email) {
    await updateInstance(existing.id, { apiKey: res.apiKey, nickname: email });
  }
  return { instanceId: existing.id, apiKey: res.apiKey, email };
}

/**
 * 退出登录：删 managed instance（会话历史的 instance 绑定走既有兜底）、
 * 清 entitlement 缓存，清本地记忆镜像与同步游标——只清本地，不调云端
 * /memory/clear（云端数据属于账号，退出不等于删除）。会话历史保留。
 */
export async function signOutPieAccount(): Promise<void> {
  const acct = await getPieAccount();
  if (acct) {
    await deleteInstance(acct.instanceId);
    await forgetEntitlement(acct.apiKey);
  }
  await clearAllMemory();
  // ponytail: 直接抹掉同步游标而不是新加一层 resetSync 选项；游标留在本地会让
  // 「退 A 登 B」用 A 的 revision 去 pull B 的增量。字段置 undefined 即可。
  await setMemoryState({
    cloudRevision: undefined,
    cloudImported: undefined,
    digestWatermark: undefined,
    lastHistoryDigestAt: undefined,
  });
}
