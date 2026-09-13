import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../lib/api/client";
import { UNEXPECTED_ERROR } from "../utils/auth-errors";
import {
  ForgotPasswordForm,
  RESET_REQUESTED_MESSAGE,
} from "./ForgotPasswordForm";

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

const requestPasswordReset = vi.fn();

vi.mock("../api/auth-api", () => ({
  requestPasswordReset: (...args: unknown[]) => requestPasswordReset(...args),
}));

async function submit(email: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Email"), email);
  await user.click(screen.getByRole("button", { name: "Send reset link" }));
}

describe("ForgotPasswordForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestPasswordReset.mockResolvedValue({ status: "accepted" });
  });

  it("requests a link and shows the neutral confirmation", async () => {
    render(<ForgotPasswordForm />);

    await submit("person@example.test");

    await waitFor(() => {
      expect(requestPasswordReset).toHaveBeenCalledWith("person@example.test");
    });
    const sent = await screen.findByTestId("forgot-password-sent");
    expect(sent.textContent).toContain(RESET_REQUESTED_MESSAGE);
  });

  it("shows the same confirmation whatever the address is", async () => {
    const { unmount } = render(<ForgotPasswordForm />);
    await submit("known@example.test");
    const first = (await screen.findByTestId("forgot-password-sent"))
      .textContent;
    unmount();

    render(<ForgotPasswordForm />);
    await submit("unknown@example.test");
    const second = (await screen.findByTestId("forgot-password-sent"))
      .textContent;

    // The UI must not become the enumeration oracle the API refuses to be.
    expect(second).toBe(first);
  });

  it("surfaces the API's message for a rejected address", async () => {
    requestPasswordReset.mockRejectedValue(
      new ApiError(400, "Enter a valid email address"),
    );
    render(<ForgotPasswordForm />);

    await submit("not-an-address");

    expect(
      (await screen.findByTestId("forgot-password-error")).textContent,
    ).toBe("Enter a valid email address");
    expect(screen.queryByTestId("forgot-password-sent")).toBeNull();
  });

  it("does not surface server detail for a failure the user cannot act on", async () => {
    requestPasswordReset.mockRejectedValue(new ApiError(503, "smtp is down"));
    render(<ForgotPasswordForm />);

    await submit("person@example.test");

    expect(
      (await screen.findByTestId("forgot-password-error")).textContent,
    ).toBe(UNEXPECTED_ERROR);
  });
});
