import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SkillRunConfirmCard } from "./SkillRunConfirmCard";
import type { SkillRunConfirmRequest } from "@/lib/agent/tools/skill-script";

afterEach(() => cleanup());

const payload: SkillRunConfirmRequest = {
  skillId: "video-parser",
  skillName: "Video Parser",
  description: "Extract frames and audio from a video URL.",
  entry: "run.ts",
  args: ["https://youtu.be/abc", "--frames"],
};

describe("SkillRunConfirmCard", () => {
  it("shows skill name, description, entry and every arg verbatim", () => {
    render(<SkillRunConfirmCard payload={payload} onDecision={vi.fn()} />);
    expect(screen.getByText(/Video Parser/)).toBeTruthy();
    expect(screen.getByText("Extract frames and audio from a video URL.")).toBeTruthy();
    expect(screen.getByText("run.ts")).toBeTruthy();
    // args 全文可见（含 URL），用户看得到这次要干什么
    expect(screen.getByText("https://youtu.be/abc")).toBeTruthy();
    expect(screen.getByText("--frames")).toBeTruthy();
  });

  it("Allow → onDecision(true); Deny → onDecision(false)", () => {
    const onDecision = vi.fn();
    render(<SkillRunConfirmCard payload={payload} onDecision={onDecision} />);
    fireEvent.click(screen.getByText("Allow & run"));
    expect(onDecision).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByText("Deny"));
    expect(onDecision).toHaveBeenCalledWith(false);
  });

  it("renders a 'None' placeholder when there are no args", () => {
    render(<SkillRunConfirmCard payload={{ ...payload, args: [] }} onDecision={vi.fn()} />);
    expect(screen.getByText("None")).toBeTruthy();
  });

  it("shows the no-fence disclosure when isolation is none", () => {
    render(<SkillRunConfirmCard payload={{ ...payload, skillIsolation: "none" }} onDecision={vi.fn()} />);
    expect(screen.getByText(/no extra sandbox/i)).toBeTruthy();
  });

  it("keeps the sandbox disclosure when isolation is srt or omitted", () => {
    render(<SkillRunConfirmCard payload={{ ...payload, skillIsolation: "srt" }} onDecision={vi.fn()} />);
    expect(screen.getByText(/inside a sandbox/i)).toBeTruthy();
  });
});
