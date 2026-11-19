// src/lib/inbox/types.ts
//
// Pie 2.0 §6 — 动态（inbox）条目。后台对象的统一结果流：监控触发 / 定时任务结束 /
// 需要用户处理。动态页、顶栏未读点、系统通知都从这里取数（通知本身仍由各业务
// 模块发，inbox 只做“可查”的那一份）。

export type InboxSource = "monitor" | "schedule";

export type InboxKind =
  /** 监控条件从不满足变为满足。 */
  | "triggered"
  /** 任务正常结束。 */
  | "done"
  /** 失败 / 暂停 / 需要用户去处理（登录、权限、实例被删等）。 */
  | "needs_action";

export interface InboxEntry {
  id: string; // "ibx_<uuid>"（迁移条目用确定性 id，保证幂等）
  source: InboxSource;
  refId: string; // monitor id / schedule id / run recordId
  kind: InboxKind;
  /** 主体（监控/任务标题）——用户数据，不本地化。 */
  title: string;
  /** 语言中立的证据摘要（`¥2,199 → ¥1,999`）；面板需要措辞时优先用 data。 */
  body: string;
  /**
   * 结构化补充，由面板按当前 locale 拼文案（`{reason:"login"}` / `{from,to}`）。
   * SW 写数据、面板写措辞 —— 语言在渲染时决定，不在写入时冻结。
   */
  data?: Record<string, string>;
  at: number;
  read: boolean;
}

/**
 * 单条动态最多保留多少条。超出时删最旧的（后台安静，动态不是日志）。
 * ponytail: 固定上限裁剪，不引入分页/归档；需要留档时再谈导出。
 */
export const MAX_INBOX_ENTRIES = 200;

/** 同一 refId 保留的条目上限（一条 15 分钟监控不该把动态刷满）。 */
export const MAX_INBOX_ENTRIES_PER_REF = 20;

export function newInboxId(): string {
  return "ibx_" + crypto.randomUUID();
}
