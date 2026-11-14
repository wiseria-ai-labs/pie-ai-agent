// Overlay screenshots — light/dark × short/long answer, real Chromium.
// Produces the four images the round-4 report references:
//   report/light-short.png  report/light-long.png
//   report/dark-short.png   report/dark-long.png
//
// Run after `pnpm build` — once per theme (a mid-run theme switch needs an
// extra navigation and left the SW handle stale):
//   THEME=light PIE_ACCEPT_BASE=/tmp/pieovl-shots node eval/acceptance/pilot-overlay-screenshots.mjs "$PWD"
//   THEME=dark  PIE_ACCEPT_BASE=/tmp/pieovl-shots node eval/acceptance/pilot-overlay-screenshots.mjs "$PWD"
import fs from "node:fs";
import http from "node:http";
import { chromium } from "playwright";

const REPO = process.argv[2];
const THEME = process.env.THEME === "dark" ? "dark" : "light";
const BASE = process.env.PIE_ACCEPT_BASE || "/tmp/pieovl-shots";
const DIST = `${REPO}/dist`;
const PROFILE = `${BASE}/profile-${THEME}`;
fs.mkdirSync(`${BASE}/report`, { recursive: true });
fs.rmSync(PROFILE, { recursive: true, force: true });
fs.mkdirSync(PROFILE, { recursive: true });

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Overlay screenshots</title>
<style>body{font:16px/1.7 -apple-system,sans-serif;margin:0;padding:56px 64px;max-width:720px;background:#fff;color:#1b1d22}
h1{font-size:28px;margin:0 0 8px}p{color:#3a3f47}</style></head>
<body><h1>季度复盘 · 草稿</h1>
<p>收入侧：本季度新增付费用户 1,284 人，环比增长 18%。主要来源是开发者社区与内容分发的长尾。留存侧：次周留存 41%，比上季度高 3 个点，但第 4 周出现明显回落。</p>
<p>成本侧：推理成本随用量线性增长，单用户成本 0.42 元，比预算高 6%。下季度重点是把缓存命中率从 32% 提到 55%。</p>
<p>风险：渠道集中在两个平台，任一政策变化都会影响获客；团队目前只有一个后端，交付节奏容易被阻塞。</p>
</body></html>`;

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(HTML);
});
await new Promise((r) => server.listen(0, r));
const PORT = server.address().port;

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: { width: 1200, height: 900 },
  locale: "en-US",
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, "--lang=en-US"],
});
let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
const extId = new URL(sw.url()).host;
const page = await ctx.newPage();
page.setDefaultTimeout(15000);

const sendToTab = (msg) =>
  sw.evaluate(async (m) => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return chrome.tabs.sendMessage(tab.id, m);
  }, msg);

const LONG_ANSWER = [
  "把这份草稿拆成四块来看，结论会更清楚。",
  "",
  "**一、增长质量**",
  "新增 1,284 人里，约六成来自开发者社区的长尾内容，三成来自两个集中渠道，剩下一成无法归因。增长本身健康，但来源结构偏窄：两个渠道合计贡献了三成，政策一变就要重做一遍获客。",
  "",
  "**二、留存**",
  "次周 41%、第四周回落，说明首周价值感知够了，但第二个价值点没有接上。建议把「第一次成功任务」的引导从首日延到第 3–5 天，并观察第四周曲线是否抬起来。",
  "",
  "**三、成本**",
  "单用户 0.42 元高预算 6%，主要来自长页面读取与重复上下文。缓存命中率从 32% 到 55% 的目标是合理的：优先缓存系统提示与技能目录这类稳定前缀，命中率提升会更直接。",
  "",
  "**四、组织风险**",
  "单后端 + 集中渠道，两个单点叠在一起。先把发布流程自动化到「一个人也能发」，再谈扩渠道，否则扩得越快，阻塞越频繁。",
  "",
  "**五、下季度的三件事**",
  "1. 缓存前缀分层：系统提示、技能目录、页面快照各一层，先量命中率再谈优化。",
  "2. 第一次成功任务前移到第 3–5 天，配合一封「你还能这样用」的邮件，观察第四周留存。",
  "3. 渠道去集中：把长尾内容的分发做成常规动作，每周固定产出，不再依赖单次爆发。",
  "",
  "**六、需要拍板的取舍**",
  "如果只能做一件，建议先做缓存：它直接改成本，见效在两到三周内，而且不依赖渠道与团队扩容。留存引导更长期，但需要产品与内容同时投入；渠道去集中见效最慢，却是唯一能降低结构性风险的一条。",
  "",
  "把这三件事排进下季度 OKR 时，建议每件只留一个可验收的数字：缓存命中率 55%、第四周留存 +2 个点、单渠道占比低于 25%。数字之外的动作都可以砍。",
].join("\n");

// Theme first: the overlay reads it on mount.
await page.goto(`chrome-extension://${extId}/src/sidepanel/index.html`);
await page.waitForTimeout(2000);
await page.evaluate(
  (value) =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open("pie");
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("config", "readwrite");
        tx.objectStore("config").put({ key: "theme-mode", value });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    }),
  THEME,
);
console.log("theme:", THEME);

const seed = async (messages) =>
  page.evaluate(
    (msgs) =>
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
          const g = indexStore.get("index");
          g.onsuccess = () => {
            const index = Array.isArray(g.result?.value) ? g.result.value.slice() : [];
            const meta = {
              id,
              createdAt: now,
              lastAccessedAt: now,
              status: "active",
              title: "季度复盘 · 草稿",
              messages: msgs,
              pinMode: "auto",
            };
            sessions.put({ id: `${id}:meta`, value: meta });
            sessions.put({
              id: `${id}:agent`,
              value: { agentMessages: [], pendingInstructions: [], stepIndex: 0, hasImageContent: false },
            });
            index.push({ id, lastAccessedAt: now, status: "active", title: meta.title, messageCount: msgs.length });
            indexStore.put({ id: "index", value: index });
            tx.oncomplete = () => {
              db.close();
              resolve(id);
            };
            tx.onerror = () => reject(tx.error);
          };
          g.onerror = () => reject(g.error);
        };
      }),
    messages,
  );

const ask = { role: "user", content: "这段风险部分怎么表述更清楚？" };
const shortId = await seed([
  ask,
  {
    role: "assistant",
    content:
      "把「两个单点」分开写：渠道集中影响获客，单后端影响交付。各给一句影响面，比现在叠在一起更有说服力。",
  },
]);
const longId = await seed([
  ask,
  { role: "assistant", content: LONG_ANSWER },
]);

async function openAndShoot(sessionId, file, { hostDark = false } = {}) {
  await page.goto(`http://localhost:${PORT}/`);
  if (hostDark) {
    // The card must stay transparent over a dark page too (no tinted box).
    await page.addStyleTag({ content: "html,body{background:#14161a;color:#e8eaed}" });
  }
  await page.waitForTimeout(1400); // content script at document_idle
  await sendToTab({
    type: "pie-overlay:open",
    payload: {
      sessionId,
      tabId: 1,
      intent: "ask",
      selection: null,
      prompt: null,
      autoSend: false,
      position: "top",
      resumed: false,
    },
  });
  await page.waitForTimeout(1600); // mount + height bridge + animation
  const frame = page.frames().find((f) => f.url().includes("src/overlay/index.html"));
  if (!frame) throw new Error("overlay frame did not mount");
  const geom = await frame.evaluate(() => ({
    scheme: getComputedStyle(document.documentElement).colorScheme,
    cardH: Math.round(document.querySelector("[data-card]").getBoundingClientRect().height),
    frameH: Math.round(window.innerHeight),
    scrolls:
      (() => {
        const el = document.querySelector("[data-thread]");
        return el ? el.scrollHeight > el.clientHeight + 4 : false;
      })(),
  }));
  const path = `${BASE}/report/${file}`;
  await page.screenshot({ path });
  console.log(`[shot] ${path}`, JSON.stringify(geom));
  // Close without tearing the conversation down (retention keeps it).
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
}

await openAndShoot(shortId, `${THEME}-short.png`);
await openAndShoot(longId, `${THEME}-long.png`);
// Light card on a dark host page — the round-4 report's fourth corner case.
if (THEME === "light") await openAndShoot(shortId, "host-dark-short.png", { hostDark: true });

console.log("\nDONE");
await ctx.close();
server.close();
