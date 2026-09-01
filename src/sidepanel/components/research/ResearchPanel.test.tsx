import { render, renderHook, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecryptedInstance } from "@/lib/instances";
import type { Entitlement } from "@/lib/managed-auth";
import { ResearchError, type ResearchRun, type ResearchRunSummary } from "@/lib/managed-research";
import ResearchPanel from "./ResearchPanel";
import { useResearchRun } from "./ResearchDetail";

const mocks = vi.hoisted(() => ({
  listInstances: vi.fn(),
  listResearch: vi.fn(),
  startResearch: vi.fn(),
  getResearch: vi.fn(),
  cancelResearch: vi.fn(),
  trackResearchRun: vi.fn(),
  getEntitlement: vi.fn(),
  getCachedEntitlement: vi.fn(),
  onSendToChat: vi.fn(),
}));

vi.mock("@/lib/instances", () => ({
  listInstances: mocks.listInstances,
}));

vi.mock("@/lib/managed-research", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/managed-research")>();
  return {
    ...actual,
    listResearch: mocks.listResearch,
    startResearch: mocks.startResearch,
    getResearch: mocks.getResearch,
    cancelResearch: mocks.cancelResearch,
  };
});

vi.mock("@/lib/research-poll", () => ({
  trackResearchRun: mocks.trackResearchRun,
}));

vi.mock("@/lib/managed-account", () => ({
  getEntitlement: mocks.getEntitlement,
  getCachedEntitlement: mocks.getCachedEntitlement,
}));

vi.mock("../ui/Collapse", () => ({
  Collapse: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
}));

vi.mock("../Markdown", () => ({
  default: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>,
}));

vi.mock("../ui/AnimatedList", () => ({
  useAnimatedList: () => ({ current: null }),
}));

const managed: DecryptedInstance = {
  id: "m1",
  provider: "managed",
  nickname: "Pie",
  apiKey: "sk-v",
  createdAt: 1,
};

const RESET_AT = 1750400000;

const entitlement: Entitlement = {
  plan: "active",
  email: "u@x.com",
  subscription: {
    planName: "Pie Pro",
    currentPeriodEnd: 1750000000,
    cancelAtPeriodEnd: false,
    source: "stripe",
  },
  quota: {
    weekly: { usedFraction: 0.2, resetAt: RESET_AT },
    research: { weekly: 5, used: 2, resetAt: RESET_AT },
  },
  models: [],
};

function summary(over: Partial<ResearchRunSummary> & Pick<ResearchRunSummary, "id">): ResearchRunSummary {
  return {
    question: "What is Pie?",
    status: "done",
    createdAt: "2026-08-20T12:00:00.000Z",
    ...over,
  };
}

function run(over: Partial<ResearchRun> & Pick<ResearchRun, "id">): ResearchRun {
  return {
    question: "What is Pie?",
    status: "running",
    sourcesFound: 4,
    phase: "gather",
    ...over,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listInstances.mockResolvedValue([managed]);
  mocks.listResearch.mockResolvedValue([]);
  mocks.getCachedEntitlement.mockReturnValue(null);
  mocks.getEntitlement.mockResolvedValue(entitlement);
  mocks.trackResearchRun.mockResolvedValue(undefined);
  mocks.cancelResearch.mockResolvedValue(undefined);
  mocks.onSendToChat.mockReset();
});

describe("ResearchPanel list", () => {
  it("shows an empty state when there are no runs", async () => {
    render(<ResearchPanel />);
    expect(await screen.findByTestId("research-empty")).toBeTruthy();
    expect(screen.getByText(/no research yet/i)).toBeTruthy();
  });

  it("lists runs newest-first with truncated question, status pill, and time", async () => {
    mocks.listResearch.mockResolvedValue([
      summary({
        id: "old",
        question: "Older question that should sort last",
        status: "done",
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
      summary({
        id: "new",
        question: "Newer question that should sort first",
        status: "running",
        createdAt: "2026-08-28T00:00:00.000Z",
      }),
    ]);
    render(<ResearchPanel />);
    const newer = await screen.findByTestId("research-row-new");
    const older = screen.getByTestId("research-row-old");
    expect(newer.textContent).toMatch(/Newer question/);
    expect(older.textContent).toMatch(/Older question/);
    expect(newer.compareDocumentPosition(older) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(newer.querySelector(".truncate")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("Done")).toBeTruthy();
  });

  it("shows remaining weekly quota", async () => {
    render(<ResearchPanel />);
    const line = await screen.findByTestId("research-quota");
    expect(line.textContent).toMatch(/3 remaining this week/);
    expect(line.textContent).toMatch(/resets/i);
  });

  it("listResearch is only called once after mount", async () => {
    render(<ResearchPanel />);
    await screen.findByTestId("research-empty");
    expect(mocks.listResearch).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 80));
    expect(mocks.listResearch).toHaveBeenCalledTimes(1);
  });
});

describe("ResearchPanel start", () => {
  it("starts a run, tracks it, and opens the detail view", async () => {
    mocks.startResearch.mockResolvedValue({ id: "run_new" });
    mocks.getResearch.mockResolvedValue(run({ id: "run_new", status: "queued", sourcesFound: 0, phase: undefined }));
    render(<ResearchPanel />);
    await screen.findByTestId("research-question");
    fireEvent.change(screen.getByTestId("research-question"), { target: { value: "What is Pie?" } });
    fireEvent.click(screen.getByTestId("research-start"));
    expect(await screen.findByTestId("research-detail")).toBeTruthy();
    expect(mocks.startResearch).toHaveBeenCalledWith("sk-v", { question: "What is Pie?" });
    expect(mocks.trackResearchRun).toHaveBeenCalledWith("run_new");
  });

  it.each([
    ["research_quota_exceeded", 429, /Weekly research quota used up/],
    ["research_in_progress", 409, /already in progress/],
    ["research_unavailable", 503, /temporarily unavailable/],
    ["research_requires_pro", 403, /Pro feature/],
  ] as const)("maps %s to its copy", async (code, status, copy) => {
    mocks.startResearch.mockRejectedValue(new ResearchError(code, status));
    render(<ResearchPanel />);
    await screen.findByTestId("research-question");
    fireEvent.change(screen.getByTestId("research-question"), { target: { value: "Q" } });
    fireEvent.click(screen.getByTestId("research-start"));
    const err = await screen.findByTestId("research-start-error");
    expect(err.textContent).toMatch(copy);
    expect(screen.queryByTestId("research-detail")).toBeNull();
    expect(mocks.trackResearchRun).not.toHaveBeenCalled();
    if (code === "research_quota_exceeded") {
      const date = new Date(RESET_AT * 1000).toLocaleDateString("en", {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
      expect(err.textContent).toContain(date);
    }
  });
});

describe("ResearchPanel detail", () => {
  async function openDetail(full: ResearchRun) {
    mocks.listResearch.mockResolvedValue([
      summary({ id: full.id, question: full.question, status: full.status, createdAt: "2026-08-20T12:00:00.000Z" }),
    ]);
    mocks.getResearch.mockResolvedValue(full);
    render(<ResearchPanel />);
    fireEvent.click(await screen.findByTestId(`research-row-${full.id}`));
    expect(await screen.findByTestId("research-detail")).toBeTruthy();
  }

  it("renders running progress: phases, sources, and cancel", async () => {
    await openDetail(run({ id: "r1", status: "running", phase: "gather", sourcesFound: 7 }));
    expect(screen.getByTestId("research-progress")).toBeTruthy();
    expect(screen.getByTestId("research-phase-plan").textContent).toBe("Planning");
    expect(screen.getByTestId("research-phase-gather").textContent).toBe("Gathering sources");
    expect(screen.getByTestId("research-phase-synthesize").textContent).toBe("Writing report");
    expect(screen.getByTestId("research-sources").textContent).toMatch(/7 sources found/);
    expect(screen.getByTestId("research-cancel")).toBeTruthy();
  });

  it("renders a done report and reference list", async () => {
    await openDetail(
      run({
        id: "r2",
        status: "done",
        report: "# Findings\nHello.",
        references: [{ n: 1, title: "Pie site", url: "https://pie.chat" }],
        sourcesFound: 1,
      }),
    );
    expect(screen.getByTestId("research-report")).toBeTruthy();
    expect(screen.getByTestId("markdown").textContent).toBe("# Findings\nHello.");
    const refs = screen.getByTestId("research-references");
    expect(refs.textContent).toMatch(/\[1\] Pie site — https:\/\/pie\.chat/);
    const link = refs.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://pie.chat");
    expect(link?.getAttribute("target")).toBe("_blank");
  });

  it("renders failed_system copy", async () => {
    await openDetail(run({ id: "r3", status: "failed_system", sourcesFound: 0 }));
    expect(screen.getByTestId("research-failed").textContent).toMatch(/doesn't count against your quota/i);
  });

  it("renders cancelled copy", async () => {
    await openDetail(run({ id: "r4", status: "cancelled", sourcesFound: 0 }));
    expect(screen.getByTestId("research-cancelled").textContent).toMatch(/cancelled/i);
  });

  it("requires a second click before cancelling", async () => {
    await openDetail(run({ id: "r5", status: "running", phase: "plan", sourcesFound: 1 }));
    fireEvent.click(screen.getByTestId("research-cancel"));
    expect(mocks.cancelResearch).not.toHaveBeenCalled();
    expect(screen.getByTestId("research-cancel-confirm")).toBeTruthy();
    mocks.getResearch.mockResolvedValue(run({ id: "r5", status: "cancelled", sourcesFound: 1 }));
    fireEvent.click(screen.getByTestId("research-cancel-confirm"));
    await waitFor(() => expect(mocks.cancelResearch).toHaveBeenCalledWith("sk-v", "r5"));
    expect(await screen.findByTestId("research-cancelled")).toBeTruthy();
  });

  it("stops polling after leaving the page", async () => {
    vi.useFakeTimers();
    mocks.getResearch.mockResolvedValue(run({ id: "r6", status: "running", phase: "plan", sourcesFound: 0 }));
    const { unmount } = renderHook(() => useResearchRun("sk-v", "r6"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const afterOpen = mocks.getResearch.mock.calls.length;
    expect(afterOpen).toBeGreaterThanOrEqual(1);

    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.getResearch.mock.calls.length).toBeGreaterThan(afterOpen);
    const afterTick = mocks.getResearch.mock.calls.length;

    unmount();

    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
    });
    expect(mocks.getResearch.mock.calls.length).toBe(afterTick);
  });

  it("stops polling once the run reaches a terminal status", async () => {
    vi.useFakeTimers();
    mocks.getResearch
      .mockResolvedValueOnce(run({ id: "r7", status: "running", phase: "plan", sourcesFound: 0 }))
      .mockResolvedValue(run({ id: "r7", status: "done", sourcesFound: 3, report: "ok" }));
    renderHook(() => useResearchRun("sk-v", "r7"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const afterOpen = mocks.getResearch.mock.calls.length;
    expect(afterOpen).toBeGreaterThanOrEqual(1);

    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
      await Promise.resolve();
    });
    const afterTerminal = mocks.getResearch.mock.calls.length;
    expect(afterTerminal).toBeGreaterThan(afterOpen);

    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
    });
    expect(mocks.getResearch.mock.calls.length).toBe(afterTerminal);
  });
});

describe("ResearchPanel composer shortcut + notification open", () => {
  it("prefills the question from the composer shortcut without starting a run", async () => {
    render(<ResearchPanel initialQuestion="AI regulation in 2026" />);
    const box = await screen.findByTestId("research-question") as HTMLTextAreaElement;
    expect(box.value).toBe("AI regulation in 2026");
    expect(mocks.startResearch).not.toHaveBeenCalled();
  });

  it("opens the matching run detail when given openId", async () => {
    mocks.listResearch.mockResolvedValue([
      summary({ id: "run_x", question: "What is Pie?", status: "done" }),
    ]);
    mocks.getResearch.mockResolvedValue(
      run({ id: "run_x", status: "done", report: "# Findings\nHello." }),
    );
    render(<ResearchPanel openId="run_x" />);
    expect(await screen.findByTestId("research-detail")).toBeTruthy();
    expect(await screen.findByTestId("research-report")).toBeTruthy();
  });
});

describe("ResearchPanel send to chat + download", () => {
  async function openDone() {
    mocks.listResearch.mockResolvedValue([
      summary({ id: "r2", question: "What is Pie?", status: "done" }),
    ]);
    mocks.getResearch.mockResolvedValue(
      run({
        id: "r2",
        status: "done",
        report: "# Findings\nHello.",
        sourcesFound: 1,
      }),
    );
    render(<ResearchPanel onSendToChat={mocks.onSendToChat} />);
    fireEvent.click(await screen.findByTestId("research-row-r2"));
    expect(await screen.findByTestId("research-detail")).toBeTruthy();
  }

  it("send to chat hands the report markdown to the callback and does not auto-start", async () => {
    await openDone();
    fireEvent.click(screen.getByTestId("research-send-to-chat"));
    expect(mocks.onSendToChat).toHaveBeenCalledWith("# Findings\nHello.");
    expect(mocks.startResearch).not.toHaveBeenCalled();
  });

  it("download uses the first 40 characters of the question plus the date", async () => {
    const { chromeMock } = await import("@/test/setup");
    const { researchDownloadFilename } = await import("@/lib/research-download");
    await openDone();
    fireEvent.click(screen.getByTestId("research-download"));
    const expectedName = researchDownloadFilename("What is Pie?");
    await waitFor(() =>
      expect(chromeMock.downloads.download).toHaveBeenCalledWith(
        expect.objectContaining({ filename: expectedName }),
      ),
    );
    expect(expectedName).toMatch(/^What is Pie-\d{4}-\d{2}-\d{2}\.md$/);
  });
});
