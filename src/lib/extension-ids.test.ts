import { describe, it, expect } from "vitest";
import {
  CHROME_STORE_EXT_ID,
  EDGE_STORE_EXT_ID,
  isAllowlistedExtId,
} from "./extension-ids";

describe("isAllowlistedExtId", () => {
  it("accepts the Chrome store id", () => {
    expect(isAllowlistedExtId(CHROME_STORE_EXT_ID)).toBe(true);
  });

  it("accepts the Edge Add-ons store id", () => {
    expect(isAllowlistedExtId(EDGE_STORE_EXT_ID)).toBe(true);
  });

  it("rejects a path-derived unpacked id", () => {
    expect(isAllowlistedExtId("oalbbnaognpedempboblkimkapdpbhjl")).toBe(false);
  });

  it("rejects empty / missing", () => {
    expect(isAllowlistedExtId("")).toBe(false);
    expect(isAllowlistedExtId(undefined)).toBe(false);
  });
});
