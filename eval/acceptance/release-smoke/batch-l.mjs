import { sleep, goChat, goSettingsRoot } from "./lib.mjs";

async function send(page, text) {
  const box = page.getByTestId("chat-composer");
  await box.click();
  await box.fill(text);
  await page.getByTestId("chat-send").click();
}

async function enableCdp(page) {
  await goSettingsRoot(page);
  const sw = page.getByTestId("cdp-switch");
  const checked = await sw.getAttribute("aria-checked");
  if (checked !== "true") await sw.click();
  await goChat(page);
}

export async function runLlm({ page, ctx, rec, snap, base, fixtureUrl }) {
  await goChat(page);
  if (!(await page.getByTestId("chat-composer").count())) {
    for (const id of ["L01", "L02", "L03", "L04", "L05"]) {
      rec(id, "ERROR", "composer 不可用（F07 没过？）");
    }
    return;
  }

  await enableCdp(page).catch(() => {});

  try {
    await send(page, "Reply with the single word PONG and nothing else.");
    const working = page.getByRole("status");
    let sawWorking = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      if (await working.count()) sawWorking = true;
      if (sawWorking && !(await page.getByTestId("chat-stop").count())) break;
      await sleep(400);
    }
    const failed = await page.getByText("FAILED", { exact: true }).count();
    const keyErr = await page.getByText(/Invalid .* API key/i).count();
    const pongOutsidePrompt = await page.evaluate(() => {
      const bubbles = [...document.querySelectorAll("p, div, span")];
      return bubbles.some((el) => {
        const t = (el.textContent || "").trim();
        return t === "PONG" || t === "pong";
      });
    });
    const ok = keyErr === 0 && failed === 0 && (pongOutsidePrompt || sawWorking);
    rec("L01", ok ? "PASS" : "FAIL", `working=${sawWorking} pong=${pongOutsidePrompt} failed=${failed} keyErr=${keyErr}`);
    await snap(page, "L01");
  } catch (e) {
    rec("L01", "ERROR", e.message);
    await snap(page, "err-L01");
  }

  try {
    await page.getByTestId("topbar-new").click();
    await sleep(300);
    await send(page, "Count slowly from 1 to 80, writing a short sentence for each number.");
    await page.getByTestId("chat-stop").waitFor({ timeout: 30000 });
    await page.getByTestId("chat-stop").click();
    await sleep(800);
    const still = await page.getByTestId("chat-stop").count();
    const composerOn = await page.getByTestId("chat-composer").isEnabled();
    rec("L02", still === 0 && composerOn ? "PASS" : "FAIL", `stopRemaining=${still} composerEnabled=${composerOn}`);
    await snap(page, "L02");
  } catch (e) {
    rec("L02", "ERROR", e.message);
    await snap(page, "err-L02");
  }

  let fixturePage = null;
  try {
    if (!fixtureUrl) throw new Error("fixtureUrl missing");
    fixturePage = await ctx.newPage();
    await fixturePage.goto(fixtureUrl);
    // Activate the fixture tab so the loop pins it — do NOT bring the
    // sidepanel tab to front (that would pin chrome-extension://… "Pie").
    await page.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find((x) => x.url && x.url.startsWith(url));
      if (t?.id) await chrome.tabs.update(t.id, { active: true });
    }, fixtureUrl);
    await goChat(page);
    await page.getByTestId("topbar-new").click();
    await sleep(400);
    await send(
      page,
      "Read the currently focused page. Click the button with id smoke-target. Then call done. Do not ask questions.",
    );
    const t0 = Date.now();
    let smoked = false;
    while (Date.now() - t0 < 180000) {
      smoked = await fixturePage.evaluate(() => document.getElementById("smoke-target")?.dataset.smoked === "1");
      if (smoked) break;
      const working = await page.getByTestId("chat-stop").count();
      if (!working && Date.now() - t0 > 25000) break;
      await sleep(800);
    }
    rec("L03", smoked ? "PASS" : "FAIL", `fixture data-smoked=${smoked} url=${fixtureUrl}`);
    await snap(page, "L03-panel");
    await fixturePage.screenshot({ path: `${base}/report/L03-fixture.png` }).catch(() => {});
  } catch (e) {
    rec("L03", "ERROR", e.message);
    await snap(page, "err-L03");
  }

  try {
    await send(page, "What was the heading you just read?");
    await sleep(1500);
    const idx = await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const req = indexedDB.open("pie");
          req.onsuccess = () => {
            const tx = req.result.transaction("session_index", "readonly");
            const r = tx.objectStore("session_index").get("index");
            r.onsuccess = () => resolve(r.result?.value ?? []);
            r.onerror = () => reject(r.error);
          };
          req.onerror = () => reject(req.error);
        }),
    );
    const active = (idx || []).filter((e) => e.status === "active" && (e.messageCount ?? 0) > 0);
    const users = await page.getByText("What was the heading you just read?").count();
    rec(
      users > 0 ? "L04" : "L04",
      users > 0 ? "PASS" : "FAIL",
      `second prompt in DOM=${users} activeSessionsWithMsgs=${active.length}`,
    );
  } catch (e) {
    rec("L04", "ERROR", e.message);
  }

  try {
    const pin = page.getByTestId("topbar-pin-row");
    const t0 = Date.now();
    let text = "";
    while (Date.now() - t0 < 8000) {
      if (await pin.count()) {
        text = await pin.innerText();
        if (text) break;
      }
      await sleep(300);
    }
    const ok = /127\.0\.0\.1|localhost|smoke fixture/i.test(text);
    rec("L05", ok ? "PASS" : "FAIL", `pin=${text || "(none)"}`);
  } catch (e) {
    rec("L05", "ERROR", e.message);
  }

}
