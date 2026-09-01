import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthState } from "../hooks/use-auth-session";
import { RequireAuth } from "./RequireAuth";

const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
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

let state: AuthState = { status: "loading" };

vi.mock("../hooks/use-auth-session", () => ({
  useAuthSession: () => ({ state, signOut: vi.fn() }),
}));

function renderGate(role?: "USER" | "ADMIN") {
  return render(
    <RequireAuth role={role}>
      <p>Protected content</p>
    </RequireAuth>,
  );
}

describe("RequireAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("holds the route while the session is still resolving", () => {
    state = { status: "loading" };
    renderGate();

    expect(screen.getByTestId("auth-checking")).toBeDefined();
    expect(screen.queryByText("Protected content")).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it("sends an anonymous browser to the sign-in page", async () => {
    state = { status: "unauthenticated" };
    renderGate();

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
    expect(screen.queryByText("Protected content")).toBeNull();
  });

  it("renders the route for an authenticated user", () => {
    state = {
      status: "authenticated",
      user: { id: "1", email: "person@example.test", role: "USER" },
    };
    renderGate();

    expect(screen.getByText("Protected content")).toBeDefined();
  });

  it("denies a role-restricted route without redirecting", () => {
    state = {
      status: "authenticated",
      user: { id: "1", email: "person@example.test", role: "USER" },
    };
    renderGate("ADMIN");

    expect(screen.getByTestId("auth-forbidden")).toBeDefined();
    expect(screen.queryByText("Protected content")).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it("allows a role-restricted route for the matching role", () => {
    state = {
      status: "authenticated",
      user: { id: "1", email: "admin@example.test", role: "ADMIN" },
    };
    renderGate("ADMIN");

    expect(screen.getByText("Protected content")).toBeDefined();
  });

  it("explains an unreachable API instead of pretending the user is signed out", () => {
    state = { status: "error" };
    renderGate();

    expect(screen.getByTestId("auth-error")).toBeDefined();
    expect(replace).not.toHaveBeenCalled();
  });
});
