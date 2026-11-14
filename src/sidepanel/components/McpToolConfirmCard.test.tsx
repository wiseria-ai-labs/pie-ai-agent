import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { McpToolConfirmCard } from "./McpToolConfirmCard";
import type { McpToolConfirmRequest } from "@/lib/mcp/agent-tools";

afterEach(() => cleanup());

const payload: McpToolConfirmRequest = {
  serverId: "srv1",
  serverName: "Google Docs",
  toolName: "mcp_google-docs_append_text",
  originalToolName: "append_text",
  args: { documentId: "doc-1", text: "Summary paragraph" },
};

describe("McpToolConfirmCard", () => {
  it("shows the server, tool name and every argument verbatim", () => {
    render(<McpToolConfirmCard payload={payload} onDecision={vi.fn()} />);
    expect(screen.getByText(/Allow the agent to use Google Docs\?/)).toBeTruthy();
    expect(screen.getByText("mcp_google-docs_append_text")).toBeTruthy();
    // Args are rendered as JSON so the user sees exactly what is sent.
    expect(screen.getByText(/"documentId": "doc-1"/)).toBeTruthy();
    expect(screen.getByText(/"text": "Summary paragraph"/)).toBeTruthy();
  });

  it("Allow → onDecision(true); Deny → onDecision(false)", () => {
    const onDecision = vi.fn();
    render(<McpToolConfirmCard payload={payload} onDecision={onDecision} />);
    fireEvent.click(screen.getByText("Allow this session"));
    expect(onDecision).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByText("Deny"));
    expect(onDecision).toHaveBeenCalledWith(false);
  });

  it("renders a placeholder when there are no arguments", () => {
    render(<McpToolConfirmCard payload={{ ...payload, args: {} }} onDecision={vi.fn()} />);
    expect(screen.getByText("(no arguments)")).toBeTruthy();
  });

  it("explains the per-session scope of the approval", () => {
    render(<McpToolConfirmCard payload={payload} onDecision={vi.fn()} />);
    expect(screen.getByText(/rest of this session/i)).toBeTruthy();
  });
});
