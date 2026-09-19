import { PASSWORD_MIN_LENGTH } from "@intrinsic/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../lib/api/client";
import { UNEXPECTED_ERROR } from "../utils/auth-errors";
import {
  PASSWORD_MISMATCH_MESSAGE,
  PASSWORD_TOO_SHORT_MESSAGE,
} from "./ResetPasswordForm";
import { VerifyEmailPanel } from "./VerifyEmailPanel";

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

const verifyEmail = vi.fn();
const resendVerification = vi.fn();

vi.mock("../api/auth-api", () => ({
  verifyEmail: (...args: unknown[]) => verifyEmail(...args),
  resendVerification: (...args: unknown[]) => resendVerification(...args),
}));

const TOKEN = "link-token";
const OWNER_PASSWORD = "Mailbox-owner-password-42";

async function submit(options: { password: string; confirmPassword?: string }) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("New password"), options.password);
  await user.type(
    screen.getByLabelText("Confirm password"),
    options.confirmPassword ?? options.password,
  );
  await user.click(
    screen.getByRole("button", { name: "Verify and set password" }),
  );
  return user;
}

describe("VerifyEmailPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not redeem the link just by opening the page", () => {
    render(<VerifyEmailPanel token={TOKEN} />);

    // AUTH-002: nothing is verified until the holder of the link chooses the password.
    expect(screen.getByTestId("verify-form")).toBeDefined();
    expect(screen.getByLabelText("New password")).toBeDefined();
    expect(screen.getByLabelText("Confirm password")).toBeDefined();
    expect(screen.queryByTestId("verify-success")).toBeNull();
    expect(verifyEmail).not.toHaveBeenCalled();
  });

  it("sends the token with the chosen password and then points to sign-in", async () => {
    verifyEmail.mockResolvedValue({ status: "verified" });
    render(<VerifyEmailPanel token={TOKEN} />);

    await submit({ password: OWNER_PASSWORD });

    expect(await screen.findByTestId("verify-success")).toBeDefined();
    expect(verifyEmail).toHaveBeenCalledTimes(1);
    expect(verifyEmail).toHaveBeenCalledWith({
      token: TOKEN,
      password: OWNER_PASSWORD,
    });
    // Verification is not a sign-in: the owner authenticates with the password they just chose.
    expect(
      screen
        .getByRole("link", { name: "Continue to sign in" })
        .getAttribute("href"),
    ).toBe("/login");
  });

  it("does not claim success while the request is still in flight, and submits once", async () => {
    let resolve: (value: unknown) => void = () => undefined;
    verifyEmail.mockReturnValue(
      new Promise((settle) => {
        resolve = settle;
      }),
    );
    render(<VerifyEmailPanel token={TOKEN} />);

    const user = await submit({ password: OWNER_PASSWORD });
    const button = screen.getByRole("button", { name: "Verifying…" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId("verify-success")).toBeNull();

    await user.click(button);
    expect(verifyEmail).toHaveBeenCalledTimes(1);

    resolve({ status: "verified" });
    expect(await screen.findByTestId("verify-success")).toBeDefined();
  });

  it("rejects a mismatched confirmation without calling the API", async () => {
    render(<VerifyEmailPanel token={TOKEN} />);

    await submit({
      password: OWNER_PASSWORD,
      confirmPassword: `${OWNER_PASSWORD}-other`,
    });

    expect((await screen.findByTestId("verify-error")).textContent).toBe(
      PASSWORD_MISMATCH_MESSAGE,
    );
    expect(verifyEmail).not.toHaveBeenCalled();
  });

  it("applies the shared password policy before calling the API", async () => {
    render(<VerifyEmailPanel token={TOKEN} />);

    await submit({ password: "a".repeat(PASSWORD_MIN_LENGTH - 1) });

    expect((await screen.findByTestId("verify-error")).textContent).toBe(
      PASSWORD_TOO_SHORT_MESSAGE,
    );
    expect(verifyEmail).not.toHaveBeenCalled();
  });

  it("offers a fresh link when the token is rejected", async () => {
    verifyEmail.mockRejectedValue(
      new ApiError(401, "This verification link is invalid or has expired"),
    );
    resendVerification.mockResolvedValue({ status: "accepted" });
    render(<VerifyEmailPanel token="expired-token" />);

    const user = await submit({ password: OWNER_PASSWORD });

    const failure = await screen.findByTestId("verify-failure");
    expect(failure.textContent).toContain("invalid, expired, or has already");
    expect(screen.queryByTestId("verify-success")).toBeNull();

    await user.type(screen.getByLabelText("Email"), "pending@example.test");
    await user.click(screen.getByRole("button", { name: "Send a new link" }));

    await waitFor(() => {
      expect(resendVerification).toHaveBeenCalledWith("pending@example.test");
    });
    expect(await screen.findByTestId("resend-confirmation")).toBeDefined();
  });

  it("keeps the form for a failure that left the link unspent, so it can be retried", async () => {
    verifyEmail
      .mockRejectedValueOnce(new ApiError(500, "boom"))
      .mockResolvedValueOnce({ status: "verified" });
    render(<VerifyEmailPanel token={TOKEN} />);

    const user = await submit({ password: OWNER_PASSWORD });

    expect((await screen.findByTestId("verify-error")).textContent).toBe(
      UNEXPECTED_ERROR,
    );
    expect(screen.queryByTestId("verify-success")).toBeNull();
    expect(screen.queryByTestId("verify-failure")).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "Verify and set password" }),
    );
    expect(await screen.findByTestId("verify-success")).toBeDefined();
    expect(verifyEmail).toHaveBeenCalledTimes(2);
  });

  it("surfaces the API's policy message for a password it refuses", async () => {
    verifyEmail.mockRejectedValue(
      new ApiError(400, "Password must be at most 1024 characters"),
    );
    render(<VerifyEmailPanel token={TOKEN} />);

    await submit({ password: OWNER_PASSWORD });

    expect((await screen.findByTestId("verify-error")).textContent).toBe(
      "Password must be at most 1024 characters",
    );
    expect(screen.getByTestId("verify-form")).toBeDefined();
  });

  it("explains what to do when the page is opened without a token", () => {
    render(<VerifyEmailPanel token={null} />);

    expect(screen.getByTestId("verify-failure").textContent).toContain(
      "needs a verification link",
    );
    expect(screen.queryByLabelText("New password")).toBeNull();
    expect(verifyEmail).not.toHaveBeenCalled();
  });
});
