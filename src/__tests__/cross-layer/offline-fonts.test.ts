import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 面板离线可用 grep guard（issue #449）。
 *
 * 侧栏字体必须本地打包：断网 / 墙内也要渲染成 Inter + JetBrains Mono，
 * 且打开侧栏不得把用户 IP 递给 Google。这条守的是回归——谁再往扩展页面里
 * 塞一行 CDN 字体链接就红。
 */
describe("#449: 侧栏字体本地打包，不走 Google Fonts", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

  it("扩展页面 HTML 里没有任何远端字体引用", () => {
    for (const page of ["src/sidepanel/index.html", "src/offscreen/pdf-parser.html"]) {
      const html = read(page);
      expect(html, page).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
      expect(html, page).not.toMatch(/<link[^>]+href="https?:\/\//);
    }
  });

  it("index.css 为 --font-sans / --font-mono 的 family 名声明了本地 @font-face", () => {
    const css = read("src/sidepanel/index.css");
    for (const family of ["Inter", "JetBrains Mono"]) {
      const face = new RegExp(`@font-face\\s*\\{[^}]*font-family:\\s*"${family}"`);
      expect(css, family).toMatch(face);
    }
    // 字体文件来自 node_modules，不是 http(s) URL
    const urls = css.match(/@font-face\s*\{[^}]*\}/g)?.join("") ?? "";
    expect(urls).not.toMatch(/url\(\s*['"]?https?:/);
  });
});
