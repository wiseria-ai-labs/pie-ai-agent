// PR #448（issue #447）真机验收 — LLM 批。只覆盖两条必须真模型才成立的清单项：
//   7) 流式过程观感：逐 token 重渲染时公式区不白屏 / 不抛错（闪烁程度留给人看截图）
//   9) 产出侧：prompt.ts 新增的那句是否真让模型用 $…$ / $$…$$ 而不是 Unicode 近似
// 断言落磁盘证据（原始回复文本 + 流式采样序列），不只看对话文本。
import fs from 'node:fs';
import { prepareWorkspace, launch, sleep } from './release-smoke/lib.mjs';

const BASE = process.env.PIE_ACCEPT_BASE;
if (!BASE) throw new Error('PIE_ACCEPT_BASE 未设置');
const PROVIDER = process.env.PIE_EVAL_PROVIDER;
const MODEL = process.env.PIE_EVAL_MODEL;
const API_KEY = process.env.PIE_EVAL_API_KEY;
const REPORT = `${BASE}/report`;
const results = [];
const rec = (id, status, note = '') => { results.push({ id, status, note }); console.log(`[${status}] ${id} — ${note}`); };

if (!API_KEY) {
  rec('L1', 'SKIP', 'PIE_EVAL_API_KEY 为空 → LLM 批整体跳过（不换 provider）');
  rec('L2', 'SKIP', 'PIE_EVAL_API_KEY 为空 → LLM 批整体跳过');
  fs.mkdirSync(REPORT, { recursive: true });
  fs.writeFileSync(`${REPORT}/results-448-llm.json`, JSON.stringify({ results }, null, 2));
  process.exit(0);
}

const latestAssistantText = (page) => page.evaluate(() => new Promise((resolve, reject) => {
  const req = indexedDB.open('pie');
  req.onsuccess = () => {
    const db = req.result;
    const tx = db.transaction('sessions', 'readonly');
    const g = tx.objectStore('sessions').getAll();
    g.onsuccess = () => {
      const metas = g.result.filter((r) => typeof r.id === 'string' && r.id.endsWith(':meta') && r.value)
        .map((r) => r.value).sort((a, b) => (b.lastAccessedAt ?? 0) - (a.lastAccessedAt ?? 0));
      db.close();
      const msgs = metas[0]?.messages ?? [];
      const last = [...msgs].reverse().find((m) => m.role === 'assistant' && m.content);
      resolve(last?.content ?? null);
    };
    g.onerror = () => { db.close(); reject(g.error); };
  };
  req.onerror = () => reject(req.error);
}));

const run = async () => {
  fs.mkdirSync(REPORT, { recursive: true });
  prepareWorkspace(BASE);
  const { ctx, page, sw } = await launch(BASE, { profile: 'profile-448-llm', dist: `${BASE}/dist-pilot` });
  await sleep(3000);
  for (let i = 0; i < 20; i++) {
    if (await sw.evaluate(() => typeof globalThis.__pieEval !== 'undefined')) break;
    await sleep(250);
  }
  const { instanceId } = await sw.evaluate((cfg) => globalThis.__pieEval.seedConfig(cfg),
    { provider: PROVIDER, model: MODEL, apiKey: API_KEY });
  await sw.evaluate((args) => new Promise((resolve, reject) => {
    const req = indexedDB.open('pie');
    req.onsuccess = () => {
      const tx = req.result.transaction('config', 'readwrite');
      tx.objectStore('config').put({ key: 'last_model_selection', value: { instanceId: args.instanceId, model: args.model } });
      tx.objectStore('config').put({ key: 'instances_index', value: [args.instanceId] });
      tx.oncomplete = () => resolve(null);
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  }), { instanceId, model: MODEL });
  await page.reload();
  await sleep(1500);
  for (let i = 0; i < 5; i++) {
    if (await page.getByTestId('chat-composer').count()) break;
    if (await page.getByTestId('topbar-back').count()) await page.getByTestId('topbar-back').click();
    await sleep(400);
  }
  console.log(`  [launch] ${PROVIDER}/${MODEL} seeded`);

  const send = async (text) => {
    const box = page.getByTestId('chat-composer');
    await box.click();
    await box.fill(text);
    await page.getByTestId('chat-send').click();
  };

  // ── L2（清单 7）：流式过程采样 ───────────────────────────────────
  // 先跑长回答那条，顺便拿它的原始文本给 L1 用。
  const samples = [];
  try {
    await send('Derive the quadratic formula step by step, then state the Gaussian integral and the Pythagorean theorem. Answer directly without using any tools.');
    const t0 = Date.now();
    let sawStop = false;
    while (Date.now() - t0 < 180000) {
      const stop = await page.getByTestId('chat-stop').count();
      if (stop) sawStop = true;
      const s = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.bubble-in')];
        const last = rows[rows.length - 1];
        return {
          len: last ? (last.innerText || '').length : 0,
          katex: document.querySelectorAll('.katex').length,
          err: document.querySelectorAll('.katex-error').length,
          empty: !!last && (last.innerText || '').trim().length === 0,
        };
      });
      samples.push({ t: Date.now() - t0, ...s });
      if (sawStop && !stop) break;
      await sleep(150);
    }
    fs.writeFileSync(`${REPORT}/448-stream-samples.json`, JSON.stringify(samples, null, 2));
    await page.screenshot({ path: `${REPORT}/448-L2-final.png` });

    const started = samples.findIndex((s) => s.len > 0);
    const after = started >= 0 ? samples.slice(started) : [];
    const blanked = after.filter((s) => s.len === 0).length;            // 回到空 = 白屏
    const errFrames = after.filter((s) => s.err > 0).length;             // 半截公式的红字帧
    const katexDrops = after.filter((s, i) => i > 0 && s.katex < after[i - 1].katex).length; // 公式数回退 = 闪
    const finalErr = after.at(-1)?.err ?? -1;
    const finalKatex = after.at(-1)?.katex ?? 0;
    const ok = blanked === 0 && finalKatex > 0 && finalErr === 0;
    rec('L2', ok ? 'PASS' : 'FAIL',
      `采样 ${samples.length} 帧 / ${(samples.at(-1)?.t ?? 0) / 1000}s：白屏帧 ${blanked}，`
      + `含 .katex-error 的中间帧 ${errFrames}（半截公式的红字，收敛后应为 0），公式数回退帧 ${katexDrops}，`
      + `终态 .katex=${finalKatex} .katex-error=${finalErr}`);
  } catch (e) {
    rec('L2', 'ERROR', e.message);
  }

  // ── L1（清单 9）：prompt 改动是否真让模型写 LaTeX ─────────────────
  try {
    const raw = await latestAssistantText(page);
    fs.writeFileSync(`${REPORT}/448-llm-reply.md`, raw ?? '(null)');
    const inline = (raw?.match(/(?<!\$)\$[^$\n]+\$(?!\$)/g) ?? []).length;
    const display = (raw?.match(/\$\$[\s\S]+?\$\$/g) ?? []).length;
    const bracket = (raw?.match(/\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)/g) ?? []).length;
    const unicode = (raw?.match(/[±×÷≈≠≤≥√∫∑∏πθαβ²³⁴ₙ]/g) ?? []).length;
    const ok = !!raw && (inline + display + bracket) > 0;
    rec('L1', ok ? 'PASS' : 'FAIL',
      `原始回复 ${raw?.length ?? 0} 字（存 448-llm-reply.md）：$…$ × ${inline}，$$…$$ × ${display}，`
      + `\\(…\\)/\\[…\\] × ${bracket}，Unicode 数学字符 × ${unicode}`);
  } catch (e) {
    rec('L1', 'ERROR', e.message);
  }

  fs.writeFileSync(`${REPORT}/results-448-llm.json`, JSON.stringify({ provider: PROVIDER, model: MODEL, results }, null, 2));
  await ctx.close();
  console.log(`\n=== LLM 批完成：${results.length} 条，FAIL/ERROR ${results.filter((r) => r.status !== 'PASS' && r.status !== 'SKIP').length} 条 ===`);
};

run().catch((e) => { console.error('FATAL', e); process.exit(1); });
