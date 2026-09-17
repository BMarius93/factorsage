import { vi } from "vitest";
import type { AuthUser } from "@intrinsic/contracts";
import type { AuthSession } from "../hooks/use-auth-session";

/**
 * The three answers `useAuthSession` gives, for tests of pages that behave differently per viewer.
 *
 * Built once here because every collection page now asks the same question — "does this viewer have
 * an account?" — and a test that hand-rolls the shape would drift from the hook it stands in for.
 * Pair with `vi.mock("…/use-auth-session", () => ({ useAuthSession: vi.fn() }))` in the test file.
 */
export function signedInSession(
  user: Partial<AuthUser> = {},
): AuthSession {
  return {
    state: {
      status: "authenticated",
      user: {
        id: "user-1",
        email: "user@example.test",
        role: "USER",
        plan: "PRO",
        ...user,
      },
    },
    signOut: vi.fn(),
  };
}

export function guestSession(): AuthSession {
  return { state: { status: "unauthenticated" }, signOut: vi.fn() };
}

export function resolvingSession(): AuthSession {
  return { state: { status: "loading" }, signOut: vi.fn() };
}
