import { useState, useEffect } from "react";
import type { SkillPackage } from "@/lib/skills";
import {
  getAllSkillPackages,
  getEnabledSkillIds,
  setSkillEnabled,
  deletePackage,
} from "@/lib/skills";
import { useT } from "@/lib/i18n";

interface SkillsListProps {
  onRunSkill: (skillId: string, skillName: string) => void;
}

const STORAGE_QUOTA_BYTES = 1 * 1024 * 1024;

/** Approximate IndexedDB bytes a package consumes (matches skill-meta.ts). */
function estimatePackageBytes(pkg: SkillPackage): number {
  return JSON.stringify(pkg).length + pkg.id.length;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function normalizeSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export default function SkillsList({ onRunSkill }: SkillsListProps) {
  const t = useT();
  const [skills, setSkills] = useState<SkillPackage[]>([]);
  const [enabledIds, setEnabledIds] = useState<Set<string>>(new Set());
  const [explicitDisabledIds, setExplicitDisabledIds] = useState<Set<string>>(new Set());
  const [storageBytes, setStorageBytes] = useState<number>(0);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    loadSkills();
  }, []);

  async function loadSkills() {
    const [all, ids] = await Promise.all([
      getAllSkillPackages(),
      getEnabledSkillIds(),
    ]);
    const sorted = [...all].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    setSkills(sorted);
    // Storage budget only accounts for user (non-built-in) packages — built-ins
    // ship with the extension and don't consume the user's IndexedDB quota.
    const bytes = sorted
      .filter((p) => !p.builtIn)
      .reduce((sum, p) => sum + estimatePackageBytes(p), 0);
    setStorageBytes(bytes);
    const enabled = new Set(ids.filter((id) => !id.startsWith("!")));
    const disabled = new Set(ids.filter((id) => id.startsWith("!")).map((id) => id.slice(1)));
    setEnabledIds(enabled);
    setExplicitDisabledIds(disabled);
  }

  function isEffectivelyEnabled(skill: SkillPackage): boolean {
    if (explicitDisabledIds.has(skill.id)) return false;
    if (enabledIds.has(skill.id)) return true;
    // Absent marker: built-ins default ON (mirrors getEnabledSkillPackages).
    // User packages require an explicit enabled marker — which the create path
    // writes via setSkillEnabled(id, true) — so an absent marker on a user
    // package means OFF. (In practice every persisted user package has a
    // marker; this fallback just keeps display parity with the loop's view.)
    return skill.builtIn;
  }

  async function handleToggle(skill: SkillPackage) {
    const current = isEffectivelyEnabled(skill);
    await setSkillEnabled(skill.id, !current);
    await loadSkills();
  }

  async function handleDelete(skill: SkillPackage) {
    if (skill.builtIn) return;
    try {
      await deletePackage(skill.id);
      await setSkillEnabled(skill.id, false);
      await loadSkills();
      setConfirmDeleteId(null);
    } catch (e) {
      console.error("deletePackage failed:", e);
    }
  }

  const quotaPct = Math.min(100, (storageBytes / STORAGE_QUOTA_BYTES) * 100);
  // Capacity / count surface only user-created skills — built-ins ship with the
  // extension and shouldn't inflate the user's skill count or storage figure.
  const custom = skills.filter((s) => !s.builtIn);

  return (
    <div className="flex flex-col gap-7">
      <CapacitySection
        skillCount={custom.length}
        storageBytes={storageBytes}
        quotaPct={quotaPct}
      />

      {/* Concept hint — Skill 与底层 tool 的区别。Phase 3+ 用户经常误以为
          "为什么 click / type / open_url 这些没在列表里" — 它们是 LLM 的原子
          工具，不是 reusable workflow（skill）。 */}
      <div
        style={{
          padding: "8px 12px",
          fontSize: 12,
          color: "var(--c-fg-2, #888)",
          background: "var(--c-bg-2, transparent)",
          borderLeft: "2px solid var(--c-line, #ccc)",
          lineHeight: 1.5,
        }}
      >
        {t("skills.empty.cta")}
      </div>

      {/* 创建技能引导 — 不再提供表单式新建/编辑，改为引导用户用聊天或录制让 Pie 代建。 */}
      <div
        style={{
          padding: "10px 12px",
          fontSize: 12,
          color: "var(--c-fg-1, #333)",
          background: "var(--c-bg-2, transparent)",
          border: "1px solid var(--c-line, #ccc)",
          borderRadius: 8,
          lineHeight: 1.6,
        }}
      >
        {t("skills.createHint")}
      </div>

      {custom.length > 0 ? (
        <SkillsSection
          title={t("skills.section.yours.title")}
          subtitle={t("skills.section.yours.subtitleEditable", { count: custom.length })}
        >
          {custom.map((skill) => (
            <SkillRow
              key={skill.id}
              skill={skill}
              enabled={isEffectivelyEnabled(skill)}
              onToggle={() => handleToggle(skill)}
              onRun={() => onRunSkill(skill.id, skill.frontmatter.name)}
              confirmDelete={confirmDeleteId === skill.id}
              onAskDelete={() => setConfirmDeleteId(skill.id)}
              onCancelDelete={() => setConfirmDeleteId(null)}
              onDelete={() => handleDelete(skill)}
            />
          ))}
        </SkillsSection>
      ) : (
        <p className="text-[12px] text-fg-3">{t("skills.noSkills")}</p>
      )}
    </div>
  );
}

function CapacitySection({
  skillCount,
  storageBytes,
  quotaPct,
}: {
  skillCount: number;
  storageBytes: number;
  quotaPct: number;
}) {
  const t = useT();
  const overFill = quotaPct >= 80;
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between">
        <div className="flex flex-col gap-0.5">
          <span className="caps text-fg-3">{t("skills.capacity")}</span>
          <span className="text-[14px] font-medium text-fg-1">
            {skillCount} skill{skillCount === 1 ? "" : "s"}{" "}
            <span className="text-fg-2">
              · {formatBytes(storageBytes)} of {formatBytes(STORAGE_QUOTA_BYTES)}
            </span>
          </span>
        </div>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-sm border border-line bg-surface">
        <div
          className={`h-full transition-all ${overFill ? "bg-warning" : "bg-accent"}`}
          style={{ width: `${quotaPct}%` }}
        />
      </div>
    </section>
  );
}

function SkillsSection({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <span className="caps text-fg-3">{title}</span>
        <span className="font-mono text-[10px] text-fg-3">{subtitle}</span>
      </div>
      <div className="flex flex-col gap-px overflow-hidden rounded-lg border border-line bg-line">
        {children}
      </div>
    </section>
  );
}

function SkillRow({
  skill,
  enabled,
  onToggle,
  onRun,
  confirmDelete,
  onAskDelete,
  onCancelDelete,
  onDelete,
}: {
  skill: SkillPackage;
  enabled: boolean;
  onToggle: () => void;
  onRun: () => void;
  confirmDelete: boolean;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const tag = skill.builtIn
    ? t("skills.authorTag.builtIn")
    : skill.frontmatter.author === "agent"
      ? t("skills.authorTag.agent")
      : t("skills.authorTag.user");
  const slug = normalizeSlug(skill.frontmatter.name) || skill.id;

  return (
    <div
      className="flex flex-col gap-2 bg-surface px-3.5 py-3.5"
    >
      <div className="flex items-center gap-2.5">
        <button
          onClick={onToggle}
          role="switch"
          aria-checked={enabled}
          className={`flex h-3 w-3 flex-shrink-0 items-center justify-center rounded-full border ${
            enabled ? "border-accent bg-accent" : "border-line bg-transparent"
          }`}
          aria-label={
            enabled
              ? t("skills.toggleAria.disable", { name: skill.frontmatter.name })
              : t("skills.toggleAria.enable", { name: skill.frontmatter.name })
          }
        />
        <code className="font-mono text-[12px] text-accent">/{slug}</code>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3">
          {tag}
        </span>
      </div>

      <p className="text-[12px] leading-[18px] text-fg-2">{skill.frontmatter.description}</p>

      <div className="flex items-center gap-2 pt-1.5">
        <span className="font-mono text-[10px] text-fg-3">
          {skill.createdAt && skill.createdAt > 0
            ? formatBytes(estimatePackageBytes(skill))
            : ""}
        </span>
        <div className="flex-1" />
        <button
          onClick={onRun}
          disabled={!enabled}
          className="rounded border border-line bg-transparent px-2.5 py-1 text-[11px] text-fg-2 hover:border-fg-3 hover:text-fg-1 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t("common.run")}
        </button>
        {!skill.builtIn && (
          <>
            {confirmDelete ? (
              <>
                <button
                  onClick={onDelete}
                  className="rounded border border-warning-line bg-transparent px-2.5 py-1 text-[11px] text-warning hover:bg-warning-tint"
                >
                  {t("common.confirm")}
                </button>
                <button
                  onClick={onCancelDelete}
                  className="rounded border border-line bg-transparent px-2.5 py-1 text-[11px] text-fg-2 hover:text-fg-1"
                >
                  {t("common.cancel")}
                </button>
              </>
            ) : (
              <button
                onClick={onAskDelete}
                className="rounded border border-line bg-transparent px-2.5 py-1 text-[11px] text-fg-3 hover:border-warning-line hover:text-warning"
              >
                {t("common.delete")}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
