import { RATE_LIMITED_CODE } from "@intrinsic/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../lib/api/client";
import { UNEXPECTED_ERROR } from "../utils/auth-errors";
import { REGISTRATION_ACCEPTED_MESSAGE, RegisterForm } from "./RegisterForm";

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

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("../api/auth-api", () => ({
  getAuthUser: () => Promise.resolve(null),
  GOOGLE_SIGN_IN_URL: "http://api.test/auth/google",
  register: (...args: unknown[]) => registerRequest(...args),
  getAuthProviders: () => getAuthProviders(),
}));

async function submitEmail(email: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Email"), email);
  await user.click(screen.getByRole("button", { name: "Continue" }));
  return user;
}

/** Everything a person could read on the confirmation, so two renders can be compared exactly. */
function acceptedCopy(): string {
  return screen.getByTestId("register-accepted").textContent ?? "";
}

describe("RegisterForm (email-first, AUTH-003)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAuthProviders.mockResolvedValue({ google: false });
  });

  it("asks for an email address and nothing else", () => {
    render(<RegisterForm />);

    expect(screen.getByLabelText("Email")).toBeDefined();
    expect(screen.queryByLabelText(/password/i)).toBeNull();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDefined();
  });

  it("sends only the address and shows the neutral confirmation", async () => {
    registerRequest.mockResolvedValue({ status: "accepted" });
    render(<RegisterForm />);

    await submitEmail("person@example.com");

    await waitFor(() => {
      expect(registerRequest).toHaveBeenCalledWith({
        email: "person@example.com",
      });
    });
    const accepted = await screen.findByTestId("register-accepted");
    expect(screen.getByRole("status").textContent).toBe(
      REGISTRATION_ACCEPTED_MESSAGE,
    );
    // Nothing that claims an account was created, already existed, or that mail was sent.
    expect(accepted.textContent).not.toMatch(
      /already (exists|registered)|account (was )?created|we sent|has been sent/i,
    );
    // Registration must not look like a completed sign-in, and the form is gone.
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(screen.queryByLabelText("Email")).toBeNull();
  });

  it("renders exactly the same confirmation whatever account the address belongs to", async () => {
    // The API gives one answer for new, pending, verified, Google-only and cooling-down
    // addresses; the page must too. Two different addresses stand in for two different states.
    registerRequest.mockResolvedValue({ status: "accepted" });
    const first = render(<RegisterForm />);
    await submitEmail("new-person@example.com");
    await screen.findByTestId("register-accepted");
    const newCopy = acceptedCopy();
    first.unmount();

    render(<RegisterForm />);
    await submitEmail("existing-person@example.com");
    await screen.findByTestId("register-accepted");

    expect(acceptedCopy()).toBe(newCopy);
    expect(newCopy).not.toContain("new-person@example.com");
  });

  it("links to sign in and to password recovery, before and after submitting", async () => {
    registerRequest.mockResolvedValue({ status: "accepted" });
    render(<RegisterForm />);

    const hrefs = () =>
      screen.getAllByRole("link").map((link) => link.getAttribute("href"));
    expect(hrefs()).toEqual(
      expect.arrayContaining(["/login", "/forgot-password"]),
    );

    await submitEmail("person@example.com");
    await screen.findByTestId("register-accepted");
    expect(hrefs()).toEqual(
      expect.arrayContaining(["/login", "/forgot-password"]),
    );
  });

  it("shows a loading state and submits once however often the button is pressed", async () => {
    let resolve!: (value: unknown) => void;
    registerRequest.mockImplementation(
      () =>
        new Promise((settle) => {
          resolve = settle;
        }),
    );
    render(<RegisterForm />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Email"), "person@example.com");

    const button = screen.getByRole("button", { name: "Continue" });
    await user.click(button);
    await user.click(button);
    await user.dblClick(button);

    const busy = await screen.findByRole("button", { name: "Sending…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Email") as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(
      document.querySelector("form")?.getAttribute("aria-busy"),
    ).toBe("true");
    expect(registerRequest).toHaveBeenCalledTimes(1);

    resolve({ status: "accepted" });
    await screen.findByTestId("register-accepted");
    expect(registerRequest).toHaveBeenCalledTimes(1);
  });

  it("shows the API's message for a malformed address and keeps the form", async () => {
    registerRequest.mockRejectedValue(
      new ApiError(400, "Enter a valid email address"),
    );
    render(<RegisterForm />);

    await submitEmail("not-an-address");

    const error = await screen.findByTestId("register-error");
    expect(error.textContent).toBe("Enter a valid email address");
    expect(error.getAttribute("role")).toBe("alert");
    const input = screen.getByLabelText("Email");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe("register-error");
    // The user can correct it and try again.
    expect(
      (screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("names the wait when registration is throttled", async () => {
    registerRequest.mockRejectedValue(
      new ApiError(429, "Too many requests", RATE_LIMITED_CODE, undefined, 120),
    );
    render(<RegisterForm />);

    await submitEmail("person@example.com");

    expect((await screen.findByTestId("register-error")).textContent).toBe(
      "Too many requests. Please try again in 2 minutes.",
    );
  });

  it("hides server detail for a server or network failure", async () => {
    registerRequest.mockRejectedValueOnce(
      new ApiError(500, "Internal server error"),
    );
    render(<RegisterForm />);

    const user = await submitEmail("person@example.com");
    expect((await screen.findByTestId("register-error")).textContent).toBe(
      UNEXPECTED_ERROR,
    );

    registerRequest.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => {
      expect(registerRequest).toHaveBeenCalledTimes(2);
    });
    expect((await screen.findByTestId("register-error")).textContent).toBe(
      UNEXPECTED_ERROR,
    );
  });

  it("keeps the return destination on its links back to sign-in and Google (UX-003)", async () => {
    const destination = "/strategies/s-1?from=prompt";
    getAuthProviders.mockResolvedValue({ google: true });
    registerRequest.mockResolvedValue({ status: "accepted" });
    render(<RegisterForm returnPath={destination} />);

    const signInLinks = () =>
      screen
        .getAllByRole("link", { name: "Sign in" })
        .map((link) => link.getAttribute("href"));
    expect(signInLinks()).toEqual([
      `/login?next=${encodeURIComponent(destination)}`,
    ]);
    expect(
      (await screen.findByTestId("google-sign-in")).getAttribute("href"),
    ).toBe(
      `http://api.test/auth/google?next=${encodeURIComponent(destination)}`,
    );

    // Still there after submitting: a same-tab sign-in comes back to where the visitor started.
    // The destination is never sent with the registration request, so it cannot reach the email.
    await submitEmail("person@example.com");
    await screen.findByTestId("register-accepted");
    expect(signInLinks()).toEqual([
      `/login?next=${encodeURIComponent(destination)}`,
    ]);
    expect(registerRequest).toHaveBeenCalledWith({
      email: "person@example.com",
    });
  });

  it("drops a destination it would refuse from its links (UX-003)", () => {
    render(<RegisterForm returnPath="https://evil.example" />);

    expect(
      screen.getByRole("link", { name: "Sign in" }).getAttribute("href"),
    ).toBe("/login");
  });
});
