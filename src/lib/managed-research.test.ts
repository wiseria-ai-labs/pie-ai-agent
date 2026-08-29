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
  const summary = {
    id: "run_1",
    question: "What is Pie?",
    status: "running" as const,
    createdAt: "2026-08-29T00:00:00.000Z",
  };

  it("GETs /research?locale= with Bearer and parses an array", async () => {
    const fetchFn = ok([summary]);
    const res = await listResearch(KEY, { fetchFn, locale: "en" });
    expect(fetchFn).toHaveBeenCalledWith("https://account.pie.chat/research?locale=en", {
      headers: { authorization: "Bearer sk-research" },
    });
    expect(res).toEqual([summary]);
  });

  it("parses {runs: [...]} envelope", async () => {
    const fetchFn = ok({ runs: [summary] });
    expect(await listResearch(KEY, { fetchFn, locale: "en" })).toEqual([summary]);
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
