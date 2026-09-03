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

/** 契约 v2.8：gather 阶段的子问题进度。字段缺失时详情页退回三步时间轴。 */
export type ResearchSubStatus = "pending" | "active" | "done" | "skipped";

export interface ResearchSubQuestion {
  q: string;
  status: ResearchSubStatus;
  sources: number;
  error?: string;
}

/** 契约 v2.8：最近拿到的来源（后端已解析 domain，客户端不解析 URL）。 */
export interface ResearchSource {
  title: string;
  url: string;
  domain: string;
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
  /** v2.8，可选：后端未升级时省略。 */
  subQuestions?: ResearchSubQuestion[];
  /** v2.8，可选：最多 3 条，新的在前。 */
  recentSources?: ResearchSource[];
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

const SUB_STATUSES: ReadonlySet<string> = new Set(["pending", "active", "done", "skipped"]);

function normalizeSubQuestions(raw: unknown): ResearchSubQuestion[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map((item) => {
    const r = (item ?? {}) as Record<string, unknown>;
    const sub: ResearchSubQuestion = {
      q: typeof r.q === "string" ? r.q : "",
      status: typeof r.status === "string" && SUB_STATUSES.has(r.status)
        ? (r.status as ResearchSubStatus)
        : "pending",
      sources: typeof r.sources === "number" && Number.isFinite(r.sources) ? r.sources : 0,
    };
    if (typeof r.error === "string") sub.error = r.error;
    return sub;
  });
}

function normalizeSources(raw: unknown): ResearchSource[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map((item) => {
    const r = (item ?? {}) as Record<string, unknown>;
    return {
      title: typeof r.title === "string" ? r.title : "",
      url: typeof r.url === "string" ? r.url : "",
      domain: typeof r.domain === "string" ? r.domain : "",
    };
  });
}

/**
 * Backend GET /research timestamps are unix seconds (number or numeric string).
 * Downstream UI Date.parse()s ISO; a bare "1756660221" is NaN.
 * ISO strings (or any other non-numeric string) are kept as-is.
 */
function normalizeTimestamp(raw: unknown): string | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return new Date(raw * 1000).toISOString();
  }
  if (typeof raw === "string") {
    if (/^\d+$/.test(raw)) {
      const sec = Number(raw);
      if (Number.isFinite(sec)) return new Date(sec * 1000).toISOString();
    }
    return raw;
  }
  return undefined;
}

function normalizeSummary(raw: unknown): ResearchRunSummary {
  const r = (raw ?? {}) as Record<string, unknown>;
  const summary: ResearchRunSummary = {
    id: String(r.id ?? ""),
    question: typeof r.question === "string" ? r.question : "",
    status: asStatus(r.status),
    createdAt: normalizeTimestamp(r.createdAt) ?? "",
  };
  const finishedAt = normalizeTimestamp(r.finishedAt);
  if (finishedAt) summary.finishedAt = finishedAt;
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
  const subQuestions = normalizeSubQuestions(r.subQuestions);
  if (subQuestions) run.subQuestions = subQuestions;
  const recentSources = normalizeSources(r.recentSources);
  if (recentSources) run.recentSources = recentSources;
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
