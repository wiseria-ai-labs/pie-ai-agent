import { describe, expect, it } from "vitest";
import { isHttpUrl } from "./http-url";

describe("isHttpUrl", () => {
  it.each(["https://a.com", "http://a.com"])("%s → true", (url) => {
    expect(isHttpUrl(url)).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,x",
    "mailto:x",
    "/rel",
    "",
    "not a url",
  ])("%s → false", (url) => {
    expect(isHttpUrl(url)).toBe(false);
  });
});
