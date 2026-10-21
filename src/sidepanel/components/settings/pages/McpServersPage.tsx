import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2, Pencil, X } from "lucide-react";
import { useT } from "@/lib/i18n";
import { onStoreChange } from "@/lib/store-bus";
import { McpClient } from "@/lib/mcp/client";
import { toolSummaries } from "@/lib/mcp/tools";
import {
  deleteMcpServer,
  getMcpServerHeaders,
  listMcpServers,
  saveMcpServer,
  setMcpServerEnabled,
  updateMcpToolsCache,
  validateHeaderName,
  validateServerUrl,
  type McpConsentMode,
  type StoredMcpServer,
} from "@/lib/mcp/store";
import { Switch } from "../../ui/Switch";

// Settings → MCP servers. List + inline add/edit form + Test. Configs live in
// the IDB config store (headers encrypted); the agent snapshots enabled servers
// at task start, each as an on-demand tool group.

interface HeaderRow {
  name: string;
  value: string;
}

interface Draft {
  id?: string;
  name: string;
  url: string;
  enabled: boolean;
  consent: McpConsentMode;
  headers: HeaderRow[];
}

type TestState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "ok"; count: number }
  | { status: "fail"; error: string };

const EMPTY_DRAFT: Draft = { name: "", url: "", enabled: true, consent: "session", headers: [] };

const inputClass =
  "w-full rounded-control border border-line bg-field px-2.5 py-1.5 text-[13px] text-fg-1 placeholder:text-fg-3 focus:outline-none";

function headersToRecord(rows: HeaderRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) if (r.name.trim()) out[r.name.trim()] = r.value;
  return out;
}

/** initialize + tools/list against the given endpoint; never throws. */
async function runTest(url: string, headers: Record<string, string>): Promise<TestState & { tools?: ReturnType<typeof toolSummaries> }> {
  const client = new McpClient({ url, headers, timeoutMs: 15_000 });
  try {
    await client.initialize();
    const defs = await client.listTools();
    return { status: "ok", count: defs.length, tools: toolSummaries(defs) };
  } catch (e) {
    return { status: "fail", error: e instanceof Error ? e.message : String(e) };
  } finally {
    void client.close();
  }
}

export default function McpServersPage() {
  const t = useT();
  const [servers, setServers] = useState<StoredMcpServer[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});

  const reload = useCallback(() => {
    void listMcpServers().then(setServers);
  }, []);

  useEffect(() => {
    reload();
    return onStoreChange("config", (c) => {
      if (c.id?.startsWith("mcp_server") ?? true) reload();
    });
  }, [reload]);

  const testKey = (id?: string) => id ?? "draft";

  async function testServer(server: StoredMcpServer) {
    setTests((s) => ({ ...s, [server.id]: { status: "running" } }));
    const r = await runTest(server.url, await getMcpServerHeaders(server));
    if (r.status === "ok" && r.tools) await updateMcpToolsCache(server.id, r.tools);
    setTests((s) => ({ ...s, [server.id]: r.status === "ok" ? { status: "ok", count: r.count } : r }));
  }

  async function testDraft(d: Draft) {
    const v = validateServerUrl(d.url);
    if (!v.ok) {
      setFormError(t(`settings.mcp.errors.${v.error}` as "settings.mcp.errors.invalid-url"));
      return;
    }
    setFormError(null);
    const key = testKey(d.id);
    setTests((s) => ({ ...s, [key]: { status: "running" } }));
    const r = await runTest(v.url, headersToRecord(d.headers));
    setTests((s) => ({ ...s, [key]: r.status === "ok" ? { status: "ok", count: r.count } : r }));
  }

  async function onSave(d: Draft) {
    const v = validateServerUrl(d.url);
    if (!d.name.trim()) return setFormError(t("settings.mcp.errors.empty-name"));
    if (!v.ok) return setFormError(t(`settings.mcp.errors.${v.error}` as "settings.mcp.errors.invalid-url"));
    if (d.headers.some((h) => h.name.trim() && !validateHeaderName(h.name.trim()))) {
      return setFormError(t("settings.mcp.errors.header"));
    }
    try {
      await saveMcpServer(
        { name: d.name, url: v.url, enabled: d.enabled, consent: d.consent, headers: headersToRecord(d.headers) },
        d.id,
      );
    } catch (e) {
      return setFormError(e instanceof Error ? e.message : String(e));
    }
    setDraft(null);
    setFormError(null);
    reload();
  }

  async function onEdit(server: StoredMcpServer) {
    const headers = await getMcpServerHeaders(server).catch(() => ({}) as Record<string, string>);
    setFormError(null);
    setDraft({
      id: server.id,
      name: server.name,
      url: server.url,
      enabled: server.enabled,
      consent: server.consent,
      headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
    });
  }

  async function onDelete(server: StoredMcpServer) {
    if (!confirm(t("settings.mcp.deleteConfirm"))) return;
    await deleteMcpServer(server.id);
    reload();
  }

  function renderTest(state: TestState | undefined) {
    if (!state || state.status === "idle") return null;
    if (state.status === "running") return <span className="text-[12px] text-fg-3">{t("settings.mcp.testing")}</span>;
    if (state.status === "ok") {
      return (
        <span data-testid="mcp-test-result" className="text-[12px] text-success">
          {t("settings.mcp.testOk", { count: String(state.count) })}
        </span>
      );
    }
    return (
      <span data-testid="mcp-test-result" className="break-all text-[12px] text-danger">
        {t("settings.mcp.testFail", { error: state.error })}
      </span>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <p className="text-[12px] leading-[18px] text-fg-2">{t("settings.mcp.description")}</p>

      {servers.length === 0 && !draft && (
        <p className="text-[12px] text-fg-3">{t("settings.mcp.empty")}</p>
      )}

      <ul className="flex flex-col gap-2">
        {servers.map((s) =>
          draft?.id === s.id ? null : (
            <li key={s.id} data-testid="mcp-server-row" className="flex flex-col gap-1.5 rounded-card border border-line bg-surface px-3 py-2.5">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-fg-1">{s.name}</div>
                  <div className="truncate font-mono text-[11px] text-fg-3">{s.url}</div>
                </div>
                <Switch checked={s.enabled} testId={`mcp-enabled-${s.id}`} onChange={(v) => void setMcpServerEnabled(s.id, v).then(reload)} />
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-fg-2">
                <span>{s.consent === "always" ? t("settings.mcp.consentAlways") : t("settings.mcp.consentSession")}</span>
                {s.toolsCache && <span className="text-fg-3">{t("settings.mcp.toolsCached", { count: String(s.toolsCache.tools.length) })}</span>}
                <span className="flex-1" />
                <button type="button" className="text-accent" onClick={() => void testServer(s)} disabled={tests[s.id]?.status === "running"}>
                  {t("settings.mcp.test")}
                </button>
                <button type="button" aria-label={t("settings.mcp.edit")} className="text-fg-2" onClick={() => void onEdit(s)}>
                  <Pencil size={14} />
                </button>
                <button type="button" aria-label={t("settings.mcp.delete")} className="text-fg-2" onClick={() => void onDelete(s)}>
                  <Trash2 size={14} />
                </button>
              </div>
              {renderTest(tests[s.id])}
            </li>
          ),
        )}
      </ul>

      {draft ? (
        <form
          data-testid="mcp-server-form"
          className="flex flex-col gap-3 rounded-card border border-line bg-surface px-3 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            void onSave(draft);
          }}
        >
          <label className="flex flex-col gap-1 text-[12px] text-fg-2">
            {t("settings.mcp.name")}
            <input className={inputClass} value={draft.name} placeholder={t("settings.mcp.namePlaceholder")} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-fg-2">
            {t("settings.mcp.url")}
            <input className={`${inputClass} font-mono`} value={draft.url} placeholder="http://localhost:8000/mcp" onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
            <span className="text-[11px] text-fg-3">{t("settings.mcp.urlHint")}</span>
          </label>

          <div className="flex flex-col gap-1.5 text-[12px] text-fg-2">
            {t("settings.mcp.headers")}
            {draft.headers.map((h, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <input
                  className={`${inputClass} w-[40%] font-mono`}
                  value={h.name}
                  placeholder="Authorization"
                  aria-label={t("settings.mcp.headerName")}
                  onChange={(e) => setDraft({ ...draft, headers: draft.headers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })}
                />
                <input
                  type="password"
                  className={`${inputClass} flex-1 font-mono`}
                  value={h.value}
                  placeholder="Bearer …"
                  aria-label={t("settings.mcp.headerValue")}
                  autoComplete="off"
                  onChange={(e) => setDraft({ ...draft, headers: draft.headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })}
                />
                <button type="button" aria-label={t("settings.mcp.delete")} className="text-fg-3" onClick={() => setDraft({ ...draft, headers: draft.headers.filter((_, j) => j !== i) })}>
                  <X size={14} />
                </button>
              </div>
            ))}
            <button type="button" className="self-start text-accent" onClick={() => setDraft({ ...draft, headers: [...draft.headers, { name: "", value: "" }] })}>
              {t("settings.mcp.addHeader")}
            </button>
            <span className="text-[11px] text-fg-3">{t("settings.mcp.headersHint")}</span>
          </div>

          <label className="flex flex-col gap-1 text-[12px] text-fg-2">
            {t("settings.mcp.consent")}
            <select className={inputClass} value={draft.consent} onChange={(e) => setDraft({ ...draft, consent: e.target.value as McpConsentMode })}>
              <option value="session">{t("settings.mcp.consentSession")}</option>
              <option value="always">{t("settings.mcp.consentAlways")}</option>
            </select>
          </label>

          <div className="flex items-center justify-between text-[12px] text-fg-2">
            {t("settings.mcp.enabled")}
            <Switch checked={draft.enabled} onChange={(v) => setDraft({ ...draft, enabled: v })} />
          </div>

          {formError && <p className="text-[12px] text-danger">{formError}</p>}
          {renderTest(tests[testKey(draft.id)])}

          <div className="flex items-center justify-end gap-2">
            <button type="button" className="mr-auto text-[13px] text-accent" onClick={() => void testDraft(draft)}>
              {t("settings.mcp.test")}
            </button>
            <button type="button" className="rounded-control px-3 py-1.5 text-[13px] text-fg-2" onClick={() => { setDraft(null); setFormError(null); }}>
              {t("settings.mcp.cancel")}
            </button>
            <button type="submit" data-testid="mcp-save" className="rounded-control bg-accent px-3 py-1.5 text-[13px] font-medium text-canvas">
              {t("settings.mcp.save")}
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          data-testid="mcp-add"
          onClick={() => { setFormError(null); setDraft({ ...EMPTY_DRAFT }); }}
          className="flex items-center gap-1.5 self-start rounded-control border border-line px-3 py-1.5 text-[13px] text-fg-1"
        >
          <Plus size={14} />
          {t("settings.mcp.add")}
        </button>
      )}
    </section>
  );
}
