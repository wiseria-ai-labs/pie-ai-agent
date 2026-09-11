// PR #450 真机验收 — LLM 批。补功能批的最后一块：**真实 Markdown 渲染**。
// 功能批验的是「字体能力」（注入 span 测宽度）；这里验「产品里真实的那个元素用了什么字体」——
// 走 CDP CSS.getPlatformFontsForNode，直接拿渲染引擎实际选用的平台字体名 + isCustomFont
// （true = @font-face web font，false = 系统字体），这是比宽度更硬的一层证据。
//
// 流程：seedConfig → composer 发一条只要 Markdown 不调工具的任务 → 断言在线态字体
// → **断网后重开侧栏**（历史消息从 IDB 重渲）→ 同一断言再跑一遍 = 清单 3 的产品级证据。
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.PIE_ACCEPT_BASE;
if (!BASE) throw new Error('PIE_ACCEPT_BASE 未设置');
const { PIE_EVAL_PROVIDER: PROVIDER, PIE_EVAL_MODEL: MODEL, PIE_EVAL_API_KEY: API_KEY } = process.env;
if (!API_KEY) { console.log('[SKIP] PIE_EVAL_API_KEY 为空 → LLM 批整体 SKIP'); process.exit(0); }
const DIST = `${BASE}/dist-pr`;
const REPORT = `${BASE}/report`;
const results = [];
let shot = 0;
const record = (item, status, note = '') => {
  results.push({ item, status, note });
  console.log(`[${status}] ${item}${note ? ' — ' + note : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function snap(page, name) {
  shot += 1;
  const f = `pr450-llm-${String(shot).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: `${REPORT}/${f}` });
  return f;
}

const ctx = await chromium.launchPersistentContext(`${BASE}/profile-llm`, {
  headless: false,
  viewport: { width: 420, height: 900 },
  locale: 'en-US',
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--lang=en-US'],
});
let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const extId = new URL(sw.url()).host;
for (let i = 0; i < 20; i++) {
  if (await sw.evaluate(() => typeof globalThis.__pieEval !== 'undefined')) break;
  await sleep(250);
}
await sleep(3000); // startup pipeline，防 instances_index lost-update
const { instanceId } = await sw.evaluate(
  (cfg) => globalThis.__pieEval.seedConfig(cfg), { provider: PROVIDER, model: MODEL, apiKey: API_KEY },
);
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
console.log(`  [launch] seeded ${PROVIDER}/${MODEL}`);

const page = await ctx.newPage();
page.setDefaultTimeout(20000);
await page.goto(`chrome-extension://${extId}/src/sidepanel/index.html`);
await sleep(1500);

// ── CDP：元素实际渲染用的平台字体 ──────────────────────────────────────
const cdp = await ctx.newCDPSession(page);
await cdp.send('DOM.enable');
await cdp.send('CSS.enable');
async function platformFonts(selector) {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  if (!nodeId) return null;
  const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
  return fonts.map((f) => ({ family: f.familyName, custom: f.isCustomFont, glyphs: f.glyphCount }));
}

const PROMPT = 'Reply with Markdown only, no tools, no browsing. Include exactly: one short sentence '
  + 'containing the **bold words** markup, and one fenced code block tagged js containing the single line '
  + 'const answer = 42;  Nothing else.';

// panel 首启可能停在设置页（配方坑：齿轮 aria 随视图翻转）→ 回 chat 才有 composer
async function backToChat(pg) {
  if (await pg.locator('textarea').count()) return;
  for (const name of ['Close settings', 'Back', 'Close Settings']) {
    const b = pg.getByRole('button', { name, exact: true });
    if (await b.count()) { await b.first().click(); await sleep(1200); break; }
  }
  if (!(await pg.locator('textarea').count())) {
    await pg.locator('button').first().click().catch(() => {});
    await sleep(1200);
  }
}

await backToChat(page);
const composer = page.locator('textarea').first();
await composer.waitFor({ timeout: 15000 });
await composer.fill(PROMPT);
await composer.press('Enter');

// 等真实 Markdown 元素落地
let rendered = false;
for (let i = 0; i < 90; i++) {
  const n = await page.locator('pre code').count().catch(() => 0);
  const b = await page.locator('strong').count().catch(() => 0);
  if (n > 0 && b > 0) { rendered = true; break; }
  await sleep(2000);
}
await sleep(1500);
const pngOnline = await snap(page, 'markdown-online');
if (!rendered) {
  record('L1. LLM 产出真实 Markdown（代码块 + 粗体）', 'ERROR',
    `90×2s 内未渲染出 pre code / strong；${pngOnline}`);
} else {
  const codeFonts = await platformFonts('pre code');
  const strongFonts = await platformFonts('strong');
  const strongWeight = await page.locator('strong').first().evaluate((el) => getComputedStyle(el).fontWeight);
  const codeFamily = await page.locator('pre code').first().evaluate((el) => getComputedStyle(el).fontFamily);

  const codeOk = codeFonts?.some((f) => f.family === 'JetBrains Mono' && f.custom);
  record('3c. 真实代码块用的是打包的 JetBrains Mono web font（CDP 平台字体，在线态）',
    codeOk ? 'PASS' : 'FAIL',
    `platformFonts(pre code)=${JSON.stringify(codeFonts)}；computed font-family=${codeFamily}；${pngOnline}`);

  const strongOk = strongFonts?.some((f) => f.family === 'Inter' && f.custom) && Number(strongWeight) >= 600;
  record('4c. 真实 <strong> 用 Inter web font 的真字重（非伪粗体）',
    strongOk ? 'PASS' : 'FAIL',
    `platformFonts(strong)=${JSON.stringify(strongFonts)}；computed font-weight=${strongWeight}`);
}

// ── 断网 → 重开侧栏（reload 原页面：session 上下文保留，历史消息从 IDB 重渲）──
await ctx.setOffline(true);
const cdnAfter = [];
ctx.on('request', (u) => { if (/fonts\.(googleapis|gstatic)\.com/.test(u.url())) cdnAfter.push(u.url()); });
await page.reload({ waitUntil: 'load' });
await sleep(4000);
await backToChat(page);
await sleep(1500);
// reload 后 panel 开的是新会话 → 历史消息要从 SessionDrawer(☰) 恢复
if ((await page.locator('pre code').count()) === 0) {
  await page.locator('header button, button').first().click().catch(() => {});
  await sleep(1500);
  // 会话标题由 LLM 生成，只能松匹配
  const row = page.getByText(/Markdown/i).first();
  if (await row.count()) { await row.click({ force: true }); await sleep(3000); }
}
const pngOffline = await snap(page, 'markdown-offline');

const cdp2 = await ctx.newCDPSession(page);
await cdp2.send('DOM.enable'); await cdp2.send('CSS.enable');
// 注意：CSS.getPlatformFontsForNode 只统计该节点**直接渲染的字形**，
// 所以必须选带直接文本的元素（body 会返回 []，不是回归）。
async function pf(selector) {
  const { root } = await cdp2.send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await cdp2.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  if (!nodeId) return null;
  const { fonts } = await cdp2.send('CSS.getPlatformFontsForNode', { nodeId });
  return fonts.map((f) => ({ family: f.familyName, custom: f.isCustomFont, glyphs: f.glyphCount }));
}
const hasCode = (await page.locator('pre code').count()) > 0;
const codeOff = hasCode ? await pf('pre code') : null;
const strongOff = (await page.locator('strong').count()) > 0 ? await pf('strong') : null;
// 正文：取渲染树里第一个带直接文本的元素（不同视图都有）
const proseSel = await page.evaluate(() => {
  const walk = document.querySelectorAll('p, span, div, h1, h2, button');
  for (const el of walk) {
    const direct = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 3);
    if (direct && el.id) return '#' + CSS.escape(el.id);
    if (direct && el.className && typeof el.className === 'string') {
      const c = el.className.trim().split(/\s+/).map((x) => '.' + CSS.escape(x)).join('');
      if (c) return el.tagName.toLowerCase() + c;
    }
  }
  return null;
});
const proseOff = proseSel ? await pf(proseSel) : null;
const monoOff = hasCode && codeOff?.some((f) => f.family === 'JetBrains Mono' && f.custom);
const sansOff = (strongOff?.some((f) => f.family === 'Inter' && f.custom))
  || (proseOff?.some((f) => f.family === 'Inter' && f.custom));
record('3d. 断网后重开侧栏：历史代码块仍 JetBrains Mono、正文仍 Inter（CDP 平台字体）',
  monoOff && sansOff ? 'PASS' : 'FAIL',
  `pre code=${JSON.stringify(codeOff)}；strong=${JSON.stringify(strongOff)}；`
  + `正文 ${proseSel}=${JSON.stringify(proseOff)}；断网后 CDN 请求 ${cdnAfter.length} 条；${pngOffline}`);

fs.writeFileSync(`${REPORT}/results-450-llm.json`, JSON.stringify({ results }, null, 2));
await ctx.close();
const fails = results.filter((r) => r.status !== 'PASS' && r.status !== 'PASS(部分)');
console.log(`\n=== LLM 批 ${results.length} 项，FAIL/ERROR ${fails.length} 项 ===`);
process.exit(fails.length ? 1 : 0);
