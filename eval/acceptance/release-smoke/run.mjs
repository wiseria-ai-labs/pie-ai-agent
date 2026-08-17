#!/usr/bin/env node
// 发版真机冒烟入口。配方见 docs/agents/auto-acceptance.md 与
// docs/specs/2026-08-17-release-smoke-checklist.md
//
//   export PIE_ACCEPT_BASE=/tmp/piesmoke   # 必须短（unix socket）
//   pnpm build:eval && pnpm build          # P 批需要 dist/
//   pnpm smoke:release
import fs from "node:fs";
import {
  loadAcceptanceEnv,
  prepareWorkspace,
  launch,
  createRecorder,
  killDaemon,
  smokeApiKey,
  smokeProvider,
  smokeModel,
  listInstanceIds,
  goChat,
  sleep,
  startFixtureServer,
} from "./lib.mjs";
import { runFunctional } from "./batch-f.mjs";
import { runProd } from "./batch-p.mjs";
import { runLlm } from "./batch-l.mjs";

loadAcceptanceEnv();

const BASE = process.env.PIE_ACCEPT_BASE || "/tmp/piesmoke";
if (BASE.length > 40) {
  console.warn(`PIE_ACCEPT_BASE=${BASE} 偏长，daemon socket 可能超过 macOS sun_path 上限`);
}

prepareWorkspace(BASE);
const rec = createRecorder(`${BASE}/report`);
const hasKey = Boolean(smokeApiKey());
const model = `${smokeProvider()}/${smokeModel()}`;

killDaemon();

const fixture = await startFixtureServer(BASE);

let fCtx;
try {
  const launched = await launch(BASE, {
    profile: "profile-f",
    dist: `${BASE}/dist-pilot`,
  });
  fCtx = launched.ctx;
  const { page } = launched;
  await runFunctional({ page, rec: rec.record, snap: rec.snap, base: BASE, hasKey });

  // F14 — 同 user-data-dir 重启，配置还在
  if (hasKey) {
    try {
      const before = await listInstanceIds(page);
      await fCtx.close();
      fCtx = null;
      const again = await launch(BASE, {
        profile: "profile-f",
        dist: `${BASE}/dist-pilot`,
      });
      fCtx = again.ctx;
      const page2 = again.page;
      await sleep(1200);
      if (await page2.getByTestId("settings-row-models").count()) {
        await page2.getByTestId("topbar-back").click();
        await sleep(300);
      }
      await goChat(page2);
      const after = await listInstanceIds(page2);
      const composer = await page2.getByTestId("chat-composer").count();
      rec.record(
        "F14",
        after.length > 0 && composer > 0 ? "PASS" : "FAIL",
        `before=${before.length} after=${after.length} composer=${composer}`,
      );
      if (hasKey) {
        await runLlm({
          page: page2,
          ctx: again.ctx,
          rec: rec.record,
          snap: rec.snap,
          base: BASE,
          fixtureUrl: fixture.url,
        });
      }
    } catch (e) {
      rec.record("F14", "ERROR", e.message);
    }
  } else {
    rec.record("F14", "ERROR", "无 API key — 环境，不挡发版");
    for (const id of ["L01", "L02", "L03", "L04", "L05"]) {
      rec.record(id, "ERROR", "无 API key — 环境");
    }
  }
} catch (e) {
  rec.record("F-setup", "ERROR", e.message);
} finally {
  if (fCtx) await fCtx.close().catch(() => {});
  killDaemon();
}

if (!hasKey) {
  // already recorded L* above when F14 skipped
}

if (fs.existsSync(`${BASE}/dist-prod/manifest.json`)) {
  let pCtx;
  try {
    const launched = await launch(BASE, {
      profile: "profile-p",
      dist: `${BASE}/dist-prod`,
    });
    pCtx = launched.ctx;
    await runProd({
      page: launched.page,
      sw: launched.sw,
      rec: rec.record,
      snap: rec.snap,
      hasKey,
    });
  } catch (e) {
    rec.record("P-setup", "ERROR", e.message);
  } finally {
    if (pCtx) await pCtx.close().catch(() => {});
  }
} else {
  rec.record("P01", "ERROR", "dist/ 不存在 — 先 pnpm build");
  rec.record("P02", "ERROR", "dist/ 不存在 — 先 pnpm build");
}

const { productHard } = rec.write({
  envNote: `PIE_ACCEPT_BASE=${BASE} · dist-eval=${fs.existsSync(`${BASE}/dist-pilot/manifest.json`)} · dist=${fs.existsSync(`${BASE}/dist-prod/manifest.json`)}`,
  model: hasKey ? model : "(no key)",
});

fixture.server.close();
console.log(`\n报告：${BASE}/report/report.md`);
process.exit(productHard.length ? 1 : 0);
