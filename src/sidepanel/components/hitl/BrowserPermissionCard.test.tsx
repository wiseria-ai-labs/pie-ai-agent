import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { installChromeApi, installFakePermissions, type FakePermissions } from "@/test/fake-browser-data";
import { BrowserPermissionCard } from "./BrowserPermissionCard";

let perms: FakePermissions;

beforeEach(() => {
  perms = installFakePermissions([]);
  installChromeApi("permissions", perms);
});

afterEach(() => {
  cleanup();
  delete (globalThis as unknown as { chrome: Record<string, unknown> }).chrome.permissions;
});

describe("BrowserPermissionCard", () => {
  it("renders the history copy, capability detail, and both actions", () => {
    render(<BrowserPermissionCard domain="history" onAnswer={() => {}} />);
    expect(screen.getByText("Allow Pie to read your browsing history?")).toBeTruthy();
    expect(screen.getByText("What it can do")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Not now" })).toBeTruthy();
  });

  it("says Chrome will ask again — the card is not the last gate", () => {
    render(<BrowserPermissionCard domain="bookmarks" onAnswer={() => {}} />);
    expect(screen.getByText(/Chrome shows its own confirmation/)).toBeTruthy();
  });

  it("declining answers false without requesting the permission", () => {
    const onAnswer = vi.fn();
    render(<BrowserPermissionCard domain="bookmarks" onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(onAnswer).toHaveBeenCalledWith(false);
    expect(perms.granted.size).toBe(0);
  });

  it("Allow requests the permission and answers with Chrome's result", async () => {
    const onAnswer = vi.fn();
    render(<BrowserPermissionCard domain="history" onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(true));
    expect(perms.granted.has("history")).toBe(true);
  });
});
