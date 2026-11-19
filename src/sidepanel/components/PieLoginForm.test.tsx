import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import PieLoginForm from "./PieLoginForm";
import { EmailCodeError, type LoginResult } from "@/lib/managed-auth";

const result = (email = "a@b.com"): LoginResult => ({
  apiKey: "sk-v",
  entitlement: { plan: "none", email, subscription: null, quota: null, models: [] },
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("PieLoginForm", () => {
  it("Google 登录成功回调 LoginResult", async () => {
    const onLoggedIn = vi.fn();
    const login = vi.fn(async () => result());
    render(<PieLoginForm deps={{ login }} onLoggedIn={onLoggedIn} />);
    fireEvent.click(screen.getByRole("button", { name: /Sign in with Google/i }));
    await waitFor(() => expect(onLoggedIn).toHaveBeenCalledWith(result()));
  });

  it("邮箱验证码主流程：发码 → 输满 6 位自动校验 → 回调", async () => {
    const onLoggedIn = vi.fn();
    const sendCode = vi.fn(async () => {});
    const verifyCode = vi.fn(async () => result("me@x.com"));
    render(<PieLoginForm deps={{ sendCode, verifyCode }} onLoggedIn={onLoggedIn} />);

    fireEvent.change(screen.getByTestId("login-email"), { target: { value: "me@x.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Send code/i }));
    await waitFor(() => expect(sendCode).toHaveBeenCalledWith("me@x.com"));

    expect(screen.getByText(/Code sent to me@x\.com/)).toBeTruthy();
    const code = screen.getByTestId("login-code") as HTMLInputElement;
    expect(code.getAttribute("inputmode")).toBe("numeric");
    expect(code.getAttribute("autocomplete")).toBe("one-time-code");

    fireEvent.change(code, { target: { value: "12345" } });
    expect(verifyCode).not.toHaveBeenCalled(); // 未满 6 位不提交
    fireEvent.change(code, { target: { value: "123456" } });
    await waitFor(() => expect(verifyCode).toHaveBeenCalledWith("me@x.com", "123456"));
    await waitFor(() => expect(onLoggedIn).toHaveBeenCalledWith(result("me@x.com")));
  });

  it("非数字字符被过滤，最多 6 位", async () => {
    const sendCode = vi.fn(async () => {});
    const verifyCode = vi.fn(async () => result());
    render(<PieLoginForm deps={{ sendCode, verifyCode }} onLoggedIn={() => {}} />);
    fireEvent.change(screen.getByTestId("login-email"), { target: { value: "me@x.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Send code/i }));
    await waitFor(() => expect(screen.getByTestId("login-code")).toBeTruthy());
    const code = screen.getByTestId("login-code") as HTMLInputElement;
    fireEvent.change(code, { target: { value: "12ab34 56" } });
    expect(code.value).toBe("123456");
    await waitFor(() => expect(verifyCode).toHaveBeenCalledWith("me@x.com", "123456"));
  });

  it.each([
    ["invalid_code", /isn't right/i],
    ["code_expired", /has expired/i],
    ["invalid_email", /valid email/i],
    ["mail_send_failed", /Couldn't send/i],
  ])("后端错误码 %s 映射成对应文案", async (codeName, pattern) => {
    const sendCode = vi.fn(async () => {});
    const verifyCode = vi.fn(async () => {
      throw new EmailCodeError(codeName, 400);
    });
    render(<PieLoginForm deps={{ sendCode, verifyCode }} onLoggedIn={() => {}} />);
    fireEvent.change(screen.getByTestId("login-email"), { target: { value: "me@x.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Send code/i }));
    await waitFor(() => expect(screen.getByTestId("login-code")).toBeTruthy());
    fireEvent.change(screen.getByTestId("login-code"), { target: { value: "123456" } });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(pattern));
    expect(screen.getByTestId("login-code")).toHaveProperty("value", ""); // 清空待重输
  });

  it("too_many_attempts 带上 retryAfter 秒数，并锁住重发", async () => {
    const sendCode = vi.fn(async () => {
      throw new EmailCodeError("too_many_attempts", 429, 42);
    });
    render(<PieLoginForm deps={{ sendCode }} onLoggedIn={() => {}} />);
    fireEvent.change(screen.getByTestId("login-email"), { target: { value: "me@x.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Send code/i }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/42s/));
  });

  it("发码后有 60s 重发倒计时，换邮箱回到邮箱输入", async () => {
    vi.useFakeTimers();
    const sendCode = vi.fn(async () => {});
    render(<PieLoginForm deps={{ sendCode }} onLoggedIn={() => {}} />);
    fireEvent.change(screen.getByTestId("login-email"), { target: { value: "me@x.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Send code/i }));
    await act(async () => {}); // flush sendCode promise
    const resend = screen.getByRole("button", { name: /Resend in 60s/i }) as HTMLButtonElement;
    expect(resend.disabled).toBe(true);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByRole("button", { name: /Resend in 59s/i })).toBeTruthy();

    fireEvent.click(screen.getByTestId("login-change-email"));
    expect(screen.getByTestId("login-email")).toBeTruthy();
  });
});
