import { PASSWORD_MIN_LENGTH } from "@intrinsic/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../lib/api/client";
import { UNEXPECTED_ERROR } from "../utils/auth-errors";
import {
  MISSING_TOKEN_MESSAGE,
  PASSWORD_MISMATCH_MESSAGE,
  PASSWORD_TOO_SHORT_MESSAGE,
  ResetPasswordForm,
} from "./ResetPasswordForm";

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

const resetPassword = vi.fn();

vi.mock("../api/auth-api", () => ({
  resetPassword: (...args: unknown[]) => resetPassword(...args),
}));

const TOKEN = "reset-token-from-the-inbox";
const VALID_PASSWORD = "Replacement-test-password-42";

async function fillForm(options: {
  password: string;
  confirmPassword?: string;
}) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("New password"), options.password);
  await user.type(
    screen.getByLabelText("Confirm new password"),
    options.confirmPassword ?? options.password,
  );
  await user.click(screen.getByRole("button", { name: "Change password" }));
}

describe("ResetPasswordForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPassword.mockResolvedValue({ status: "password_reset" });
  });

  it("sends the token from the link with the new password", async () => {
    render(<ResetPasswordForm token={TOKEN} />);

    await fillForm({ password: VALID_PASSWORD });

    await waitFor(() => {
      expect(resetPassword).toHaveBeenCalledWith({
        token: TOKEN,
        password: VALID_PASSWORD,
      });
    });
    await screen.findByTestId("reset-password-success");
    // A completed reset is not a sign-in: the user still has to authenticate.
    expect(
      screen.getByRole("link", { name: "Continue to sign in" }),
    ).toBeTruthy();
  });

  it("asks for a link instead of a password when the URL carries no token", async () => {
    render(<ResetPasswordForm token={null} />);

    expect(
      (await screen.findByTestId("reset-password-missing-token")).textContent,
    ).toContain(MISSING_TOKEN_MESSAGE);
    expect(screen.queryByLabelText("New password")).toBeNull();
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it("applies the shared password policy before calling the API", async () => {
    render(<ResetPasswordForm token={TOKEN} />);

    await fillForm({ password: "a".repeat(PASSWORD_MIN_LENGTH - 1) });

    expect(
      (await screen.findByTestId("reset-password-error")).textContent,
    ).toBe(PASSWORD_TOO_SHORT_MESSAGE);
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it("rejects a mismatched confirmation without calling the API", async () => {
    render(<ResetPasswordForm token={TOKEN} />);

    await fillForm({
      password: VALID_PASSWORD,
      confirmPassword: `${VALID_PASSWORD}-other`,
    });

    expect(
      (await screen.findByTestId("reset-password-error")).textContent,
    ).toBe(PASSWORD_MISMATCH_MESSAGE);
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it("surfaces the API's message for a spent or expired link", async () => {
    resetPassword.mockRejectedValue(
      new ApiError(401, "This password reset link is invalid or has expired"),
    );
    render(<ResetPasswordForm token={TOKEN} />);

    await fillForm({ password: VALID_PASSWORD });

    expect(
      (await screen.findByTestId("reset-password-error")).textContent,
    ).toBe("This password reset link is invalid or has expired");
    expect(screen.queryByTestId("reset-password-success")).toBeNull();
  });

  it("does not surface server detail for a failure the user cannot act on", async () => {
    resetPassword.mockRejectedValue(new ApiError(500, "boom"));
    render(<ResetPasswordForm token={TOKEN} />);

    await fillForm({ password: VALID_PASSWORD });

    expect(
      (await screen.findByTestId("reset-password-error")).textContent,
    ).toBe(UNEXPECTED_ERROR);
  });
});
