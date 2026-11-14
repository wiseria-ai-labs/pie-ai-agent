import type { BrowserSearchResults } from "../browser-data/types";

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
   * Pie 2.0 — bookmarks/history search results for the clickable F6 list.
   * loop.ts turns this into a `browser-results` port message; the text
   * observation is still what the model reads.
   */
  browserResults?: BrowserSearchResults;
  /**
   * Pie 2.0 — an applied bookmark change recorded under `bookmark_snapshots`.
   * loop.ts turns this into a `browser-change` port message so the conversation
   * keeps an inline undo row (F7 "已整理 … · 还原"). The panel reads the record
   * from IDB by id — nothing else travels on the wire.
   */
  browserChange?: { recordId: string };
}
