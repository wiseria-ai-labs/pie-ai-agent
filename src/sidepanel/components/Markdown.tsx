import { isValidElement, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { useT } from "@/lib/i18n";

interface MarkdownContentProps {
  content: string;
}

/** Flatten a React children tree back to its raw text — used to recover the
 * verbatim source of a fenced code block for the clipboard. */
function extractText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement(node)) {
    return extractText((node.props as { children?: ReactNode }).children);
  }
  return "";
}

/** Two-overlapping-squares "copy" glyph, tinted via currentColor. */
export function CopyIcon() {
  return (
    <svg viewBox="0 0 1024 1024" width="13" height="13" fill="currentColor" aria-hidden>
      <path d="M337.28 138.688a27.968 27.968 0 0 0-27.968 27.968v78.72h377.344c50.816 0 92.032 41.152 92.032 91.968v377.344h78.656a28.032 28.032 0 0 0 27.968-28.032V166.656a28.032 28.032 0 0 0-27.968-27.968H337.28z m441.408 640v78.656c0 50.816-41.216 91.968-92.032 91.968H166.656a92.032 92.032 0 0 1-91.968-91.968V337.28c0-50.816 41.152-92.032 91.968-92.032h78.72V166.656c0-50.816 41.152-91.968 91.968-91.968h520c50.816 0 91.968 41.152 91.968 91.968v520c0 50.816-41.152 92.032-91.968 92.032h-78.72zM166.656 309.312a27.968 27.968 0 0 0-27.968 28.032v520c0 15.424 12.544 27.968 27.968 27.968h520a28.032 28.032 0 0 0 28.032-27.968V337.28a28.032 28.032 0 0 0-28.032-28.032H166.656z" />
    </svg>
  );
}

/** A fenced code block with a borderless copy button in its top-right corner.
 * The button is invisible until the block is hovered/focused so it doesn't
 * clutter the reading flow. The icon sits in a square hit-area; on a successful
 * write it swaps to a "copied" label for ~1.5s, each state keyed so it
 * re-mounts and plays the shared `.scale-in` fade. */
function CodeBlock({ children }: { children?: ReactNode }) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(extractText(children));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (denied permission / insecure context) — no-op.
    }
  };

  return (
    <div className="group relative my-2">
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? t("chat.copied") : t("chat.copyCode")}
        className="absolute right-1.5 top-1.5 z-10 flex items-center justify-center rounded p-1 text-fg-3 opacity-0 transition-opacity duration-200 hover:text-fg-1 focus-visible:opacity-100 group-hover:opacity-100"
      >
        {copied ? (
          <span
            key="copied"
            className="scale-in whitespace-nowrap text-[10px] font-medium leading-none"
          >
            {t("chat.copied")}
          </span>
        ) : (
          <span key="icon" className="scale-in flex">
            <CopyIcon />
          </span>
        )}
      </button>
      <pre className="overflow-x-auto rounded border border-line bg-field p-2.5 font-mono text-[11px] leading-4 text-fg-1">
        {children}
      </pre>
    </div>
  );
}

/**
 * CommonMark spec: any line that starts with 4+ spaces (or a tab) becomes an
 * "indented code block" — rendered through the <pre> code path with mono font
 * + overflow-x-auto. LLM reasoning output occasionally lands such whitespace
 * (extra padding around bullets, copy-pasted text from the page snapshot,
 * stream chunk concatenation artifacts), turning a plain Chinese sentence
 * into a horizontally-scrolling code box. Strip those leading spaces in
 * regions OUTSIDE fenced ``` blocks so the indented-code rule no longer
 * fires unintentionally; real code (in ```...```) is preserved verbatim.
 */
function stripIncidentalIndentedCode(content: string): string {
  const lines = content.split("\n");
  let inFenced = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFenced = !inFenced;
      continue;
    }
    if (!inFenced) {
      lines[i] = lines[i].replace(/^(?: {4,}|\t+)/, "");
    }
  }
  return lines.join("\n");
}

/** Fenced code blocks and inline code spans — the regions math normalization
 * must leave byte-for-byte alone. Unterminated fences match to end of input so
 * a half-streamed ``` block is still protected. */
const CODE_SPANS =
  /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`+[^`\n]*(?:`+|$))/g;

/**
 * A dollar amount is not math, but remark-math pairs `$` like a code-span
 * delimiter — it has no "`$` may not be followed by a digit" guard — so
 * "valued between $3.5B and $4.8B" pairs the two signs and renders the prose
 * between them as italic math with the signs eaten. Escape a sign that is
 * followed by a number, *unless* the next sign on the line reads like a closing
 * delimiter (right after a non-space character, and not itself followed by a
 * number — `US$2,169` is another amount, not a closer) — then it is the
 * opener of a digit-leading formula such as `$2\pi r$` or `$3.14$`, and
 * escaping it would orphan that closer to pair with the next formula's opener
 * ("Area $2\pi r$ and radius $r$" → "and radius" rendered as math).
 * `\$` is the escape remark-math documents.
 *
 * Known hole, accepted to keep bare `$…$` inline math: an amount followed on
 * the same line by a formula whose opener sits right after punctuation —
 * "Costs $5 at rate ($r$)." — reads as a digit-leading formula, so "5 at rate ("
 * still renders as math. Single-`$` math and currency can't be told apart by
 * any local rule (which is why KaTeX auto-render and MathJax leave single `$`
 * off by default); every variant tried leaves one such sentence shape open.
 * `\(…\)` and `$$…$$` never have the problem.
 */
function escapeCurrencyDollars(text: string): string {
  // Skip `$$` (display fences, whose body may legitimately start with a digit)
  // and an already-escaped `\$`.
  return text.replace(
    /(?<![\\$])\$(?=[ \t]*\d)(?![^\n$]*[^\s$]\$(?![ \t]*\d))/g,
    "\\$&",
  );
}

/**
 * Models write math with whichever delimiters their training favored, but
 * remark-math only understands dollars — and only treats `$$` as a *display*
 * block when the fences sit on their own lines. Rewrite the two other shapes
 * we actually see into the one it renders the way a reader expects:
 *
 *   `\(x\)`  → `$x$`        (inline)
 *   `\[x\]`  → `$$x$$`      (which the next rule may promote to display)
 *   a line that is nothing but `$$x$$` → fences split onto their own lines
 *
 * Mid-sentence `\[…\]` stays on one line and renders inline rather than
 * surgically splitting the paragraph — display math in running text is rare,
 * and inline is a readable fallback where a broken block is not.
 */
function normalizeMathDelimiters(text: string): string {
  return text
    .replace(/\\\[([\s\S]*?)\\\]/g, "$$$$$1$$$$")
    .replace(/\\\(([\s\S]*?)\\\)/g, "$$$1$$")
    .replace(/^[ \t]*\$\$([^\n$]+?)\$\$[ \t]*$/gm, (_m, body: string) =>
      `$$\n${body.trim()}\n$$`,
    );
}

/** Apply math-delimiter normalization outside code regions only, so a `$` or
 * `\[` shown as example source in a code block is never eaten. */
function normalizeMath(content: string): string {
  return content
    .split(CODE_SPANS)
    .map((seg, i) =>
      // Currency first: delimiter normalization *emits* `$`, and those are math
      // by construction — they must not be run through the currency escape.
      i % 2 === 0 ? normalizeMathDelimiters(escapeCurrencyDollars(seg)) : seg,
    )
    .join("");
}

export default function MarkdownContent({ content }: MarkdownContentProps) {
  const normalized = normalizeMath(stripIncidentalIndentedCode(content));
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        h1: ({ children }) => (
          <h1 className="mb-2 mt-3 text-[15px] font-semibold first:mt-0">
            {children}
          </h1>
        ),
        h2: ({ children }) => (
          <h2 className="mb-2 mt-3 text-[14px] font-semibold first:mt-0">
            {children}
          </h2>
        ),
        h3: ({ children }) => (
          <h3 className="mb-1.5 mt-2 text-[13px] font-semibold first:mt-0">
            {children}
          </h3>
        ),
        p: ({ children }) => (
          <p className="mb-2 leading-[20px] last:mb-0">{children}</p>
        ),
        ul: ({ children }) => (
          <ul className="my-2 ml-5 list-disc space-y-0.5">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="my-2 ml-5 list-decimal space-y-0.5">{children}</ol>
        ),
        li: ({ children }) => <li className="leading-[20px]">{children}</li>,
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline decoration-accent/40 hover:decoration-accent"
          >
            {children}
          </a>
        ),
        code: ({ className, children, ...props }) => {
          const text = typeof children === "string" ? children : String(children);
          const isBlock = Boolean(className) || text.includes("\n");
          if (!isBlock) {
            return (
              <code
                className="rounded border border-line bg-field px-1 py-0.5 font-mono text-[11px] text-fg-1"
                {...props}
              >
                {children}
              </code>
            );
          }
          return (
            <code className={className} {...props}>
              {children}
            </code>
          );
        },
        pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        blockquote: ({ children }) => (
          <blockquote className="my-2 border-l-2 border-line pl-3 italic text-fg-2">
            {children}
          </blockquote>
        ),
        table: ({ children }) => (
          <div className="my-2 overflow-x-auto rounded border border-line">
            <table className="min-w-full text-[12px]">{children}</table>
          </div>
        ),
        thead: ({ children }) => (
          <thead className="border-b border-line text-left font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3">
            {children}
          </thead>
        ),
        th: ({ children }) => <th className="px-2.5 py-1.5">{children}</th>,
        td: ({ children }) => (
          <td className="border-b border-line/60 px-2.5 py-1.5">{children}</td>
        ),
        strong: ({ children }) => (
          <strong className="font-semibold">{children}</strong>
        ),
        em: ({ children }) => <em className="italic">{children}</em>,
        hr: () => <hr className="my-3 border-line" />,
        del: ({ children }) => (
          <del className="text-fg-3 line-through">{children}</del>
        ),
      }}
    >
      {normalized}
    </ReactMarkdown>
  );
}
