import { useState, useEffect, useMemo } from "react";
import type { ProviderRef, BuiltinProvider, ModelMeta } from "@/lib/model-router";
import { getProviderMeta, resolveEndpointVariant } from "@/lib/model-router";
import { useProviderMeta } from "@/sidepanel/hooks/useProviderMeta";
import { CUSTOM_PREFIX } from "@/lib/custom-providers";
import { useT, providerDisplayName } from "@/lib/i18n";
import { type StoredCustomModelMeta } from "@/lib/provider-custom-model-meta";
import ProviderModelList from "./ProviderModelList";
import ManagedAccountPanel from "./ManagedAccountPanel";
import { Button } from "./ui/Button";

export interface InstanceFormPayload {
  nickname: string;
  apiKey: string;
  customModels: string[];
  /** EndpointVariant.id；undefined = 默认端点。 */
  endpointVariant?: string;
}

/** Render-prop API exposed when the parent wants to compose a custom action footer
 *  (e.g. NewConfigWizard merges Test/Create with ← provider/取消 in one row). */
export interface InstanceFormActionsApi {
  canSave: boolean;
  testing: boolean;
  testStatus: "idle" | "success";
  replacing: boolean;
  triggerSave: () => void;
  triggerTest: () => void;
  triggerDelete?: () => void;
  saveLabel: string;
}

interface Props {
  mode: "create" | "edit";
  provider: ProviderRef;
  initialNickname: string;
  initialCustomModels?: string[];
  initialEndpointVariant?: string;
  fetchedModels?: ModelMeta[];
  fetchedAt?: number;
  isFetching?: boolean;
  maskedKey?: string;
  existingApiKey?: string;
  onSave: (payload: InstanceFormPayload) => void;
  onTest: (payload: InstanceFormPayload) => void;
  onDelete?: () => void;
  customModelMetas?: Record<string, StoredCustomModelMeta>;
  onAddCustomModel?: (id: string, meta: StoredCustomModelMeta) => void;
  onUpdateCustomModelMeta?: (id: string, meta: StoredCustomModelMeta) => void;
  onRemoveCustomModel?: (id: string) => void;
  /** Receives the form's effective apiKey (just-typed or existing) so the
   *  parent can fetch /v1/models without forcing the user to save first. */
  onRefreshModels?: (apiKey: string) => void | Promise<void>;
  testing?: boolean;
  testStatus?: "idle" | "success";
  saveLabel?: string;
  /** Optional render-prop replacing the default Test/Save/Forget action row.
   *  When provided, InstanceForm renders ONLY the form fields; the parent
   *  is responsible for rendering action buttons via the supplied api. */
  renderActions?: (api: InstanceFormActionsApi) => React.ReactNode;
  /** When true, hides the built-in read-only provider field.
   *  Used by NewConfigWizard where provider is managed by ProviderDropdown above. */
  hideProviderField?: boolean;
}

export default function InstanceForm(props: Props) {
  const t = useT();
  const { meta: resolvedMeta, loading: metaLoading } = useProviderMeta(props.provider);
  // For builtin providers, resolve meta synchronously so the field renders
  // immediately without waiting for the async hook to fire.
  const syncMeta = props.provider.startsWith(CUSTOM_PREFIX) ? undefined : getProviderMeta(props.provider as BuiltinProvider);
  const meta = resolvedMeta ?? syncMeta;
  const isCustomProvider = props.provider.startsWith(CUSTOM_PREFIX);
  const effectiveFetchedModels = useMemo(() => {
    if (isCustomProvider && meta?.models) return meta.models;
    return props.fetchedModels;
  }, [isCustomProvider, meta?.models, props.fetchedModels]);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  // Locally-tracked custom models. Initialised from initialCustomModels but
  // accumulates user's "+ 添加自定义模型" entries during the form session so
  // they appear in the dropdown immediately AND get carried to onSave.
  // Edit-mode parents (Settings.tsx) also persist async via onAddCustomModel
  // for cross-session durability.
  const [customModels, setCustomModels] = useState<string[]>(props.initialCustomModels ?? []);
  // Sync newly-arrived items from initialCustomModels into local state.
  // Wizard fetches the provider pool asynchronously on provider select, so the
  // prop arrives [] first then [X, ...] — without this effect, useState's
  // one-shot init misses the late arrival. We MERGE (never remove) to avoid
  // racing against just-added local items whose pool write hasn't resolved yet.
  useEffect(() => {
    const incoming = props.initialCustomModels ?? [];
    if (incoming.length === 0) return;
    setCustomModels((prev) => {
      let changed = false;
      const merged = [...prev];
      for (const id of incoming) {
        if (!merged.includes(id)) {
          merged.push(id);
          changed = true;
        }
      }
      return changed ? merged : prev;
    });
  }, [props.initialCustomModels]);
  // Lazy init normalizes stale variant ids: if a registry update removed the
  // stored variant, the UI falls back to the default endpoint and saving the
  // form clears the stale id — same semantics as the runtime fallback in
  // instances.ts. Safe at init time: builtin meta resolves synchronously via
  // getProviderMeta, and custom providers never have endpointVariants.
  const [endpointVariant, setEndpointVariant] = useState<string | undefined>(() =>
    meta && resolveEndpointVariant(meta, props.initialEndpointVariant) ? props.initialEndpointVariant : undefined,
  );
  const variants = meta?.endpointVariants ?? [];
  const selectedVariant = meta ? resolveEndpointVariant(meta, endpointVariant) : undefined;

  // Edit mode: start in read-only partial-reveal; create mode: always in replacing state
  const [replacing, setReplacing] = useState(props.mode === "create" || !props.existingApiKey);

  const requireApiKey = props.mode === "create" || replacing;
  const canSave = !requireApiKey || apiKey.trim().length > 0;
  const testing = props.testing === true;
  const testStatus = props.testStatus ?? "idle";

  const payload: InstanceFormPayload = { nickname: props.initialNickname, apiKey, customModels, endpointVariant };

  // Managed provider: skip the BYOK form entirely — show account panel instead.
  if (props.provider === "managed") {
    return (
      <div className="flex flex-col gap-3 px-3.5 py-3.5">
        {props.existingApiKey
          ? <ManagedAccountPanel apiKey={props.existingApiKey} />
          : <div className="text-[12px] text-fg-3">{t("managed.account.setupHint")}</div>}
        {/* Edit-mode parents (Settings) don't pass renderActions, so the only way to
            remove a managed config is this delete button — visually/text aligned with
            the BYOK "Forget config" button below. */}
        {props.onDelete && (
          <Button variant="danger" className="self-start" onClick={() => props.onDelete!()}>
            {t("instanceForm.forgetConfig")}
          </Button>
        )}
        {props.renderActions?.({
          canSave: false,
          replacing: false,
          testing: false,
          testStatus: "idle",
          saveLabel: props.saveLabel ?? t("instanceForm.save"),
          triggerSave: () => {},
          triggerTest: () => {},
          triggerDelete: props.onDelete,
        })}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-3 px-3.5 py-3.5">
      {!props.hideProviderField && (
        <Field label={t("instanceForm.provider")}>
          {metaLoading && isCustomProvider ? (
            <div className="h-[38px] animate-pulse rounded bg-field" />
          ) : (
            <div className="flex items-center gap-2 rounded-[10px] bg-field px-3 py-2.5 text-[13px] text-fg-2">
              <span className="text-fg-1">{meta ? providerDisplayName(meta, t) : props.provider}</span>
              <span className="ml-auto text-[10px] text-fg-3">{t("instanceForm.locked")}</span>
            </div>
          )}
        </Field>
      )}

      {variants.length > 0 && (
        <FieldDiv label={t("instanceForm.endpoint")} hint={selectedVariant?.baseUrl ?? meta?.defaultBaseUrl}>
          <div role="group" aria-label={t("instanceForm.endpoint")} className="flex w-full bg-field rounded-[12px] p-[3px]">
            {/* 默认端点（Plan）在左、Pay-as-you-go variant 在右——跨 provider 对齐。 */}
            {[{ id: undefined as string | undefined, label: meta?.defaultEndpointLabel ?? t("instanceForm.endpointDefault") },
              ...variants.map((v) => ({ id: v.id as string | undefined, label: v.label }))].map((opt) => {
              const active = endpointVariant === opt.id;
              return (
                <button
                  key={opt.id ?? "_default"}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setEndpointVariant(opt.id)}
                  className={"flex-1 truncate text-center text-[12px] py-2 rounded-[9px] transition-colors " +
                    (active ? "bg-surface text-fg-1 font-medium shadow-[0_1px_4px_rgba(21,25,31,0.08)]" : "text-fg-2")}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </FieldDiv>
      )}

      <Field label={t("instanceForm.apiKey")} hint={t("instanceForm.aesGcmLocal")}>
        {!replacing && props.existingApiKey ? (
          <div className="flex flex-col gap-1.5">
            <button
              type="button"
              onClick={() => setReplacing(true)}
              className="min-w-0 overflow-x-auto whitespace-nowrap rounded-[10px] bg-field px-3 py-2.5 text-left font-mono text-[13px] text-fg-1 outline-none hover:bg-line focus:bg-surface-deep focus:shadow-[0_6px_24px_rgba(29,107,214,0.10)]"
            >
              {partialReveal(props.existingApiKey)}
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <div className="flex gap-1.5">
              <input
                aria-label={t("instanceForm.apiKeyLabel")}
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={selectedVariant?.placeholder ?? meta?.placeholder ?? ""}
                className="min-w-0 flex-1 rounded-[10px] bg-field px-3 py-2.5 text-[13px] text-fg-1 outline-none focus:bg-surface-deep focus:shadow-[0_6px_24px_rgba(29,107,214,0.10)]"
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="shrink-0 rounded-[10px] bg-transparent px-2.5 py-2 text-[12px] text-fg-2 hover:bg-field hover:text-fg-1"
              >
                {showKey ? t("instanceForm.hideKey") : t("instanceForm.showKey")}
              </button>
            </div>
            {props.mode === "edit" && props.existingApiKey && (
              <Button
                variant="secondary"
                className="self-start"
                onClick={() => { setApiKey(""); setReplacing(false); }}
              >
                {t("instanceForm.cancelKeepKey")}
              </Button>
            )}
          </div>
        )}
      </Field>

      <FieldDiv label={t("instanceForm.models")}>
        <ProviderModelList
          provider={props.provider}
          endpointVariant={endpointVariant}
          customModels={customModels}
          customModelMetas={props.customModelMetas}
          fetchedModels={effectiveFetchedModels}
          fetchedAt={props.fetchedAt}
          isFetching={props.isFetching}
          onAddCustom={(id, meta) => {
            // Local state drives immediate display (the just-added id appears
            // before any async refresh). Persistence is the parent's job, routed
            // by provider type: builtin → pcm/pcmm pool, custom → entity models.
            setCustomModels((prev) => (prev.includes(id) ? prev : [...prev, id]));
            props.onAddCustomModel?.(id, meta);
          }}
          onUpdateCustomMeta={(id, meta) => props.onUpdateCustomModelMeta?.(id, meta)}
          onRemoveCustom={(id) => {
            setCustomModels((prev) => prev.filter((x) => x !== id));
            props.onRemoveCustomModel?.(id);
          }}
          onRefresh={() => {
            // Effective apiKey: just-typed (replacing OR creating) takes
            // precedence; otherwise fall back to existing stored key.
            const effective = apiKey.trim().length > 0 ? apiKey : (props.existingApiKey ?? "");
            props.onRefreshModels?.(effective);
          }}
        />
      </FieldDiv>

      {!props.renderActions && (
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          {props.mode === "edit" && props.onDelete && (
            <Button variant="danger" onClick={() => props.onDelete!()}>
              {t("instanceForm.forgetConfig")}
            </Button>
          )}
          <div className="flex-1" />
          <Button
            variant="secondary"
            loading={testing}
            disabled={!canSave}
            onClick={() => {
              if (!testing) props.onTest(payload);
            }}
          >
            {testButtonLabel(t, testing, testStatus)}
          </Button>
          <Button
            variant="primary"
            disabled={!canSave}
            onClick={() => props.onSave(payload)}
          >
            {props.saveLabel ?? t("instanceForm.save")}
          </Button>
        </div>
      )}
      </div>
      {props.renderActions && props.renderActions({
        canSave,
        replacing,
        testing,
        testStatus,
        saveLabel: props.saveLabel ?? t("instanceForm.save"),
        triggerSave: () => props.onSave(payload),
        triggerTest: () => {
          if (!testing) props.onTest(payload);
        },
        triggerDelete: props.onDelete,
      })}
    </div>
  );
}

function testButtonLabel(
  t: ReturnType<typeof useT>,
  testing: boolean,
  status: "idle" | "success",
): string {
  if (testing) return t("customProvider.testing");
  if (status === "success") return t("instanceForm.testOk");
  return t("instanceForm.test");
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[12px] font-medium text-fg-2">{label}</span>
        {hint && <span className="font-mono text-[10px] text-fg-3">{hint}</span>}
      </div>
      {children}
    </label>
  );
}

/** Like Field but uses a <div> instead of <label> — use when children contain
 *  interactive controls (buttons) whose accessible names must not inherit the
 *  surrounding label text (e.g. segmented button groups). */
function FieldDiv({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[12px] font-medium text-fg-2">{label}</span>
        {hint && <span className="font-mono text-[10px] text-fg-3">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function partialReveal(key: string): string {
  if (key.length <= 8) return "•".repeat(8);
  return `${key.slice(0, 7)}${"•".repeat(Math.max(8, key.length - 11))}${key.slice(-4)}`;
}
