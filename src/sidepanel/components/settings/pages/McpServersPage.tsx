import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { onStoreChange } from "@/lib/store-bus";
import {
  MCP_SERVERS_KEY,
  listMcpServerViews,
  saveMcpServer,
  deleteMcpServer,
  McpConfigError,
  type McpServerView,
} from "@/lib/mcp/store";
import {
  MCP_TEST_MESSAGE,
  type McpTestMessage,
  type McpTestResult,
} from "@/lib/mcp/test-connection";

// #481 — Settings → MCP servers. User-configured remote Streamable HTTP servers
// only (no bundled catalogue). Header values are write-only in this UI: saved
// rows render masked, and leaving a value blank keeps the stored one.

interface HeaderRow {
  key: string;
  value: string;
}

interface EditorState {
  id?: string;
  name: string;
  url: string;
  headers: HeaderRow[];
  /** Keys that already exist server-side (their blank value means "keep"). */
  existingKeys: string[];
}

function emptyEditor(): EditorState {
  return { name: "", url: "", headers: [{ key: "", value: "" }], existingKeys: [] };
}

function editorFor(view: McpServerView): EditorState {
  return {
    id: view.id,
    name: view.name,
    url: view.url,
    headers: view.headerKeys.length
      ? view.headerKeys.map((key) => ({ key, value: "" }))
      : [{ key: "", value: "" }],
    existingKeys: view.headerKeys,
  };
}

export default function McpServersPage() {
  const t = useT();
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  // 行内两步确认（SkillsList / SchedulesPanel 同款），不用 window.confirm。
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, McpTestResult>>({});

  const refresh = () => {
    void listMcpServerViews().then(setServers);
  };

  useEffect(() => {
    refresh();
    return onStoreChange("config", (c) => {
      if (c.id === MCP_SERVERS_KEY) refresh();
    });
  }, []);

  const errorText = (e: unknown): string => {
    if (e instanceof McpConfigError) {
      if (e.code === "nameRequired") return t("settings.mcp.errorNameRequired");
      if (e.code === "urlInvalid") return t("settings.mcp.errorUrlInvalid");
      if (e.code === "tooMany") return t("settings.mcp.errorTooMany");
    }
    return e instanceof Error ? e.message : t("settings.mcp.errorGeneric");
  };

  async function onSave() {
    if (!editor || busy) return;
    setBusy(true);
    setError(null);
    try {
      await saveMcpServer({
        ...(editor.id ? { id: editor.id } : {}),
        name: editor.name,
        url: editor.url,
        headers: editor.headers,
      });
      setEditor(null);
      refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(id: string) {
    setConfirmDeleteId(null);
    await deleteMcpServer(id);
    setTestResults((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    refresh();
  }

  async function onTest(id: string) {
    if (testingId) return;
    setTestingId(id);
    try {
      const msg: McpTestMessage = { type: MCP_TEST_MESSAGE, serverId: id };
      const res = (await chrome.runtime.sendMessage(msg)) as McpTestResult;
      setTestResults((prev) => ({ ...prev, [id]: res }));
    } catch (e) {
      setTestResults((prev) => ({
        ...prev,
        [id]: { ok: false, tools: [], skipped: [], error: errorText(e) },
      }));
    } finally {
      setTestingId(null);
    }
  }

  function updateEditor(patch: Partial<EditorState>) {
    setEditor((cur) => (cur ? { ...cur, ...patch } : cur));
  }

  return (
    <section className="flex flex-col gap-3">
      <p className="text-[12px] leading-[18px] text-fg-2">{t("settings.mcp.description")}</p>

      {servers.length === 0 && !editor && (
        <p data-testid="mcp-empty" className="text-[12px] leading-[18px] text-fg-3">
          {t("settings.mcp.empty")}
        </p>
      )}

      {servers.map((view) => {
        const result = testResults[view.id];
        return (
          <div
            key={view.id}
            data-testid={`mcp-server-${view.slug}`}
            className="flex flex-col gap-2 rounded-card border border-line bg-surface p-3"
          >
            <div className="flex items-start gap-2">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-[13px] font-medium text-fg-1">{view.name}</span>
                <span className="truncate font-mono text-[11px] text-fg-3">{view.url}</span>
                {view.headerKeys.length > 0 && (
                  <span className="text-[11px] text-fg-3">
                    {t("settings.mcp.headersLabel")}: {view.headerKeys.join(", ")}
                  </span>
                )}
              </div>
              <div className="flex shrink-0 gap-1">
                <button
                  type="button"
                  data-testid={`mcp-test-${view.slug}`}
                  onClick={() => void onTest(view.id)}
                  disabled={testingId !== null}
                  className="rounded-control border border-line px-2 py-1 text-[12px] text-fg-1 hover:bg-field disabled:opacity-50"
                >
                  {testingId === view.id ? t("settings.mcp.testing") : t("settings.mcp.test")}
                </button>
                <button
                  type="button"
                  data-testid={`mcp-edit-${view.slug}`}
                  onClick={() => {
                    setError(null);
                    setEditor(editorFor(view));
                  }}
                  className="rounded-control border border-line px-2 py-1 text-[12px] text-fg-1 hover:bg-field"
                >
                  {t("common.edit")}
                </button>
                {confirmDeleteId === view.id ? (
                  <>
                    <button
                      type="button"
                      data-testid={`mcp-delete-confirm-${view.slug}`}
                      onClick={() => void onDelete(view.id)}
                      className="rounded-control border border-warning-line px-2 py-1 text-[12px] text-warning hover:bg-warning-tint"
                    >
                      {t("common.confirm")}
                    </button>
                    <button
                      type="button"
                      data-testid={`mcp-delete-cancel-${view.slug}`}
                      onClick={() => setConfirmDeleteId(null)}
                      className="rounded-control border border-line px-2 py-1 text-[12px] text-fg-2 hover:bg-field"
                    >
                      {t("common.cancel")}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    data-testid={`mcp-delete-${view.slug}`}
                    onClick={() => setConfirmDeleteId(view.id)}
                    className="rounded-control border border-line px-2 py-1 text-[12px] text-fg-2 hover:bg-field"
                  >
                    {t("common.delete")}
                  </button>
                )}
              </div>
            </div>
            {result && (
              <div
                data-testid={`mcp-test-result-${view.slug}`}
                className={`whitespace-pre-wrap break-words rounded-control border px-2 py-1.5 font-mono text-[11px] leading-[16px] ${
                  result.ok
                    ? "border-line bg-field text-fg-2"
                    : "border-warning-line bg-warning-tint text-warning"
                }`}
              >
                {result.ok
                  ? `${t("settings.mcp.toolsFound")}: ${
                      result.tools.length ? result.tools.join(", ") : "—"
                    }` +
                    (result.skipped.length
                      ? `\n${t("settings.mcp.skippedTools")}: ${result.skipped
                          .map((s) => `${s.name} (${s.reason})`)
                          .join("; ")}`
                      : "")
                  : result.error}
              </div>
            )}
          </div>
        );
      })}

      {editor ? (
        <div
          data-testid="mcp-editor"
          className="flex flex-col gap-2.5 rounded-card border border-line bg-surface p-3"
        >
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-fg-1">{t("settings.mcp.nameLabel")}</span>
            <input
              data-testid="mcp-name-input"
              value={editor.name}
              onChange={(e) => updateEditor({ name: e.target.value })}
              placeholder={t("settings.mcp.namePlaceholder")}
              className="rounded-control border border-line bg-field px-2 py-1.5 text-[13px] text-fg-1 placeholder:text-fg-3 focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-fg-1">{t("settings.mcp.urlLabel")}</span>
            <input
              data-testid="mcp-url-input"
              value={editor.url}
              onChange={(e) => updateEditor({ url: e.target.value })}
              placeholder={t("settings.mcp.urlPlaceholder")}
              className="rounded-control border border-line bg-field px-2 py-1.5 font-mono text-[12px] text-fg-1 placeholder:text-fg-3 focus:outline-none"
            />
          </label>
          <p className="text-[11px] leading-[16px] text-fg-3">{t("settings.mcp.urlRule")}</p>

          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-fg-1">{t("settings.mcp.headersLabel")}</span>
            {editor.headers.map((row, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <input
                  data-testid={`mcp-header-key-${i}`}
                  value={row.key}
                  onChange={(e) => {
                    const headers = editor.headers.slice();
                    headers[i] = { ...row, key: e.target.value };
                    updateEditor({ headers });
                  }}
                  placeholder={t("settings.mcp.headerKey")}
                  className="w-2/5 rounded-control border border-line bg-field px-2 py-1.5 font-mono text-[12px] text-fg-1 placeholder:text-fg-3 focus:outline-none"
                />
                <input
                  data-testid={`mcp-header-value-${i}`}
                  value={row.value}
                  onChange={(e) => {
                    const headers = editor.headers.slice();
                    headers[i] = { ...row, value: e.target.value };
                    updateEditor({ headers });
                  }}
                  placeholder={
                    editor.existingKeys.includes(row.key)
                      ? t("settings.mcp.headerKeepPlaceholder")
                      : t("settings.mcp.headerValue")
                  }
                  className="flex-1 rounded-control border border-line bg-field px-2 py-1.5 font-mono text-[12px] text-fg-1 placeholder:text-fg-3 focus:outline-none"
                />
                <button
                  type="button"
                  aria-label={t("common.remove")}
                  onClick={() => {
                    updateEditor({ headers: editor.headers.filter((_, j) => j !== i) });
                  }}
                  className="shrink-0 rounded-control border border-line px-2 py-1.5 text-[12px] text-fg-3 hover:bg-field"
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              data-testid="mcp-add-header"
              onClick={() => updateEditor({ headers: [...editor.headers, { key: "", value: "" }] })}
              className="self-start text-[12px] text-accent hover:underline"
            >
              + {t("settings.mcp.addHeader")}
            </button>
            <p className="text-[11px] leading-[16px] text-fg-3">{t("settings.mcp.headersHint")}</p>
          </div>

          {error && (
            <p data-testid="mcp-editor-error" className="text-[12px] leading-[18px] text-warning">
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setEditor(null);
                setError(null);
              }}
              className="rounded-control border border-line px-3 py-1.5 text-[12px] text-fg-2 hover:bg-field"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              data-testid="mcp-save"
              onClick={() => void onSave()}
              disabled={busy}
              className="rounded-control bg-accent px-3 py-1.5 text-[12px] font-medium text-canvas disabled:opacity-50"
            >
              {t("common.save")}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          data-testid="mcp-add-server"
          onClick={() => {
            setError(null);
            setEditor(emptyEditor());
          }}
          className="self-start rounded-control border border-line px-3 py-1.5 text-[12px] font-medium text-fg-1 hover:bg-field"
        >
          + {t("settings.mcp.addServer")}
        </button>
      )}
    </section>
  );
}
