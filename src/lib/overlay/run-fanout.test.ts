import { describe, it, expect } from "vitest";
import {
  attachPanel,
  clearPanelLog,
  createPanelFanout,
  detachPanel,
  panelAttached,
  postToPanel,
  type PostTarget,
} from "./run-fanout";
import type { PortMessageToPanel } from "@/types";

const chunk = (text: string): PortMessageToPanel => ({
  type: "chat-chunk",
  sessionId: "s1",
  text,
});

function fakePort(failAfter = Number.POSITIVE_INFINITY): PostTarget & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    postMessage(msg: unknown) {
      if (sent.length >= failAfter) throw new Error("port disconnected");
      sent.push(msg);
    },
  };
}

describe("overlay run → side-panel fan-out (live handoff)", () => {
  it("a detached run attached mid-stream replays and keeps receiving events", () => {
    const fanout = createPanelFanout();

    // The run started on the overlay document; it emitted before any panel
    // existed (document gone, capsule running).
    postToPanel(fanout, chunk("第一段"));
    postToPanel(fanout, chunk("第二段"));
    expect(panelAttached(fanout)).toBe(false);

    // The user opens the side panel on the same session.
    const panel = fakePort();
    expect(attachPanel(fanout, panel, "s1")).toBe(true);

    expect(panel.sent[0]).toEqual({ type: "chat-attach", sessionId: "s1" });
    expect(panel.sent.slice(1)).toEqual([chunk("第一段"), chunk("第二段")]);

    // …and the in-flight turn continues into the panel.
    postToPanel(fanout, chunk("第三段"));
    expect(panel.sent.at(-1)).toEqual(chunk("第三段"));
    expect(panelAttached(fanout)).toBe(true);
  });

  it("a dead panel port is dropped instead of throwing into the loop", () => {
    const fanout = createPanelFanout();
    const dead = fakePort(0);
    attachPanel(fanout, dead, "s1"); // attach itself fails → not bound
    expect(panelAttached(fanout)).toBe(false);

    const live = fakePort();
    attachPanel(fanout, live, "s1");
    expect(panelAttached(fanout)).toBe(true);

    const dying = fakePort(1); // attach preamble succeeds, next post throws
    expect(attachPanel(fanout, dying, "s1")).toBe(true);
    expect(() => postToPanel(fanout, chunk("x"))).not.toThrow();
    expect(panelAttached(fanout)).toBe(false);
  });

  it("detaching only clears the matching port", () => {
    const fanout = createPanelFanout();
    const a = fakePort();
    const b = fakePort();
    attachPanel(fanout, a, "s1");
    detachPanel(fanout, b);
    expect(panelAttached(fanout)).toBe(true);
    detachPanel(fanout, a);
    expect(panelAttached(fanout)).toBe(false);
  });

  it("terminal cleanup drops the replay log", () => {
    const fanout = createPanelFanout();
    postToPanel(fanout, chunk("x"));
    postToPanel(fanout, chunk("y"));
    clearPanelLog(fanout);
    expect(fanout.log).toHaveLength(0);
    expect(panelAttached(fanout)).toBe(false);
  });
});
