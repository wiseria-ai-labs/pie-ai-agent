// Issue #231 follow-up — shared active-tab pin capture.
//
// #231 taught the LOOP's startup fallback (resolveStartupPin) that a
// restricted tab (chrome://, new-tab, settings...) with a real tab.id is a
// legitimate pin with an EMPTY origin. But the two storage-side capture
// functions (panel captureActivePinned + SW captureSwActivePinned) kept
// returning null for restricted URLs → sessions started on chrome:// never
// got a persisted pin → the pin bar vanished while streaming and R7
// cross-session locking never saw the tab.
//
// Fix: ONE shared capture (this module) mirroring the resolveStartupPin
// contract, used by both panel and SW.

import { describe, expect, it, beforeEach } from "vitest";
import { chromeMock } from "@/test/setup";
import { captureActivePinnedTab, captureAnchorTab, capturePinnedTabById } from "./capture-active-pinned";

beforeEach(() => {
  chromeMock.tabs.__activeTab = null;
});

describe("captureActivePinnedTab", () => {
  it("captures a normal https tab with its origin", async () => {
    chromeMock.tabs.__activeTab = {
      id: 7,
      url: "https://example.com/some/page",
    };
    expect(await captureActivePinnedTab()).toEqual({
      tabId: 7,
      origin: "https://example.com",
    });
  });

  it("captures a restricted tab (chrome://) with EMPTY origin — #231 mirror", async () => {
    chromeMock.tabs.__activeTab = { id: 9, url: "chrome://extensions/" };
    expect(await captureActivePinnedTab()).toEqual({ tabId: 9, origin: "" });
  });

  it("captures an unresolvable-origin tab with EMPTY origin", async () => {
    chromeMock.tabs.__activeTab = { id: 11, url: "about:blank" };
    expect(await captureActivePinnedTab()).toEqual({ tabId: 11, origin: "" });
  });

  it("keeps the file PDF exception: full URL as pin identity", async () => {
    chromeMock.tabs.__activeTab = {
      id: 13,
      url: "file:///Users/me/paper.pdf",
    };
    expect(await captureActivePinnedTab()).toEqual({
      tabId: 13,
      origin: "file:///Users/me/paper.pdf",
    });
  });

  it("returns null when there is no active tab", async () => {
    chromeMock.tabs.__activeTab = null;
    expect(await captureActivePinnedTab()).toBeNull();
  });

  it("returns null for a non-addressable tab id (-1)", async () => {
    chromeMock.tabs.__activeTab = { id: -1, url: "https://example.com" };
    expect(await captureActivePinnedTab()).toBeNull();
  });
});

describe("captureAnchorTab (panel, at send)", () => {
  it("returns the panel window's active tab with its window id", async () => {
    chromeMock.tabs.__activeTab = { id: 7, windowId: 3, url: "https://example.com/x" } as never;
    expect(await captureAnchorTab()).toEqual({ tabId: 7, windowId: 3, origin: "https://example.com" });
  });
  it("null when there is no tab", async () => {
    expect(await captureAnchorTab()).toBeNull();
  });
});

describe("capturePinnedTabById (SW, from the panel's anchor)", () => {
  it("pins the given tab even when another tab is active", async () => {
    chromeMock.tabs.__tabsById.set(11, { id: 11, url: "https://classroom.google.com/c/1" } as never);
    chromeMock.tabs.__activeTab = { id: 22, url: "https://mail.google.com/" } as never;
    expect(await capturePinnedTabById(11)).toEqual({ tabId: 11, origin: "https://classroom.google.com" });
  });
  it("null for a closed tab — no fallback to the active tab", async () => {
    chromeMock.tabs.__activeTab = { id: 22, url: "https://mail.google.com/" } as never;
    expect(await capturePinnedTabById(99)).toBeNull();
  });
});
