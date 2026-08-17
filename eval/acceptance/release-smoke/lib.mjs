// Shared harness for the release-smoke suite.
// Recipe (scratch HOME, NM promote, locale, seed timing) matches
// docs/agents/auto-acceptance.md.
import { chromium } from "playwright";
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXT_ID = "gpccjhdgjkmalnepmeclooflliiocfed";
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function loadAcceptanceEnv() {
  const envPath = `${process.env.HOME}/.pie/acceptance.env`;
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

export function smokeProvider() {
  return process.env.PIE_EVAL_PROVIDER || process.env.OPENROUTER_API_KEY && "openrouter" || "openrouter";
}

export function smokeApiKey() {
  return process.env.PIE_EVAL_API_KEY || process.env.OPENROUTER_API_KEY || "";
}

export function smokeModel() {
  return process.env.PIE_EVAL_MODEL || "openai/gpt-4o-mini";
}

export function secondProvider(primary) {
  return primary === "openai" ? "anthropic" : "openai";
}

export function createRecorder(reportDir) {
  const results = [];
  let shot = 0;
  return {
    results,
    record(item, status, note = "") {
      results.push({ item, status, note });
      console.log(`[${status}] ${item}${note ? ` — ${note}` : ""}`);
    },
    async snap(page, name) {
      shot += 1;
      const file = `${reportDir}/${String(shot).padStart(2, "0")}-${name}.png`;
      try {
        await page.screenshot({ path: file, fullPage: false });
      } catch {
        /* page may already be closed */
      }
    },
    hardFails() {
      return results.filter((r) => {
        const hard = r.item.startsWith("F") || r.item.startsWith("P");
        return hard && (r.status === "FAIL" || r.status === "ERROR");
      });
    },
    write(extra = {}) {
      const out = { generatedAt: new Date().toISOString(), ...extra, results };
      fs.writeFileSync(`${reportDir}/results.json`, JSON.stringify(out, null, 2));
      const lines = [
        "## 发版真机冒烟报告",
        "",
        `环境：Playwright Chromium · ${extra.envNote ?? ""}`,
        `模型：${extra.model ?? "(none)"}`,
        "",
        "| ID | 结果 | 证据 |",
        "|---|---|---|",
        ...results.map((r) => `| ${r.item} | ${r.status} | ${(r.note || "").replace(/\|/g, "/")} |`),
        "",
        "**留人工**：品牌 Chrome 真 side panel、optional 权限弹框、本发版若动过则抽 PDF / HITL",
        "",
      ];
      const hard = out.results.filter((r) => (r.item.startsWith("F") || r.item.startsWith("P")) && (r.status === "FAIL" || r.status === "ERROR"));
      const envErrors = hard.filter((r) => /环境|API key|acceptance.env|dist-eval|dist\//i.test(r.note));
      const productHard = hard.filter((r) => !envErrors.includes(r));
      if (productHard.length === 0) {
        lines.push("结论：冒烟通过，建议抽查 H 区后打 tag");
      } else {
        lines.push("结论：存在硬挡 FAIL，不能打 tag");
      }
      fs.writeFileSync(`${reportDir}/report.md`, lines.join("\n"));
      return { productHard, envErrors };
    },
  };
}

export function prepareWorkspace(base) {
  fs.mkdirSync(`${base}/report`, { recursive: true });
  fs.mkdirSync(`${base}/home/.pie`, { recursive: true });
  const distEval = `${REPO}/dist-eval`;
  const distProd = `${REPO}/dist`;
  if (!fs.existsSync(`${distEval}/manifest.json`)) {
    throw new Error(`dist-eval 不存在——先在仓库根跑 pnpm build:eval`);
  }
  for (const name of ["dist-pilot", "dist-orig"]) {
    const dst = `${base}/${name}`;
    fs.rmSync(dst, { recursive: true, force: true });
    fs.cpSync(distEval, dst, { recursive: true });
  }
  {
    const mfPath = `${base}/dist-pilot/manifest.json`;
    const mf = JSON.parse(fs.readFileSync(mfPath, "utf8"));
    mf.optional_permissions = (mf.optional_permissions ?? []).filter((p) => p !== "nativeMessaging");
    if (mf.optional_permissions.length === 0) delete mf.optional_permissions;
    mf.permissions = mf.permissions ?? [];
    if (!mf.permissions.includes("nativeMessaging")) mf.permissions.push("nativeMessaging");
    fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2));
  }
  if (fs.existsSync(`${distProd}/manifest.json`)) {
    const dst = `${base}/dist-prod`;
    fs.rmSync(dst, { recursive: true, force: true });
    fs.cpSync(distProd, dst, { recursive: true });
  }
  fs.copyFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "fixture.html"),
    `${base}/fixture.html`,
  );
  fs.writeFileSync(
    `${base}/host-wrapper.sh`,
    `#!/bin/bash\nexport HOME=${base}/home\nexec bun ${REPO}/daemon/src/cli.ts host\n`,
    { mode: 0o755 },
  );
}

const NM_MANIFEST = (base) =>
  JSON.stringify({
    name: "ai.wiseria.pie",
    description: "Pie daemon bridge (release-smoke scratch)",
    path: `${base}/host-wrapper.sh`,
    type: "stdio",
    allowed_origins: [`chrome-extension://${EXT_ID}/`],
  });

export async function launch(base, { profile, dist }) {
  const profileDir = `${base}/${profile}`;
  fs.mkdirSync(`${profileDir}/NativeMessagingHosts`, { recursive: true });
  fs.writeFileSync(`${profileDir}/NativeMessagingHosts/ai.wiseria.pie.json`, NM_MANIFEST(base));
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 420, height: 900 },
    locale: "en-US",
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--lang=en-US"],
  });
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(`chrome-extension://${extId}/src/sidepanel/index.html`);
  return { ctx, page, sw, extId };
}

export async function waitSwReady(sw, ms = 3500) {
  await sleep(ms);
  return sw;
}

export function killDaemon() {
  try {
    execSync(`pkill -f "daemon/src/cli.ts daemon"`);
  } catch {
    /* already dead */
  }
}

export function startDaemon(base) {
  const p = spawn("bun", [`${REPO}/daemon/src/cli.ts`, "daemon"], {
    env: { ...process.env, HOME: `${base}/home` },
    detached: true,
    stdio: "ignore",
  });
  p.unref();
}

export const sockExists = (base) => fs.existsSync(`${base}/home/.pie/daemon.sock`);

export async function idbConfigGet(page, key) {
  return page.evaluate(
    (k) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open("pie");
        req.onsuccess = () => {
          const tx = req.result.transaction("config", "readonly");
          const r = tx.objectStore("config").get(k);
          r.onsuccess = () => resolve(r.result ? r.result.value : null);
          r.onerror = () => reject(r.error);
        };
        req.onerror = () => reject(req.error);
      }),
    key,
  );
}

export async function idbGetAll(page, store) {
  return page.evaluate(
    (s) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open("pie");
        req.onsuccess = () => {
          const tx = req.result.transaction(s, "readonly");
          const r = tx.objectStore(s).getAll();
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        };
        req.onerror = () => reject(req.error);
      }),
    store,
  );
}

export async function listInstanceIds(page) {
  const idx = await idbConfigGet(page, "instances_index");
  return Array.isArray(idx) ? idx : [];
}

export async function goChat(page) {
  for (let i = 0; i < 4; i++) {
    if (await page.getByTestId("chat-open-settings").count()) return;
    if (await page.getByTestId("chat-composer").count()) return;
    if (await page.getByTestId("topbar-back").count()) {
      await page.getByTestId("topbar-back").click();
      await sleep(250);
      continue;
    }
    break;
  }
}

export async function goSettingsRoot(page) {
  if (await page.getByTestId("settings-row-models").count()) return;
  if (await page.getByTestId("settings-page-root").count()) return;
  if (await page.getByTestId("topbar-back").count() && (await page.getByTestId("settings-page-models").count() || await page.locator("[data-testid^='settings-page-']").count())) {
    await page.getByTestId("topbar-back").click();
    await page.getByTestId("settings-row-models").waitFor();
    return;
  }
  if (await page.getByTestId("chat-open-settings").count()) {
    await page.getByTestId("chat-open-settings").click();
    await page.getByTestId("settings-row-models").waitFor();
    return;
  }
  await page.getByTestId("topbar-drawer").click();
  await page.getByTestId("drawer-settings").click();
  await page.getByTestId("settings-row-models").waitFor();
}

export async function openSettingsPage(page, id) {
  await goSettingsRoot(page);
  await page.getByTestId(`settings-row-${id}`).click();
  await page.getByTestId(`settings-page-${id}`).waitFor();
}

export async function seedSessions(page, titles) {
  return page.evaluate((names) => {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("pie");
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(["sessions", "session_index"], "readwrite");
        const sessions = tx.objectStore("sessions");
        const indexStore = tx.objectStore("session_index");
        const now = Date.now();
        const indexReq = indexStore.get("index");
        indexReq.onsuccess = () => {
          const index = Array.isArray(indexReq.result?.value) ? indexReq.result.value.slice() : [];
          const created = [];
          for (let i = 0; i < names.length; i++) {
            const id = crypto.randomUUID();
            const meta = {
              id,
              createdAt: now + i,
              lastAccessedAt: now + i,
              status: "active",
              title: names[i],
              messages: [{ role: "user", content: `seed ${names[i]}` }],
              pinMode: "auto",
            };
            sessions.put({ id: `${id}:meta`, value: meta });
            sessions.put({
              id: `${id}:agent`,
              value: { agentMessages: [], pendingInstructions: [], stepIndex: 0, hasImageContent: false },
            });
            index.push({
              id,
              lastAccessedAt: now + i,
              status: "active",
              title: names[i],
              messageCount: 1,
            });
            created.push(id);
          }
          indexStore.put({ id: "index", value: index });
          tx.oncomplete = () => resolve(created);
          tx.onerror = () => reject(tx.error);
        };
      };
    });
  }, titles);
}

export function hasEvalBridge(sw) {
  return sw.evaluate(() => typeof globalThis.__pieEval !== "undefined");
}

/** Serve fixture.html on 127.0.0.1 (file:// is blocked for the agent). */
export function startFixtureServer(base) {
  const html = fs.readFileSync(path.join(base, "fixture.html"));
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}
