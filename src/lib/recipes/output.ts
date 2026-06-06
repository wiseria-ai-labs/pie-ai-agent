// src/lib/recipes/output.ts
import type { RecordRow, RunResult } from "./types";

function escapeCSV(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function toCSV(records: RecordRow[], schema: { name: string }[]): string {
  const cols = schema.map((s) => s.name);
  const head = cols.map(escapeCSV).join(",");
  if (!records.length) return head;
  const body = records.map((r) => cols.map((c) => escapeCSV(r[c] ?? "")).join(",")).join("\n");
  return `${head}\n${body}`;
}

export function toJSON(result: RunResult): string {
  return JSON.stringify(result, null, 2);
}
