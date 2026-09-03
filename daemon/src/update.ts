// daemon/src/update.ts — Pie Link 自更新调度。
// 纯逻辑在 update-core；mac 换文件在 update-darwin；本文件只按 runtimeFeatures 分发。

import { paths } from "./paths";
import { DAEMON_VERSION } from "./version";
import { runtimeFeatures } from "./runtime-features";
import type { CheckUpdateResult, ApplyUpdateResult } from "../../src/types/local-bridge";
import {
  LATEST_JSON_URL,
  EXPECTED_TEAM_ID,
  PIE_LINK_APP_PATH,
  parseLatest,
  compareVersions,
  defaultFetchJson,
  defaultFetchBytes,
  type UpdateDeps,
} from "./update-core";
import {
  applyDarwinUpdate,
  defaultCodesignVerify,
  defaultCodesignVerifyDeep,
  defaultCodesignInfo,
  defaultUnzipToBinary,
  defaultUnzipToBundle,
} from "./update-darwin";

export {
  LATEST_JSON_URL,
  RELEASES_URL_PREFIX,
  EXPECTED_TEAM_ID,
  PIE_LINK_APP_PATH,
  compareVersions,
  parseLatest,
  isAllowedUpdateUrl,
  parseTeamId,
  sha256Hex,
  validateUpdateBinary,
  type UpdateDeps,
  type BinaryChecks,
} from "./update-core";

export {
  defaultUnzipToBinary,
  defaultUnzipToBundle,
  defaultCodesignVerifyDeep,
  findTopLevelApp,
} from "./update-darwin";

function realDeps(): UpdateDeps {
  return {
    fetchJson: defaultFetchJson,
    fetchBytes: defaultFetchBytes,
    codesignVerify: defaultCodesignVerify,
    codesignVerifyDeep: defaultCodesignVerifyDeep,
    codesignInfo: defaultCodesignInfo,
    unzipToBinary: defaultUnzipToBinary,
    unzipToBundle: defaultUnzipToBundle,
    platform: process.platform,
    binDir: paths.binDir,
    appPath: PIE_LINK_APP_PATH,
    expectedTeamId: EXPECTED_TEAM_ID,
  };
}

export async function checkUpdate(deps: Partial<UpdateDeps> = {}): Promise<CheckUpdateResult> {
  const d = { ...realDeps(), ...deps };
  const latest = parseLatest(await d.fetchJson(LATEST_JSON_URL));
  const current = DAEMON_VERSION;
  const features = runtimeFeatures(d.platform);
  const available = compareVersions(latest.version, current) > 0;
  return {
    current,
    latest: latest.version,
    available,
    url: latest[features.releaseChannel].url,
    supported: features.selfUpdate,
  };
}

export async function applyUpdate(deps: Partial<UpdateDeps> = {}): Promise<ApplyUpdateResult> {
  const d = { ...realDeps(), ...deps };
  const features = runtimeFeatures(d.platform);
  if (!features.selfUpdate) {
    throw new Error("self-update is not available");
  }
  const latest = parseLatest(await d.fetchJson(LATEST_JSON_URL));
  return applyDarwinUpdate(d, latest);
}
