import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import Markdown from "@/sidepanel/components/Markdown";
import { ModelPickerBody, ModelPickerTrigger } from "@/sidepanel/components/ModelPicker";
import { getLocale, useI18n, useT } from "@/lib/i18n";
import type { DictKey } from "@/lib/i18n";
import { getConfig } from "@/lib/idb/config-store";
import { getToolClass } from "@/lib/agent/tool-names";
import type { DisplayMessage } from "@/types";
import {
  OVERLAY_CARD_PAD as CARD_PAD,
  REWRITE_STYLE_IDS,
  type OverlayIntent,
  type OverlayOpenState,
  type OverlayReplaceResult,
  type OverlaySelection,
  type OverlayTask,
  type RewriteStyleId,
} from "@/lib/overlay/protocol";
import { buildOverlayWireContent as buildWireContent } from "@/lib/overlay/wire";
import { buildOverlayTaskInstruction } from "@/lib/overlay/task-text";
import { TRANSLATE_LANGS, quickTranslateLangs, translateLangName } from "@/lib/overlay/translate-target";
import { getOverlaySettings, rememberRewriteStyle, rememberTranslateLang } from "@/lib/overlay/settings";
import { startMemoryPrefetch, type MemoryPrefetch } from "@/lib/memory/selector";
import type { MemoryEntry } from "@/lib/memory/types";
import { MEMORY_SEND_WAIT_MS, shouldReuseMemoryPick } from "@/lib/overlay/memory-task";
import { MemoryEventRow, MemoryUsedChip } from "@/sidepanel/components/MemoryRows";
import { useStickToBottom } from "@/sidepanel/hooks/useStickToBottom";
import { useOverlaySession } from "./useOverlaySession";
import { useModelSelection } from "./useModelSelection";
import { usePanelRequest } from "@/sidepanel/hooks/usePanelRequest";
import { HitlInlineCards } from "@/sidepanel/components/hitl/HitlInlineCards";
import { processPickedFile } from "@/lib/files/process-picked-file";

/** Below this the composer never collapses — matches the host's min height. */
const MAX_TEXTAREA_LINES = 3;
/** Trigger row → popover edge, and popover → frame edge (room for its shadow). */
const POPOVER_FOOTER_OFFSET = 34;
const POPOVER_EDGE = 32; // shadow-pop: 0 8px 24px → 32px below the box
/** Fallback cap until the host reports the real viewport-derived one. */
const FALLBACK_MAX_HEIGHT = 620;

function currentColorScheme(): string {
  try {
    return getComputedStyle(document.documentElement).colorScheme || "light";
  } catch {
    return "light";
  }
}

function reportHeight(): void {
  const root = document.getElementById("overlay-root");
  if (!root) return;
  window.parent.postMessage(
    {
      type: "pie-overlay:resize",
      height: Math.ceil(root.getBoundingClientRect().height),
      // The host copies this onto the iframe element: a color-scheme mismatch
      // makes Chrome paint an opaque base behind the frame (opaque corners).
      colorScheme: currentColorScheme(),
    },
    "*",
  );
}

function requestClose(): void {
  window.parent.postMessage({ type: "pie-overlay:close" }, "*");
}


const STYLE_LABEL_KEY: Record<RewriteStyleId, DictKey> = {
  formal: "overlay.ui.styleFormal",
  concise: "overlay.ui.styleConcise",
  casual: "overlay.ui.styleCasual",
  proofread: "overlay.ui.styleProofread",
  expand: "overlay.ui.styleExpand",
};

interface RewriteCardState {
  to: string;
  from: string;
}

export default function OverlayApp() {
  const { t, locale } = useI18n();
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const sessionId = params.get("sessionId") ?? "";
  const tabId = Number(params.get("tabId") ?? "-1");
  const urlIntent = (params.get("intent") as OverlayIntent | null) ?? "hotkey";

  const [openState, setOpenState] = useState<OverlayOpenState | null>(null);
  const [runningElsewhere, setRunningElsewhere] = useState(false);
  const [input, setInput] = useState("");
  const [selection, setSelection] = useState<OverlaySelection | null>(null);
  const [selectionConsumed, setSelectionConsumed] = useState(false);
  const [replaced, setReplaced] = useState<Record<number, "ok" | "undone">>({});
  const [staleIndexes, setStaleIndexes] = useState<Record<number, true>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [maxHeight, setMaxHeight] = useState(FALLBACK_MAX_HEIGHT);
  const [translateTarget, setTranslateTarget] = useState("en");
  const [langOpen, setLangOpen] = useState(false);
  const [recentStyles, setRecentStyles] = useState<string[]>([]);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const modelRowRef = useRef<HTMLDivElement>(null);
  const modelPopoverRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  /** The frame grows upwards (bottom-anchored) — the popover opens upwards too. */
  const [growsUp, setGrowsUp] = useState(true);
  /** Extra frame margin the popover needs beyond the card's own. */
  const [popoverExtra, setPopoverExtra] = useState(0);
  useLayoutEffect(() => {
    const pop = modelPopoverRef.current;
    const card = cardRef.current;
    if (!modelPickerOpen || !pop || !card) {
      setPopoverExtra(0);
      return;
    }
    const measure = () => {
      const need = growsUp
        ? POPOVER_FOOTER_OFFSET + pop.offsetHeight + POPOVER_EDGE - card.offsetHeight
        : pop.offsetHeight + POPOVER_EDGE;
      setPopoverExtra(Math.max(0, need - CARD_PAD));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(pop);
    observer.observe(card);
    measure();
    return () => observer.disconnect();
  }, [modelPickerOpen, growsUp]);
  useEffect(() => {
    if (!modelPickerOpen) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!modelRowRef.current?.contains(target) && !modelPopoverRef.current?.contains(target)) {
        setModelPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [modelPickerOpen]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sendRef = useRef<() => void>(() => {});
  const { containerRef, onScroll, stickIfNeeded } = useStickToBottom<HTMLDivElement>();

  // The SW's open state is authoritative: the document can be reused for a
  // later open, and then its URL still carries the first intent.
  const intent: OverlayIntent = openState?.intent ?? urlIntent;

  const session = useOverlaySession({ sessionId, tabId, runningElsewhere });
  const model = useModelSelection(sessionId);
  // HITL cards (permissions, confirmations, pickers) render in this thread —
  // the SW registers the overlay document as the session's panel-request port.
  const { active: panelRequest, respond: respondPanel } = usePanelRequest(sessionId || null);
  const localFileInputRef = useRef<HTMLInputElement>(null);
  // A card arriving while the surface is hidden (Esc during a run) brings it back.
  useEffect(() => {
    if (panelRequest) window.parent.postMessage({ type: "pie-overlay:reveal" }, "*");
  }, [panelRequest]);
  const onLocalFilePicked = useCallback(
    async (file: File | undefined) => {
      if (!panelRequest) return;
      const id = panelRequest.requestId;
      if (!file) return respondPanel(id, { ok: false, reason: "cancelled by user" });
      try {
        const r = await processPickedFile(file, { supportsVision: false });
        if (r.ok && r.kind === "file") {
          const a = r.attachment;
          return respondPanel(id, { ok: true, data: { name: a.name, mime: a.mime, text: a.text, truncated: a.truncated } });
        }
        respondPanel(id, {
          ok: false,
          reason: "image_or_unsupported: that file type can't be returned here; for images use the + menu",
        });
      } catch {
        respondPanel(id, { ok: false, reason: "processing failed" });
      }
    },
    [panelRequest, respondPanel],
  );
  const { messages, streaming, streamingText, streamingThinking } = session;

  // ── Memory prefetch (spec §5.5) ───────────────────────────────────────────
  // Started as soon as the overlay opens — the user's typing time is the
  // budget. The pick is reused at send time unless the typed task drifted.
  const openStateRef = useRef<OverlayOpenState | null>(null);
  openStateRef.current = openState;
  const prefetchRef = useRef<{ task: string; prefetch: MemoryPrefetch } | null>(null);
  /** A send is waiting on the pick — swallow a second Enter. */
  const sendingRef = useRef(false);

  const takeMemoryPick = useCallback(
    async (text: string): Promise<{ pick: MemoryEntry[]; at: number } | null> => {
      const cur = prefetchRef.current;
      const reuse = cur !== null && shouldReuseMemoryPick(cur.task, text);
      const prefetch = reuse
        ? cur!.prefetch
        : startMemoryPrefetch({
            task: text,
            pageTitle: openStateRef.current?.pageTitle,
            pageUrl: openStateRef.current?.pageUrl,
          });
      const at = reuse ? cur!.prefetch.startedAt : Date.now();
      const timedOut = Symbol("timeout");
      const result = await Promise.race([
        prefetch.promise,
        new Promise<typeof timedOut>((resolve) =>
          window.setTimeout(() => resolve(timedOut), MEMORY_SEND_WAIT_MS),
        ),
      ]);
      if (result === timedOut) {
        // A reused prefetch may still settle for a later turn; a fresh one only
        // existed to make this send wait, so drop it.
        if (!reuse) prefetch.abort();
        return null;
      }
      return result.length > 0 ? { pick: result, at } : null;
    },
    [],
  );

  // ── Theme: same config the side panel uses ────────────────────────────────
  useEffect(() => {
    void getConfig<string>("theme-mode").then((mode) => {
      if (mode === "light" || mode === "dark") {
        document.documentElement.dataset.theme = mode;
      } else {
        delete document.documentElement.dataset.theme;
      }
      reportHeight();
    });
  }, []);

  // ── Open state (selection / prefill / auto-send) ──────────────────────────
  // The SAME document serves several opens on one tab (hide keeps it alive),
  // so the state is re-read every time the host announces an open — not just
  // on mount.
  const aliveRef = useRef(true);
  const autoSentRef = useRef(false);
  /** `openedAt` of the open that last reset the auto-send guard. */
  const autoOpenTokenRef = useRef<number | null>(null);

  const fetchOpenState = useCallback(async () => {
    try {
      const reply = (await chrome.runtime.sendMessage({
        type: "overlay:get-state",
        sessionId,
        tabId,
      })) as { state?: OverlayOpenState | null; running?: boolean } | undefined;
      if (!aliveRef.current) return;
      const state = reply?.state ?? null;
      setOpenState(state);
      setRunningElsewhere(reply?.running === true);
      if (state?.translateTarget) setTranslateTarget(state.translateTarget);
      setSelection(state?.selection ?? null);
      setSelectionConsumed(false);
      if (state?.prompt) setInput(state.prompt);
      if (state?.openedAt !== undefined && state.openedAt !== autoOpenTokenRef.current) {
        autoOpenTokenRef.current = state.openedAt;
        autoSentRef.current = false;
      }
    } catch {
      // SW unavailable — the overlay still works as a plain conversation.
    }
  }, [sessionId, tabId]);

  useEffect(() => {
    aliveRef.current = true;
    void fetchOpenState();
    return () => {
      aliveRef.current = false;
    };
  }, [fetchOpenState]);

  // Recent custom rewrite instructions (global settings, shared with the
  // settings page's clear button).
  useEffect(() => {
    void getOverlaySettings().then((s) => setRecentStyles(s.recentRewriteStyles));
  }, []);

  // ── Host ↔ document: height cap + "a new open just happened" ──────────────
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.source !== window.parent) return;
      const data = e.data as { type?: string; height?: number; growsUp?: boolean } | null;
      if (data?.type === "pie-overlay:opened") {
        void fetchOpenState();
        return;
      }
      if (data?.type !== "pie-overlay:max-height" || typeof data.height !== "number") return;
      if (!Number.isFinite(data.height)) return;
      setMaxHeight(Math.max(120, Math.round(data.height)));
      if (typeof data.growsUp === "boolean") setGrowsUp(data.growsUp);
    }
    window.addEventListener("message", onMessage);
    // Ask the host for the cap + open state once our listeners are attached;
    // its load-time pushes may have fired before this effect ran.
    window.parent.postMessage({ type: "pie-overlay:ready" }, "*");
    return () => window.removeEventListener("message", onMessage);
  }, [fetchOpenState]);

  // ── Memory prefetch kick-off ──────────────────────────────────────────────
  useEffect(() => {
    if (!openState) return;
    const task =
      (openState.selection?.text ?? "").trim() || openState.pageTitle || openState.pageUrl || "";
    const prefetch = startMemoryPrefetch({
      task,
      pageTitle: openState.pageTitle,
      pageUrl: openState.pageUrl,
    });
    prefetchRef.current = { task, prefetch };
    return () => prefetch.abort();
  }, [openState]);

  const rewriteMode = intent === "rewrite" && selection !== null;
  const translateMode = intent === "translate" && selection !== null;
  // Language names in the UI language — `Intl` owns the translations.
  const langName = useCallback((code: string) => translateLangName(code, locale), [locale]);

  /** One send path for every mode: pick memory, then hand the turn to the
   *  session (structured tasks carry the overlay intent, not a prompt text). */
  const dispatch = useCallback(
    (
      content: string,
      opts: {
        wireText?: string;
        overlayTask?: OverlayTask;
        editableSelection?: boolean;
        rememberCustom?: string;
      } = {},
    ) => {
      const text = content.trim();
      if (!text || streaming || !session.ready || sendingRef.current) return false;
      sendingRef.current = true;
      // A structured turn is stored with the instruction + quote it stood for
      // (the SW rebuilds the live one). History that only said "翻译成日语"
      // without the text or target let the next turn copy the previous answer.
      const task = opts.overlayTask;
      const wireText =
        opts.wireText ??
        (task
          ? buildWireContent(
              buildOverlayTaskInstruction(task, getLocale(), opts.editableSelection === true),
              task.selection ? { ...task.selection, editable: false } : null,
            )
          : undefined);
      void (async () => {
        const mem = await takeMemoryPick(text);
        session.send({
          content: text,
          ...(wireText !== undefined ? { expandedForLLM: wireText } : {}),
          ...(opts.editableSelection ? { editableSelection: true } : {}),
          ...(mem ? { memoryPick: mem.pick, memoryPickAsOf: mem.at } : {}),
          ...(opts.overlayTask ? { overlayTask: opts.overlayTask } : {}),
        });
        sendingRef.current = false;
      })();
      if (opts.rememberCustom) {
        void rememberRewriteStyle(opts.rememberCustom).then((s) =>
          setRecentStyles(s.recentRewriteStyles),
        );
      }
      return true;
    },
    [session, streaming, takeMemoryPick],
  );

  // ── Auto-send (explain / omnibox) ─────────────────────────────────────────
  const readyForAuto = session.ready;
  useEffect(() => {
    if (autoSentRef.current) return;
    if (!openState || !openState.autoSend) return;
    if (!readyForAuto) return;
    autoSentRef.current = true;
    const sel = openState.selection;
    if (intent === "explain" && sel) {
      dispatch(t("overlay.ui.explainShort"), {
        overlayTask: { kind: "explain", selection: { text: sel.text, url: sel.url } },
      });
    } else if (openState.prompt) {
      dispatch(openState.prompt, { wireText: buildWireContent(openState.prompt, sel) });
    }
    setSelectionConsumed(true);
    setInput("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openState, readyForAuto, intent]);

  // ── Height reporting for the iframe host ──────────────────────────────────
  useEffect(() => {
    const root = document.getElementById("overlay-root");
    if (!root) return;
    const observer = new ResizeObserver(() => reportHeight());
    // border-box: the popover margin is padding, invisible to content-box.
    observer.observe(root, { box: "border-box" });
    reportHeight();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    reportHeight();
  }, [maxHeight]);

  // Stick to the tail like the side panel: follow new content while the user
  // is at the bottom, stop following as soon as they scroll up.
  useEffect(() => {
    stickIfNeeded();
  }, [messages, streamingText, streamingThinking, session.panelNotice, panelRequest, stickIfNeeded]);

  // ── Focus on open ─────────────────────────────────────────────────────────
  useEffect(() => {
    textareaRef.current?.focus({ preventScroll: true });
  }, []);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    // Translate keeps its selection: typed text there is "do this to it".
    const sel = selectionConsumed && !translateMode ? null : selection;
    let sent = false;
    if (rewriteMode && selection) {
      // Typed text IS the rewrite instruction; a style chip click sends
      // separately through `sendRewriteStyle`.
      sent = dispatch(text, {
        overlayTask: {
          kind: "rewrite",
          custom: text,
          selection: { text: selection.text, url: selection.url },
        },
        editableSelection: selection.editable,
        rememberCustom: text,
      });
    } else {
      sent = dispatch(text, {
        wireText: buildWireContent(text, sel),
        ...(sel?.editable ? { editableSelection: true } : {}),
      });
    }
    if (sent) {
      setInput("");
      setSelectionConsumed(true);
      setNotice(null);
      setModelPickerOpen(false);
    }
  }, [input, rewriteMode, translateMode, selection, selectionConsumed, dispatch]);

  sendRef.current = send;

  const sendRewriteStyle = useCallback(
    (style: RewriteStyleId) => {
      if (!selection) return;
      const styleLabel = t(STYLE_LABEL_KEY[style]);
      dispatch(t("overlay.ui.rewriteShort", { style: styleLabel }), {
        overlayTask: {
          kind: "rewrite",
          style,
          selection: { text: selection.text, url: selection.url },
        },
        editableSelection: selection.editable,
      });
      setSelectionConsumed(true);
      setNotice(null);
    },
    [dispatch, selection, t],
  );

  /** One click = one translation; picking another language re-translates. */
  const sendTranslate = useCallback(
    (lang: string) => {
      if (!selection) return;
      setLangOpen(false);
      const sent = dispatch(t("overlay.ui.translateShort", { lang: langName(lang) }), {
        overlayTask: {
          kind: "translate",
          targetLang: lang,
          selection: { text: selection.text, url: selection.url },
        },
        editableSelection: selection.editable,
      });
      if (!sent) return;
      setTranslateTarget(lang);
      setSelectionConsumed(true);
      setNotice(null);
      void rememberTranslateLang(lang);
    },
    [dispatch, langName, selection, t],
  );

  const toPanel = useCallback(() => {
    void chrome.runtime.sendMessage({ type: "overlay:to-panel", sessionId, tabId });
  }, [sessionId, tabId]);

  const openMemorySettings = useCallback(() => {
    void chrome.runtime.sendMessage({ type: "overlay:open-memory-settings", tabId });
  }, [tabId]);

  const openModelSettings = useCallback(() => {
    void chrome.runtime.sendMessage({ type: "overlay:open-model-settings", tabId });
  }, [tabId]);

  const newChat = useCallback(() => {
    void chrome.runtime.sendMessage({ type: "overlay:new-chat", tabId });
  }, [tabId]);

  // ── Keyboard: Enter / Shift+Enter / ⌘Enter / ⌘K / Esc ─────────────────────
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape") {
        if (modelPickerOpen) {
          e.preventDefault();
          setModelPickerOpen(false);
          return;
        }
        if (langOpen) {
          e.preventDefault();
          setLangOpen(false);
          return;
        }
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
  }, [newChat, toPanel, langOpen, modelPickerOpen]);

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
  const cardMaxHeight = Math.max(120, maxHeight - CARD_PAD * 2);

  // The selection the next send acts on. Translate / rewrite keep it for
  // follow-up clicks; a plain question consumes it.
  const activeSelection =
    selection && (translateMode || rewriteMode || !selectionConsumed) ? selection : null;

  const selectionRow = activeSelection ? (
    <div className="flex items-center gap-2 rounded-[10px] bg-field py-1.5 pl-2.5 pr-1.5" data-selection-row>
      <span className="h-[14px] w-[2px] shrink-0 rounded-full bg-accent opacity-60" />
      <span className="min-w-0 flex-1 truncate text-[12px] leading-[18px] text-fg-2">{activeSelection.text}</span>
      <span className="shrink-0 text-[11px] text-fg-3">
        {activeSelection.editable
          ? t("overlay.ui.chipSelectionEditable", { count: charCount(activeSelection.text) })
          : t("overlay.ui.chipSelection", { count: charCount(activeSelection.text) })}
      </span>
      <button
        type="button"
        onClick={() => {
          setSelection(null);
          setSelectionConsumed(true);
          setLangOpen(false);
        }}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[13px] text-fg-3 hover:bg-surface hover:text-fg-1"
        aria-label={t("overlay.ui.removeSelection")}
        title={t("overlay.ui.removeSelection")}
      >
        ×
      </button>
    </div>
  ) : null;

  // Provider · model — same selection the side panel's composer shows. Rendered
  // in flow (not as a popover) because the card clips whatever leaves it.
  const modelRow = (
    <div ref={modelRowRef} className="flex items-center gap-1" data-model-row>
      <ModelPickerTrigger
        instances={model.instances}
        currentInstanceId={model.currentInstanceId}
        currentModel={model.currentModel}
        locked={busy}
        open={modelPickerOpen}
        onToggle={() => setModelPickerOpen((v) => !v)}
        className="rounded-chip hover:bg-field"
      />
    </div>
  );

  // The side panel composer's popover, floated off the trigger into the
  // frame's transparent margin (the frame grows to fit, in the direction it
  // already grows, so the card itself never moves or stretches).
  const modelPopover = modelPickerOpen ? (
    <div
      ref={modelPopoverRef}
      role="dialog"
      data-model-panel
      className="absolute left-2 z-10 flex w-[300px] max-w-[calc(100%-1rem)] flex-col overflow-y-auto rounded-card border border-line bg-surface shadow-pop"
      style={
        growsUp
          ? { bottom: POPOVER_FOOTER_OFFSET, maxHeight: Math.max(160, maxHeight - CARD_PAD - POPOVER_FOOTER_OFFSET - POPOVER_EDGE) }
          : { top: "calc(100% + 6px)", maxHeight: Math.max(160, maxHeight - CARD_PAD * 2 - (cardRef.current?.offsetHeight ?? 0) - POPOVER_EDGE) }
      }
    >
      <ModelPickerBody
        instances={model.instances}
        currentInstanceId={model.currentInstanceId}
        currentModel={model.currentModel}
        onSelect={(id, m) => void model.select(id, m)}
        onManage={openModelSettings}
        onRefreshModels={(id) => void model.refreshModels(id)}
        isOpen={modelPickerOpen}
        onClose={() => setModelPickerOpen(false)}
      />
    </div>
  ) : null;

  const actionRow = translateMode ? (
    <div className="flex flex-wrap items-center gap-1.5" data-action-row="translate">
      <span className="pr-0.5 text-[11.5px] text-fg-3">{t("overlay.ui.translateRow")}</span>
      {quickTranslateLangs(translateTarget, selection?.text ?? "").map((lang) => (
        <Pill
          key={lang}
          primary={lang === translateTarget}
          onClick={() => sendTranslate(lang)}
          disabled={busy}
          data-lang={lang}
        >
          {langName(lang)}
        </Pill>
      ))}
      <Pill onClick={() => setLangOpen((v) => !v)} disabled={busy} aria-expanded={langOpen}>
        {t("overlay.ui.moreLangs")} {langOpen ? "▴" : "▾"}
      </Pill>
      {langOpen && (
        // In flow, not a popover: the card clips its children (rounded corners
        // + scrolling thread), so an absolutely-positioned list was cut off.
        <div role="listbox" className="grid w-full grid-cols-3 gap-0.5 rounded-[10px] border border-line bg-surface p-1">
          {TRANSLATE_LANGS.map((lang) => (
            <button
              key={lang}
              type="button"
              role="option"
              aria-selected={lang === translateTarget}
              data-lang={lang}
              onClick={() => sendTranslate(lang)}
              className={`truncate rounded-[6px] px-2 py-1 text-left text-[12px] hover:bg-field ${
                lang === translateTarget ? "font-medium text-accent" : "text-fg-2"
              }`}
            >
              {langName(lang)}
            </button>
          ))}
        </div>
      )}
    </div>
  ) : rewriteMode ? (
    <div className="flex flex-wrap items-center gap-1.5" data-action-row="rewrite">
      <span className="pr-0.5 text-[11.5px] text-fg-3">{t("overlay.ui.rewriteRow")}</span>
      {REWRITE_STYLE_IDS.map((style) => (
        <Pill key={style} onClick={() => sendRewriteStyle(style)} disabled={busy}>
          {t(STYLE_LABEL_KEY[style])}
        </Pill>
      ))}
      {recentStyles.map((text) => (
        <Pill
          key={`recent-${text}`}
          onClick={() =>
            selection &&
            dispatch(text, {
              overlayTask: {
                kind: "rewrite",
                custom: text,
                selection: { text: selection.text, url: selection.url },
              },
              editableSelection: selection.editable,
            })
          }
          disabled={busy}
          title={text}
        >
          {text}
        </Pill>
      ))}
    </div>
  ) : null;

  return (
    <div
      id="overlay-root"
      data-mode={chat ? "chat" : "spot"}
      className="flex w-full flex-col"
      // Both paddings always present: React clears a key that disappears from
      // the object, and removing one longhand resets the `padding` shorthand
      // (the card lost its top margin on the first host message).
      style={{
        paddingLeft: CARD_PAD,
        paddingRight: CARD_PAD,
        paddingTop: CARD_PAD + (growsUp ? popoverExtra : 0),
        paddingBottom: CARD_PAD + (growsUp ? 0 : popoverExtra),
      }}
    >
      <div className="relative w-full">
      <div
        ref={cardRef}
        data-card
        className="flex w-full flex-col overflow-hidden rounded-[16px] border border-line bg-surface font-sans text-fg-1 shadow-[0_10px_28px_-6px_rgba(20,24,29,0.22),0_1px_4px_rgba(20,24,29,0.08)]"
        style={{ maxHeight: cardMaxHeight }}
      >
        {chat && (
          <div className="flex h-[42px] shrink-0 items-center gap-2 border-b border-line px-3">
            <PieMark className="h-[15px] w-[15px] shrink-0 text-fg-1" />
            <span className="truncate text-[12.5px] font-medium">{sessionTitle(messages, t("overlay.ui.newChat"))}</span>
            <span className="shrink-0 text-[11.5px] text-fg-3">· {t("overlay.ui.sameSession")}</span>
            <span className="flex-1" />
            <IconBtn label={t("overlay.ui.newChat")} onClick={newChat}>＋</IconBtn>
            <IconBtn label={t("overlay.ui.toPanel")} onClick={toPanel} disabled={busy}>⤢</IconBtn>
            <IconBtn label={t("common.close")} onClick={requestClose}>×</IconBtn>
          </div>
        )}

        {chat && (
          <div
            ref={containerRef}
            onScroll={onScroll}
            data-thread
            className="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 py-3"
          >
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
                onMemoryWrong={openMemorySettings}
              />
            ))}
            {session.panelNotice === "panel-request" && !panelRequest && (
              <div className="text-[11.5px] text-fg-3" data-testid="overlay-panel-notice">
                {t("overlay.ui.needsPanelConfirm")}
              </div>
            )}
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
            <HitlInlineCards
              request={panelRequest}
              respond={respondPanel}
              instances={model.instances}
              onChooseLocalFile={() => localFileInputRef.current?.click()}
            />
            <input
              ref={localFileInputRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                void onLocalFilePicked(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
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

        <div className={`flex shrink-0 flex-col gap-2 px-3 pb-2 pt-2.5 ${chat ? "border-t border-line" : ""}`}>
          {selectionRow}
          {actionRow}
          <div className="flex items-end gap-2 rounded-[12px] border border-line bg-field py-[5px] pl-2.5 pr-[5px] focus-within:border-fg-3">
            <span className="flex h-[26px] shrink-0 items-center">
              <PieMark className="h-[15px] w-[15px] text-fg-1" />
            </span>
            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onTextareaKeyDown}
              placeholder={
                busy
                  ? t("overlay.ui.placeholderBusy")
                  : rewriteMode
                    ? t("overlay.ui.rewritePlaceholder")
                    : translateMode
                      ? t("overlay.ui.translatePlaceholder")
                      : t("overlay.ui.placeholder")
              }
              className="min-h-[26px] flex-1 resize-none bg-transparent py-[3px] text-[13.5px] leading-[20px] text-fg-1 outline-none placeholder:text-fg-3"
              style={{ height: "auto", maxHeight: MAX_TEXTAREA_LINES * 20 + 6 }}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_LINES * 20 + 6)}px`;
              }}
            />
            <button
              type="button"
              onClick={send}
              disabled={busy || input.trim().length === 0}
              aria-label={t("common.send")}
              className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-accent text-[13px] text-white disabled:opacity-40"
            >
              ↑
            </button>
          </div>
          <div className="flex items-center gap-2 px-1 text-[11px] text-fg-3">
            {modelRow}
            {notice && <span className="truncate text-warning">{notice}</span>}
            <span className="flex-1" />
            <span className="shrink-0">{chat ? t("overlay.ui.hintsChat") : t("overlay.ui.hints")}</span>
          </div>
        </div>
      </div>
      {modelPopover}
      </div>
    </div>
  );
}

function charCount(text: string): number {
  return Array.from(text).length;
}

/** The bite-marked disc from the app icon, no square plate. Painted in the
 *  text colour, so it is a dark disc on light themes and a white one on dark,
 *  which keeps it solid in both and never reads as a loading ring. */
function PieMark({ className }: { className?: string }) {
  const maskId = useId();
  return (
    <svg viewBox="0 0 128 128" className={className} aria-hidden="true">
      <mask id={maskId}>
        <rect width="128" height="128" fill="#fff" />
        <circle cx="98" cy="30" r="22" fill="#000" />
      </mask>
      <circle cx="64" cy="64" r="44" fill="currentColor" mask={`url(#${maskId})`} />
    </svg>
  );
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

function Pill({
  children,
  onClick,
  disabled,
  title,
  primary,
  ...rest
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  primary?: boolean;
  "aria-expanded"?: boolean;
  "data-lang"?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`h-[26px] max-w-[200px] truncate rounded-full border px-2.5 text-[12px] disabled:opacity-40 ${
        primary
          ? "border-accent bg-surface font-medium text-accent"
          : "border-line bg-surface text-fg-2 hover:border-fg-3 hover:text-fg-1"
      }`}
      {...rest}
    >
      {children}
    </button>
  );
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

function MessageRow({
  m,
  rewrite,
  replaceState,
  stale,
  canReplace,
  onReplace,
  onUndo,
  onCopy,
  onMemoryWrong,
}: {
  m: DisplayMessage;
  rewrite?: RewriteCardState;
  replaceState?: "ok" | "undone";
  stale: boolean;
  canReplace: boolean;
  onReplace: () => void;
  onUndo: () => void;
  onCopy: (text: string) => void;
  onMemoryWrong: () => void;
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
  // Pie 2.0 memory — F4 rows. "不对" jumps to the panel's memory page.
  if (m.role === "memory-used") {
    return <MemoryUsedChip items={m.items} onWrong={onMemoryWrong} />;
  }
  if (m.role === "memory-event") {
    return <MemoryEventRow msg={m} />;
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
