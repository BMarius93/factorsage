import { PLAN_ENTITLEMENTS, GUEST_ENTITLEMENTS } from "@intrinsic/contracts";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAuthSession, type AuthSession } from "./use-auth-session";
import { useEntitlements } from "./use-entitlements";

vi.mock("./use-auth-session", () => ({ useAuthSession: vi.fn() }));
const session = vi.mocked(useAuthSession);
const as = (state: AuthSession["state"]) =>
  ({ state, signOut: vi.fn() }) as unknown as AuthSession;

describe("useEntitlements", () => {
  it("resolves a signed-in user's limits with the canonical resolver", () => {
    session.mockReturnValue(
      as({
        status: "authenticated",
        user: { id: "u", email: "u@x.test", role: "USER", plan: "STARTER" },
      }),
    );
    const { result } = renderHook(() => useEntitlements());
    expect(result.current).toMatchObject({
      status: "ready",
      plan: "STARTER",
      entitlements: PLAN_ENTITLEMENTS.STARTER,
    });
  });

  it("gives a Guest the Guest capacities", () => {
    session.mockReturnValue(as({ status: "unauthenticated" }));
    const { result } = renderHook(() => useEntitlements());
    expect(result.current).toEqual({
      status: "ready",
      entitlements: GUEST_ENTITLEMENTS,
    });
  });

  it("shows no limit while the session is resolving, or where no session exists", () => {
    session.mockReturnValue(as({ status: "loading" }));
    expect(renderHook(() => useEntitlements()).result.current.status).toBe(
      "loading",
    );
    session.mockImplementation(() => {
      throw new Error("useAuthSession must be used inside AuthSessionProvider");
    });
    expect(renderHook(() => useEntitlements()).result.current.status).toBe(
      "loading",
    );
  });
});
