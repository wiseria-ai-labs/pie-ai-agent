// 加密记忆（地址 / 联系方式）的放行闸。
//
// 云端与本地都是密文落盘，但下发到客户端时是明文；一旦拼进 prompt，这些内容
// 就交给了用户配置的模型服务商（BYOK 时完全不经过我们）。所以默认只给模型
// 一行占位，模型真要内容时（`recall_memory`）在这里问一次用户。
//
// 批准范围 = 本次会话：同一会话里后续的 recall_memory 不再重复弹卡；换会话、
// SW 重启（内存表清空）都会重新问。拒绝 / 超时 / 没有面板可问，一律保持屏蔽。

import { requestFromPanel } from "@/lib/panel-request";

/** 不说话就继续隐藏：卡在那儿没人回答，也比一个任务无限挂着好。 */
const UNLOCK_TIMEOUT_MS = 120_000;

const unlockedSessions = new Set<string>();

export function __resetMemoryUnlockState(): void {
  unlockedSessions.clear();
}

export function isEncryptedMemoryUnlocked(sessionId: string): boolean {
  return unlockedSessions.has(sessionId);
}

export interface EncryptedMemoryUnlockInput {
  sessionId?: string;
  count: number;
  kinds: string[];
  signal?: AbortSignal;
}

/**
 * 问用户能不能把加密条目的正文发给模型。true 才可以展开。
 * 没有 sessionId（测试 / 非会话上下文）→ 不问，直接保持屏蔽。
 */
export async function requestEncryptedMemoryUnlock(
  input: EncryptedMemoryUnlockInput,
): Promise<boolean> {
  const { sessionId } = input;
  if (!sessionId) return false;
  if (unlockedSessions.has(sessionId)) return true;
  try {
    const granted = await requestFromPanel(
      sessionId,
      "memory-unlock",
      { count: input.count, kinds: input.kinds },
      { signal: input.signal, timeoutMs: UNLOCK_TIMEOUT_MS },
    );
    if (granted) unlockedSessions.add(sessionId);
    return granted;
  } catch {
    // 用户取消 / 面板不在 / abort：保持屏蔽，不是错误。
    return false;
  }
}
