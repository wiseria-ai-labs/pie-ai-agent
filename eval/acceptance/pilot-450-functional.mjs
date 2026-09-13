// PR #450（fix/449-bundle-fonts-locally）真机验收 — 功能批。
// 环境搭建 / 配方坑见 docs/agents/auto-acceptance.md。纯前端样式 PR：不触 daemon / agent loop
// → 不起 scratch daemon、不写 NM manifest、不 seedConfig、无 LLM 批。
//
// 清单（Review 给的 4 条）：
//   1. 侧栏 0 条请求指向 fonts.googleapis.com / fonts.gstatic.com
//   2. 4 个 woff2 从 chrome-extension://<id>/assets/ 加载成功（唯一技术盲区：
//      /assets/ 根绝对路径是本仓库第一个进扩展页面 CSS 的 url()）
//   3. 断网后重开侧栏：正文仍 Inter、代码块仍 JetBrains Mono，不是回落
//   4. 粗体是真可变字重不是伪粗体；中文仍回落系统字体
//
// 每条都跑 clean-main 的 dist 做对照（main 源码重 build）：
//   - 场景 C（main·在线）必须**有** CDN 请求 → 证明断言 1 的监听真能看见字体请求
//   - 场景 D（main·断网）Inter 必须**回落** → 证明断言 3 真能测出差别，不是环境巧合
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.PIE_ACCEPT_BASE;
if (!BASE) throw new Error('PIE_ACCEPT_BASE 未设置');
const REPORT = `${BASE}/report`;
fs.mkdirSync(REPORT, { recursive: true });

const results = [];
let shot = 0;
function record(item, status, note = '') {
  results.push({ item, status, note });
  console.log(`[${status}] ${item}${note ? ' — ' + note : ''}`);
}
async function snap(page, name) {
  shot += 1;
  const p = `${REPORT}/pr450-${String(shot).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: p });
  return p.split('/').pop();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 页面内探针：全部在 sidepanel 的真实 CSS 环境里跑 ─────────────────────
const PROBE = `(async () => {
  const LATIN = 'Handgloves Quick Brown Fox 0123456789';
  const LATIN_EXT = '\\u0100\\u0113\\u0123\\u014B\\u0179';   // Ā ē ģ ŋ Ź  → U+0100-02BA 子集
  const CJK = '\\u4E2D\\u6587\\u6D4B\\u8BD5\\u5185\\u5BB9';  // 中文测试内容

  function measure(family, text, weight) {
    const el = document.createElement('span');
    el.style.cssText = 'position:absolute;left:-9999px;top:-9999px;white-space:pre;font-size:64px;'
      + 'font-weight:' + (weight || 400) + ';font-family:' + family;
    el.textContent = text;
    document.body.appendChild(el);
    const w = el.getBoundingClientRect().width;
    el.remove();
    return Math.round(w * 100) / 100;
  }

  // 主动触发两个子集（latin 与 latin-ext 各一串字符），走真实 CSS @font-face 解析路径
  const loadState = {};
  for (const [key, fam, txt] of [
    ['inter-latin', '16px Inter', LATIN],
    ['inter-latin-ext', '16px Inter', LATIN_EXT],
    ['mono-latin', '16px "JetBrains Mono"', LATIN],
    ['mono-latin-ext', '16px "JetBrains Mono"', LATIN_EXT],
  ]) {
    try {
      const faces = await document.fonts.load(fam, txt);
      loadState[key] = faces.map((f) => f.family + '/' + f.status);
    } catch (e) { loadState[key] = 'ERROR: ' + e.message; }
  }
  await document.fonts.ready;

  const faces = [];
  document.fonts.forEach((f) => faces.push({ family: f.family, weight: f.weight, status: f.status }));

  // resource timing：拿 woff2 的真实 URL + 状态（chrome-extension scheme 也会记录）
  const res = performance.getEntriesByType('resource').map((e) => ({
    name: e.name, status: e.responseStatus, size: e.transferSize || e.encodedBodySize, type: e.initiatorType,
  }));

  const cs = getComputedStyle(document.documentElement);
  const bodyFont = getComputedStyle(document.body).fontFamily;

  // 字重扫描：可变轴 → 各档宽度各不相同；静态 400-only → 400/500/600 完全相同（合成只在 bolder）
  const weights = {};
  for (const w of [100, 300, 400, 500, 600, 700, 800, 900]) weights[w] = measure('Inter', LATIN, w);

  return {
    loadState, faces, res,
    varSans: cs.getPropertyValue('--font-sans').trim(),
    varMono: cs.getPropertyValue('--font-mono').trim(),
    bodyFont,
    w: {
      interLatin: measure('Inter', LATIN),
      interLatinExt: measure('Inter', LATIN_EXT),
      sansFallback: measure('"__PieNoSuchFont__", system-ui', LATIN),
      sansFallbackExt: measure('"__PieNoSuchFont__", system-ui', LATIN_EXT),
      mono: measure('"JetBrains Mono"', LATIN),
      monoFallback: measure('"__PieNoSuchFont__", monospace', LATIN),
      varSansText: measure('var(--font-sans)', LATIN),
      varMonoText: measure('var(--font-mono)', LATIN),
      defaultFont: measure('"__PieNoSuchFont__"', LATIN),
      cjkInter: measure('Inter', CJK),
      cjkSystem: measure('system-ui', CJK),
    },
    weights,
  };
})()`;

const differs = (a, b) => Math.abs(a - b) > 0.5;

async function runScenario({ dist, profile, offline, label }) {
  const reqs = [];
  const ctx = await chromium.launchPersistentContext(`${BASE}/${profile}`, {
    headless: false,
    viewport: { width: 420, height: 900 },
    locale: 'en-US',
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--lang=en-US'],
  });
  const resps = [];
  ctx.on('request', (r) => reqs.push(r.url()));
  ctx.on('response', (r) => resps.push({ url: r.url(), status: r.status() }));
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const extId = new URL(sw.url()).host;
  await sleep(1500);                       // SW startup pipeline
  if (offline) await ctx.setOffline(true); // 断网发生在打开侧栏之前
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  const pageReqs = [];
  page.on('request', (r) => pageReqs.push(r.url()));
  page.on('response', (r) => resps.push({ url: r.url(), status: r.status() }));
  await page.goto(`chrome-extension://${extId}/src/sidepanel/index.html`);
  await page.waitForLoadState('load');
  await sleep(2500);
  const probe = await page.evaluate(PROBE);
  const png = await snap(page, label);
  const all = [...reqs, ...pageReqs];
  await ctx.close();
  return { probe, reqs: all, resps, extId, png };
}

const CDN_RE = /fonts\.(googleapis|gstatic)\.com/;
const out = {};

// ── 场景 A：PR 版 · 在线 ────────────────────────────────────────────────
{
  const { probe, reqs, resps, extId, png } = await runScenario({
    dist: `${BASE}/dist-pr`, profile: 'profile-pr-online', offline: false, label: 'pr-online',
  });
  out.A = { probe, reqs, resps, extId };
  const cdn = reqs.filter((u) => CDN_RE.test(u));
  record('1. 侧栏 0 条请求指向 fonts.googleapis.com / fonts.gstatic.com',
    cdn.length === 0 ? 'PASS' : 'FAIL',
    `总请求 ${reqs.length} 条，CDN 字体请求 ${cdn.length} 条${cdn.length ? ': ' + cdn.join(', ') : ''} / ${png}`);

  const woffUrls = [...new Set(reqs.filter((u) => u.endsWith('.woff2')))];
  const fromAssets = woffUrls.filter((u) => u.startsWith(`chrome-extension://${extId}/assets/`));
  const woffResps = resps.filter((r) => r.url.endsWith('.woff2'));
  const bad = woffResps.filter((r) => r.status !== 200);
  const facesLoaded = probe.faces.filter((f) => f.status === 'loaded');
  record('2. 4 个 woff2 从 chrome-extension://<id>/assets/ 成功加载（根绝对路径盲区）',
    fromAssets.length === 4 && woffUrls.length === 4 && bad.length === 0 && facesLoaded.length === 4
      ? 'PASS' : 'FAIL',
    `请求 ${woffUrls.length} 个 woff2，全部 chrome-extension://${extId}/assets/ : `
    + fromAssets.map((u) => u.split('/').pop()).join(', ')
    + ` ‖ response status: ${[...new Set(woffResps.map((r) => r.status))].join(',')}（非 200: ${bad.length}）`
    + ` ‖ document.fonts 中 ${facesLoaded.length}/4 face status=loaded`
    + (woffUrls.length !== fromAssets.length ? ` ‖ 非 assets 路径: ${woffUrls.filter((u) => !fromAssets.includes(u))}` : ''));

  const distinct = new Set(Object.values(probe.weights));
  const cjkFallback = !differs(probe.w.cjkInter, probe.w.cjkSystem);
  record('4a. 粗体是真可变字重不是伪粗体（100–900 轴生效）',
    distinct.size >= 6 ? 'PASS' : 'FAIL',
    `字重宽度 ${JSON.stringify(probe.weights)} → ${distinct.size} 个不同值（静态单字重会只有 1–2 个）`);
  record('4b. 中文仍回落系统字体（Inter 不含 CJK，预期行为不变）',
    cjkFallback ? 'PASS' : 'FAIL',
    `CJK@Inter=${probe.w.cjkInter}px vs CJK@system-ui=${probe.w.cjkSystem}px（相同=回落）`);
}

// ── 场景 B：PR 版 · 断网（清单 3 主场景）──────────────────────────────
{
  const { probe, reqs, png } = await runScenario({
    dist: `${BASE}/dist-pr`, profile: 'profile-pr-offline', offline: true, label: 'pr-offline',
  });
  out.B = { probe, reqs };
  const D = probe.w.defaultFont;                       // 裸 family 解析失败时的真实回落目标
  const sansOk = differs(probe.w.interLatin, D) && !differs(probe.w.varSansText, probe.w.interLatin);
  const monoOk = differs(probe.w.mono, D) && !differs(probe.w.varMonoText, probe.w.mono)
    && differs(probe.w.mono, probe.w.monoFallback);   // 也要跟 SF Mono/Menlo 回落区分开
  const loaded = probe.faces.filter((f) => f.status === 'loaded');
  record('3. 断网后重开侧栏：正文仍 Inter、代码块仍 JetBrains Mono（非回落）',
    sansOk && monoOk && loaded.length === 4 ? 'PASS' : 'FAIL',
    `断网下 4/4 face status=${loaded.length === 4 ? 'loaded' : JSON.stringify(probe.faces)}；`
    + `var(--font-sans) 实渲=${probe.w.varSansText}px ≡ Inter=${probe.w.interLatin}px，`
    + `回落基准 default=${D}px / system-ui=${probe.w.sansFallback}px；`
    + `var(--font-mono) 实渲=${probe.w.varMonoText}px ≡ JetBrains Mono=${probe.w.mono}px，`
    + `回落基准 monospace=${probe.w.monoFallback}px / ${png}`);
  const cdn = reqs.filter((u) => CDN_RE.test(u));
  record('3b. 断网态也不尝试请求字体 CDN', cdn.length === 0 ? 'PASS' : 'FAIL',
    `CDN 请求 ${cdn.length} 条`);
}

// ── 场景 D：clean main · 断网（对照，先跑：profile 全新、无 CDN 缓存）──
{
  const { probe, png } = await runScenario({
    dist: `${BASE}/dist-main`, profile: 'profile-main-offline', offline: true, label: 'main-offline',
  });
  out.D = { probe };
  const noFaces = probe.faces.length === 0;
  const sansFell = !differs(probe.w.varSansText, probe.w.sansFallback);
  const monoFell = !differs(probe.w.varMonoText, probe.w.monoFallback);
  record('CTRL-D. 对照 clean main · 断网 → Inter/JetBrains Mono 必须回落（断言 3 的有效性证明）',
    noFaces && sansFell && monoFell ? 'PASS' : 'FAIL',
    `main 断网: document.fonts 为空(${probe.faces.length} face)；`
    + `var(--font-sans) 实渲=${probe.w.varSansText}px ≡ system-ui 回落=${probe.w.sansFallback}px；`
    + `var(--font-mono) 实渲=${probe.w.varMonoText}px ≡ monospace 回落=${probe.w.monoFallback}px；`
    + `裸 Inter/裸 Mono 双双落到浏览器默认字体 ${probe.w.interLatin}px/${probe.w.mono}px / ${png}`);
}

// ── 场景 C：clean main · 在线（对照：断言 1 的监听有效性证明）────────
{
  const { reqs, probe, png } = await runScenario({
    dist: `${BASE}/dist-main`, profile: 'profile-main-online', offline: false, label: 'main-online',
  });
  out.C = { reqs, probe };
  const cdn = reqs.filter((u) => CDN_RE.test(u));
  record('CTRL-C. 对照 clean main · 在线 → 必须看得见 CDN 字体请求（断言 1 的有效性证明）',
    cdn.length > 0 ? 'PASS' : 'FAIL',
    `main 抓到 ${cdn.length} 条: ${[...new Set(cdn.map((u) => new URL(u).host))].join(', ')} / ${png}`);
}

fs.writeFileSync(`${REPORT}/results-450.json`, JSON.stringify({ results, out }, null, 2));
const fails = results.filter((r) => r.status !== 'PASS');
console.log(`\n=== ${results.length} 项，FAIL/ERROR ${fails.length} 项 ===`);
process.exit(fails.length ? 1 : 0);
