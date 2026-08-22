import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const template = readFileSync(
  join(import.meta.dir, "..", "install", "ai.wiseria.pie.host.template.json"),
  "utf8",
);

const EDGE_EXT_ID = "gbfdgfkpglimajnjedphgakmhaplgobf";

test("mac host template allowlists the Chrome placeholder and the Edge store id", () => {
  const parsed = JSON.parse(template) as { allowed_origins: string[] };
  expect(parsed.allowed_origins).toEqual([
    "chrome-extension://__EXT_ID__/",
    `chrome-extension://${EDGE_EXT_ID}/`,
  ]);
});

test("mac host template does not allowlist a path-derived unpacked id", () => {
  expect(template).not.toContain("oalbbnaognpedempboblkimkapdpbhjl");
});
