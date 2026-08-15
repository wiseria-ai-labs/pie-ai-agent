import { describe, it, expect } from "vitest";
import { BUILT_IN_SKILL_PACKAGES } from "./builtin";
import { parseSkillMarkdown } from "./frontmatter";

describe("BUILT_IN_SKILL_PACKAGES", () => {
  it("每个包都有 SKILL.md 且能解析", () => {
    expect(BUILT_IN_SKILL_PACKAGES.length).toBeGreaterThan(0);
    for (const pkg of BUILT_IN_SKILL_PACKAGES) {
      expect(pkg.builtIn).toBe(true);
      expect(pkg.files["SKILL.md"]).toBeTruthy();
      const { frontmatter } = parseSkillMarkdown(pkg.files["SKILL.md"]);
      expect(frontmatter.name).toBe(pkg.frontmatter.name);
    }
  });

  it("包含 extract / group / dedupe 三个内置技能", () => {
    const ids = BUILT_IN_SKILL_PACKAGES.map((p) => p.id);
    expect(ids).toContain("extract_structured_data");
    expect(ids).toContain("auto_group_tabs");
    expect(ids).toContain("close_duplicate_tabs");
  });

  it("extract_structured_data 升级为 scratchpad 长程抽取 playbook", () => {
    const extract = BUILT_IN_SKILL_PACKAGES.find((p) => p.id === "extract_structured_data")!;
    const md = extract.files["SKILL.md"];
    // description 进 catalog，须带触发信号（何时调用）
    expect(extract.frontmatter.description).toMatch(/scrape|collect/i);
    // body 编排 scratchpad 工具链 + 导出前与用户确认
    expect(md).toMatch(/scratchpad/i);
    expect(md).toContain("save_scratchpad");
    expect(md).toContain("update_scratchpad_notes");
    expect(md).toContain("query_scratchpad");
    expect(md).toContain("output_file");
    expect(md).toMatch(/before export/i);
    // 旧的单页 output-json playbook 已不再
    expect(md).not.toContain("data-pie-idx");
  });

  it("没有 builtin 残留 capabilities 死配置", () => {
    // capabilities frontmatter 已删（issue #303）；builtin SKILL.md 不得再带该块。
    for (const p of BUILT_IN_SKILL_PACKAGES) {
      expect(p.files["SKILL.md"]).not.toContain("capabilities:");
    }
  });

  it("video_transcript 引导视频字幕/transcript 抓取 (L1)", () => {
    const skill = BUILT_IN_SKILL_PACKAGES.find((p) => p.id === "video_transcript");
    expect(skill).toBeTruthy();
    // description 进 catalog，须带触发信号，让「总结这个视频」类请求可靠触发
    expect(skill!.frontmatter.description).toMatch(/summarize|video/i);
    const md = skill!.files["SKILL.md"];
    // 覆盖 YouTube + B 站两个平台
    expect(md).toMatch(/YouTube/);
    expect(md).toMatch(/Bilibili|B 站/);
    // transcript / 字幕 面板引导
    expect(md).toMatch(/transcript/i);
    expect(md).toMatch(/字幕/);
    // 明确的无字幕失败路径（不许幻觉）
    expect(md).toMatch(/No captions available/i);
    expect(md).toMatch(/hallucinate|fabricate|never invent|not guess|do NOT guess/i);
    // 用语义特征找控件而非硬编码 selector
    expect(md).not.toMatch(/querySelector|data-pie-idx/);
    // untrusted 页面内容防注入提醒
    expect(md).toMatch(/untrusted/i);
    // 回归护栏（need-to-solve）：search_page 工具已于 60e1c736 退役，
    // 引导绝不能再引用它（否则命令模型调用一个不存在的工具）。
    expect(md).not.toMatch(/search_page/);
    // YouTube 段用现役工具定位控件：read_page(interactive) + 展开 ...more/more-actions
    const yt = md.slice(md.indexOf("## YouTube"), md.indexOf("## Bilibili"));
    expect(yt).toMatch(/read_page/);
    expect(yt).toMatch(/\.\.\.more|Show more|more-actions/);
    // 显式的视口省略陷阱说明（read_page 会按视口省略；没看到 ≠ 页面没有）
    expect(md).toMatch(/omitted|viewport/i);
    expect(md).toMatch(/does NOT mean|≠|not mean the page lacks/i);
    // no-captions 失败路径要求真的展开并重跑 read_page 后仍无命中
    const noCap = md.slice(md.indexOf("## No captions available"));
    expect(noCap).toMatch(/read_page/);
    expect(noCap).toMatch(/\.\.\.more|Show more|more-actions|expanded/);
    // L1.5 / L3 梯子：截帧 tool + 本地 video-parser，且 L3 不得抢 L1
    expect(md).toMatch(/capture_video_frame/);
    expect(md).toMatch(/blank_or_drm_frame/);
    expect(md).toMatch(/video-parser/);
    expect(md).toMatch(/parse\.ts/);
    expect(md).toMatch(/Do NOT call L3/);
  });

  it("create_skill_from_recording instructs preserving cross-tab steps", () => {
    const pkg = BUILT_IN_SKILL_PACKAGES.find((p) => p.id === "create_skill_from_recording");
    expect(pkg).toBeTruthy();
    const text = JSON.stringify(pkg);
    expect(text).toContain("switch_to_new_tab");
    expect(text).toMatch(/标签页|tab/);
  });
});
