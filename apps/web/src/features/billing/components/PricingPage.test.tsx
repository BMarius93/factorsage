import type {
  BillingStatusResponse,
  BillingSubscriptionView,
  EntitlementLimit,
} from "@intrinsic/contracts";
import {
  BILLING_CATALOG,
  BILLING_CATALOG_ENTRIES,
  PAID_PLANS,
  PLAN_ENTITLEMENTS,
} from "@intrinsic/contracts";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  guestSession,
  resolvingSession,
  signedInSession,
} from "../../auth/__testing__/auth-session";
import { useAuthSession } from "../../auth/hooks/use-auth-session";
import { SIGN_IN_TO_CHOOSE_PLAN } from "../../auth/utils/sign-in-prompts";
import {
  PLAN_CARD_ORDER,
  UNLIMITED_MONITORS_FOOTNOTE,
  plansCaption,
} from "../utils/plan-presentation";
import { BillingPage } from "./BillingPage";
import { PricingPage } from "./PricingPage";

/**
 * The public price list (PRICING-001).
 *
 * The properties worth proving here are the ones DEC-001 sets: a Guest sees the real catalog and is
 * asked for an account in place — never sent to Checkout, never made to call a billing endpoint —
 * with sign-in links that come back to `/pricing`; a signed-in viewer gets exactly `/billing`'s
 * behaviour; and the two pages cannot show different prices or limits. Every expected amount and
 * capacity below is read out of `BILLING_CATALOG` / `PLAN_ENTITLEMENTS`, never restated.
 *
 * The catalog sells monthly prices only, so neither page offers a cadence to choose.
 */

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("../../auth/hooks/use-auth-session", () => ({
  useAuthSession: vi.fn(),
}));

const useAuthSessionMock = vi.mocked(useAuthSession);

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

const BILLING_API = [
  fetchBillingStatus,
  refreshBillingStatus,
  startCheckout,
  openBillingPortal,
  changeBillingPlan,
];

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

function subscription(
  overrides: Partial<BillingSubscriptionView> = {},
): BillingSubscriptionView {
  return {
    status: "ACTIVE",
    plan: "STARTER",
    interval: "MONTH",
    currentPeriodEnd: "2026-10-18T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    cancelAt: null,
    pendingChange: null,
    ...overrides,
  };
}

const card = (plan: string) => screen.getByTestId(`plan-card-${plan}`);
const action = (plan: string) => screen.getByTestId(`plan-action-${plan}`);
const usd = (minorUnits: number) => `$${minorUnits / 100}`;
/** A matrix number as a card prints it: `1000` -> `1,000`, unbounded -> `Unlimited`. */
const quoted = (limit: EntitlementLimit) =>
  limit === null ? "Unlimited" : limit.toLocaleString("en-US");

describe("PricingPage", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/pricing");
    useAuthSessionMock.mockReturnValue(guestSession());
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  describe("for a Guest", () => {
    it("shows the four plans with prices and capacities from the canonical catalog", () => {
      render(<PricingPage />);

      expect(
        screen.getByRole("heading", { level: 1, name: "Pricing" }),
      ).toBeTruthy();
      const catalog = screen.getByTestId("billing-catalog");
      expect(
        Array.from(catalog.children, (child) =>
          child.getAttribute("data-testid"),
        ),
      ).toEqual(PLAN_CARD_ORDER.map((plan) => `plan-card-${plan}`));
      expect(PLAN_CARD_ORDER).toEqual(["FREE", "STARTER", "PRO", "PRO_PLUS"]);

      for (const plan of PAID_PLANS) {
        expect(screen.getByTestId(`plan-price-${plan}`).textContent).toBe(
          `${usd(BILLING_CATALOG[`${plan}_MONTHLY`].amountMinorUnits)}/ month`,
        );
      }
      expect(screen.getByTestId("plan-price-FREE").textContent).toBe(
        "$0/ month",
      );

      for (const plan of PLAN_CARD_ORDER) {
        const features =
          screen.getByTestId(`plan-features-${plan}`).textContent ?? "";
        const limits = PLAN_ENTITLEMENTS[plan];
        expect(features).toContain(
          `${quoted(limits.lists.maxSymbols)} stocks per list`,
        );
        expect(features).toContain(
          `Backtests up to ${quoted(limits.backtests.maxHistoricalYears)} years long`,
        );
        expect(features).toContain(
          `${quoted(limits.backtests.maxSymbols)} stocks per backtest`,
        );
        expect(features).toContain(
          `${quoted(limits.monitors.maxActive)} active monitor`,
        );
      }
    });

    it("offers no cadence to choose, because the catalog sells monthly prices only", () => {
      render(<PricingPage />);

      expect(screen.queryByTestId("billing-interval-toggle")).toBeNull();
      expect(screen.queryByRole("radio", { name: "Yearly" })).toBeNull();
      for (const plan of PAID_PLANS) {
        expect(screen.getByTestId(`plan-price-note-${plan}`).textContent).toBe(
          "Billed monthly",
        );
        expect(
          screen.queryByTestId(`plan-price-equivalent-${plan}`),
        ).toBeNull();
      }
      expect(screen.getByTestId("billing-catalog").textContent).not.toMatch(
        /\/ year|annual/i,
      );
    });

    it("recommends Pro as the best value and names Pro+ the advanced tier", () => {
      render(<PricingPage />);

      expect(card("PRO").getAttribute("data-emphasis")).toBe("recommended");
      expect(screen.getAllByTestId("plan-recommended-badge")).toHaveLength(1);
      expect(
        within(card("PRO")).getByTestId("plan-recommended-badge").textContent,
      ).toBe("Best Value");

      expect(screen.getByTestId("plan-tagline-PRO_PLUS").textContent).toBe(
        "Advanced Research",
      );
      expect(
        screen.getByTestId("plan-feature-PRO_PLUS-backtest-concurrency")
          .textContent,
      ).toContain("Parallel Backtests: 2 at a time");
      expect(action("PRO_PLUS").textContent).toBe("Choose Pro+");
      expect(screen.getByTestId("plans-footnote").textContent).toBe(
        UNLIMITED_MONITORS_FOOTNOTE,
      );
    });

    it("tells a visitor which plans include premium content", () => {
      render(<PricingPage />);

      expect(screen.getByTestId("plans-caption").textContent).toBe(
        plansCaption(),
      );
      for (const plan of PLAN_CARD_ORDER) {
        const row = screen.getByTestId(`plan-feature-${plan}-premium-content`);
        expect(row.textContent).toContain(
          PLAN_ENTITLEMENTS[plan].builtInContent.canUsePremium
            ? "S&P 500 Historical PIT backtests"
            : "Not included",
        );
      }
    });

    it("never advertises priority, speed or a guaranteed run time", () => {
      const { container } = render(<PricingPage />);

      // Every plan shares one fair queue: a plan changes how many runs go at once, never how fast.
      expect(container.textContent).not.toMatch(
        /\b(priority|faster|guaranteed)\b/i,
      );
    });

    it("explains billing in monthly terms, with the fair queue and a non-destructive downgrade", () => {
      render(<PricingPage />);

      const facts =
        screen.getByTestId("pricing-billing-facts").textContent ?? "";
      expect(facts).not.toMatch(/annual|yearly/i);
      expect(facts).toContain("renews automatically every month");
      expect(facts).toContain("one fair queue");
      expect(facts).toContain(
        "Lists larger than the new plan allows stay saved",
      );
    });

    it("calls no billing endpoint at all", async () => {
      render(<PricingPage />);
      await userEvent.click(action("PRO_PLUS"));

      for (const call of BILLING_API) {
        expect(call).not.toHaveBeenCalled();
      }
    });

    it("opens the sign-in prompt from every plan, and never starts Checkout", async () => {
      render(<PricingPage />);

      for (const plan of PLAN_CARD_ORDER) {
        const button = action(plan);
        expect(button.tagName).toBe("BUTTON");
        expect(button.getAttribute("data-action")).toBe("SIGN_IN");
        // A Guest button names no price: there is nothing it could send.
        expect(button.hasAttribute("data-price-key")).toBe(false);

        await userEvent.click(button);
        const prompt = await screen.findByTestId("sign-in-prompt");
        expect(
          within(prompt).getByText(SIGN_IN_TO_CHOOSE_PLAN.title),
        ).toBeTruthy();
        await userEvent.click(
          within(prompt).getByRole("button", { name: "Close dialog" }),
        );
        await waitFor(() =>
          expect(screen.queryByTestId("sign-in-prompt")).toBeNull(),
        );
      }

      expect(startCheckout).not.toHaveBeenCalled();
      expect(changeBillingPlan).not.toHaveBeenCalled();
    });

    it("sends sign-in and registration back to /pricing", async () => {
      render(<PricingPage />);
      await userEvent.click(action("PRO"));

      const prompt = await screen.findByTestId("sign-in-prompt");
      expect(
        within(prompt)
          .getByRole("link", { name: "Sign in" })
          .getAttribute("href"),
      ).toBe("/login?next=%2Fpricing");
      expect(
        within(prompt)
          .getByRole("link", { name: "Create an account" })
          .getAttribute("href"),
      ).toBe("/register?next=%2Fpricing");
    });

    it("operates a plan action from the keyboard", async () => {
      const user = userEvent.setup();
      render(<PricingPage />);

      action("STARTER").focus();
      await user.keyboard("{Enter}");

      expect(await screen.findByTestId("sign-in-prompt")).toBeTruthy();
      expect(startCheckout).not.toHaveBeenCalled();
    });

    it("never renders a Stripe identifier or an internal price key", () => {
      const { container } = render(<PricingPage />);
      const text = container.textContent ?? "";

      for (const entry of BILLING_CATALOG_ENTRIES) {
        expect(text).not.toContain(entry.key);
        expect(text).not.toContain(entry.lookupKey);
      }
      expect(text).not.toMatch(/price_|prod_|cus_|sub_|cs_test/);
    });
  });

  it("offers nothing while the session is still resolving", async () => {
    useAuthSessionMock.mockReturnValue(resolvingSession());
    render(<PricingPage />);

    for (const plan of PLAN_CARD_ORDER) {
      expect((action(plan) as HTMLButtonElement).disabled).toBe(true);
    }
    await userEvent.click(action("PRO"));
    expect(screen.queryByTestId("sign-in-prompt")).toBeNull();
    for (const call of BILLING_API) {
      expect(call).not.toHaveBeenCalled();
    }
  });

  describe("for a signed-in viewer", () => {
    beforeEach(() => {
      useAuthSessionMock.mockReturnValue(signedInSession({ plan: "FREE" }));
      vi.stubGlobal("location", {
        ...window.location,
        assign: vi.fn(),
      } as unknown as Location);
    });

    it("starts the existing Checkout for the price the card shows", async () => {
      fetchBillingStatus.mockResolvedValue(billingStatus());
      startCheckout.mockResolvedValue({
        checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_stub",
      });
      render(<PricingPage />);

      await waitFor(() =>
        expect(card("FREE").getAttribute("data-current")).toBe("true"),
      );
      expect(
        screen.getByTestId("pricing-billing-link").getAttribute("href"),
      ).toBe("/billing");
      expect(action("PRO_PLUS").textContent).toBe("Upgrade to Pro+");
      expect(action("PRO_PLUS").getAttribute("data-price-key")).toBe(
        BILLING_CATALOG.PRO_PLUS_MONTHLY.key,
      );
      await userEvent.click(action("PRO_PLUS"));

      expect(startCheckout).toHaveBeenCalledTimes(1);
      expect(startCheckout).toHaveBeenCalledWith(
        BILLING_CATALOG.PRO_PLUS_MONTHLY.key,
      );
      expect(window.location.assign).toHaveBeenCalledWith(
        "https://checkout.stripe.com/c/pay/cs_test_stub",
      );
      expect(screen.queryByTestId("sign-in-prompt")).toBeNull();
    });

    it("changes a live subscription through the existing change call, not Checkout", async () => {
      fetchBillingStatus.mockResolvedValue(
        billingStatus({
          plan: "STARTER",
          subscription: subscription(),
          canStartCheckout: false,
          canOpenPortal: true,
          canChangePlan: true,
        }),
      );
      changeBillingPlan.mockResolvedValue({});
      render(<PricingPage />);

      await waitFor(() =>
        expect(card("STARTER").getAttribute("data-current")).toBe("true"),
      );
      await userEvent.click(action("PRO"));

      expect(changeBillingPlan).toHaveBeenCalledWith("PRO_MONTHLY");
      expect(startCheckout).not.toHaveBeenCalled();
      // Re-reads authoritative state rather than assuming the change landed.
      await waitFor(() => expect(fetchBillingStatus).toHaveBeenCalledTimes(2));
    });

    it("quotes a legacy yearly subscriber today's monthly price, keeping their plan current", async () => {
      // A subscription still billed on a retired yearly price: the cards show what the catalog
      // sells now, and the plan stays current because `billing.plan` says so.
      fetchBillingStatus.mockResolvedValue(
        billingStatus({
          plan: "PRO",
          subscription: subscription({ plan: "PRO", interval: "YEAR" }),
          canStartCheckout: false,
          canOpenPortal: true,
          canChangePlan: true,
        }),
      );
      render(<PricingPage />);

      await waitFor(() =>
        expect(action("PRO").textContent).toBe("Current plan"),
      );
      expect(card("PRO").getAttribute("data-current")).toBe("true");
      expect(screen.getByTestId("plan-price-PRO").textContent).toBe(
        `${usd(BILLING_CATALOG.PRO_MONTHLY.amountMinorUnits)}/ month`,
      );
      expect(screen.queryByTestId("billing-interval-toggle")).toBeNull();
      // No change is offered from a price the catalog cannot classify.
      expect(document.querySelectorAll('[data-action="CHANGE"]')).toHaveLength(
        0,
      );
    });

    it("offers no action while the plan is loading", () => {
      fetchBillingStatus.mockReturnValue(new Promise(() => {}));
      render(<PricingPage />);

      expect(screen.getByTestId("pricing-plan-loading")).toBeTruthy();
      expect(screen.getByTestId("plan-price-PRO").textContent).toContain("$");
      for (const plan of PLAN_CARD_ORDER) {
        expect(screen.queryByTestId(`plan-action-${plan}`)).toBeNull();
      }
    });

    it("offers no action when the plan cannot be loaded, and can retry", async () => {
      fetchBillingStatus.mockRejectedValueOnce(new Error("offline"));
      fetchBillingStatus.mockResolvedValueOnce(billingStatus());
      render(<PricingPage />);

      const error = await screen.findByTestId("pricing-plan-error");
      for (const plan of PLAN_CARD_ORDER) {
        expect(screen.queryByTestId(`plan-action-${plan}`)).toBeNull();
      }

      await userEvent.click(
        within(error).getByRole("button", { name: "Try again" }),
      );
      await waitFor(() =>
        expect(action("PRO").textContent).toBe("Upgrade to Pro"),
      );
      expect(screen.queryByTestId("pricing-plan-error")).toBeNull();
    });

    it("offers no purchase where billing is not configured, and says so", async () => {
      fetchBillingStatus.mockResolvedValue(
        billingStatus({
          billingEnabled: false,
          canStartCheckout: false,
        }),
      );
      render(<PricingPage />);

      await screen.findByTestId("billing-unavailable");
      for (const plan of PAID_PLANS) {
        expect(screen.queryByTestId(`plan-action-${plan}`)).toBeNull();
      }
      expect(startCheckout).not.toHaveBeenCalled();
    });
  });

  it("shows exactly the prices, notes, limits and emphasis /billing shows", async () => {
    const read = () => ({
      caption: screen.getByTestId("plans-caption").textContent,
      footnote: screen.getByTestId("plans-footnote").textContent,
      cards: PLAN_CARD_ORDER.map((plan) => ({
        plan,
        tagline: screen.getByTestId(`plan-tagline-${plan}`).textContent,
        badge:
          within(card(plan)).queryByTestId("plan-recommended-badge")
            ?.textContent ?? null,
        emphasis: card(plan).getAttribute("data-emphasis"),
        price: screen.getByTestId(`plan-price-${plan}`).textContent,
        note: screen.getByTestId(`plan-price-note-${plan}`).textContent,
        features: screen.getByTestId(`plan-features-${plan}`).textContent,
      })),
    });

    const snapshots: Record<string, unknown> = {};
    for (const page of ["pricing", "billing"] as const) {
      fetchBillingStatus.mockResolvedValue(billingStatus());
      render(page === "pricing" ? <PricingPage /> : <BillingPage />);
      await screen.findByTestId("billing-catalog");
      snapshots[page] = read();
      cleanup();
    }

    expect(snapshots.pricing).toEqual(snapshots.billing);
  });
});
