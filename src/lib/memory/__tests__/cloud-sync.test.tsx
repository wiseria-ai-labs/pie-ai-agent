import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { _resetForTests } from "@/lib/idb/db";
import { _resetKeyForTests } from "@/lib/crypto";
import { createInstance } from "@/lib/instances";
import {
  _clearEntitlementCacheForTests,
  cacheEntitlement,
} from "@/lib/managed-account";
import type { Entitlement } from "@/lib/managed-auth";
import { getMemoryAccessState } from "@/lib/memory/access";
import { normalizeCloudEntry } from "@/lib/memory/cloud";
import { flushMemoryDigests } from "@/lib/memory/digest-sync";
import { _setMemoryRequiresSubscriptionForTests } from "@/lib/memory/model";
import {
  _setMemoryCloudConsentForTests,
  acceptPrivacyPolicy,
  declineCloudMemoryConsent,
  getPrivacyConsent,
} from "@/lib/privacy-consent";
import { pickMemory } from "@/lib/memory/selector";
import {
  dismissFirstConsolidationNotice,
  getMemoryProfile,
  getMemorySettings,
  getMemoryState,
  listMemoryEntries,
  rememberEntry,
  setMemorySettings,
  setMemoryState,
  setMemoryProfileText,
} from "@/lib/memory/store";
import {
  _resetMemorySyncForTests,
  syncClearAllMemory,
  syncDeleteMemoryEntries,
  syncMemoryFromCloud,
  syncRestoreMemorySnapshot,
  syncSetMemorySettings,
  syncUndoMemoryEvent,
  syncUpdateMemoryEntry,
} from "@/lib/memory/sync";
import { handleMemoryAlarm, MEMORY_ALARM } from "@/lib/memory/tick";
import MemoryPage from "@/sidepanel/components/settings/pages/MemoryPage";
import type { SessionIndexEntry, SessionMeta } from "@/lib/sessions/types";

function activeEnt(): Entitlement {
  return {
    plan: "active",
    email: "pro@pie.chat",
    subscription: {
      planName: "Pie Pro",
      currentPeriodEnd: Date.now() + 86_400_000,
      cancelAtPeriodEnd: false,
      source: "stripe",
      interval: "month",
    },
    quota: { weekly: { usedFraction: 0.2, resetAt: Date.now() + 86_400_000 } },
    models: [],
  };
}

function expiredEnt(): Entitlement {
  return {
    plan: "none",
    email: "old@pie.chat",
    subscription: null,
    quota: null,
    models: [],
  };
}

beforeEach(async () => {
  await _resetForTests();
  _resetKeyForTests();
  _clearEntitlementCacheForTests();
  _resetMemorySyncForTests();
  _setMemoryRequiresSubscriptionForTests(true);
  _setMemoryCloudConsentForTests(true);
});

afterEach(() => {
  cleanup();
  _setMemoryRequiresSubscriptionForTests(null);
  _setMemoryCloudConsentForTests(null);
  _clearEntitlementCacheForTests();
  _resetMemorySyncForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("normalizeCloudEntry & access gating", () => {
  it("strips validTo: null so live cloud entries are not treated as expired", () => {
    const entry = normalizeCloudEntry({
      id: "m_1",
      kind: "about",
      title: "工程师",
      body: "做前端与扩展开发",
      tags: ["职业"],
      createdAt: 1000,
      updatedAt: 1000,
      validFrom: 1000,
      validTo: null,
      useCount: 0,
      lastUsedAt: null,
      pinned: false,
      encrypted: false,
      origin: "consolidated",
    });
    expect(entry).not.toBeNull();
    expect(entry!.validTo).toBeUndefined();
    expect("validTo" in entry!).toBe(false);
    expect("lastUsedAt" in entry!).toBe(false);
  });

  it("classifies local_dev, locked, readonly_expired, and cloud_active accurately", async () => {
    expect((await getMemoryAccessState()).mode).toBe("locked");

    await setMemoryState({ cloudReadOnly: true });
    expect((await getMemoryAccessState()).mode).toBe("readonly_expired");

    await createInstance({ provider: "managed", nickname: "Pie", apiKey: "mk_1" });
    await cacheEntitlement("mk_1", activeEnt());
    expect((await getMemoryAccessState()).mode).toBe("cloud_active");

    _setMemoryRequiresSubscriptionForTests(false);
    expect((await getMemoryAccessState()).mode).toBe("local_dev");
  });
});

describe("syncMemoryFromCloud, local import bootstrap & write-through", () => {
  it("imports existing local memories on first cloud login when server revision === 0", async () => {
    await rememberEntry({
      kind: "about",
      title: "本地旧记忆",
      body: "常用 TypeScript",
    });
    await setMemoryProfileText("核心画像：前端开发者", 1000);
    await createInstance({ provider: "managed", nickname: "Pie", apiKey: "mk_boot" });
    await cacheEntitlement("mk_boot", activeEnt());

    let importedBody: unknown = null;
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/memory?") || u.endsWith("/memory")) {
        return new Response(
          JSON.stringify({
            unchanged: false,
            revision: 0,
            readOnly: false,
            settings: { enabled: true, excludedDomains: [] },
            profile: { text: "", updatedAt: 0 },
            state: { hasSnapshot: false },
            entries: [],
          }),
          { status: 200 },
        );
      }
      if (u.endsWith("/memory/import")) {
        importedBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(
          JSON.stringify({
            unchanged: false,
            revision: 1,
            readOnly: false,
            settings: { enabled: true, excludedDomains: [] },
            profile: { text: "核心画像：前端开发者", updatedAt: 1000 },
            state: { hasSnapshot: false },
            entries: [
              {
                id: "m_imported",
                kind: "about",
                title: "本地旧记忆",
                body: "常用 TypeScript",
                tags: [],
                createdAt: 1000,
                updatedAt: 1000,
                validFrom: 1000,
                validTo: null,
                useCount: 0,
                lastUsedAt: null,
                pinned: false,
                encrypted: false,
                origin: "consolidated",
              },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected ${u}`);
    });

    const res = await syncMemoryFromCloud({ force: true, deps: { fetchFn } });
    expect(res?.revision).toBe(1);
    expect(importedBody).toBeTruthy();
    expect((importedBody as { profileText: string }).profileText).toBe("核心画像：前端开发者");
    expect((await getMemoryState()).cloudImported).toBe(true);
    expect((await getMemoryState()).cloudRevision).toBe(1);
    expect((await listMemoryEntries()).map((e) => e.id)).toEqual(["m_imported"]);
  });

  it("mirrors contact entries encrypted locally and sets/dismisses first-consolidation banner", async () => {
    await createInstance({ provider: "managed", nickname: "Pie", apiKey: "mk_sync" });
    await cacheEntitlement("mk_sync", activeEnt());
    await setMemoryState({ cloudImported: true });

    let pullCount = 0;
    const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("sinceRevision=2")) {
        return new Response(
          JSON.stringify({ unchanged: true, revision: 2, readOnly: false }),
          { status: 200 },
        );
      }
      pullCount += 1;
      return new Response(
        JSON.stringify({
          unchanged: false,
          revision: 2,
          readOnly: false,
          settings: { enabled: true, excludedDomains: ["bank.example"] },
          profile: { text: "画像：上海产品经理", updatedAt: 2000 },
          state: {
            lastConsolidatedAt: 2000,
            hasSnapshot: true,
            lastSummary: {
              at: 2000,
              added: 1,
              updated: 0,
              merged: 0,
              expired: 0,
              deleted: 0,
              profileRewritten: true,
            },
          },
          entries: [
            {
              id: "m_contact",
              kind: "contact",
              title: "收货手机",
              body: "13800138000",
              tags: [],
              createdAt: 2000,
              updatedAt: 2000,
              validFrom: 2000,
              validTo: null,
              useCount: 0,
              lastUsedAt: null,
              pinned: false,
              encrypted: true,
              origin: "consolidated",
            },
          ],
        }),
        { status: 200 },
      );
    });

    await syncMemoryFromCloud({ force: true, now: 10_000, deps: { fetchFn } });
    expect(pullCount).toBe(1);
    const list = await listMemoryEntries();
    expect(list).toHaveLength(1);
    expect(list[0]!.encrypted).toBe(true);
    expect(list[0]!.body).toBe("13800138000");
    expect((await getMemoryProfile()).text).toBe("画像：上海产品经理");
    expect((await getMemorySettings()).excludedDomains).toEqual(["bank.example"]);
    expect((await getMemoryState()).firstConsolidationPendingBanner).toBe(true);
    expect((await getMemoryState()).hasCloudSnapshot).toBe(true);

    // O(1) sinceRevision fast path when revision matches
    const second = await syncMemoryFromCloud({ now: 35_000, deps: { fetchFn } });
    expect(second?.unchanged).toBe(true);
    expect(pullCount).toBe(1);

    await dismissFirstConsolidationNotice();
    const afterDismiss = await getMemoryState();
    expect(afterDismiss.firstConsolidationPendingBanner).toBe(false);
    expect(afterDismiss.firstConsolidationNoticeShown).toBe(true);
  });

  it("preserves local memories for expired users when cloud returns empty readOnly revision=0", async () => {
    await rememberEntry({ kind: "about", title: "本地保留条", body: "不应被空云端抹掉" });
    await createInstance({ provider: "managed", nickname: "Pie", apiKey: "mk_old" });
    await cacheEntitlement("mk_old", expiredEnt());

    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({
          unchanged: false,
          revision: 0,
          readOnly: true,
          settings: { enabled: true, excludedDomains: [] },
          profile: { text: "", updatedAt: 0 },
          state: { hasSnapshot: false },
          entries: [],
        }),
        { status: 200 },
      ),
    );

    await syncMemoryFromCloud({ force: true, deps: { fetchFn } });
    const kept = await listMemoryEntries();
    expect(kept.map((e) => e.title)).toEqual(["本地保留条"]);
    expect((await getMemoryState()).cloudReadOnly).toBe(true);
  });

  it("supports write-through settings, edit, delete, undo, restore, and clear even in readOnly", async () => {
    await createInstance({ provider: "managed", nickname: "Pie", apiKey: "mk_wr" });
    await cacheEntitlement("mk_wr", activeEnt());
    await setMemoryState({ cloudImported: true });

    let rev = 1;
    const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.endsWith("/memory/settings")) {
        rev += 1;
        return new Response(
          JSON.stringify({
            revision: rev,
            settings: { enabled: false, excludedDomains: ["x.com"] },
          }),
          { status: 200 },
        );
      }
      if (u.includes("/memory/entries/m_1") && !u.endsWith("/delete")) {
        rev += 1;
        return new Response(
          JSON.stringify({
            ok: true,
            revision: rev,
            entry: {
              id: "m_1",
              kind: "about",
              title: "改后标题",
              body: "改后内容",
              tags: [],
              createdAt: 1000,
              updatedAt: 3000,
              validFrom: 1000,
              validTo: null,
              useCount: 0,
              lastUsedAt: null,
              pinned: false,
              encrypted: false,
              origin: "user",
            },
          }),
          { status: 200 },
        );
      }
      if (u.endsWith("/memory/entries/delete")) {
        rev += 1;
        return new Response(
          JSON.stringify({ revision: rev, count: 1, eventId: "undo_del" }),
          { status: 200 },
        );
      }
      if (u.endsWith("/memory/undo")) {
        rev += 1;
        return new Response(
          JSON.stringify({ ok: true, kind: "deleted", revision: rev }),
          { status: 200 },
        );
      }
      if (u.endsWith("/memory/snapshot/restore")) {
        rev += 1;
        return new Response(JSON.stringify({ ok: true, revision: rev }), { status: 200 });
      }
      if (u.endsWith("/memory/clear")) {
        rev += 1;
        return new Response(JSON.stringify({ ok: true, revision: rev }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          unchanged: false,
          revision: rev,
          readOnly: false,
          settings: { enabled: false, excludedDomains: ["x.com"] },
          profile: { text: "", updatedAt: 0 },
          state: { hasSnapshot: false },
          entries: [],
        }),
        { status: 200 },
      );
    });

    const s = await syncSetMemorySettings(
      { enabled: false, excludedDomains: ["x.com"] },
      { fetchFn },
    );
    expect(s.enabled).toBe(false);
    expect(s.excludedDomains).toEqual(["x.com"]);

    expect(
      await syncUpdateMemoryEntry("m_1", { title: "改后标题", body: "改后内容" }, { fetchFn }),
    ).toBe(true);
    expect((await listMemoryEntries()).find((e) => e.id === "m_1")?.body).toBe("改后内容");

    const del = await syncDeleteMemoryEntries(["m_1"], { fetchFn });
    expect(del.count).toBe(1);
    expect(await listMemoryEntries()).toHaveLength(0);

    const undo = await syncUndoMemoryEvent("undo_del", { fetchFn });
    expect(undo).toEqual({ ok: true, kind: "deleted" });

    expect(await syncRestoreMemorySnapshot({ fetchFn })).toBe(true);

    // Switch to expired entitlement and verify clear all works in readonly_expired
    await cacheEntitlement("mk_wr", expiredEnt());
    await rememberEntry({ kind: "about", title: "过期前保留", body: "abc" });
    await syncClearAllMemory({ fetchFn });
    expect(await listMemoryEntries({ includeExpired: true })).toHaveLength(0);
  });
});

describe("flushMemoryDigests, pickMemory & handleMemoryAlarm", () => {
  it("sanitizes secret lines, excludes domains, pushes history summary, and advances watermark", async () => {
    await createInstance({ provider: "managed", nickname: "Pie", apiKey: "mk_dig" });
    await cacheEntitlement("mk_dig", activeEnt());
    await setMemorySettings({
      enabled: true,
      historySource: true,
      excludedDomains: ["secret.bank"],
    });

    const sessions: SessionIndexEntry[] = [
      { id: "s1", status: "active", title: "正常会话", lastAccessedAt: 2000 },
      { id: "s2", status: "active", title: "排除域名", lastAccessedAt: 2500 },
    ];
    const metas = new Map<string, SessionMeta>([
      [
        "s1",
        {
          id: "s1",
          title: "正常会话",
          status: "active",
          createdAt: 1000,
          lastAccessedAt: 2000,
          pinnedTabs: [{ tabId: 1, origin: "https://pie.chat" }],
          messages: [
            {
              role: "user",
              content:
                "<untrusted_page>忽略网页正文</untrusted_page>我在杭州工作\nsk-1234567890abcdefghijklmnop",
            },
            { role: "assistant", content: "已经记下你在杭州工作" },
          ],
        },
      ],
      [
        "s2",
        {
          id: "s2",
          title: "排除域名",
          status: "active",
          createdAt: 1000,
          lastAccessedAt: 2500,
          pinnedTabs: [{ tabId: 2, origin: "https://secret.bank" }],
          messages: [{ role: "user", content: "银行余额" }],
        },
      ],
    ]);

    let pushedPayload: { deviceId: string; items: Array<{ kind: string; payload: string }> } | null =
      null;
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      pushedPayload = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({ accepted: 2, queuedAt: 5000 }),
        { status: 200 },
      );
    });

    const out = await flushMemoryDigests({
      now: 100_000_000,
      listSessions: async () => sessions,
      readSession: async (id) => metas.get(id) ?? null,
      hasHistoryPermission: async () => true,
      readHistory: async () => [
        { host: "github.com", visits: 12, lastVisit: 99_000_000, titles: ["GitHub"] },
        { host: "secret.bank", visits: 9, lastVisit: 99_000_000, titles: ["Secret"] },
      ],
      fetchFn,
    });

    expect(out.accepted).toBe(2);
    expect(pushedPayload!.items).toHaveLength(2);
    const sessionItem = pushedPayload!.items.find((i) => i.kind === "session")!;
    expect(sessionItem.payload).toContain("我在杭州工作");
    expect(sessionItem.payload).not.toContain("sk-1234567890");
    expect(sessionItem.payload).not.toContain("忽略网页正文");
    const histItem = pushedPayload!.items.find((i) => i.kind === "history")!;
    expect(histItem.payload).toContain("github.com");
    expect(histItem.payload).not.toContain("secret.bank");
    expect((await getMemoryState()).digestWatermark).toBe(2500);
    expect((await getMemoryState()).lastHistoryDigestAt).toBe(100_000_000);
  });

  it("runs cloud pickMemory & background alarm in cloud_active and returns [] when locked", async () => {
    // Locked -> pickMemory returns [] without network call
    expect(await pickMemory({ task: "订票" })).toEqual([]);

    await createInstance({ provider: "managed", nickname: "Pie", apiKey: "mk_pick" });
    await cacheEntitlement("mk_pick", activeEnt());
    await setMemoryState({ cloudImported: true, cloudRevision: 1 });

    const seenUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const u = String(url);
        seenUrls.push(u);
        if (u.endsWith("/memory/pick")) {
          return new Response(
            JSON.stringify({
              revision: 2,
              entries: [
                {
                  id: "m_p1",
                  kind: "preference",
                  title: "偏好一等座",
                  body: "高铁",
                  tags: [],
                  createdAt: 1000,
                  updatedAt: 1000,
                  validFrom: 1000,
                  validTo: null,
                  useCount: 1,
                  lastUsedAt: 1000,
                  pinned: false,
                  encrypted: false,
                  origin: "consolidated",
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({ unchanged: true, revision: 2, readOnly: false }),
          { status: 200 },
        );
      }),
    );

    const picked = await pickMemory({ task: "买明天高铁票" });
    expect(picked.map((e) => e.id)).toEqual(["m_p1"]);

    await handleMemoryAlarm(MEMORY_ALARM, { isBusy: () => false, now: () => 123_000 });
    expect(seenUrls.some((u) => u.endsWith("/memory/pick"))).toBe(true);
    expect(seenUrls.some((u) => u.includes("/memory"))).toBe(true);
  });
});

describe("MemoryPage UI gating & multi-device read-only retention", () => {
  it("renders MemoryPaywall when unsubscribed (locked) and triggers onOpenSubscribe", async () => {
    const onSub = vi.fn();
    render(<MemoryPage onOpenSubscribe={onSub} />);
    await waitFor(() => expect(screen.getByTestId("memory-paywall")).toBeTruthy());
    fireEvent.click(screen.getByTestId("memory-paywall-subscribe"));
    expect(onSub).toHaveBeenCalledTimes(1);
  });

  it("loads churned cloud snapshot on a second device into readonly mode and supports clear all", async () => {
    await createInstance({ provider: "managed", nickname: "Pie", apiKey: "mk_2nd" });
    await cacheEntitlement("mk_2nd", expiredEnt());

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u.includes("/me/entitlement")) {
          return new Response(JSON.stringify(expiredEnt()), { status: 200 });
        }
        if (u.endsWith("/memory/clear")) {
          return new Response(JSON.stringify({ ok: true, revision: 4 }), { status: 200 });
        }
        if (u.includes("/memory")) {
          return new Response(
            JSON.stringify({
              unchanged: false,
              revision: 3,
              readOnly: true,
              settings: { enabled: true, excludedDomains: [] },
              profile: { text: "画像：老用户", updatedAt: 1000 },
              state: { hasSnapshot: true },
              entries: [
                {
                  id: "m_ro1",
                  kind: "about",
                  title: "常驻深圳",
                  body: "南山区",
                  tags: [],
                  createdAt: 1000,
                  updatedAt: 1000,
                  validFrom: 1000,
                  validTo: null,
                  useCount: 0,
                  lastUsedAt: null,
                  pinned: false,
                  encrypted: false,
                  origin: "consolidated",
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({}), { status: 404 });
      }),
    );

    const onSub = vi.fn();
    render(<MemoryPage onOpenSubscribe={onSub} />);

    // Second device pulls readOnly cloud snapshot and flips from locked -> readonly_expired
    await waitFor(() =>
      expect(screen.getByTestId("memory-readonly-banner")).toBeTruthy(),
    );

    const sw = screen.getByTestId("memory-switch") as HTMLButtonElement;
    expect(sw.disabled).toBe(true);
    expect(screen.queryByTestId("memory-restore")).toBeNull();

    // Category view hides edit buttons when readOnly
    fireEvent.click(screen.getByTestId("memory-kind-about"));
    await waitFor(() => expect(screen.getByText("南山区")).toBeTruthy());
    expect(screen.queryByTestId("memory-edit-m_ro1")).toBeNull();

    // Back & Clear All works even in read-only mode (user deletion right)
    fireEvent.click(screen.getByText("Memory"));
    await waitFor(() => expect(screen.getByTestId("memory-clear")).toBeTruthy());
    fireEvent.click(screen.getByTestId("memory-clear"));
    fireEvent.click(screen.getByTestId("memory-clear-confirm"));

    await waitFor(() =>
      expect(screen.getByTestId("memory-paywall")).toBeTruthy(),
    );
  });

  it("blocks flushMemoryDigests and local cloud import without privacy consent", async () => {
    _setMemoryCloudConsentForTests(null);
    await createInstance({ provider: "managed", nickname: "Pie", apiKey: "mk_gate" });
    await cacheEntitlement("mk_gate", activeEnt());
    await rememberEntry({ kind: "about", title: "本地保留", body: "未同意前不上云" });

    const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/memory?") || u.endsWith("/memory")) {
        return new Response(
          JSON.stringify({
            unchanged: false,
            revision: 0,
            readOnly: false,
            settings: { enabled: true, excludedDomains: [] },
            profile: { text: "", updatedAt: 0 },
            state: { hasSnapshot: false },
            entries: [],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected cloud upload ${u}`);
    });

    // Without consent, syncMemoryFromCloud does NOT call /memory/import
    await syncMemoryFromCloud({ force: true, deps: { fetchFn } });
    expect(fetchFn.mock.calls.some(([u]) => String(u).endsWith("/memory/import"))).toBe(false);

    // Without consent, flushMemoryDigests uploads nothing
    const digestFetch = vi.fn();
    const out = await flushMemoryDigests({
      now: 100_000_000,
      listSessions: async () => [{ id: "s1", status: "active", title: "Chat", lastAccessedAt: 2000 }],
      readSession: async () => ({
        id: "s1",
        title: "Chat",
        status: "active",
        createdAt: 1000,
        lastAccessedAt: 2000,
        messages: [{ role: "user", content: "remember this" }],
      }),
      fetchFn: digestFetch as unknown as typeof fetch,
    });
    expect(out.accepted).toBe(0);
    expect(digestFetch).not.toHaveBeenCalled();

    // Once consented, flushMemoryDigests proceeds normally
    await acceptPrivacyPolicy("subscribe");
    const okFetch = vi.fn(async () => new Response(JSON.stringify({ accepted: 1, queuedAt: 5000 }), { status: 200 }));
    const okOut = await flushMemoryDigests({
      now: 100_000_000,
      listSessions: async () => [{ id: "s1", status: "active", title: "Chat", lastAccessedAt: 2000 }],
      readSession: async () => ({
        id: "s1",
        title: "Chat",
        status: "active",
        createdAt: 1000,
        lastAccessedAt: 2000,
        messages: [{ role: "user", content: "remember this" }],
      }),
      fetchFn: okFetch as unknown as typeof fetch,
    });
    expect(okOut.accepted).toBe(1);
    expect(okFetch).toHaveBeenCalledTimes(1);
  });

  it("shows privacy consent banner on MemoryPage when declined and records consent on agree", async () => {
    _setMemoryCloudConsentForTests(null);
    await declineCloudMemoryConsent();
    await setMemorySettings({ enabled: false });
    await createInstance({ provider: "managed", nickname: "Pie", apiKey: "mk_banner" });
    await cacheEntitlement("mk_banner", activeEnt());

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u.includes("/me/entitlement")) {
          return new Response(JSON.stringify(activeEnt()), { status: 200 });
        }
        if (u.endsWith("/memory/settings")) {
          return new Response(
            JSON.stringify({ revision: 2, settings: { enabled: true, excludedDomains: [] } }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            unchanged: false,
            revision: 1,
            readOnly: false,
            settings: { enabled: false, excludedDomains: [] },
            profile: { text: "", updatedAt: 0 },
            state: { hasSnapshot: false },
            entries: [],
          }),
          { status: 200 },
        );
      }),
    );

    render(<MemoryPage />);
    expect(await screen.findByTestId("memory-privacy-consent-banner")).toBeTruthy();
    expect(screen.getByTestId("memory-privacy-policy-link")).toBeTruthy();

    fireEvent.click(screen.getByTestId("memory-privacy-agree"));
    await waitFor(async () => {
      expect(await getPrivacyConsent()).toMatchObject({ status: "accepted", source: "memory_settings" });
    });
    await waitFor(() => expect(screen.queryByTestId("memory-privacy-consent-banner")).toBeNull());
  });

  it("syncs privacyConsent from cloud (Device B agreed) and resumes Device A digest uploads", async () => {
    _setMemoryCloudConsentForTests(null);
    await declineCloudMemoryConsent();
    await setMemorySettings({ enabled: false });
    await createInstance({ provider: "managed", nickname: "Pie", apiKey: "mk_multi" });
    await cacheEntitlement("mk_multi", activeEnt());
    await setMemoryState({ cloudImported: true, cloudRevision: 1 });

    // Device B agreed & enabled memory on server -> server snapshot has privacyConsent=true, enabled=true, revision=2
    const pullFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          unchanged: false,
          revision: 2,
          readOnly: false,
          settings: { enabled: true, excludedDomains: [], privacyConsent: true },
          profile: { text: "", updatedAt: 0 },
          state: { hasSnapshot: false },
          entries: [],
        }),
        { status: 200 },
      ),
    );
    await syncMemoryFromCloud({ force: true, deps: { fetchFn: pullFetch } });

    expect(await getPrivacyConsent()).toMatchObject({ status: "accepted", source: "cloud_sync" });
    expect((await getMemorySettings()).enabled).toBe(true);

    // Device A can now flush digests
    const digestFetch = vi.fn(
      async () => new Response(JSON.stringify({ accepted: 1, queuedAt: 5000 }), { status: 200 }),
    );
    const out = await flushMemoryDigests({
      now: 100_000_000,
      listSessions: async () => [{ id: "s1", status: "active", title: "Chat", lastAccessedAt: 2000 }],
      readSession: async () => ({
        id: "s1",
        title: "Chat",
        status: "active",
        createdAt: 1000,
        lastAccessedAt: 2000,
        messages: [{ role: "user", content: "remember multi device" }],
      }),
      fetchFn: digestFetch as unknown as typeof fetch,
    });
    expect(out.accepted).toBe(1);
    expect(digestFetch).toHaveBeenCalledTimes(1);
  });
});
