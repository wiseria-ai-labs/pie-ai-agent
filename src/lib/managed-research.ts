import { ACCOUNT_BASE } from "./managed-config";
import { getLocale } from "./i18n";

export type ResearchStatus = "queued" | "running" | "done" | "cancelled" | "failed_system";
export type ResearchPhase = "plan" | "gather" | "synthesize";

export interface ResearchRunSummary {
  id: string;
  question: string;
  status: ResearchStatus;
  createdAt: string;
  finishedAt?: string;
}

export interface ResearchReference {
  n: number;
  title: string;
  url: string;
}

export interface ResearchRun {
  id: string;
  question: string;
  status: ResearchStatus;
  phase?: ResearchPhase;
  sourcesFound: number;
  report?: string;
  references?: ResearchReference[];
  error?: string;
}

export interface ManagedResearchDeps {
  fetchFn?: typeof fetch;
  /** 缺省取当前 UI locale（getLocale()）。 */
  locale?: string;
}

/** /research 失败：按 HTTP status 映射固定 error code（契约 v2.6）。 */
export class ResearchError extends Error {
  constructor(public code: string, public status: number) {
    super(code);
    this.name = "ResearchError";
  }
}

const RESEARCH_ERROR_BY_STATUS: Record<number, string> = {
  403: "research_requires_pro",
  429: "research_quota_exceeded",
  409: "research_in_progress",
  503: "research_unavailable",
};

const STATUSES: ReadonlySet<string> = new Set(["queued", "running", "done", "cancelled", "failed_system"]);
const PHASES: ReadonlySet<string> = new Set(["plan", "gather", "synthesize"]);

function localeQuery(locale: string): string {
  return `?locale=${encodeURIComponent(locale)}`;
}

function researchUrl(path: string, locale: string): string {
  return `${ACCOUNT_BASE}${path}${localeQuery(locale)}`;
}

async function throwResearchError(resp: Response): Promise<never> {
  const mapped = RESEARCH_ERROR_BY_STATUS[resp.status];
  if (mapped) throw new ResearchError(mapped, resp.status);
  let code = "research_failed";
  try {
    const b = (await resp.json()) as { error?: string };
    if (b && typeof b.error === "string") code = b.error;
  } catch {
    /* 非 JSON 错误体：保留 research_failed */
  }
  throw new ResearchError(code, resp.status);
}

function asStatus(raw: unknown): ResearchStatus {
  return STATUSES.has(raw as string) ? (raw as ResearchStatus) : "queued";
}

function asPhase(raw: unknown): ResearchPhase | undefined {
  return PHASES.has(raw as string) ? (raw as ResearchPhase) : undefined;
}

function normalizeReferences(raw: unknown): ResearchReference[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map((item, i) => {
    const r = (item ?? {}) as Record<string, unknown>;
    return {
      n: typeof r.n === "number" && Number.isFinite(r.n) ? r.n : i + 1,
      title: typeof r.title === "string" ? r.title : "",
      url: typeof r.url === "string" ? r.url : "",
    };
  });
}

function normalizeSummary(raw: unknown): ResearchRunSummary {
  const r = (raw ?? {}) as Record<string, unknown>;
  const summary: ResearchRunSummary = {
    id: String(r.id ?? ""),
    question: typeof r.question === "string" ? r.question : "",
    status: asStatus(r.status),
    createdAt: typeof r.createdAt === "string" ? r.createdAt : String(r.createdAt ?? ""),
  };
  if (typeof r.finishedAt === "string") summary.finishedAt = r.finishedAt;
  else if (r.finishedAt != null) summary.finishedAt = String(r.finishedAt);
  return summary;
}

function normalizeRun(raw: unknown): ResearchRun {
  const r = (raw ?? {}) as Record<string, unknown>;
  const phase = asPhase(r.phase);
  const references = normalizeReferences(r.references);
  const run: ResearchRun = {
    id: String(r.id ?? ""),
    question: typeof r.question === "string" ? r.question : "",
    status: asStatus(r.status),
    sourcesFound: typeof r.sourcesFound === "number" && Number.isFinite(r.sourcesFound) ? r.sourcesFound : 0,
  };
  if (phase) run.phase = phase;
  if (typeof r.report === "string") run.report = r.report;
  if (references) run.references = references;
  if (typeof r.error === "string") run.error = r.error;
  return run;
}

function authHeaders(apiKey: string, jsonBody: boolean): Record<string, string> {
  return jsonBody
    ? { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }
    : { authorization: `Bearer ${apiKey}` };
}

/** POST /research → {id}。403/429/409/503 映射为 ResearchError.code。 */
export async function startResearch(
  apiKey: string,
  input: { question: string; focus?: string },
  deps: ManagedResearchDeps = {},
): Promise<{ id: string }> {
  const fetchFn = deps.fetchFn ?? fetch;
  const locale = deps.locale ?? getLocale();
  const body: { question: string; focus?: string } = { question: input.question };
  if (input.focus) body.focus = input.focus;
  const resp = await fetchFn(researchUrl("/research", locale), {
    method: "POST",
    headers: authHeaders(apiKey, true),
    body: JSON.stringify(body),
  });
  if (!resp.ok) await throwResearchError(resp);
  const json = (await resp.json()) as { id?: unknown };
  return { id: String(json.id ?? "") };
}

/** GET /research → ResearchRunSummary[]。 */
export async function listResearch(
  apiKey: string,
  deps: ManagedResearchDeps = {},
): Promise<ResearchRunSummary[]> {
  const fetchFn = deps.fetchFn ?? fetch;
  const locale = deps.locale ?? getLocale();
  const resp = await fetchFn(researchUrl("/research", locale), {
    headers: authHeaders(apiKey, false),
  });
  if (!resp.ok) await throwResearchError(resp);
  const json: unknown = await resp.json();
  const rows = Array.isArray(json)
    ? json
    : json && typeof json === "object" && Array.isArray((json as { runs?: unknown }).runs)
      ? (json as { runs: unknown[] }).runs
      : [];
  return rows.map(normalizeSummary);
}

/** GET /research/:id → ResearchRun。 */
export async function getResearch(
  apiKey: string,
  id: string,
  deps: ManagedResearchDeps = {},
): Promise<ResearchRun> {
  const fetchFn = deps.fetchFn ?? fetch;
  const locale = deps.locale ?? getLocale();
  const resp = await fetchFn(researchUrl(`/research/${encodeURIComponent(id)}`, locale), {
    headers: authHeaders(apiKey, false),
  });
  if (!resp.ok) await throwResearchError(resp);
  return normalizeRun(await resp.json());
}

/** POST /research/:id/cancel。 */
export async function cancelResearch(
  apiKey: string,
  id: string,
  deps: ManagedResearchDeps = {},
): Promise<void> {
  const fetchFn = deps.fetchFn ?? fetch;
  const locale = deps.locale ?? getLocale();
  const resp = await fetchFn(researchUrl(`/research/${encodeURIComponent(id)}/cancel`, locale), {
    method: "POST",
    headers: authHeaders(apiKey, false),
  });
  if (!resp.ok) await throwResearchError(resp);
}
