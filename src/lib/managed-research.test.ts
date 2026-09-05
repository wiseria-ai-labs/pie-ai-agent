import { describe, expect, it, vi } from "vitest";
import {
  startResearch,
  listResearch,
  getResearch,
  cancelResearch,
  ResearchError,
} from "./managed-research";

const KEY = "sk-research";

function ok(json: unknown, status = 200): typeof fetch {
  return vi.fn(async () => ({ ok: true, status, json: async () => json })) as unknown as typeof fetch;
}

function fail(status: number, body: unknown = {}): typeof fetch {
  return vi.fn(async () => ({ ok: false, status, json: async () => body })) as unknown as typeof fetch;
}

const ERRORS: [number, string][] = [
  [403, "research_requires_pro"],
  [429, "research_quota_exceeded"],
  [409, "research_in_progress"],
  [503, "research_unavailable"],
];

describe("startResearch", () => {
  it("POSTs /research?locale= with Bearer + {question} and returns {id}", async () => {
    const fetchFn = ok({ id: "run_1" });
    const res = await startResearch(KEY, { question: "What is Pie?" }, { fetchFn, locale: "en" });
    expect(fetchFn).toHaveBeenCalledWith("https://account.pie.chat/research?locale=en", {
      method: "POST",
      headers: { authorization: "Bearer sk-research", "content-type": "application/json" },
      body: JSON.stringify({ question: "What is Pie?" }),
    });
    expect(res).toEqual({ id: "run_1" });
  });

  it("includes optional focus in the body", async () => {
    const fetchFn = ok({ id: "run_2" });
    await startResearch(KEY, { question: "Q", focus: "news" }, { fetchFn, locale: "zh-CN" });
    expect(fetchFn).toHaveBeenCalledWith("https://account.pie.chat/research?locale=zh-CN", {
      method: "POST",
      headers: { authorization: "Bearer sk-research", "content-type": "application/json" },
      body: JSON.stringify({ question: "Q", focus: "news" }),
    });
  });

  it.each(ERRORS)("status %s → ResearchError.code %s", async (status, code) => {
    const fetchFn = fail(status);
    await expect(startResearch(KEY, { question: "Q" }, { fetchFn, locale: "en" })).rejects.toMatchObject({
      name: "ResearchError",
      code,
      status,
    });
    await expect(startResearch(KEY, { question: "Q" }, { fetchFn, locale: "en" })).rejects.toBeInstanceOf(ResearchError);
  });
});

describe("listResearch", () => {
  const UNIX_SEC = 1756660221;
  const ISO = new Date(UNIX_SEC * 1000).toISOString();

  const summaryWire = {
    id: "run_1",
    question: "What is Pie?",
    status: "running" as const,
    createdAt: UNIX_SEC,
  };

  const summary = {
    id: "run_1",
    question: "What is Pie?",
    status: "running" as const,
    createdAt: ISO,
  };

  it("GETs /research?locale= with Bearer and parses an array", async () => {
    const fetchFn = ok([summaryWire]);
    const res = await listResearch(KEY, { fetchFn, locale: "en" });
    expect(fetchFn).toHaveBeenCalledWith("https://account.pie.chat/research?locale=en", {
      headers: { authorization: "Bearer sk-research" },
    });
    expect(res).toEqual([summary]);
    expect(Date.parse(res[0].createdAt)).toBe(UNIX_SEC * 1000);
  });

  it("parses {runs: [...]} envelope", async () => {
    const fetchFn = ok({ runs: [summaryWire] });
    expect(await listResearch(KEY, { fetchFn, locale: "en" })).toEqual([summary]);
  });

  it("normalizes unix-second createdAt / finishedAt (number) to ISO", async () => {
    const finishedSec = UNIX_SEC + 60;
    const fetchFn = ok([{ ...summaryWire, finishedAt: finishedSec }]);
    const res = await listResearch(KEY, { fetchFn, locale: "en" });
    expect(res[0].createdAt).toBe(ISO);
    expect(Date.parse(res[0].createdAt)).toBe(1756660221000);
    expect(res[0].finishedAt).toBe(new Date(finishedSec * 1000).toISOString());
    expect(Date.parse(res[0].finishedAt!)).toBe(finishedSec * 1000);
  });

  it("normalizes numeric-string createdAt / finishedAt the same way", async () => {
    const finishedSec = UNIX_SEC + 60;
    const fetchFn = ok([{
      ...summaryWire,
      createdAt: String(UNIX_SEC),
      finishedAt: String(finishedSec),
    }]);
    const res = await listResearch(KEY, { fetchFn, locale: "en" });
    expect(res[0].createdAt).toBe(ISO);
    expect(Date.parse(res[0].createdAt)).toBe(1756660221000);
    expect(res[0].finishedAt).toBe(new Date(finishedSec * 1000).toISOString());
    expect(Date.parse(res[0].finishedAt!)).toBe(finishedSec * 1000);
  });

  it("keeps ISO timestamps as-is", async () => {
    const finishedIso = "2026-08-29T00:01:00.000Z";
    const fetchFn = ok([{ ...summaryWire, createdAt: ISO, finishedAt: finishedIso }]);
    const res = await listResearch(KEY, { fetchFn, locale: "en" });
    expect(res[0].createdAt).toBe(ISO);
    expect(res[0].finishedAt).toBe(finishedIso);
  });

  it("omits finishedAt when the backend doesn't send it", async () => {
    const fetchFn = ok([summaryWire]);
    const res = await listResearch(KEY, { fetchFn, locale: "en" });
    expect(res[0].finishedAt).toBeUndefined();
    expect("finishedAt" in res[0]).toBe(false);
  });

  it.each(ERRORS)("status %s → ResearchError.code %s", async (status, code) => {
    const fetchFn = fail(status);
    await expect(listResearch(KEY, { fetchFn, locale: "en" })).rejects.toMatchObject({ code, status });
  });
});

describe("getResearch", () => {
  const run = {
    id: "run_1",
    question: "What is Pie?",
    status: "done" as const,
    phase: "synthesize" as const,
    sourcesFound: 4,
    report: "# Report",
    references: [{ n: 1, title: "Pie", url: "https://pie.chat" }],
  };

  it("GETs /research/:id?locale= with Bearer and parses the run", async () => {
    const fetchFn = ok(run);
    const res = await getResearch(KEY, "run_1", { fetchFn, locale: "en" });
    expect(fetchFn).toHaveBeenCalledWith("https://account.pie.chat/research/run_1?locale=en", {
      headers: { authorization: "Bearer sk-research" },
    });
    expect(res).toEqual(run);
  });

  it.each(ERRORS)("status %s → ResearchError.code %s", async (status, code) => {
    const fetchFn = fail(status);
    await expect(getResearch(KEY, "run_1", { fetchFn, locale: "en" })).rejects.toMatchObject({ code, status });
  });

  // 契约 v2.8：两个字段都是可选的，后端未升级时必须整字段消失而不是变成空数组，
  // 否则详情页会渲染一个空的子问题清单而不是退回三步态。
  it("omits subQuestions / recentSources when the backend doesn't send them", async () => {
    const res = await getResearch(KEY, "run_1", { fetchFn: ok(run), locale: "en" });
    expect(res.subQuestions).toBeUndefined();
    expect(res.recentSources).toBeUndefined();
  });

  it("parses v2.8 subQuestions / recentSources and defends against junk", async () => {
    const fetchFn = ok({
      ...run,
      subQuestions: [
        { q: "a", status: "done", sources: 6 },
        { q: "b", status: "skipped", sources: 0, error: "tavily 502" },
        { q: "c", status: "bogus", sources: "3" },
        {},
      ],
      recentSources: [{ title: "T", url: "https://x.dev/a", domain: "x.dev" }, {}],
    });
    const res = await getResearch(KEY, "run_1", { fetchFn, locale: "en" });
    expect(res.subQuestions).toEqual([
      { q: "a", status: "done", sources: 6 },
      { q: "b", status: "skipped", sources: 0, error: "tavily 502" },
      { q: "c", status: "pending", sources: 0 }, // 未知 status / 非数字 sources 落回安全值
      { q: "", status: "pending", sources: 0 },
    ]);
    expect(res.recentSources).toEqual([
      { title: "T", url: "https://x.dev/a", domain: "x.dev" },
      { title: "", url: "", domain: "" },
    ]);
  });
});

describe("cancelResearch", () => {
  it("POSTs /research/:id/cancel?locale= with Bearer", async () => {
    const fetchFn = ok({ ok: true });
    await cancelResearch(KEY, "run_1", { fetchFn, locale: "en" });
    expect(fetchFn).toHaveBeenCalledWith("https://account.pie.chat/research/run_1/cancel?locale=en", {
      method: "POST",
      headers: { authorization: "Bearer sk-research" },
    });
  });

  it.each(ERRORS)("status %s → ResearchError.code %s", async (status, code) => {
    const fetchFn = fail(status);
    await expect(cancelResearch(KEY, "run_1", { fetchFn, locale: "en" })).rejects.toMatchObject({ code, status });
  });
});
