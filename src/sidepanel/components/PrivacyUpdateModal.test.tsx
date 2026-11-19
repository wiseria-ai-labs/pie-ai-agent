import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PRIVACY_POLICY_URL } from "@/lib/privacy-consent";
import PrivacyUpdateModal from "./PrivacyUpdateModal";

afterEach(() => {
  cleanup();
});

describe("PrivacyUpdateModal", () => {
  it("renders updated privacy info, policy link, and triggers agree / decline handlers", async () => {
    const onAgree = vi.fn(async () => {});
    const onDecline = vi.fn(async () => {});

    render(<PrivacyUpdateModal onAgree={onAgree} onDecline={onDecline} />);

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByTestId("privacy-update-modal")).toBeTruthy();

    const link = screen.getByTestId("privacy-update-policy-link") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(PRIVACY_POLICY_URL);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");

    fireEvent.click(screen.getByTestId("privacy-update-agree"));
    await waitFor(() => expect(onAgree).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId("privacy-update-decline"));
    await waitFor(() => expect(onDecline).toHaveBeenCalledTimes(1));
  });
});
