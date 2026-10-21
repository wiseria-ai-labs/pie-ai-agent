import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { render } from "@testing-library/react";

// Test-harness invariant.
//
// Testing Library's auto-cleanup only registers itself when a GLOBAL
// `afterEach` exists; this project runs vitest with `globals: false`, so
// without an explicit cleanup in src/test/setup.ts every rendered tree stayed
// mounted for the whole file. React 19's scheduler can defer work through
// `setImmediate` — when such a callback fired after the file finished and
// vitest tore down happy-dom, react-dom touched `window` and threw
// "ReferenceError: window is not defined" as an UNHANDLED error, failing the
// whole run even though every test passed.
//
// These two tests pin the invariant: a tree mounted by one test is gone by
// the time the next test runs.

describe("React tree cleanup between tests", () => {
  it("mounts a tree", () => {
    const { container } = render(
      createElement("div", { "data-testid": "leak-probe" }),
    );
    expect(document.body.contains(container)).toBe(true);
  });

  it("the previous test's tree was unmounted by the global cleanup", () => {
    expect(document.body.querySelector("[data-testid='leak-probe']")).toBeNull();
  });
});
