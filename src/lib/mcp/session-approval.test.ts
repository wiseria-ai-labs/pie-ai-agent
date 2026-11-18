import { beforeEach, describe, expect, it } from "vitest";
import { _resetForTests } from "@/lib/idb/db";
import {
  createSession,
  getSessionAgent,
  isMcpServerApprovedInSession,
  recordMcpServerApproval,
  setSessionAgent,
} from "@/lib/sessions/storage";
import { mergeSessionAgentSnapshot } from "@/lib/agent/loop";

beforeEach(async () => {
  await _resetForTests();
});

describe("per-session MCP approvals", () => {
  it("records once and reads back for the same session only", async () => {
    const a = await createSession();
    const b = await createSession();
    expect(await isMcpServerApprovedInSession(a.id, "srv1")).toBe(false);
    await recordMcpServerApproval(a.id, "srv1");
    await recordMcpServerApproval(a.id, "srv1"); // idempotent
    expect(await isMcpServerApprovedInSession(a.id, "srv1")).toBe(true);
    expect(await isMcpServerApprovedInSession(b.id, "srv1")).toBe(false);
    expect((await getSessionAgent(a.id))?.approvedMcpServerIds).toEqual(["srv1"]);
  });

  it("survives the task-end tombstone (session outlives its tasks)", async () => {
    const s = await createSession();
    await setSessionAgent(s.id, {
      agentMessages: [],
      pendingInstructions: [],
      stepIndex: 0,
      hasImageContent: false,
      approvedMcpServerIds: ["srv1"],
    });
    const merged = mergeSessionAgentSnapshot(await getSessionAgent(s.id), {
      agentMessages: [],
      pendingInstructions: [],
      stepIndex: 0,
      hasImageContent: false,
    });
    expect(merged.approvedMcpServerIds).toEqual(["srv1"]);
  });
});
