import { EMAIL_NOT_VERIFIED_CODE } from "@intrinsic/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../lib/api/client";
import { GENERIC_SIGN_IN_ERROR } from "../utils/auth-errors";
import { LoginForm } from "./LoginForm";

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
const resendVerification = vi.fn();
const getAuthProviders = vi.fn();

vi.mock("../api/auth-api", () => ({
  GOOGLE_SIGN_IN_URL: "http://api.test/auth/google",
  login: (...args: unknown[]) => login(...args),
  resendVerification: (...args: unknown[]) => resendVerification(...args),
  getAuthProviders: () => getAuthProviders(),
}));

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
    expect(replace).toHaveBeenCalledWith("/dashboard");
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

  it("offers a resend when the account exists but is not verified", async () => {
    login.mockRejectedValue(
      new ApiError(403, "Verify your email address before signing in", EMAIL_NOT_VERIFIED_CODE),
    );
    resendVerification.mockResolvedValue({ status: "accepted" });
    render(<LoginForm />);

    const user = await submitCredentials(
      "pending@example.test",
      "Local-test-password-42",
    );

    expect(await screen.findByTestId("login-unverified")).toBeDefined();
    await user.click(
      screen.getByRole("button", { name: "Send a new verification link" }),
    );

    // The address the user just typed is reused, so no second email field appears.
    await waitFor(() => {
      expect(resendVerification).toHaveBeenCalledWith("pending@example.test");
    });
    expect(await screen.findByTestId("resend-confirmation")).toBeDefined();
    expect(screen.getAllByLabelText("Email")).toHaveLength(1);
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
});
