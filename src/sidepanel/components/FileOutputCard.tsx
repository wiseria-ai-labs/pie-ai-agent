import { useState, useEffect } from "react";
import { useT } from "@/lib/i18n";
import { fileTypeLabel, humanSize } from "@/lib/files/mime-label";

export interface DownloadResult {
  status: "ok" | "expired" | "error";
}

interface Props {
  artifactId: string;
  /** Path-style filename, e.g. "pie/report.md" — basename is extracted for display */
  filename: string;
  mime: string;
  size: number;
  /** 头部内容预览（前几行，SW 侧已截断）+ 总行数 */
  preview?: string;
  totalLines?: number;
  /** 点保存 → SW 弹原生保存对话框，用户自己选位置 */
  onDownload: (artifactId: string) => Promise<DownloadResult>;
  /** Optional existence probe run on mount — if it resolves false (artifact
   *  evicted / session archived), the card shows the expired state without the
   *  user having to click download first. */
  onProbe?: (artifactId: string) => Promise<boolean>;
}

function basename(name: string): string {
  const parts = name.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? name;
}

/** Basename without its trailing extension — the type is shown separately on
 *  the meta line, so the title omits the redundant ".md"/".csv"/etc. A leading
 *  dot (dotfiles like ".gitignore") is preserved. */
function displayName(filename: string): string {
  const base = basename(filename);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

const DocIcon = ({ className }: { className?: string }) => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <path d="M14 3v4a1 1 0 0 0 1 1h4" />
    <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2Z" />
  </svg>
);

const DownloadIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 3v12" />
    <path d="m7 10 5 5 5-5" />
    <path d="M5 21h14" />
  </svg>
);



export function FileOutputCard({
  artifactId,
  filename,
  size,
  preview,
  totalLines,
  onDownload,
  onProbe,
}: Props) {
  const t = useT();
  const [status, setStatus] = useState<"idle" | "busy" | "expired">("idle");
  const disabled = status !== "idle";
  const dimmed = status === "expired";

  // Proactively reflect availability whenever the artifact changes (mount, or
  // a reused instance switched to a different artifact). Authoritative in BOTH
  // directions — present → idle, gone → expired — so a stale "expired" left by
  // a reused instance is corrected (don't clobber an in-flight download).
  useEffect(() => {
    if (!onProbe) return;
    let cancelled = false;
    void onProbe(artifactId).then((exists) => {
      if (cancelled) return;
      setStatus((prev) => (prev === "busy" ? prev : exists ? "idle" : "expired"));
    });
    return () => {
      cancelled = true;
    };
  }, [artifactId, onProbe]);

  async function handleClick() {
    if (disabled) return;
    setStatus("busy");
    const r = await onDownload(artifactId);
    setStatus(r.status === "expired" ? "expired" : "idle");
  }

  const previewLines = preview ? preview.split("\n").length : 0;
  const showMore = !!totalLines && totalLines > previewLines;

  return (
    <div
      className={[
        "flex flex-col gap-2.5 rounded-xl border border-line bg-surface px-3 py-2.5",
        dimmed ? "opacity-50" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="flex items-center gap-3">
        {/* 40×40 icon slot — tinted with accent-tint, accent-coloured glyph */}
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent-tint text-accent">
          <DocIcon />
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="truncate text-[14px] font-medium text-fg-1">
            {displayName(filename)}
          </div>
          <div className="font-mono text-[11px] text-fg-3">
            {dimmed ? t("chat.output.expired") : `${fileTypeLabel(filename)} · ${humanSize(size)}`}
          </div>
        </div>

        {/* 保存 = 原生保存对话框，用户自己选位置 */}
        <button
          type="button"
          disabled={disabled}
          onClick={handleClick}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-accent-line bg-accent-strong px-3 py-1.5 text-[12px] font-medium text-surface hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <DownloadIcon />
          {t("chat.output.save")}
        </button>
      </div>

      {/* 头部内容预览：保存前先让用户看清产出的是什么 */}
      {preview && !dimmed && (
        <div className="flex flex-col gap-1 rounded-lg border border-line bg-surface-deep px-2.5 py-2">
          <pre className="m-0 max-h-28 overflow-hidden whitespace-pre-wrap break-words font-mono text-[11px] leading-[17px] text-fg-2">
            {preview}
          </pre>
          {showMore && (
            <span className="font-mono text-[10px] text-fg-3">
              ⋯ {t("chat.output.previewMore").replace("{total}", String(totalLines))}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
