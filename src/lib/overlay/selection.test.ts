import { describe, it, expect, beforeEach } from "vitest";
import {
  applyReplacement,
  captureSelectionSnapshot,
  editableTargetFor,
  findUniqueTextRange,
  isTextField,
  selectionAnchorRect,
} from "./selection";

beforeEach(() => {
  document.body.innerHTML = "";
});

function select(node: Node, start: number, end: number): Selection {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  return sel;
}

describe("isTextField", () => {
  it("accepts textareas and text-like inputs only", () => {
    expect(isTextField(document.createElement("textarea"))).toBe(true);
    const text = document.createElement("input");
    text.type = "text";
    expect(isTextField(text)).toBe(true);
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    expect(isTextField(checkbox)).toBe(false);
    expect(isTextField(document.createElement("div"))).toBe(false);
    expect(isTextField(null)).toBe(false);
  });
});

describe("editableTargetFor", () => {
  it("returns null for a read-only paragraph selection", () => {
    document.body.innerHTML = "<p id='p'>hello world</p>";
    const p = document.getElementById("p")!;
    const sel = select(p.firstChild!, 0, 5);
    expect(editableTargetFor(sel, p)).toBeNull();
  });

  it("detects a contenteditable host", () => {
    document.body.innerHTML = "<div id='e' contenteditable='true'>hello world</div>";
    const e = document.getElementById("e")!;
    const sel = select(e.firstChild!, 0, 5);
    const target = editableTargetFor(sel, e);
    expect(target?.kind).toBe("editable");
    if (target?.kind === "editable") expect(target.element).toBe(e);
  });

  it("detects a textarea and records the character range", () => {
    document.body.innerHTML = "<textarea id='t'>hello world</textarea>";
    const t = document.getElementById("t") as HTMLTextAreaElement;
    t.focus();
    t.setSelectionRange(0, 5);
    // happy-dom cannot range over a textarea's value, so hand the function the
    // shape a real browser reports (anchor = the field element itself).
    const sel = {
      rangeCount: 1,
      toString: () => "hello",
      anchorNode: t,
      getRangeAt: () => ({}) as Range,
    } as unknown as Selection;
    const target = editableTargetFor(sel, t);
    expect(target).toEqual({ kind: "field", element: t, start: 0, end: 5, text: "hello" });
  });

  it("returns null for an empty/whitespace selection", () => {
    document.body.innerHTML = "<p id='p'> </p>";
    const p = document.getElementById("p")!;
    const sel = select(p.firstChild!, 0, 1);
    expect(editableTargetFor(sel, p)).toBeNull();
  });
});

describe("findUniqueTextRange", () => {
  it("finds the single occurrence", () => {
    document.body.innerHTML = "<div id='e'>alpha beta gamma</div>";
    const e = document.getElementById("e")!;
    const range = findUniqueTextRange(e, "beta");
    expect(range?.toString()).toBe("beta");
  });

  it("refuses an ambiguous match (two identical sentences)", () => {
    document.body.innerHTML = "<div id='e'>same same</div>";
    const e = document.getElementById("e")!;
    expect(findUniqueTextRange(e, "same")).toBeNull();
  });

  it("returns null when the text is gone", () => {
    document.body.innerHTML = "<div id='e'>alpha</div>";
    expect(findUniqueTextRange(document.getElementById("e")!, "beta")).toBeNull();
  });

  it("walks nested elements", () => {
    document.body.innerHTML = "<div id='e'>a <b>bold</b> c</div>";
    expect(findUniqueTextRange(document.getElementById("e")!, "bold")?.toString()).toBe("bold");
  });
});

describe("applyReplacement", () => {
  it("refuses when the target element left the document", () => {
    document.body.innerHTML = "<div id='e' contenteditable='true'>hello</div>";
    const e = document.getElementById("e") as HTMLElement;
    const target = { kind: "editable" as const, element: e, text: "hello" };
    e.remove();
    expect(applyReplacement(target, "hello", "hi")).toBe(false);
  });

  it("refuses when the original text no longer matches (page changed)", () => {
    document.body.innerHTML = "<div id='e' contenteditable='true'>changed text</div>";
    const e = document.getElementById("e") as HTMLElement;
    expect(applyReplacement({ kind: "editable", element: e, text: "hello" }, "hello", "hi")).toBe(false);
  });

  it("refuses an empty original", () => {
    document.body.innerHTML = "<div id='e' contenteditable='true'>hello</div>";
    const e = document.getElementById("e") as HTMLElement;
    expect(applyReplacement({ kind: "editable", element: e, text: "" }, "", "hi")).toBe(false);
  });
});

describe("captureSelectionSnapshot", () => {
  it("returns null without a selection", () => {
    window.getSelection()!.removeAllRanges();
    expect(captureSelectionSnapshot(window.getSelection(), document.body)).toBeNull();
  });

  it("caps the text and reports editability", () => {
    document.body.innerHTML = "<div id='e' contenteditable='true'></div>";
    const e = document.getElementById("e")!;
    e.textContent = "x".repeat(9000);
    const sel = select(e.firstChild!, 0, 9000);
    const snap = captureSelectionSnapshot(sel, e);
    expect(snap?.editable).toBe(true);
    expect(snap?.text.length).toBe(8000);
  });
});

describe("selectionAnchorRect", () => {
  it("returns null without a selection", () => {
    window.getSelection()!.removeAllRanges();
    expect(selectionAnchorRect(window.getSelection())).toBeNull();
  });
});
