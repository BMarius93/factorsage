import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthUser, logout, logoutEverywhere } from "../api/auth-api";
import {
  AuthSessionProvider,
  useAuthSession,
  type AuthSession,
} from "./use-auth-session";

vi.mock("../api/auth-api", () => ({
  getAuthUser: vi.fn(),
  logout: vi.fn(),
  logoutEverywhere: vi.fn(),
}));

let session: AuthSession | null = null;

function Probe() {
  session = useAuthSession();
  return <span data-testid="status">{session.state.status}</span>;
}

async function renderSignedIn() {
  render(
    <AuthSessionProvider>
      <Probe />
    </AuthSessionProvider>,
  );
  await waitFor(() =>
    expect(screen.getByTestId("status").textContent).toBe("authenticated"),
  );
}

describe("AuthSessionProvider sign-out", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    session = null;
    vi.mocked(getAuthUser).mockResolvedValue({
      id: "1",
      email: "person@example.test",
      role: "USER",
      plan: "PRO",
    });
    vi.mocked(logout).mockResolvedValue(undefined);
    vi.mocked(logoutEverywhere).mockResolvedValue(undefined);
  });

  it("signs out this browser only by default", async () => {
    await renderSignedIn();

    await act(() => session?.signOut() ?? Promise.resolve());

    expect(logout).toHaveBeenCalledTimes(1);
    expect(logoutEverywhere).not.toHaveBeenCalled();
    expect(screen.getByTestId("status").textContent).toBe("unauthenticated");
  });

  it("revokes every session when asked to sign out everywhere", async () => {
    await renderSignedIn();

    await act(
      () => session?.signOut({ everywhere: true }) ?? Promise.resolve(),
    );

    expect(logoutEverywhere).toHaveBeenCalledTimes(1);
    expect(logout).not.toHaveBeenCalled();
    expect(screen.getByTestId("status").textContent).toBe("unauthenticated");
  });
});
