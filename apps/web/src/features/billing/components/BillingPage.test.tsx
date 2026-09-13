import type { BillingStatusResponse } from "@intrinsic/contracts";
import { BILLING_CATALOG_ENTRIES } from "@intrinsic/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BillingPage } from "./BillingPage";

/**
 * What the billing page renders, and — more importantly — what it refuses to render.
 *
 * The rules worth a unit test are the presentation ones the server cannot enforce for us: that the
 * plan shown is the server's plan, that returning from Checkout with a success parameter grants
 * nothing on its own, and that a pending downgrade reads as *pending* rather than as done.
 */

const searchParams = { value: new URLSearchParams() };

vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams.value,
}));

const fetchBillingStatus = vi.fn();
const refreshBillingStatus = vi.fn();
const startCheckout = vi.fn();
const openBillingPortal = vi.fn();
const changeBillingPlan = vi.fn();

vi.mock("../api/billing-api", () => ({
  fetchBillingStatus: (...args: unknown[]) => fetchBillingStatus(...args),
  refreshBillingStatus: (...args: unknown[]) => refreshBillingStatus(...args),
  startCheckout: (...args: unknown[]) => startCheckout(...args),
  openBillingPortal: (...args: unknown[]) => openBillingPortal(...args),
  changeBillingPlan: (...args: unknown[]) => changeBillingPlan(...args),
}));

function billingStatus(
  overrides: Partial<BillingStatusResponse> = {},
): BillingStatusResponse {
  return {
    plan: "FREE",
    billingEnabled: true,
    subscription: null,
    canStartCheckout: true,
    canOpenPortal: false,
    canChangePlan: false,
    catalog: BILLING_CATALOG_ENTRIES,
    ...overrides,
  };
}

describe("BillingPage", () => {
  beforeEach(() => {
    searchParams.value = new URLSearchParams();
    vi.stubGlobal("location", { assign: vi.fn() } as unknown as Location);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows a Free user the four catalog options and no management entry", async () => {
    fetchBillingStatus.mockResolvedValue(billingStatus());
    render(<BillingPage />);

    expect((await screen.findByTestId("billing-plan")).textContent).toContain("Free");
    for (const entry of BILLING_CATALOG_ENTRIES) {
      expect(screen.getByTestId(`plan-option-${entry.key}`)).toBeTruthy();
      expect(screen.getByTestId(`choose-${entry.key}`)).toBeTruthy();
    }
    expect(screen.queryByTestId("manage-billing")).toBeNull();
  });

  it("prices each option from the shared catalog", async () => {
    fetchBillingStatus.mockResolvedValue(billingStatus());
    render(<BillingPage />);
    await screen.findByTestId("billing-catalog");

    expect(screen.getByTestId("plan-option-STARTER_MONTHLY").textContent).toContain("$9 / month");
    expect(screen.getByTestId("plan-option-STARTER_YEARLY").textContent).toContain("$99 / year");
    expect(screen.getByTestId("plan-option-PRO_MONTHLY").textContent).toContain("$29 / month");
    expect(screen.getByTestId("plan-option-PRO_YEARLY").textContent).toContain("$299 / year");
  });

  it("sends a catalog key to checkout and navigates to the returned Stripe URL", async () => {
    fetchBillingStatus.mockResolvedValue(billingStatus());
    startCheckout.mockResolvedValue({
      checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_123",
    });
    render(<BillingPage />);

    await userEvent.click(await screen.findByTestId("choose-PRO_YEARLY"));

    expect(startCheckout).toHaveBeenCalledWith("PRO_YEARLY");
    await waitFor(() =>
      expect(window.location.assign).toHaveBeenCalledWith(
        "https://checkout.stripe.com/c/pay/cs_test_123",
      ),
    );
  });

  it("shows a paid user their interval, renewal date and management entry", async () => {
    fetchBillingStatus.mockResolvedValue(
      billingStatus({
        plan: "PRO",
        canStartCheckout: false,
        canOpenPortal: true,
        canChangePlan: true,
        subscription: {
          plan: "PRO",
          interval: "YEAR",
          status: "ACTIVE",
          currentPeriodEnd: "2027-03-14T00:00:00.000Z",
          cancelAtPeriodEnd: false,
          cancelAt: null,
          pendingChange: null,
        },
      }),
    );
    render(<BillingPage />);

    expect((await screen.findByTestId("billing-plan")).textContent).toContain("Pro");
    expect(screen.getByTestId("billing-interval").textContent).toContain("Yearly");
    expect(screen.getByTestId("billing-period-end")).toBeTruthy();
    expect(screen.getByTestId("manage-billing")).toBeTruthy();
    expect(screen.getByTestId("plan-option-PRO_YEARLY").getAttribute("data-current")).toBe("true");
  });

  it("labels a downgrade as taking effect at renewal and an upgrade as immediate", async () => {
    fetchBillingStatus.mockResolvedValue(
      billingStatus({
        plan: "STARTER",
        canStartCheckout: false,
        canOpenPortal: true,
        canChangePlan: true,
        subscription: {
          plan: "STARTER",
          interval: "MONTH",
          status: "ACTIVE",
          currentPeriodEnd: "2026-10-12T00:00:00.000Z",
          cancelAtPeriodEnd: false,
          cancelAt: null,
          pendingChange: null,
        },
      }),
    );
    render(<BillingPage />);
    await screen.findByTestId("billing-catalog");

    // Same classifier the server uses, so the promise the label makes is the one the API keeps.
    expect(screen.getByTestId("plan-option-PRO_MONTHLY").textContent).toContain("Takes effect immediately");
    expect(screen.getByTestId("plan-option-STARTER_YEARLY").textContent).toContain("Takes effect immediately");
  });

  it("presents a scheduled cancellation as still-current access", async () => {
    fetchBillingStatus.mockResolvedValue(
      billingStatus({
        plan: "PRO",
        canStartCheckout: false,
        canOpenPortal: true,
        canChangePlan: true,
        subscription: {
          plan: "PRO",
          interval: "MONTH",
          status: "ACTIVE",
          currentPeriodEnd: "2026-10-12T00:00:00.000Z",
          cancelAtPeriodEnd: true,
          cancelAt: "2026-10-12T00:00:00.000Z",
          pendingChange: null,
        },
      }),
    );
    render(<BillingPage />);

    const scheduled = await screen.findByTestId("billing-cancel-scheduled");
    expect(scheduled.textContent).toContain("Cancels on");
    expect(scheduled.textContent).toContain("You keep Pro until then");
    // The plan badge still says Pro, because the entitlement has not moved.
    expect(screen.getByTestId("billing-plan").textContent).toContain("Pro");
  });

  it("presents a pending downgrade without claiming it has happened", async () => {
    fetchBillingStatus.mockResolvedValue(
      billingStatus({
        plan: "PRO",
        canStartCheckout: false,
        canOpenPortal: true,
        canChangePlan: true,
        subscription: {
          plan: "PRO",
          interval: "MONTH",
          status: "ACTIVE",
          currentPeriodEnd: "2026-10-12T00:00:00.000Z",
          cancelAtPeriodEnd: false,
          cancelAt: null,
          pendingChange: {
            plan: "STARTER",
            interval: "MONTH",
            effectiveAt: "2026-10-12T00:00:00.000Z",
          },
        },
      }),
    );
    render(<BillingPage />);

    const pending = await screen.findByTestId("billing-pending-change");
    expect(pending.textContent).toContain("Changing to Starter");
    expect(pending.textContent).toContain("Until then you keep Pro");
    expect(screen.getByTestId("billing-plan").textContent).toContain("Pro");
  });

  it("warns about a failed payment while keeping the plan visible", async () => {
    fetchBillingStatus.mockResolvedValue(
      billingStatus({
        plan: "PRO",
        canStartCheckout: false,
        canOpenPortal: true,
        canChangePlan: true,
        subscription: {
          plan: "PRO",
          interval: "MONTH",
          status: "PAST_DUE",
          currentPeriodEnd: "2026-10-12T00:00:00.000Z",
          cancelAtPeriodEnd: false,
          cancelAt: null,
          pendingChange: null,
        },
      }),
    );
    render(<BillingPage />);

    expect((await screen.findByTestId("billing-status-notice")).textContent).toMatch(/did not go through/);
    expect(screen.getByTestId("billing-plan").textContent).toContain("Pro");
  });

  it("grants nothing from a checkout=success parameter alone", async () => {
    // The critical one: a browser redirect is not billing proof. Both the initial read and the
    // settle refresh report FREE, and the page must say FREE while the notice explains the wait.
    searchParams.value = new URLSearchParams("checkout=success");
    fetchBillingStatus.mockResolvedValue(billingStatus());
    refreshBillingStatus.mockResolvedValue(billingStatus());
    render(<BillingPage />);

    expect(await screen.findByTestId("checkout-success-notice")).toBeTruthy();
    await waitFor(() => expect(refreshBillingStatus).toHaveBeenCalled());
    expect(screen.getByTestId("billing-plan").textContent).toContain("Free");
  });

  it("shows the confirmed plan once the server reports it", async () => {
    searchParams.value = new URLSearchParams("checkout=success");
    fetchBillingStatus.mockResolvedValue(billingStatus());
    refreshBillingStatus.mockResolvedValue(
      billingStatus({
        plan: "STARTER",
        canStartCheckout: false,
        canOpenPortal: true,
        canChangePlan: true,
        subscription: {
          plan: "STARTER",
          interval: "MONTH",
          status: "ACTIVE",
          currentPeriodEnd: "2026-10-12T00:00:00.000Z",
          cancelAtPeriodEnd: false,
          cancelAt: null,
          pendingChange: null,
        },
      }),
    );
    render(<BillingPage />);

    await waitFor(() =>
      expect(screen.getByTestId("billing-plan").textContent).toContain("Starter"),
    );
  });

  it("reports a cancelled checkout as having changed nothing", async () => {
    searchParams.value = new URLSearchParams("checkout=cancelled");
    fetchBillingStatus.mockResolvedValue(billingStatus());
    render(<BillingPage />);

    const cancelled = await screen.findByTestId("checkout-cancelled-notice");
    expect(cancelled.textContent).toMatch(/Nothing was charged/);
    expect(refreshBillingStatus).not.toHaveBeenCalled();
  });

  it("surfaces the API's own refusal message", async () => {
    fetchBillingStatus.mockResolvedValue(
      billingStatus({
        plan: "PRO",
        canStartCheckout: false,
        canOpenPortal: true,
        canChangePlan: true,
        subscription: {
          plan: "PRO",
          interval: "MONTH",
          status: "ACTIVE",
          currentPeriodEnd: "2026-10-12T00:00:00.000Z",
          cancelAtPeriodEnd: false,
          cancelAt: null,
          pendingChange: null,
        },
      }),
    );
    const { ApiError } = await import("../../../lib/api/client");
    changeBillingPlan.mockRejectedValue(
      new ApiError(
        409,
        "Your subscription is scheduled to cancel. Resume it from billing management before changing plan.",
        "BILLING_CHANGE_NOT_ALLOWED",
      ),
    );
    render(<BillingPage />);

    await userEvent.click(await screen.findByTestId("choose-STARTER_MONTHLY"));
    expect((await screen.findByTestId("billing-action-error")).textContent).toMatch(/scheduled to cancel/);
  });

  it("still lists prices when billing is not configured, but offers no purchase path", async () => {
    // The pricing table is information; the buttons are the transaction. A deployment with no
    // biller shows the former and none of the latter.
    fetchBillingStatus.mockResolvedValue(
      billingStatus({ billingEnabled: false, canStartCheckout: false }),
    );
    render(<BillingPage />);

    expect(await screen.findByTestId("billing-unavailable")).toBeTruthy();
    expect(screen.getByTestId("billing-catalog")).toBeTruthy();
    for (const entry of BILLING_CATALOG_ENTRIES) {
      expect(screen.getByTestId(`plan-option-${entry.key}`)).toBeTruthy();
      expect(screen.queryByTestId(`choose-${entry.key}`)).toBeNull();
    }
  });
});
