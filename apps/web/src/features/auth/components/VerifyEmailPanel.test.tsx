import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

describe("VerifyEmailPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redeems the token from the link and confirms verification", async () => {
    verifyEmail.mockResolvedValue({ status: "verified" });
    render(<VerifyEmailPanel token="link-token" />);

    expect(screen.getByTestId("verify-pending")).toBeDefined();
    expect(await screen.findByTestId("verify-success")).toBeDefined();
    expect(verifyEmail).toHaveBeenCalledWith("link-token");
    expect(
      screen.getByRole("link", { name: "Continue to sign in" }),
    ).toBeDefined();
  });

  it("offers a fresh link when the token is rejected", async () => {
    verifyEmail.mockRejectedValue(new Error("invalid"));
    resendVerification.mockResolvedValue({ status: "accepted" });
    render(<VerifyEmailPanel token="expired-token" />);

    const failure = await screen.findByTestId("verify-failure");
    expect(failure.textContent).toContain("invalid, expired, or has already");

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Email"), "pending@example.test");
    await user.click(screen.getByRole("button", { name: "Send a new link" }));

    await waitFor(() => {
      expect(resendVerification).toHaveBeenCalledWith("pending@example.test");
    });
    expect(await screen.findByTestId("resend-confirmation")).toBeDefined();
  });

  it("explains what to do when the page is opened without a token", () => {
    render(<VerifyEmailPanel token={null} />);

    expect(screen.getByTestId("verify-failure").textContent).toContain(
      "needs a verification link",
    );
    expect(verifyEmail).not.toHaveBeenCalled();
  });
});
