/**
 * #438 — typing in the composer must not re-render the message scrollback.
 *
 * The composer's draft lives in Chat's own state, so before the fix every
 * keystroke re-rendered every MessageBubble and re-parsed every reply through
 * ReactMarkdown — the "typing is not smooth" symptom in the bug report.
 *
 * Harness: same module mocks as Chat.test.tsx (no chrome.crypto / real
 * storage), plus a counting stand-in for the Markdown renderer.
 */

import React from "react";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chromeMock } from "@/test/setup";
import Chat from "./Chat";
import type { UseSession } from "@/sidepanel/hooks/useSession";
import type { DisplayMessage } from "@/types";

const { markdownRenders } = vi.hoisted(() => ({ markdownRenders: vi.fn() }));

vi.mock("./Markdown", () => ({
  default: ({ content }: { content: string }) => {
    markdownRenders(content);
    return <div>{content}</div>;
  },
  CopyIcon: () => null,
}));

vi.mock("@/lib/instances", () => ({
  listInstances: vi.fn().mockResolvedValue([
    { id: "inst-1", provider: "anthropic", nickname: "Test", apiKey: "sk-test", createdAt: 0 },
  ]),
  getActiveInstance: vi.fn().mockResolvedValue("inst-1"),
  getInstance: vi.fn().mockResolvedValue({
    id: "inst-1", provider: "anthropic", nickname: "Test", apiKey: "sk-test", createdAt: 0,
  }),
  updateInstance: vi.fn().mockResolvedValue(undefined),
  firstModelForProvider: vi.fn().mockResolvedValue("claude-opus-5"),
}));

vi.mock("@/lib/model-selection-resolver", () => ({
  resolveSelection: vi.fn().mockResolvedValue({ instanceId: "inst-1", model: "claude-opus-5" }),
}));

vi.mock("@/lib/openrouter-models-fetch", () => ({
  fetchOpenRouterModels: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/sessions/storage", () => ({
  getSessionMeta: vi.fn().mockResolvedValue(null),
  setSessionMeta: vi.fn().mockResolvedValue(undefined),
  metaKey: vi.fn((id: string) => `${id}:meta`),
}));

function makeSession(overrides?: Partial<UseSession>): UseSession {
  return {
    sessionId: "test-session-id",
    ready: true,
    status: "active",
    pinnedTabs: null,
    pinMode: "auto",
    messages: [] as DisplayMessage[],
    streaming: false,
    streamingText: "",
    streamingThinking: "",
    error: null,
    toast: null,
    sendMessage: vi.fn(),
    abort: vi.fn(),
    resumeTask: vi.fn(),
    discardTask: vi.fn(),
    clearMessages: vi.fn().mockResolvedValue(undefined),
    clearError: vi.fn(),
    clearToast: vi.fn(),
    setActive: vi.fn().mockResolvedValue(null),
    createAndActivate: vi.fn().mockResolvedValue(null),
    togglePinTab: vi.fn().mockResolvedValue(undefined),
    clearUserPin: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as UseSession;
}

const noop = () => {};
(globalThis as unknown as { chrome: Record<string, unknown> }).chrome = {
  ...(globalThis as unknown as { chrome: Record<string, unknown> }).chrome,
  tabs: {
    ...(globalThis as unknown as { chrome: { tabs: Record<string, unknown> } }).chrome.tabs,
    onActivated: { addListener: vi.fn(noop), removeListener: vi.fn(noop) },
    onUpdated: { addListener: vi.fn(noop), removeListener: vi.fn(noop) },
  },
  windows: { WINDOW_ID_NONE: -1, onFocusChanged: { addListener: vi.fn(noop), removeListener: vi.fn(noop) } },
};

beforeEach(() => {
  chromeMock.tabs.__activeTab = { id: 1, url: "https://example.com", active: true };
  markdownRenders.mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("#438 — composer typing does not re-render the scrollback", () => {
  const messages: DisplayMessage[] = [
    { role: "user", content: "抓取三页" },
    { role: "assistant", content: "第 1 页已就绪" },
    { role: "assistant", content: "第 2 页已就绪" },
  ];

  it("keeps reply renders flat across keystrokes, and still re-renders on new messages", async () => {
    const { rerender } = render(
      <Chat session={makeSession({ messages })} onOpenSettings={vi.fn()} providerLabel="Anthropic" />,
    );
    // Wait for checkConfig() to settle (Chat shows a loading branch until then).
    const textarea = await screen.findByTestId("chat-composer");
    const afterMount = markdownRenders.mock.calls.length;
    expect(afterMount).toBe(2); // two assistant replies

    fireEvent.change(textarea, { target: { value: "a" } });
    fireEvent.change(textarea, { target: { value: "ab" } });
    fireEvent.change(textarea, { target: { value: "abc" } });
    expect((textarea as HTMLTextAreaElement).value).toBe("abc");
    expect(markdownRenders.mock.calls.length).toBe(afterMount);

    // Sanity: the memo isn't stale — a new reply does re-render.
    await act(async () => {
      rerender(
        <Chat
          session={makeSession({
            messages: [...messages, { role: "assistant", content: "第 3 页已就绪" }],
          })}
          onOpenSettings={vi.fn()}
          providerLabel="Anthropic"
        />,
      );
    });
    expect(screen.getByText("第 3 页已就绪")).toBeTruthy();
    expect(markdownRenders.mock.calls.length).toBeGreaterThan(afterMount);
  });
});
