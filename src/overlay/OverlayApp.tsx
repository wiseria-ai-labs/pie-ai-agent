import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import Markdown from "@/sidepanel/components/Markdown";
import { useT } from "@/lib/i18n";
import type { DictKey } from "@/lib/i18n";
import { getConfig } from "@/lib/idb/config-store";
import { getToolClass } from "@/lib/agent/tool-names";
import type { DisplayMessage } from "@/types";
import type { OverlayOpenState, OverlayReplaceResult, OverlaySelection } from "@/lib/overlay/protocol";
import { buildOverlayWireContent as buildWireContent } from "@/lib/overlay/wire";
import { useOverlaySession } from "./useOverlaySession";

/** Below this the composer never collapses — matches the host's min height. */
const MAX_TEXTAREA_LINES = 3;

function reportHeight(): void {
  const root = document.getElementById("overlay-root");
  if (!root) return;
  window.parent.postMessage(
    { type: "pie-overlay:resize", height: Math.ceil(root.getBoundingClientRect().height) },
    "*",
  );
}

function requestClose(): void {
  window.parent.postMessage({ type: "pie-overlay:close" }, "*");
}

interface RewriteCardState {
  to: string;
  from: string;
}

export default function OverlayApp() {
  const t = useT();
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const sessionId = params.get("sessionId") ?? "";
  const tabId = Number(params.get("tabId") ?? "-1");

  const [openState, setOpenState] = useState<OverlayOpenState | null>(null);
  const [runningElsewhere, setRunningElsewhere] = useState(false);
  const [input, setInput] = useState("");
  const [selection, setSelection] = useState<OverlaySelection | null>(null);
  const [selectionConsumed, setSelectionConsumed] = useState(false);
  const [replaced, setReplaced] = useState<Record<number, "ok" | "undone">>({});
  const [staleIndexes, setStaleIndexes] = useState<Record<number, true>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sendRef = useRef<() => void>(() => {});

  const session = useOverlaySession({ sessionId, tabId, runningElsewhere });
  const { messages, streaming, streamingText, streamingThinking } = session;

  // ── Theme: same config the side panel uses ────────────────────────────────
  useEffect(() => {
    void getConfig<string>("theme-mode").then((mode) => {
      if (mode === "light" || mode === "dark") {
        document.documentElement.dataset.theme = mode;
      } else {
        delete document.documentElement.dataset.theme;
      }
    });
  }, []);

  // ── Open state (selection / prefill / auto-send) ──────────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const reply = (await chrome.runtime.sendMessage({
          type: "overlay:get-state",
          sessionId,
          tabId,
        })) as { state?: OverlayOpenState | null; running?: boolean } | undefined;
        if (cancelled) return;
        const state = reply?.state ?? null;
        setOpenState(state);
        setRunningElsewhere(reply?.running === true);
        if (state?.selection) {
          setSelection(state.selection);
          setSelectionConsumed(false);
        }
        if (state?.prompt) setInput(state.prompt);
      } catch {
        // SW unavailable — the overlay still works as a plain conversation.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, tabId]);

  // ── Auto-send (explain / translate / rewrite / omnibox) ───────────────────
  const autoSentRef = useRef(false);
  const sendRefForAuto = session.send;
  const readyForAuto = session.ready;
  useEffect(() => {
    if (autoSentRef.current) return;
    if (!openState || !openState.autoSend || !openState.prompt) return;
    if (!readyForAuto) return;
    autoSentRef.current = true;
    const sel = openState.selection;
    sendRefForAuto({
      content: openState.prompt,
      expandedForLLM: buildWireContent(openState.prompt, sel),
      editableSelection: sel?.editable === true,
    });
    setSelectionConsumed(true);
    setInput("");
  }, [openState, readyForAuto, sendRefForAuto]);

  // ── Height reporting for the iframe host ──────────────────────────────────
  useEffect(() => {
    const root = document.getElementById("overlay-root");
    if (!root) return;
    const observer = new ResizeObserver(() => reportHeight());
    observer.observe(root);
    reportHeight();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    reportHeight();
  }, [messages.length, streaming, streamingText, notice]);

  // ── Focus on open ─────────────────────────────────────────────────────────
  useEffect(() => {
    textareaRef.current?.focus({ preventScroll: true });
  }, []);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || streaming || !session.ready) return;
    const sel = selectionConsumed ? null : selection;
    session.send({
      content: text,
      expandedForLLM: buildWireContent(text, sel),
      editableSelection: sel?.editable === true,
    });
    setInput("");
    setSelectionConsumed(true);
    setNotice(null);
  }, [input, selection, selectionConsumed, session, streaming]);

  sendRef.current = send;

  const toPanel = useCallback(() => {
    void chrome.runtime.sendMessage({ type: "overlay:to-panel", sessionId, tabId });
  }, [sessionId, tabId]);

  const newChat = useCallback(() => {
    void chrome.runtime.sendMessage({ type: "overlay:new-chat", tabId });
  }, [tabId]);

  // ── Keyboard: Enter / Shift+Enter / ⌘Enter / ⌘K / Esc ─────────────────────
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape") {
        e.preventDefault();
        requestClose();
        return;
      }
      if (mod && e.key === "Enter") {
        e.preventDefault();
        toPanel();
        return;
      }
      if (mod && !e.shiftKey && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        newChat();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [newChat, toPanel]);

  const onTextareaKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    if (e.nativeEvent.isComposing) return; // IME candidate selection
    e.preventDefault();
    sendRef.current();
  };

  // ── Rewrite cards + write-back ────────────────────────────────────────────
  const selectionText = openState?.selection?.text ?? null;

  const rewriteCards = useMemo(() => {
    const cards: Record<number, RewriteCardState> = {};
    messages.forEach((m, i) => {
      if (m.role !== "agent-step" || m.tool !== "propose_rewrite" || m.status === "pending") return;
      const args = (m.args ?? {}) as { text?: unknown };
      const to = typeof args.text === "string" ? args.text : "";
      if (!to) return;
      // The original is the selection the turn was started with. For turns
      // restored from storage there is nothing to compare against, so the card
      // renders without the write-back action.
      const prevUser = [...messages.slice(0, i)].reverse().find((x) => x.role === "user");
      const from = prevUser ? selectionTextFor(messages, prevUser, selectionText) : null;
      if (from !== null) cards[i] = { to, from };
    });
    return cards;
  }, [messages, selectionText]);

  const latestRewriteIndex = useMemo(() => {
    let idx = -1;
    for (const key of Object.keys(rewriteCards)) idx = Math.max(idx, Number(key));
    return idx;
  }, [rewriteCards]);

  const taskRanAfter = useCallback(
    (index: number) =>
      messages
        .slice(index + 1)
        .some((m) => m.role === "agent-step" && m.tool !== "propose_rewrite" && getToolClass(m.tool) === "write"),
    [messages],
  );

  const doReplace = useCallback(
    async (index: number, card: RewriteCardState) => {
      const reply = (await chrome.runtime.sendMessage({
        type: "overlay:request-replace",
        tabId,
        original: card.from,
        text: card.to,
      })) as OverlayReplaceResult | undefined;
      if (reply?.ok) {
        setReplaced((r) => ({ ...r, [index]: "ok" }));
        setNotice(null);
      } else {
        setStaleIndexes((s) => ({ ...s, [index]: true }));
        setNotice(reply?.reason === "readonly" ? t("overlay.ui.cannotWrite") : t("overlay.ui.stale"));
      }
    },
    [t, tabId],
  );

  const doUndo = useCallback(
    async (index: number, card: RewriteCardState) => {
      const reply = (await chrome.runtime.sendMessage({
        type: "overlay:request-replace",
        tabId,
        original: card.to,
        text: card.from,
      })) as OverlayReplaceResult | undefined;
      if (reply?.ok) setReplaced((r) => ({ ...r, [index]: "undone" }));
    },
    [tabId],
  );

  const copyText = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(t("overlay.ui.copied"));
      window.setTimeout(() => setNotice(null), 1200);
    } catch {
      setNotice(t("common.copyFailed"));
    }
  }, [t]);

  const chat = messages.length > 0 || streaming;
  const busy = streaming;

  return (
    <div
      id="overlay-root"
      data-mode={chat ? "chat" : "spot"}
      className="flex w-full flex-col overflow-hidden rounded-[16px] border border-line bg-surface font-sans text-fg-1 shadow-[0_16px_48px_rgba(20,24,29,0.22)]"
    >
      {chat && (
        <div className="flex h-[42px] shrink-0 items-center gap-2 border-b border-line px-3">
          <span className="h-[13px] w-[13px] shrink-0 rounded-full bg-[radial-gradient(circle_at_34%_30%,#fafbfc_0_52%,#14181d_53%_100%)] ring-1 ring-line" />
          <span className="truncate text-[12.5px] font-medium">{sessionTitle(messages, t("overlay.ui.newChat"))}</span>
          <span className="shrink-0 text-[11.5px] text-fg-3">· {t("overlay.ui.sameSession")}</span>
          <span className="flex-1" />
          <IconBtn label={t("overlay.ui.newChat")} onClick={newChat}>＋</IconBtn>
          <IconBtn label={t("overlay.ui.toPanel")} onClick={toPanel} disabled={busy}>⤢</IconBtn>
          <IconBtn label={t("common.close")} onClick={requestClose}>×</IconBtn>
        </div>
      )}

      {chat && (
        <div className="flex max-h-[min(52vh,440px)] flex-col gap-3 overflow-y-auto px-4 py-3">
          {messages.map((m, i) => (
            <MessageRow
              key={i}
              m={m}
              rewrite={rewriteCards[i]}
              replaceState={replaced[i]}
              stale={staleIndexes[i] === true}
              canReplace={
                i === latestRewriteIndex &&
                replaced[i] === undefined &&
                !taskRanAfter(i) &&
                !streaming
              }
              onReplace={() => void doReplace(i, rewriteCards[i]!)}
              onUndo={() => void doUndo(i, rewriteCards[i]!)}
              onCopy={copyText}
            />
          ))}
          {streaming && (
            <div className="flex flex-col gap-1.5">
              {streamingThinking && (
                <div className="flex items-center gap-2 text-[11.5px] text-fg-3">
                  <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                  <span className="truncate">{streamingThinking.slice(-160)}</span>
                </div>
              )}
              {streamingText ? (
                <div className="text-[13px] leading-[19px]">
                  <Markdown content={streamingText} />
                  <span className="ml-0.5 inline-block h-[13px] w-[2px] animate-pulse bg-accent align-middle" />
                </div>
              ) : (
                <div className="flex items-center gap-2 text-[12px] text-fg-3">
                  <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                  <span>{t("overlay.ui.thinking")}</span>
                  <button type="button" className="ml-auto text-[11.5px] text-accent hover:underline" onClick={session.abort}>
                    {t("common.stop")}
                  </button>
                </div>
              )}
            </div>
          )}
          {session.error && (
            <div className="rounded-[10px] border border-warning-line bg-warning-tint px-2.5 py-2 text-[12px] text-warning">
              {t("overlay.ui.error", { error: session.error })}
            </div>
          )}
          {runningElsewhere && streaming && (
            <div className="text-[11px] text-fg-3">{t("overlay.ui.viewerNotice")}</div>
          )}
        </div>
      )}

      <div className="flex shrink-0 flex-col gap-1 px-3 pb-2 pt-2">
        <div className="flex items-end gap-2 rounded-[11px] border border-line bg-field px-2.5 py-1.5">
          <span className="mb-1 h-[13px] w-[13px] shrink-0 rounded-full bg-[radial-gradient(circle_at_34%_30%,#fafbfc_0_52%,#14181d_53%_100%)] ring-1 ring-line" />
          <textarea
            ref={textareaRef}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onTextareaKeyDown}
            placeholder={busy ? t("overlay.ui.placeholderBusy") : t("overlay.ui.placeholder")}
            className="max-h-[57px] min-h-[20px] flex-1 resize-none bg-transparent text-[13.5px] leading-[19px] text-fg-1 outline-none placeholder:text-fg-3"
            style={{ height: "auto" }}
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_LINES * 19)}px`;
            }}
          />
          <button
            type="button"
            onClick={send}
            disabled={busy || input.trim().length === 0}
            aria-label={t("common.send")}
            className="mb-0.5 flex h-[26px] w-[26px] items-center justify-center rounded-full bg-accent text-[13px] text-white disabled:opacity-40"
          >
            ↑
          </button>
        </div>
        <div className="flex items-center gap-1.5 px-1 text-[11px] text-fg-3">
          <Chip label={t("overlay.ui.chipPage")} />
          {selection && !selectionConsumed && (
            <Chip
              label={
                selection.editable
                  ? t("overlay.ui.chipSelectionEditable", { count: charCount(selection.text) })
                  : t("overlay.ui.chipSelection", { count: charCount(selection.text) })
              }
              onRemove={() => {
                setSelection(null);
                setSelectionConsumed(true);
              }}
            />
          )}
          <span className="flex-1" />
          <span className="truncate">{chat ? t("overlay.ui.hintsChat") : t("overlay.ui.hints")}</span>
        </div>
        {notice && <div className="px-1 text-[11px] text-warning">{notice}</div>}
      </div>
    </div>
  );
}

function charCount(text: string): number {
  return Array.from(text).length;
}

function sessionTitle(messages: DisplayMessage[], fallback: string): string {
  const first = messages.find((m) => m.role === "user");
  if (!first || first.role !== "user") return fallback;
  const text = first.content.replace(/\s+/g, " ").trim();
  return Array.from(text).slice(0, 18).join("");
}

/** Best-effort original for a rewrite card: the selection text this overlay
 *  opened with, when the card belongs to the current turn. */
function selectionTextFor(
  messages: DisplayMessage[],
  userMessage: DisplayMessage,
  selectionText: string | null,
): string | null {
  if (!selectionText) return null;
  const idx = messages.indexOf(userMessage);
  const after = messages.slice(idx + 1);
  // Only the turn that produced the card counts — a later user message means
  // this card belongs to an older turn and we no longer know its selection.
  return after.some((m) => m.role === "user") ? null : selectionText;
}

function IconBtn({
  children,
  label,
  onClick,
  disabled,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="flex h-6 w-6 items-center justify-center rounded-chip text-[13px] text-fg-2 hover:bg-field hover:text-fg-1 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function Chip({ label, onRemove }: { label: string; onRemove?: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-chip bg-field px-1.5 py-[2px] text-[10.5px] text-fg-2">
      {label}
      {onRemove && (
        <button type="button" onClick={onRemove} className="text-fg-3 hover:text-fg-1" aria-label="remove">
          ×
        </button>
      )}
    </span>
  );
}

function MessageRow({
  m,
  rewrite,
  replaceState,
  stale,
  canReplace,
  onReplace,
  onUndo,
  onCopy,
}: {
  m: DisplayMessage;
  rewrite?: RewriteCardState;
  replaceState?: "ok" | "undone";
  stale: boolean;
  canReplace: boolean;
  onReplace: () => void;
  onUndo: () => void;
  onCopy: (text: string) => void;
}) {
  const t = useT();
  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[82%] whitespace-pre-wrap rounded-[12px_12px_4px_12px] bg-bubble px-3 py-2 text-[13px] leading-[19px]">
          {m.content}
        </div>
      </div>
    );
  }
  if (m.role === "assistant") {
    if (!m.content.trim()) return null;
    return (
      <div className="text-[13px] leading-[19px]">
        <Markdown content={m.content} />
      </div>
    );
  }
  if (m.role === "agent-step" && m.tool === "propose_rewrite") {
    if (!rewrite) {
      // Restored card: no original to compare, so no write-back (prototype:
      // only the latest rewrite can replace, and only with a known original).
      const args = (m.args ?? {}) as { text?: string };
      if (!args.text) return null;
      return (
        <div className="rounded-[10px] border border-line bg-field px-2.5 py-2 text-[12.5px] leading-[18px]">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.12em] text-fg-3">
            {t("overlay.ui.rewriteLabel")}
          </div>
          <div className="whitespace-pre-wrap">{args.text}</div>
          <div className="mt-1.5 flex gap-2">
            <button type="button" className="rounded-chip border border-line px-2 py-0.5 text-[11.5px]" onClick={() => onCopy(args.text!)}>
              {t("common.copy")}
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-1.5 rounded-[10px] border border-line bg-surface px-2.5 py-2">
        <div className="flex gap-2 text-[12.5px] leading-[18px]">
          <span className="w-[34px] shrink-0 font-mono text-[10px] uppercase tracking-[0.1em] text-fg-3">{t("overlay.ui.original")}</span>
          <span className="text-fg-2 line-through decoration-line">{rewrite.from}</span>
        </div>
        <div className="flex gap-2 text-[13px] leading-[19px]">
          <span className="w-[34px] shrink-0 font-mono text-[10px] uppercase tracking-[0.1em] text-success">{t("overlay.ui.rewriteLabel")}</span>
          <span className="whitespace-pre-wrap rounded-[6px] bg-success-tint px-1 py-0.5">{rewrite.to}</span>
        </div>
        <div className="flex items-center gap-2 pt-0.5">
          {replaceState === "ok" ? (
            <span className="text-[11.5px] text-success">✓ {t("overlay.ui.replaced")}</span>
          ) : replaceState === "undone" ? (
            <span className="text-[11.5px] text-fg-3">↺ {t("overlay.ui.undone")}</span>
          ) : canReplace && !stale ? (
            <button type="button" onClick={onReplace} className="rounded-chip bg-accent px-2 py-0.5 text-[11.5px] font-medium text-white">
              {t("overlay.ui.replace")}
            </button>
          ) : (
            <span className="text-[11.5px] text-warning">{stale ? t("overlay.ui.stale") : t("overlay.ui.cannotWrite")}</span>
          )}
          <button type="button" onClick={() => onCopy(rewrite.to)} className="rounded-chip border border-line px-2 py-0.5 text-[11.5px]">
            {t("common.copy")}
          </button>
          {replaceState === "ok" && (
            <button type="button" onClick={onUndo} className="ml-auto text-[11.5px] text-accent hover:underline">
              {t("overlay.ui.undo")}
            </button>
          )}
        </div>
      </div>
    );
  }
  if (m.role === "agent-summary") {
    return (
      <div className={`rounded-[10px] border px-2.5 py-2 text-[12.5px] leading-[18px] ${m.success ? "border-success/40 bg-success-tint" : "border-warning-line bg-warning-tint"}`}>
        <div className="flex items-center gap-1.5 font-medium">
          <span>{m.success ? "✓" : "!"}</span>
          <span className="truncate">{m.summaryKey ? t(m.summaryKey as DictKey) : m.summary}</span>
        </div>
      </div>
    );
  }
  // Other agent steps stay out of the overlay thread — the capsule owns them.
  return null;
}
