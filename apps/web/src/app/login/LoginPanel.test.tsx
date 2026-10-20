import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SIGN_IN_REASONS } from "../../features/auth/utils/sign-in-reason";
import { LoginPanel } from "./LoginPanel";

const replace = vi.fn();
const refresh = vi.fn();
let search = "";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh }),
  useSearchParams: () => new URLSearchParams(search),
}));

const login = vi.fn();

vi.mock("../../features/auth/api/auth-api", () => ({
  GOOGLE_SIGN_IN_URL: "http://api.test/auth/google",
  login: (...args: unknown[]) => login(...args),
  getAuthProviders: () => Promise.resolve({ google: false }),
  getAuthUser: () => Promise.resolve(null),
}));

async function signIn() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Email"), "user@example.test");
  await user.type(screen.getByLabelText("Password"), "Local-test-password-42");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("LoginPanel return destination (UX-003)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    login.mockResolvedValue({
      id: "1",
      email: "user@example.test",
      role: "USER",
    });
  });

  it("returns to the exact page and query named in ?next=, decoded once", async () => {
    const destination = "/backtests/new?strategyId=s-1&stockListId=l-2";
    search = `next=${encodeURIComponent(destination)}`;
    render(<LoginPanel />);

    await signIn();

    await waitFor(() => expect(replace).toHaveBeenCalledWith(destination));
  });

  it.each([
    ["an encoded protocol-relative URL", "next=%2F%2Fevil.example"],
    ["an absolute URL", "next=https%3A%2F%2Fevil.example"],
    ["a slash-backslash", "next=%2F%5Cevil.example"],
    ["a double-encoded //", "next=%2F%252F%252Fevil.example"],
    ["no destination", ""],
  ])("lands on the Dashboard for %s", async (_label, query) => {
    search = query;
    render(<LoginPanel />);

    await signIn();

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
  });
});

describe("LoginPanel sign-in reason (GL-7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["/backtests", SIGN_IN_REASONS.backtests],
    [
      "/backtests/new?strategyId=s-1&stockListId=l-2",
      SIGN_IN_REASONS.backtests,
    ],
    ["/strategies/new", SIGN_IN_REASONS.newStrategy],
    ["/billing", SIGN_IN_REASONS.billing],
    ["/legal/requests", SIGN_IN_REASONS.privacyRequests],
    ["/lists?new=1", SIGN_IN_REASONS.newList],
    ["/admin", SIGN_IN_REASONS.fallback],
  ])("says why %s needs an account, above the form", (destination, reason) => {
    search = `next=${encodeURIComponent(destination)}`;
    render(<LoginPanel />);

    const line = screen.getByTestId("login-reason");
    expect(line.textContent).toBe(reason);
    // Above the form, not inside it, and not an alert: it is information, not a failure.
    const form = document.querySelector("form");
    expect(form).not.toBeNull();
    expect(
      line.compareDocumentPosition(form as HTMLFormElement) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(line.getAttribute("role")).toBeNull();
  });

  it.each([
    ["no destination", ""],
    ["the Dashboard", "next=%2F"],
    ["a page a Guest can read", "next=%2Fstocks%2FAAPL"],
    ["an encoded protocol-relative URL", "next=%2F%2Fevil.example%2Fbacktests"],
    ["an absolute URL", "next=https%3A%2F%2Fevil.example%2Fbilling"],
    ["a double-encoded //", "next=%2F%252F%252Fevil.example"],
  ])("shows no reason for %s", (_label, query) => {
    search = query;
    render(<LoginPanel />);

    expect(screen.queryByTestId("login-reason")).toBeNull();
    expect(screen.getByLabelText("Email")).toBeDefined();
  });

  it("never echoes the link's own words, and still returns to the page", async () => {
    login.mockResolvedValue({
      id: "1",
      email: "user@example.test",
      role: "USER",
    });
    const destination = "/backtests?note=Your%20account%20is%20suspended";
    search = `next=${encodeURIComponent(destination)}`;
    render(<LoginPanel />);

    expect(screen.getByTestId("login-reason").textContent).toBe(
      SIGN_IN_REASONS.backtests,
    );
    expect(document.body.textContent).not.toMatch(/suspended/i);

    await signIn();
    await waitFor(() => expect(replace).toHaveBeenCalledWith(destination));
  });
});
