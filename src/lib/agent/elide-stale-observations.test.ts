import { describe, expect, it } from "vitest";
import type { AgentMessage, ContentBlock } from "@/lib/model-router";
import {
  elideStaleObservations,
  KEEP_FULL_OBSERVATIONS,
  STALE_OBSERVATION_MARKER,
  STALE_STRUCT_MARKER,
} from "./elide-stale-observations";

// An observation text mirrors buildObservationMessage's shape: a cheap
// header, a blank line, then one or more <untrusted_page_content> frames.
function obs(url: string, elementCount: number): string {
  const frames = Array.from({ length: elementCount }, (_, i) => `[${i}] button "btn ${i}"`).join("\n");
  return [
    `Current URL: ${url}`,
    `Page title: Title ${url}`,
    "",
    "Semantic:",
    "  Headings:",
    "    H1: Hello",
    "",
    `<untrusted_page_content frame_id="0" frame_url="${url}">`,
    "Elements:",
    frames,
    "</untrusted_page_content>",
  ].join("\n");
}

// Like obs, but with TWO <untrusted_page_content> frame blocks.
function obs2(url: string, elementCount: number): string {
  const frame = (fid: number) =>
    [
      `<untrusted_page_content frame_id="${fid}" frame_url="${url}">`,
      "Elements:",
      Array.from({ length: elementCount }, (_, i) => `[${i}] button "btn ${i}"`).join("\n"),
      "</untrusted_page_content>",
    ].join("\n");
  return [
    `Current URL: ${url}`,
    `Page title: Title ${url}`,
    "",
    "Semantic:",
    "  Headings:",
    "    H1: Hello",
    "",
    frame(0),
    frame(1),
  ].join("\n");
}

function userTask(task: string, observation: string): AgentMessage {
  return {
    role: "user",
    content: [
      { type: "text", text: task },
      { type: "text", text: observation },
    ] as ContentBlock[],
  };
}

function assistantToolUse(id: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name: "click", input: { elementIndex: 1 } }] as ContentBlock[],
  };
}

function userToolResult(id: string, observation: string): AgentMessage {
  return {
    role: "user",
    content: [
      { type: "tool_result", toolUseId: id, content: "clicked" },
      { type: "text", text: observation },
    ] as ContentBlock[],
  };
}

describe("elideStaleObservations", () => {
  it("keeps the most recent observation full, elides earlier ones", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      userTask("do the thing", obs("https://a", 50)),
      assistantToolUse("t1"),
      userToolResult("t1", obs("https://b", 50)),
      assistantToolUse("t2"),
      userToolResult("t2", obs("https://c", 50)),
    ];
    const out = elideStaleObservations(history, 1);

    // newest observation (https://c) is untouched
    const newest = out[5].content as ContentBlock[];
    expect((newest[1] as { text: string }).text).toContain("<untrusted_page_content");
    expect((newest[1] as { text: string }).text).not.toContain(STALE_OBSERVATION_MARKER);

    // earlier react observation (https://b) is elided
    const mid = out[3].content as ContentBlock[];
    const midObs = (mid[1] as { text: string }).text;
    expect(midObs).toContain("Current URL: https://b");      // header kept
    expect(midObs).toContain("Semantic:");                   // header kept
    expect(midObs).toContain(STALE_OBSERVATION_MARKER);      // frames replaced
    expect(midObs).not.toContain("<untrusted_page_content"); // frames gone

    // head user(task) observation (https://a) is elided but task text kept
    const head = out[1].content as ContentBlock[];
    expect((head[0] as { text: string }).text).toBe("do the thing");
    const headObs = (head[1] as { text: string }).text;
    expect(headObs).toContain("Current URL: https://a");
    expect(headObs).toContain(STALE_OBSERVATION_MARKER);
    expect(headObs).not.toContain("<untrusted_page_content");
  });

  it("does not mutate the input array or its message objects", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      userTask("t", obs("https://a", 10)),
      assistantToolUse("t1"),
      userToolResult("t1", obs("https://b", 10)),
    ];
    const snapshot = JSON.parse(JSON.stringify(history));
    elideStaleObservations(history, 1);
    expect(history).toEqual(snapshot);
  });

  it("preserves tool_result blocks unchanged when eliding", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      userTask("t", obs("https://a", 10)),
      assistantToolUse("t1"),
      userToolResult("t1", obs("https://b", 10)),
      assistantToolUse("t2"),
      userToolResult("t2", obs("https://c", 10)),
    ];
    const out = elideStaleObservations(history, 1);
    const mid = out[3].content as ContentBlock[];
    expect(mid[0]).toEqual({ type: "tool_result", toolUseId: "t1", content: "clicked" });
  });

  it("returns history with a single observation unchanged", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      userTask("t", obs("https://a", 10)),
    ];
    const out = elideStaleObservations(history, 1);
    expect((out[1].content as ContentBlock[])[1]).toEqual(
      (history[1].content as ContentBlock[])[1],
    );
  });

  it("leaves a text block without frame markers untouched", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: [{ type: "text", text: "plain task no frames" }] as ContentBlock[] },
      assistantToolUse("t1"),
      userToolResult("t1", obs("https://b", 10)),
    ];
    const out = elideStaleObservations(history, 1);
    expect((out[1].content as ContentBlock[])[0]).toEqual({
      type: "text",
      text: "plain task no frames",
    });
  });

  // m1: only the LAST text block is ever elided. If the last text block has
  // no frame marker but an earlier text block IS an observation, the earlier
  // observation is left FULL (documents the "observation = last text block"
  // contract).
  it("only elides the last text block, leaving earlier observation blocks full", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      {
        role: "user",
        content: [
          { type: "text", text: obs("https://a", 10) },
          { type: "text", text: "trailing note without frames" },
        ] as ContentBlock[],
      },
      assistantToolUse("t1"),
      userToolResult("t1", obs("https://b", 10)),
    ];
    const out = elideStaleObservations(history, 1);
    const head = out[1].content as ContentBlock[];
    // earlier (observation) block left FULL
    expect((head[0] as { text: string }).text).toContain("<untrusted_page_content");
    expect((head[0] as { text: string }).text).not.toContain(STALE_OBSERVATION_MARKER);
    // last text block (no frames) untouched
    expect((head[1] as { text: string }).text).toBe("trailing note without frames");
  });

  // m3: a multi-frame observation on a stale turn loses ALL frames (split at
  // first <untrusted_page_content occurrence drops everything after it).
  it("elides all frames from a multi-frame stale observation", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      userTask("t", obs2("https://a", 5)),
      assistantToolUse("t1"),
      userToolResult("t1", obs("https://b", 5)),
    ];
    const out = elideStaleObservations(history, 1);
    const head = out[1].content as ContentBlock[];
    const headObs = (head[1] as { text: string }).text;
    expect(headObs).toContain("Current URL: https://a");   // header kept
    expect(headObs).toContain("Semantic:");                // header kept
    expect(headObs).toContain(STALE_OBSERVATION_MARKER);   // marker present
    expect(headObs).not.toContain("<untrusted_page_content"); // ALL frames gone
  });

  // m4: idempotency — running twice == running once (marker text has no
  // frame marker, so a second pass is a no-op).
  it("is idempotent", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      userTask("do the thing", obs("https://a", 20)),
      assistantToolUse("t1"),
      userToolResult("t1", obs("https://b", 20)),
      assistantToolUse("t2"),
      userToolResult("t2", obs("https://c", 20)),
    ];
    const once = elideStaleObservations(history, 1);
    const twice = elideStaleObservations(once, 1);
    expect(twice).toEqual(once);
  });

  // m2: a string-content user turn that is NOT the last user turn is returned
  // unchanged (verifies the typeof === "string" guard).
  it("leaves a non-last string-content user turn unchanged", () => {
    const stringTurn: AgentMessage = { role: "user", content: "plain string task" };
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      stringTurn,
      assistantToolUse("t1"),
      userToolResult("t1", obs("https://b", 10)),
    ];
    const out = elideStaleObservations(history, 1);
    expect(out[1]).toEqual({ role: "user", content: "plain string task" });
  });
});

// ---------------------------------------------------------------------------
// Pull-mode (Phase 3): read_page snapshots ride tool_result blocks. These are
// the heavy carriers on page-operation tasks and the whole reason the react
// segment used to grow unboundedly.
// ---------------------------------------------------------------------------

/** Mirrors read-page.ts observation shape (interactive mode): cheap header,
 *  frame_map, then the bulky interactive index + frame content blocks. */
function readPageResult(url: string, elementCount: number): string {
  const elements = Array.from(
    { length: elementCount },
    (_, i) =>
      `  <interactive_element frame_id="0" pie_idx="${i}" tag="button" role="button">btn ${i}</interactive_element>`,
  ).join("\n");
  return [
    `Current URL: ${url}`,
    `Page title: Title ${url}`,
    "",
    "<frame_map>",
    `  frame_id="0" url="${url}"`,
    "</frame_map>",
    "",
    `<interactive_index mode="interactive" total="${elementCount}">`,
    elements,
    "</interactive_index>",
    "",
    `<untrusted_page_content frame_id="0" frame_url="${url}">`,
    "<div>page body</div>",
    "</untrusted_page_content>",
  ].join("\n");
}

/** Atlas mode: no interactive index; bulk starts at the first frame block. */
function readPageAtlasResult(url: string): string {
  return [
    `Current URL: ${url}`,
    `Page title: Title ${url}`,
    "",
    "<frame_map>",
    `  frame_id="0" url="${url}"`,
    "</frame_map>",
    "",
    `<untrusted_page_content frame_id="0" mode="atlas">`,
    "<page_atlas>…</page_atlas>",
    "</untrusted_page_content>",
  ].join("\n");
}

function userToolResultOnly(id: string, content: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "tool_result", toolUseId: id, content }] as ContentBlock[],
  };
}

describe("elideStaleObservations — read_page tool_result elision (pull mode)", () => {
  it("elides a stale read_page tool_result: header + frame_map kept, index and frames gone", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      userTask("do the thing", obs("https://a", 5)),
      assistantToolUse("t1"),
      userToolResultOnly("t1", readPageResult("https://b", 50)),
      assistantToolUse("t2"),
      userToolResult("t2", obs("https://c", 5)),
    ];
    const out = elideStaleObservations(history, 1);

    const stale = out[3].content as ContentBlock[];
    const tr = stale[0] as Extract<ContentBlock, { type: "tool_result" }>;
    expect(tr.type).toBe("tool_result");
    expect(tr.toolUseId).toBe("t1"); // pairing preserved
    expect(tr.content).toContain("Current URL: https://b"); // header kept
    expect(tr.content).toContain("<frame_map>"); // frame_map kept
    expect(tr.content).toContain(STALE_OBSERVATION_MARKER);
    expect(tr.content).not.toContain("<interactive_index"); // bulky index gone
    expect(tr.content).not.toContain("<untrusted_page_content"); // frame payload gone
    expect(tr.content).not.toContain("btn 0");

    // The most recent user turn keeps its full content, by reference.
    expect(out[5]).toBe(history[5]);
  });

  it("elides atlas-mode results (cut at the first frame block when no index exists)", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      userTask("t", obs("https://a", 5)),
      assistantToolUse("t1"),
      userToolResultOnly("t1", readPageAtlasResult("https://b")),
      assistantToolUse("t2"),
      userToolResult("t2", obs("https://c", 5)),
    ];
    const out = elideStaleObservations(history, 1);
    const tr = (out[3].content as ContentBlock[])[0] as Extract<ContentBlock, { type: "tool_result" }>;
    expect(tr.content).toContain("Current URL: https://b");
    expect(tr.content).toContain(STALE_OBSERVATION_MARKER);
    expect(tr.content).not.toContain("<untrusted_page_content");
    expect(tr.content).not.toContain("<page_atlas>");
  });

  it("elides every snapshot tool_result in a stale multi-result turn", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      userTask("t", obs("https://a", 5)),
      assistantToolUse("t1"),
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "t1a", content: readPageResult("https://b1", 20) },
          { type: "tool_result", toolUseId: "t1b", content: readPageAtlasResult("https://b2") },
        ] as ContentBlock[],
      },
      assistantToolUse("t2"),
      userToolResult("t2", obs("https://c", 5)),
    ];
    const out = elideStaleObservations(history, 1);
    const stale = out[3].content as ContentBlock[];
    for (const b of stale) {
      const tr = b as Extract<ContentBlock, { type: "tool_result" }>;
      expect(tr.content).toContain(STALE_OBSERVATION_MARKER);
      expect(tr.content).not.toContain("<untrusted_page_content");
    }
    expect((stale[0] as { toolUseId: string }).toolUseId).toBe("t1a");
    expect((stale[1] as { toolUseId: string }).toolUseId).toBe("t1b");
  });

  it("elides a read_struct result outside the keep window with the read_struct placeholder", () => {
    // 注意:这里用的是 read_struct 的**真实** wrapper —— 它复用
    // <untrusted_page_content>,靠 target_id 属性与页面快照区分。此前这个测试
    // 用了实现中根本不存在的 <untrusted_struct_records>,因此从没覆盖真实路径,
    // 而真实路径上 target evidence 是会被当成快照抹掉的。
    const structResult =
      '<untrusted_page_content atlas_id="atlas_1" target_id="collection_c1" tool="read_struct">' +
      '<records count="2">\n  <record id="r1" evidence="tr">{"price":"42"}</record>\n</records>' +
      "</untrusted_page_content>";
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      userTask("t", obs("https://a", 5)),
      assistantToolUse("t1"),
      userToolResultOnly("t1", structResult),
      assistantToolUse("t2"),
      userToolResult("t2", obs("https://c", 5)),
    ];
    const out = elideStaleObservations(history, 1);
    const content = ((out[3].content as ContentBlock[])[0] as Extract<ContentBlock, { type: "tool_result" }>).content;
    expect(content).toBe(STALE_STRUCT_MARKER);
    // With the default window (3) the same result stays in full.
    expect(elideStaleObservations(history)[3]).toBe(history[3]);
  });

  it("leaves plain tool results (click / …) untouched", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      userTask("t", obs("https://a", 5)),
      assistantToolUse("t1"),
      userToolResultOnly("t1", "clicked element 3"),
      assistantToolUse("t2"),
      userToolResult("t2", obs("https://c", 5)),
    ];
    const out = elideStaleObservations(history, 1);
    expect(out[3]).toBe(history[3]);
  });

  it("stale turn with both a read_struct result and a page snapshot: each gets its own placeholder", () => {
    const structResult =
      '<untrusted_page_content atlas_id="atlas_1" target_id="table_t0" tool="read_struct">' +
      '<records count="1"><record id="r1" evidence="tr">{"total":"1299"}</record></records>' +
      "</untrusted_page_content>";
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      userTask("t", obs("https://a", 5)),
      assistantToolUse("t1"),
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "t1", content: structResult },
          { type: "tool_result", toolUseId: "t1b", content: readPageResult("https://b", 30) },
        ] as ContentBlock[],
      },
      assistantToolUse("t2"),
      userToolResult("t2", obs("https://c", 5)),
    ];
    const out = elideStaleObservations(history, 1);
    const blocks = out[3].content as ContentBlock[];
    const evidence = blocks[0] as Extract<ContentBlock, { type: "tool_result" }>;
    const snapshot = blocks[1] as Extract<ContentBlock, { type: "tool_result" }>;

    expect(evidence.content).toBe(STALE_STRUCT_MARKER);
    expect(snapshot.content).toContain(STALE_OBSERVATION_MARKER);
    expect(snapshot.content).not.toContain("<interactive_index");
  });

  it("produces a bare marker when the payload starts directly with the frame block", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      userTask("t", obs("https://a", 5)),
      assistantToolUse("t1"),
      userToolResultOnly("t1", "<untrusted_page_content>fares…</untrusted_page_content>"),
      assistantToolUse("t2"),
      userToolResult("t2", obs("https://c", 5)),
    ];
    const out = elideStaleObservations(history, 1);
    const tr = (out[3].content as ContentBlock[])[0] as Extract<ContentBlock, { type: "tool_result" }>;
    expect(tr.content).toBe(STALE_OBSERVATION_MARKER);
  });

  it("keeps the most recent user turn's snapshot tool_result full", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      userTask("t", obs("https://a", 5)),
      assistantToolUse("t1"),
      userToolResultOnly("t1", readPageResult("https://b", 30)),
    ];
    const out = elideStaleObservations(history, 1);
    expect(out[3]).toBe(history[3]);
  });

  it("is idempotent across the tool_result path", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      userTask("t", obs("https://a", 5)),
      assistantToolUse("t1"),
      userToolResultOnly("t1", readPageResult("https://b", 30)),
      assistantToolUse("t2"),
      userToolResult("t2", obs("https://c", 5)),
    ];
    const once = elideStaleObservations(history, 1);
    const twice = elideStaleObservations(once, 1);
    expect(twice).toEqual(once);
  });

  // Cache-stability invariant: a block elided at step N must stay
  // byte-identical at step N+1 (only the previous last user turn flips
  // full → marker). Simulated by appending one more react pair.
  it("is monotone: elided stale turns stay byte-identical as history grows", () => {
    const base: AgentMessage[] = [
      { role: "system", content: "sys" },
      userTask("t", obs("https://a", 5)),
      assistantToolUse("t1"),
      userToolResultOnly("t1", readPageResult("https://b", 30)),
      assistantToolUse("t2"),
      userToolResult("t2", obs("https://c", 5)),
    ];
    const stepN = elideStaleObservations(base, 1);
    const grown: AgentMessage[] = [
      ...base,
      assistantToolUse("t3"),
      userToolResult("t3", obs("https://d", 5)),
    ];
    const stepN1 = elideStaleObservations(grown, 1);
    // Every message before the previous last user turn is byte-identical.
    for (let i = 0; i < base.length - 1; i++) {
      expect(stepN1[i]).toEqual(stepN[i]);
    }
    // The previous last user turn has now flipped to elided.
    const flipped = stepN1[base.length - 1].content as ContentBlock[];
    const flippedObs = (flipped[1] as { text: string }).text;
    expect(flippedObs).toContain(STALE_OBSERVATION_MARKER);
    expect(flippedObs).not.toContain("<untrusted_page_content");
  });
});

// Mechanics above pin keep=1; these cover the wire default (last 3 full).
describe("elideStaleObservations — default keep window", () => {
  const structResult = (id: string, rows: number) =>
    `<untrusted_page_content atlas_id="a1" target_id="t${id}" tool="read_struct">` +
    Array.from({ length: rows }, (_, i) => `row ${i}`).join("\n") +
    "</untrusted_page_content>";
  const toolTurn = (id: string, content: string): AgentMessage => ({
    role: "user",
    content: [{ type: "tool_result", toolUseId: id, content }] as ContentBlock[],
  });
  const isFull = (m: AgentMessage) =>
    !JSON.stringify(m.content).includes(STALE_OBSERVATION_MARKER.slice(0, 40)) &&
    !JSON.stringify(m.content).includes(STALE_STRUCT_MARKER.slice(0, 40));

  it("keeps the last 3 observations (read_page + read_struct, counted together) in full", () => {
    expect(KEEP_FULL_OBSERVATIONS).toBe(3);
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      userTask("task", obs("https://a", 20)), // 1 (oldest)
      assistantToolUse("t1"),
      toolTurn("t1", structResult("1", 30)), // 2
      assistantToolUse("t2"),
      toolTurn("t2", obs("https://b", 20)), // 3
      assistantToolUse("t3"),
      toolTurn("t3", structResult("3", 30)), // 4
      assistantToolUse("t4"),
      toolTurn("t4", obs("https://c", 20)), // 5 (newest)
    ];
    const out = elideStaleObservations(history);
    expect(isFull(out[1])).toBe(false);
    expect(isFull(out[3])).toBe(false);
    expect(isFull(out[5])).toBe(true);
    expect(isFull(out[7])).toBe(true);
    expect(isFull(out[9])).toBe(true);
    // read_struct gets its own placeholder telling the model how to get the rows back
    expect(JSON.stringify(out[3].content)).toContain("read_struct again");
    expect(JSON.stringify(out[3].content)).not.toContain("row 5");
    // page snapshot keeps its cheap header
    expect(JSON.stringify(out[1].content)).toContain("Current URL: https://a");
    // tool_use pairing untouched
    expect((out[3].content as ContentBlock[])[0]).toMatchObject({ type: "tool_result", toolUseId: "t1" });
  });

  it("never elides read_target / find_target evidence", () => {
    const evidence = `<untrusted_page_content atlas_id="a1" target_id="x" tool="read_target">secret row</untrusted_page_content>`;
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      toolTurn("e", evidence),
      ...[1, 2, 3, 4].flatMap((n) => [assistantToolUse(`t${n}`), toolTurn(`t${n}`, obs(`https://p${n}`, 5))]),
    ];
    const out = elideStaleObservations(history);
    expect(out[1]).toBe(history[1]);
  });

  it("is idempotent and leaves untouched messages by identity", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "sys" },
      ...[1, 2, 3, 4, 5].flatMap((n) => [assistantToolUse(`t${n}`), toolTurn(`t${n}`, obs(`https://p${n}`, 5))]),
    ];
    const once = elideStaleObservations(history);
    expect(elideStaleObservations(once)).toEqual(once);
    expect(once[0]).toBe(history[0]);
    expect(once[10]).toBe(history[10]);
  });

  it("keep=0 / false elides everything (compaction summarizer path)", () => {
    const history: AgentMessage[] = [{ role: "system", content: "sys" }, toolTurn("t", obs("https://a", 5))];
    expect(isFull(elideStaleObservations(history, false)[1])).toBe(false);
    expect(isFull(elideStaleObservations(history, 0)[1])).toBe(false);
  });
});
