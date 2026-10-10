import type { FakeStripeGateway } from "./stripe-gateway.test-helper";
import {
  StripeFixtureError,
  type StripeFixtureClock,
  type StripeFixtureCustomer,
  type StripeFixtureGateway,
  type StripeFixturePaymentBehavior,
  type StripeFixtureSubscription,
} from "./stripe-fixture-gateway";

/**
 * An in-memory stand-in for Stripe's test-mode fixture operations, built **on** the existing
 * `FakeStripeGateway` rather than beside it.
 *
 * That is the point of the arrangement: a subscription this fake creates lands in the same
 * `FakeStripeGateway.subscriptions` map the product's fake gateway reads, so the real
 * `BillingReconciliationService` — real lock, real transaction, real Prisma writes — reconciles
 * what the billing persona tooling built. Nothing about reconciliation is simulated here.
 *
 * What it models is the behaviour the tooling depends on, and no more:
 *
 * - Test Clocks whose advancement is **asynchronous**: a clock reports `advancing` for a number of
 *   reads before it is `ready`, and its effects land only then;
 * - what a clock crossing a period boundary does to a subscription — it ends one with a
 *   cancellation due, puts one whose payment method fails into `past_due` once the renewal invoice
 *   has had time to finalise, and otherwise renews it;
 * - that deleting a clock deletes its customers and cancels their subscriptions;
 * - every mutating call, recorded, so a test can prove a rerun made none.
 *
 * It models no money, like the fake it stands on.
 */

type FakeClock = {
  id: string;
  name: string;
  status: string;
  frozenTime: Date;
  deletesAfter: Date;
  livemode: boolean;
  /** Where an advance in progress is heading, and how many more reads report `advancing`. */
  advancingTo: Date | null;
  readsUntilReady: number;
};

type FakeFixtureCustomer = {
  id: string;
  email: string;
  metadata: Record<string, string>;
  clockId: string;
  livemode: boolean;
};

export type FakeStripeFixtureOptions = {
  /** How many `retrieveTestClock` reads report `advancing` before an advance completes. */
  readonly readsWhileAdvancing?: number;
  /**
   * How long after a period end a failed renewal turns the subscription `past_due`. Stripe
   * finalises the renewal invoice about an hour after creating it; until then the subscription
   * still reads `active`.
   */
  readonly renewalFinalizationMs?: number;
};

export class FakeStripeFixtureGateway implements StripeFixtureGateway {
  readonly clocks = new Map<string, FakeClock>();
  readonly fixtureCustomers = new Map<string, FakeFixtureCustomer>();
  readonly subscriptionMetadata = new Map<string, Record<string, string>>();
  readonly paymentMethodMetadata = new Map<string, Record<string, string>>();

  /** Every mutating call, in order. A converged rerun adds nothing to it. */
  readonly writes: { operation: string; idempotencyKey: string | null }[] = [];

  /** Makes the named operation throw once, as an interrupted run would stop. */
  failNext: string | null = null;

  readsWhileAdvancing: number;
  renewalFinalizationMs: number;

  /** Payment method id -> how it behaves, and the one each subscription charges. */
  private readonly paymentMethods = new Map<
    string,
    StripeFixturePaymentBehavior
  >();
  private readonly subscriptionPaymentMethod = new Map<string, string>();
  private sequence = 0;

  constructor(
    private readonly stripe: FakeStripeGateway,
    options: FakeStripeFixtureOptions = {},
  ) {
    this.readsWhileAdvancing = options.readsWhileAdvancing ?? 2;
    this.renewalFinalizationMs = options.renewalFinalizationMs ?? 3_600_000;
  }

  // -------------------------------------------------------------------------
  // Test-facing helpers
  // -------------------------------------------------------------------------

  /** A Test Clock somebody else created, optionally with a customer of their own on it. */
  seedForeignClock(input: {
    name: string;
    customerMetadata?: Record<string, string>;
  }): { clockId: string; customerId: string | null } {
    const clockId = `clock_${this.next()}`;
    this.clocks.set(clockId, this.newClock(clockId, input.name, new Date()));
    if (!input.customerMetadata) {
      return { clockId, customerId: null };
    }
    const customerId = this.stripe.seedCustomer("somebody-else");
    this.fixtureCustomers.set(customerId, {
      id: customerId,
      email: "somebody@example.test",
      metadata: { ...input.customerMetadata },
      clockId,
      livemode: false,
    });
    return { clockId, customerId };
  }

  /** How many of one operation were made. */
  countOf(operation: string): number {
    return this.writes.filter((write) => write.operation === operation).length;
  }

  private next(): string {
    this.sequence += 1;
    return `fixture_${this.sequence}`;
  }

  private newClock(id: string, name: string, frozenTime: Date): FakeClock {
    return {
      id,
      name,
      status: "ready",
      frozenTime,
      deletesAfter: new Date(Date.now() + 30 * 86_400_000),
      livemode: false,
      advancingTo: null,
      readsUntilReady: 0,
    };
  }

  private write(operation: string, idempotencyKey: string | null = null): void {
    if (this.failNext === operation) {
      this.failNext = null;
      throw new StripeFixtureError(
        `Stripe ${operation} failed: simulated outage`,
      );
    }
    this.writes.push({ operation, idempotencyKey });
  }

  private requireClock(clockId: string): FakeClock {
    const clock = this.clocks.get(clockId);
    if (!clock) {
      throw new StripeFixtureError(
        `Stripe testClocks failed: no such clock ${clockId}`,
      );
    }
    return clock;
  }

  private toClock(clock: FakeClock): StripeFixtureClock {
    return {
      id: clock.id,
      name: clock.name,
      status: clock.status,
      frozenTime: clock.frozenTime,
      deletesAfter: clock.deletesAfter,
      livemode: clock.livemode,
    };
  }

  private toCustomer(customer: FakeFixtureCustomer): StripeFixtureCustomer {
    return {
      id: customer.id,
      email: customer.email,
      metadata: { ...customer.metadata },
      testClockId: customer.clockId,
      livemode: customer.livemode,
    };
  }

  private toSubscription(subscriptionId: string): StripeFixtureSubscription {
    const subscription = this.stripe.subscriptions.get(subscriptionId);
    if (!subscription) {
      throw new StripeFixtureError(
        `Stripe subscriptions failed: no such subscription ${subscriptionId}`,
      );
    }
    return {
      id: subscription.id,
      customerId: subscription.customerId,
      status: subscription.status,
      priceId: subscription.currentPriceId,
      metadata: { ...(this.subscriptionMetadata.get(subscription.id) ?? {}) },
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      cancelAt: subscription.cancelAt,
      canceledAt: subscription.canceledAt,
      currentPeriodStart: subscription.currentPeriodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
      livemode: false,
    };
  }

  /** What Stripe does to a clock's subscriptions once the clock has reached `target`. */
  private applyAdvance(clock: FakeClock, target: Date): void {
    for (const customer of this.fixtureCustomers.values()) {
      if (customer.clockId !== clock.id) {
        continue;
      }
      for (const subscription of this.stripe.subscriptions.values()) {
        if (
          subscription.customerId !== customer.id ||
          (subscription.status !== "active" &&
            subscription.status !== "past_due")
        ) {
          continue;
        }
        if (subscription.cancelAt && subscription.cancelAt <= target) {
          this.stripe.endSubscription(subscription.id);
          continue;
        }
        const failing =
          this.paymentMethods.get(
            this.subscriptionPaymentMethod.get(subscription.id) ?? "",
          ) === "FAILS_ON_CHARGE";
        const boundary = subscription.currentPeriodEnd;
        if (boundary > target) {
          continue;
        }
        if (
          failing &&
          target.getTime() < boundary.getTime() + this.renewalFinalizationMs
        ) {
          // The renewal invoice exists but is still a draft: nothing has been charged yet.
          continue;
        }
        const length =
          boundary.getTime() - subscription.currentPeriodStart.getTime();
        subscription.currentPeriodStart = boundary;
        subscription.currentPeriodEnd = new Date(boundary.getTime() + length);
        if (failing) {
          subscription.status = "past_due";
        }
      }
    }
    clock.frozenTime = target;
  }

  // -------------------------------------------------------------------------
  // StripeFixtureGateway
  // -------------------------------------------------------------------------

  async listTestClocks(): Promise<readonly StripeFixtureClock[]> {
    return [...this.clocks.values()].map((clock) => this.toClock(clock));
  }

  async retrieveTestClock(clockId: string): Promise<StripeFixtureClock | null> {
    const clock = this.clocks.get(clockId);
    if (!clock) {
      return null;
    }
    if (clock.status === "advancing" && clock.advancingTo) {
      if (clock.readsUntilReady > 0) {
        clock.readsUntilReady -= 1;
      } else {
        this.applyAdvance(clock, clock.advancingTo);
        clock.advancingTo = null;
        clock.status = "ready";
      }
    }
    return this.toClock(clock);
  }

  async createTestClock(input: {
    readonly name: string;
    readonly frozenTime: Date;
    readonly idempotencyKey: string;
  }): Promise<StripeFixtureClock> {
    this.write("createTestClock", input.idempotencyKey);
    const id = `clock_${this.next()}`;
    const clock = this.newClock(id, input.name, input.frozenTime);
    this.clocks.set(id, clock);
    return this.toClock(clock);
  }

  async advanceTestClock(input: {
    readonly clockId: string;
    readonly frozenTime: Date;
    readonly idempotencyKey: string;
  }): Promise<StripeFixtureClock> {
    this.write("advanceTestClock", input.idempotencyKey);
    const clock = this.requireClock(input.clockId);
    if (clock.status !== "ready") {
      throw new StripeFixtureError(
        "Stripe testClocks.advance failed: the clock is not ready",
      );
    }
    if (input.frozenTime <= clock.frozenTime) {
      throw new StripeFixtureError(
        "Stripe testClocks.advance failed: a clock can only move forward",
      );
    }
    clock.status = "advancing";
    clock.advancingTo = input.frozenTime;
    clock.readsUntilReady = this.readsWhileAdvancing;
    return this.toClock(clock);
  }

  /**
   * As Stripe does it: the clock goes, its customers are deleted, and their subscriptions are
   * **cancelled, not erased** — Stripe goes on listing them for the deleted customer's id.
   */
  async deleteTestClock(clockId: string): Promise<void> {
    this.write("deleteTestClock");
    if (!this.clocks.delete(clockId)) {
      return;
    }
    for (const customer of [...this.fixtureCustomers.values()]) {
      if (customer.clockId !== clockId) {
        continue;
      }
      this.fixtureCustomers.delete(customer.id);
      const held = this.stripe.customers.get(customer.id);
      if (held) {
        held.deleted = true;
      }
      for (const subscription of this.stripe.subscriptions.values()) {
        if (
          subscription.customerId === customer.id &&
          subscription.status !== "canceled"
        ) {
          this.stripe.endSubscription(subscription.id);
        }
      }
    }
  }

  async listTestClockCustomers(
    clockId: string,
  ): Promise<readonly StripeFixtureCustomer[]> {
    return [...this.fixtureCustomers.values()]
      .filter((customer) => customer.clockId === clockId)
      .map((customer) => this.toCustomer(customer));
  }

  async retrieveCustomer(
    customerId: string,
  ): Promise<StripeFixtureCustomer | null> {
    const held = this.stripe.customers.get(customerId);
    if (!held || held.deleted) {
      return null;
    }
    const fixture = this.fixtureCustomers.get(customerId);
    return fixture
      ? this.toCustomer(fixture)
      : {
          id: customerId,
          email: null,
          metadata: { factorsageUserId: held.userId },
          testClockId: null,
          livemode: false,
        };
  }

  async createTestClockCustomer(input: {
    readonly clockId: string;
    readonly email: string;
    readonly name: string;
    readonly metadata: Readonly<Record<string, string>>;
    readonly idempotencyKey: string;
  }): Promise<StripeFixtureCustomer> {
    this.write("createTestClockCustomer", input.idempotencyKey);
    this.requireClock(input.clockId);
    const id = this.stripe.seedCustomer(
      input.metadata.factorsageUserId ?? "unknown",
      `cus_${this.next()}`,
    );
    const customer: FakeFixtureCustomer = {
      id,
      email: input.email,
      metadata: { ...input.metadata },
      clockId: input.clockId,
      livemode: false,
    };
    this.fixtureCustomers.set(id, customer);
    return this.toCustomer(customer);
  }

  async attachTestPaymentMethod(input: {
    readonly customerId: string;
    readonly behavior: StripeFixturePaymentBehavior;
    readonly metadata: Readonly<Record<string, string>>;
    readonly idempotencyKey: string;
  }): Promise<{ readonly id: string }> {
    this.write("attachTestPaymentMethod", input.idempotencyKey);
    const id = `pm_${this.next()}`;
    this.paymentMethods.set(id, input.behavior);
    this.paymentMethodMetadata.set(id, { ...input.metadata });
    return { id };
  }

  async listSubscriptions(
    customerId: string,
  ): Promise<readonly StripeFixtureSubscription[]> {
    return [...this.stripe.subscriptions.values()]
      .filter((subscription) => subscription.customerId === customerId)
      .map((subscription) => this.toSubscription(subscription.id));
  }

  async createSubscription(input: {
    readonly customerId: string;
    readonly priceId: string;
    readonly paymentMethodId: string;
    readonly metadata: Readonly<Record<string, string>>;
    readonly idempotencyKey: string;
  }): Promise<StripeFixtureSubscription> {
    this.write("createSubscription", input.idempotencyKey);
    const customer = this.fixtureCustomers.get(input.customerId);
    if (!customer) {
      throw new StripeFixtureError(
        "Stripe subscriptions.create failed: no such customer",
      );
    }
    if (this.paymentMethods.get(input.paymentMethodId) !== "SUCCEEDS") {
      // `payment_behavior: error_if_incomplete`: a declined first payment creates nothing.
      throw new StripeFixtureError(
        "Stripe subscriptions.create failed (card_declined): the first payment was declined",
      );
    }
    // The subscription lives in clock time: it starts when the clock says it is.
    const start = this.requireClock(customer.clockId).frozenTime;
    const subscription = this.stripe.seedSubscription({
      customerId: input.customerId,
      priceId: input.priceId,
      id: `sub_${this.next()}`,
      currentPeriodEnd: new Date(start.getTime() + 30 * 86_400_000),
      created: start,
    });
    subscription.currentPeriodStart = start;
    this.subscriptionMetadata.set(subscription.id, { ...input.metadata });
    this.subscriptionPaymentMethod.set(subscription.id, input.paymentMethodId);
    return this.toSubscription(subscription.id);
  }

  async setSubscriptionPaymentMethod(input: {
    readonly subscriptionId: string;
    readonly paymentMethodId: string;
  }): Promise<StripeFixtureSubscription> {
    this.write("setSubscriptionPaymentMethod");
    this.subscriptionPaymentMethod.set(
      input.subscriptionId,
      input.paymentMethodId,
    );
    return this.toSubscription(input.subscriptionId);
  }

  async scheduleCancellationAtPeriodEnd(
    subscriptionId: string,
  ): Promise<StripeFixtureSubscription> {
    this.write("scheduleCancellationAtPeriodEnd");
    // The product fake's own model of a Portal cancellation: `cancel_at` set, the raw
    // `cancel_at_period_end` flag false.
    this.stripe.scheduleCancellation(subscriptionId);
    return this.toSubscription(subscriptionId);
  }
}
