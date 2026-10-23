import type { Tool, ToolHandlerContext } from "../types";
import type { ActionResult } from "../../dom-actions/types";
import { probePageInjected, type ProbeResult } from "../../dom-actions/probe-core";
import { escapeWrapperAttribute, escapeUntrustedWrappers } from "../untrusted-wrappers";
import { isRestrictedSchemeForGrouping } from "./tabs";
import { isPdfTabAsync } from "@/lib/pdf/detect";
import { pageAtlasStore, parseOrigin, type PageAtlasState } from "./page-atlas";
import { renderPageAtlas } from "./page-atlas/render";
import { executeScriptAllFrames, type AllFramesInjectionOutcome } from "../inject-all-frames";
import { estimateTokens } from "../window-token-budget";
import { diag, kv } from "../diag";
import { extractPageTextInjected, type PageTextResult } from "../../dom-actions/page-text";

// Every read_page call is bounded and small by default. Weak local models
// (qwen via Ollama) drowned in the old 300–500 KB raw-HTML budgets; strong
// models never needed them (atlas + read_target/find_target cover structure).
//
// The ADVERTISED schema is deliberately tiny — tabId (optional, defaults to
// the task's current tab), mode text|interactive|atlas, query, offset — and
// every footer only names those. The handler still honours the older surface
// for back-compat (old transcripts, skills, strong models):
//
//   text (default)  readable text, paged by `offset`, filtered by `query`
//   interactive     element index, capped at `max_elements` (hidden arg)
//   atlas           compact Page Atlas (capped by render.ts) — advertised only
//                   because find_target/read_struct/read_target need its ids
//   full            hidden: text (first page) + capped interactive index
//   html            hidden: raw markup, hard cap HTML_MAX_BYTES — last resort
//   auto / content  hidden aliases of text
//   max_chars / max_bytes / scope / max_elements   hidden, still honoured

/** mode="html" hard byte cap (and default). */
export const HTML_MAX_BYTES = 30_000;

/** mode="text" char budget: default + clamp range for `max_chars`. */
export const TEXT_MAX_CHARS_DEFAULT = 8_000;
export const TEXT_MAX_CHARS_MIN = 500;
export const TEXT_MAX_CHARS_MAX = 60_000;
/**
 * How much text the injected extractor hands back in one go. The SW slices
 * pages (`offset`) and query hits out of it, so paging never re-walks with a
 * different cut and offsets stay stable across calls.
 */
export const TEXT_EXTRACT_CAP = 400_000;
const TEXT_INJECT_TIMEOUT_MS = 10_000;

/** mode="interactive"/"full" element cap: default + clamp range for `max_elements`. */
export const INTERACTIVE_MAX_DEFAULT = 60;
export const INTERACTIVE_MAX_MIN = 10;
export const INTERACTIVE_MAX_MAX = 300;

/** mode="text" + query: matched lines shown before "N more matches". */
export const QUERY_MAX_HITS = 40;

/** Per-field cap inside a compact interactive_element line. */
const ELEMENT_FIELD_MAX = 80;

function toFiniteNumber(raw: unknown): number | undefined {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

export function resolveTextMaxChars(raw: unknown): number {
  const n = toFiniteNumber(raw);
  if (n === undefined) return TEXT_MAX_CHARS_DEFAULT;
  return Math.max(TEXT_MAX_CHARS_MIN, Math.min(TEXT_MAX_CHARS_MAX, Math.floor(n)));
}

export function resolveMaxElements(raw: unknown): number {
  const n = toFiniteNumber(raw);
  if (n === undefined) return INTERACTIVE_MAX_DEFAULT;
  return Math.max(INTERACTIVE_MAX_MIN, Math.min(INTERACTIVE_MAX_MAX, Math.floor(n)));
}

function resolveOffset(raw: unknown): number {
  const n = toFiniteNumber(raw);
  return n === undefined || n < 0 ? 0 : Math.floor(n);
}

function resolveHtmlBudget(rawMaxBytes: unknown): number {
  const n = toFiniteNumber(rawMaxBytes);
  if (n === undefined) return HTML_MAX_BYTES;
  return Math.max(1, Math.min(HTML_MAX_BYTES, Math.floor(n)));
}

type ReadPageMode = "text" | "atlas" | "interactive" | "full" | "html";

interface ReadPageArgs {
  tabId?: number;
  mode?: string;
  max_bytes?: number;
  max_chars?: number;
  max_elements?: number;
  offset?: number;
  query?: string;
  scope?: "main" | "page";
}

export function normalizeMode(mode: unknown): ReadPageMode {
  return mode === "atlas" || mode === "interactive" || mode === "full" || mode === "html" ? mode : "text";
}

/** Query terms: `|`-separated alternatives, trimmed, lower-cased. */
export function parseQuery(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split("|")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
}

function matchesQuery(haystack: string, terms: string[]): boolean {
  const lower = haystack.toLowerCase();
  return terms.some((t) => lower.includes(t));
}

// ---------------------------------------------------------------------------
// Unchanged re-read memo. A model that re-reads the same page with the same
// arguments gets the same content back, prefixed with one line saying so —
// the content is never omitted (the earlier copy may have been elided from
// context). Keyed per tab; only the immediately previous read counts.
// ---------------------------------------------------------------------------

export const UNCHANGED_PREFIX = "(Unchanged since your previous read_page of this page.)";

const lastReadByTab = new Map<number, { sig: string; hash: string; at: number }>();
const MEMO_MAX_TABS = 64;

function hashText(text: string): string {
  // FNV-1a 32-bit + length: cheap, and a collision only costs a missing hint.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(16)}:${text.length}`;
}

function applyUnchangedMemo(tabId: number, sig: string, observation: string): string {
  const hash = hashText(observation);
  const prev = lastReadByTab.get(tabId);
  lastReadByTab.delete(tabId);
  lastReadByTab.set(tabId, { sig, hash, at: Date.now() });
  if (lastReadByTab.size > MEMO_MAX_TABS) {
    const oldest = lastReadByTab.keys().next().value;
    if (oldest !== undefined) lastReadByTab.delete(oldest);
  }
  return prev && prev.sig === sig && prev.hash === hash ? `${UNCHANGED_PREFIX}\n${observation}` : observation;
}

/** Test hook. */
export function __resetReadPageMemo(): void {
  lastReadByTab.clear();
}

function classifyUnreachable(url: string, errorOccurred?: boolean, timedOut?: boolean): string {
  // 注入永不返回的僵尸 frame（导航被打断的沙箱 frame，如 micro-app/wujie iframe
  // 模式）——元数据看起来完全健康，只能靠超时识别。
  if (timedOut) return "not-responding";
  if (url.startsWith("chrome-extension://")) return "extension-child";
  if (url === "about:blank" && !errorOccurred) return "about-blank";
  if (errorOccurred) return "frame-error";
  return "sandbox";
}

// atlas/auto mode counterpart to the snapshot path's per-frame unreachable
// blocks: list every frame that yielded no atlas result so the LLM can tell a
// child app frame is genuinely unreadable (and stop retrying) rather than
// having it vanish silently.
function renderAtlasUnreachableFrames(
  frames: chrome.webNavigation.GetAllFrameResultDetails[],
  reachableFrameIds: Set<number>,
  timedOutFrameIds: Set<number>,
): string {
  const lines = frames
    .filter((f) => !reachableFrameIds.has(f.frameId))
    .sort((a, b) => a.frameId - b.frameId)
    .map((f) => {
      const reason = classifyUnreachable(f.url, f.errorOccurred, timedOutFrameIds.has(f.frameId));
      return `  frame_id="${f.frameId}" url="${escapeWrapperAttribute(f.url)}" unreachable="true" reason="${reason}"`;
    });
  if (lines.length === 0) return "";
  return ["<frame_map>", ...lines, "</frame_map>"].join("\n");
}

function attr(name: string, value: string | number | boolean): string {
  return `${name}="${escapeWrapperAttribute(String(value))}"`;
}

function elementText(value: string): string {
  return escapeWrapperAttribute(escapeUntrustedWrappers(value));
}

/**
 * `Current URL` / `Page title` lines that head every read_page observation,
 * so the model can check which page it is reading. The title is page text:
 * wrapper tags in it are escaped. When the tab's URL and the document's URL
 * disagree the page is mid-navigation — say so instead of letting the model
 * trust a page that is about to be replaced.
 */
export function pageHeaderLines(info: { tabId?: number; url: string; title: string; tabUrl: string }): string[] {
  const lines = [
    ...(info.tabId !== undefined ? [`Tab: ${info.tabId}`] : []),
    `Current URL: ${info.url}`,
    `Page title: ${escapeUntrustedWrappers(info.title)}`,
  ];
  if (info.tabUrl && info.url && info.tabUrl !== info.url) {
    lines.push(
      `Note: the browser reports ${info.tabUrl} but the document is still ${info.url} — ` +
        "the page is probably mid-navigation; call read_page again in a moment.",
    );
  }
  return lines;
}

/** One page of `full` starting at `offset`, cut on a line boundary. */
export function slicePageText(
  full: string,
  offset: number,
  maxChars: number,
): { start: number; end: number; next: number | null } {
  const total = full.length;
  // Snap a mid-line offset back to its line start so no line is shown torn.
  let start = Math.min(Math.max(0, offset), total);
  if (start > 0 && start < total && full[start - 1] !== "\n") {
    start = full.lastIndexOf("\n", start - 1) + 1;
  }
  let end = start + maxChars;
  if (end >= total) return { start, end: total, next: null };
  const nl = full.lastIndexOf("\n", end);
  // Prefer the line boundary unless that would throw away more than half the
  // page (one giant line) — then hard-cut.
  if (nl > start + maxChars * 0.5) end = nl;
  const next = full[end] === "\n" ? end + 1 : end;
  return { start, end, next: next < total ? next : null };
}

/** Lines matching `terms` (from `offset` on), ±1 line of context, merged. */
export function renderTextQuery(
  full: string,
  terms: string[],
  offset: number,
  maxChars: number,
): { body: string; matches: number; shown: number; nextOffset: number | null } {
  const lines = full.split("\n");
  const starts: number[] = [];
  let pos = 0;
  for (const line of lines) {
    starts.push(pos);
    pos += line.length + 1;
  }
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (starts[i] + lines[i].length < offset) continue;
    if (lines[i] && matchesQuery(lines[i], terms)) hits.push(i);
  }
  const hitSet = new Set(hits);
  const chunks: string[][] = [];
  let used = 0;
  let k = 0;
  let lastEnd = -1;
  while (k < hits.length && k < QUERY_MAX_HITS) {
    const i = hits[k];
    const from = Math.max(0, i - 1);
    const to = Math.min(lines.length - 1, i + 1);
    // Overlapping / adjacent to the previous excerpt → extend it; otherwise
    // start a new excerpt headed by its char offset.
    const extend = lastEnd !== -1 && from <= lastEnd + 1;
    const piece: string[] = extend ? [] : [`[offset ${starts[from]}]`];
    for (let j = Math.max(from, lastEnd + 1); j <= to; j++) {
      piece.push(`${hitSet.has(j) ? "»" : " "} ${lines[j]}`);
    }
    const pieceChars = piece.reduce((n, l) => n + l.length + 1, 0);
    if (k > 0 && used + pieceChars > maxChars) break;
    if (extend) chunks[chunks.length - 1].push(...piece);
    else chunks.push(piece);
    used += pieceChars;
    lastEnd = Math.max(lastEnd, to);
    k++;
  }
  const nextHit = hits[k];
  return {
    body: chunks.map((c) => c.join("\n")).join("\n…\n"),
    matches: hits.length,
    shown: k,
    nextOffset: nextHit === undefined ? null : starts[nextHit],
  };
}

interface TextReadArgs {
  maxChars: number;
  offset: number;
  terms: string[];
  rawQuery: string;
  scope: "main" | "page";
}

type TextRead =
  | { ok: false; error: string }
  | { ok: true; data: PageTextResult; wrapper: string[]; footer: string[]; diagInfo: Record<string, unknown> };

/** Inject the extractor into the top frame and render the text section. */
async function readTextSection(tabId: number, args: TextReadArgs): Promise<TextRead> {
  let data: PageTextResult | undefined;
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), TEXT_INJECT_TIMEOUT_MS);
    });
    const injected = await Promise.race([
      chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: extractPageTextInjected,
        args: [{ maxChars: TEXT_EXTRACT_CAP, scope: args.scope }],
        // Same as the atlas/snapshot fan-out: read the current DOM, never
        // wait for document_idle.
        injectImmediately: true,
      }),
      timeout,
    ]);
    clearTimeout(timer);
    if (injected === "timeout") {
      return { ok: false, error: "read_page text: page did not respond; try again in a moment" };
    }
    data = injected?.[0]?.result as PageTextResult | undefined;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "executeScript failed" };
  }
  if (!data || typeof data.text !== "string") {
    return { ok: false, error: "read_page text: could not read the page" };
  }

  const full = data.text;
  const total = full.length;
  // The extractor stopped early (pathological page): totals are lower bounds.
  const capped = data.truncated;
  const totalLabel = capped ? `${total}+` : String(total);
  const attrs = [attr("tool", "read_page"), attr("mode", "text"), attr("tab_id", tabId)];
  if (data.root === "main") attrs.push(attr("root", "main"));
  const footer: string[] = [];
  let body: string;
  const diagInfo: Record<string, unknown> = { totalChars: total, capped, root: data.root, maxChars: args.maxChars, offset: args.offset };

  if (total === 0) {
    body = "(no readable text found — the page may still be loading, or its content is in an iframe/canvas; try mode=\"interactive\")";
  } else if (args.terms.length > 0) {
    attrs.push(attr("query", args.rawQuery));
    const q = renderTextQuery(full, args.terms, args.offset, args.maxChars);
    diagInfo.matches = q.matches;
    diagInfo.shown = q.shown;
    const qJson = JSON.stringify(args.rawQuery);
    if (q.matches === 0) {
      body = `(no lines match ${qJson}${args.offset > 0 ? ` after offset ${args.offset}` : ""})`;
      footer.push(
        `No matches in ${totalLabel} chars of page text. Try other words (separate alternatives with |), or omit query to read the page: read_page({tabId: ${tabId}, mode:"text"})`,
      );
    } else {
      body = q.body;
      const more = q.matches - q.shown;
      footer.push(`${q.matches} matching line${q.matches === 1 ? "" : "s"} for ${qJson}${more > 0 ? `; showing the first ${q.shown}` : ""}. Lines marked » match; [offset N] is where that excerpt starts.`);
      if (more > 0 && q.nextOffset !== null) {
        footer.push(`${more} more matches not shown. Next: read_page({tabId: ${tabId}, mode:"text", query:${qJson}, offset:${q.nextOffset}})`);
      }
      footer.push(`To read around a match: read_page({tabId: ${tabId}, mode:"text", offset:N})`);
    }
  } else {
    const page = slicePageText(full, args.offset, args.maxChars);
    diagInfo.shownChars = page.end - page.start;
    if (page.start >= total) {
      body = `(offset ${args.offset} is past the end of the page text)`;
      footer.push(`The page text is ${totalLabel} chars. Start over: read_page({tabId: ${tabId}, mode:"text"})`);
    } else {
      body = full.slice(page.start, page.end);
      if (page.start > 0 || page.next !== null) {
        attrs.push(attr("offset", page.start));
        footer.push(
          `Showing chars ${page.start}–${page.end} of ${totalLabel}.` +
            (page.next !== null
              ? ` Next: read_page({tabId: ${tabId}, mode:"text", offset:${page.next}})`
              : " (end of page text)") +
            (page.next !== null ? ` — or use query:"word|other" to jump to specific text.` : ""),
        );
      }
    }
  }
  if (capped && (args.terms.length > 0 || slicePageText(full, args.offset, args.maxChars).next === null)) {
    footer.push(`(The page is very long; only its first ${total} chars of text could be read.)`);
  }
  if (data.root === "main" && args.scope === "main") {
    footer.push(`(Showing the page's main content only; menus and sidebars are left out — their links and buttons are listed by mode:"interactive".)`);
  }
  const wrapper = [`<untrusted_page_content ${attrs.join(" ")}>`, escapeUntrustedWrappers(body), "</untrusted_page_content>"];
  return { ok: true, data, wrapper, footer, diagInfo };
}

/** mode="text": readable text of the top frame only. */
async function readPageText(tabId: number, tab: chrome.tabs.Tab, args: TextReadArgs): Promise<ActionResult> {
  const r = await readTextSection(tabId, args);
  if (!r.ok) return { success: false, error: r.error };
  const lines = [
    ...pageHeaderLines({ tabId, url: r.data.url || tab.url || "", title: r.data.title ?? tab.title ?? "", tabUrl: tab.url ?? "" }),
    ...(args.terms.length > 0 ? [`Query: ${escapeUntrustedWrappers(args.rawQuery)}`] : []),
    ``,
    ...r.wrapper,
    ...r.footer,
  ];
  const observation = lines.join("\n");
  diag("read_page", kv({ mode: "text", est: estOf(observation), chars: observation.length }), kv(r.diagInfo));
  return { success: true, observation };
}

function wrapPageAtlasObservation(atlas: PageAtlasState, body: string, tabUrl: string): string {
  return [
    // Header mirrors the snapshot path's `Current URL / Page title` prelude so
    // elideStaleObservations has something cheap to keep before its cut point.
    // Without it a stale atlas result elides down to a bare marker — every one
    // of them byte-identical — and the LLM can no longer tell which step read
    // which page, so it re-runs read_page instead of relying on history.
    ...pageHeaderLines({ tabId: atlas.tabId, url: atlas.fingerprint.url || atlas.url, title: atlas.title, tabUrl }),
    ``,
    `<untrusted_page_content ${attr("tool", "read_page")} ${attr("mode", "atlas")} ${attr("atlas_id", atlas.atlasId)} ${attr("tab_id", atlas.tabId)}>`,
    body,
    "</untrusted_page_content>",
  ].join("\n");
}

function frameScopedId(frameId: number, id: string): string {
  return frameId === 0 ? id : `f${frameId}_${id}`;
}

function namespaceAtlasResult(data: Extract<ProbeResult, { op: "atlas" }>, frameId: number) {
  return {
    targets: data.targets.map((target) => ({
      ...target,
      id: frameScopedId(frameId, target.id),
      frameId,
      records: target.records?.map((record) => ({
        ...record,
        id: frameScopedId(frameId, record.id),
      })),
    })),
    controls: data.controls.map((control) => ({
      ...control,
      id: frameScopedId(frameId, control.id),
      frameId,
    })),
    forms: data.forms.map((form) => ({
      ...form,
      id: frameScopedId(frameId, form.id),
      frameId,
      fields: form.fields.map((field) => frameScopedId(frameId, field)),
      submitControlId: form.submitControlId ? frameScopedId(frameId, form.submitControlId) : undefined,
    })),
  };
}

type SnapshotResult = Extract<ProbeResult, { op: "snapshot" }>;

type InteractiveEl = SnapshotResult["interactiveElements"][number];

/** Text-entry fields win a tie among off-screen elements: they're what a task most often needs. */
function isTextEntry(el: InteractiveEl): boolean {
  const tag = el.tag.toLowerCase();
  const role = el.role.toLowerCase();
  return el.contenteditable || tag === "input" || tag === "textarea" || role === "textbox" || role === "editor";
}

function capField(value: string): string {
  return value.length > ELEMENT_FIELD_MAX ? `${value.slice(0, ELEMENT_FIELD_MAX - 1)}…` : value;
}

export function renderInteractiveIndex(
  mode: ReadPageMode,
  frames: Array<{ frameId: number; crossOrigin: boolean; elements: InteractiveEl[] }>,
  opts: { maxElements: number; terms: string[]; rawQuery: string },
): { index: string; footer: string[]; total: number; matched: number; shown: number } {
  const all = frames.flatMap((f, frameOrder) =>
    f.elements.map((el, elementOrder) => ({
      frameId: f.frameId,
      crossOrigin: f.crossOrigin,
      el,
      order: frameOrder * 1_000_000 + elementOrder,
    })),
  );
  const matched = opts.terms.length > 0
    ? all.filter(({ el }) =>
        [el.name, el.text, el.label, el.placeholder, el.href ?? "", el.role, el.tag].some(
          (v) => v && matchesQuery(v, opts.terms),
        ),
      )
    : all;
  // Pick: in-viewport first, then text-entry fields, then document order.
  // List the picked ones back in document order so the index reads like the page.
  const picked = [...matched]
    .sort(
      (a, b) =>
        Number(!a.el.inViewport) - Number(!b.el.inViewport) ||
        Number(!isTextEntry(a.el)) - Number(!isTextEntry(b.el)) ||
        a.order - b.order,
    )
    .slice(0, opts.maxElements)
    .sort((a, b) => a.order - b.order);

  const lines = picked.map(({ frameId, crossOrigin, el }) => {
    const attrs = [
      attr("frame_id", frameId),
      attr("pie_idx", el.pieIdx),
      attr("tag", el.tag),
      attr("role", el.role),
    ];
    if (crossOrigin) attrs.push(attr("cross_origin", true));
    if (el.name) attrs.push(attr("name", capField(el.name)));
    if (el.placeholder) attrs.push(attr("placeholder", capField(el.placeholder)));
    if (el.label && el.label !== el.name) attrs.push(attr("label", capField(el.label)));
    if (el.section) attrs.push(attr("section", capField(el.section)));
    if (el.type) attrs.push(attr("type", el.type));
    if (el.href) attrs.push(attr("href", el.href.length > 120 ? `${el.href.slice(0, 119)}…` : el.href));
    if (el.contenteditable) attrs.push(attr("contenteditable", true));
    if (el.disabled) attrs.push(attr("disabled", true));
    if (el.checked) attrs.push(attr("checked", true));
    if (el.selected) attrs.push(attr("selected", true));
    if (el.hasPopup) attrs.push(attr("haspopup", el.hasPopup));
    if (el.ariaExpanded) attrs.push(attr("expanded", el.ariaExpanded));
    const text = el.text && el.text !== el.name ? elementText(capField(el.text)) : "";
    return `  <interactive_element ${attrs.join(" ")}>${text}</interactive_element>`;
  });

  const header = [attr("mode", mode), attr("total", all.length)];
  if (opts.terms.length > 0) header.push(attr("query", opts.rawQuery), attr("matched", matched.length));
  if (matched.length > lines.length) header.push(attr("shown", lines.length), attr("truncated", true));
  const footer: string[] = [];
  const hidden = matched.length - lines.length;
  if (hidden > 0) {
    footer.push(
      `${hidden} more element${hidden === 1 ? "" : "s"} not shown (on-screen and text fields listed first) — ` +
        `use query:"…" to list only elements whose name/text/link matches (alternatives separated by |, e.g. query:"submit|send").`,
    );
  }
  if (opts.terms.length > 0 && matched.length === 0) {
    footer.push(`No elements match ${JSON.stringify(opts.rawQuery)} (${all.length} elements on the page). Try other words, or omit query.`);
  }
  const body = lines.length > 0 ? `\n${lines.join("\n")}\n` : "\n";
  return {
    index: `<interactive_index ${header.join(" ")}>${body}</interactive_index>`,
    footer,
    total: all.length,
    matched: matched.length,
    shown: lines.length,
  };
}

const textEncoder = new TextEncoder();

function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

// ---------------------------------------------------------------------------
// read_page 成本诊断。回答「这次返回的 token 花在哪一段」——loop.ts 的 [ctx]
// 只能看到轮级总量,定位不到是 controls 还是正文在膨胀。
//
// 分段按渲染产物的字面块切,不改 render.ts:切片顺序要求先有基线,再动渲染。
// est 复用 estimateTokens(与 [ctx] 同一把尺子,便于两条日志直接相加对照)——
// 它已知系统性低估 40-47%,但基线和对照用同一把尺子,相对变化仍然可信。
// ---------------------------------------------------------------------------

/** 一段文本的估算 token 数,口径与 loop.ts 的 [ctx] 一致。 */
function estOf(text: string): number {
  return estimateTokens([{ role: "user", content: text }]);
}

/** `open` 到 `close`(含)之间的子串;任一缺失则空串。 */
function blockOf(body: string, open: string, close: string): string {
  const start = body.indexOf(open);
  if (start === -1) return "";
  const end = body.indexOf(close, start);
  return end === -1 ? "" : body.slice(start, end + close.length);
}

/** 所有以 `prefix` 开头(忽略缩进)的行的字符数合计。 */
function lineChars(body: string, prefix: string): number {
  let total = 0;
  for (const line of body.split("\n")) {
    if (line.trimStart().startsWith(prefix)) total += line.length + 1;
  }
  return total;
}



function sliceUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let used = 0;
  let result = "";
  for (const ch of value) {
    const byteLength = utf8ByteLength(ch);
    if (used + byteLength > maxBytes) break;
    result += ch;
    used += byteLength;
  }
  return result;
}

export const readPageTool: Tool = {
  name: "read_page",
  // Kept plain on purpose (weak local models): only the advertised args
  // appear here. Hidden legacy args are documented at the top of the file.
  description:
    `Read the current page as plain text, about ${TEXT_MAX_CHARS_DEFAULT} characters per call; a long page ends with a "Next:" line — call it with that offset to read on. ` +
    "Use query to get only the lines containing some words (e.g. query:\"§|homework\"). " +
    "Use mode:\"interactive\" to get numbered elements, needed before click/type/select.",
  parameters: {
    type: "object",
    properties: {
      tabId: { type: "integer", description: "Tab to read. Leave out to read the current tab." },
      mode: {
        type: "string",
        enum: ["text", "interactive", "atlas"],
        description:
          "text (default): the page as plain text. " +
          "interactive: clickable elements with index numbers, needed before click/type/select. " +
          "atlas: ids of tables and lists, only for find_target / read_struct / read_target / extract_records.",
      },
      query: {
        type: "string",
        description: "Words to find, separate alternatives with | (e.g. \"§|homework\"). Returns only the matching lines (or, with mode interactive, matching elements).",
      },
      offset: {
        type: "integer",
        minimum: 0,
        description: "Where to start reading — the number from the previous result's \"Next:\" line.",
      },
    },
  },
  handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
    const a = (args ?? {}) as ReadPageArgs;
    // tabId is optional: a missing (or unusable, e.g. "current") tabId reads
    // the task's current tab — ctx.tabId is the loop's live focused pin.
    // read_page is read-class, so the R7 cross-session lock never inspects
    // its args; nothing upstream needs an explicit tabId.
    const tabId = typeof a.tabId === "number" && Number.isFinite(a.tabId) ? a.tabId : ctx?.tabId;
    if (typeof tabId !== "number") {
      return { success: false, error: "read_page: no tabId given and no current tab to read" };
    }
    const mode = normalizeMode(a.mode);
    if (a.mode === "content" || (a.mode !== undefined && a.mode !== mode && a.mode !== "auto")) {
      diag("read_page", kv({ modeAlias: String(a.mode), as: mode }));
    }
    const terms = parseQuery(a.query);
    const rawQuery = typeof a.query === "string" ? a.query.trim() : "";
    const offset = resolveOffset(a.offset);
    const maxChars = resolveTextMaxChars(a.max_chars ?? a.max_bytes);
    const maxElements = resolveMaxElements(a.max_elements);
    const scope: "main" | "page" = a.scope === "page" ? "page" : "main";
    const totalBudgetBytes = resolveHtmlBudget(a.max_bytes ?? a.max_chars);
    const textArgs: TextReadArgs = { maxChars, offset, terms, rawQuery, scope };

    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return { success: false, error: "Tab not found" };
    }
    if (await isPdfTabAsync(tabId, tab.url)) {
      return {
        success: false,
        error:
          "pdf_tab: This tab is a PDF. Use read_pdf / search_pdf / get_pdf_outline instead.",
      };
    }
    if (!tab.url || isRestrictedSchemeForGrouping(tab.url)) {
      return { success: false, error: "restrictedUrl: cannot read restricted-scheme tabs" };
    }
    if (tab.discarded) {
      return { success: false, error: "discardedTabRequiresActivation" };
    }

    // Every non-atlas read goes through the unchanged-memo (atlas output
    // carries a fresh atlas_id, so it is never byte-identical — it only
    // resets the chain).
    const memoSig = [tab.url ?? "", mode, offset, rawQuery, scope, maxChars, maxElements, totalBudgetBytes].join("\u0000");
    const withMemo = (r: ActionResult): ActionResult =>
      r.success && typeof r.observation === "string"
        ? { ...r, observation: applyUnchangedMemo(tabId, memoSig, r.observation) }
        : r;

    if (mode === "text") {
      return withMemo(await readPageText(tabId, tab, textArgs));
    }

    if (mode === "atlas") {
      lastReadByTab.delete(tabId);
      // Per-frame fan-out (see inject-all-frames.ts): a zombie frame with an
      // interrupted navigation must cost only its own timeout budget instead
      // of hanging the whole read.
      let injection: AllFramesInjectionOutcome<ProbeResult>;
      try {
        injection = await executeScriptAllFrames<ProbeResult>(tabId, probePageInjected, [
          { op: "atlas" },
        ]);
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "executeScript failed" };
      }
      const { frames, results: atlasResults, timedOutFrameIds } = injection;

      const top = frames.find((f) => f.frameId === 0);
      const topUrl = top?.url ?? tab.url ?? "";
      const topAtlasResult = atlasResults.find((r) => r.frameId === 0)?.result;
      const topFingerprint = topAtlasResult?.op === "atlas"
        ? topAtlasResult.fingerprint
        : {
            url: topUrl,
            title: tab.title ?? "",
            bodyTextLengthBucket: 0,
            interactiveCountBucket: 0,
            topSectionCount: 0,
          };

      const atlasId = `atlas_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const atlas: PageAtlasState = {
        atlasId,
        tabId,
        url: topUrl,
        origin: parseOrigin(topUrl),
        // The document's own title (fingerprint) beats tab metadata, which can
        // lag an SPA route change.
        title: topFingerprint.title || tab.title || "",
        createdAt: Date.now(),
        fingerprint: topFingerprint,
        targets: [],
        controls: [],
        forms: [],
        controlGroups: [],
        navigation: [],
      };

      const reachableFrameIds = new Set<number>();
      for (const result of atlasResults) {
        const data = result.result;
        if (data?.op !== "atlas") continue;
        const frameId = result.frameId;
        reachableFrameIds.add(frameId);
        const scoped = namespaceAtlasResult(data, frameId);
        atlas.targets.push(...scoped.targets);
        atlas.controls.push(...scoped.controls);
        atlas.forms.push(...scoped.forms);
      }

      pageAtlasStore.save(atlas);
      // Surface frames that returned no atlas result (injection failed / blocked
      // by CSP / sandbox iframe / still navigating) so the LLM knows content is
      // missing instead of silently re-running read_page forever.
      const unreachableBlock = renderAtlasUnreachableFrames(frames, reachableFrameIds, timedOutFrameIds);
      const rendered = renderPageAtlas(atlas);
      const atlasBody = unreachableBlock ? `${rendered}\n${unreachableBlock}` : rendered;
      const observation = wrapPageAtlasObservation(atlas, atlasBody, tab.url ?? "");

      const actionBlock = blockOf(atlasBody, "<action_surfaces>", "</action_surfaces>");
      const dataBlock = blockOf(atlasBody, "<data_surfaces>", "</data_surfaces>");
      const controlChars = lineChars(atlasBody, "<control ");
      diag(
        "read_page",
        kv({
          mode,
          est: estOf(observation),
          chars: observation.length,
          frames: frames.length,
          unreachable: frames.length - reachableFrameIds.size,
        }),
        // controls 是已知的大头(实测 484 条占单份 atlas 69% token)。
        // `shown/n` = top-K 后渲染的条数 / 页面上的总数,差值即 omitted。
        kv({
          controls: `${atlasBody.split("<control ").length - 1}/${atlas.controls.length}`,
          ctrlChars: controlChars,
          forms: atlas.forms.length,
          targets: atlas.targets.length,
          actionEst: estOf(actionBlock),
          dataEst: estOf(dataBlock),
          nextActionChars: lineChars(atlasBody, "<next_action "),
        }),
      );
      return { success: true, observation };
    }

    // See atlas path: per-frame fan-out so a never-responding frame can't
    // wedge the snapshot read.
    let snapshotInjection: AllFramesInjectionOutcome<ProbeResult>;
    try {
      snapshotInjection = await executeScriptAllFrames<ProbeResult>(tabId, probePageInjected, [
        { op: "snapshot" },
      ]);
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : "executeScript failed" };
    }
    const { frames, results, timedOutFrameIds } = snapshotInjection;

    const top = frames.find((f) => f.frameId === 0);
    const topUrl = top?.url ?? tab.url ?? "";

    function rewriteIframePlaceholders(parentFrameId: number, html: string): string {
      const childFrames = frames!
        .filter((f) => f.parentFrameId === parentFrameId)
        // Assumes child frame IDs increase in DOM iframe-position order. Chrome
        // assigns frameIds sequentially on first parse — holds in practice; may
        // drift if a child navigates and gets a new frameId.
        .sort((x, y) => x.frameId - y.frameId);
      // Regex depends on probe-core.ts stripping all non-whitelisted iframe
      // attributes — only data-pie-iframe-position survives, so [^>]* is safe.
      return html.replace(
        /<iframe([^>]*)data-pie-iframe-position="(\d+)"([^>]*)>([\s\S]*?)<\/iframe>/g,
        (_match, before, pos, after, _inner) => {
          const idx = Number(pos);
          const child = childFrames[idx];
          if (!child) {
            return `<iframe${before}${after}>[内容见 frame_map]</iframe>`;
          }
          const cleanedBefore = before.replace(/\s*data-pie-iframe-position="\d+"/g, "").trimEnd();
          const cleanedAfter = after.replace(/\s*data-pie-iframe-position="\d+"/g, "").trimEnd();
          const prefix = cleanedBefore ? `${cleanedBefore} ` : "";
          return `<iframe ${prefix}data-frame-id="${child.frameId}"${cleanedAfter}>[内容见 frame_id=${child.frameId}]</iframe>`;
        },
      );
    }

    let topOrigin: string | null = null;
    try { topOrigin = new URL(topUrl).origin; } catch { topOrigin = null; }

    // 各 mode 只返回自己声明的表示面。此前无论哪个 mode 都同时发 interactive
    // index 和整页 HTML,mode 实际只改了 byte cap —— 与工具描述和 prompt 里的
    // 说法不符,LLM 即使正确选了轻模式也拿到不需要的内容。
    const wantIndex = mode === "interactive" || mode === "full";
    const wantBlocks = mode === "html";

    const sortedFrames = [...frames].sort((a, b) => a.frameId - b.frameId);
    const frameMapLines: string[] = [];
    const frameInteractive: Array<{
      frameId: number;
      crossOrigin: boolean;
      elements: SnapshotResult["interactiveElements"];
    }> = [];
    const blocks: string[] = [];
    const scrollableLines: string[] = [];
    let used = 0;
    let budgetExhausted = false;

    for (const f of sortedFrames) {
      const inj = results.find((r) => r.frameId === f.frameId);
      const rawData = inj?.result;
      const data = rawData?.op === "snapshot" ? rawData : undefined;
      let origin: string | null = null;
      try { origin = new URL(f.url).origin; if (origin === "null") origin = null; } catch {}
      const crossOrigin = topOrigin !== null && origin !== null && origin !== topOrigin;

      if (!data) {
        const reason = classifyUnreachable(f.url, f.errorOccurred, timedOutFrameIds.has(f.frameId));
        frameMapLines.push(
          `  frame_id="${f.frameId}" url="${escapeWrapperAttribute(f.url)}" unreachable="true" reason="${reason}"`,
        );
        // frame_map 那行已经说明了不可达 —— 不发 content 面时不必再来一个空块。
        if (!wantBlocks) continue;
        const attrs = [
          `frame_id="${f.frameId}"`,
          `frame_url="${escapeWrapperAttribute(f.url)}"`,
          `unreachable="true"`,
          `reason="${reason}"`,
        ];
        blocks.push(`<untrusted_page_content ${attrs.join(" ")}></untrusted_page_content>`);
        continue;
      }

      const mapAttrs = [
        `frame_id="${f.frameId}"`,
        `url="${escapeWrapperAttribute(f.url)}"`,
      ];
      if (crossOrigin) mapAttrs.push(`cross_origin="true"`);
      frameMapLines.push("  " + mapAttrs.join(" "));
      frameInteractive.push({
        frameId: f.frameId,
        crossOrigin,
        elements: data.interactiveElements ?? [],
      });

      for (const hint of data.scrollableHints) {
        scrollableLines.push(
          `  - ${hint.region}${hint.pieIdx !== null ? ` at data-pie-idx=${hint.pieIdx}` : ""}: ${hint.visibleCount} visible, estimated ${hint.estimatedTotal} total (frame_id=${f.frameId})`,
        );
      }

      // mode=interactive 到此为止:index 与 frame_map 已备齐,整页 HTML 的
      // iframe 占位重写 + escape 是纯浪费(大页面上是几百 KB 的字符串处理)。
      if (!wantBlocks) continue;

      const blockAttrs: string[] = [
        `frame_id="${f.frameId}"`,
      ];
      if (crossOrigin) blockAttrs.push(`cross_origin="true"`);

      if (budgetExhausted) {
        blockAttrs.push(`unread="budget"`);
        blocks.push(`<untrusted_page_content ${blockAttrs.join(" ")}></untrusted_page_content>`);
        continue;
      }

      let body = rewriteIframePlaceholders(f.frameId, data.html);
      const remaining = totalBudgetBytes - used;
      let truncated = false;
      const bodyBytes = utf8ByteLength(body);
      if (bodyBytes > remaining) {
        // May cut mid-tag — LLM tolerates malformed HTML; truncation tradeoff
        // is documented in the spec.
        body = sliceUtf8(body, remaining);
        truncated = true;
        budgetExhausted = true;
      }
      used += utf8ByteLength(body);
      if (truncated) blockAttrs.push(`truncated="true"`);

      blocks.push(
        `<untrusted_page_content ${blockAttrs.join(" ")}>\n${escapeUntrustedWrappers(body)}\n</untrusted_page_content>`,
      );
    }

    // Header: prefer what the document itself reports — chrome.tabs metadata
    // can lag (or lead) an SPA route change, which is exactly when the model
    // needs to know which page it is looking at.
    const topSnapshot = results.find((r) => r.frameId === 0)?.result;
    const docInfo = topSnapshot?.op === "snapshot" ? topSnapshot : undefined;
    const headerLines = [
      ...pageHeaderLines({
        tabId,
        url: docInfo?.url || topUrl,
        title: docInfo?.title ?? tab.title ?? "",
        tabUrl: tab.url ?? "",
      }),
      ``,
      `<frame_map>`,
      ...frameMapLines,
      `</frame_map>`,
    ];

    const idx = wantIndex
      ? renderInteractiveIndex(mode, frameInteractive, { maxElements, terms, rawQuery })
      : undefined;
    const interactiveIndex = idx?.index ?? "";
    if (terms.length > 0 && wantIndex) headerLines.splice(headerLines.indexOf(""), 0, `Query: ${escapeUntrustedWrappers(rawQuery)}`);
    const observationParts = [headerLines.join("\n")];
    if (interactiveIndex) observationParts.push([interactiveIndex, ...(idx?.footer ?? [])].join("\n"));
    if (scrollableLines.length > 0) {
      observationParts.push(`<scrollable_regions>\n${scrollableLines.join("\n")}\n</scrollable_regions>`);
    }
    observationParts.push(...blocks);
    if (mode === "html" && budgetExhausted) {
      observationParts.push(
        `(HTML truncated at ${totalBudgetBytes} bytes. Raw markup is a last resort — prefer mode="text" (with offset/query) to read, or mode="interactive" to act.)`,
      );
    }
    if (mode === "full") {
      // full = the capped index + the text surface (first page, or query
      // hits — the same query narrows both).
      const text = await readTextSection(tabId, textArgs);
      observationParts.push(
        text.ok ? [...text.wrapper, ...text.footer].join("\n") : `(page text unavailable: ${text.error})`,
      );
    }

    const observation = observationParts.join("\n\n");
    const blocksChars = blocks.reduce((n, b) => n + b.length, 0);
    diag(
      "read_page",
      kv({
        mode,
        est: estOf(observation),
        chars: observation.length,
        frames: frames.length,
      }),
      // 这两段是 snapshot 路径的两个返回面,各 mode 只发自己那一面(切片 3)。
      kv({
        idxEls: idx?.total ?? 0,
        idxShown: idx?.shown ?? 0,
        idxChars: interactiveIndex.length,
        blocks: blocks.length,
        blockChars: blocksChars,
        frameMapChars: headerLines.join("\n").length,
        budget: totalBudgetBytes,
        exhausted: budgetExhausted,
      }),
    );
    return withMemo({ success: true, observation });
  },
};
