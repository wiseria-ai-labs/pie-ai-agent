import type { ResearchRun } from "@/lib/managed-research";

/**
 * Fixed sample ids. Files live at `samples/${id}.${locale}.md`.
 * Missing locale files fall back to `en` — add translations by dropping in a
 * new file; do not change this list or the loader when replacing copy.
 */
export const SAMPLE_IDS = ["ai-regulation", "climate-tech", "electric-vehicles"] as const;
export type SampleId = (typeof SAMPLE_IDS)[number];

const SAMPLE_FILES = import.meta.glob<string>("./samples/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});

export function sampleFileKey(id: string, locale: string): string {
  return `./samples/${id}.${locale}.md`;
}

/** Prefer `${id}.${locale}.md`, else `${id}.en.md`. */
export function pickSampleFile(
  files: Record<string, string>,
  id: string,
  locale: string,
): string | undefined {
  return files[sampleFileKey(id, locale)] ?? files[sampleFileKey(id, "en")];
}

/** Run stats shown on the paywall card. Absent when the file has no front matter. */
export interface SampleStats {
  sources: number;
  searches: number;
  minutes: number;
}

/**
 * Optional `--- key: value ---` front matter, then `# Title`, then the body.
 * Only the three numeric stats are recognised; anything else is ignored, so a
 * real report can keep whatever else its author put up there.
 */
export function parseSampleFrontMatter(md: string): { stats?: SampleStats; rest: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(md);
  if (!m) return { rest: md };
  const num = (key: string): number | undefined => {
    const hit = new RegExp(`^${key}:\\s*([0-9.]+)\\s*$`, "m").exec(m[1]);
    const n = hit ? Number(hit[1]) : NaN;
    return Number.isFinite(n) ? n : undefined;
  };
  const sources = num("sources");
  const searches = num("searches");
  const minutes = num("minutes");
  const rest = md.slice(m[0].length);
  // All three or none — a card showing "27 sources · NaN searches" is worse
  // than a card showing no stats at all.
  if (sources == null || searches == null || minutes == null) return { rest };
  return { stats: { sources, searches, minutes }, rest };
}

export function parseSampleMarkdown(md: string): {
  title: string;
  body: string;
  summary: string;
  stats?: SampleStats;
} {
  const { stats, rest } = parseSampleFrontMatter(md.replace(/^\uFEFF/, "").trim());
  const trimmed = rest.trim();
  const m = /^#\s+(.+?)\s*(?:\n+([\s\S]*))?$/.exec(trimmed);
  const title = m ? m[1].trim() : (trimmed.split("\n")[0] ?? "");
  const body = (m ? (m[2] ?? "") : trimmed).trim();
  // Card summary is the body's opening paragraph — no separate field to keep
  // in sync with the report itself.
  const summary = (body.split(/\n\s*\n/)[0] ?? "").replace(/\s+/g, " ").trim();
  return { title, body, summary, ...(stats ? { stats } : {}) };
}

export interface SampleReport {
  id: SampleId;
  title: string;
  body: string;
  summary: string;
  stats?: SampleStats;
}

export function loadSample(id: SampleId, locale: string): SampleReport {
  const md = pickSampleFile(SAMPLE_FILES, id, locale);
  if (!md) throw new Error(`missing research sample: ${id}`);
  return { id, ...parseSampleMarkdown(md) };
}

export function listSamples(locale: string): SampleReport[] {
  return SAMPLE_IDS.map((id) => loadSample(id, locale));
}

export function sampleToRun(sample: SampleReport): ResearchRun {
  return {
    id: `sample:${sample.id}`,
    question: sample.title,
    status: "done",
    sourcesFound: 0,
    report: sample.body,
  };
}
