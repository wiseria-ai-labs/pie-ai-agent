import { describe, expect, it } from "vitest";
import {
  SAMPLE_IDS,
  listSamples,
  loadSample,
  parseSampleMarkdown,
  pickSampleFile,
  sampleFileKey,
  sampleToRun,
} from "./samples";

describe("research sample fixtures", () => {
  it("ships three fixed ids", () => {
    expect([...SAMPLE_IDS]).toEqual(["ai-regulation", "climate-tech", "electric-vehicles"]);
  });

  it("parses the leading H1 as title and the rest as body", () => {
    const parsed = parseSampleMarkdown("# Hello world\n\nBody paragraph.\n");
    expect(parsed.title).toBe("Hello world");
    expect(parsed.body).toBe("Body paragraph.");
    expect(parsed.summary).toBe("Body paragraph.");
    expect(parsed.stats).toBeUndefined();
  });

  it("reads run stats from front matter and keeps them out of the body", () => {
    const md = "---\nsources: 27\nsearches: 10\nminutes: 4.8\n---\n\n# T\n\nOpening line.\n\nRest of it.";
    const parsed = parseSampleMarkdown(md);
    expect(parsed.stats).toEqual({ sources: 27, searches: 10, minutes: 4.8 });
    expect(parsed.title).toBe("T");
    expect(parsed.summary).toBe("Opening line.");
    expect(parsed.body).not.toContain("sources:");
  });

  it("drops partial stats rather than rendering a NaN on the card", () => {
    const parsed = parseSampleMarkdown("---\nsources: 27\n---\n\n# T\n\nBody.");
    expect(parsed.stats).toBeUndefined();
    expect(parsed.title).toBe("T");
  });

  it("collapses a wrapped opening paragraph into one summary line", () => {
    const parsed = parseSampleMarkdown("# T\n\nOne line\nwrapped here.\n\nSecond para.");
    expect(parsed.summary).toBe("One line wrapped here.");
  });

  it("prefers the locale file and falls back to en", () => {
    const files = {
      [sampleFileKey("ai-regulation", "en")]: "# English title\n\nen body",
      [sampleFileKey("ai-regulation", "zh-CN")]: "# 中文标题\n\nzh body",
    };
    expect(pickSampleFile(files, "ai-regulation", "zh-CN")).toContain("中文标题");
    expect(pickSampleFile(files, "ai-regulation", "ja")).toContain("English title");
    expect(pickSampleFile(files, "missing", "en")).toBeUndefined();
  });

  it("loads packed en fixtures and falls back for locales without a file", () => {
    const en = loadSample("ai-regulation", "en");
    const ja = loadSample("ai-regulation", "ja");
    expect(en.title.length).toBeGreaterThan(0);
    expect(en.body).not.toMatch(/placeholder/i);
    expect(en.body).toMatch(/^## References/m);
    expect(ja).toEqual(en);
    expect(listSamples("pt-BR")).toHaveLength(3);
  });

  it("every packed sample carries the stats the paywall card renders", () => {
    for (const s of listSamples("en")) {
      expect(s.stats, s.id).toBeTruthy();
      expect(s.summary.length, s.id).toBeGreaterThan(20);
      expect(s.summary, s.id).not.toMatch(/placeholder/i);
    }
  });

  it("rejects failed-run leftovers so paywall samples stay finished copy", () => {
    for (const s of listSamples("en")) {
      expect(s.body, s.id).not.toMatch(/not supplied in the notes/i);
      expect(s.body, s.id).not.toMatch(/skipped due to data errors/i);
      expect(s.body, s.id).toMatch(/^## References/m);
      expect(s.body, s.id).toMatch(/\[1\]/);
    }
  });

  it("maps a sample onto a done ResearchRun for the shared detail view", () => {
    const run = sampleToRun(loadSample("climate-tech", "en"));
    expect(run.id).toBe("sample:climate-tech");
    expect(run.status).toBe("done");
    expect(run.report).not.toMatch(/placeholder/i);
    expect(run.report).toMatch(/\[1\]/);
    expect(run.question).toBe(loadSample("climate-tech", "en").title);
  });
});
