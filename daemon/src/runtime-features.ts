/**
 * 本 runtime 对外声明的产品能力。协议只传这些语义，不传 platform（ADR 0010）。
 * 平台判定留在本文件内部。
 */
export type SkillIsolation = "srt" | "none";

export type ReleaseChannel = "macos" | "windows";

export interface RuntimeFeatures {
  /** 脚本执行隔离：srt = 有围栏；none = 以用户账户直跑。 */
  skillIsolation: SkillIsolation;
  /** 是否支持 apply_update 一键换二进制。 */
  selfUpdate: boolean;
  /** pie-link-latest.json 里本 runtime 对应的发布物键。 */
  releaseChannel: ReleaseChannel;
}

export function runtimeFeatures(platform: NodeJS.Platform = process.platform): RuntimeFeatures {
  const win = platform === "win32";
  return {
    skillIsolation: win ? "none" : "srt",
    selfUpdate: platform === "darwin",
    releaseChannel: win ? "windows" : "macos",
  };
}
