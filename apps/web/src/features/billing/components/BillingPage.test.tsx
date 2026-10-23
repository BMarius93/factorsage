import type {
  BillingStatusResponse,
  BillingSubscriptionView,
  EntitlementLimit,
  PaidPlan,
} from "@intrinsic/contracts";
import {
  BILLING_CATALOG,
  BILLING_CATALOG_ENTRIES,
  PLAN_ENTITLEMENTS,
} from "@intrinsic/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PLAN_CARD_ORDER,
  PLAN_TAGLINE,
  UNLIMITED_MONITORS_FOOTNOTE,
  formatUsd,
  planFeatures,
  plansCaption,
} from "../utils/plan-presentation";
import { BillingPage } from "./BillingPage";

/**
 * What the billing page renders, and — more importantly — what it refuses to render.
 *
 * The rules worth a unit test are the presentation ones the server cannot enforce for us: that
 * there are four plans, cheapest first, rather than one row per price; that each card's button
 * sends the logical price key of the very price the card shows; that the plan shown is the
 * server's plan, including for a subscriber still billed on a retired yearly price; that returning
 * from Checkout with a success parameter grants nothing; and that a pending downgrade reads as
 * *pending* rather than as done.
 *
 * The catalog sells monthly prices only, so there is no cadence toggle to drive.
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

/** A live subscription mirror on `plan`'s monthly price, with whatever the test needs changed. */
function subscriptionOf(
  plan: PaidPlan,
  overrides: Partial<BillingSubscriptionView> = {},
): BillingSubscriptionView {
  return {
    plan,
    interval: "MONTH",
    status: "ACTIVE",
    currentPeriodEnd: "2026-10-12T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    cancelAt: null,
    pendingChange: null,
    ...overrides,
  };
}

const priceOf = (plan: string) =>
  screen.getByTestId(`plan-price-${plan}`).textContent ?? "";

/** What a card's price line reads for a catalog amount: `$49/ month`. */
const monthly = (minorUnits: number) => `${formatUsd(minorUnits)}/ month`;

/** A matrix number as a card prints it: `1000` -> `1,000`, unbounded -> `Unlimited`. */
const quoted = (limit: EntitlementLimit) =>
  limit === null ? "Unlimited" : limit.toLocaleString("en-US");

describe("BillingPage", () => {
  beforeEach(() => {
    searchParams.value = new URLSearchParams();
    vi.stubGlobal("location", { assign: vi.fn() } as unknown as Location);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders exactly four plan cards — Free, Starter, Pro and Pro+, cheapest first", async () => {
    fetchBillingStatus.mockResolvedValue(billingStatus());
    render(<BillingPage />);

    const catalog = await screen.findByTestId("billing-catalog");
    // Direct children only: each card holds its own list of features.
    expect(
      Array.from(catalog.children, (card) => card.getAttribute("data-testid")),
    ).toEqual([
      "plan-card-FREE",
      "plan-card-STARTER",
      "plan-card-PRO",
      "plan-card-PRO_PLUS",
    ]);
    expect(
      within(catalog)
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(["Free", "Starter", "Pro", "Pro+"]);
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

  it("prices every paid plan per month from the catalog, with no cadence to choose", async () => {
    fetchBillingStatus.mockResolvedValue(billingStatus());
    render(<BillingPage />);
    const catalog = await screen.findByTestId("billing-catalog");

    for (const entry of BILLING_CATALOG_ENTRIES) {
      expect(priceOf(entry.plan)).toBe(monthly(entry.amountMinorUnits));
      expect(screen.getByTestId(`plan-price-note-${entry.plan}`).textContent).toBe(
        "Billed monthly",
      );
    }
    expect(priceOf("FREE")).toBe("$0/ month");
    // The amounts the decision document fixes, stated once: $19, $49 and $199 a month.
    expect([priceOf("STARTER"), priceOf("PRO"), priceOf("PRO_PLUS")]).toEqual([
      "$19/ month",
      "$49/ month",
      "$199/ month",
    ]);

    // One cadence is sold, so there is nothing to toggle and no yearly line to show.
    expect(screen.queryByTestId("billing-interval-toggle")).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "Billing interval" })).toBeNull();
    for (const plan of PLAN_CARD_ORDER) {
      expect(screen.queryByTestId(`plan-price-equivalent-${plan}`)).toBeNull();
    }
    expect(catalog.textContent).not.toMatch(/\/ year|annual|Yearly|≈/);
  });

  it("sends the logical price key of the very price each card shows", async () => {
    // The bug this guards: a card quoting one price while its request carries another.
    fetchBillingStatus.mockResolvedValue(billingStatus());
    startCheckout.mockResolvedValue({ checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test" });
    render(<BillingPage />);
    await screen.findByTestId("billing-catalog");

    for (const entry of BILLING_CATALOG_ENTRIES) {
      expect(
        screen.getByTestId(`plan-action-${entry.plan}`).getAttribute("data-price-key"),
      ).toBe(entry.key);
    }

    await userEvent.click(screen.getByTestId("plan-action-PRO_PLUS"));
    expect(startCheckout).toHaveBeenCalledWith("PRO_PLUS_MONTHLY");
    await waitFor(() =>
      expect(window.location.assign).toHaveBeenCalledWith(
        "https://checkout.stripe.com/c/pay/cs_test",
      ),
    );
  });

  it("emphasizes Pro as the best value, with one badge and the card's frame", async () => {
    fetchBillingStatus.mockResolvedValue(billingStatus());
    render(<BillingPage />);
    await screen.findByTestId("billing-catalog");

    const badges = screen.getAllByTestId("plan-recommended-badge");
    expect(badges).toHaveLength(1);
    expect(badges[0]?.textContent).toBe("Best Value");
    expect(
      within(screen.getByTestId("plan-card-PRO")).getByTestId("plan-recommended-badge"),
    ).toBe(badges[0]);
    for (const plan of PLAN_CARD_ORDER) {
      expect(
        screen.getByTestId(`plan-card-${plan}`).getAttribute("data-emphasis"),
        plan,
      ).toBe(plan === "PRO" ? "recommended" : null);
    }
  });

  it("steps the badge aside for a Pro subscriber, keeping the card's emphasis", async () => {
    // "Best Value" would compete with "Current plan" on the same card; the frame stays.
    fetchBillingStatus.mockResolvedValue(
      paid({ plan: "PRO", subscription: subscriptionOf("PRO") }),
    );
    render(<BillingPage />);

    const pro = await screen.findByTestId("plan-card-PRO");
    expect(screen.queryByTestId("plan-recommended-badge")).toBeNull();
    expect(pro.getAttribute("data-emphasis")).toBe("recommended");
    expect(within(pro).getByTestId("plan-current-badge").textContent).toBe("Current plan");
  });

  it("names Pro+ the advanced tier and says how many of its backtests run at once", async () => {
    fetchBillingStatus.mockResolvedValue(billingStatus());
    render(<BillingPage />);
    await screen.findByTestId("billing-catalog");

    for (const plan of PLAN_CARD_ORDER) {
      expect(screen.getByTestId(`plan-tagline-${plan}`).textContent).toBe(
        PLAN_TAGLINE[plan],
      );
    }
    expect(screen.getByTestId("plan-tagline-PRO_PLUS").textContent).toBe("Advanced Research");

    const parallel = screen.getByTestId("plan-feature-PRO_PLUS-backtest-concurrency");
    expect(parallel.textContent).toContain("Parallel Backtests: 2 at a time");
    expect(parallel.textContent).toContain("fair queue");
    for (const plan of ["FREE", "STARTER", "PRO"] as const) {
      expect(
        screen.getByTestId(`plan-feature-${plan}-backtest-concurrency`).textContent,
      ).toBe(`${quoted(PLAN_ENTITLEMENTS[plan].backtests.maxConcurrentRuns)} backtest at a time`);
    }
  });

  it("states premium content on every card, from the entitlement matrix", async () => {
    fetchBillingStatus.mockResolvedValue(billingStatus());
    render(<BillingPage />);
    await screen.findByTestId("billing-catalog");

    for (const plan of PLAN_CARD_ORDER) {
      const { builtInContent, backtests } = PLAN_ENTITLEMENTS[plan];
      const row = screen.getByTestId(`plan-feature-${plan}-premium-content`);
      expect(row.textContent).toContain("Premium lists, strategies and point-in-time universes");
      if (!builtInContent.canUsePremium) {
        // Marked in words and by a different mark, never just greyed out or left off the card.
        expect(row.getAttribute("data-included")).toBe("false");
        expect(row.textContent).toContain("Not included");
        expect(row.querySelector("path")?.getAttribute("d")).toBe("M4 8h8");
      } else {
        expect(row.getAttribute("data-included")).toBe("true");
        expect(row.textContent).toContain("S&P 500 Historical PIT backtests");
        expect(row.textContent).toContain(
          `up to ${quoted(backtests.maxIndexUniverseConstituents)} index members at once`,
        );
        expect(row.textContent).not.toContain("Not included");
      }
    }
    // Free and Starter go without it; Pro and Pro+ include it.
    expect(
      PLAN_CARD_ORDER.map((plan) =>
        screen
          .getByTestId(`plan-feature-${plan}-premium-content`)
          .getAttribute("data-included"),
      ),
    ).toEqual(["false", "false", "true", "true"]);
    const caption = screen.getByTestId("plans-caption").textContent;
    expect(caption).toBe(plansCaption());
    expect(caption).not.toMatch(/Plans differ by capacity\.$/);
  });

  it("lists each plan's capacities as checked rows quoting the entitlement matrix", async () => {
    fetchBillingStatus.mockResolvedValue(billingStatus());
    render(<BillingPage />);
    await screen.findByTestId("billing-catalog");

    for (const plan of PLAN_CARD_ORDER) {
      const features = screen.getByTestId(`plan-features-${plan}`);
      const rows = within(features).getAllByRole("listitem");
      // The same rows in the same order on every card, so the cards compare line by line.
      expect(rows.map((row) => row.getAttribute("data-testid"))).toEqual(
        planFeatures(plan).map((feature) => `plan-feature-${plan}-${feature.id}`),
      );

      // The number on the card is the number in the matrix, not a copy of it.
      const { lists, monitors } = PLAN_ENTITLEMENTS[plan];
      expect(features.textContent).toContain(`${quoted(lists.maxSymbols)} stocks per list`);
      expect(features.textContent).toContain(`${quoted(monitors.maxActive)} active monitor`);

      // One decorative mark per row, hidden from assistive technology so a ten-item list is
      // read as ten items rather than twenty.
      for (const row of rows) {
        const check = row.querySelector("svg");
        expect(check).not.toBeNull();
        expect(check?.getAttribute("aria-hidden")).toBe("true");
      }
    }
    // And the dot-styled bullets are gone.
    expect(document.querySelectorAll("li")[0]?.textContent).not.toContain("•");
  });

  it("explains the unlimited-monitor asterisk in a footnote under the cards", async () => {
    fetchBillingStatus.mockResolvedValue(billingStatus());
    render(<BillingPage />);
    const catalog = await screen.findByTestId("billing-catalog");

    const footnote = screen.getByTestId("plans-footnote");
    expect(footnote.textContent).toBe(UNLIMITED_MONITORS_FOOTNOTE);
    expect(
      catalog.compareDocumentPosition(footnote) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    for (const plan of PLAN_CARD_ORDER) {
      const row = screen.getByTestId(`plan-feature-${plan}-monitors`);
      if (PLAN_ENTITLEMENTS[plan].monitors.maxActive === null) {
        expect(row.textContent).toContain("Unlimited active monitors*");
        expect(row.textContent).toContain("*No plan cap. Fair use applies.");
      } else {
        expect(row.textContent).not.toContain("*");
      }
    }
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
    expect(screen.getByTestId("plan-action-PRO_PLUS").textContent).toBe(
      "Upgrade to Pro+",
    );
    expect(screen.queryByTestId("manage-billing")).toBeNull();
  });

  it("names the plan the server reports beside the page title", async () => {
    fetchBillingStatus.mockResolvedValue(billingStatus({ plan: "STARTER" }));
    render(<BillingPage />);

    expect((await screen.findByTestId("billing-plan")).textContent).toContain(
      "Starter",
    );
  });

  it("names Pro+ by its product name, never by its enum", async () => {
    fetchBillingStatus.mockResolvedValue(billingStatus({ plan: "PRO_PLUS" }));
    render(<BillingPage />);

    expect((await screen.findByTestId("billing-plan")).textContent).toBe("Pro+");
    expect(screen.getByTestId("plan-card-PRO_PLUS").getAttribute("data-current")).toBe(
      "true",
    );
  });

  it("shows a legacy yearly subscriber today's monthly prices, still marking their plan current", async () => {
    // The catalog no longer sells a yearly price. A subscriber still billed on one keeps their
    // plan — `billing.plan` is what marks the card — and is shown the cards at today's monthly
    // prices, rather than a page that throws trying to quote the price they pay.
    fetchBillingStatus.mockResolvedValue(
      paid({
        plan: "PRO",
        subscription: subscriptionOf("PRO", {
          interval: "YEAR",
          currentPeriodEnd: "2027-03-14T00:00:00.000Z",
        }),
      }),
    );
    render(<BillingPage />);
    const catalog = await screen.findByTestId("billing-catalog");

    expect(catalog.childElementCount).toBe(PLAN_CARD_ORDER.length);
    expect(screen.queryByTestId("billing-interval-toggle")).toBeNull();
    expect(priceOf("PRO")).toBe(monthly(BILLING_CATALOG.PRO_MONTHLY.amountMinorUnits));

    expect(screen.getByTestId("plan-card-PRO").getAttribute("data-current")).toBe("true");
    const current = screen.getByTestId("plan-action-PRO") as HTMLButtonElement;
    expect(current.textContent).toBe("Current plan");
    expect(current.disabled).toBe(true);
    // No card offers a change from the retired price — there is no catalog price to classify the
    // move from, and the API refuses one — and nothing reads as an unpaid subscription.
    expect(document.querySelectorAll('[data-action="CHANGE"]')).toHaveLength(0);
    expect(screen.queryByText("Waiting for payment confirmation")).toBeNull();
    // What they are billed for is still stated as it is.
    expect(screen.getByTestId("billing-interval").textContent).toBe("Yearly");
    expect(screen.queryByTestId("billing-price-unrecognised")).toBeNull();
  });

  it("shows a subscriber their interval, renewal date and management entry", async () => {
    fetchBillingStatus.mockResolvedValue(
      paid({ plan: "PRO", subscription: subscriptionOf("PRO") }),
    );
    render(<BillingPage />);

    expect((await screen.findByTestId("billing-plan")).textContent).toContain("Pro");
    expect(screen.getByTestId("billing-interval").textContent).toBe("Monthly");
    expect(screen.getByTestId("billing-period-end")).toBeTruthy();
    expect(screen.getByTestId("manage-billing")).toBeTruthy();
  });

  it("labels an upgrade as immediate and a downgrade as at renewal", async () => {
    fetchBillingStatus.mockResolvedValue(
      paid({ plan: "PRO", subscription: subscriptionOf("PRO") }),
    );
    render(<BillingPage />);
    await screen.findByTestId("billing-catalog");

    // Same classifier the server uses, so the promise the label makes is the one the API keeps.
    expect(screen.getByTestId("plan-action-PRO_PLUS").textContent).toBe("Upgrade to Pro+");
    expect(screen.getByTestId("plan-hint-PRO_PLUS").textContent).toBe(
      "Takes effect immediately",
    );
    expect(screen.getByTestId("plan-action-STARTER").textContent).toBe("Switch to Starter");
    expect(screen.getByTestId("plan-hint-STARTER").textContent).toBe(
      "Takes effect at your next renewal",
    );
    expect(screen.getByTestId("plan-action-FREE").textContent).toBe(
      "Cancel subscription",
    );
    expect(screen.getByTestId("plan-hint-FREE").textContent).toBe(
      "Takes effect at your next renewal",
    );
  });

  it("renders the CTA matrix for a Free, Starter, Pro and Pro+ user (BILLING-CTA)", async () => {
    const renewal = "Takes effect at your next renewal";
    const immediate = "Takes effect immediately";
    const cases = [
      {
        billing: billingStatus(),
        expected: {
          FREE: ["Current plan", true, ""],
          STARTER: ["Upgrade to Starter", false, ""],
          PRO: ["Upgrade to Pro", false, ""],
          PRO_PLUS: ["Upgrade to Pro+", false, ""],
        },
      },
      {
        billing: paid({ plan: "STARTER", subscription: subscriptionOf("STARTER") }),
        expected: {
          FREE: ["Cancel subscription", false, renewal],
          STARTER: ["Current plan", true, ""],
          PRO: ["Upgrade to Pro", false, immediate],
          PRO_PLUS: ["Upgrade to Pro+", false, immediate],
        },
      },
      {
        // The regression: this card used to read "Upgrade to Starter" / "Downgrade to Starter".
        billing: paid({ plan: "PRO", subscription: subscriptionOf("PRO") }),
        expected: {
          FREE: ["Cancel subscription", false, renewal],
          STARTER: ["Switch to Starter", false, renewal],
          PRO: ["Current plan", true, ""],
          PRO_PLUS: ["Upgrade to Pro+", false, immediate],
        },
      },
      {
        billing: paid({ plan: "PRO_PLUS", subscription: subscriptionOf("PRO_PLUS") }),
        expected: {
          FREE: ["Cancel subscription", false, renewal],
          STARTER: ["Switch to Starter", false, renewal],
          PRO: ["Switch to Pro", false, renewal],
          PRO_PLUS: ["Current plan", true, ""],
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

      for (const plan of PLAN_CARD_ORDER) {
        expect(read(plan), `${billing.plan} user, ${plan} card`).toEqual(expected[plan]);
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
    expect(screen.getByTestId("plan-action-PRO_PLUS").textContent).toBe(
      "Upgrade to Pro+",
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
    // The ended subscription was yearly, a cadence no longer sold: a returning buyer is quoted, and
    // buys, today's monthly price.
    expect(priceOf("PRO")).toBe(monthly(BILLING_CATALOG.PRO_MONTHLY.amountMinorUnits));
    expect(pro.getAttribute("data-price-key")).toBe("PRO_MONTHLY");
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
    expect(priceOf("PRO")).toBe(monthly(BILLING_CATALOG.PRO_MONTHLY.amountMinorUnits));
    expect(priceOf("PRO_PLUS")).toBe(
      monthly(BILLING_CATALOG.PRO_PLUS_MONTHLY.amountMinorUnits),
    );
    expect(screen.queryByTestId("plan-action-STARTER")).toBeNull();
    expect(screen.queryByTestId("plan-action-PRO")).toBeNull();
    expect(screen.queryByTestId("plan-action-PRO_PLUS")).toBeNull();
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
