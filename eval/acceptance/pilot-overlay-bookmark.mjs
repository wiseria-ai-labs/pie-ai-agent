// Real end-to-end: "add this page to bookmarks" asked INSIDE the overlay.
//
// Proves the round-5 rule with the real model + real agent loop:
//   - the overlay never collapses to a capsule while the task runs,
//   - the bookmark really is created (create_bookmark actually ran),
//   - screenshots at start / during the tool / final answer.
//
// Requires the eval build (needs `__pieEval.seedConfig`) with bookmarks moved
// from optional_permissions to permissions (no permission card in automation):
//   pnpm build:eval
//   node -e "const fs=require('fs');const p='dist-eval/manifest.json';const m=JSON.parse(fs.readFileSync(p));m.optional_permissions=m.optional_permissions.filter(x=>x!=='bookmarks');m.permissions.push('bookmarks');fs.writeFileSync(p,JSON.stringify(m,null,2))"
//   set -a; source ~/.pie/acceptance.env; set +a
//   PIE_ACCEPT_BASE=/tmp/pieovl-bookmark node eval/acceptance/pilot-overlay-bookmark.mjs "$PWD"
import fs from "node:fs";
import http from "node:http";
import { chromium } from "playwright";

const REPO = process.argv[2];
const BASE = process.env.PIE_ACCEPT_BASE || "/tmp/pieovl-bookmark";
const DIST = `${REPO}/dist-eval`;
const PROVIDER = process.env.PIE_EVAL_PROVIDER;
const MODEL = process.env.PIE_EVAL_MODEL;
const API_KEY = process.env.PIE_EVAL_API_KEY;
if (!PROVIDER || !MODEL || !API_KEY) throw new Error("PIE_EVAL_* 未配置（source ~/.pie/acceptance.env）");
if (!fs.existsSync(`${DIST}/manifest.json`)) throw new Error("先 pnpm build:eval");

fs.mkdirSync(`${BASE}/report`, { recursive: true });
fs.rmSync(`${BASE}/profile`, { recursive: true, force: true });
fs.mkdirSync(`${BASE}/profile`, { recursive: true });

const results = [];
const rec = (id, status, note = "") => {
  results.push({ id, status, note });
  console.log(`[${status}] ${id}${note ? " — " + note : ""}`);
};

const TITLE = `Pie bookmark ${Date.now()}`;
const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>${TITLE} · 季度复盘</title>
<style>body{font:16px/1.7 -apple-system,sans-serif;padding:56px 64px;max-width:720px}
h1{font-size:26px;margin:0 0 10px}p{color:#333}</style></head>
<body><h1>季度复盘 · 草稿</h1>
<p>收入侧：本季度新增付费用户 1,284 人，环比增长 18%。主要来源是开发者社区与内容分发的长尾。</p>
<p>成本侧：推理成本随用量线性增长，单用户成本 0.42 元，比预算高 6%。</p>
<p>风险：渠道集中在两个平台，任一政策变化都会影响获客。</p>
</body></html>`;
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(HTML);
});
await new Promise((r) => server.listen(0, r));
const PORT = server.address().port;

const ctx = await chromium.launchPersistentContext(`${BASE}/profile`, {
  headless: false,
  viewport: { width: 1200, height: 900 },
  locale: "en-US",
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, "--lang=en-US"],
});
let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
const extId = new URL(sw.url()).host;
for (let i = 0; i < 20; i++) {
  if (await sw.evaluate(() => typeof globalThis.__pieEval !== "undefined")) break;
  await new Promise((r) => setTimeout(r, 250));
}
await new Promise((r) => setTimeout(r, 3000)); // startup pipeline
const { instanceId } = await sw.evaluate((cfg) => globalThis.__pieEval.seedConfig(cfg), {
  provider: PROVIDER,
  model: MODEL,
  apiKey: API_KEY,
});
await sw.evaluate(
  (args) =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open("pie");
      req.onsuccess = () => {
        const tx = req.result.transaction("config", "readwrite");
        tx.objectStore("config").put({ key: "last_model_selection", value: { instanceId: args.instanceId, model: args.model } });
        tx.objectStore("config").put({ key: "instances_index", value: [args.instanceId] });
        tx.oncomplete = () => resolve(null);
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    }),
  { instanceId, model: MODEL },
);
console.log(`seeded ${PROVIDER}/${MODEL}`);

const page = await ctx.newPage();
page.setDefaultTimeout(20000);
const sendToTab = (msg) =>
  sw.evaluate(async (m) => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return chrome.tabs.sendMessage(tab.id, m);
  }, msg);

await page.goto(`http://localhost:${PORT}/`);
await page.waitForTimeout(1500); // content script at document_idle

// Open through the REAL selection-bar path (content script → SW), so the SW
// resolves/creates the tab's session exactly as a user would.
await page.evaluate(() => {
  const p = document.querySelector("p");
  const range = document.createRange();
  range.selectNodeContents(p);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
});
await page.waitForTimeout(400);
await page.evaluate(() => {
  const bar = document.querySelector("[data-pie-quote-bubble]");
  bar.shadowRoot.querySelector('[data-act="ask"]').click();
});
await page.waitForTimeout(1500);
const frame = page.frames().find((f) => f.url().includes("src/overlay/index.html"));
if (!frame) throw new Error("overlay did not mount");
const sessionId = new URL(frame.url()).searchParams.get("sessionId");
console.log("session:", sessionId);

const stateNow = async () =>
  page.evaluate(() => {
    const h = document.querySelector("[data-pie-overlay-host]");
    return {
      display: h ? getComputedStyle(h).display : "absent",
      visibility: h ? getComputedStyle(h).visibility : "absent",
      capsule: Boolean(document.querySelector("[data-pie-capsule]")),
    };
  });

async function snap(name) {
  const path = `${BASE}/report/${name}.png`;
  await page.screenshot({ path });
  return path;
}

const readSession = () =>
  sw.evaluate(
    (sid) =>
      new Promise((resolve) => {
        const req = indexedDB.open("pie");
        req.onsuccess = () => {
          const db = req.result;
          const g = db.transaction("sessions").objectStore("sessions").get(`${sid}:meta`);
          g.onsuccess = () => {
            db.close();
            const msgs = g.result?.value?.messages ?? [];
            resolve({
              tools: msgs.filter((m) => m.role === "agent-step").map((m) => m.tool),
              assistant: msgs.some((m) => m.role === "assistant" && String(m.content ?? "").trim().length > 0),
            });
          };
        };
      }),
    sessionId,
  );

// ── the run ────────────────────────────────────────────────────────────────
const composer = frame.locator("#overlay-root textarea");
await composer.fill(
  "把这个页面加入书签，标题用「" +
    TITLE +
    "」。如果需要，先用 load_tools 加载 browser-data，再调用 create_bookmark。加完用一句话确认。",
);
await composer.press("Enter");
await page.waitForTimeout(1200);
const s0 = await stateNow();
const shot0 = await snap("bookmark-1-start");
rec(
  "start: overlay stays open after send",
  s0.display === "block" && s0.visibility === "visible" && !s0.capsule ? "PASS" : "FAIL",
  JSON.stringify(s0),
);

let sawStep = false;
let shotDuring = null;
let sDuring = null;
for (let i = 0; i < 120; i++) {
  await page.waitForTimeout(500);
  const { tools } = await readSession();
  if (!sawStep && tools.includes("create_bookmark")) {
    sawStep = true;
    sDuring = await stateNow();
    shotDuring = await snap("bookmark-2-tool-running");
  }
  // The composer placeholder is the UI's own "still streaming" flag; waiting
  // for an assistant ROW is not enough (the loop flushes text at every step).
  const placeholder = await composer.getAttribute("placeholder").catch(() => null);
  const answering = /Answering/i.test(placeholder ?? "");
  if (sawStep && !answering) break;
  // No tool call after 40s: stop waiting; the run may still be answering.
  if (!sawStep && i === 80) break;
}
const steps = (await readSession()).tools;
const sEnd = await stateNow();
const shotEnd = await snap("bookmark-3-final");
const bookmark = await sw.evaluate(
  (title) =>
    new Promise((resolve) => {
      chrome.bookmarks.search({ title }, (rows) => resolve(rows.map((r) => ({ title: r.title, url: r.url }))));
    }),
  TITLE,
);

rec("create_bookmark actually ran", sawStep ? "PASS" : "FAIL", `steps=${JSON.stringify(steps.slice(-8))}`);
rec(
  "during the tool: overlay stays open",
  sDuring && sDuring.display === "block" && sDuring.visibility === "visible" && !sDuring.capsule ? "PASS" : "FAIL",
  JSON.stringify(sDuring),
);
rec(
  "end: overlay still open, no capsule ever appeared",
  sEnd.display === "block" && sEnd.visibility === "visible" && !sEnd.capsule ? "PASS" : "FAIL",
  JSON.stringify(sEnd),
);
rec(
  "bookmark exists",
  Array.isArray(bookmark) && bookmark.length > 0 ? "PASS" : "FAIL",
  JSON.stringify(bookmark),
);
// ── phase 2: capsule only when the USER closes a live run ──────────────────
const composer2 = frame.locator("#overlay-root textarea");
await composer2.fill("再读一下这个页面，然后用一句话说明它主要讲什么。");
await composer2.press("Enter");
await page.waitForTimeout(500);
await page.keyboard.press("Escape");
let capsuleAfterClose = null;
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(250);
  capsuleAfterClose = await page.evaluate(() => {
    const c = document.querySelector("[data-pie-capsule]");
    if (!c) return null;
    const wrap = c.shadowRoot.querySelector(".wrap");
    return { text: wrap?.textContent?.trim().slice(0, 60), overlay: getComputedStyle(document.querySelector("[data-pie-overlay-host]")).display };
  });
  if (capsuleAfterClose) break;
}
const shotCapsule = await snap("bookmark-4-capsule-after-user-close");
rec(
  "user close while running → capsule, overlay hidden",
  capsuleAfterClose && capsuleAfterClose.text?.length > 0 && capsuleAfterClose.overlay === "none" ? "PASS" : "FAIL",
  JSON.stringify(capsuleAfterClose),
);
// Reopen the way a user does while the task runs: select text and ask. (The
// running capsule deliberately offers Stop / Open panel, not "view".)
if (capsuleAfterClose) {
  await page.evaluate(() => {
    const p = document.querySelectorAll("p")[1];
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const bar = document.querySelector("[data-pie-quote-bubble]");
    bar.shadowRoot.querySelector('[data-act="ask"]').click();
  });
}
await page.waitForTimeout(1500);
const reopened = await stateNow();
const shotReopen = await snap("bookmark-5-reopened-live");
rec(
  "reopen returns to the live conversation (capsule gone)",
  reopened.display === "block" && reopened.visibility === "visible" && !reopened.capsule ? "PASS" : "FAIL",
  JSON.stringify(reopened),
);
console.log("capsule screenshots:", shotCapsule, shotReopen);

console.log("screenshots:", shot0, shotDuring, shotEnd);
fs.writeFileSync(
  `${BASE}/report/results.json`,
  JSON.stringify(
    { results, sessionId, shots: [shot0, shotDuring, shotEnd, shotCapsule, shotReopen] },
    null,
    2,
  ),
);
console.log("\nSUMMARY", results.every((r) => r.status === "PASS") ? "ALL PASS" : "HAS FAILURES");
await ctx.close();
server.close();
