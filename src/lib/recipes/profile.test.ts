// src/lib/recipes/profile.test.ts
import { describe, it, expect } from "vitest";
import { detectPageProfile } from "./profile";

function root(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

describe("detectPageProfile", () => {
  it("classic: semantic classes", () => {
    expect(detectPageProfile(root(`<table><tr class="team"><td class="name">A</td></tr></table>`))).toBe("classic");
  });

  it("spa-grid: ARIA grid roles", () => {
    expect(detectPageProfile(root(`<div role="grid"><div role="row"><div role="gridcell">A</div></div></div>`))).toBe("spa-grid");
  });

  it("spa-grid: hashed CSS-in-JS classnames", () => {
    const cells = Array.from({ length: 20 }, () => `<td class="MuiTableCell-root css-1q8sdr">x</td>`).join("");
    expect(detectPageProfile(root(`<table>${cells}</table>`))).toBe("spa-grid");
  });
});
