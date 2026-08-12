import { parse as parseYaml } from "yaml";

export interface ParsedSkillMd {
  name: string;
  description: string;
  body: string;
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** strict YAML 解析失败时的宽松回退：只提零缩进的顶层 `name:`/`description:` 行。
 *  手写 SKILL.md 的 description 含「: 」（冒号+空格，中文语境极常见）会让 strict
 *  yaml 抛 Nested-mappings 错——不能因此让 skill 在 listSkills 里隐身（真机案例：
 *  2b 迁移包每次冷启动被重写且磁盘模式不可见）。 */
function lenientFrontmatter(yaml: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of yaml.split(/\r?\n/)) {
    const kv = /^(name|description):\s*(.+)$/.exec(line);
    if (kv && out[kv[1]] === undefined) out[kv[1]] = kv[2].trim();
  }
  return out;
}

/**
 * ADR 0007：metadata.pie.* 能力声明（network/write）整套下线。授权改由 agent 确认层
 * 兜底、沙箱降为固定基线（网络全放 + 写限 workspace + env 白名单），SKILL.md 里不再
 * 有任何能力声明可解析——frontmatter 只剩 name/description。
 */
export function parseSkillMd(md: string): ParsedSkillMd {
  const m = md.match(FENCE);
  if (!m) throw new Error("SKILL.md missing --- frontmatter --- fence");
  const [, yaml, body] = m;
  let fm: Record<string, unknown>;
  try {
    fm = (parseYaml(yaml) ?? {}) as Record<string, unknown>;
  } catch {
    fm = lenientFrontmatter(yaml);
  }

  const name = fm.name;
  const description = fm.description;
  if (typeof name !== "string" || !name) throw new Error("SKILL.md frontmatter missing required `name`");
  if (typeof description !== "string" || !description)
    throw new Error("SKILL.md frontmatter missing required `description`");

  return { name, description, body };
}
