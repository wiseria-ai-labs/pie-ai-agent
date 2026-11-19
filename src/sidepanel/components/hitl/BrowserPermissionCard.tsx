import { useT } from "@/lib/i18n";
import type { BrowserDataDomain } from "@/lib/browser-data/types";
import { grantBrowserDataPermission } from "@/lib/browser-data/permissions";
import {
  HitlCardShell,
  HitlPrimaryButton,
  HitlSecondaryButton,
  HitlDetailBlock,
  HitlDetailGroup,
} from "./HitlCardShell";

interface Props {
  domain: BrowserDataDomain;
  onAnswer: (granted: boolean) => void;
}

const HistoryIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
    <path d="M12 8v4l3 2" />
  </svg>
);

const BookmarkIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M6 3h12v18l-6-4-6 4V3z" />
  </svg>
);

/**
 * F5 — first-use permission card for the two optional browser-data permissions
 * (spec §3.1). The "允许" click is the ONLY place chrome.permissions.request is
 * called: Chrome requires a user gesture and the panel is where it exists.
 * Chrome then shows its own system confirmation on top of this card, which is
 * why the note says so.
 */
export function BrowserPermissionCard({ domain, onAnswer }: Props) {
  const t = useT();
  const isHistory = domain === "history";
  return (
    <HitlCardShell
      register="browser"
      icon={isHistory ? <HistoryIcon /> : <BookmarkIcon />}
      capsLabel={t("hitl.caps.browserData")}
      title={t(isHistory ? "browserData.perm.historyTitle" : "browserData.perm.bookmarksTitle")}
      description={t(isHistory ? "browserData.perm.historyBody" : "browserData.perm.bookmarksBody")}
      actions={
        <>
          <HitlSecondaryButton onClick={() => onAnswer(false)}>
            {t("browserData.perm.decline")}
          </HitlSecondaryButton>
          <HitlPrimaryButton
            register="browser"
            onClick={() => {
              // Must stay in the click task — no awaits before the request call.
              void grantBrowserDataPermission(domain).then(onAnswer);
            }}
          >
            {t("browserData.perm.allow")}
          </HitlPrimaryButton>
        </>
      }
    >
      <HitlDetailBlock>
        <HitlDetailGroup label={t("browserData.perm.canDo")}>
          <span className="text-[12px] leading-[18px] text-fg-1">
            {t(isHistory ? "browserData.perm.historyCanDo" : "browserData.perm.bookmarksCanDo")}
          </span>
        </HitlDetailGroup>
        <HitlDetailGroup label={t("browserData.perm.revokeLabel")}>
          <span className="text-[12px] leading-[18px] text-fg-1">{t("browserData.perm.revoke")}</span>
        </HitlDetailGroup>
      </HitlDetailBlock>
      <div className="text-[11px] leading-[17px] text-fg-3">{t("browserData.perm.chromeNote")}</div>
    </HitlCardShell>
  );
}
