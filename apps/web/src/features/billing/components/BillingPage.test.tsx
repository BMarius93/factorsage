import type { BillingStatusResponse } from "@intrinsic/contracts";
import {
  BILLING_CATALOG_ENTRIES,
  PLAN_ENTITLEMENTS,
} from "@intrinsic/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BillingPage } from "./BillingPage";

/**
 * What the billing page renders, and — more importantly — what it refuses to render.
 *
 * The rules worth a unit test are the presentation ones the server cannot enforce for us: that
 * there are three plans rather than four price rows, that the cadence toggle changes both the price
 * *and* the logical price key the button will send, that the plan shown is the server's plan, that
 * returning from Checkout with a success parameter grants nothing, and that a pending downgrade
 * reads as *pending* rather than as done.
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

function paid(
  overrides: Partial<BillingStatusResponse> = {},
): BillingStatusResponse {
  return billingStatus({
    canStartCheckout: false,
    canOpenPortal: true,
    canChangePlan: true,
    ...overrides,
  });
}

const priceOf = (plan: string) =>
  screen.getByTestId(`plan-price-${plan}`).textContent ?? "";

describe("BillingPage", () => {
  beforeEach(() => {
    searchParams.value = new URLSearchParams();
    vi.stubGlobal("location", { assign: vi.fn() } as unknown as Location);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders exactly three plan cards — Free, Starter and Pro", async () => {
    fetchBillingStatus.mockResolvedValue(billingStatus());
    render(<BillingPage />);

    const catalog = await screen.findByTestId("billing-catalog");
    // Direct children only: each card holds its own list of features.
    expect(catalog.childElementCount).toBe(3);
    for (const plan of ["FREE", "STARTER", "PRO"]) {
      expect(screen.getByTestId(`plan-card-${plan}`)).toBeTruthy();
    }
  });

  it("has no separate monthly and yearly cards", async () => {
    // The regression this replaces: four cards, one per catalog price.
    fetchBillingStatus.mockResolvedValue(billingStatus());
    render(<BillingPage />);
    await screen.findByTestId("billing-catalog");

    for (const entry of BILLING_CATALOG_ENTRIES) {
      expect(screen.queryByTestId(`plan-option-${entry.key}`)).toBeNull();
    }
    expect(screen.queryByText("Starter Monthly")).toBeNull();
    expect(screen.queryByText("Starter Yearly")).toBeNull();
  });

  it("changes the prices in place when the cadence toggle moves", async () => {
    fetchBillingStatus.mockResolvedValue(billingStatus());
    render(<BillingPage />);
    await screen.findByTestId("billing-catalog");

    expect(priceOf("STARTER")).toContain("$9");
    expect(priceOf("STARTER")).toContain("/ month");
    expect(priceOf("PRO")).toContain("$29");

    await userEvent.click(screen.getByTestId("billing-interval-YEAR"));

    expect(priceOf("STARTER")).toContain("$99");
    expect(priceOf("STARTER")).toContain("/ year");
    expect(priceOf("PRO")).toContain("$299");
    // Still three cards; the cadence is a property of a plan, not another plan.
    expect(screen.getByTestId("billing-catalog").childElementCount).toBe(3);
  });

  it("carries the cadence through to the price key its button will send", async () => {
    // The bug this guards: the page shows Yearly while the request carries the monthly price.
    fetchBillingStatus.mockResolvedValue(billingStatus());
    startCheckout.mockResolvedValue({ checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test" });
    render(<BillingPage />);
    await screen.findByTestId("billing-catalog");

    expect(
      screen.getByTestId("plan-action-STARTER").getAttribute("data-price-key"),
    ).toBe("STARTER_MONTHLY");

    await userEvent.click(screen.getByTestId("billing-interval-YEAR"));
    expect(
      screen.getByTestId("plan-action-STARTER").getAttribute("data-price-key"),
    ).toBe("STARTER_YEARLY");

    await userEvent.click(screen.getByTestId("plan-action-STARTER"));
    expect(startCheckout).toHaveBeenCalledWith("STARTER_YEARLY");
    await waitFor(() =>
      expect(window.location.assign).toHaveBeenCalledWith(
        "https://checkout.stripe.com/c/pay/cs_test",
      ),
    );
  });

  it("exposes the selected cadence as a radio selection, not a pressed button", async () => {
    fetchBillingStatus.mockResolvedValue(billingStatus());
    render(<BillingPage />);
    await screen.findByTestId("billing-catalog");

    const group = screen.getByRole("radiogroup", { name: "Billing interval" });
    const monthly = within(group).getByRole("radio", { name: "Monthly" });
    const yearly = within(group).getByRole("radio", { name: "Yearly" });

    expect((monthly as HTMLInputElement).checked).toBe(true);
    expect((yearly as HTMLInputElement).checked).toBe(false);

    await userEvent.click(yearly);
    expect((yearly as HTMLInputElement).checked).toBe(true);
    expect((monthly as HTMLInputElement).checked).toBe(false);
  });

  it("lists each plan's capacities as checked rows quoting the entitlement matrix", async () => {
    fetchBillingStatus.mockResolvedValue(billingStatus());
    render(<BillingPage />);
    await screen.findByTestId("billing-catalog");

    for (const plan of ["FREE", "STARTER", "PRO"] as const) {
      const features = screen.getByTestId(`plan-features-${plan}`);
      const rows = within(features).getAllByRole("listitem");
      expect(rows.length).toBeGreaterThan(0);

      // The number on the card is the number in the matrix, not a copy of it.
      expect(features.textContent).toContain(
        `${PLAN_ENTITLEMENTS[plan].lists.maxSymbols} stocks per list`,
      );
      expect(features.textContent).toContain(
        `${PLAN_ENTITLEMENTS[plan].monitors.maxActive} active monitor`,
      );

      // One decorative check per row, hidden from assistive technology so a five-item list is
      // read as five items rather than ten.
      for (const row of rows) {
        const check = row.querySelector("svg");
        expect(check).not.toBeNull();
        expect(check?.getAttribute("aria-hidden")).toBe("true");
      }
    }
    // And the dot-styled bullets are gone.
    expect(document.querySelectorAll("li")[0]?.textContent).not.toContain("•");
  });

  it("marks the Free plan as current for a Free user and disables its action", async () => {
    fetchBillingStatus.mockResolvedValue(billingStatus());
    render(<BillingPage />);

    const free = await screen.findByTestId("plan-card-FREE");
    expect(free.getAttribute("data-current")).toBe("true");
    expect(within(free).getByTestId("plan-current-badge").textContent).toBe(
      "Current plan",
    );

    const action = screen.getByTestId("plan-action-FREE") as HTMLButtonElement;
    expect(action.textContent).toBe("Current plan");
    expect(action.disabled).toBe(true);

    expect(screen.getByTestId("plan-card-STARTER").getAttribute("data-current")).toBeNull();
    expect(screen.getByTestId("plan-action-STARTER").textContent).toBe(
      "Upgrade to Starter",
    );
    expect(screen.getByTestId("plan-action-PRO").textContent).toBe("Upgrade to Pro");
    expect(screen.queryByTestId("manage-billing")).toBeNull();
  });

  it("names the plan the server reports beside the page title", async () => {
    fetchBillingStatus.mockResolvedValue(billingStatus({ plan: "STARTER" }));
    render(<BillingPage />);

    expect((await screen.findByTestId("billing-plan")).textContent).toContain(
      "Starter",
    );
  });

  it("opens on the cadence a subscriber is already billed for", async () => {
    fetchBillingStatus.mockResolvedValue(
      paid({
        plan: "PRO",
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
    await screen.findByTestId("billing-catalog");

    expect(
      (
        screen.getByRole("radio", { name: "Yearly" }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(priceOf("PRO")).toContain("$299");
    expect(
      (screen.getByTestId("plan-action-PRO") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByTestId("plan-action-PRO").textContent).toBe("Current plan");
  });

  it("shows a subscriber their interval, renewal date and management entry", async () => {
    fetchBillingStatus.mockResolvedValue(
      paid({
        plan: "PRO",
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
  });

  it("labels an upgrade as immediate and a downgrade as at renewal", async () => {
    fetchBillingStatus.mockResolvedValue(
      paid({
        plan: "STARTER",
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
    expect(screen.getByTestId("plan-action-PRO").textContent).toBe("Upgrade to Pro");
    expect(screen.getByTestId("plan-hint-PRO").textContent).toBe(
      "Takes effect immediately",
    );
    expect(screen.getByTestId("plan-action-FREE").textContent).toBe(
      "Cancel subscription",
    );
    expect(screen.getByTestId("plan-hint-FREE").textContent).toBe(
      "Takes effect at your next renewal",
    );

    await userEvent.click(screen.getByTestId("billing-interval-YEAR"));
    expect(screen.getByTestId("plan-action-STARTER").textContent).toBe(
      "Switch to yearly",
    );
  });

  it("renders the CTA matrix for a Free, Starter and Pro user in both cadences (BILLING-CTA)", async () => {
    const subscription = (plan: "STARTER" | "PRO") => ({
      plan,
      interval: "MONTH" as const,
      status: "ACTIVE" as const,
      currentPeriodEnd: "2026-10-12T00:00:00.000Z",
      cancelAtPeriodEnd: false,
      cancelAt: null,
      pendingChange: null,
    });
    const renewal = "Takes effect at your next renewal";
    const cases = [
      {
        billing: billingStatus(),
        expected: {
          FREE: ["Current plan", true, ""],
          STARTER: ["Upgrade to Starter", false, ""],
          PRO: ["Upgrade to Pro", false, ""],
        },
      },
      {
        billing: paid({
          plan: "STARTER",
          subscription: subscription("STARTER"),
        }),
        expected: {
          FREE: ["Cancel subscription", false, renewal],
          STARTER: ["Current plan", true, ""],
          PRO: ["Upgrade to Pro", false, "Takes effect immediately"],
        },
      },
      {
        // The regression: this card used to read "Upgrade to Starter" / "Downgrade to Starter".
        billing: paid({ plan: "PRO", subscription: subscription("PRO") }),
        expected: {
          FREE: ["Cancel subscription", false, renewal],
          STARTER: ["Switch to Starter", false, renewal],
          PRO: ["Current plan", true, ""],
        },
      },
    ] as const;

    const read = (plan: string) => {
      const button = screen.getByTestId(
        `plan-action-${plan}`,
      ) as HTMLButtonElement;
      return [
        button.textContent,
        button.disabled,
        screen.getByTestId(`plan-hint-${plan}`).textContent,
      ];
    };

    for (const { billing, expected } of cases) {
      fetchBillingStatus.mockResolvedValue(billing);
      const view = render(<BillingPage />);
      await screen.findByTestId("billing-catalog");

      for (const plan of ["FREE", "STARTER", "PRO"] as const) {
        expect(
          read(plan),
          `${billing.plan} user, ${plan} card, monthly`,
        ).toEqual(expected[plan]);
      }
      // Yearly re-prices the cards; it does not re-decide which way each one moves the user. The
      // current tier's own card is the exception, and offers the other cadence.
      await userEvent.click(screen.getByTestId("billing-interval-YEAR"));
      for (const plan of ["FREE", "STARTER", "PRO"] as const) {
        if (plan === billing.plan && plan !== "FREE") {
          expect(read(plan)[0]).toBe("Switch to yearly");
          continue;
        }
        expect(
          read(plan),
          `${billing.plan} user, ${plan} card, yearly`,
        ).toEqual(expected[plan]);
      }
      view.unmount();
    }
  });

  it("names a lower tier a switch for a plan granted without a subscription", async () => {
    // A seeded or administratively set Pro: Checkout is still how it buys, but Starter is below
    // it, and there is no subscription for the Free card to cancel.
    fetchBillingStatus.mockResolvedValue(billingStatus({ plan: "PRO" }));
    render(<BillingPage />);
    await screen.findByTestId("billing-catalog");

    expect(screen.getByTestId("plan-action-STARTER").textContent).toBe(
      "Switch to Starter",
    );
    expect(screen.getByTestId("plan-action-PRO").textContent).toBe(
      "Current plan",
    );
    expect(screen.queryByTestId("plan-action-FREE")).toBeNull();
  });

  it("asks the API to change plan rather than to buy a second subscription", async () => {
    fetchBillingStatus.mockResolvedValue(
      paid({
        plan: "STARTER",
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
    changeBillingPlan.mockResolvedValue({
      effect: "IMMEDIATE",
      kind: "TIER_UPGRADE",
      effectiveAt: null,
      plan: "PRO",
    });
    render(<BillingPage />);

    await userEvent.click(await screen.findByTestId("plan-action-PRO"));

    expect(changeBillingPlan).toHaveBeenCalledWith("PRO_MONTHLY");
    expect(startCheckout).not.toHaveBeenCalled();
  });

  it("sends a subscriber to the Customer Portal to reach Free", async () => {
    fetchBillingStatus.mockResolvedValue(
      paid({
        plan: "PRO",
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
    openBillingPortal.mockResolvedValue({
      portalUrl: "https://billing.stripe.com/p/session_test",
    });
    render(<BillingPage />);

    await userEvent.click(await screen.findByTestId("plan-action-FREE"));

    // Free has no Stripe price: the supported route is cancellation, and that lives in Portal.
    expect(startCheckout).not.toHaveBeenCalled();
    expect(changeBillingPlan).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(window.location.assign).toHaveBeenCalledWith(
        "https://billing.stripe.com/p/session_test",
      ),
    );
  });

  it("presents a scheduled cancellation as still-current access", async () => {
    fetchBillingStatus.mockResolvedValue(
      paid({
        plan: "PRO",
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
    expect(screen.getByTestId("plan-card-PRO").getAttribute("data-current")).toBe(
      "true",
    );
    // And Free is not offered again — Stripe already has the request.
    expect(screen.queryByTestId("plan-action-FREE")).toBeNull();
  });

  it("presents a pending downgrade without claiming it has happened", async () => {
    fetchBillingStatus.mockResolvedValue(
      paid({
        plan: "PRO",
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
    expect(screen.getByTestId("plan-card-PRO").getAttribute("data-current")).toBe(
      "true",
    );
  });

  it("warns about a failed payment while keeping the plan visible", async () => {
    fetchBillingStatus.mockResolvedValue(
      paid({
        plan: "PRO",
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

    expect((await screen.findByTestId("billing-status-notice")).textContent).toMatch(
      /did not go through/,
    );
    expect(screen.getByTestId("billing-plan").textContent).toContain("Pro");
  });

  it("does not claim a subscribed-but-unpaid price as the current plan", async () => {
    fetchBillingStatus.mockResolvedValue(
      billingStatus({
        plan: "FREE",
        canStartCheckout: false,
        canChangePlan: true,
        canOpenPortal: true,
        subscription: {
          plan: "STARTER",
          interval: "MONTH",
          status: "INCOMPLETE",
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          cancelAt: null,
          pendingChange: null,
        },
      }),
    );
    render(<BillingPage />);

    await screen.findByTestId("billing-catalog");
    expect(screen.getByTestId("plan-card-FREE").getAttribute("data-current")).toBe(
      "true",
    );
    expect(
      screen.getByTestId("plan-card-STARTER").getAttribute("data-current"),
    ).toBeNull();
    expect(screen.getByTestId("plan-hint-STARTER").textContent).toBe(
      "Waiting for payment confirmation",
    );
  });

  it("does not tell an ended subscription that it renews", async () => {
    // The mirror keeps the cadence and the period end after cancellation; printing them would
    // promise a renewal to somebody whose access has already gone.
    fetchBillingStatus.mockResolvedValue(
      billingStatus({
        plan: "FREE",
        canStartCheckout: true,
        canOpenPortal: true,
        canChangePlan: false,
        subscription: {
          plan: "PRO",
          interval: "YEAR",
          status: "CANCELED",
          currentPeriodEnd: "2027-09-14T00:00:00.000Z",
          cancelAtPeriodEnd: false,
          cancelAt: "2027-09-14T00:00:00.000Z",
          pendingChange: null,
        },
      }),
    );
    render(<BillingPage />);

    expect((await screen.findByTestId("billing-status-notice")).textContent).toMatch(
      /subscription has ended/,
    );
    expect(screen.queryByTestId("billing-period-end")).toBeNull();
    expect(screen.queryByTestId("billing-interval")).toBeNull();
    expect(screen.queryByTestId("billing-cancel-scheduled")).toBeNull();
    // Free is current again, and buying is offered from the Free card's neighbours.
    expect(screen.getByTestId("plan-card-FREE").getAttribute("data-current")).toBe(
      "true",
    );
    expect(screen.getByTestId("plan-action-STARTER").textContent).toBe(
      "Upgrade to Starter",
    );
  });

  it("lets a lapsed subscriber buy back the plan they left (UI-037)", async () => {
    fetchBillingStatus.mockResolvedValue(
      billingStatus({
        plan: "FREE",
        canStartCheckout: true,
        canOpenPortal: true,
        subscription: {
          plan: "PRO",
          interval: "YEAR",
          status: "CANCELED",
          currentPeriodEnd: "2027-09-14T00:00:00.000Z",
          cancelAtPeriodEnd: false,
          cancelAt: null,
          pendingChange: null,
        },
      }),
    );
    render(<BillingPage />);

    const pro = await screen.findByTestId("plan-action-PRO");
    // Not "Waiting for payment confirmation": nothing is waiting, the subscription ended.
    expect(pro.textContent).toBe("Resubscribe to Pro");
    expect(pro.hasAttribute("disabled")).toBe(false);
    expect(screen.queryByText("Waiting for payment confirmation")).toBeNull();
    // The ended yearly cadence does not seed the toggle; a returning buyer starts on monthly.
    expect(
      (screen.getByRole("radio", { name: /Monthly/ }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("never claims confirmation when the settle window runs out unconfirmed (UI-046)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      searchParams.value = new URLSearchParams("checkout=success");
      fetchBillingStatus.mockResolvedValue(billingStatus());
      refreshBillingStatus.mockResolvedValue(billingStatus());
      render(<BillingPage />);

      await screen.findByTestId("checkout-success-notice");
      await vi.advanceTimersByTimeAsync(20_000);
      await waitFor(() =>
        expect(refreshBillingStatus.mock.calls.length).toBeGreaterThanOrEqual(6),
      );
      const notice = await screen.findByTestId("checkout-success-notice");
      await waitFor(() => expect(notice.textContent).toMatch(/Still confirming/));
      expect(notice.textContent).not.toMatch(/confirmed subscription|Payment confirmed/);
      expect(screen.getByTestId("billing-plan").textContent).toContain("Free");
    } finally {
      vi.useRealTimers();
    }
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
    expect(screen.getByTestId("plan-card-FREE").getAttribute("data-current")).toBe(
      "true",
    );
  });

  it("shows the confirmed plan once the server reports it", async () => {
    searchParams.value = new URLSearchParams("checkout=success");
    fetchBillingStatus.mockResolvedValue(billingStatus());
    refreshBillingStatus.mockResolvedValue(
      paid({
        plan: "STARTER",
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
    await waitFor(() =>
      expect(
        screen.getByTestId("plan-card-STARTER").getAttribute("data-current"),
      ).toBe("true"),
    );
    // Confirmation is stated only because the persisted plan now says so.
    expect(screen.getByTestId("checkout-success-notice").textContent).toMatch(
      /Payment confirmed/,
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
      paid({
        plan: "PRO",
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

    await userEvent.click(await screen.findByTestId("plan-action-STARTER"));
    expect((await screen.findByTestId("billing-action-error")).textContent).toMatch(
      /scheduled to cancel/,
    );
  });

  it("explains a failed portal session instead of leaving the page silent", async () => {
    fetchBillingStatus.mockResolvedValue(
      paid({
        plan: "STARTER",
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
    const { ApiError } = await import("../../../lib/api/client");
    openBillingPortal.mockRejectedValue(
      new ApiError(503, "Billing management is unavailable.", "BILLING_PORTAL_UNAVAILABLE"),
    );
    render(<BillingPage />);

    await userEvent.click(await screen.findByTestId("manage-billing"));
    expect((await screen.findByTestId("billing-action-error")).textContent).toMatch(
      /unavailable/,
    );
    // And the entry point comes back rather than staying stuck on "Opening…".
    expect(
      (screen.getByTestId("manage-billing") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("still compares plans when billing is not configured, but offers no purchase path", async () => {
    // The comparison is information; the buttons are the transaction. A deployment with no biller
    // shows the former and none of the latter.
    fetchBillingStatus.mockResolvedValue(
      billingStatus({ billingEnabled: false, canStartCheckout: false }),
    );
    render(<BillingPage />);

    expect(await screen.findByTestId("billing-unavailable")).toBeTruthy();
    expect(screen.getByTestId("billing-catalog")).toBeTruthy();
    expect(priceOf("PRO")).toContain("$29");
    expect(screen.queryByTestId("plan-action-STARTER")).toBeNull();
    expect(screen.queryByTestId("plan-action-PRO")).toBeNull();
  });

  it("keeps the page usable when the status request fails", async () => {
    fetchBillingStatus.mockRejectedValue(new Error("network"));
    render(<BillingPage />);

    expect(await screen.findByTestId("billing-error")).toBeTruthy();
    // The title stays, so the page never renders as a bare error string.
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Plan and billing",
    );
  });
});
