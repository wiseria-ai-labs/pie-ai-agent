import { describe, expect, it } from "vitest";
import { formatElapsed } from "./Timeline";

describe("formatElapsed", () => {
  it("renders mm:ss with zero padding", () => {
    expect(formatElapsed(0)).toBe("00:00");
    expect(formatElapsed(9_000)).toBe("00:09");
    expect(formatElapsed(252_000)).toBe("04:12");
    expect(formatElapsed(59 * 60_000 + 59_000)).toBe("59:59");
  });

  it("rolls over to h:mm:ss past an hour", () => {
    expect(formatElapsed(60 * 60_000)).toBe("1:00:00");
    expect(formatElapsed(3 * 60 * 60_000 + 7 * 60_000 + 5_000)).toBe("3:07:05");
  });

  it("clamps a negative delta (clock skew) to zero instead of showing -1:-1", () => {
    expect(formatElapsed(-5_000)).toBe("00:00");
  });
});
