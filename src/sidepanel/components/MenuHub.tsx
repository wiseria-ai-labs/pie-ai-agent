/** 菜单枢纽(spec §6 C 屏):IP 点击后的低频目的地面板。无边框列表,
 *  overlay 落在顶栏下方;层次=surface+弹层投影(无界弹层规格 spec §3.3)。 */
import { useEffect, useRef, type ReactElement, type RefObject } from "react";
import { useT } from "@/lib/i18n";

interface MenuHubProps {
  open: boolean;
  onClose: () => void;
  onHistory: () => void;
  onSkills: () => void;
  onSchedules: () => void;
  onSettings: () => void;
  version: string;
  /** The IP/wordmark trigger button that toggles `open`. Outside-click
   *  ignores clicks landing on it so the trigger's own onClick stays the sole
   *  source of truth — otherwise a mousedown-close races the click-open/close
   *  toggle and the menu never closes (same hazard as PinnedTabDropdown's
   *  anchorRef). Optional so the component still works standalone in tests. */
  anchorRef?: RefObject<HTMLElement | null>;
}

export function MenuHub({ open, onClose, onHistory, onSkills, onSchedules, onSettings, version, anchorRef }: MenuHubProps) {
  const t = useT(); // hooks 全部在 early-return 之前(顺序规则)
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (anchorRef?.current?.contains(target)) return;
      if (ref.current && !ref.current.contains(target)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDoc);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("mousedown", onDoc); };
  }, [open, onClose, anchorRef]);

  if (!open) return null;
  const rows: { label: string; onPick: () => void; icon: ReactElement }[] = [
    { label: t("menu.history"), onPick: onHistory, icon: <IconClock /> },
    { label: t("menu.skills"), onPick: onSkills, icon: <IconSpark /> },
    { label: t("menu.schedules"), onPick: onSchedules, icon: <IconRepeat /> },
    { label: t("menu.settings"), onPick: onSettings, icon: <IconGear /> },
  ];
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={t("topBar.menu")}
      className="drawer-down absolute left-3 top-[54px] z-30 w-[228px] rounded-[16px] bg-surface p-2 shadow-[0_8px_28px_rgba(21,25,31,0.14)]"
    >
      {rows.map((r) => (
        <button
          key={r.label}
          type="button"
          role="menuitem"
          onClick={() => { r.onPick(); onClose(); }}
          className="flex w-full items-center gap-3 rounded-[11px] px-3 py-2.5 text-[13px] text-fg-1 hover:bg-field transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line"
        >
          <span className="text-fg-3">{r.icon}</span>
          {r.label}
        </button>
      ))}
      {/* 品牌区(G7:不写 formerly Pie) */}
      <div className="mt-2 px-3 pb-1 pt-2 text-[11px] leading-4 text-fg-3">
        Vailie · v{version}
        <br />
        {t("menu.brandLine")} {/* "开源 Apache-2.0 · 无遥测" */}
      </div>
    </div>
  );
}

/* 16px 线性图标(stroke=currentColor,与顶栏一致) */
function IconClock() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" /></svg>; }
function IconSpark() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" /></svg>; }
function IconRepeat() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17 2l4 4-4 4" /><path d="M3 11v-1a4 4 0 014-4h14" /><path d="M7 22l-4-4 4-4" /><path d="M21 13v1a4 4 0 01-4 4H3" /></svg>; }
function IconGear() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33h0a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51h0a1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82v0a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" /></svg>; }
