import { render, renderHook, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecryptedInstance } from "@/lib/instances";
import type { Entitlement } from "@/lib/managed-auth";
import { ResearchError, type ResearchRun, type ResearchRunSummary } from "@/lib/managed-research";
import { publishChange } from "@/lib/store-bus";
import ResearchPanel, { hasResearchAccess } from "./ResearchPanel";
import { useResearchRun } from "./ResearchDetail";
import { SAMPLE_IDS, loadSample } from "./samples";

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

const noneEnt: Entitlement = {
  plan: "none",
  email: "u@x.com",
  subscription: null,
  quota: { weekly: { usedFraction: 0, resetAt: RESET_AT } },
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

  it("renders the three-phase timeline and cancel (no v2.8 fields)", async () => {
    await openDetail(run({ id: "r1", status: "running", phase: "gather", sourcesFound: 7 }));
    const progress = screen.getByTestId("research-progress");
    expect(progress.textContent).toMatch(/Planning/);
    expect(progress.textContent).toMatch(/Gathering sources/);
    expect(progress.textContent).toMatch(/Writing report/);
    // subQuestions 缺失 → 退回旧的来源计数 caption，不渲染子问题清单
    expect(progress.textContent).toMatch(/7 sources found/);
    expect(screen.queryByTestId("research-subquestions")).toBeNull();
    expect(screen.queryByTestId("research-recent-sources")).toBeNull();
    expect(screen.getByTestId("research-cancel")).toBeTruthy();
  });

  // 后端在 plan 阶段（plan 列还没写）会下发 subQuestions: []。空数组是 truthy，
  // 若不当作「没有」处理，gather 行会既没有清单也没有来源计数——是空的。
  it("treats an empty subQuestions array as absent, not as an empty list", async () => {
    await openDetail(
      run({ id: "r1c", status: "running", phase: "plan", sourcesFound: 0, subQuestions: [], recentSources: [] }),
    );
    expect(screen.getByTestId("research-progress").textContent).toMatch(/0 sources found/);
    expect(screen.queryByTestId("research-subquestions")).toBeNull();
    expect(screen.queryByTestId("research-recent-sources")).toBeNull();
  });

  it("expands sub-questions and the recent-source feed when v2.8 fields are present", async () => {
    await openDetail(
      run({
        id: "r1b",
        status: "running",
        phase: "gather",
        sourcesFound: 18,
        subQuestions: [
          { q: "What it is", status: "done", sources: 6 },
          { q: "Who builds it", status: "active", sources: 0 },
          { q: "How it differs", status: "pending", sources: 0 },
          { q: "Open source", status: "skipped", sources: 0, error: "tavily 502" },
        ],
        recentSources: [
          { title: "A Survey", url: "https://arxiv.org/abs/1", domain: "arxiv.org" },
        ],
      }),
    );
    const subs = screen.getByTestId("research-subquestions");
    expect(subs.textContent).toMatch(/What it is/);
    expect(subs.textContent).toMatch(/6 sources/);
    expect(subs.textContent).toMatch(/searching/);
    expect(subs.textContent).toMatch(/skipped/);
    expect(screen.getByTestId("research-sub-active")).toBeTruthy();
    expect(screen.getByTestId("research-sub-skipped")).toBeTruthy();
    // 子问题清单接管后不再重复渲染 "N sources found" caption
    expect(screen.getByTestId("research-progress").textContent).not.toMatch(/sources found/);
    const feed = screen.getByTestId("research-recent-sources");
    expect(feed.textContent).toMatch(/A Survey/);
    expect(feed.textContent).toMatch(/arxiv\.org/);
    expect(feed.textContent).toMatch(/18/);
  });

  it("renders a done report and reference list", async () => {
    await openDetail(
      run({
        id: "r2",
        status: "done",
        report: "# Findings\nHello.",
        references: [{ n: 1, title: "Pie site", url: "https://pie.chat" }],
        sourcesFound: 1,
        subQuestions: [
          { q: "a", status: "done", sources: 1 },
          { q: "b", status: "done", sources: 0 },
        ],
      }),
    );
    // 完成后时间轴收成一行，把版面让给报告
    expect(screen.queryByTestId("research-progress")).toBeNull();
    expect(screen.getByTestId("research-process-collapsed").textContent).toMatch(/all 2 directions done/);
    expect(screen.getByTestId("research-report")).toBeTruthy();
    expect(screen.getByTestId("markdown").textContent).toBe("# Findings\nHello.");
    const refs = screen.getByTestId("research-references");
    expect(refs.textContent).toMatch(/\[1\] Pie site — https:\/\/pie\.chat/);
    const link = refs.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://pie.chat");
    expect(link?.getAttribute("target")).toBe("_blank");
  });

  it("does not render javascript: reference urls as links", async () => {
    await openDetail(
      run({
        id: "r-js-ref",
        status: "done",
        report: "# x",
        references: [{ n: 1, title: "Evil", url: "javascript:alert(1)" }],
        sourcesFound: 1,
      }),
    );
    const refs = screen.getByTestId("research-references");
    expect(refs.textContent).toMatch(/\[1\] Evil — javascript:alert\(1\)/);
    expect(refs.querySelector("a")).toBeNull();
    expect(refs.innerHTML).not.toMatch(/href=["']javascript:/i);
  });

  it("does not render javascript: recentSources as links", async () => {
    await openDetail(
      run({
        id: "r-js-src",
        status: "running",
        phase: "gather",
        sourcesFound: 1,
        recentSources: [{ title: "Evil", url: "javascript:alert(1)", domain: "evil" }],
      }),
    );
    const feed = screen.getByTestId("research-recent-sources");
    expect(feed.textContent).toMatch(/Evil/);
    expect(feed.querySelector("a")).toBeNull();
    expect(feed.innerHTML).not.toMatch(/href=["']javascript:/i);
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

describe("hasResearchAccess", () => {
  it("requires plan:active and quota.research", () => {
    expect(hasResearchAccess(null)).toBe(false);
    expect(hasResearchAccess(noneEnt)).toBe(false);
    expect(hasResearchAccess({ ...entitlement, quota: { weekly: entitlement.quota!.weekly } })).toBe(false);
    expect(hasResearchAccess(entitlement)).toBe(true);
  });
});

describe("ResearchPanel paywall", () => {
  it("plan:none shows paywall and sample list, not the composer or run list", async () => {
    mocks.getEntitlement.mockResolvedValue(noneEnt);
    render(<ResearchPanel />);
    expect(await screen.findByTestId("research-paywall")).toBeTruthy();
    expect(screen.getByTestId("research-samples")).toBeTruthy();
    for (const id of SAMPLE_IDS) {
      expect(screen.getByTestId(`research-sample-${id}`)).toBeTruthy();
    }
    expect(screen.queryByTestId("research-question")).toBeNull();
    expect(screen.queryByTestId("research-empty")).toBeNull();
    expect(screen.queryByTestId("research-start")).toBeNull();
    expect(mocks.listResearch).not.toHaveBeenCalled();
  });

  it("no managed login at all still reaches the paywall and samples", async () => {
    mocks.listInstances.mockResolvedValue([]);
    render(<ResearchPanel />);
    expect(await screen.findByTestId("research-paywall")).toBeTruthy();
    expect(screen.getByTestId("research-samples")).toBeTruthy();
    expect(mocks.getEntitlement).not.toHaveBeenCalled();
    expect(mocks.listResearch).not.toHaveBeenCalled();
  });

  it("plan:active does not show the paywall", async () => {
    render(<ResearchPanel />);
    expect(await screen.findByTestId("research-question")).toBeTruthy();
    expect(screen.queryByTestId("research-paywall")).toBeNull();
    expect(screen.queryByTestId("research-samples")).toBeNull();
  });

  it("clicking a sample renders it in the shared detail view without cancel or polling", async () => {
    mocks.getEntitlement.mockResolvedValue(noneEnt);
    render(<ResearchPanel />);
    fireEvent.click(await screen.findByTestId("research-sample-ai-regulation"));
    expect(await screen.findByTestId("research-detail")).toBeTruthy();
    expect(screen.getByTestId("research-report")).toBeTruthy();
    expect(screen.getByTestId("markdown").textContent).toMatch(/References/);
    expect(screen.getByText(loadSample("ai-regulation", "en").title)).toBeTruthy();
    expect(screen.queryByTestId("research-cancel")).toBeNull();
    expect(mocks.getResearch).not.toHaveBeenCalled();
    expect(mocks.cancelResearch).not.toHaveBeenCalled();
  });

  it("switches from paywall to the live list when entitlement becomes active", async () => {
    mocks.getEntitlement.mockResolvedValue(noneEnt);
    mocks.getCachedEntitlement.mockReturnValue(noneEnt);
    render(<ResearchPanel />);
    expect(await screen.findByTestId("research-paywall")).toBeTruthy();

    mocks.getCachedEntitlement.mockReturnValue(entitlement);
    act(() => publishChange("config", "put", "managed_entitlement_sk-v"));

    // Longest chain in the file (paywall → store event → refetch → list);
    // the default 1s findBy timeout flakes on a cold transform cache.
    expect(await screen.findByTestId("research-question", {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByTestId("research-paywall")).toBeNull();
    await waitFor(() => expect(mocks.listResearch).toHaveBeenCalledTimes(1));
  });

  it("subscribe routes out to settings instead of signing in here", async () => {
    // Signing in from this page used to skip provider-instance creation:
    // the page unlocked but no key existed to run research with.
    const onOpenSubscribe = vi.fn();
    mocks.getEntitlement.mockResolvedValue(noneEnt);
    render(<ResearchPanel onOpenSubscribe={onOpenSubscribe} />);
    expect(screen.queryByTestId("research-paywall-redeem")).toBeNull();
    fireEvent.click(await screen.findByTestId("research-paywall-subscribe"));
    expect(onOpenSubscribe).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/no active subscription/i)).toBeNull();
    expect(screen.getByTestId("research-paywall")).toBeTruthy();
  });

  it("signed-out visitor still sees the intro-offer badge (no entitlement to ask)", async () => {
    mocks.listInstances.mockResolvedValue([]);
    render(<ResearchPanel />);
    const btn = await screen.findByTestId("research-paywall-subscribe");
    expect(btn.textContent).toMatch(/50% off/i);
  });

  it("hides the badge for a signed-in user the backend deemed ineligible", async () => {
    mocks.getEntitlement.mockResolvedValue(noneEnt);
    render(<ResearchPanel />);
    const btn = await screen.findByTestId("research-paywall-subscribe");
    expect(btn.textContent).not.toMatch(/off/i);
  });

  it("sample cards carry the opening paragraph and the front-matter run stats", async () => {
    mocks.getEntitlement.mockResolvedValue(noneEnt);
    render(<ResearchPanel />);
    const card = await screen.findByTestId("research-sample-ai-regulation");
    const sample = loadSample("ai-regulation", "en");
    expect(sample.stats).toBeTruthy();
    expect(card.textContent).toContain(sample.summary);
    expect(card.textContent).toContain(`${sample.stats!.sources} sources`);
    expect(card.textContent).toContain(`${sample.stats!.minutes} min`);
  });
});
