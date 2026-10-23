import { render, screen } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guestSession } from "../../auth/__testing__/auth-session";
import { useAuthSession } from "../../auth/hooks/use-auth-session";
import { PricingPage } from "./PricingPage";

/**
 * A catalog that has lost a price must not become a card that quotes `undefined` — or, worse, a
 * number from somewhere else — to a visitor. `plan-presentation.ts` refuses to price a plan it has
 * no catalog entry for, and the page lets that refusal reach the route's error boundary rather than
 * rendering around it.
 *
 * The catalog sells one cadence, so every card is priced on the first render: the lost price —
 * here Pro+'s monthly one — fails the page as it opens, not after a cadence switch.
 *
 * Its own file because the catalog is replaced for the whole module graph.
 */

vi.mock("@intrinsic/contracts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@intrinsic/contracts")>();
  return {
    ...actual,
    BILLING_CATALOG_ENTRIES: actual.BILLING_CATALOG_ENTRIES.filter(
      (entry) => entry.key !== "PRO_PLUS_MONTHLY",
    ),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("../../auth/hooks/use-auth-session", () => ({
  useAuthSession: vi.fn(),
}));

const fetchBillingStatus = vi.fn();
const startCheckout = vi.fn();

vi.mock("../api/billing-api", () => ({
  fetchBillingStatus: (...args: unknown[]) => fetchBillingStatus(...args),
  refreshBillingStatus: vi.fn(),
  startCheckout: (...args: unknown[]) => startCheckout(...args),
  openBillingPortal: vi.fn(),
  changeBillingPlan: vi.fn(),
}));

/** What the stand-in boundary caught, so the test can say the page failed for the right reason. */
const caught: unknown[] = [];

/** Stands in for the `(app)` route's `error.tsx`. */
class Boundary extends Component<
  { readonly children: ReactNode },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    caught.push(error);
  }

  override render() {
    return this.state.failed ? (
      <p data-testid="route-error">Something went wrong.</p>
    ) : (
      this.props.children
    );
  }
}

describe("PricingPage with an incomplete catalog", () => {
  beforeEach(() => {
    caught.length = 0;
    vi.mocked(useAuthSession).mockReturnValue(guestSession());
    // React reports the caught render error to the console; that report is the expected outcome.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fails into the error boundary instead of quoting a price it does not have", () => {
    render(
      <Boundary>
        <PricingPage />
      </Boundary>,
    );

    expect(screen.getByTestId("route-error")).toBeTruthy();
    expect(screen.queryByTestId("billing-catalog")).toBeNull();
    expect(document.body.textContent).not.toContain("undefined");
    // Refused for the price that is missing, not for some unrelated reason.
    expect(caught).toHaveLength(1);
    expect(String(caught[0])).toContain("No catalog entry for PRO_PLUS/MONTH");
    expect(fetchBillingStatus).not.toHaveBeenCalled();
    expect(startCheckout).not.toHaveBeenCalled();
  });
});
