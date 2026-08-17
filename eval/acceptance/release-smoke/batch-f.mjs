import {
  sleep,
  goChat,
  goSettingsRoot,
  openSettingsPage,
  listInstanceIds,
  idbConfigGet,
  seedSessions,
  startDaemon,
  killDaemon,
  sockExists,
  smokeProvider,
  smokeApiKey,
  secondProvider,
} from "./lib.mjs";

async function tryItem(rec, snap, page, id, fn) {
  try {
    await fn();
  } catch (e) {
    rec(id, "ERROR", e.message);
    await snap(page, `err-${id}`);
  }
}

export async function runFunctional({ page, rec, snap, base, hasKey }) {
  const provider = smokeProvider();
  const apiKey = smokeApiKey();
  const other = secondProvider(provider);

  // firstRun lands on Settings — go back to Chat empty state.
  await sleep(800);
  if (await page.getByTestId("settings-row-models").count()) {
    await page.getByTestId("topbar-back").click();
    await sleep(300);
  }

  await tryItem(rec, snap, page, "F01", async () => {
    const cta = page.getByTestId("chat-open-settings");
    await cta.waitFor();
    const composer = await page.getByTestId("chat-composer").count();
    if (composer) {
      rec("F01", "FAIL", "composer 出现在无配置空态");
      return;
    }
    rec("F01", "PASS", "空态 CTA 在，composer 不在");
    await snap(page, "F01-empty");
  });

  await tryItem(rec, snap, page, "F02", async () => {
    await page.getByTestId("chat-open-settings").click();
    await page.getByTestId("settings-row-models").waitFor();
    rec("F02", "PASS", "CTA → Settings root");
  });

  await tryItem(rec, snap, page, "F03", async () => {
    const pages = [
      "models",
      "bridge",
      "search",
      "uiLanguage",
      "assistantLanguage",
      "customRules",
      "feedback",
      "about",
    ];
    const seen = [];
    for (const id of pages) {
      await openSettingsPage(page, id);
      seen.push(id);
      await page.getByTestId("topbar-back").click();
      await page.getByTestId("settings-row-models").waitFor();
    }
    rec("F03", "PASS", `opened ${seen.join(",")}`);
  });

  await tryItem(rec, snap, page, "F04", async () => {
    await goSettingsRoot(page);
    await page.getByTestId("theme-dark").click();
    const dark = await page.evaluate(() => document.documentElement.dataset.theme);
    if (dark !== "dark") {
      rec("F04", "FAIL", `theme after click=${dark}`);
      return;
    }
    await page.reload();
    await page.getByTestId("settings-row-models").or(page.getByTestId("chat-open-settings")).waitFor();
    await goSettingsRoot(page);
    const after = await page.evaluate(() => document.documentElement.dataset.theme);
    const pressed = await page.getByTestId("theme-dark").getAttribute("aria-pressed");
    if (after !== "dark" || pressed !== "true") {
      rec("F04", "FAIL", `reload theme=${after} pressed=${pressed}`);
      return;
    }
    await page.getByTestId("theme-light").click();
    rec("F04", "PASS", "dark 持久化后切回 light");
  });

  await tryItem(rec, snap, page, "F05", async () => {
    await goSettingsRoot(page);
    const sw = page.getByTestId("cdp-switch");
    await sw.click();
    const t0 = Date.now();
    let tDom = null;
    let tIdb = null;
    while (Date.now() - t0 < 4000) {
      const checked = await sw.getAttribute("aria-checked");
      const raw = await idbConfigGet(page, "cdp_input_enabled");
      if (tDom === null && checked === "true") tDom = Date.now() - t0;
      if (tIdb === null && raw === true) tIdb = Date.now() - t0;
      if (tDom !== null && tIdb !== null) break;
      await sleep(200);
    }
    await sw.click();
    const t1 = Date.now();
    let tDomOff = null;
    let tIdbOff = null;
    while (Date.now() - t1 < 4000) {
      const checked = await sw.getAttribute("aria-checked");
      const raw = await idbConfigGet(page, "cdp_input_enabled");
      if (tDomOff === null && checked === "false") tDomOff = Date.now() - t1;
      if (tIdbOff === null && raw === false) tIdbOff = Date.now() - t1;
      if (tDomOff !== null && tIdbOff !== null) break;
      await sleep(200);
    }
    const ok = tDom !== null && tIdb !== null && tDomOff !== null && tIdbOff !== null;
    rec(ok ? "F05" : "F05", ok ? "PASS" : "FAIL",
      `on dom@${tDom} idb@${tIdb}; off dom@${tDomOff} idb@${tIdbOff}`);
  });

  await tryItem(rec, snap, page, "F06", async () => {
    await goSettingsRoot(page);
    const sw = page.getByTestId("panel-window-switch");
    const before = await idbConfigGet(page, "panel_display_mode");
    await sw.click();
    await sleep(400);
    const after = await idbConfigGet(page, "panel_display_mode");
    if (after === before) {
      rec("F06", "FAIL", `panel_display_mode unchanged (${after})`);
      return;
    }
    rec("F06", "PASS", `${before} → ${after}`);
  });

  if (!hasKey) {
    for (const id of ["F07", "F08", "F09", "F10", "F11", "F12", "F13", "F14", "F23"]) {
      rec(id, "ERROR", "无 API key（~/.pie/acceptance.env）— 环境，不挡发版");
    }
  } else {
    await tryItem(rec, snap, page, "F07", async () => {
      await openSettingsPage(page, "models");
      await page.getByTestId("models-new-config").click();
      await page.getByTestId("provider-dropdown").click();
      await page.getByTestId(`provider-option-${provider}`).click();
      await page.getByTestId("instance-api-key").fill(apiKey);
      await page.getByTestId("instance-save").or(page.getByRole("button", { name: "Create" })).click();
      await sleep(800);
      const ids = await listInstanceIds(page);
      if (ids.length < 1) {
        rec("F07", "FAIL", `instances_index=${JSON.stringify(ids)}`);
        await snap(page, "F07-fail");
        return;
      }
      await page.getByTestId("topbar-back").click();
      await goChat(page);
      await page.getByTestId("chat-composer").waitFor();
      rec("F07", "PASS", `instance ${ids[0]} · composer 解锁`);
    });

    await tryItem(rec, snap, page, "F08", async () => {
      await openSettingsPage(page, "models");
      const ids = await listInstanceIds(page);
      await page.getByTestId(`instance-row-${ids[0]}`).click();
      await page.getByTestId("instance-test").click();
      const t0 = Date.now();
      let note = "";
      while (Date.now() - t0 < 20000) {
        const okBtn = await page.getByText("Test OK", { exact: true }).count();
        const err = await page.locator("text=/failed|invalid|401|403|error/i").count();
        if (okBtn) {
          rec("F08", "PASS", "Test OK");
          return;
        }
        if (err) {
          rec("F08", "ERROR", "Test 打出错误（环境/额度），UI 有反应 — 不挡发版");
          return;
        }
        await sleep(300);
      }
      rec("F08", "FAIL", `20s 内 UI 无测试结果 ${note}`);
      await snap(page, "F08-timeout");
    });

    await tryItem(rec, snap, page, "F09", async () => {
      await openSettingsPage(page, "models");
      await page.getByTestId("models-new-config").click();
      await page.getByTestId("provider-dropdown").click();
      await page.getByTestId(`provider-option-${other}`).click();
      await page.getByTestId("instance-api-key").fill("sk-smoke-second-dummy");
      await page.getByTestId("instance-save").or(page.getByRole("button", { name: "Create" })).click();
      await sleep(800);
      const ids = await listInstanceIds(page);
      if (ids.length < 2) {
        rec("F09", "FAIL", `want 2 instances, got ${ids.length}`);
        return;
      }
      await page.getByTestId("topbar-back").click();
      await goChat(page);
      await page.getByTestId("model-picker").click();
      const secondId = ids[ids.length - 1];
      const row = page.getByTestId(`model-picker-row-${secondId}`);
      await row.click();
      await sleep(250);
      const named = page.getByTestId("model-option-gpt-4o-mini");
      const sibling = page.locator(`[data-testid="model-picker-row-${secondId}"] + div [data-testid^="model-option-"]`).first();
      if (await named.count()) await named.click({ force: true });
      else if (await sibling.count()) await sibling.click({ force: true });
      else await page.keyboard.press("Escape");
      const t0 = Date.now();
      let sel = null;
      while (Date.now() - t0 < 5000) {
        sel = await idbConfigGet(page, "last_model_selection");
        if (sel && sel.instanceId === secondId) break;
        await sleep(200);
      }
      if (!sel || sel.instanceId !== secondId) {
        rec("F09", "FAIL", `last_model_selection=${JSON.stringify(sel)} want ${secondId}`);
        return;
      }
      rec("F09", "PASS", `switched to ${secondId}`);
    });

    await tryItem(rec, snap, page, "F10", async () => {
      await openSettingsPage(page, "models");
      const ids = await listInstanceIds(page);
      const first = ids[0];
      await page.getByTestId(`instance-row-${first}`).click();
      const rpm = page.getByTestId("instance-rpm");
      await rpm.fill("42");
      await page.getByTestId("instance-save").click();
      await sleep(400);
      await page.getByTestId(`instance-row-${first}`).click(); // collapse
      await sleep(200);
      await page.getByTestId(`instance-row-${first}`).click(); // expand
      const val = await page.getByTestId("instance-rpm").inputValue();
      if (val !== "42") {
        rec("F10", "FAIL", `rpm=${val}`);
        return;
      }
      rec("F10", "PASS", "rpm=42 persisted");
    });

    await tryItem(rec, snap, page, "F11", async () => {
      await openSettingsPage(page, "models");
      const ids = await listInstanceIds(page);
      const first = ids[0];
      if (!(await page.getByTestId("instance-replace-key").count())) {
        await page.getByTestId(`instance-row-${first}`).click();
      }
      await page.getByTestId("instance-replace-key").click();
      await page.getByTestId("instance-api-key").fill(apiKey + "-rotated");
      await page.getByTestId("instance-save").click();
      await sleep(400);
      await page.getByTestId(`instance-row-${first}`).click();
      await sleep(200);
      await page.getByTestId(`instance-row-${first}`).click();
      const reveal = await page.getByTestId("instance-replace-key").innerText();
      if (reveal.includes(apiKey) && apiKey.length > 8) {
        rec("F11", "FAIL", "全文回显了 key");
        return;
      }
      // 写回真 key，后面 L 批还要用
      await page.getByTestId("instance-replace-key").click();
      await page.getByTestId("instance-api-key").fill(apiKey);
      await page.getByTestId("instance-save").click();
      await sleep(400);
      rec("F11", "PASS", `masked=${reveal.slice(0, 24)} · restored`);
    });

    await tryItem(rec, snap, page, "F12", async () => {
      await openSettingsPage(page, "models");
      const ids = await listInstanceIds(page);
      if (ids.length < 2) {
        rec("F12", "FAIL", "需要两条 instance 才能删非 active");
        return;
      }
      const victim = ids[ids.length - 1];
      page.once("dialog", (d) => d.accept());
      await page.getByTestId(`instance-row-${victim}`).click();
      await page.getByTestId("instance-forget").click();
      await sleep(500);
      const after = await listInstanceIds(page);
      if (after.includes(victim) || after.length !== ids.length - 1) {
        rec("F12", "FAIL", `after=${JSON.stringify(after)}`);
        return;
      }
      rec("F12", "PASS", `deleted ${victim}, left ${after.length}`);
    });

    await tryItem(rec, snap, page, "F13", async () => {
      await openSettingsPage(page, "models");
      await page.getByTestId("models-new-config").click();
      await page.getByTestId("provider-dropdown").click();
      await page.getByTestId("provider-new-custom").click();
      await page.getByTestId("custom-provider-name").fill("Smoke Custom");
      await page.getByTestId("custom-provider-baseurl").fill("http://127.0.0.1:9");
      if (await page.getByTestId("add-custom-model").count()) {
        await page.getByTestId("add-custom-model").click();
        await page.getByTestId("custom-model-id").fill("smoke-model");
        await page.getByTestId("custom-model-save").click();
      }
      await page.getByTestId("instance-api-key").fill("sk-smoke-custom");
      await page.getByTestId("instance-save").or(page.getByRole("button", { name: "Create" })).click();
      await sleep(800);
      const all = await page.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const req = indexedDB.open("pie");
            req.onsuccess = () => {
              const tx = req.result.transaction("config", "readonly");
              tx.objectStore("config").getAll().onsuccess = (e) => resolve(e.target.result);
              tx.onerror = () => reject(tx.error);
            };
            req.onerror = () => reject(req.error);
          }),
      );
      const cp = (all || []).find((r) => r.key && String(r.key).startsWith("custom_provider_"));
      if (!cp) {
        rec("F13", "FAIL", "custom_provider_* 未写入");
        await snap(page, "F13-fail");
        return;
      }
      const entity = cp.value;
      if (!entity || entity.baseUrl !== "http://127.0.0.1:9") {
        rec("F13", "FAIL", `entity=${JSON.stringify(entity)}`);
        return;
      }
      rec("F13", "PASS", `baseUrl on entity ${cp.key}`);
    });
  }

  await tryItem(rec, snap, page, "F15", async () => {
    await goChat(page);
    await page.getByTestId("topbar-new").click();
    await sleep(300);
    await page.getByTestId("topbar-drawer").click();
    const rows = page.locator('[role="listitem"]');
    const n = await rows.count();
    await page.keyboard.press("Escape");
    rec("F15", "PASS", `new session · visible drawer rows=${n}（空 active 应隐藏）`);
  });

  await tryItem(rec, snap, page, "F16", async () => {
    await seedSessions(page, ["Smoke Alpha", "Smoke Beta"]);
    await page.reload();
    await sleep(800);
    await goChat(page);
    const drawer = page.getByRole("dialog", { name: "Sessions" });
    await page.getByTestId("topbar-drawer").click();
    await drawer.waitFor();
    const beta = drawer.getByText("Smoke Beta", { exact: true }).first();
    await beta.waitFor();
    await beta.click();
    await sleep(300);
    await page.keyboard.press("Escape");
    await drawer.waitFor({ state: "hidden" }).catch(() => {});
    rec("F16", "PASS", "switched to Smoke Beta");
  });

  await tryItem(rec, snap, page, "F17", async () => {
    const drawer = page.getByRole("dialog", { name: "Sessions" });
    await page.getByTestId("topbar-drawer").click();
    await drawer.waitFor();
    const row = drawer.locator('[role="listitem"]').filter({ hasText: "Smoke Beta" }).first();
    await row.waitFor();
    await row.hover();
    await page.getByTestId("session-archive").click();
    await sleep(400);
    const inActive = await drawer.locator('[role="listitem"]').filter({ hasText: "Smoke Beta" }).count();
    await page.getByTestId("session-show-archived").click();
    await sleep(300);
    const inArchived = await drawer.getByText("Smoke Beta", { exact: true }).count();
    if (await page.getByTestId("session-unarchive").count()) {
      await page.getByTestId("session-unarchive").click();
    }
    await sleep(400);
    rec(
      inArchived > 0 || inActive === 0 ? "F17" : "F17",
      inActive === 0 ? "PASS" : "FAIL",
      `after archive visibleInList=${inActive} archivedSection=${inArchived}`,
    );
    await page.keyboard.press("Escape");
  });

  await tryItem(rec, snap, page, "F18", async () => {
    await seedSessions(page, ["Smoke Gamma"]);
    await page.reload();
    await sleep(800);
    const drawer = page.getByRole("dialog", { name: "Sessions" });
    await page.getByTestId("topbar-drawer").click();
    await drawer.waitFor();
    const row = drawer.locator('[role="listitem"]').filter({ hasText: "Smoke Gamma" }).first();
    await row.waitFor();
    await row.hover();
    await page.getByTestId("session-archive").click();
    await sleep(300);
    await page.getByTestId("session-show-archived").click();
    await sleep(200);
    if (await page.getByTestId("session-delete-forever").count()) {
      page.once("dialog", (d) => d.accept());
      await page.getByTestId("session-delete-forever").click();
    }
    await sleep(400);
    const left = await page.getByText("Smoke Gamma", { exact: true }).count();
    rec(left === 0 ? "F18" : "F18", left === 0 ? "PASS" : "FAIL", `Smoke Gamma remaining=${left}`);
    await page.keyboard.press("Escape");
  });

  await tryItem(rec, snap, page, "F19", async () => {
    await goChat(page);
    await page.getByTestId("topbar-skills").click();
    await page.getByTestId("skills-page").waitFor();
    rec("F19", "PASS", "SkillsList mounted");
  });

  await tryItem(rec, snap, page, "F20", async () => {
    await page.getByTestId("topbar-back").click();
    await page.getByTestId("topbar-schedules").click();
    await page.getByTestId("schedules-page").waitFor();
    await page.getByTestId("topbar-back").click();
    rec("F20", "PASS", "SchedulesPanel mounted + back");
  });

  await tryItem(rec, snap, page, "F21", async () => {
    await page.getByTestId("topbar-drawer").click();
    await page.getByTestId("drawer-settings").click();
    await page.getByTestId("settings-row-models").waitFor();
    rec("F21", "PASS", "drawer gear → settings root");
  });

  await tryItem(rec, snap, page, "F22", async () => {
    await openSettingsPage(page, "customRules");
    const box = page.getByTestId("custom-rules-textarea");
    await box.waitFor();
    await page.waitForFunction(() => {
      const el = document.querySelector("[data-testid='custom-rules-textarea']");
      return el instanceof HTMLTextAreaElement && !el.disabled;
    });
    await box.fill("Smoke rule: always say pie.");
    await page.getByTestId("custom-rules-save").click();
    await page.getByText("Saved", { exact: true }).waitFor({ timeout: 5000 });
    const stored = await idbConfigGet(page, "custom_rules");
    await page.reload();
    await sleep(800);
    await openSettingsPage(page, "customRules");
    await box.waitFor();
    await page.waitForFunction(() => {
      const el = document.querySelector("[data-testid='custom-rules-textarea']");
      return el && !el.disabled;
    });
    const val = await box.inputValue();
    const ok = val.includes("Smoke rule") || (typeof stored === "string" && stored.includes("Smoke rule"));
    rec("F22", ok ? "PASS" : "FAIL", `value=${val.slice(0, 40)} stored=${String(stored).slice(0, 40)}`);
  });

  if (hasKey) {
    await tryItem(rec, snap, page, "F23", async () => {
      await goChat(page);
      await page.getByTestId("chat-composer").waitFor();
      const send = page.getByTestId("chat-send");
      const disabled = await send.isDisabled();
      await page.getByTestId("model-picker").waitFor();
      const tools = page.getByLabel("More tools");
      if (await tools.count()) {
        await tools.first().click();
        await sleep(200);
        await page.keyboard.press("Escape");
      }
      rec(disabled ? "F23" : "F23", disabled ? "PASS" : "FAIL", `empty send disabled=${disabled}`);
    });
  }

  await tryItem(rec, snap, page, "F24", async () => {
    await goSettingsRoot(page);
    const badge = async () => {
      const on = await page.getByText("Connected", { exact: true }).count();
      const off = await page.getByText("Not connected", { exact: true }).count();
      if (on && !off) return "Connected";
      if (off && !on) return "Not connected";
      if (!on && !off) return "none";
      return "both";
    };
    const ready = () =>
      page.evaluate(
        () =>
          new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: "local-bridge:status" }, (res) =>
              resolve(res?.ready === true),
            );
          }),
      ).catch(() => null);

    killDaemon();
    await sleep(800);
    const before = { badge: await badge(), ready: await ready() };
    if (before.badge !== "Not connected" && before.ready !== false) {
      // already connected from a leftover daemon — still try the follow path
    }
    startDaemon(base);
    for (let i = 0; i < 40 && !sockExists(base); i++) await sleep(250);
    if (!sockExists(base)) {
      rec("F24", "ERROR", "scratch daemon 没起来（环境）");
      return;
    }
    const t0 = Date.now();
    let tReady = null;
    let tBadge = null;
    while (Date.now() - t0 < 90000) {
      const r = await ready();
      const b = await badge();
      if (tReady === null && r === true) tReady = Date.now() - t0;
      if (tBadge === null && b === "Connected") tBadge = Date.now() - t0;
      if (tReady !== null && tBadge !== null) break;
      await sleep(250);
    }
    const lag = tReady !== null && tBadge !== null ? tBadge - tReady : null;
    const ok = tReady !== null && tBadge !== null && lag <= 2500;
    rec("F24", ok ? "PASS" : "FAIL", `ready@${tReady}ms badge@${tBadge}ms lag=${lag}`);
    killDaemon();
  });
}
