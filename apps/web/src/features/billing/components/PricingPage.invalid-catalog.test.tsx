import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
 * Its own file because the catalog is replaced for the whole module graph.
 */

vi.mock("@intrinsic/contracts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@intrinsic/contracts")>();
  return {
    ...actual,
    BILLING_CATALOG_ENTRIES: actual.BILLING_CATALOG_ENTRIES.filter(
      (entry) => entry.key !== "PRO_YEARLY",
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

/** Stands in for the `(app)` route's `error.tsx`. */
class Boundary extends Component<
  { readonly children: ReactNode },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
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
    vi.mocked(useAuthSession).mockReturnValue(guestSession());
    // React reports the caught render error to the console; that report is the expected outcome.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fails into the error boundary instead of quoting a price it does not have", async () => {
    render(
      <Boundary>
        <PricingPage />
      </Boundary>,
    );
    // Monthly prices are all present, so the page renders normally first.
    expect(screen.getByTestId("plan-price-PRO").textContent).toContain("$");

    await userEvent.click(screen.getByTestId("billing-interval-YEAR"));

    expect(screen.getByTestId("route-error")).toBeTruthy();
    expect(screen.queryByTestId("billing-catalog")).toBeNull();
    expect(document.body.textContent).not.toContain("undefined");
    expect(fetchBillingStatus).not.toHaveBeenCalled();
    expect(startCheckout).not.toHaveBeenCalled();
  });
});
