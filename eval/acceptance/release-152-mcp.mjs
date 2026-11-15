#!/usr/bin/env node
// v1.5.2 发版真机验收（H 区可自动化部分 + 远程 MCP #481 全链路）。
//   H01 设置根页 + MCP 页 + Chat 在 420×900 面板里排版
//   H02 Pie Link 开关在位（原生权限弹框 Playwright 点不了 → 记 SKIP）
//   H04/H05 MCP 确认卡真人点按钮（真 sidepanel tab，不是 headless）
//   远程 MCP：加 server → 测试连接（401 → 加头成功）→ 真模型 load_tools → 首调确认卡
//            → read_document 内容回灌 → append_text 落盘 → token 不外泄
//
//   export PIE_ACCEPT_BASE=/tmp/pie152 && set -a; source ~/.pie/acceptance.env; set +a
//   pnpm build:eval && node eval/acceptance/release-152-mcp.mjs
import fs from "node:fs";
import { spawn } from "node:child_process";
import {
  prepareWorkspace, launch, sleep, REPO,
  smokeProvider, smokeModel, smokeApiKey, goSettingsRoot,
} from "./release-smoke/lib.mjs";

const BASE = process.env.PIE_ACCEPT_BASE;
if (!BASE) throw new Error("PIE_ACCEPT_BASE 未设置");
const PROVIDER = smokeProvider();
const MODEL = smokeModel();
const API_KEY = smokeApiKey();
if (!API_KEY) throw new Error("PIE_EVAL_API_KEY 为空 —— LLM 批必须有真模型");

const REPORT = `${BASE}/report`;
fs.mkdirSync(REPORT, { recursive: true });
const results = [];
const rec = (id, status, note = "") => { results.push({ id, status, note }); console.log(`[${status}] ${id} — ${note}`); };

const SECRET = "SMOKE-SECRET-7f3a";
const STATE = `${BASE}/mcp/docs.json`;
fs.rmSync(STATE, { force: true });
const server = spawn(process.execPath,
  [`${REPO}/eval/acceptance/mcp-fixture-server.mjs`, "--port", "7801", "--name", "docs",
    "--state", STATE, "--auth", SECRET],
  { stdio: "ignore" });
await sleep(600);
const stopServer = () => { try { server.kill(); } catch {} };

let ctx;
try {
  prepareWorkspace(BASE);
  const launched = await launch(BASE, { profile: "profile-152", dist: `${BASE}/dist-pilot` });
  ctx = launched.ctx;
  const { page, sw } = launched;

  // H01 — 真扩展页在 420×900 下渲染，无横向溢出
  await sleep(1500);

  // seed 模型配置（三坑：等 SW 落定 → seed → 补 index + last_model_selection）
  await sleep(3000);
  for (let i = 0; i < 20; i++) {
    if (await sw.evaluate(() => typeof globalThis.__pieEval !== "undefined")) break;
    await sleep(250);
  }
  const { instanceId } = await sw.evaluate((cfg) => globalThis.__pieEval.seedConfig(cfg),
    { provider: PROVIDER, model: MODEL, apiKey: API_KEY });
  await sw.evaluate((args) => new Promise((resolve, reject) => {
    const req = indexedDB.open("pie");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction("config", "readwrite");
      tx.objectStore("config").put({ key: "last_model_selection", value: { instanceId: args.instanceId, model: args.model } });
      tx.objectStore("config").put({ key: "instances_index", value: [args.instanceId] });
      tx.oncomplete = () => resolve(null);
      tx.onerror = () => reject(tx.error);
    };
  }), { instanceId, model: MODEL });
  console.log(`  [seed] ${PROVIDER}/${MODEL}`);
  await page.reload();
  await sleep(1500);

  const overflow = async () => page.evaluate(() => ({
    docW: document.documentElement.scrollWidth,
    winW: window.innerWidth,
    docH: document.documentElement.scrollHeight,
    winH: window.innerHeight,
  }));

  // 进 chat
  for (let i = 0; i < 6; i++) {
    if (await page.getByTestId("chat-composer").count()) break;
    if (await page.getByTestId("topbar-back").count()) await page.getByTestId("topbar-back").click();
    await sleep(400);
  }
  await page.getByTestId("chat-composer").waitFor();
  let o = await overflow();
  await page.screenshot({ path: `${REPORT}/152-H01-chat.png` });
  rec("H01-chat", o.docW <= o.winW ? "PASS" : "FAIL", `chat ${o.winW}×${o.winH} docW=${o.docW} docH=${o.docH}`);

  // 设置根页
  await goSettingsRoot(page);
  await page.getByTestId("settings-row-mcp").waitFor();
  o = await overflow();
  await page.screenshot({ path: `${REPORT}/152-H01-settings.png` });
  rec("H01-settings", o.docW <= o.winW ? "PASS" : "FAIL", `settings docW=${o.docW}/${o.winW} docH=${o.docH}`);

  // H02 — Pie Link 开关在位（点它弹的是浏览器原生框，Playwright 点不了 → SKIP）
  const bridgeRow = await page.getByTestId("settings-row-bridge").count().catch(() => 0);
  const bridgeText = bridgeRow ? await page.getByTestId("settings-row-bridge").innerText() : "";
  rec("H02", "SKIP", `Pie Link 行${bridgeRow ? "在位" : "不在位"}（${bridgeText.replace(/\s+/g, " ").slice(0, 60)}）；原生权限弹框只能人手点`);

  // ── MCP 页 ────────────────────────────────────────────────────────
  await page.getByTestId("settings-row-mcp").click();
  await page.getByTestId("settings-page-mcp").waitFor();
  rec("MCP-1", (await page.getByTestId("mcp-empty").count()) ? "PASS" : "FAIL", "初始空态");

  const editor = page.getByTestId("mcp-editor");
  if (!(await editor.isVisible().catch(() => false))) await page.getByTestId("mcp-add-server").click();
  await page.getByTestId("mcp-name-input").fill("Docs");
  await page.getByTestId("mcp-url-input").fill(`http://127.0.0.1:7801/mcp`);
  await page.getByTestId("mcp-save").click();
  await page.getByTestId("mcp-server-docs").waitFor();
  rec("MCP-2", "PASS", "添加 server：名称 Docs → slug docs，http loopback 放行");

  // 先不带头测连接 → 401 + 提示
  await page.getByTestId("mcp-test-docs").click();
  await page.getByTestId("mcp-test-result-docs").waitFor();
  const r401 = await page.getByTestId("mcp-test-result-docs").innerText();
  rec("MCP-3", /401/.test(r401) ? "PASS" : "FAIL", `无凭据测试连接：${r401.replace(/\s+/g, " ").slice(0, 160)}`);

  // 加 Authorization 头后重测 → 工具列表 + 已跳过
  await page.getByTestId("mcp-edit-docs").click();
  await page.getByTestId("mcp-add-header").click();
  await page.getByTestId("mcp-header-key-0").fill("Authorization");
  await page.getByTestId("mcp-header-value-0").fill(`Bearer ${SECRET}`);
  await page.getByTestId("mcp-save").click();
  await page.getByTestId("mcp-server-docs").waitFor();
  await page.getByTestId("mcp-test-docs").click();
  await page.getByTestId("mcp-test-result-docs").waitFor();
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="mcp-test-result-docs"]');
    return el && /read_document/.test(el.textContent || "");
  }, null, { timeout: 20000 }).catch(() => {});
  const rOk = await page.getByTestId("mcp-test-result-docs").innerText();
  const has3 = ["read_document", "append_text", "search"].every((n) => rOk.includes(n));
  const skipped = /broken_schema/.test(rOk) && /huge_schema/.test(rOk);
  await page.screenshot({ path: `${REPORT}/152-MCP-test.png` });
  const secretsInUi = (await page.evaluate(() => document.body.innerText)).includes(SECRET);
  rec("MCP-4", has3 && skipped && !secretsInUi ? "PASS" : "FAIL",
    `带 Bearer 后测试：三工具${has3 ? "齐" : "缺"}、坏/additionalProperties 超大 schema ${skipped ? "进已跳过" : "未跳过"}、页面文本含 SECRET=${secretsInUi}`);

  // 密文落库
  const stored = await page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open("pie");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const g = req.result.transaction("config", "readonly").objectStore("config").get("mcp_servers");
      g.onsuccess = () => { req.result.close(); resolve(g.result?.value ?? null); };
      g.onerror = () => { req.result.close(); reject(g.error); };
    };
  }));
  const raw = JSON.stringify(stored ?? {});
  rec("MCP-5", stored && !raw.includes(SECRET) && /encryptedHeaders/.test(raw) ? "PASS" : "FAIL",
    `IDB mcp_servers：headerKeys=${JSON.stringify(stored?.[0]?.headerKeys)} 密文=${Boolean(stored?.[0]?.encryptedHeaders)} 明文 SECRET 在库内=${raw.includes(SECRET)}`);

  // ── 回到 chat，真模型走一遍 ──────────────────────────────────────
  for (let i = 0; i < 6; i++) {
    if (await page.getByTestId("chat-composer").count()) break;
    if (await page.getByTestId("topbar-back").count()) await page.getByTestId("topbar-back").click();
    await sleep(400);
  }
  const box = page.getByTestId("chat-composer");
  await box.waitFor();
  await box.fill("Call load_tools with group \"mcp:docs\", then call the mcp_docs_read_document tool and quote the document text back to me exactly. Do not use any other tools.");
  await page.getByTestId("chat-send").click();

  // 首调确认卡 → 人点 Allow（H04）
  let cardShown = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    if (await page.getByRole("button", { name: "Allow this session", exact: true }).count()) {
      cardShown = true;
      await page.screenshot({ path: `${REPORT}/152-MCP-confirm-card.png` });
      await page.getByRole("button", { name: "Allow this session", exact: true }).click();
      break;
    }
    // 模型可能先问一嘴再调；3 分钟后放弃
    await sleep(500);
  }
  rec("H04-confirm-card", cardShown ? "PASS" : "FAIL", cardShown ? "首调弹 mcp-tool-confirm 卡并点了 Allow" : "180s 内没出现确认卡");

  // 等任务结束（composer 重新可用 或 stop 按钮消失）
  const t1 = Date.now();
  while (Date.now() - t1 < 240000) {
    const stopping = await page.getByTestId("chat-stop").count();
    const sendable = await page.getByTestId("chat-send").count();
    if (!stopping && sendable) break;
    await sleep(500);
  }
  await sleep(1500);
  await page.screenshot({ path: `${REPORT}/152-MCP-chat.png` });

  const panelText = await page.evaluate(() => document.body.innerText);
  const chatOk = /Fixture document|Hello from the MCP fixture/i.test(panelText);
  rec("H05-read", chatOk ? "PASS" : "FAIL",
    `对话里出现 fixture 文档正文=${chatOk}；SECRET 出现在面板文本=${panelText.includes(SECRET)}`);

  // 落库证据：step 里有 mcp_docs_read_document
  const dbDump = await page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open("pie");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const g = req.result.transaction("sessions", "readonly").objectStore("sessions").getAll();
      g.onsuccess = () => { req.result.close(); resolve(JSON.stringify(g.result)); };
      g.onerror = () => { req.result.close(); reject(g.error); };
    };
  }));
  fs.writeFileSync(`${REPORT}/152-sessions.json`, dbDump);
  const toolCalled = /mcp_docs_read_document/.test(dbDump);
  rec("H05-tool-name", toolCalled ? "PASS" : "FAIL", `IDB sessions 里出现 mcp_docs_read_document=${toolCalled}（152-sessions.json）`);
  rec("MCP-secret-leak", !dbDump.includes(SECRET) && !panelText.includes(SECRET) ? "PASS" : "FAIL",
    `SECRET 在 IDB sessions=${dbDump.includes(SECRET)} / 面板文本=${panelText.includes(SECRET)}`);

  // ── append_text 真落盘 ───────────────────────────────────────────
  const before = fs.existsSync(STATE) ? fs.readFileSync(STATE, "utf8") : "";
  await box.fill("Now call the mcp_docs_append_text tool with text \"Added by v1.5.2 real-machine check\" and then tell me it is done. Use only that tool.");
  await page.getByTestId("chat-send").click();
  const t2 = Date.now();
  while (Date.now() - t2 < 240000) {
    const stopping = await page.getByTestId("chat-stop").count();
    const sendable = await page.getByTestId("chat-send").count();
    if (!stopping && sendable) break;
    await sleep(500);
  }
  await sleep(1000);
  const after = fs.existsSync(STATE) ? fs.readFileSync(STATE, "utf8") : "";
  const appended = /Added by v1\.5\.2 real-machine check/.test(after);
  rec("H05-append", appended ? "PASS" : "FAIL",
    `state 文件 ${STATE}：追加前 ${before.length}B → 追加后 ${after.length}B，含追加文本=${appended}`);
  await page.screenshot({ path: `${REPORT}/152-MCP-final.png` });
} catch (e) {
  console.error("FATAL", e);
  rec("FATAL", "ERROR", e.message);
} finally {
  fs.writeFileSync(`${REPORT}/results-152.json`, JSON.stringify({ results }, null, 2));
  const bad = results.filter((r) => r.status === "FAIL" || r.status === "ERROR");
  console.log(`\n=== ${results.length} 条，FAIL/ERROR ${bad.length} 条 ===`);
  try { await ctx?.close(); } catch {}
  stopServer();
}
