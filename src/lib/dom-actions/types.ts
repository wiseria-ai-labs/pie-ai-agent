export interface ActionResult {
  success: boolean;
  observation?: string;
  error?: string;
  /**
   * output_file — structured artifact handed to the panel so it can render a
   * download card. Present only on a successful output_file call. Wire-only:
   * loop.ts turns this into a `file-output` port message. Full content lives
   * in the persistent output-store (IndexedDB), NOT here.
   */
  fileOutput?: { id: string; filename: string; mime: string; size: number; preview?: string; totalLines?: number };
  /**
   * Optional image to feed the vision model (L1.5 frames / L3 skill JPEGs).
   * loop.ts hydrates this the same way as screenshot tools.
   */
  image?: {
    mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
    data: string;
    width: number;
    height: number;
    byteLength: number;
    id?: string;
  };
  /**
   * 记忆工具（remember / forget）—— 对话里留一条可撤销事件行（F13）。
   * loop.ts 转成 `memory-event` port 消息；eventId 供面板的「撤销」按钮回调。
   */
  memoryEvent?: {
    eventId: string;
    kind: "updated" | "deleted";
    /** 事件行展示的短语（"高铁坐一等座（公司报销）" / "1 条记忆"）。 */
    label: string;
    count: number;
  };
}
