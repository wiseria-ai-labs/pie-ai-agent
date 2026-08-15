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
}
