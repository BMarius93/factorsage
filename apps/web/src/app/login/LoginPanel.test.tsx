import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/dashboard"));
  });
});
