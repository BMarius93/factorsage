import { PASSWORD_MIN_LENGTH } from "@intrinsic/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../lib/api/client";
import { UNEXPECTED_ERROR } from "../utils/auth-errors";
import {
  PASSWORD_MISMATCH_MESSAGE,
  PASSWORD_TOO_SHORT_MESSAGE,
  RegisterForm,
} from "./RegisterForm";

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

const registerRequest = vi.fn();
const getAuthProviders = vi.fn();

vi.mock("../api/auth-api", () => ({
  GOOGLE_SIGN_IN_URL: "http://api.test/auth/google",
  register: (...args: unknown[]) => registerRequest(...args),
  getAuthProviders: () => getAuthProviders(),
}));

const VALID_PASSWORD = "Local-test-password-42";

async function fillForm(options: {
  email: string;
  password: string;
  confirmPassword?: string;
}) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Email"), options.email);
  await user.type(screen.getByLabelText("Password"), options.password);
  await user.type(
    screen.getByLabelText("Confirm password"),
    options.confirmPassword ?? options.password,
  );
  await user.click(screen.getByRole("button", { name: "Create account" }));
  return user;
}

describe("RegisterForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAuthProviders.mockResolvedValue({ google: false });
  });

  it("registers and tells the user to check their inbox", async () => {
    registerRequest.mockResolvedValue({ status: "verification_sent" });
    render(<RegisterForm />);

    await fillForm({ email: "new@example.test", password: VALID_PASSWORD });

    await waitFor(() => {
      expect(registerRequest).toHaveBeenCalledWith({
        email: "new@example.test",
        password: VALID_PASSWORD,
      });
    });

    const success = await screen.findByTestId("register-success");
    expect(success.textContent).toContain("new@example.test");
    // Registration must not look like a completed sign-in.
    expect(screen.queryByRole("button", { name: "Create account" })).toBeNull();
  });

  it("rejects a password that is shorter than the shared policy minimum", async () => {
    render(<RegisterForm />);

    await fillForm({ email: "new@example.test", password: "a".repeat(PASSWORD_MIN_LENGTH - 1) });

    expect((await screen.findByTestId("register-error")).textContent).toBe(
      PASSWORD_TOO_SHORT_MESSAGE,
    );
    expect(registerRequest).not.toHaveBeenCalled();
  });

  it("rejects a mismatched confirmation without calling the API", async () => {
    render(<RegisterForm />);

    await fillForm({
      email: "new@example.test",
      password: VALID_PASSWORD,
      confirmPassword: `${VALID_PASSWORD}-other`,
    });

    expect((await screen.findByTestId("register-error")).textContent).toBe(
      PASSWORD_MISMATCH_MESSAGE,
    );
    expect(registerRequest).not.toHaveBeenCalled();
  });

  it("surfaces the API's message when the address is already taken", async () => {
    registerRequest.mockRejectedValue(
      new ApiError(409, "An account with this email already exists"),
    );
    render(<RegisterForm />);

    await fillForm({ email: "taken@example.test", password: VALID_PASSWORD });

    expect((await screen.findByTestId("register-error")).textContent).toBe(
      "An account with this email already exists",
    );
  });

  it("does not surface server detail for a failure the user cannot act on", async () => {
    registerRequest.mockRejectedValue(
      new ApiError(503, "The verification email could not be sent."),
    );
    render(<RegisterForm />);

    await fillForm({ email: "new@example.test", password: VALID_PASSWORD });

    expect((await screen.findByTestId("register-error")).textContent).toBe(
      UNEXPECTED_ERROR,
    );
  });
});
