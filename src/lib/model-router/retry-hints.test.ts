import { describe, it, expect } from "vitest";
import { isHardQuotaText, parseRetryAfter } from "./retry-hints";

describe("parseRetryAfter", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfter("12")).toBe(12_000);
    expect(parseRetryAfter("0.5")).toBe(500);
    expect(parseRetryAfter(" 3 ")).toBe(3_000);
  });
  it("parses an HTTP-date relative to now", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:10 GMT", now)).toBe(10_000);
    expect(parseRetryAfter("Wed, 31 Dec 2025 23:00:00 GMT", now)).toBe(0);
  });
  it("ignores absent / garbage / negative values", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter("-5")).toBeUndefined();
  });
});

describe("isHardQuotaText", () => {
  it("spots daily / billing quota bodies", () => {
    expect(isHardQuotaText('{"error":{"details":[{"quotaId":"GenerateRequestsPerDayPerProject"}]}}')).toBe(true);
    expect(isHardQuotaText('{"error":{"code":"insufficient_quota"}}')).toBe(true);
    expect(isHardQuotaText("Your credit balance is too low")).toBe(true);
  });
  it("leaves short-window rate limits alone", () => {
    expect(isHardQuotaText("Rate limit reached for requests per minute")).toBe(false);
    expect(isHardQuotaText("")).toBe(false);
  });
});
