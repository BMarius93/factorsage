import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../lib/api/client";
import { GENERIC_SIGN_IN_ERROR } from "../utils/auth-errors";
import {
  EMAIL_REQUIRED_MESSAGE,
  LoginForm,
  PASSWORD_REQUIRED_MESSAGE,
} from "./LoginForm";

const replace = vi.fn();
const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh }),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const login = vi.fn();
const getAuthProviders = vi.fn();

vi.mock("../api/auth-api", () => ({
  GOOGLE_SIGN_IN_URL: "http://api.test/auth/google",
  login: (...args: unknown[]) => login(...args),
  getAuthProviders: () => getAuthProviders(),
  getAuthUser: () => getAuthUser(),
}));

const getAuthUser = vi.fn(() => Promise.resolve(null as unknown));

async function submitCredentials(email: string, password: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Email"), email);
  await user.type(screen.getByLabelText("Password"), password);
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  return user;
}

describe("LoginForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAuthProviders.mockResolvedValue({ google: false });
  });

  it("signs in and moves the browser to the product", async () => {
    login.mockResolvedValue({ id: "1", email: "user@example.test", role: "USER" });
    render(<LoginForm />);

    await submitCredentials("user@example.test", "Local-test-password-42");

    await waitFor(() => {
      expect(login).toHaveBeenCalledWith({
        email: "user@example.test",
        password: "Local-test-password-42",
      });
    });
    expect(replace).toHaveBeenCalledWith("/");
  });

  it("shows one generic message for any rejected credentials", async () => {
    login.mockRejectedValue(new ApiError(401, "Invalid email or password"));
    render(<LoginForm />);

    await submitCredentials("user@example.test", "wrong-password");

    expect((await screen.findByTestId("login-error")).textContent).toBe(
      GENERIC_SIGN_IN_ERROR,
    );
    expect(replace).not.toHaveBeenCalled();
  });

  it("answers a pending account exactly like wrong credentials (AUTH-003)", async () => {
    // The API refuses an unverified account with the same generic 401; the page adds no
    // "verify your email" state that would reveal the account exists.
    login.mockRejectedValue(new ApiError(401, "Invalid email or password"));
    render(<LoginForm />);

    await submitCredentials("pending@example.test", "Local-test-password-42");

    expect((await screen.findByTestId("login-error")).textContent).toBe(
      GENERIC_SIGN_IN_ERROR,
    );
    expect(screen.queryByText(/verify your email/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /verification/i })).toBeNull();
  });

  it("surfaces a failed Google redirect without blocking password sign-in", () => {
    render(<LoginForm providerError="That sign-in attempt expired." />);

    expect(screen.getByRole("alert").textContent).toBe(
      "That sign-in attempt expired.",
    );
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDefined();
  });

  it("offers Google only when the API reports it as configured", async () => {
    getAuthProviders.mockResolvedValue({ google: true });
    render(<LoginForm />);

    const button = await screen.findByTestId("google-sign-in");
    expect(button.getAttribute("href")).toBe("http://api.test/auth/google");
  });

  it("hides Google when the deployment has not configured it", async () => {
    render(<LoginForm />);

    await waitFor(() => expect(getAuthProviders).toHaveBeenCalled());
    expect(screen.queryByTestId("google-sign-in")).toBeNull();
  });

  describe("return destination (UX-003)", () => {
    const DESTINATION = "/backtests/new?strategyId=s-1&stockListId=l-2";

    it("returns to a valid destination after password sign-in", async () => {
      login.mockResolvedValue({
        id: "1",
        email: "user@example.test",
        role: "USER",
      });
      render(<LoginForm returnPath={DESTINATION} />);

      await submitCredentials("user@example.test", "Local-test-password-42");

      await waitFor(() => expect(replace).toHaveBeenCalledWith(DESTINATION));
      expect(replace).toHaveBeenCalledTimes(1);
    });

    it.each([
      "//evil.example",
      "/\\evil.example",
      "https://evil.example",
      "javascript:alert(1)",
      "",
    ])("lands on the Dashboard instead of %j", async (hostile) => {
      login.mockResolvedValue({
        id: "1",
        email: "user@example.test",
        role: "USER",
      });
      render(<LoginForm returnPath={hostile} />);

      await submitCredentials("user@example.test", "Local-test-password-42");

      await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    });

    it("does not move the browser when sign-in is refused", async () => {
      login.mockRejectedValue(new ApiError(401, "Invalid email or password"));
      render(<LoginForm returnPath={DESTINATION} />);

      await submitCredentials("user@example.test", "wrong-password");

      await screen.findByTestId("login-error");
      expect(replace).not.toHaveBeenCalled();
    });

    it("hands the destination to Google and to account creation", async () => {
      getAuthProviders.mockResolvedValue({ google: true });
      render(<LoginForm returnPath={DESTINATION} />);

      const google = await screen.findByTestId("google-sign-in");
      expect(google.getAttribute("href")).toBe(
        `http://api.test/auth/google?next=${encodeURIComponent(DESTINATION)}`,
      );
      expect(
        screen
          .getByRole("link", { name: "Create an account" })
          .getAttribute("href"),
      ).toBe(`/register?next=${encodeURIComponent(DESTINATION)}`);
    });

    it("never hands Google a destination it would refuse", async () => {
      getAuthProviders.mockResolvedValue({ google: true });
      render(<LoginForm returnPath="//evil.example" />);

      const google = await screen.findByTestId("google-sign-in");
      expect(google.getAttribute("href")).toBe("http://api.test/auth/google");
      expect(
        screen
          .getByRole("link", { name: "Create an account" })
          .getAttribute("href"),
      ).toBe("/register");
    });
  });

  it("answers an empty submit beside the fields and sends nothing (UI-041)", async () => {
    const user = userEvent.setup();
    render(<LoginForm />);

    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(screen.getByText(EMAIL_REQUIRED_MESSAGE)).toBeDefined();
    expect(screen.getByText(PASSWORD_REQUIRED_MESSAGE)).toBeDefined();
    expect(screen.getByLabelText("Email").getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(document.activeElement).toBe(screen.getByLabelText("Email"));
    expect(login).not.toHaveBeenCalled();
  });

  it("sends a visitor who is already signed in on to where they were going (UI-040)", async () => {
    getAuthUser.mockResolvedValueOnce({
      id: "1",
      email: "user@example.test",
      role: "USER",
    });
    render(<LoginForm returnPath="/backtests/new?strategyId=s1" />);

    expect(await screen.findByTestId("auth-already-signed-in")).toBeDefined();
    expect(replace).toHaveBeenCalledWith("/backtests/new?strategyId=s1");
  });

  it("keeps the destination through the password-recovery detour (UI-042)", () => {
    render(<LoginForm returnPath="/monitors" />);
    expect(
      screen
        .getByRole("link", { name: "Forgot your password?" })
        .getAttribute("href"),
    ).toBe("/forgot-password?next=%2Fmonitors");
  });
});
