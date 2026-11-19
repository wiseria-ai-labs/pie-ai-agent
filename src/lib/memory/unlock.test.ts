import { describe, it, expect, vi, beforeEach } from "vitest";

const requestFromPanel = vi.fn();
vi.mock("@/lib/panel-request", () => ({ requestFromPanel: (...a: unknown[]) => requestFromPanel(...a) }));

import {
  __resetMemoryUnlockState,
  isEncryptedMemoryUnlocked,
  requestEncryptedMemoryUnlock,
} from "./unlock";

describe("encrypted memory unlock", () => {
  beforeEach(() => {
    requestFromPanel.mockReset();
    __resetMemoryUnlockState();
  });

  it("asks once per session, then stays approved", async () => {
    requestFromPanel.mockResolvedValue(true);
    expect(await requestEncryptedMemoryUnlock({ sessionId: "s1", count: 2, kinds: ["contact"] })).toBe(true);
    expect(await requestEncryptedMemoryUnlock({ sessionId: "s1", count: 2, kinds: ["contact"] })).toBe(true);
    expect(requestFromPanel).toHaveBeenCalledTimes(1);
    expect(requestFromPanel.mock.calls[0][0]).toBe("s1");
    expect(requestFromPanel.mock.calls[0][1]).toBe("memory-unlock");
    expect(requestFromPanel.mock.calls[0][2]).toEqual({ count: 2, kinds: ["contact"] });
    expect(isEncryptedMemoryUnlocked("s1")).toBe(true);
    // another session starts masked
    expect(isEncryptedMemoryUnlocked("s2")).toBe(false);
  });

  it("stays masked when the user declines or the card cannot be shown", async () => {
    requestFromPanel.mockResolvedValue(false);
    expect(await requestEncryptedMemoryUnlock({ sessionId: "s1", count: 1, kinds: ["contact"] })).toBe(false);
    requestFromPanel.mockRejectedValue(new Error("no sidepanel port"));
    expect(await requestEncryptedMemoryUnlock({ sessionId: "s1", count: 1, kinds: ["contact"] })).toBe(false);
    expect(isEncryptedMemoryUnlocked("s1")).toBe(false);
    // no session → never asks
    expect(await requestEncryptedMemoryUnlock({ count: 1, kinds: ["contact"] })).toBe(false);
  });

  it("survives a card that never answers by staying closed on abort", async () => {
    requestFromPanel.mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));
    const ac = new AbortController();
    ac.abort();
    expect(
      await requestEncryptedMemoryUnlock({ sessionId: "s1", count: 1, kinds: ["contact"], signal: ac.signal }),
    ).toBe(false);
  });
});
