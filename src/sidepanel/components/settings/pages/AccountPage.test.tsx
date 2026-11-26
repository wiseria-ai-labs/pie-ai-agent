import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import AccountPage from "./AccountPage";

const getPieAccount = vi.fn();
const signOutPieAccount = vi.fn();
vi.mock("@/lib/pie-account", () => ({
  getPieAccount: (...a: unknown[]) => getPieAccount(...a),
  signOutPieAccount: (...a: unknown[]) => signOutPieAccount(...a),
}));

const ent = {
  plan: "active" as const,
  email: "a@b.com",
  subscription: { planName: "Pie Pro", currentPeriodEnd: null, cancelAtPeriodEnd: false, source: "stripe" as const },
  quota: null,
  models: [],
};
vi.mock("@/lib/managed-account", async (orig) => ({
  ...(await orig<typeof import("@/lib/managed-account")>()),
  getCachedEntitlement: () => ent,
  getEntitlement: vi.fn(async () => ent),
  openCheckout: vi.fn(),
  openPortal: vi.fn(),
}));

beforeEach(() => {
  getPieAccount.mockReset();
  signOutPieAccount.mockReset();
  signOutPieAccount.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("AccountPage", () => {
  it("未登录 → PieLoginForm（Google 按钮）", async () => {
    getPieAccount.mockResolvedValue(null);
    render(<AccountPage />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Sign in with Google/i })).toBeTruthy());
  });

  it("已登录 → 账号面板 + 退出登录；退出后回到登录表单", async () => {
    getPieAccount.mockResolvedValue({ instanceId: "m", apiKey: "sk-v", email: "a@b.com" });
    vi.stubGlobal("confirm", vi.fn(() => true));
    render(<AccountPage __loginDeps={{ login: vi.fn() }} />);
    await waitFor(() => expect(screen.getByTestId("account-sign-out")).toBeTruthy());
    expect(screen.getAllByText("a@b.com").length).toBeGreaterThan(0); // 邮箱来自 entitlement

    // 退出后账号为 null → 回到登录表单
    getPieAccount.mockResolvedValue(null);
    fireEvent.click(screen.getByTestId("account-sign-out"));
    await act(async () => {});
    expect(signOutPieAccount).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("button", { name: /Sign in with Google/i })).toBeTruthy());
    vi.unstubAllGlobals();
  });

  it("signed-out view shows holiday banner inside window and hides it outside window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 10, 26, 12, 0, 0));
    getPieAccount.mockResolvedValue(null);

    render(<AccountPage />);
    expect(await screen.findByTestId("holiday-account-banner")).toBeTruthy();
    expect(screen.getByText("HOLIDAY50")).toBeTruthy();

    cleanup();
    vi.setSystemTime(Date.UTC(2026, 11, 26, 0, 0, 0));
    render(<AccountPage />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Sign in with Google/i })).toBeTruthy());
    expect(screen.queryByTestId("holiday-account-banner")).toBeNull();
  });
});
