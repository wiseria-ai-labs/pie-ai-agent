// Localized rendering of a BrowserChangeRecord.
//
// Lives at the panel boundary: the SW stores only structured fields, and this
// turns them into a sentence through the active dictionary. Both the settings
// page (F17) and the in-conversation undo row render through here, so the two
// can never drift.

import type { DotPathKey } from "@/lib/i18n/types";
import type { EnDict } from "@/lib/i18n/dictionaries/en";
import type { BrowserChangeRecord, BookmarkPlanCounts } from "./types";

type DictKey = DotPathKey<EnDict>;
type Translate = (key: DictKey, params?: Record<string, string | number>) => string;

export interface ChangeDescription {
  labelKey: DictKey;
  params: Record<string, string | number>;
  /** bookmark_plan: per-op counts, rendered as appended chips. */
  planParts: Array<{ labelKey: DictKey; count: number }>;
  /** history_delete: affected site names (data, joined by the caller). */
  domains: string[];
}

export function describeChange(rec: BrowserChangeRecord): ChangeDescription {
  switch (rec.kind) {
    case "bookmark_plan": {
      const counts: BookmarkPlanCounts = rec.changeCounts ?? { folders: 0, moves: 0, renames: 0 };
      return {
        labelKey: "browserData.change.planLabel",
        params: {},
        planParts: [
          { labelKey: "browserData.plan.chipFolders", count: counts.folders },
          { labelKey: "browserData.plan.chipMoves", count: counts.moves },
          { labelKey: "browserData.plan.chipRenames", count: counts.renames },
        ],
        domains: [],
      };
    }
    case "bookmark_create":
      return {
        labelKey: "browserData.change.created",
        params: { title: rec.title ?? "" },
        planParts: [],
        domains: [],
      };
    case "bookmark_update":
      return {
        labelKey: "browserData.change.updated",
        params: { title: rec.title ?? "" },
        planParts: [],
        domains: [],
      };
    case "history_delete":
      return {
        labelKey: "browserData.deletion.title",
        params: { count: rec.count ?? 0 },
        planParts: [],
        domains: rec.domains ?? [],
      };
  }
}

/** Full one-line label, e.g. `整理书签 · 新文件夹 2 · 移动 71`. */
export function changeLabel(rec: BrowserChangeRecord, t: Translate): string {
  const d = describeChange(rec);
  const parts = d.planParts.filter((p) => p.count > 0).map((p) => t(p.labelKey, { count: p.count }));
  return [t(d.labelKey, d.params), ...parts, d.domains.join(", ")].filter(Boolean).join(" · ");
}
