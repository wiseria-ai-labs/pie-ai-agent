// Seed first-party reference skills into ~/.pie/skills on daemon start.
// Never overwrite a user-modified copy (exists → skip).
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { paths } from "./paths";
// First-party disk skills are not seeded until Skill + Kit landing
// (docs/specs/2026-08-15-skill-kits.md). Keep the hook; the list stays empty.
const BUNDLED: { name: string; files: Record<string, string> }[] = [];

/** Returns how many skills were newly written. */
export function seedBundledSkills(skillsDir: string = paths.skillsDir): number {
  mkdirSync(skillsDir, { recursive: true });
  let n = 0;
  for (const skill of BUNDLED) {
    const dir = join(skillsDir, skill.name);
    if (existsSync(dir)) continue;
    for (const [rel, content] of Object.entries(skill.files)) {
      const dest = join(dir, rel);
      mkdirSync(join(dest, ".."), { recursive: true });
      writeFileSync(dest, content, "utf8");
    }
    n++;
  }
  return n;
}
