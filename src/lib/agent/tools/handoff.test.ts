import { describe, it, expect, vi } from "vitest";
import { buildHandoffTool } from "./handoff";

const AGENTS = [
  { id: "claude-app", label: "Claude Code (App)" },
  { id: "codex-terminal", label: "Codex (Terminal)" },
];

describe("handoff_to_agent tool", () => {
  it("declines: consent null → error, run not called", async () => {
    const run = vi.fn();
    const tool = buildHandoffTool({ run, listAgents: async () => AGENTS, requestConsent: async () => null });
    const r = await tool.handler({ context: "do it" }, {} as never);
    expect(r.success).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("grants: consent gets brand groups, run called with the picked form id", async () => {
    const run = vi.fn(async () => ({ dir: "/Users/x/pie-handoffs/2026-07-07-do-it", mode: "terminal" as const }));
    const consent = vi.fn(async () => "codex-terminal");
    const tool = buildHandoffTool({ run, listAgents: async () => AGENTS, requestConsent: consent });
    const r = await tool.handler({ context: "do it", files: [{ name: "a.md", content: "x" }] }, {} as never);
    expect(consent).toHaveBeenCalledWith({
      context: "do it",
      fileCount: 1,
      brands: [
        { id: "claude", label: "Claude Code", forms: [{ id: "claude-app", kind: "app" }] },
        { id: "codex", label: "Codex", forms: [{ id: "codex-terminal", kind: "terminal" }] },
      ],
    });
    expect(run).toHaveBeenCalledWith({ target: "codex-terminal", context: "do it", files: [{ name: "a.md", content: "x" }] });
    expect(r.success).toBe(true);
    expect(r.observation).not.toContain("/Users/x/pie-handoffs/2026-07-07-do-it");
    expect(r.observation).not.toMatch(/[/\\]pie-handoffs[/\\]/);
    expect(r.observation).toContain("Codex (Terminal)");
  });

  it("app mode observation tells the LLM the user must send a message to start", async () => {
    const run = vi.fn(async () => ({ dir: "/Users/x/pie-handoffs/2026-07-07-do-it", mode: "app" as const }));
    const tool = buildHandoffTool({ run, listAgents: async () => AGENTS, requestConsent: async () => "claude-app" });
    const r = await tool.handler({ context: "do it" }, {} as never);
    expect(r.success).toBe(true);
    expect(r.observation).toMatch(/continue/i);
    expect(r.observation).toMatch(/opened app/i);
    expect(r.observation).not.toMatch(/prefilled/i);
    expect(r.observation).not.toMatch(/[/\\]pie-handoffs[/\\]/);
  });

  it("web appLaunch says the Web UI opened, workspace registered, brief on clipboard — not prefilled", async () => {
    const run = vi.fn(async () => ({
      dir: "/Users/x/pie-handoffs/2026-07-07-do-it",
      mode: "app" as const,
      appLaunch: "web" as const,
    }));
    const tool = buildHandoffTool({
      run,
      listAgents: async () => [{ id: "dsh-app", label: "DeepSeek Harness (App)", kind: "app" as const }],
      requestConsent: async () => "dsh-app",
    });
    const r = await tool.handler({ context: "do it" }, {} as never);
    expect(r.success).toBe(true);
    expect(r.observation).toMatch(/Web UI/i);
    expect(r.observation).toMatch(/clipboard/i);
    expect(r.observation).toMatch(/workspace/i);
    expect(r.observation).not.toMatch(/prefilled/i);
    expect(r.observation).not.toMatch(/[/\\]pie-handoffs[/\\]/);
  });

  it("deeplink appLaunch mentions the prefilled composer", async () => {
    const run = vi.fn(async () => ({
      dir: "/Users/x/pie-handoffs/2026-07-07-do-it",
      mode: "app" as const,
      appLaunch: "deeplink" as const,
    }));
    const tool = buildHandoffTool({ run, listAgents: async () => AGENTS, requestConsent: async () => "claude-app" });
    const r = await tool.handler({ context: "do it" }, {} as never);
    expect(r.success).toBe(true);
    expect(r.observation).toMatch(/prefilled/i);
    expect(r.observation).not.toMatch(/[/\\]pie-handoffs[/\\]/);
  });

  it("empty detection: structured error, no consent card, no run", async () => {
    const run = vi.fn();
    const requestConsent = vi.fn();
    const tool = buildHandoffTool({ run, listAgents: async () => [], requestConsent });
    const r = await tool.handler({ context: "do it" }, {} as never);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/no local agent is available/i);
    expect(r.error).not.toMatch(/claude|codex/i);
    expect(requestConsent).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects empty context before touching the bridge", async () => {
    const run = vi.fn();
    const listAgents = vi.fn();
    const requestConsent = vi.fn();
    const tool = buildHandoffTool({ run, listAgents, requestConsent });
    const r = await tool.handler({ context: "   " }, {} as never);
    expect(r.success).toBe(false);
    expect(listAgents).not.toHaveBeenCalled();
    expect(requestConsent).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});
