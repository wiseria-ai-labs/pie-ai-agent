/** Filename: first 40 Unicode code points of the question + local YYYY-MM-DD + `.md`. */
export function researchDownloadFilename(question: string, at: Date = new Date()): string {
  const raw = question.trim().replace(/\s+/g, " ");
  const stem =
    Array.from(raw.replace(/[/\\?%*:|"<>]/g, "")).slice(0, 40).join("").trim() || "research";
  const yyyy = String(at.getFullYear());
  const mm = String(at.getMonth() + 1).padStart(2, "0");
  const dd = String(at.getDate()).padStart(2, "0");
  return `${stem}-${yyyy}-${mm}-${dd}.md`;
}

/** Trigger the browser save dialog. Uses octet-stream so Chrome keeps `.md`. */
export async function downloadResearchMarkdown(filename: string, content: string): Promise<void> {
  const url = URL.createObjectURL(new Blob([content], { type: "application/octet-stream" }));
  try {
    await chrome.downloads.download({
      url,
      filename,
      conflictAction: "uniquify",
      saveAs: true,
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
