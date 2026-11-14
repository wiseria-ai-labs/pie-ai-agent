import type { BuiltinProvider, ModelMeta, ProviderRef } from "@/lib/model-router";
import { getProviderMeta, resolveEndpointVariant } from "@/lib/model-router";
import { CUSTOM_PREFIX, getCustomProvider, providerRefToId } from "@/lib/custom-providers";
import { fetchOpenAICompatModels } from "@/lib/openai-compat-models-fetch";
import { fetchOpenRouterModels } from "@/lib/openrouter-models-fetch";

/**
 * Single gate for "this provider can list its models over `GET /v1/models`".
 * Capability flag lives on ProviderMeta.modelsEndpoint; custom providers have
 * no registry entry but are always attempted (OpenAI-compat convention — some
 * proxies list models without auth). Callers treat a failed fetch as a silent
 * no-op and keep the existing list.
 */
export function supportsModelFetch(ref: ProviderRef): boolean {
  if (ref.startsWith(CUSTOM_PREFIX)) return true;
  return !!getProviderMeta(ref as BuiltinProvider)?.modelsEndpoint;
}

/**
 * Builtin provider whose model list exists ONLY behind `GET /v1/models` (empty
 * curated `models[]`) — offers to pre-fetch on provider select / first picker
 * expand. Custom providers are excluded on purpose: their models come from the
 * entity list and a failed auto-fetch would silently retry on every expand.
 */
export function isLazyModelProvider(ref: ProviderRef): boolean {
  if (ref.startsWith(CUSTOM_PREFIX)) return false;
  const meta = getProviderMeta(ref as BuiltinProvider);
  return !!meta?.modelsEndpoint && meta.models.length === 0;
}

export interface ModelFetchTarget {
  /** Overrides the registry / custom-entity baseUrl — e.g. a custom provider
   *  still being authored in the wizard (not saved yet). */
  baseUrl?: string;
  /** Stored instance's endpoint variant; its baseUrl wins over defaultBaseUrl. */
  endpointVariant?: string;
}

/**
 * Fetch a provider's model list. Returns null (no network call) when the
 * provider doesn't support it. Throws on network / non-2xx — callers swallow
 * that and keep the previously stored list.
 *
 * OpenRouter takes the dedicated fetch to keep `context_length` /
 * `input_modalities`; everyone else is plain OpenAI-compat `/v1/models`.
 */
export async function fetchProviderModels(
  ref: ProviderRef,
  apiKey?: string,
  target?: ModelFetchTarget,
): Promise<ModelMeta[] | null> {
  if (!supportsModelFetch(ref)) return null;

  let baseUrl = target?.baseUrl?.trim();
  if (!baseUrl && ref.startsWith(CUSTOM_PREFIX)) {
    const cpId = providerRefToId(ref);
    baseUrl = cpId ? (await getCustomProvider(cpId))?.baseUrl : undefined;
  }
  if (!baseUrl) {
    const meta = getProviderMeta(ref as BuiltinProvider);
    baseUrl =
      (meta && resolveEndpointVariant(meta, target?.endpointVariant)?.baseUrl) ||
      meta?.defaultBaseUrl;
  }
  if (!baseUrl) return null;

  return ref === "openrouter"
    ? fetchOpenRouterModels(baseUrl, apiKey)
    : fetchOpenAICompatModels(baseUrl, apiKey);
}
