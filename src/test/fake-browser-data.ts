// Fake chrome.bookmarks / chrome.history / chrome.permissions for the
// browser-data tests. Installed onto globalThis.chrome (see src/test/setup.ts)
// — only the surface the library actually calls is implemented.

export interface FakeNode {
  id: string;
  parentId?: string;
  title: string;
  url?: string;
  dateAdded?: number;
  children?: FakeNode[];
}

export interface FakeBookmarks {
  /** id → node (root "0" included). */
  nodes: Map<string, FakeNode>;
  barId: string;
  getTree: () => Promise<FakeNode[]>;
  search: (q: string | { url?: string; query?: string; title?: string }) => Promise<FakeNode[]>;
  getChildren: (id: string) => Promise<FakeNode[]>;
  create: (d: { parentId?: string; title: string; url?: string }) => Promise<FakeNode>;
  move: (id: string, d: { parentId?: string }) => Promise<FakeNode>;
  update: (id: string, d: { title?: string; url?: string }) => Promise<FakeNode>;
  remove: (id: string) => Promise<void>;
}

function copy(n: FakeNode): FakeNode {
  return { ...n, children: n.children?.map(copy) };
}

export function installFakeBookmarks(seed?: { bar?: Array<{ title: string; url?: string }> }): FakeBookmarks {
  let seq = 100;
  const nodes = new Map<string, FakeNode>();
  const root: FakeNode = { id: "0", title: "", children: [] };
  const bar: FakeNode = { id: "1", parentId: "0", title: "Bookmarks bar", children: [] };
  const other: FakeNode = { id: "2", parentId: "0", title: "Other bookmarks", children: [] };
  root.children = [bar, other];
  for (const n of [root, bar, other]) nodes.set(n.id, n);

  for (const item of seed?.bar ?? []) {
    const id = String(seq++);
    const node: FakeNode = {
      id,
      parentId: bar.id,
      title: item.title,
      ...(item.url ? { url: item.url } : {}),
      ...(item.url ? {} : { children: [] }),
      dateAdded: 1_700_000_000_000,
    };
    nodes.set(id, node);
    bar.children!.push(node);
  }

  const childrenOf = (id: string) => nodes.get(id)?.children ?? [];

  const fake: FakeBookmarks = {
    nodes,
    barId: bar.id,
    getTree: async () => [copy(root)],
    search: async (q) => {
      const query = typeof q === "string" ? q : (q.query ?? "");
      const url = typeof q === "string" ? undefined : q.url;
      const out: FakeNode[] = [];
      for (const n of nodes.values()) {
        if (!n.url) continue;
        if (url !== undefined) {
          if (n.url === url) out.push(copy(n));
          continue;
        }
        if (!query || n.url.includes(query) || n.title.toLowerCase().includes(query.toLowerCase())) {
          out.push(copy(n));
        }
      }
      return out;
    },
    getChildren: async (id) => {
      const node = nodes.get(id);
      if (!node) throw new Error(`No bookmark with id ${id}`);
      return childrenOf(id).map(copy);
    },
    create: async (d) => {
      const parentId = d.parentId ?? bar.id;
      const parent = nodes.get(parentId);
      if (!parent || parent.url) throw new Error(`Invalid parent folder: ${parentId}`);
      const node: FakeNode = {
        id: String(seq++),
        parentId,
        title: d.title,
        dateAdded: Date.now(),
        ...(d.url ? { url: d.url } : { children: [] }),
      };
      parent.children!.push(node);
      nodes.set(node.id, node);
      return copy(node);
    },
    move: async (id, d) => {
      const node = nodes.get(id);
      if (!node) throw new Error(`No bookmark with id ${id}`);
      const from = nodes.get(node.parentId ?? "");
      if (from?.children) from.children = from.children.filter((c) => c.id !== id);
      const to = nodes.get(d.parentId ?? "");
      if (!to || to.url) throw new Error(`Invalid parent folder: ${d.parentId}`);
      node.parentId = to.id;
      to.children!.push(node);
      return copy(node);
    },
    update: async (id, d) => {
      const node = nodes.get(id);
      if (!node) throw new Error(`No bookmark with id ${id}`);
      if (d.title !== undefined) node.title = d.title;
      if (d.url !== undefined) node.url = d.url;
      return copy(node);
    },
    remove: async (id) => {
      const node = nodes.get(id);
      if (!node) throw new Error(`No bookmark with id ${id}`);
      if (node.children && node.children.length > 0) throw new Error("Folder not empty");
      const parent = nodes.get(node.parentId ?? "");
      if (parent?.children) parent.children = parent.children.filter((c) => c.id !== id);
      nodes.delete(id);
    },
  };
  return fake;
}

export interface FakeHistoryEntry {
  url: string;
  title: string;
  lastVisitTime: number;
  visitCount: number;
}

export interface FakeHistory {
  entries: FakeHistoryEntry[];
  search: (q: { text?: string; startTime?: number; endTime?: number; maxResults?: number }) => Promise<FakeHistoryEntry[]>;
  deleteUrl: (d: { url: string }) => Promise<void>;
}

export function installFakeHistory(entries: FakeHistoryEntry[]): FakeHistory {
  const state = entries.map((e) => ({ ...e }));
  return {
    entries: state,
    search: async (q) => {
      const text = (q.text ?? "").toLowerCase();
      const start = q.startTime ?? 0;
      const end = q.endTime ?? Number.MAX_SAFE_INTEGER;
      return state
        .filter((e) => e.lastVisitTime >= start && e.lastVisitTime <= end)
        .filter((e) => !text || e.url.toLowerCase().includes(text) || e.title.toLowerCase().includes(text))
        .slice(0, q.maxResults ?? 100)
        .map((e) => ({ ...e }));
    },
    deleteUrl: async (d) => {
      for (let i = state.length - 1; i >= 0; i -= 1) if (state[i].url === d.url) state.splice(i, 1);
    },
  };
}

export interface FakePermissions {
  granted: Set<string>;
  contains: (p: { permissions: string[] }) => Promise<boolean>;
  request: (p: { permissions: string[] }) => Promise<boolean>;
  remove: (p: { permissions: string[] }) => Promise<boolean>;
  onAdded: { addListener: (cb: () => void) => void; removeListener: (cb: () => void) => void };
  onRemoved: { addListener: (cb: () => void) => void; removeListener: (cb: () => void) => void };
}

/** `requestResult` controls what the fake Chrome confirmation returns. */
export function installFakePermissions(
  initial: string[] = [],
  requestResult = true,
): FakePermissions {
  const granted = new Set(initial);
  const noop = { addListener: () => {}, removeListener: () => {} };
  return {
    granted,
    contains: async (p) => p.permissions.every((x) => granted.has(x)),
    request: async (p) => {
      if (requestResult) p.permissions.forEach((x) => granted.add(x));
      return requestResult;
    },
    remove: async (p) => {
      p.permissions.forEach((x) => granted.delete(x));
      return true;
    },
    onAdded: noop,
    onRemoved: noop,
  };
}

/** Install a fake onto the global chrome object (setup.ts's chromeMock). */
export function installChromeApi(key: "bookmarks" | "history" | "permissions", api: unknown): void {
  const g = globalThis as unknown as { chrome: Record<string, unknown> };
  g.chrome[key] = api;
}
