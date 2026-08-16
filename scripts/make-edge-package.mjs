// Local helper: turn a built `dist/` into a package Edge Add-ons accepts.
// Not a release asset — GitHub Releases only ship the keyed Chrome zip.
// Partner Center upload is manual: `pnpm build && node scripts/make-edge-package.mjs dist`
// then zip `dist/` yourself.
//
// Same build, three edits — every one of them something Edge's package
// validator complains about and Chrome needs (or doesn't care about):
//
//   1. `manifest.key` — a hard REJECTION on Edge Add-ons. Chrome needs it: the
//      key pins the extension ID (`gpccjhdgjkmalnepmeclooflliiocfed`), and the
//      Google OAuth redirect URI is registered against that ID.
//      The output is store-only. Local Edge load-unpacked must use the Chrome
//      zip (key intact) so Pie Link `allowed_origins` still matches. A
//      path-derived unpacked ID is unstable and must never be allowlisted.
//   2. Store copy that names another browser — a warning per locale. Each
//      locale carries an `extension_description_edge` alternative for this.
//   3. `chrome://extensions/shortcuts` in the command hints — not a validator
//      finding but a dead link on Edge, where the page is `edge://`.
//
// Rewrites dist/ in place. Run against a fresh `pnpm build`, not a dist/
// you still need for Chrome.

import { readFileSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";

const dist = process.argv[2] ?? "dist";

const manifestPath = `${dist}/manifest.json`;
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
delete manifest.key;

for (const command of Object.values(manifest.commands ?? {})) {
  if (typeof command.description === "string") {
    command.description = command.description.replaceAll("chrome://", "edge://");
  }
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

const locales = readdirSync(`${dist}/_locales`);
const missing = [];
for (const locale of locales) {
  const path = `${dist}/_locales/${locale}/messages.json`;
  const messages = JSON.parse(readFileSync(path, "utf8"));
  const alt = messages.extension_description_edge;
  if (!alt) {
    missing.push(locale);
    continue;
  }
  messages.extension_description = alt;
  delete messages.extension_description_edge;
  writeFileSync(path, JSON.stringify(messages, null, 2) + "\n");
}

// A locale added without its Edge copy would silently ship the Chrome wording,
// which is exactly the warning this script exists to remove.
if (missing.length > 0) {
  console.error(`FAIL: no extension_description_edge in: ${missing.join(", ")}`);
  process.exit(1);
}

// The store limit, and the reason the Edge strings are worded separately rather
// than search-replaced out of the Chrome ones.
const DESCRIPTION_LIMIT = 132;
for (const locale of locales) {
  const { extension_description: d } = JSON.parse(
    readFileSync(`${dist}/_locales/${locale}/messages.json`, "utf8"),
  );
  if (/chrome/i.test(d.message)) {
    console.error(`FAIL: ${locale} description still names Chrome`);
    process.exit(1);
  }
  if (d.message.length > DESCRIPTION_LIMIT) {
    console.error(`FAIL: ${locale} description is ${d.message.length} chars (max ${DESCRIPTION_LIMIT})`);
    process.exit(1);
  }
}
if ("key" in manifest) {
  console.error("FAIL: manifest.key survived");
  process.exit(1);
}

console.log(`OK: Edge package prepared (${locales.length} locales)`);
