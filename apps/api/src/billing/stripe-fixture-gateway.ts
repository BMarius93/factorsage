/**
 * The Stripe **test-mode fixture** boundary, as types.
 *
 * `StripeGateway` (`stripe-gateway.ts`) is everything the product asks of Stripe. This is the
 * separate, much smaller set of things the billing QA persona tooling asks of it in order to
 * *construct* real subscription lifecycles: Test Clocks, a customer on one, a named Stripe test
 * payment method, a subscription on a configured catalog price, a cancellation at period end.
 * It is a different interface on purpose — none of these operations may ever be reachable from a
 * request, a webhook or the reconciler, and the product's gateway stays exactly as wide as the
 * product needs.
 *
 * What it deliberately cannot do is as important as what it can:
 *
 * - **No product or price operation of any kind.** The shared four-price catalog is read by
 *   `StripeGateway.describePrices` and written by nobody.
 * - **One delete: a Test Clock.** Stripe removes a clock's customers and their subscriptions with
 *   it, so there is no "delete customer" or "cancel subscription now" to aim at an object this
 *   tooling did not create.
 * - **No card data.** A payment method is one of two named Stripe test tokens, chosen by behaviour.
 * - **No live mode.** The implementation refuses to be constructed from anything but a test-mode
 *   key ({@link assertStripeTestModeKey}) and refuses any object Stripe reports as `livemode`.
 *
 * As with `StripeGateway`, no Stripe SDK type crosses this file. The implementation is
 * `StripeTestModeFixtureGateway` in `stripe.gateway.ts`, which remains the only file in the
 * repository that imports `stripe`; the deterministic suites use
 * `FakeStripeFixtureGateway` (`stripe-fixture-gateway.test-helper.ts`).
 */

/** A Stripe Test Clock. `status` is Stripe's raw string: `ready`, `advancing`, `internal_failure`. */
export type StripeFixtureClock = {
  readonly id: string;
  /** Test Clocks carry no metadata; the name is the only thing that can identify one. */
  readonly name: string | null;
  readonly status: string;
  readonly frozenTime: Date;
  /** When Stripe will delete the clock, and everything on it, by itself. */
  readonly deletesAfter: Date | null;
  readonly livemode: boolean;
};

export type StripeFixtureCustomer = {
  readonly id: string;
  readonly email: string | null;
  readonly metadata: Readonly<Record<string, string>>;
  readonly testClockId: string | null;
  readonly livemode: boolean;
};

export type StripeFixtureSubscription = {
  readonly id: string;
  readonly customerId: string;
  /** Stripe's raw status string. */
  readonly status: string;
  /** The price being billed now. */
  readonly priceId: string | null;
  readonly metadata: Readonly<Record<string, string>>;
  /**
   * Stripe's **raw** `cancel_at_period_end`, not FactorSage's mapped flag.
   *
   * Kept raw so the tooling can report which of Stripe's two representations of a scheduled
   * cancellation it actually got back; whether one *is* scheduled is always asked through
   * `hasScheduledCancellation`, the same function the product's gateway maps through.
   */
  readonly cancelAtPeriodEnd: boolean;
  readonly cancelAt: Date | null;
  readonly canceledAt: Date | null;
  readonly currentPeriodStart: Date | null;
  readonly currentPeriodEnd: Date | null;
  readonly livemode: boolean;
};

/**
 * How a fixture's payment method behaves. Each is one of Stripe's documented test tokens; no card
 * number, expiry or CVC exists anywhere in this repository.
 */
export const STRIPE_FIXTURE_PAYMENT_BEHAVIORS = [
  /** Attaches and pays. */
  "SUCCEEDS",
  /** Attaches, then fails every charge — what makes a renewal go `past_due`. */
  "FAILS_ON_CHARGE",
] as const;

export type StripeFixturePaymentBehavior =
  (typeof STRIPE_FIXTURE_PAYMENT_BEHAVIORS)[number];

export interface StripeFixtureGateway {
  /** Every Test Clock in the account, whoever created it. */
  listTestClocks(): Promise<readonly StripeFixtureClock[]>;

  /** One clock, or `null` when Stripe no longer has it. */
  retrieveTestClock(clockId: string): Promise<StripeFixtureClock | null>;

  createTestClock(input: {
    readonly name: string;
    readonly frozenTime: Date;
    readonly idempotencyKey: string;
  }): Promise<StripeFixtureClock>;

  /**
   * **Starts** advancing a clock. Advancement is asynchronous: the returned clock is normally
   * still `advancing`, and nothing about its customers may be assumed until a later
   * {@link retrieveTestClock} reports `ready`.
   */
  advanceTestClock(input: {
    readonly clockId: string;
    readonly frozenTime: Date;
    readonly idempotencyKey: string;
  }): Promise<StripeFixtureClock>;

  /**
   * Deletes a clock, and with it every customer and subscription attached to it.
   *
   * The only destructive operation on this interface. A clock that is already gone is success.
   */
  deleteTestClock(clockId: string): Promise<void>;

  listTestClockCustomers(
    clockId: string,
  ): Promise<readonly StripeFixtureCustomer[]>;

  /** One customer, or `null` when Stripe no longer has it or reports it deleted. */
  retrieveCustomer(customerId: string): Promise<StripeFixtureCustomer | null>;

  createTestClockCustomer(input: {
    readonly clockId: string;
    readonly email: string;
    readonly name: string;
    readonly metadata: Readonly<Record<string, string>>;
    readonly idempotencyKey: string;
  }): Promise<StripeFixtureCustomer>;

  /** Attaches one of Stripe's named test payment methods to a customer, and tags it. */
  attachTestPaymentMethod(input: {
    readonly customerId: string;
    readonly behavior: StripeFixturePaymentBehavior;
    readonly metadata: Readonly<Record<string, string>>;
    readonly idempotencyKey: string;
  }): Promise<{ readonly id: string }>;

  /** Every subscription of one customer, in any status. */
  listSubscriptions(
    customerId: string,
  ): Promise<readonly StripeFixtureSubscription[]>;

  /**
   * A subscription on one of the **configured catalog prices**, paid from the given payment method.
   *
   * Refuses any other price id, and fails rather than leaving an `incomplete` subscription behind
   * when the first payment does not succeed.
   */
  createSubscription(input: {
    readonly customerId: string;
    readonly priceId: string;
    readonly paymentMethodId: string;
    readonly metadata: Readonly<Record<string, string>>;
    readonly idempotencyKey: string;
  }): Promise<StripeFixtureSubscription>;

  setSubscriptionPaymentMethod(input: {
    readonly subscriptionId: string;
    readonly paymentMethodId: string;
  }): Promise<StripeFixtureSubscription>;

  /**
   * Schedules a cancellation for the end of the current paid period — the same request Customer
   * Portal makes — and returns the subscription as Stripe then represents it.
   */
  scheduleCancellationAtPeriodEnd(
    subscriptionId: string,
  ): Promise<StripeFixtureSubscription>;
}

/** Thrown when a fixture operation is refused before, or failed at, Stripe. */
export class StripeFixtureError extends Error {
  override readonly name = "StripeFixtureError";
}

/**
 * Refuses anything that is not a Stripe **test-mode** secret.
 *
 * Stated positively — the key must *be* a test key — rather than as "not a live key", so a value
 * of an unknown shape is refused too. `testMode` is the flag `getStripeBillingConfig` derived; it
 * is checked as well as the prefix so neither can be wrong alone.
 *
 * The message never contains the key.
 */
export function assertStripeTestModeKey(config: {
  readonly secretKey: string;
  readonly testMode: boolean;
}): void {
  const isTestKey =
    config.secretKey.startsWith("sk_test_") ||
    config.secretKey.startsWith("rk_test_");
  if (!config.testMode || !isTestKey) {
    throw new StripeFixtureError(
      "Refusing to create or change Stripe fixtures: the configured Stripe key is not a " +
        "test-mode key (sk_test_/rk_test_). Billing QA fixtures exist only in a Stripe sandbox.",
    );
  }
}

/** Anything shaped like a Stripe credential, so an error message can be shown to an operator. */
const STRIPE_CREDENTIAL_PATTERN = /\b(sk|rk|pk|whsec)_[A-Za-z0-9_*]+/g;

export function redactStripeCredentials(message: string): string {
  return message.replace(STRIPE_CREDENTIAL_PATTERN, "$1_<redacted>");
}
