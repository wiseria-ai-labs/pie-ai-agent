#!/usr/bin/env node
// 跑一次线上 Deep Research，把报告写成 paywall 示例（issue #430）。
// 用法：PIE_API_KEY=sk-... node scripts/research-sample.mjs <sample-id> "<question>" [searches]
//   sample-id 必须是 samples.ts 里的 SAMPLE_IDS 之一；searches 只有 admin「研究运行」列表能看到，手填。
const BASE = process.env.PIE_ACCOUNT_BASE ?? "https://account.pie.chat";
const [id, question, searchesArg] = process.argv.slice(2);
const key = process.env.PIE_API_KEY;
if (!id || !question || !key) { console.error("usage: PIE_API_KEY=... research-sample.mjs <id> <question> [searches]"); process.exit(2); }
const h = { authorization: `Bearer ${key}`, "content-type": "application/json" };
const j = async (r) => { if (!r.ok) throw new Error(`${r.status} ${await r.text()}`); return r.json(); };

// PIE_RUN_ID=<id> 时跳过 POST，只轮询并落文件（脚本中途被杀时用它接着拿）。
const runId = process.env.PIE_RUN_ID
  ?? (await j(await fetch(`${BASE}/research?locale=en`, { method: "POST", headers: h, body: JSON.stringify({ question }) }))).id;
console.error(`run ${runId} ${process.env.PIE_RUN_ID ? "resume" : "queued"}`);
let run;
for (;;) {
  await new Promise((r) => setTimeout(r, 10_000));
  run = await j(await fetch(`${BASE}/research/${runId}?locale=en`, { headers: h }));
  console.error(`  ${run.status} ${run.phase ?? ""} sources=${run.sourcesFound ?? 0}`);
  if (["done", "cancelled", "failed_system"].includes(run.status)) break;
}
if (run.status !== "done") { console.error(`run ended ${run.status}: ${run.error ?? ""}`); process.exit(1); }

const list = await j(await fetch(`${BASE}/research?locale=en`, { headers: h }));
const row = (list.runs ?? list).find((r) => r.id === runId);
const sec = (v) => (typeof v === "number" ? v : Date.parse(v) / 1000);
const minutes = row?.finishedAt ? ((sec(row.finishedAt) - sec(row.createdAt)) / 60).toFixed(1) : null;
const searches = searchesArg ? Number(searchesArg) : null;
// 三项缺一 samples.ts 就整体丢弃 stats；缺 searches 时先不写 front matter，拿到数字再补。
const fm = searches != null && minutes != null
  ? `---\nsources: ${run.sourcesFound}\nsearches: ${searches}\nminutes: ${minutes}\n---\n\n`
  : `<!-- TODO front matter: sources: ${run.sourcesFound}, minutes: ${minutes ?? "?"}, searches: ? (admin 研究运行列表) -->\n\n`;
const out = new URL(`../src/sidepanel/components/research/samples/${id}.en.md`, import.meta.url);
const { writeFileSync } = await import("node:fs");
writeFileSync(out, fm + run.report.trim() + "\n");
console.error(`wrote ${out.pathname}`);
