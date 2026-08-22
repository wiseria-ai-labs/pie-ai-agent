import { sleep, goChat, openSettingsPage, listInstanceIds, hasEvalBridge, smokeProvider, smokeApiKey } from "./lib.mjs";

export async function runProd({ page, sw, rec, snap, hasKey }) {
  await sleep(800);
  if (await page.getByTestId("settings-row-models").count()) {
    await page.getByTestId("topbar-back").click();
    await sleep(300);
  }

  try {
    const bridged = await hasEvalBridge(sw);
    if (bridged) {
      rec("P01", "FAIL", "__pieEval 出现在 prod dist/ 上");
      return;
    }
    const cta = page.getByTestId("chat-open-settings");
    await cta.waitFor();
    await cta.click();
    await page.getByTestId("settings-row-models").waitFor();
    rec("P01", "PASS", "无 eval bridge · 空态 CTA 进设置");
  } catch (e) {
    rec("P01", "ERROR", e.message);
    await snap(page, "err-P01");
  }

  if (!hasKey) {
    rec("P02", "ERROR", "无 API key — 环境，不挡发版");
    return;
  }

  try {
    const provider = smokeProvider();
    await openSettingsPage(page, "models");
    await page.getByTestId("models-new-config").click();
    await page.getByTestId("provider-dropdown").click();
    await page.getByTestId(`provider-option-${provider}`).click();
    await page.getByTestId("instance-api-key").fill(smokeApiKey());
    await page.getByTestId("instance-save").or(page.getByRole("button", { name: "Create" })).click();
    await sleep(800);
    const ids = await listInstanceIds(page);
    await page.getByTestId("topbar-back").click();
    await goChat(page);
    await page.getByTestId("chat-composer").waitFor();
    rec("P02", ids.length >= 1 ? "PASS" : "FAIL", `instances=${ids.length} · composer unlocked`);
  } catch (e) {
    rec("P02", "ERROR", e.message);
    await snap(page, "err-P02");
  }
}
