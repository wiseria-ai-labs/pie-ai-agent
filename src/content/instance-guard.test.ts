import { afterEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("chrome", { runtime: { id: "ext" } });
const { markOwned, startInstanceGuard } = await import("./instance-guard");

const flush = () => new Promise((r) => setTimeout(r, 0));

function addHost(attr: string, owned: boolean): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute(attr, "");
  if (owned) markOwned(el);
  document.documentElement.appendChild(el);
  return el;
}

describe("content instance guard", () => {
  afterEach(() => {
    document.documentElement.querySelectorAll("[data-pie-quote-bubble],[data-pie-capsule]").forEach((e) => e.remove());
    vi.stubGlobal("chrome", { runtime: { id: "ext" } });
  });

  it("removes hosts left by older instances, keeps its own", async () => {
    vi.stubGlobal("chrome", { runtime: { id: "ext" } });
    const stale = addHost("data-pie-quote-bubble", false);
    startInstanceGuard(() => {});
    expect(stale.isConnected).toBe(false);

    const lateStale = addHost("data-pie-capsule", false);
    const mine = addHost("data-pie-quote-bubble", true);
    await flush();
    expect(lateStale.isConnected).toBe(false);
    expect(mine.isConnected).toBe(true);

    // Same extension, other (older) instance → removed; another Pie install → kept.
    const sibling = addHost("data-pie-quote-bubble", false);
    sibling.setAttribute("data-pie-instance", "ext:older");
    const otherInstall = addHost("data-pie-quote-bubble", false);
    otherInstall.setAttribute("data-pie-instance", "store-ext:abc");
    await flush();
    expect(sibling.isConnected).toBe(false);
    expect(otherInstall.isConnected).toBe(true);
  });

  it("an orphaned instance stops guarding and detaches itself", async () => {
    const runtime: { id?: string } = { id: "ext" };
    vi.stubGlobal("chrome", { runtime });
    const onOrphaned = vi.fn();
    startInstanceGuard(onOrphaned);
    runtime.id = undefined; // extension reloaded under this instance
    const newer = addHost("data-pie-quote-bubble", false);
    await flush();
    expect(onOrphaned).toHaveBeenCalledTimes(1);
    expect(newer.isConnected).toBe(true);
  });
});
