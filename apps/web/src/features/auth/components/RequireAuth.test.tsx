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
const retry = vi.fn();

vi.mock("../hooks/use-auth-session", () => ({
  useAuthSession: () => ({ state, signOut: vi.fn(), retry }),
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

  it("sends an anonymous browser to the sign-in page, keeping the URL it asked for (UX-003)", async () => {
    const attempted = "/backtests/new?strategyId=s-1&stockListId=l-2";
    window.history.replaceState(null, "", attempted);
    state = { status: "unauthenticated" };
    renderGate();

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(
        `/login?next=${encodeURIComponent(attempted)}`,
      ),
    );
    expect(replace).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Protected content")).toBeNull();
    window.history.replaceState(null, "", "/");
  });

  it("renders the route for an authenticated user", () => {
    state = {
      status: "authenticated",
      user: { id: "1", email: "person@example.test", role: "USER", plan: "FREE" },
    };
    renderGate();

    expect(screen.getByText("Protected content")).toBeDefined();
  });

  it("denies a role-restricted route without redirecting", () => {
    state = {
      status: "authenticated",
      user: { id: "1", email: "person@example.test", role: "USER", plan: "FREE" },
    };
    renderGate("ADMIN");

    expect(screen.getByTestId("auth-forbidden")).toBeDefined();
    expect(screen.queryByText("Protected content")).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it("allows a role-restricted route for the matching role", () => {
    state = {
      status: "authenticated",
      user: { id: "1", email: "admin@example.test", role: "ADMIN", plan: "FREE" },
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

  it("words a failure by its cause and offers a retry, inside the page gutters (UI-029)", async () => {
    state = { status: "error", reason: "server" };
    const { unmount } = renderGate();
    const panel = screen.getByTestId("auth-error");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(panel.textContent).toContain("usually temporary");
    expect(panel.textContent).not.toContain("connection");
    screen.getByRole("button", { name: "Try again" }).click();
    expect(retry).toHaveBeenCalled();
    unmount();

    state = { status: "error", reason: "unreachable" };
    renderGate();
    expect(screen.getByTestId("auth-error").textContent).toContain(
      "Check your connection",
    );
  });

  it("gives an account without the role one heading and a way back", () => {
    state = {
      status: "authenticated",
      user: { id: "1", email: "user@example.test", role: "USER", plan: "FREE" },
    };
    renderGate("ADMIN");
    const panel = screen.getByTestId("auth-forbidden");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(
      panel.querySelector("a")?.getAttribute("href"),
    ).toBe("/dashboard");
  });
});
