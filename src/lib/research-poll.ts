import { getResearch, type ResearchRun } from "./managed-research";
import { listInstances } from "./instances";
import { getConfig, setConfig } from "./idb/config-store";

/** SW chrome.alarms 名：固定单 alarm，周期 1 分钟。 */
export const RESEARCH_POLL_ALARM = "pie-research-poll";

const STORAGE_KEY = "research_in_progress_ids";
const PERIOD_MINUTES = 1;
const RESEARCH_NOTIF_PREFIX = "research-done:";

export interface ResearchPollDeps {
  fetchFn?: typeof fetch;
  locale?: string;
  /** 缺省取唯一 managed instance 的 apiKey。测试注入。 */
  getApiKey?: () => Promise<string | null>;
}

const TERMINAL_NO_NOTIFY = new Set(["failed_system", "cancelled"]);

async function readTrackedIds(): Promise<string[]> {
  const raw = await getConfig<string[]>(STORAGE_KEY);
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
}

async function writeTrackedIds(ids: string[]): Promise<void> {
  await setConfig(STORAGE_KEY, ids);
}

async function defaultGetApiKey(): Promise<string | null> {
  try {
    const inst = (await listInstances()).find((i) => i.provider === "managed");
    return inst?.apiKey ?? null;
  } catch {
    return null;
  }
}

async function ensureAlarm(): Promise<void> {
  if (!chrome.alarms) return;
  const existing = await chrome.alarms.get(RESEARCH_POLL_ALARM);
  if (existing) return;
  chrome.alarms.create(RESEARCH_POLL_ALARM, { periodInMinutes: PERIOD_MINUTES });
}

async function clearAlarmIfIdle(ids: string[]): Promise<void> {
  if (ids.length > 0 || !chrome.alarms) return;
  await chrome.alarms.clear(RESEARCH_POLL_ALARM);
}

function iconUrl(): string {
  try {
    return chrome.runtime.getURL("icons/icon-48.png");
  } catch {
    return "";
  }
}

/** 复用 schedules/notify.ts 的 chrome.notifications.create 写法；失败非致命。 */
async function notifyResearchDone(run: ResearchRun): Promise<void> {
  try {
    await new Promise<void>((resolve) => {
      chrome.notifications.create(
        `${RESEARCH_NOTIF_PREFIX}${run.id}`,
        {
          type: "basic",
          iconUrl: iconUrl(),
          title: "Research complete",
          message: (run.question || "Your research is ready.").slice(0, 100),
        },
        () => resolve(),
      );
    });
  } catch {
    // Notifications API unavailable or permission not granted — non-fatal.
  }
}

/** 把一个进行中 run 记入本地列表并保证 poll alarm 在跑。 */
export async function trackResearchRun(id: string): Promise<void> {
  if (!id) return;
  const ids = await readTrackedIds();
  if (!ids.includes(id)) ids.push(id);
  await writeTrackedIds(ids);
  await ensureAlarm();
}

/** 从本地列表移除；列表空则清 alarm。 */
export async function untrackResearchRun(id: string): Promise<void> {
  const ids = (await readTrackedIds()).filter((x) => x !== id);
  await writeTrackedIds(ids);
  await clearAlarmIfIdle(ids);
}

/**
 * SW chrome.alarms.onAlarm 入口。名不匹配则立即返回。
 * 对每个进行中 id GET /research/:id；终态移出列表；done 时发系统通知。
 */
export async function handleResearchPollAlarm(
  name: string,
  deps: ResearchPollDeps = {},
): Promise<void> {
  if (name !== RESEARCH_POLL_ALARM) return;
  try {
    await pollInProgressRuns(deps);
  } catch (e) {
    console.warn("[research-poll] poll failed:", e);
  }
}

async function pollInProgressRuns(deps: ResearchPollDeps): Promise<void> {
  const ids = await readTrackedIds();
  if (ids.length === 0) {
    await clearAlarmIfIdle(ids);
    return;
  }

  const getApiKey = deps.getApiKey ?? defaultGetApiKey;
  const apiKey = await getApiKey();
  if (!apiKey) return;

  const still: string[] = [];
  for (const id of ids) {
    try {
      const run = await getResearch(apiKey, id, deps);
      if (run.status === "done") {
        await notifyResearchDone(run);
      } else if (!TERMINAL_NO_NOTIFY.has(run.status)) {
        still.push(id);
      }
    } catch {
      still.push(id);
    }
  }
  await writeTrackedIds(still);
  await clearAlarmIfIdle(still);
}
