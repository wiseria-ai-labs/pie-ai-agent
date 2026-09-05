#!/usr/bin/env node
// 把 samples/<id>.en.md 翻成其它 locale（issue #430 多语言化）。按 H2 分段调 DeepSeek，
// 引用标记 [n] 逐段校验数量一致；References 段原样复制只换标题；三个固定标题用后端
// worker/src/models.ts 的同一套字串，让示例和真实本地化 run 长得一样。
// 用法：DEEPSEEK_API_KEY=... node scripts/research-sample-translate.mjs [id ...] [--locale zh-CN,ja]
import { readFileSync, writeFileSync } from "node:fs";

const BASE = process.env.DEEPSEEK_BASE ?? "https://api.deepseek.com";
const MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
const KEY = process.env.DEEPSEEK_API_KEY;
if (!KEY) { console.error("DEEPSEEK_API_KEY missing"); process.exit(2); }

const LANG = {
  "zh-CN": "Simplified Chinese (简体中文)",
  "zh-TW": "Traditional Chinese as used in Taiwan (繁體中文)",
  ja: "Japanese (日本語)",
  "es-419": "Latin American Spanish (español latinoamericano)",
  "pt-BR": "Brazilian Portuguese (português do Brasil)",
};
// 与 pie-managed-backend worker/src/models.ts 保持一致。
const HEADINGS = {
  "Limitations / Uncovered": { "zh-CN": "局限 / 未覆盖", "zh-TW": "局限 / 未涵蓋", "es-419": "Limitaciones / No cubierto", ja: "限界 / 未カバー", "pt-BR": "Limitações / Não coberto" },
  Unverified: { "zh-CN": "未经证实", "zh-TW": "未經證實", "es-419": "No verificado", ja: "未確認", "pt-BR": "Não verificado" },
  References: { "zh-CN": "参考文献", "zh-TW": "參考文獻", "es-419": "Referencias", ja: "参考文献", "pt-BR": "Referências" },
};

const args = process.argv.slice(2);
const li = args.indexOf("--locale");
const locales = li >= 0 ? args[li + 1].split(",") : Object.keys(LANG);
const ids = args.filter((a, i) => a !== "--locale" && i !== li + 1);
if (ids.length === 0) ids.push("ai-regulation", "climate-tech", "electric-vehicles");

const dir = new URL("../src/sidepanel/components/research/samples/", import.meta.url);
const cites = (s) => (s.match(/\[\d+\]/g) ?? []).sort().join(",");

async function translate(text, locale, attempt = 0) {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      // 思考模型的 reasoning 计入 max_tokens，不关会把千字段落都截掉。
      model: MODEL, temperature: 0, max_tokens: 8000, thinking: { type: "disabled" },
      messages: [
        { role: "system", content: `You translate a Markdown research report section from English into ${LANG[locale]}.
Rules:
- Translate all prose, including Markdown headings.
- Keep Markdown structure exactly (heading levels, paragraphs, lists, bold).
- Keep every citation marker like [12] or [3][7] exactly where it is; never add, drop, merge or renumber them.
- Keep numbers, dates, currency, model names, law names, company names, URLs and acronyms as in the source (add the local rendering in parentheses only if a name has a well-known one).
- Do not summarize, expand, or comment. Output only the translated Markdown, no code fence.` },
        { role: "user", content: text },
      ],
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const j = await res.json();
  const out = (j.choices?.[0]?.message?.content ?? "").trim().replace(/^```(?:markdown)?\n?|\n?```$/g, "");
  if (j.choices?.[0]?.finish_reason === "length") throw new Error("truncated");
  if (cites(out) !== cites(text)) {
    if (attempt < 2) return translate(text, locale, attempt + 1);
    throw new Error(`citation mismatch after retries:\n${cites(text)}\nvs\n${cites(out)}`);
  }
  return out;
}

async function one(id, locale) {
  const src = readFileSync(new URL(`${id}.en.md`, dir), "utf8");
  const fm = src.match(/^---\n[\s\S]*?\n---\n\n/);
  const body = fm ? src.slice(fm[0].length) : src;
  // 首块 = H1 + 摘要；其后每块以 "## " 起头。
  const chunks = body.split(/\n(?=## )/);
  const out = [];
  for (const chunk of chunks) {
    const m = chunk.match(/^## (.+)\n/);
    const heading = m?.[1]?.trim();
    if (heading === "References") {
      out.push(chunk.replace(/^## .+/, `## ${HEADINGS.References[locale]}`));
      continue;
    }
    let t = await translate(chunk, locale);
    if (heading && HEADINGS[heading]) t = t.replace(/^#+ .+/, `## ${HEADINGS[heading][locale]}`);
    out.push(t);
    console.error(`  ${id}/${locale}: ${heading ?? "(head)"} ok`);
  }
  writeFileSync(new URL(`${id}.${locale}.md`, dir), (fm?.[0] ?? "") + out.join("\n\n").trim() + "\n");
  console.error(`wrote ${id}.${locale}.md`);
}

const jobs = [];
for (const id of ids) for (const locale of locales) jobs.push([id, locale]);
// 每个 (id, locale) 内部串行，跨任务并发 5。
let cursor = 0, failed = 0;
await Promise.all(Array.from({ length: 5 }, async () => {
  while (cursor < jobs.length) {
    const [id, locale] = jobs[cursor++];
    try { await one(id, locale); } catch (e) { failed++; console.error(`FAILED ${id}/${locale}: ${e.message}`); }
  }
}));
process.exit(failed ? 1 : 0);
