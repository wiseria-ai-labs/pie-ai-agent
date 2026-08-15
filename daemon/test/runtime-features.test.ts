import { test, expect } from "bun:test";
import { runtimeFeatures } from "../src/runtime-features";

test("darwin runtime：有 srt 围栏，支持一键自更新，走 macos 发布通道", () => {
  expect(runtimeFeatures("darwin")).toEqual({
    skillIsolation: "srt",
    selfUpdate: true,
    releaseChannel: "macos",
  });
});

test("win32 runtime：无额外围栏，不支持一键自更新，走 windows 发布通道", () => {
  expect(runtimeFeatures("win32")).toEqual({
    skillIsolation: "none",
    selfUpdate: false,
    releaseChannel: "windows",
  });
});
