// PR #456（#455 界面缩放滑杆）真机验收 — 功能批。
// 环境搭建 / 配方坑见 docs/agents/auto-acceptance.md。纯侧栏前端 PR：不触 daemon / agent loop
// → 不起 scratch daemon、用 dist-orig（未提 NM 权限）、无 LLM 批。
//
// 清单（Review 给的 5 条）：
//   1. 拖动滑杆：实时缩放、数值不乱跑、松手才落盘；重开侧栏 / 重启浏览器后值保持，首帧无跳变
//   2. 70%/150%：ModelPicker、TopBar pin 下拉、CDP「?」help 弹层贴着触发元素；侧栏高度 = 窗口高度
//   3. 70%/150% × 深浅色 × 中英文：对话区/工具卡/composer/设置根页及子页无横向溢出、不重叠
//   4. 100% 下与 main 外观一致（设置页各行高度和对齐）
//   5. 人拍板：150% 下 ModelPicker 单行省略号（截图 + 是否真省略了的证据）
//
// 对照：clean main 的 dist-eval（/tmp/pie456/main-src 重 build）
//   - CTRL-A：main 上手动 html.style.zoom=1.5 → 高度 / 弹层断言必须 FAIL（证明断言测得到东西）
//   - 4 的行几何直接 PR@100% vs main 逐行比
import { chromium } from 'playwright';
import fs from 'node:fs';
import { prepareWorkspace, sleep, REPO, idbConfigGet, startFixtureServer } from './release-smoke/lib.mjs';

const BASE = process.env.PIE_ACCEPT_BASE;
if (!BASE) throw new Error('PIE_ACCEPT_BASE 未设置');
const REPORT = `${BASE}/report`;
fs.mkdirSync(REPORT, { recursive: true });
const MAIN_DIST = `${BASE}/main-src/dist-eval`;

const results = [];
let shot = 0;
function record(item, status, note = '') {
  results.push({ item, status, note });
  console.log(`[${status}] ${item}${note ? ' — ' + note : ''}`);
}
async function snap(page, name) {
  shot += 1;
  const p = `${REPORT}/pr456-${String(shot).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: p });
  return p.split('/').pop();
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const r1 = (n) => Math.round(n * 10) / 10;

// ── 首帧探针：记录 html 上 zoom 首次出现 vs #root 首次挂载的先后 ─────────
const FIRST_FRAME_PROBE = `(() => {
  const rec = { zoomAt: null, zoomVal: null, rootAt: null };
  const mo = new MutationObserver(() => {
    const de = document.documentElement;
    if (rec.zoomAt == null && de && de.style && de.style.zoom) { rec.zoomAt = performance.now(); rec.zoomVal = de.style.zoom; }
    const root = document.getElementById('root');
    if (rec.rootAt == null && root && root.firstElementChild) rec.rootAt = performance.now();
    if (rec.zoomAt != null && rec.rootAt != null) mo.disconnect();
  });
  mo.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] });
  window.__ff = rec;
})()`;

async function launch({ profile, dist, initScript }) {
  const profileDir = `${BASE}/${profile}`;
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 420, height: 900 },
    locale: 'en-US',
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--lang=en-US'],
  });
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const extId = new URL(sw.url()).host;
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  if (initScript) await page.addInitScript(initScript);
  await page.goto(`chrome-extension://${extId}/src/sidepanel/index.html`);
  return { ctx, page, sw, extId };
}

// seed 三坑见 auto-acceptance.md：等 pipeline 落定 → seedConfig → 补 instances_index + last_model_selection
async function seedInstance(sw) {
  await sleep(3000);
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
  return instanceId;
}

// 带工具卡 + 长 markdown + user pin 的 fixture 会话（pin 行才会出现在 TopBar）
async function seedSession(page, { tabId, origin }) {
  return page.evaluate(({ tabId, origin }) => new Promise((resolve, reject) => {
    const req = indexedDB.open('pie');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(['sessions', 'session_index'], 'readwrite');
      const sessions = tx.objectStore('sessions');
      const indexStore = tx.objectStore('session_index');
      const now = Date.now();
      const id = crypto.randomUUID();
      const longObs = 'Observation line with a fairly long unbroken-ish sentence that should wrap inside the tool card at any interface scale. '.repeat(4);
      const messages = [
        { role: 'user', content: 'Scale fixture: read the page, click the first link, then summarise. 这是一段中文用户消息，用来看换行。' },
        { role: 'agent-step', stepIndex: 0, tool: 'read_page', args: { tabId }, status: 'ok', observation: longObs },
        { role: 'agent-step', stepIndex: 1, tool: 'click', args: { idx: 3, frameId: 0, reason: 'first link' }, status: 'ok', observation: 'clicked' },
        { role: 'agent-step', stepIndex: 2, tool: 'type', args: { idx: 7, text: 'hello world' }, status: 'error', observation: 'element not found' },
        { role: 'assistant', content: '## Summary\n\nParagraph one with **bold** and `inline code` and a [link](https://example.com).\n\n```ts\nconst x = computePopoverCoords(rect, vp.w, vp.h); // a long code line to check horizontal scroll inside code blocks\n```\n\n- bullet one\n- bullet two\n\n| col a | col b | col c |\n|---|---|---|\n| 1 | 2 | 3 |' },
        { role: 'agent-summary', success: true, summary: 'Done. Read the page and clicked the first link.', stepCount: 3 },
      ];
      const g = indexStore.get('index');
      g.onsuccess = () => {
        const index = Array.isArray(g.result?.value) ? g.result.value.slice() : [];
        const meta = {
          id, createdAt: now, lastAccessedAt: now, status: 'active', title: 'Scale Fixture', messages,
          pinMode: 'user', pinnedTabs: [{ tabId, origin }],
        };
        sessions.put({ id: `${id}:meta`, value: meta });
        sessions.put({ id: `${id}:agent`, value: { agentMessages: [], pendingInstructions: [], stepIndex: 0, hasImageContent: false } });
        index.push({ id, lastAccessedAt: now, status: 'active', title: 'Scale Fixture', messageCount: messages.length });
        indexStore.put({ id: 'index', value: index });
        tx.oncomplete = () => { db.close(); resolve(id); };
        tx.onerror = () => reject(tx.error);
      };
      g.onerror = () => reject(g.error);
    };
  }), { tabId, origin });
}

async function goChat(page) {
  for (let i = 0; i < 5; i++) {
    if (await page.getByTestId('chat-composer').count()) return;
    if (await page.getByTestId('topbar-back').count()) { await page.getByTestId('topbar-back').click(); await sleep(300); continue; }
    await sleep(300);
  }
}
async function openFixtureSession(page) {
  await goChat(page);
  if (await page.getByText('Scale Fixture', { exact: true }).count() && await page.locator('[role=dialog]').count() === 0) {
    // already the active session? (title shows in top bar)
  }
  await page.getByTestId('topbar-drawer').click();
  await sleep(300);
  const item = page.locator('[role=dialog]').getByText('Scale Fixture', { exact: true }).first();
  await item.waitFor();
  await item.click();
  await sleep(600);
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(300);
}
async function goSettingsRoot(page) {
  for (let i = 0; i < 6; i++) {
    if (await page.getByTestId('ui-scale-slider').count() || await page.getByTestId('settings-row-models').count()) return;
    if (await page.getByTestId('topbar-back').count()) { await page.getByTestId('topbar-back').click(); await sleep(300); continue; }
    if (await page.getByTestId('chat-open-settings').count()) { await page.getByTestId('chat-open-settings').click(); await sleep(300); continue; }
    if (await page.getByTestId('topbar-drawer').count()) {
      await page.getByTestId('topbar-drawer').click(); await sleep(250);
      await page.getByTestId('drawer-settings').click(); await sleep(300); continue;
    }
    await sleep(300);
  }
}

// 通过滑杆本身把缩放设到 pct（input=实时预览、change=落盘），与用户操作同一条路径
async function setScaleViaSlider(page, pct) {
  await goSettingsRoot(page);
  await page.getByTestId('ui-scale-slider').evaluate((el, v) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, pct);
  await sleep(200);
}
async function setTheme(page, mode) {
  await goSettingsRoot(page);
  await page.getByTestId(`theme-${mode}`).click();
  await sleep(200);
}
async function setLocale(page, locale) {
  await page.evaluate((loc) => new Promise((resolve, reject) => {
    const req = indexedDB.open('pie');
    req.onsuccess = () => {
      const tx = req.result.transaction('config', 'readwrite');
      tx.objectStore('config').put({ key: 'ui_locale', value: loc });
      tx.oncomplete = () => resolve(null);
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  }), locale);
  await page.reload();
  await sleep(1500);
}

// ── 几何探针 ────────────────────────────────────────────────────────────
const zoomOf = (page) => page.evaluate(() => parseFloat(document.documentElement.style.zoom || '1'));
const rectOf = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height };
}, sel);

async function heightProbe(page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const app = document.querySelector('#root > div');
    const r = app ? app.getBoundingClientRect() : null;
    return {
      zoom: de.style.zoom || '1', innerH: innerHeight, innerW: innerWidth,
      appH: r ? r.height : null, appB: r ? r.bottom : null, appW: r ? r.width : null,
      // 注意单位：zoom 作用在 <html> 上，body.* 是 body 自己的（已缩放）CSS px，只能和 body.clientHeight 比
      docScrollH: de.scrollHeight, docClientH: de.clientHeight, bodyScrollH: document.body.scrollHeight, bodyClientH: document.body.clientHeight,
      docScrollW: de.scrollWidth, docClientW: de.clientWidth,
    };
  });
}
// 侧栏高度 = 窗口高度：App 根容器视觉高度≈innerHeight，且文档无纵向滚动
function judgeHeight(h) {
  const ok = h.appH != null && near(h.appH, h.innerH, 1.5) && h.docScrollH <= h.docClientH + 1 && h.bodyScrollH <= h.bodyClientH + 1;
  return { ok, note: `zoom=${h.zoom} app.h=${r1(h.appH)} vs innerHeight=${h.innerH}；html.scrollH=${h.docScrollH}/clientH=${h.docClientH} body.scrollH=${h.bodyScrollH}/clientH=${h.bodyClientH}` };
}

// 横向溢出 + 行内重叠
async function overflowProbe(page) {
  return page.evaluate(() => {
    const vw = innerWidth;
    const de = document.documentElement;
    const clippedByAncestor = (el) => {
      let p = el.parentElement;
      while (p && p !== document.body) {
        const cs = getComputedStyle(p);
        if (cs.overflowX !== 'visible' && cs.overflowX !== '') {
          const pr = p.getBoundingClientRect();
          if (pr.right <= vw + 1 && pr.left >= -1) return true;
        }
        p = p.parentElement;
      }
      return false;
    };
    const desc = (el) => `<${el.tagName.toLowerCase()}${el.dataset.testid ? ` testid=${el.dataset.testid}` : ''}${el.className && typeof el.className === 'string' ? ` .${el.className.split(' ').slice(0, 3).join('.')}` : ''}>`;
    const offenders = [];
    for (const el of document.body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) continue;
      if (cs.position === 'fixed' && (r.right <= 0 || r.left >= vw)) continue; // off-screen helpers
      if (r.right > vw + 1 || r.left < -1) {
        if (!clippedByAncestor(el)) offenders.push(`${desc(el)} l=${Math.round(r.left)} r=${Math.round(r.right)}`);
      }
      if (offenders.length >= 8) break;
    }
    // 设置行内重叠：ControlRow / NavRow 的直接子元素两两不相交；UiScaleRow 头行同理
    const overlaps = [];
    const rows = [...document.querySelectorAll('[class*="min-h-[46px]"], [data-testid^="settings-row-"], [data-testid="ui-scale-value"]')];
    const rowEls = rows.map((r) => (r.dataset.testid === 'ui-scale-value' ? r.parentElement : r));
    for (const row of rowEls) {
      const kids = [...row.children].map((k) => ({ k, r: k.getBoundingClientRect() })).filter(({ r }) => r.width > 0 && r.height > 0);
      for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
        const a = kids[i].r, b = kids[j].r;
        const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ix > 1 && iy > 1) overlaps.push(`${desc(row)}: ${desc(kids[i].k)} × ${desc(kids[j].k)} (${Math.round(ix)}×${Math.round(iy)}px)`);
      }
    }
    // composer 底栏：model-picker 与发送键不相交且都在视口内
    const mp = document.querySelector('[data-testid=model-picker]');
    const send = document.querySelector('[data-testid=chat-send]');
    if (mp && send) {
      const a = mp.getBoundingClientRect(), b = send.getBoundingClientRect();
      const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ix > 1 && iy > 1) overlaps.push(`composer: model-picker × chat-send (${Math.round(ix)}×${Math.round(iy)}px)`);
      if (b.right > vw + 1 || a.left < -1) overlaps.push(`composer: model-picker/send 出视口 (mp.l=${Math.round(a.left)} send.r=${Math.round(b.right)} vw=${vw})`);
    }
    return { docOverflowX: de.scrollWidth - de.clientWidth, offenders, overlaps, rows: rowEls.length };
  });
}

// 弹层贴锚：popover 在视口内；水平与锚点重叠或左对齐（允许边缘 clamp）；纵向间距 = gap×zoom
async function anchoredProbe(page, triggerSel, popSel, { gap, side }) {
  await sleep(450); // Popover 入场动画（framer y:±8 → 0）落定后再量
  const z = await zoomOf(page);
  const t = await rectOf(page, triggerSel);
  const p = await rectOf(page, popSel);
  const vw = await page.evaluate(() => innerWidth);
  const vh = await page.evaluate(() => innerHeight);
  if (!t || !p) return { ok: false, note: `trigger=${!!t} popover=${!!p}（弹层没出现）` };
  const inVp = p.l >= -1 && p.r <= vw + 1 && p.t >= -1 && p.b <= vh + 1;
  const hOverlap = Math.min(p.r, t.r) - Math.max(p.l, t.l);
  const hOk = hOverlap > 0 || near(p.l, t.l, 16 * z);
  const vGap = side === 'above' ? t.t - p.b : p.t - t.b;
  const vOk = near(vGap, gap * z, 2.5);
  return {
    ok: inVp && hOk && vOk,
    note: `zoom=${z} anchor[l=${r1(t.l)} t=${r1(t.t)} b=${r1(t.b)} w=${r1(t.w)}] popover[l=${r1(p.l)} t=${r1(p.t)} b=${r1(p.b)} w=${r1(p.w)}] `
      + `${side}-gap=${r1(vGap)}(期望 ${gap}×${z}=${r1(gap * z)}) 水平重叠=${r1(hOverlap)} 视口内=${inVp} (vw=${vw} vh=${vh})`,
  };
}

async function popoverChecks(page, tag) {
  const out = {};
  // ModelPicker（composer 内，向上弹：bottom = vh - rect.top + 8 → 间距 8）
  await goChat(page);
  await page.getByTestId('model-picker').click();
  out.modelPicker = await anchoredProbe(page, '[data-testid=model-picker]', '[role=dialog].fixed.z-\\[100\\]', { gap: 8, side: 'above' });
  out.modelPickerShot = await snap(page, `${tag}-modelpicker`);
  await page.keyboard.press('Escape');
  await sleep(350);
  // TopBar pin 下拉（top = rect.bottom + 4）
  if (await page.getByTestId('topbar-pin-row').count()) {
    await page.getByTestId('topbar-pin-row').click();
    out.pin = await anchoredProbe(page, '[data-testid=topbar-pin-row]', '[role=dialog][aria-label]', { gap: 4, side: 'below' });
    out.pinShot = await snap(page, `${tag}-pin`);
    await page.keyboard.press('Escape');
    await sleep(350);
  } else {
    out.pin = { ok: false, note: 'topbar-pin-row 不存在（fixture 会话未打开或 pin 行未显示）' };
  }
  // CDP help（top = rect.bottom + 6）
  await goSettingsRoot(page);
  await page.getByTestId('cdp-help').scrollIntoViewIfNeeded();
  await page.getByTestId('cdp-help').hover();
  out.help = await anchoredProbe(page, '[data-testid=cdp-help]', '[role=tooltip]', { gap: 6, side: 'below' });
  out.helpShot = await snap(page, `${tag}-cdphelp`);
  await page.mouse.move(5, 5);
  await sleep(300);
  return out;
}

// 设置根页各行几何（清单 4：与 main 比高度 / 对齐）
async function settingsRowsGeometry(page) {
  await goSettingsRoot(page);
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('[class*="min-h-[46px]"], [data-testid^="settings-row-"]')];
    return rows.map((row) => {
      const r = row.getBoundingClientRect();
      const kids = [...row.children].map((k) => k.getBoundingClientRect());
      const label = (row.textContent || '').trim().slice(0, 40);
      return {
        label, h: Math.round(r.height * 10) / 10, w: Math.round(r.width),
        iconL: kids[0] ? Math.round(kids[0].left - r.left) : null,
        labelL: kids[1] ? Math.round(kids[1].left - r.left) : null,
        ctrlR: kids.length ? Math.round(r.right - kids[kids.length - 1].right) : null,
        ctrlTopInRow: kids.length ? Math.round((kids[kids.length - 1].top - r.top) * 10) / 10 : null,
      };
    });
  });
}

// ══════════════════════════════════════════════════════════════════════
const out = {};
prepareWorkspace(BASE);
if (!fs.existsSync(`${MAIN_DIST}/manifest.json`)) throw new Error(`${MAIN_DIST} 不存在——先 build clean main`);
fs.rmSync(`${BASE}/dist-main`, { recursive: true, force: true });
fs.cpSync(MAIN_DIST, `${BASE}/dist-main`, { recursive: true });
const fixture = await startFixtureServer(BASE);
const fixtureOrigin = new URL(fixture.url).origin;

async function bootstrap({ profile, dist }) {
  const { ctx, page, sw, extId } = await launch({ profile, dist });
  await seedInstance(sw);
  const tabPage = await ctx.newPage();
  await tabPage.goto(fixture.url);
  const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u + '*' }))[0]?.id, fixture.url);
  await page.bringToFront();
  await seedSession(page, { tabId, origin: fixtureOrigin });
  await page.reload();
  await sleep(1500);
  await openFixtureSession(page);
  return { ctx, page, sw, extId, tabId };
}

// ── PR 版 ──────────────────────────────────────────────────────────────
let { ctx, page, sw } = await bootstrap({ profile: 'profile-456', dist: `${BASE}/dist-orig` });
await snap(page, 'pr-chat-100');

// 清单 4a：PR@100% 设置根页行几何（稍后与 main 比）
const prRows100 = await settingsRowsGeometry(page);
await snap(page, 'pr-settings-100');

// ── 清单 1：真鼠标拖动 ───────────────────────────────────────────────
{
  const slider = page.getByTestId('ui-scale-slider');
  const v0 = await slider.inputValue();
  const reset0 = await page.getByTestId('ui-scale-reset').isDisabled();
  const ls0 = await page.evaluate(() => localStorage.getItem('ui-scale'));
  record('1a. 初始态：滑杆 100 / 重置钮禁用 / 未落盘', v0 === '100' && reset0 && ls0 === null ? 'PASS' : 'FAIL',
    `value=${v0} resetDisabled=${reset0} localStorage.ui-scale=${ls0}`);

  const box = await slider.boundingBox();
  const thumbW = 16;
  const x0 = box.x + thumbW / 2 + ((100 - 70) / 80) * (box.width - thumbW);
  const y = box.y + box.height / 2;
  await page.mouse.move(x0, y);
  await page.mouse.down();
  const samples = [];
  const sample = async (tag) => samples.push({
    tag, value: await slider.inputValue(), zoom: await zoomOf(page),
    ls: await page.evaluate(() => localStorage.getItem('ui-scale')),
  });
  await sample('down');
  const dx = (box.width - thumbW) / 80 * 5; // 每 5% 一步的像素
  for (let i = 1; i <= 6; i++) { await page.mouse.move(x0 + dx * i * 1.0, y, { steps: 3 }); await sleep(120); await sample(`move+${i}`); }
  // 按住不动：数值不能自己跑
  await sleep(400); await sample('hold1');
  await sleep(400); await sample('hold2');
  await sleep(400); await sample('hold3');
  const holdVals = samples.filter((s) => s.tag.startsWith('hold')).map((s) => s.value);
  const holdStable = new Set(holdVals).size === 1;
  const live = samples.every((s) => near(s.zoom, Number(s.value) / 100, 0.001));
  const notPersistedDuringDrag = samples.every((s) => s.ls === null);
  const moved = Number(samples[samples.length - 1].value) > 100;
  const idbDuring = await idbConfigGet(page, 'ui-scale');
  await snap(page, 'pr-drag-hold');
  await page.mouse.up();
  await sleep(300);
  const vEnd = await slider.inputValue();
  const lsEnd = await page.evaluate(() => localStorage.getItem('ui-scale'));
  const idbEnd = await idbConfigGet(page, 'ui-scale');
  const zEnd = await zoomOf(page);
  const valueTxt = await page.getByTestId('ui-scale-value').textContent();
  const trace = samples.map((s) => `${s.tag}:${s.value}/z${s.zoom}`).join(' ');
  record('1b. 拖动中：zoom 实时跟随、数值不乱跑（按住 1.2s 三次采样同值）、拖动中不落盘',
    holdStable && live && notPersistedDuringDrag && moved && idbDuring == null ? 'PASS' : 'FAIL',
    `${trace} ‖ hold 三采样=${holdVals.join('/')} ‖ 拖动中 localStorage 恒 null=${notPersistedDuringDrag} IDB=${idbDuring}`);
  record('1c. 松手落盘：localStorage 与 IDB 同值 = value/100，百分比文案同步',
    lsEnd === String(Number(vEnd) / 100) && idbEnd === Number(vEnd) / 100 && near(zEnd, Number(vEnd) / 100, 0.001) && valueTxt === `${vEnd}%` ? 'PASS' : 'FAIL',
    `value=${vEnd} zoom=${zEnd} localStorage=${lsEnd} IDB=${idbEnd} 文案=${valueTxt}`);
  out.dragSamples = samples;

  // 键盘步进：每步就是一次 change → 落盘
  await slider.focus();
  await page.keyboard.press('ArrowRight');
  await sleep(200);
  const vKey = await slider.inputValue();
  const lsKey = await page.evaluate(() => localStorage.getItem('ui-scale'));
  record('1d. 键盘 → 一步 +5 且立即落盘', Number(vKey) === Number(vEnd) + 5 && lsKey === String(Number(vKey) / 100) ? 'PASS' : 'FAIL',
    `${vEnd} → ${vKey}，localStorage=${lsKey}`);
  const saved = Number(vKey);

  // 重开侧栏（reload）：首帧 zoom 先于 React 挂载
  await page.addInitScript(FIRST_FRAME_PROBE);
  await page.reload();
  await sleep(1500);
  const ff = await page.evaluate(() => window.__ff);
  const zReload = await zoomOf(page);
  await goSettingsRoot(page);
  const vReload = await page.getByTestId('ui-scale-slider').inputValue();
  record('1e. 重开侧栏：值保持，首帧 zoom 先于 #root 挂载（无跳变）',
    near(zReload, saved / 100, 0.001) && vReload === String(saved) && ff && ff.zoomAt != null && ff.rootAt != null && ff.zoomAt <= ff.rootAt && ff.zoomVal === String(saved / 100) ? 'PASS' : 'FAIL',
    `zoom=${zReload} slider=${vReload} ‖ 首帧探针 zoomSetAt=${ff && r1(ff.zoomAt)}ms(${ff && ff.zoomVal}) rootMountAt=${ff && r1(ff.rootAt)}ms`);
  await snap(page, 'pr-after-reload');

  // 重启浏览器（关 context 重开同 profile）
  await ctx.close();
  ({ ctx, page, sw } = await launch({ profile: 'profile-456', dist: `${BASE}/dist-orig`, initScript: FIRST_FRAME_PROBE }));
  await sleep(2000);
  const ff2 = await page.evaluate(() => window.__ff);
  const zRestart = await zoomOf(page);
  const idbRestart = await idbConfigGet(page, 'ui-scale');
  await goSettingsRoot(page);
  const vRestart = await page.getByTestId('ui-scale-slider').inputValue();
  record('1f. 重启浏览器：值保持，首帧无跳变',
    near(zRestart, saved / 100, 0.001) && vRestart === String(saved) && idbRestart === saved / 100 && ff2 && ff2.zoomAt != null && ff2.zoomAt <= ff2.rootAt ? 'PASS' : 'FAIL',
    `zoom=${zRestart} slider=${vRestart} IDB=${idbRestart} ‖ zoomSetAt=${ff2 && r1(ff2.zoomAt)}ms rootMountAt=${ff2 && r1(ff2.rootAt)}ms`);
  await snap(page, 'pr-after-restart');

  // 重置
  await page.getByTestId('ui-scale-reset').click();
  await sleep(200);
  const zR = await page.evaluate(() => document.documentElement.style.zoom);
  const lsR = await page.evaluate(() => localStorage.getItem('ui-scale'));
  const idbR = await idbConfigGet(page, 'ui-scale');
  const disR = await page.getByTestId('ui-scale-reset').isDisabled();
  record('1g. 重置 → zoom 清空、落盘 1、重置钮禁用', zR === '' && lsR === '1' && idbR === 1 && disR ? 'PASS' : 'FAIL',
    `html.style.zoom="${zR}" localStorage=${lsR} IDB=${idbR} resetDisabled=${disR}`);
  await openFixtureSession(page);
}

// ── 清单 2：70% / 150% 弹层贴锚 + 侧栏高度 ───────────────────────────
for (const pct of [70, 150]) {
  await setScaleViaSlider(page, pct);
  const h = judgeHeight(await heightProbe(page));
  record(`2.${pct}-height. ${pct}%：侧栏高度 = 窗口高度、无纵向滚动`, h.ok ? 'PASS' : 'FAIL', h.note);
  const pc = await popoverChecks(page, `pr-${pct}`);
  record(`2.${pct}-modelpicker. ${pct}%：ModelPicker 弹层贴触发器（上方 8px×zoom）`, pc.modelPicker.ok ? 'PASS' : 'FAIL', `${pc.modelPicker.note} / ${pc.modelPickerShot}`);
  record(`2.${pct}-pin. ${pct}%：TopBar pin 下拉贴 pin 行（下方 4px×zoom）`, pc.pin.ok ? 'PASS' : 'FAIL', `${pc.pin.note} / ${pc.pinShot ?? ''}`);
  record(`2.${pct}-help. ${pct}%：CDP「?」help 贴图标（下方 6px×zoom）`, pc.help.ok ? 'PASS' : 'FAIL', `${pc.help.note} / ${pc.helpShot}`);
  // chat 视图下再量一次高度（不同视图根容器同一个，但 composer 高度不同）
  await goChat(page);
  const h2 = judgeHeight(await heightProbe(page));
  record(`2.${pct}-height-chat. ${pct}%（chat 视图）：侧栏高度 = 窗口高度`, h2.ok ? 'PASS' : 'FAIL', h2.note);
}

// ── 清单 5：150% ModelPicker 单行省略（证据给人拍板）─────────────────
{
  await setScaleViaSlider(page, 150);
  await goChat(page);
  const mp = await page.evaluate(() => {
    const b = document.querySelector('[data-testid=model-picker]');
    const span = b && b.querySelector('span.truncate');
    if (!b || !span) return null;
    const r = span.getBoundingClientRect();
    return { text: span.textContent, title: b.getAttribute('title'), spanH: r.height, lineH: getComputedStyle(span).lineHeight, whiteSpace: getComputedStyle(span).whiteSpace, ellipsized: span.scrollWidth > span.clientWidth, sw: span.scrollWidth, cw: span.clientWidth };
  });
  const s = await snap(page, 'pr-150-composer-modelname');
  record('5. 150% ModelPicker 模型名：单行 + title（是否省略号由文本长度决定；人拍板）', mp ? 'PASS' : 'FAIL',
    mp ? `text="${mp.text}" white-space=${mp.whiteSpace} span 视觉高=${r1(mp.spanH)}px(line-height ${mp.lineH}×zoom1.5 ⇒ 单行) 省略=${mp.ellipsized}(scrollW ${mp.sw}/clientW ${mp.cw}) title="${mp.title}" / ${s}` : 'model-picker 或 truncate span 不存在');
  out.modelPicker150 = mp;
}

// ── 清单 3：70/150 × light/dark × en/zh-CN，逐视图查溢出与重叠 ──────
{
  const pages = ['models', 'bridge', 'search', 'uiLanguage', 'assistantLanguage', 'customRules', 'feedback', 'about'];
  const matrix = [];
  for (const locale of ['en', 'zh-CN']) {
    await setLocale(page, locale);
    await openFixtureSession(page);
    for (const theme of ['light', 'dark']) {
      await setTheme(page, theme);
      for (const pct of [70, 150]) {
        await setScaleViaSlider(page, pct);
        const tag = `${locale}-${theme}-${pct}`;
        const views = [];
        // chat
        await goChat(page);
        await sleep(200);
        let p = await overflowProbe(page);
        views.push({ view: 'chat', ...p, shot: await snap(page, `${tag}-chat`) });
        // settings root
        await goSettingsRoot(page);
        p = await overflowProbe(page);
        views.push({ view: 'settings', ...p, shot: await snap(page, `${tag}-settings`) });
        for (const id of pages) {
          await goSettingsRoot(page);
          if (!(await page.getByTestId(`settings-row-${id}`).count())) { views.push({ view: id, skipped: 'row absent' }); continue; }
          await page.getByTestId(`settings-row-${id}`).click();
          try { await page.getByTestId(`settings-page-${id}`).waitFor({ timeout: 4000 }); } catch { views.push({ view: id, skipped: 'page did not open' }); continue; }
          await sleep(250);
          p = await overflowProbe(page);
          views.push({ view: id, ...p, shot: await snap(page, `${tag}-${id}`) });
        }
        const bad = views.filter((v) => !v.skipped && (v.docOverflowX > 1 || v.offenders.length || v.overlaps.length));
        const skipped = views.filter((v) => v.skipped).map((v) => `${v.view}(${v.skipped})`);
        matrix.push({ tag, views });
        record(`3.${tag}. ${pct}% ${theme} ${locale}：${views.length - skipped.length} 个视图无横向溢出、无重叠`,
          bad.length ? 'FAIL' : 'PASS',
          bad.length
            ? bad.map((v) => `${v.view}: docOverflowX=${v.docOverflowX} 溢出=${v.offenders.join('; ')} 重叠=${v.overlaps.join('; ')} / ${v.shot}`).join(' ‖ ')
            : `视图=${views.filter((v) => !v.skipped).map((v) => v.view).join(',')}${skipped.length ? ' 跳过=' + skipped.join(',') : ''}；截图 ${views[0].shot}…`);
      }
    }
  }
  out.matrix = matrix;
  // 还原
  await setLocale(page, 'auto');
  await setTheme(page, 'system');
  await setScaleViaSlider(page, 100);
}
await ctx.close();

// ── 对照 clean main ────────────────────────────────────────────────────
{
  const m = await bootstrap({ profile: 'profile-main', dist: `${BASE}/dist-main` });
  await snap(m.page, 'main-chat-100');
  const mainRows = await settingsRowsGeometry(m.page);
  await snap(m.page, 'main-settings-100');
  // 4：逐行比（PR 多一行「界面缩放」不在 min-h-[46px] 行集合里，其余按 label 对齐）
  const byLabel = new Map(mainRows.map((r) => [r.label, r]));
  const diffs = [];
  let matched = 0;
  for (const r of prRows100) {
    const mr = byLabel.get(r.label);
    if (!mr) { diffs.push(`PR 行「${r.label}」main 无对应`); continue; }
    matched++;
    for (const k of ['h', 'w', 'iconL', 'labelL', 'ctrlR', 'ctrlTopInRow']) {
      if (r[k] !== mr[k]) diffs.push(`「${r.label}」${k}: PR=${r[k]} main=${mr[k]}`);
    }
  }
  record('4. 100% 设置根页各行高度 / 图标·文字·控件对齐与 main 一致', diffs.length === 0 && matched >= 8 ? 'PASS' : 'FAIL',
    `${matched}/${prRows100.length} 行匹配（main ${mainRows.length} 行）${diffs.length ? '；差异: ' + diffs.join('; ') : '；所有行 h/w/iconL/labelL/ctrlR/ctrlTop 全等'}`);
  out.rows = { pr: prRows100, main: mainRows };
  const h100 = judgeHeight(await heightProbe(m.page));
  record('4b. main@100% 高度基线（PR 的 h-full 链在 100% 下应与 h-screen 等价）', h100.ok ? 'PASS' : 'FAIL', h100.note);

  // CTRL-A：main 上手动 zoom=1.5 → 高度 / ModelPicker 弹层断言必须 FAIL
  await m.page.evaluate(() => { document.documentElement.style.zoom = '1.5'; });
  await sleep(300);
  const hc = judgeHeight(await heightProbe(m.page));
  await goChat(m.page);
  await m.page.getByTestId('model-picker').click();
  const pc = await anchoredProbe(m.page, '[data-testid=model-picker]', '[role=dialog].fixed.z-\\[100\\]', { gap: 8, side: 'above' });
  const shotC = await snap(m.page, 'main-zoom150-modelpicker');
  await m.page.keyboard.press('Escape');
  record('CTRL-A. 对照 clean main 手动 zoom=1.5 → 高度断言与 ModelPicker 贴锚断言必须至少一项 FAIL（证明断言有效）',
    !hc.ok || !pc.ok ? 'PASS' : 'FAIL', `main@1.5 高度: ${hc.ok ? 'ok' : 'FAIL'}(${hc.note}) ‖ 弹层: ${pc.ok ? 'ok' : 'FAIL'}(${pc.note}) / ${shotC}`);
  await m.ctx.close();
}

fixture.server.close();
fs.writeFileSync(`${REPORT}/results-456.json`, JSON.stringify({ results, out }, null, 2));
const fails = results.filter((r) => r.status !== 'PASS');
console.log(`\n=== ${results.length} 项，FAIL/ERROR ${fails.length} 项 ===`);
process.exit(fails.length ? 1 : 0);
