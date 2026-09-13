// PR #448（issue #447 — Markdown LaTeX 公式渲染）真机验收 — 功能批。
// 环境搭建 / 配方坑见 docs/agents/auto-acceptance.md。本 PR 不碰 daemon / 桥 → 不起 daemon、不 seedConfig。
//
// 验的是 happy-dom 单测结构上测不出来的那一半：真实 Chromium 应用 KaTeX CSS 之后
// 公式的**几何**（竖直定位）、**字体**、**窄栏溢出**、**配比**、**颜色**，以及
// 四个 Markdown 消费方（Chat / 思考区 / 总结区 / Deep Research 报告）各自的 CSS 上下文。
//
// 第 1 轮的阻塞 bug（CSS 与 JS 分属两个 KaTeX major → 21 个结构类名全不匹配 → 盒模型规则
// 全不生效）在真机上的表现就是 A1 的几何断言。A1 自带敏感度对照：把结构类的 display/position
// 就地中和掉（等价于第 1 轮那份产物），同一断言必须翻红——否则说明断言根本没测到东西。
import fs from 'node:fs';
import { prepareWorkspace, launch, sleep, REPO } from './release-smoke/lib.mjs';

const BASE = process.env.PIE_ACCEPT_BASE;
if (!BASE) throw new Error('PIE_ACCEPT_BASE 未设置');
const REPORT = `${BASE}/report`;
const results = [];
let shot = 0;

function rec(id, status, note = '') {
  results.push({ id, status, note });
  console.log(`[${status}] ${id} — ${note}`);
}
async function snap(page, name) {
  shot += 1;
  await page.screenshot({ path: `${REPORT}/448-${String(shot).padStart(2, '0')}-${name}.png` }).catch(() => {});
}
async function item(page, id, fn) {
  try { await fn(); } catch (e) { rec(id, 'ERROR', e.message); await snap(page, `err-${id}`); }
}

// ───────────────────────── fixture：seed 一个含各种公式的会话 ─────────────────────────
const R = String.raw;
const ASSISTANT_MD = [
  'Inline: mass-energy equivalence is $E=mc^2$ in running text.',
  '',
  R`$$\int_0^\infty e^{-x}\,dx = 1$$`,
  '',
  R`Fraction: $$\frac{a+b}{c}$$`,
  '',
  R`Root and sum: $\sqrt{x^2+y^2}$ then $\sum_{i=1}^{n} i$.`,
  '',
  'Wide display formula (must scroll inside its own box):',
  '',
  R`$$\alpha_{1}+\alpha_{2}+\alpha_{3}+\alpha_{4}+\alpha_{5}+\alpha_{6}+\alpha_{7}+\alpha_{8}+\alpha_{9}+\alpha_{10}+\alpha_{11}+\alpha_{12}+\alpha_{13}+\alpha_{14}+\alpha_{15} = \beta^{2}$$`,
  '',
  R`Bracket delimiters: \(y = kx + b\) and \[z = x^{2} + y^{2}\]`,
  '',
  R`Broken formula: $$\frac{1$$`,
  '',
  'Shell block:',
  '',
  '```sh',
  'cost=$100',
  'echo $PATH',
  '```',
  '',
  'Inline code `echo $HOME` must stay literal.',
  '',
  // 取自 dist 里真实的 Deep Research 样例报告原句——同段落里三个金额。
  'Prose money: Form Energy is valued between $3.5B and $4.8B [18]; Base Power at $13 billion post-money.',
].join('\n');

const THINKING_MD = R`Checking the identity $a^2+b^2=c^2$ before answering.`;
const SUMMARY_MD = R`Done. Result: $$\frac{n(n+1)}{2}$$`;

async function seedMathSession(page) {
  return page.evaluate(({ content, thinking, summary }) => new Promise((resolve, reject) => {
    const req = indexedDB.open('pie');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(['sessions', 'session_index'], 'readwrite');
      const sessions = tx.objectStore('sessions');
      const indexStore = tx.objectStore('session_index');
      const now = Date.now();
      const id = crypto.randomUUID();
      const messages = [
        { role: 'user', content: 'Show me some math.' },
        { role: 'assistant', content, thinking },
        { role: 'agent-summary', success: true, summary, stepCount: 2 },
      ];
      const g = indexStore.get('index');
      g.onsuccess = () => {
        const index = Array.isArray(g.result?.value) ? g.result.value.slice() : [];
        const meta = {
          id, createdAt: now, lastAccessedAt: now, status: 'active',
          title: 'Math Fixture', messages, pinMode: 'auto',
        };
        sessions.put({ id: `${id}:meta`, value: meta });
        sessions.put({ id: `${id}:agent`, value: { agentMessages: [], pendingInstructions: [], stepIndex: 0, hasImageContent: false } });
        index.push({ id, lastAccessedAt: now, status: 'active', title: 'Math Fixture', messageCount: messages.length });
        indexStore.put({ id: 'index', value: index });
        tx.oncomplete = () => { db.close(); resolve(id); };
        tx.onerror = () => reject(tx.error);
      };
      g.onerror = () => reject(g.error);
    };
  }), { content: ASSISTANT_MD, thinking: THINKING_MD, summary: SUMMARY_MD });
}

/** ResearchDetail 的样例报告是 build 期 inline 进 bundle 的字符串；为验这个消费方，
 *  在 dist-pilot 的那份副本里注入一条公式（fixture 注入，不改产品源码）。 */
function patchSampleMath(dist) {
  const anchor = '## What are the current frontier-model licensing thresholds';
  const file = fs.readdirSync(`${dist}/assets`).find((f) => /^index\.html-.*\.js$/.test(f));
  if (!file) return { ok: false, why: 'panel bundle 未找到' };
  const p = `${dist}/assets/${file}`;
  const src = fs.readFileSync(p, 'utf8');
  if (src.split(anchor).length - 1 !== 1) return { ok: false, why: 'anchor 不唯一' };
  // bundle 里样例正文是模板字面量，写进去的 `\f` 会被 JS 当换页符 → 必须落两个反斜杠字节。
  const injected = `$$\\\\frac{P_{1}}{P_{2}} = 10^{26}$$\n\n${anchor}`;
  fs.writeFileSync(p, src.replace(anchor, injected));
  return { ok: true, file };
}

// ───────────────────────── 页内测量工具 ─────────────────────────
const PROBES = `
  window.__m = {
    // 只认 .katex-html（可视部分）；.katex-mathml 是给读屏的隐藏副本，取它的 rect 全是 0。
    leaves(root) {
      return [...root.querySelectorAll('.katex-html span')]
        .filter((s) => s.children.length === 0 && s.textContent.trim());
    },
    byTex(tex, scope) {
      const norm = (s) => (s || '').replace(/\\s+/g, '');
      return [...(scope || document).querySelectorAll('.katex')]
        .find((k) => norm(k.querySelector('annotation')?.textContent) === norm(tex)) || null;
    },
    leafRect(root, text) {
      const el = this.leaves(root).find((s) => s.textContent.trim() === text);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { text, top: r.top, bottom: r.bottom, left: r.left, right: r.right, h: r.height };
    },
    lum(rgb) {
      const [r, g, b] = rgb.map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    },
    parseRgb(s) { return (s.match(/\\d+(\\.\\d+)?/g) || []).slice(0, 3).map(Number); },
    contrast(fg, bg) {
      const a = this.lum(this.parseRgb(fg)), b = this.lum(this.parseRgb(bg));
      const [hi, lo] = a > b ? [a, b] : [b, a];
      return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
    },
    effectiveBg(el) {
      for (let n = el; n; n = n.parentElement) {
        const c = getComputedStyle(n).backgroundColor;
        if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c;
      }
      return getComputedStyle(document.body).backgroundColor;
    },
  };
`;

async function openFixtureSession(page) {
  for (let i = 0; i < 5; i++) {
    if (await page.getByTestId('topbar-drawer').count()) break;
    if (await page.getByTestId('topbar-back').count()) await page.getByTestId('topbar-back').click();
    await sleep(400);
  }
  await page.getByTestId('topbar-drawer').click();
  const drawer = page.getByRole('dialog', { name: 'Sessions' });
  await drawer.waitFor();
  await drawer.getByText('Math Fixture', { exact: true }).first().click();
  await sleep(700);
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(400);
}

const run = async () => {
  fs.mkdirSync(REPORT, { recursive: true });
  prepareWorkspace(BASE);
  const patch = patchSampleMath(`${BASE}/dist-pilot`);
  console.log(`  [fixture] sample math patch: ${JSON.stringify(patch)}`);

  const { ctx, page, sw, extId } = await launch(BASE, { profile: 'profile-448', dist: `${BASE}/dist-pilot` });
  // 全程记录网络：KaTeX 必须全本地（MV3 CSP + 离线），任何对外 font/css 请求都是回归。
  const net = [];
  ctx.on('request', (r) => { const u = r.url(); if (/^https?:/.test(u)) net.push(`${r.resourceType()} ${u}`); });
  console.log(`  [launch] extId=${extId} dist=dist-pilot`);
  await sleep(3000); // startup migration pipeline

  // Chat 在没有任何 instance 时只渲染 "NO API KEY" 空态（消息列表不挂载）→ 必须 seed 一个
  // instance 才能看到渲染。本批不发任何请求，key 是占位串。三处 seed 坑见 auto-acceptance.md。
  for (let i = 0; i < 20; i++) {
    if (await sw.evaluate(() => typeof globalThis.__pieEval !== 'undefined')) break;
    await sleep(250);
  }
  const { instanceId } = await sw.evaluate(
    (cfg) => globalThis.__pieEval.seedConfig(cfg),
    { provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'sk-fixture-never-sent' },
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
  }), { instanceId, model: 'deepseek-v4-flash' });

  const sid = await seedMathSession(page);
  await page.reload();
  await sleep(1200);
  await page.addInitScript(PROBES);

  // 进 Chat 并打开 fixture 会话
  for (let i = 0; i < 4; i++) {
    if (await page.getByTestId('chat-composer').count()) break;
    if (await page.getByTestId('topbar-back').count()) { await page.getByTestId('topbar-back').click(); await sleep(300); continue; }
    if (await page.getByTestId('chat-open-settings').count()) break;
    await sleep(300);
  }
  await openFixtureSession(page);
  await page.evaluate(PROBES);
  await snap(page, 'chat-math');
  console.log(`  [fixture] session ${sid.slice(0, 8)} opened`);

  const katexCount = await page.evaluate(() => document.querySelectorAll('.katex').length);
  if (!katexCount) {
    rec('A0', 'ERROR', '面板里一个 .katex 都没有——会话没打开或渲染未发生，后续断言无意义');
    await snap(page, 'err-A0');
  } else {
    rec('A0', 'PASS', `fixture 会话已渲染，.katex × ${katexCount}`);
  }

  // ── A1 公式竖直定位（本轮修的就是它）────────────────────────────────
  await item(page, 'A1', async () => {
    const geo = await page.evaluate(() => {
      const m = window.__m;
      const baseEl = document.querySelector('.katex .base');
      const strutEl = document.querySelector('.katex .strut');
      const bs = baseEl && getComputedStyle(baseEl);
      const sup = m.byTex('E=mc^2');
      const frac = m.byTex(String.raw`\frac{a+b}{c}`);
      const integ = m.byTex(String.raw`\int_0^\infty e^{-x}\,dx = 1`);
      const out = {
        baseStyle: bs ? { display: bs.display, position: bs.position, whiteSpace: bs.whiteSpace, width: bs.width } : null,
        strutDisplay: strutEl ? getComputedStyle(strutEl).display : null,
      };
      if (sup) { out.supC = m.leafRect(sup, 'c'); out.sup2 = m.leafRect(sup, '2'); }
      if (frac) {
        out.fracA = m.leafRect(frac, 'a');
        out.fracC = m.leafRect(frac, 'c');
        const box = frac.querySelector('.mfrac') || frac;
        out.fracH = box.getBoundingClientRect().height;
        out.fracLine = !!frac.querySelector('.frac-line');
      }
      if (integ) { out.lo = m.leafRect(integ, '0'); out.hi = m.leafRect(integ, '∞'); }
      return out;
    });
    const s = geo.baseStyle;
    const cssOk = !!s && s.display === 'inline-block' && s.position === 'relative' && s.whiteSpace === 'nowrap'
      && geo.strutDisplay === 'inline-block';
    const supOk = !!geo.sup2 && !!geo.supC && geo.sup2.bottom < geo.supC.bottom - 1 && geo.sup2.top < geo.supC.top - 1;
    // 分子整体在分母之上 + 两者纵向跨度约两行字（塌成一行时跨度会掉到一行）+ 分数线存在。
    // 注：`.mfrac` 自身的 rect 高度不作判据——A1-ctrl 实测它对这组 CSS 规则不敏感（恒 16.0）。
    const fracSpan = geo.fracA && geo.fracC ? geo.fracC.bottom - geo.fracA.top : null;
    const fracOk = !!geo.fracA && !!geo.fracC && geo.fracA.bottom <= geo.fracC.top + 1
      && fracSpan > geo.fracA.h * 1.8 && geo.fracLine;
    const intOk = !!geo.hi && !!geo.lo && geo.hi.bottom <= geo.lo.top + 1;
    const ok = cssOk && supOk && fracOk && intOk;
    rec('A1', ok ? 'PASS' : 'FAIL',
      `.base{${s ? `${s.display}/${s.position}/${s.whiteSpace}/${s.width}` : 'null'}} .strut{${geo.strutDisplay}} | `
      + `sup: '2'.bottom=${geo.sup2?.bottom?.toFixed(1)} < 'c'.bottom=${geo.supC?.bottom?.toFixed(1)} → ${supOk} | `
      + `frac: 'a'.bottom=${geo.fracA?.bottom?.toFixed(1)} <= 'c'.top=${geo.fracC?.top?.toFixed(1)} `
      + `分子分母纵向跨度=${fracSpan?.toFixed(1)} vs 单字高=${geo.fracA?.h?.toFixed(1)} 分数线=${geo.fracLine} → ${fracOk} | `
      + `int: '∞'.bottom=${geo.hi?.bottom?.toFixed(1)} <= '0'.top=${geo.lo?.top?.toFixed(1)} → ${intOk}`);

  });

  // ── A2 字体真加载 + 零对外请求 ────────────────────────────────────
  await item(page, 'A2', async () => {
    const f = await page.evaluate(async () => {
      const m = window.__m;
      await document.fonts.ready;
      const faces = [...document.fonts].filter((x) => x.family.includes('KaTeX')).map((x) => `${x.family}:${x.status}`);
      const sup = m.byTex('E=mc^2');
      const leaf = sup && m.leaves(sup).find((s) => s.textContent.trim() === 'c');
      return {
        checkMath: document.fonts.check('16px "KaTeX_Math"'),
        checkMain: document.fonts.check('16px "KaTeX_Main"'),
        faces,
        leafFamily: leaf ? getComputedStyle(leaf).fontFamily : null,
        leafStyle: leaf ? getComputedStyle(leaf).fontStyle : null,
      };
    });
    const external = net.filter((u) => !u.includes('chrome-extension://'));
    const katexExternal = external.filter((u) => /katex/i.test(u));
    const ok = f.checkMath && f.checkMain && /KaTeX_Math/.test(f.leafFamily || '') && katexExternal.length === 0;
    rec('A2', ok ? 'PASS' : 'FAIL',
      `fonts.check(KaTeX_Math)=${f.checkMath} KaTeX_Main=${f.checkMain} loaded=[${f.faces.slice(0, 4).join(', ')}…共${f.faces.length}] `
      + `'c' 字形 font-family=${f.leafFamily} style=${f.leafStyle} | KaTeX 相关对外请求 ${katexExternal.length} 条 `
      + `| 其它对外请求 ${external.length} 条（${[...new Set(external.map((u) => new URL(u.split(' ')[1]).host))].join(',') || '无'}，main 上 index.html 已有的 Google Fonts，非本 PR）`);
  });

  // ── A3 窄栏横滚 ───────────────────────────────────────────────────
  await item(page, 'A3', async () => {
    const o = await page.evaluate(() => {
      const wide = [...document.querySelectorAll('.katex-display')]
        .map((d) => ({ d, over: d.scrollWidth - d.clientWidth }))
        .sort((x, y) => y.over - x.over)[0];
      if (!wide) return null;
      const el = wide.d;
      const cs = getComputedStyle(el);
      el.scrollLeft = 9999;
      const scrolled = el.scrollLeft;
      el.scrollLeft = 0;
      return {
        overflowX: cs.overflowX, overflowY: cs.overflowY,
        scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrolled,
        innerWidth: window.innerWidth,
        docScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
      };
    });
    const ok = !!o && o.overflowX === 'auto' && o.scrollWidth > o.clientWidth && o.scrolled > 0
      && o.clientWidth <= o.innerWidth && o.docScrollWidth <= o.innerWidth + 1;
    rec('A3', ok ? 'PASS' : 'FAIL',
      `视口 ${o?.innerWidth}px：.katex-display overflow-x=${o?.overflowX} scrollWidth=${o?.scrollWidth} clientWidth=${o?.clientWidth} `
      + `scrollLeft(拉到底)=${o?.scrolled} | 页面 documentElement.scrollWidth=${o?.docScrollWidth}（≤视口即未撑破）`);
  });

  // ── A4 大小配比 ───────────────────────────────────────────────────
  await item(page, 'A4', async () => {
    const o = await page.evaluate(() => {
      const k = document.querySelector('.katex');
      if (!k) return null;
      const parentBox = k.closest('p, div');
      return {
        katex: getComputedStyle(k).fontSize,
        parent: getComputedStyle(parentBox).fontSize,
        body: getComputedStyle(document.body).fontSize,
      };
    });
    if (!o) { rec('A4', 'FAIL', '页面里没有 .katex'); return; }
    const ratio = parseFloat(o.katex) / parseFloat(o.parent);
    const ok = Math.abs(ratio - 1.05) < 0.02;
    rec('A4', ok ? 'PASS' : 'FAIL',
      `.katex ${o.katex} / 正文 ${o.parent} = ${ratio.toFixed(3)}（期望 1.05；KaTeX 默认 1.21 已被下调）body=${o.body}`);
  });

  // ── A5 四个消费方（Chat / 思考区 / 总结区 此处，Research 在 A6）──────
  await item(page, 'A5a', async () => {
    const o = await page.evaluate(() => {
      const m = window.__m;
      const hit = (tex) => { const k = m.byTex(tex); return k ? { ok: true, fs: getComputedStyle(k).fontSize, base: !!k.querySelector('.base') } : { ok: false }; };
      return {
        chat: hit('E=mc^2'),
        summary: hit(String.raw`\frac{n(n+1)}{2}`),
        thinkingRaw: hit('a^2+b^2=c^2'),
      };
    });
    rec('A5a-chat', o.chat.ok ? 'PASS' : 'FAIL', `Chat 助手消息：.katex 存在=${o.chat.ok} font-size=${o.chat.fs} .base=${o.chat.base}`);
    rec('A5a-summary', o.summary.ok ? 'PASS' : 'FAIL', `总结区（AgentSummary）：.katex 存在=${o.summary.ok} font-size=${o.summary.fs} .base=${o.summary.base}`);
    // 思考区默认折叠，展开后再看
    let think = o.thinkingRaw;
    if (!think.ok) {
      const toggle = page.getByRole('button', { name: /Thinking|Thought/i }).first();
      if (await toggle.count()) { await toggle.click(); await sleep(400); }
      think = await page.evaluate(() => {
        const k = window.__m.byTex('a^2+b^2=c^2');
        return k ? { ok: true, fs: getComputedStyle(k).fontSize, base: !!k.querySelector('.base') } : { ok: false };
      });
    }
    rec('A5a-thinking', think.ok ? 'PASS' : 'FAIL', `思考区（ThinkingSection，需展开）：.katex 存在=${think.ok} font-size=${think.fs} .base=${think.base}`);
    await snap(page, 'A5a-thinking');
  });

  // ── A8 代码块 / 行内 code 里的 $ 原样 ─────────────────────────────
  await item(page, 'A8', async () => {
    const o = await page.evaluate(() => {
      const pre = [...document.querySelectorAll('pre')].find((p) => p.textContent.includes('cost='));
      const codes = [...document.querySelectorAll('code')].map((c) => c.textContent.trim());
      return {
        preText: pre ? pre.textContent.replace(/\s+/g, ' ').trim() : null,
        katexInPre: pre ? pre.querySelectorAll('.katex').length : -1,
        inlineHome: codes.find((c) => c.includes('$HOME')) ?? null,
        katexInCode: [...document.querySelectorAll('code')].reduce((n, c) => n + c.querySelectorAll('.katex').length, 0),
      };
    });
    const ok = !!o.preText && o.preText.includes('cost=$100') && o.preText.includes('echo $PATH')
      && o.katexInPre === 0 && o.inlineHome === 'echo $HOME' && o.katexInCode === 0;
    rec('A8', ok ? 'PASS' : 'FAIL',
      `fenced pre = "${o.preText}"（.katex×${o.katexInPre}）| 行内 code = "${o.inlineHome}" | code 内 .katex 总数=${o.katexInCode}`);
  });

  // ── A10 散文里的金额是否被误当公式（真实样例报告原句）─────────────
  await item(page, 'A10', async () => {
    const o = await page.evaluate(() => {
      const p = [...document.querySelectorAll('p')].find((x) => x.textContent.includes('Form Energy'));
      if (!p) return null;
      return {
        text: p.textContent.replace(/\s+/g, ' ').trim(),
        katex: p.querySelectorAll('.katex').length,
        tex: [...p.querySelectorAll('annotation')].map((a) => a.textContent),
      };
    });
    const ok = !!o && o.katex === 0;
    rec('A10', ok ? 'PASS' : 'FAIL',
      `散文段落 .katex × ${o?.katex}${o?.katex ? ` → 被当公式的片段: ${JSON.stringify(o.tex)}` : ''} | 渲染文本: "${(o?.text || '').slice(0, 160)}"`);
    await snap(page, 'A10-prose-money');
  });

  // ── A6 Deep Research 报告详情页（第四个消费方）+ 样例报告里的金额 ───
  await item(page, 'A6', async () => {
    await page.getByTestId('topbar-research').click();
    await page.getByTestId('research-page').waitFor();
    await sleep(600);
    const hasSamples = await page.getByTestId('research-samples').count();
    if (!hasSamples) { rec('A5b-research', 'SKIP', '当前账号已解锁 Research（无 paywall 样例入口），未验此消费方'); return; }
    await page.getByTestId('research-sample-ai-regulation').click();
    await page.getByTestId('research-report').waitFor();
    await sleep(800);
    await page.evaluate(PROBES);
    const o = await page.evaluate(() => {
      const box = document.querySelector('[data-testid="research-report"]');
      const k = box.querySelector('.katex');
      const base = box.querySelector('.katex .base');
      return {
        count: box.querySelectorAll('.katex').length,
        tex: [...box.querySelectorAll('annotation')].map((a) => a.textContent).slice(0, 5),
        fs: k ? getComputedStyle(k).fontSize : null,
        parentFs: k ? getComputedStyle(k.closest('p, div')).fontSize : null,
        baseDisplay: base ? getComputedStyle(base).display : null,
        clipped: k ? k.getBoundingClientRect().right > window.innerWidth : null,
        // 注入的公式若没被解析成 math，源码会原样出现在正文里
        rawInjected: box.innerText.includes('P_{1}') ? box.innerText.slice(Math.max(0, box.innerText.indexOf('P_{1}') - 60), box.innerText.indexOf('P_{1}') + 60) : null,
        dollarsInText: (box.innerText.match(/\$/g) || []).length,
      };
    });
    const injectedOk = o.tex.some((t) => t.includes('P_{1}'));
    const ok = o.count > 0 && o.baseDisplay === 'inline-block' && injectedOk;
    rec('A5b-research', ok ? 'PASS' : 'FAIL',
      `Deep Research 报告详情页（注入的公式）：.katex × ${o.count} tex=${JSON.stringify(o.tex)} font-size=${o.fs}/正文${o.parentFs} .base display=${o.baseDisplay}`
      + ` | 注入源码是否原样漏出=${JSON.stringify(o.rawInjected)} 正文剩余 $ 符号数=${o.dollarsInText}`);
    await snap(page, 'A5b-research');

    // 样例报告正文里真实存在的 "$3.5B and $4.8B" 等金额
    const money = await page.evaluate(() => {
      const box = document.querySelector('[data-testid="research-report"]');
      const texts = [...box.querySelectorAll('annotation')].map((a) => a.textContent);
      return { all: texts, bogus: texts.filter((t) => !t.includes('P_{1}')) };
    });
    rec('A10-research', money.bogus.length === 0 ? 'PASS' : 'FAIL',
      `线上样例报告（ai-regulation）里被误当公式的散文片段 ${money.bogus.length} 处：${JSON.stringify(money.bogus.slice(0, 4))}`);
  });

  // ── A7 深色模式 ───────────────────────────────────────────────────
  await item(page, 'A7', async () => {
    await page.evaluate(() => localStorage.setItem('theme-mode', 'dark'));
    await page.reload();
    await sleep(1500);
    await page.evaluate(PROBES);
    await openFixtureSession(page); // reload 后要重新打开，否则量的是空会话
    await page.evaluate(PROBES);
    const o = await page.evaluate(() => {
      const m = window.__m;
      const k = m.byTex('E=mc^2');
      const para = k && k.closest('p, div');
      const err = document.querySelector('.katex-error');
      return {
        dark: document.documentElement.className + '|' + document.documentElement.dataset.theme,
        mathColor: k ? getComputedStyle(k).color : null,
        textColor: para ? getComputedStyle(para).color : null,
        errColor: err ? getComputedStyle(err).color : null,
        errBg: err ? m.effectiveBg(err) : null,
        errContrast: err ? m.contrast(getComputedStyle(err).color, m.effectiveBg(err)) : null,
        errWrap: err ? getComputedStyle(err).whiteSpace : null,
        errOverflowsPanel: err ? err.getBoundingClientRect().right > window.innerWidth : null,
        errText: err ? err.textContent.slice(0, 40) : null,
      };
    });
    const follows = !!o.mathColor && o.mathColor === o.textColor;
    rec('A7', follows ? 'PASS' : 'FAIL',
      `深色（root=${o.dark}）：.katex color=${o.mathColor} vs 正文 color=${o.textColor} → 跟随=${follows}`);
    rec('A7-err', o.errColor ? 'PASS' : 'FAIL',
      `.katex-error color=${o.errColor} bg=${o.errBg} 对比度=${o.errContrast}:1（WCAG AA 正文需 4.5:1）`
      + ` white-space=${o.errWrap} 溢出面板=${o.errOverflowsPanel} text="${o.errText}"`);
    await snap(page, 'A7-dark');
  });

  // ── A1-ctrl 敏感度对照（放最后，会破坏页面样式）────────────────────
  await item(page, 'A1-ctrl', async () => {
    const o = await page.evaluate(() => {
      const m = window.__m;
      const before = (() => {
        const f = m.byTex(String.raw`\frac{a+b}{c}`);
        const a = f && m.leafRect(f, 'a'), c = f && m.leafRect(f, 'c');
        return { stacked: !!a && !!c && a.bottom <= c.top + 1, h: a && c ? c.bottom - a.top : null };
      })();
      // 删掉所有「.katex 后代里用到非 katex- 前缀类名」的规则 —— 这正是 0.18 CSS 配
      // 0.16 JS 时的效果（21 个结构类改名，选择器全不匹配）。
      const deleted = [];
      for (const sheet of [...document.styleSheets]) {
        let rules; try { rules = sheet.cssRules; } catch { continue; }
        for (let i = rules.length - 1; i >= 0; i--) {
          const sel = rules[i].selectorText;
          if (!sel || !sel.includes('katex')) continue;
          const cls = sel.match(/\.[a-zA-Z0-9_-]+/g) || [];
          if (cls.some((c) => !c.startsWith('.katex'))) { deleted.push(sel); sheet.deleteRule(i); }
        }
      }
      const f = m.byTex(String.raw`\frac{a+b}{c}`);
      const a = f && m.leafRect(f, 'a'), c = f && m.leafRect(f, 'c');
      const baseEl = document.querySelector('.katex .base');
      return {
        deleted: deleted.length,
        before,
        afterStacked: !!a && !!c && a.bottom <= c.top + 1,
        afterH: a && c ? c.bottom - a.top : null,
        afterBaseDisplay: baseEl ? getComputedStyle(baseEl).display : null,
      };
    });
    const flipped = o.before.stacked === true && (o.afterStacked === false || (o.afterH != null && o.afterH < o.before.h * 0.7));
    rec('A1-ctrl', flipped ? 'PASS' : 'FAIL',
      `删掉 ${o.deleted} 条「.katex 后代用非 katex- 前缀类」的规则（= 第 1 轮那份错配产物）后：`
      + `堆叠 ${o.before.stacked}→${o.afterStacked}，分子分母纵向跨度 ${o.before.h?.toFixed(1)}→${o.afterH?.toFixed(1)}，`
      + `.base display=${o.afterBaseDisplay} ⇒ A1 的几何断言确实由这组规则决定`);
    await snap(page, 'A1-ctrl-neutralized');
  });

  fs.writeFileSync(`${REPORT}/results-448-functional.json`, JSON.stringify({ head: process.env.PIE_HEAD || '', net: net.filter((u) => !u.includes('chrome-extension://')), results }, null, 2));
  await ctx.close();
  const bad = results.filter((r) => r.status === 'FAIL' || r.status === 'ERROR');
  console.log(`\n=== 功能批完成：${results.length} 条，FAIL/ERROR ${bad.length} 条 ===`);
  for (const b of bad) console.log(`  ${b.status} ${b.id}: ${b.note}`);
};

run().catch((e) => { console.error('FATAL', e); process.exit(1); });
