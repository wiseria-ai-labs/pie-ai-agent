import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  RESEARCH_POLL_ALARM,
  trackResearchRun,
  untrackResearchRun,
  handleResearchPollAlarm,
} from "./research-poll";
import { getConfig } from "./idb/config-store";
import { _resetForTests } from "./idb/db";

const STORAGE_KEY = "research_in_progress_ids";

function installChromeStub() {
  const alarms = new Map<string, { name: string; periodInMinutes?: number }>();
  const create = vi.fn((name: string, info: { periodInMinutes?: number; when?: number }) => {
    alarms.set(name, { name, periodInMinutes: info.periodInMinutes });
  });
  const clear = vi.fn((name: string) => {
    const had = alarms.has(name);
    alarms.delete(name);
    return Promise.resolve(had);
  });
  const get = vi.fn((name: string) => Promise.resolve(alarms.get(name)));
  const notifCreate = vi.fn((_id: string, _opts: object, cb?: () => void) => {
    cb?.();
  });
  // 挂到 setup.ts 的 chrome mock 上（alarms / notifications）；id 列表走 IDB config-store。
  const c = chrome as unknown as {
    alarms: unknown;
    notifications: unknown;
  };
  c.alarms = { create, clear, get, onAlarm: { addListener: vi.fn() } };
  c.notifications = { create: notifCreate };
  return { create, clear, get, notifCreate, alarms };
}

let stub: ReturnType<typeof installChromeStub>;

beforeEach(async () => {
  await _resetForTests();
  stub = installChromeStub();
});

afterEach(() => {
  delete (chrome as unknown as { alarms?: unknown }).alarms;
  delete (chrome as unknown as { notifications?: unknown }).notifications;
});

async function trackedIds(): Promise<string[]> {
  return (await getConfig<string[]>(STORAGE_KEY)) ?? [];
}

function fetchReturning(run: unknown, status = 200): typeof fetch {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => run,
  })) as unknown as typeof fetch;
}

describe("trackResearchRun / untrackResearchRun", () => {
  it("track 写入 id 并创建 1 分钟周期 alarm", async () => {
    await trackResearchRun("run_a");
    expect(await trackedIds()).toEqual(["run_a"]);
    expect(stub.create).toHaveBeenCalledWith(RESEARCH_POLL_ALARM, { periodInMinutes: 1 });
  });

  it("重复 track 不重复写入；alarm 已在则不再 create", async () => {
    await trackResearchRun("run_a");
    await trackResearchRun("run_a");
    expect(await trackedIds()).toEqual(["run_a"]);
    expect(stub.create).toHaveBeenCalledOnce();
  });

  it("untrack 最后一个 id 后清除 alarm", async () => {
    await trackResearchRun("run_a");
    await untrackResearchRun("run_a");
    expect(await trackedIds()).toEqual([]);
    expect(stub.clear).toHaveBeenCalledWith(RESEARCH_POLL_ALARM);
  });
});

describe("handleResearchPollAlarm", () => {
  it("done → 移出列表并发 notification", async () => {
    await trackResearchRun("run_done");
    const fetchFn = fetchReturning({
      id: "run_done",
      question: "What is Pie?",
      status: "done",
      sourcesFound: 3,
      report: "# ok",
    });
    await handleResearchPollAlarm(RESEARCH_POLL_ALARM, {
      fetchFn,
      getApiKey: async () => "sk-r",
      locale: "en",
    });
    expect(await trackedIds()).toEqual([]);
    expect(stub.notifCreate).toHaveBeenCalledOnce();
    const [notifId, opts] = stub.notifCreate.mock.calls[0]!;
    expect(notifId).toBe("research-done:run_done");
    expect((opts as { title: string }).title).toMatch(/research/i);
    expect((opts as { message: string }).message).toContain("What is Pie?");
    expect(stub.clear).toHaveBeenCalledWith(RESEARCH_POLL_ALARM);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://account.pie.chat/research/run_done?locale=en",
      expect.objectContaining({ headers: { authorization: "Bearer sk-r" } }),
    );
  });

  it("failed_system → 移出但不发 notification", async () => {
    await trackResearchRun("run_fail");
    const fetchFn = fetchReturning({
      id: "run_fail",
      question: "Q",
      status: "failed_system",
      sourcesFound: 0,
      error: "boom",
    });
    await handleResearchPollAlarm(RESEARCH_POLL_ALARM, {
      fetchFn,
      getApiKey: async () => "sk-r",
      locale: "en",
    });
    expect(await trackedIds()).toEqual([]);
    expect(stub.notifCreate).not.toHaveBeenCalled();
    expect(stub.clear).toHaveBeenCalledWith(RESEARCH_POLL_ALARM);
  });

  it("cancelled → 移出但不发 notification", async () => {
    await trackResearchRun("run_cancel");
    await handleResearchPollAlarm(RESEARCH_POLL_ALARM, {
      fetchFn: fetchReturning({ id: "run_cancel", question: "Q", status: "cancelled", sourcesFound: 0 }),
      getApiKey: async () => "sk-r",
      locale: "en",
    });
    expect(await trackedIds()).toEqual([]);
    expect(stub.notifCreate).not.toHaveBeenCalled();
  });

  it("running 保留在列表且不通知、不清 alarm", async () => {
    await trackResearchRun("run_run");
    stub.clear.mockClear();
    await handleResearchPollAlarm(RESEARCH_POLL_ALARM, {
      fetchFn: fetchReturning({
        id: "run_run",
        question: "Q",
        status: "running",
        phase: "gather",
        sourcesFound: 2,
      }),
      getApiKey: async () => "sk-r",
      locale: "en",
    });
    expect(await trackedIds()).toEqual(["run_run"]);
    expect(stub.notifCreate).not.toHaveBeenCalled();
    expect(stub.clear).not.toHaveBeenCalled();
  });

  it("空列表 → 清 alarm 且不 fetch", async () => {
    const fetchFn = fetchReturning({});
    await handleResearchPollAlarm(RESEARCH_POLL_ALARM, {
      fetchFn,
      getApiKey: async () => "sk-r",
    });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(stub.clear).toHaveBeenCalledWith(RESEARCH_POLL_ALARM);
    expect(stub.notifCreate).not.toHaveBeenCalled();
  });

  it("名不匹配则什么都不做", async () => {
    await trackResearchRun("run_x");
    const fetchFn = fetchReturning({ id: "run_x", status: "done", question: "Q", sourcesFound: 0 });
    await handleResearchPollAlarm("schedule:abc", {
      fetchFn,
      getApiKey: async () => "sk-r",
    });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await trackedIds()).toEqual(["run_x"]);
  });
});
