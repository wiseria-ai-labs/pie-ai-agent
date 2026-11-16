import { describe, it, expect, beforeEach } from "vitest";
import { openDb, tx, txMulti, STORES, _resetForTests } from "../db";

beforeEach(async () => {
  await _resetForTests();
});

describe("openDb", () => {
  it("creates all four object stores", async () => {
    const db = await openDb();
    expect(db.objectStoreNames.contains(STORES.sessions)).toBe(true);
    expect(db.objectStoreNames.contains(STORES.sessionIndex)).toBe(true);
    expect(db.objectStoreNames.contains(STORES.instances)).toBe(true);
    expect(db.objectStoreNames.contains(STORES.config)).toBe(true);
    db.close();
  });
});

describe("tx", () => {
  it("round-trips a record in the config store", async () => {
    await tx(STORES.config, "readwrite", (s) => s.put({ key: "k", value: 1 }));
    const got = await tx<{ key: string; value: number } | undefined>(
      STORES.config, "readonly", (s) => s.get("k"),
    );
    expect(got?.value).toBe(1);
  });
});

describe("txMulti", () => {
  it("writes across two stores atomically in one transaction", async () => {
    await txMulti([STORES.sessions, STORES.sessionIndex], "readwrite", (stores) => {
      stores[STORES.sessions].put({ id: "s1:meta", value: { title: "x" } });
      stores[STORES.sessionIndex].put({ id: "index", value: [{ id: "s1" }] });
    });
    const meta = await tx<{ id: string; value: { title: string } } | undefined>(
      STORES.sessions, "readonly", (s) => s.get("s1:meta"),
    );
    expect(meta?.value.title).toBe("x");
  });
});

// 线上用户全是 main 的 v3 库：升 v4 必须补建新表且不动已有数据。
describe("v3 → v4 upgrade (released users)", () => {
  it("adds the v4 stores and keeps existing v3 records", async () => {
    const V3_STORES: [string, string][] = [
      ["sessions", "id"], ["session_index", "id"], ["instances", "id"],
      ["config", "key"], ["scratchpads", "id"], ["schedules", "id"],
    ];
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("pie", 3);
      req.onupgradeneeded = () => {
        for (const [name, keyPath] of V3_STORES) req.result.createObjectStore(name, { keyPath });
        req.transaction!.objectStore("instances").put({ id: "inst-1", provider: "managed" });
      };
      req.onsuccess = () => { req.result.close(); resolve(); };
      req.onerror = () => reject(req.error);
    });

    const db = await openDb();
    expect(db.version).toBe(4);
    for (const name of Object.values(STORES)) expect(db.objectStoreNames.contains(name)).toBe(true);
    const inst = await tx<{ id: string; provider: string } | undefined>(
      STORES.instances, "readonly", (s) => s.get("inst-1"),
    );
    expect(inst?.provider).toBe("managed");
  });
});
