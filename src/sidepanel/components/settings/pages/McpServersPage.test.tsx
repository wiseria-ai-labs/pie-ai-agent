import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { _resetForTests } from "@/lib/idb/db";
import { _resetKeyForTests } from "@/lib/crypto";
import { listMcpServers } from "@/lib/mcp/store";
import McpServersPage from "./McpServersPage";

beforeEach(async () => {
  await _resetForTests();
  _resetKeyForTests();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function fill(label: string, value: string) {
  fireEvent.change(screen.getByTestId(label), { target: { value } });
}

describe("McpServersPage", () => {
  it("adds a server, then shows masked headers and keeps the saved value on a blank edit", async () => {
    render(<McpServersPage />);
    await waitFor(() => expect(screen.getByTestId("mcp-add-server")).toBeTruthy());
    fireEvent.click(screen.getByTestId("mcp-add-server"));

    fill("mcp-name-input", "Docs");
    fill("mcp-url-input", "http://127.0.0.1:7801/mcp");
    fill("mcp-header-key-0", "Authorization");
    fill("mcp-header-value-0", "Bearer t0p-secret");
    fireEvent.click(screen.getByTestId("mcp-save"));

    await waitFor(() => expect(screen.getByTestId("mcp-server-docs")).toBeTruthy());
    // Header NAME is visible; the value never is.
    expect(screen.getByText(/Authorization/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("t0p-secret");
    const [saved] = await listMcpServers();
    expect(saved?.headers).toEqual({ Authorization: "Bearer t0p-secret" });

    // Re-open the editor and save without touching the value → kept.
    fireEvent.click(screen.getByTestId("mcp-edit-docs"));
    fill("mcp-name-input", "Docs 2");
    fireEvent.click(screen.getByTestId("mcp-save"));
    // Renaming changes the derived slug → new row testid.
    await waitFor(() => expect(screen.getByTestId("mcp-server-docs-2")).toBeTruthy());
    const [edited] = await listMcpServers();
    expect(edited?.name).toBe("Docs 2");
    expect(edited?.headers).toEqual({ Authorization: "Bearer t0p-secret" });
  });

  it("deletes with an inline two-step confirm (no window.confirm)", async () => {
    // happy-dom has no window.confirm; install a spy so "was it called?" is real.
    const confirmSpy = vi.fn();
    (window as unknown as { confirm: typeof confirmSpy }).confirm = confirmSpy;
    render(<McpServersPage />);
    await waitFor(() => expect(screen.getByTestId("mcp-add-server")).toBeTruthy());
    fireEvent.click(screen.getByTestId("mcp-add-server"));
    fill("mcp-name-input", "Docs");
    fill("mcp-url-input", "http://127.0.0.1:7801/mcp");
    fireEvent.click(screen.getByTestId("mcp-save"));
    await waitFor(() => expect(screen.getByTestId("mcp-server-docs")).toBeTruthy());

    // First click only arms the confirmation.
    fireEvent.click(screen.getByTestId("mcp-delete-docs"));
    await waitFor(() => expect(screen.getByTestId("mcp-delete-confirm-docs")).toBeTruthy());
    expect(await listMcpServers()).toHaveLength(1);

    fireEvent.click(screen.getByTestId("mcp-delete-confirm-docs"));
    await waitFor(() => expect(screen.queryByTestId("mcp-server-docs")).toBeNull());
    expect(await listMcpServers()).toHaveLength(0);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("shows a readable error for a non-https URL", async () => {
    render(<McpServersPage />);
    await waitFor(() => expect(screen.getByTestId("mcp-add-server")).toBeTruthy());
    fireEvent.click(screen.getByTestId("mcp-add-server"));
    fill("mcp-name-input", "Docs");
    fill("mcp-url-input", "http://evil.example.com/mcp");
    fireEvent.click(screen.getByTestId("mcp-save"));
    await waitFor(() => expect(screen.getByTestId("mcp-editor-error")).toBeTruthy());
    expect(screen.getByTestId("mcp-editor-error").textContent).toMatch(/https/i);
  });
});
