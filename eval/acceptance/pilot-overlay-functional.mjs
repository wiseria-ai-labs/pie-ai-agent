// Overlay smoke — real Chromium, real extension, real content scripts.
// Verifies the half that happy-dom cannot: the shadow host + iframe mount,
// the top-layer promotion, the selection bar, the capsule, and resize wiring.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";

const REPO = process.argv[2];
const BASE = process.env.PIE_ACCEPT_BASE || "/tmp/pieovl";
const DIST = `${REPO}/dist`;
fs.mkdirSync(`${BASE}/report`, { recursive: true });
fs.mkdirSync(`${BASE}/profile`, { recursive: true });

const results = [];
const rec = (id, status, note = "") => {
  results.push({ id, status, note });
  console.log(`[${status}] ${id}${note ? " — " + note : ""}`);
};
let shot = 0;
async function snap(page, name) {
  shot += 1;
  const f = `${BASE}/report/${String(shot).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path: f }).catch(() => {});
  return f;
}

// ── fixture page ────────────────────────────────────────────────────────────
const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Overlay fixture</title>
<style>body{font:16px/1.6 -apple-system,sans-serif;padding:40px;max-width:640px}
#reply{width:100%;height:80px}.ed{border:1px solid #ccc;padding:8px;min-height:40px}</style></head>
<body>
  <h1>Overlay fixture</h1>
  <p id="read">预算口径按新的分摊规则执行，差额部分由各 BU 自行消化。</p>
  <label>Reply<textarea id="reply">好的，我这周五前发给你。</textarea></label>
  <div class="ed" id="ed" contenteditable="true">这周五前必须把报告交上来，别再拖了。</div>
  <p><a href="/other">another page</a></p>
  <div id="under" style="position:fixed;left:600px;top:120px;width:120px;height:40px;background:#eef">under the card</div>
  <div id="far" style="position:fixed;left:40px;top:700px;width:120px;height:40px;background:#efe">far away</div>
</body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === "/other") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body><h1>Second page</h1><p>navigated</p></body></html>");
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(HTML);
});
await new Promise((r) => server.listen(0, r));
const PORT = server.address().port;

// ── launch ──────────────────────────────────────────────────────────────────
const ctx = await chromium.launchPersistentContext(`${BASE}/profile`, {
  headless: false,
  viewport: { width: 1200, height: 900 },
  locale: "en-US",
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, "--lang=en-US"],
});
let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
const extId = new URL(sw.url()).host;
console.log("extension id:", extId);
const page = await ctx.newPage();
page.setDefaultTimeout(15000);

// Seed a conversation directly into IDB (same shape as the panel writes).
await page.goto(`chrome-extension://${extId}/src/sidepanel/index.html`);
await page.waitForTimeout(2500);
const sessionId = await page.evaluate(
  () =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open("pie");
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(["sessions", "session_index"], "readwrite");
        const sessions = tx.objectStore("sessions");
        const indexStore = tx.objectStore("session_index");
        const now = Date.now();
        const id = crypto.randomUUID();
        const messages = [
          { role: "user", content: "这样写太生硬了，改得客气一点" },
          { role: "assistant", content: "已按更客气的语气改好，见下方对比。" },
          {
            role: "agent-step",
            stepIndex: 1,
            tool: "propose_rewrite",
            args: { text: "麻烦这周五前把报告发我，辛苦啦，有困难随时跟我说。" },
            status: "ok",
          },
        ];
        const g = indexStore.get("index");
        g.onsuccess = () => {
          const index = Array.isArray(g.result?.value) ? g.result.value.slice() : [];
          const meta = { id, createdAt: now, lastAccessedAt: now, status: "active", title: "Overlay fixture", messages, pinMode: "auto" };
          sessions.put({ id: `${id}:meta`, value: meta });
          sessions.put({ id: `${id}:agent`, value: { agentMessages: [], pendingInstructions: [], stepIndex: 0, hasImageContent: false } });
          index.push({ id, lastAccessedAt: now, status: "active", title: "Overlay fixture", messageCount: messages.length });
          indexStore.put({ id: "index", value: index });
          tx.oncomplete = () => { db.close(); resolve(id); };
          tx.onerror = () => reject(tx.error);
        };
        g.onerror = () => reject(g.error);
      };
    }),
);
console.log("seeded session:", sessionId);

const sendToTab = (msg) => sw.evaluate(async (m) => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return chrome.tabs.sendMessage(tab.id, m);
}, msg);

// ── A. overlay mounts from a SW → content-script OPEN ───────────────────────
await page.goto(`http://localhost:${PORT}/`);
await page.waitForTimeout(1500); // content script at document_idle

try {
  await sendToTab({
    type: "pie-overlay:open",
    payload: {
      sessionId,
      tabId: 1,
      intent: "ask",
      selection: { text: "预算口径按新的分摊规则执行", editable: false, url: `http://localhost:${PORT}/` },
      prompt: null,
      autoSend: false,
      position: "anchor",
      resumed: false,
    },
  });
  await page.waitForTimeout(1200);
  const host = await page.evaluate(() => {
    const h = document.querySelector("[data-pie-overlay-host]");
    if (!h) return null;
    const frame = h.shadowRoot?.querySelector("iframe");
    return {
      hasShadow: Boolean(h.shadowRoot),
      inTopLayer: h.matches(":popover-open"),
      frameSrc: frame?.getAttribute("src") ?? null,
      frameVisible: frame ? frame.getBoundingClientRect().height > 50 : false,
      hostTop: h.style.top,
      hostLeft: h.style.left,
      hostWidth: frame ? Math.round(frame.getBoundingClientRect().width) : 0,
    };
  });
  if (!host) rec("A1 overlay host", "FAIL", "no [data-pie-overlay-host]");
  else if (!host.inTopLayer) rec("A1 overlay host", "FAIL", `not in top layer: ${JSON.stringify(host)}`);
  else rec("A1 overlay host", "PASS", JSON.stringify(host));

  const iframe = page.frameLocator("[data-pie-overlay-host] iframe");
  const composerVisible = await iframe.locator("#overlay-root textarea").isVisible().catch(() => false);
  const bubbleText = await iframe.locator("text=这样写太生硬了").count().catch(() => 0);
  const rewriteCard = await iframe.locator("text=麻烦这周五前把报告发我").count().catch(() => 0);
  rec("A2 overlay document renders", composerVisible ? "PASS" : "FAIL",
    `composer=${composerVisible} userBubble=${bubbleText} rewriteCard=${rewriteCard}`);
  await snap(page, "overlay-open");

  // 高度上报：宿主 iframe 高度应大于最小 120（说明 resize 桥在工作）
  const h = await page.evaluate(() => {
    const f = document.querySelector("[data-pie-overlay-host]").shadowRoot.querySelector("iframe");
    return f.getBoundingClientRect().height;
  });
  rec("A3 resize bridge", h > 130 ? "PASS" : "FAIL", `iframe height=${Math.round(h)}`);

  // 卡片几何：iframe 744（卡片 680 + 两侧 32px 透明留白），阴影不被裁、圆角外透明
  const ovFrame = page.frames().find((f) => f.url().includes("src/overlay/index.html"));
  const layout = await ovFrame.evaluate(() => {
    const root = document.getElementById("overlay-root");
    const card = root?.querySelector("[data-card]");
    const cs = root ? getComputedStyle(root) : null;
    const r = card?.getBoundingClientRect();
    return {
      pad: cs?.paddingTop,
      cardW: r ? Math.round(r.width) : 0,
      iframeH: Math.round(window.innerHeight),
      iframeColorScheme: getComputedStyle(document.documentElement).colorScheme,
      bodyBg: getComputedStyle(document.body).backgroundColor,
    };
  });
  rec(
    "A4 card geometry inside a transparent iframe",
    host.hostWidth === 744 && layout.pad === "32px" && layout.cardW === 680 && layout.bodyBg === "rgba(0, 0, 0, 0)"
      ? "PASS"
      : "FAIL",
    JSON.stringify({ host: host.hostWidth, ...layout }),
  );

  // ── B. Esc closes; reopen keeps the conversation ──────────────────────────
  await iframe.locator("textarea").click();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const hidden = await page.evaluate(() => {
    const h = document.querySelector("[data-pie-overlay-host]");
    return !h || getComputedStyle(h).display === "none";
  });
  rec("B1 Esc hides the overlay", hidden ? "PASS" : "FAIL", `display none/absent=${hidden}`);

  await sendToTab({
    type: "pie-overlay:open",
    payload: {
      sessionId, tabId: 1, intent: "hotkey", selection: null, prompt: null,
      autoSend: false, position: "top", resumed: true,
    },
  });
  await page.waitForTimeout(800);
  const reopened = await page.evaluate(() => {
    const h = document.querySelector("[data-pie-overlay-host]");
    return h ? { display: getComputedStyle(h).display, top: h.style.top } : null;
  });
  rec("B2 reopen resumes", reopened && reopened.display !== "none" ? "PASS" : "FAIL", JSON.stringify(reopened));

  // ── C. close tears the document down when nothing is running ──────────────
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);
  const gone = await page.evaluate(() => !document.querySelector("[data-pie-overlay-host]"));
  rec("C1 close without a task tears down", gone ? "PASS" : "FAIL", `absent=${gone}`);
} catch (e) {
  rec("A0 overlay flow", "ERROR", e.message);
  await snap(page, "overlay-error");
}

// ── D. selection bar ────────────────────────────────────────────────────────
try {
  await page.waitForTimeout(600);
  const box = await page.locator("#read").boundingBox();
  await page.mouse.move(box.x + 5, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 10, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const bar = await page.evaluate(() => {
    const h = document.querySelector("[data-pie-quote-bubble]");
    if (!h) return null;
    return {
      acts: [...h.shadowRoot.querySelectorAll("[data-act]")].map((b) => b.dataset.act),
      top: h.style.top,
    };
  });
  rec("D1 read-only selection bar", bar && bar.acts.includes("quote") ? "PASS" : "FAIL", JSON.stringify(bar));
  await snap(page, "selection-bar");

  // editable selection → rewrite buttons
  await page.evaluate(() => {
    const ed = document.getElementById("ed");
    const range = document.createRange();
    range.selectNodeContents(ed);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await page.waitForTimeout(300);
  const bar2 = await page.evaluate(() => {
    const h = document.querySelector("[data-pie-quote-bubble]");
    return h ? [...h.shadowRoot.querySelectorAll("[data-act]")].map((b) => b.dataset.act) : null;
  });
  rec("D2 editable selection bar", bar2 && bar2.includes("rewrite") && !bar2.includes("quote") ? "PASS" : "FAIL", JSON.stringify(bar2));
  await snap(page, "selection-bar-editable");
} catch (e) {
  rec("D0 selection bar", "ERROR", e.message);
}

// ── F. write-back (S2): real content script, real execCommand ───────────────
try {
  // Re-select the contenteditable and click the bar's 改写 — this goes through
  // the REAL intent path (content script → SW → open payload → overlay doc).
  await page.evaluate(() => {
    const ed = document.getElementById("ed");
    const range = document.createRange();
    range.selectNodeContents(ed);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const bar = document.querySelector("[data-pie-quote-bubble]");
    bar.shadowRoot.querySelector('[data-act="rewrite"]').click();
  });
  await page.waitForTimeout(1500);

  const opened = await page.evaluate(() => {
    const h = document.querySelector("[data-pie-overlay-host]");
    return h ? getComputedStyle(h).display : "absent";
  });
  rec("F1 bar intent opens the overlay", opened !== "none" && opened !== "absent" ? "PASS" : "FAIL", `display=${opened}`);

  const frame = page.frames().find((f) => f.url().includes("src/overlay/index.html"));
  const realTabId = frame ? Number(new URL(frame.url()).searchParams.get("tabId")) : -1;
  if (!frame) {
    rec("F2 write-back", "FAIL", "overlay frame not found");
  } else {
    // The overlay document asks the SW; the SW relays to the content script.
    const ok = await frame.evaluate(async (tabId) =>
      chrome.runtime.sendMessage({
        type: "overlay:request-replace",
        tabId,
        original: "这周五前必须把报告交上来，别再拖了。",
        text: "请您于本周五前提交报告，如有困难请提前告知。",
      }), realTabId);
    const after = await page.evaluate(() => document.getElementById("ed").textContent);
    rec("F2 replace writes the page", ok?.ok === true && after.includes("请您于本周五前提交报告") ? "PASS" : "FAIL",
      `reply=${JSON.stringify(ok)} text=${after}`);

    const undo = await frame.evaluate(async (tabId) =>
      chrome.runtime.sendMessage({
        type: "overlay:request-replace",
        tabId,
        original: "请您于本周五前提交报告，如有困难请提前告知。",
        text: "这周五前必须把报告交上来，别再拖了。",
      }), realTabId);
    const restored = await page.evaluate(() => document.getElementById("ed").textContent);
    rec("F3 undo restores the original", undo?.ok === true && restored.includes("别再拖了") ? "PASS" : "FAIL",
      `reply=${JSON.stringify(undo)} text=${restored}`);

    const stale = await frame.evaluate(async (tabId) =>
      chrome.runtime.sendMessage({
        type: "overlay:request-replace",
        tabId,
        original: "这段文字页面上已经没有了",
        text: "x",
      }), realTabId);
    rec("F4 stale original is refused", stale?.ok === false && stale?.reason === "stale" ? "PASS" : "FAIL",
      JSON.stringify(stale));

    // Textarea path (field, not contenteditable). The bar only appears while no
    // overlay is open, so close it first.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    const field = await page.evaluate(() => {
      const t = document.getElementById("reply");
      t.focus();
      t.setSelectionRange(0, 12);
      return { start: t.selectionStart, text: t.value.slice(0, 12) };
    });
    await page.evaluate(() => {
      const t = document.getElementById("reply");
      t.focus();
      t.setSelectionRange(0, 12);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const bar = document.querySelector("[data-pie-quote-bubble]");
      if (bar) bar.shadowRoot.querySelector('[data-act="rewrite"]').click();
    });
    await page.waitForTimeout(1200);
    const fieldFrame = page.frames().find((f) => f.url().includes("src/overlay/index.html"));
    const fieldReplace = await fieldFrame.evaluate(async ({ original, tabId }) =>
      chrome.runtime.sendMessage({
        type: "overlay:request-replace",
        tabId,
        original,
        text: "收到，我周五前发您。",
      }), { original: field.text, tabId: realTabId });
    const fieldAfter = await page.evaluate(() => document.getElementById("reply").value);
    rec("F5 textarea field write-back", fieldReplace?.ok === true && fieldAfter.includes("收到，我周五前发您。") ? "PASS" : "FAIL",
      `reply=${JSON.stringify(fieldReplace)} value=${fieldAfter}`);
  }
  await snap(page, "writeback");
} catch (e) {
  rec("F0 write-back", "ERROR", e.message);
}

// ── E. capsule survives + renders ─────────────────────────────────────────
try {
  // The capsule only exists while the overlay is closed (user closed a live
  // run); with the overlay visible its state is dropped by design.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  await sendToTab({
    type: "pie-capsule:state",
    state: {
      status: "run",
      sessionId,
      steps: [
        { tool: "click", status: "ok" },
        { tool: "type", status: "pending" },
      ],
    },
  });
  await page.waitForTimeout(500);
  const cap = await page.evaluate(() => {
    const h = document.querySelector("[data-pie-capsule]");
    if (!h) return null;
    const wrap = h.shadowRoot.querySelector(".wrap");
    return { text: wrap?.textContent?.trim().slice(0, 80), bottomRight: true };
  });
  // Copy is the localized activity line — never the tool name or its args.
  rec(
    "E1 capsule renders human activity, no tool names/args",
    cap && cap.text?.includes("Working on the page") && !cap.text.includes("click") && !cap.text.includes("{")
      ? "PASS"
      : "FAIL",
    JSON.stringify(cap),
  );
  await snap(page, "capsule");

  await sendToTab({ type: "pie-surface:hide" });
  await page.waitForTimeout(200);
  const hiddenCap = await page.evaluate(() => {
    const h = document.querySelector("[data-pie-capsule]");
    return h ? getComputedStyle(h).display : "absent";
  });
  await sendToTab({ type: "pie-surface:show" });
  await page.waitForTimeout(200);
  const shownCap = await page.evaluate(() => {
    const h = document.querySelector("[data-pie-capsule]");
    return h ? getComputedStyle(h).display : "absent";
  });
  rec("E2 surface hide/show (screenshot guard)", hiddenCap === "none" && shownCap !== "none" ? "PASS" : "FAIL",
    `hidden=${hiddenCap} shown=${shownCap}`);
} catch (e) {
  rec("E0 capsule", "ERROR", e.message);
}

// ── G. structured translate / rewrite (round 4 redesign) ───────────────────
try {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);

  // Translate: select the read-only paragraph and use the real selection bar.
  await page.evaluate(() => {
    const p = document.getElementById("read");
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    document.querySelector("[data-pie-quote-bubble]").shadowRoot.querySelector('[data-act="translate"]').click();
  });
  await page.waitForTimeout(1200);
  const tFrame = page.frames().find((f) => f.url().includes("src/overlay/index.html"));
  const langs = await tFrame.locator("[data-action-row=translate] [data-lang]").allTextContents();
  const prefill = await tFrame.locator("#overlay-root textarea").inputValue();
  // Pre-conversation the thread is mounted but collapsed (it animates open with
  // the first message), so assert "no space taken", not "absent".
  const threadOpen0 = await tFrame.evaluate(() => {
    const el = document.querySelector("[data-thread]");
    return el ? Math.round(el.getBoundingClientRect().height) : 0;
  });
  rec(
    "G1 translate opens with one-click language buttons, empty composer, no auto-send",
    langs.length >= 2 && prefill === "" && threadOpen0 <= 30 ? "PASS" : "FAIL",
    `langs=${JSON.stringify(langs)} prefill=${JSON.stringify(prefill)} threadH=${threadOpen0}`,
  );
  await snap(page, "translate-chip");

  // More languages → picking one translates right away and is remembered.
  await tFrame.locator("[data-action-row=translate] button[aria-expanded]").click();
  await page.waitForTimeout(250);
  await snap(page, "translate-languages");
  await tFrame.locator('#overlay-root [role="option"][data-lang="ja"]').click();
  await page.waitForTimeout(600);
  const after = (await tFrame.locator("#overlay-root [data-thread]").innerText().catch(() => "")) ?? "";
  // Read the persisted preference in the extension origin (the SW shares the
  // same IDB; the fixture page has its own origin-local database).
  const stored = await sw.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open("pie");
        req.onsuccess = () => {
          const db = req.result;
          const g = db.transaction("config").objectStore("config").get("overlay_settings");
          g.onsuccess = () => {
            db.close();
            resolve(g.result?.value ?? null);
          };
        };
      }),
  );
  rec(
    "G2 picking a language sends the translation and is remembered",
    after.includes("Japanese") && stored?.lastTranslateLang === "ja" ? "PASS" : "FAIL",
    `thread=${JSON.stringify(after.slice(0, 80))} stored=${stored?.lastTranslateLang}`,
  );
  await snap(page, "translate-japanese");

  // Rewrite: clicking 改写 must open with style chips, NOT send automatically.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const ed = document.getElementById("ed");
    const range = document.createRange();
    range.selectNodeContents(ed);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    document.querySelector("[data-pie-quote-bubble]").shadowRoot.querySelector('[data-act="rewrite"]').click();
  });
  await page.waitForTimeout(1200);
  const rFrame = page.frames().find((f) => f.url().includes("src/overlay/index.html"));
  const chipTexts = await rFrame.locator("#overlay-root button").allTextContents();
  const placeholder = await rFrame.locator("#overlay-root textarea").getAttribute("placeholder");
  const styles = ["More formal", "Shorter", "More casual", "Fix typos & grammar", "Expand"];
  rec(
    "G3 rewrite opens with style chips, no auto-send",
    styles.every((x) => chipTexts.includes(x)) && /how should i change it/i.test(placeholder ?? "") ? "PASS" : "FAIL",
    `chips=${JSON.stringify(chipTexts)} placeholder=${JSON.stringify(placeholder)}`,
  );
  await snap(page, "rewrite-chips");
} catch (e) {
  rec("G0 structured tasks", "ERROR", e.message);
}

// ── H. surface rules: no auto-collapse, screenshot peek, overlap guard ─────
try {
  // Start from an open overlay (G3 left one open).
  const openFrame = page.frames().find((f) => f.url().includes("src/overlay/index.html"));
  // H1 — a capsule push (the old write-tool trigger) must NOT hide the overlay.
  await sendToTab({
    type: "pie-capsule:state",
    state: { status: "run", sessionId, steps: [{ tool: "create_bookmark", status: "pending" }] },
  });
  await page.waitForTimeout(400);
  const h1 = await page.evaluate(() => {
    const h = document.querySelector("[data-pie-overlay-host]");
    return {
      overlayDisplay: h ? getComputedStyle(h).display : "absent",
      overlayVisibility: h ? getComputedStyle(h).visibility : "absent",
      capsule: Boolean(document.querySelector("[data-pie-capsule]")),
    };
  });
  rec(
    "H1 bookmark step does not collapse the overlay",
    h1.overlayDisplay === "block" && h1.overlayVisibility === "visible" && h1.capsule === false ? "PASS" : "FAIL",
    JSON.stringify(h1),
  );
  await snap(page, "bookmark-step-overlay-open");

  // H2 — screenshot peek: visibility only, layout untouched, restored after.
  const beforeH = await page.evaluate(() => {
    const f = document.querySelector("[data-pie-overlay-host]").shadowRoot.querySelector("iframe");
    return Math.round(f.getBoundingClientRect().height);
  });
  await sendToTab({ type: "pie-surface:peek-hide" });
  await page.waitForTimeout(150);
  const peeked = await page.evaluate(() => {
    const h = document.querySelector("[data-pie-overlay-host]");
    const f = h.shadowRoot.querySelector("iframe");
    return { visibility: getComputedStyle(h).visibility, h: Math.round(f.getBoundingClientRect().height) };
  });
  await sendToTab({ type: "pie-surface:peek-show" });
  await page.waitForTimeout(150);
  const restored = await page.evaluate(() => {
    const h = document.querySelector("[data-pie-overlay-host]");
    return getComputedStyle(h).visibility;
  });
  rec(
    "H2 screenshot peek hidden one frame, layout kept",
    peeked.visibility === "hidden" && peeked.h === beforeH && restored === "visible" ? "PASS" : "FAIL",
    JSON.stringify({ beforeH, ...peeked, restored }),
  );

  // H3 — page guard hides only when the target rectangle meets the card.
  await page.evaluate(() => {
    // Park #under on top of the card wherever it currently is, and #far well
    // outside it, so the overlap test does not depend on placement mode.
    const host = document.querySelector("[data-pie-overlay-host]");
    const r = host.getBoundingClientRect();
    const under = document.getElementById("under");
    under.style.left = `${Math.round(r.left + 30)}px`;
    under.style.top = `${Math.round(r.top + 30)}px`;
    under.setAttribute("data-pie-idx", "101");
    const far = document.getElementById("far");
    far.style.left = `${Math.max(4, Math.round(r.left - 160))}px`;
    far.style.top = `${Math.round(r.top + 30)}px`;
    far.setAttribute("data-pie-idx", "102");
  });
  const guard = async (target) => {
    await sendToTab({ type: "pie-surface:page-guard", phase: "begin", target });
    await page.waitForTimeout(120);
    const on = await page.evaluate(() => {
      const h = document.querySelector("[data-pie-overlay-host]");
      return { visibility: getComputedStyle(h).visibility, pointer: getComputedStyle(h).pointerEvents };
    });
    await sendToTab({ type: "pie-surface:page-guard", phase: "end" });
    await page.waitForTimeout(120);
    const off = await page.evaluate(() => getComputedStyle(document.querySelector("[data-pie-overlay-host]")).visibility);
    return { on, off };
  };
  const overlapping = await guard({ frameId: 0, elementIndex: 101 });
  const farAway = await guard({ frameId: 0, elementIndex: 102 });
  const unknown = await guard({ frameId: 9, elementIndex: 101 });
  rec(
    "H3 page guard only when the target meets the card",
    overlapping.on.visibility === "hidden" &&
      overlapping.on.pointer === "none" &&
      overlapping.off === "visible" &&
      farAway.on.visibility === "visible" &&
      unknown.on.visibility === "hidden"
      ? "PASS"
      : "FAIL",
    JSON.stringify({ overlapping, farAway, unknown }),
  );
  await snap(page, "page-guard");
} catch (e) {
  rec("H0 surface rules", "ERROR", e.message);
}

fs.writeFileSync(`${BASE}/report/results.json`, JSON.stringify(results, null, 2));
console.log("\nSUMMARY", results.filter((r) => r.status !== "PASS").length === 0 ? "ALL PASS" : "HAS FAILURES");
await ctx.close();
server.close();
