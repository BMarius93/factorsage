import { BILLING_PERSONAS } from "@intrinsic/testing";
import { describe, expect, it } from "vitest";
import type {
  StripeFixtureClock,
  StripeFixtureCustomer,
  StripeFixtureSubscription,
} from "../billing/stripe-fixture-gateway";
import {
  BILLING_PERSONA_CLOCK_PREFIX,
  BILLING_PERSONA_FIXTURE_KIND,
  BILLING_PERSONA_FIXTURE_VERSION,
  BILLING_PERSONA_METADATA_KEYS,
  billingPersonaClockName,
  billingPersonaFixtureMetadata,
  classifyBillingPersonaFixture,
  evaluateBillingPersonaFixture,
  parseBillingPersonaClockName,
  planFixtureCleanup,
  type BillingPersonaFixtureClassification,
  type ObservedFixtureClock,
  type OwnedBillingPersonaFixture,
} from "./billing-persona-fixtures";

/**
 * The ownership rules are what stand between `pnpm qa:billing:cleanup` and somebody else's Stripe
 * test data, so each refusal is asserted on its own rather than inferred from the happy path.
 */

const OWNER = "0f4c2c1e-3b7a-4d55-9a61-6f2f0c1d9e11";
const OTHER_OWNER = "7a1e9d40-52c3-4b6f-8e0d-2c4b6a8f1035";
const IDENTITY = { persona: "BILLING_PRO_ACTIVE", ownerUserId: OWNER };
const PRICE_ID = "price_pro_monthly";

function clock(
  overrides: Partial<StripeFixtureClock> = {},
): StripeFixtureClock {
  return {
    id: "clock_1",
    name: billingPersonaClockName(IDENTITY),
    status: "ready",
    frozenTime: new Date("2026-10-10T00:00:00Z"),
    deletesAfter: new Date("2026-11-09T00:00:00Z"),
    livemode: false,
    ...overrides,
  };
}

function customer(
  overrides: Partial<StripeFixtureCustomer> = {},
): StripeFixtureCustomer {
  return {
    id: "cus_1",
    email: "qa-billing-pro-active@factorsage.test",
    metadata: billingPersonaFixtureMetadata(IDENTITY, "test"),
    testClockId: "clock_1",
    livemode: false,
    ...overrides,
  };
}

function subscription(
  overrides: Partial<StripeFixtureSubscription> = {},
): StripeFixtureSubscription {
  return {
    id: "sub_1",
    customerId: "cus_1",
    status: "active",
    priceId: PRICE_ID,
    metadata: billingPersonaFixtureMetadata(IDENTITY, "test"),
    cancelAtPeriodEnd: false,
    cancelAt: null,
    canceledAt: null,
    currentPeriodStart: new Date("2026-10-10T00:00:00Z"),
    currentPeriodEnd: new Date("2026-11-10T00:00:00Z"),
    livemode: false,
    ...overrides,
  };
}

function observed(
  overrides: {
    clock?: Partial<StripeFixtureClock>;
    customer?: Partial<StripeFixtureCustomer>;
    subscriptions?: StripeFixtureSubscription[];
    extraCustomers?: ObservedFixtureClock["customers"];
    noCustomer?: boolean;
  } = {},
): ObservedFixtureClock {
  return {
    clock: clock(overrides.clock),
    customers: overrides.noCustomer
      ? []
      : [
          {
            customer: customer(overrides.customer),
            subscriptions: overrides.subscriptions ?? [subscription()],
          },
          ...(overrides.extraCustomers ?? []),
        ],
  };
}

function reasonsOf(
  classification: BillingPersonaFixtureClassification,
): string {
  if (classification.kind !== "AMBIGUOUS") {
    throw new Error(`expected AMBIGUOUS, received ${classification.kind}`);
  }
  return classification.reasons.join(" | ");
}

function owned(
  classification: BillingPersonaFixtureClassification,
): OwnedBillingPersonaFixture {
  if (classification.kind !== "OWNED") {
    throw new Error(`expected OWNED, received ${classification.kind}`);
  }
  return classification;
}

describe("billing persona fixture identity", () => {
  it("names a clock after the tooling, the format version, the persona and the owner", () => {
    expect(billingPersonaClockName(IDENTITY)).toBe(
      `factorsage-qa/billing-persona/v1/BILLING_PRO_ACTIVE/${OWNER}`,
    );
    expect(
      parseBillingPersonaClockName(billingPersonaClockName(IDENTITY)),
    ).toEqual(IDENTITY);
  });

  it("refuses to name a clock for anything but a persona and a user id", () => {
    expect(() =>
      billingPersonaClockName({ persona: "pro active", ownerUserId: OWNER }),
    ).toThrow(/not a billing persona name/);
    expect(() =>
      billingPersonaClockName({
        persona: "BILLING_PRO_ACTIVE",
        ownerUserId: "me",
      }),
    ).toThrow(/user id/);
  });

  it.each([
    ["no name", null],
    ["somebody else's clock", "checkout smoke clock"],
    [
      "a name that only contains ours",
      `x-${BILLING_PERSONA_CLOCK_PREFIX}v1/BILLING_PRO_ACTIVE/${OWNER}`,
    ],
    [
      "an older format version",
      `${BILLING_PERSONA_CLOCK_PREFIX}v0/BILLING_PRO_ACTIVE/${OWNER}`,
    ],
    ["a missing owner", `${BILLING_PERSONA_CLOCK_PREFIX}v1/BILLING_PRO_ACTIVE`],
    [
      "an owner that is not a user id",
      `${BILLING_PERSONA_CLOCK_PREFIX}v1/BILLING_PRO_ACTIVE/me`,
    ],
    [
      "a trailing segment",
      `${BILLING_PERSONA_CLOCK_PREFIX}v1/BILLING_PRO_ACTIVE/${OWNER}/x`,
    ],
    [
      "a lower-case persona",
      `${BILLING_PERSONA_CLOCK_PREFIX}v1/billing_pro_active/${OWNER}`,
    ],
  ])("reads no identity from %s", (_label, name) => {
    expect(parseBillingPersonaClockName(name)).toBeNull();
  });

  it("tags a fixture with what it is, which persona, whose, and who made it", () => {
    expect(
      billingPersonaFixtureMetadata(IDENTITY, "pnpm qa:billing:seed"),
    ).toEqual({
      factorsage_qa_fixture: "billing-persona",
      factorsage_qa_fixture_version: "1",
      factorsage_qa_persona: "BILLING_PRO_ACTIVE",
      factorsage_qa_owner_user_id: OWNER,
      factorsage_qa_created_by: "pnpm qa:billing:seed",
      // The product's own customer tag, so the fixture reads like any FactorSage customer.
      factorsageUserId: OWNER,
    });
    expect(BILLING_PERSONA_FIXTURE_KIND).toBe("billing-persona");
    expect(BILLING_PERSONA_FIXTURE_VERSION).toBe("1");
  });
});

describe("classifyBillingPersonaFixture", () => {
  it("owns a clock whose name, customer and subscription all agree", () => {
    const fixture = owned(classifyBillingPersonaFixture(observed()));
    expect(fixture.identity).toEqual(IDENTITY);
    expect(fixture.customer?.id).toBe("cus_1");
    expect(fixture.subscriptions.map((item) => item.id)).toEqual(["sub_1"]);
  });

  it("owns a clock a run abandoned before creating its customer", () => {
    const fixture = owned(
      classifyBillingPersonaFixture(observed({ noCustomer: true })),
    );
    expect(fixture.customer).toBeNull();
    expect(fixture.subscriptions).toEqual([]);
  });

  it("owns a fixture of a persona this registry no longer has", () => {
    const retired = { persona: "BILLING_RETIRED_PERSONA", ownerUserId: OWNER };
    const metadata = billingPersonaFixtureMetadata(retired, "test");
    const fixture = owned(
      classifyBillingPersonaFixture(
        observed({
          clock: { name: billingPersonaClockName(retired) },
          customer: { metadata },
          subscriptions: [subscription({ metadata })],
        }),
      ),
    );
    expect(fixture.identity.persona).toBe("BILLING_RETIRED_PERSONA");
  });

  it("calls a clock foreign when its name is not ours, whatever is on it", () => {
    // Even a customer carrying our tags does not make somebody else's clock ours.
    expect(
      classifyBillingPersonaFixture(
        observed({ clock: { name: "manual test" } }),
      ),
    ).toEqual({ kind: "FOREIGN" });
    expect(
      classifyBillingPersonaFixture(observed({ clock: { name: null } })),
    ).toEqual({ kind: "FOREIGN" });
  });

  it("refuses a clock whose name starts like ours but is not in the current format", () => {
    const classification = classifyBillingPersonaFixture(
      observed({
        clock: {
          name: `${BILLING_PERSONA_CLOCK_PREFIX}v0/BILLING_PRO_ACTIVE/${OWNER}`,
        },
      }),
    );
    expect(reasonsOf(classification)).toMatch(/not in the current format/);
    expect(classification).toMatchObject({ claimed: null });
  });

  it("refuses a customer that has lost its metadata", () => {
    const classification = classifyBillingPersonaFixture(
      observed({ customer: { metadata: {} } }),
    );
    expect(reasonsOf(classification)).toMatch(
      /customer cus_1: metadata factorsage_qa_fixture is missing/,
    );
    // What the name claims is reported, never trusted.
    expect(classification).toMatchObject({ claimed: IDENTITY });
  });

  it.each([
    [
      "the fixture kind",
      BILLING_PERSONA_METADATA_KEYS.fixture,
      "something-else",
    ],
    ["the format version", BILLING_PERSONA_METADATA_KEYS.version, "2"],
    ["the persona", BILLING_PERSONA_METADATA_KEYS.persona, "BILLING_CANCELED"],
    ["the owner", BILLING_PERSONA_METADATA_KEYS.owner, OTHER_OWNER],
  ])(
    "refuses a customer whose metadata disagrees about %s",
    (_label, key, value) => {
      const metadata = {
        ...billingPersonaFixtureMetadata(IDENTITY, "test"),
        [key]: value,
      };
      expect(
        reasonsOf(
          classifyBillingPersonaFixture(observed({ customer: { metadata } })),
        ),
      ).toMatch(new RegExp(`customer cus_1: metadata ${key} does not match`));
    },
  );

  it("refuses a subscription somebody added to a fixture customer by hand", () => {
    expect(
      reasonsOf(
        classifyBillingPersonaFixture(
          observed({
            subscriptions: [
              subscription(),
              subscription({ id: "sub_manual", metadata: {} }),
            ],
          }),
        ),
      ),
    ).toMatch(
      /subscription sub_manual: metadata factorsage_qa_fixture is missing/,
    );
  });

  it("refuses a clock holding more than one customer", () => {
    expect(
      reasonsOf(
        classifyBillingPersonaFixture(
          observed({
            extraCustomers: [
              { customer: customer({ id: "cus_2" }), subscriptions: [] },
            ],
          }),
        ),
      ),
    ).toMatch(/holds 2 customers/);
  });

  it("refuses anything Stripe reports as live mode", () => {
    expect(
      reasonsOf(
        classifyBillingPersonaFixture(observed({ clock: { livemode: true } })),
      ),
    ).toMatch(/clock is not a test-mode object/);
    expect(
      reasonsOf(
        classifyBillingPersonaFixture(
          observed({ customer: { livemode: true } }),
        ),
      ),
    ).toMatch(/customer cus_1 is not a test-mode object/);
    expect(
      reasonsOf(
        classifyBillingPersonaFixture(
          observed({ subscriptions: [subscription({ livemode: true })] }),
        ),
      ),
    ).toMatch(/subscription sub_1 is not a test-mode object/);
  });

  it("refuses a customer that is not attached to the clock it was listed under", () => {
    expect(
      reasonsOf(
        classifyBillingPersonaFixture(
          observed({ customer: { testClockId: "clock_9" } }),
        ),
      ),
    ).toMatch(/not attached to this clock/);
  });
});

describe("evaluateBillingPersonaFixture", () => {
  const evaluate = (
    persona: keyof typeof BILLING_PERSONAS,
    input: Parameters<typeof observed>[0] = {},
  ) =>
    evaluateBillingPersonaFixture({
      persona: BILLING_PERSONAS[persona],
      priceId: PRICE_ID,
      fixture: owned(classifyBillingPersonaFixture(observed(input))),
    });

  const reasons = (evaluation: ReturnType<typeof evaluate>): string =>
    evaluation.converged ? "" : evaluation.reasons.join(" | ");

  it("accepts an active subscription on the configured price with nothing scheduled", () => {
    const evaluation = evaluate("BILLING_PRO_ACTIVE");
    expect(evaluation).toMatchObject({ converged: true });
  });

  it("rejects a fixture whose clock is still advancing", () => {
    expect(
      reasons(
        evaluate("BILLING_PRO_ACTIVE", { clock: { status: "advancing" } }),
      ),
    ).toMatch(/test clock is advancing/);
  });

  it("rejects a half-built fixture with no customer or no subscription", () => {
    expect(
      reasons(evaluate("BILLING_PRO_ACTIVE", { noCustomer: true })),
    ).toMatch(/no customer/);
    expect(
      reasons(evaluate("BILLING_PRO_ACTIVE", { subscriptions: [] })),
    ).toMatch(/0 subscriptions/);
  });

  it("rejects a subscription on another price or in another status", () => {
    expect(
      reasons(
        evaluate("BILLING_PRO_ACTIVE", {
          subscriptions: [subscription({ priceId: "price_starter_monthly" })],
        }),
      ),
    ).toMatch(/not on the configured PRO_MONTHLY price/);
    expect(
      reasons(
        evaluate("BILLING_PRO_ACTIVE", {
          subscriptions: [subscription({ status: "past_due" })],
        }),
      ),
    ).toMatch(/is past_due, not active/);
  });

  it("recognises a scheduled cancellation in either of Stripe's representations", () => {
    const cancelAt = new Date("2026-11-10T00:00:00Z");
    // The representation the pinned API version returns: the raw flag stays false.
    expect(
      evaluate("BILLING_PRO_CANCELING", {
        subscriptions: [subscription({ cancelAtPeriodEnd: false, cancelAt })],
      }),
    ).toMatchObject({ converged: true });
    // The older one.
    expect(
      evaluate("BILLING_PRO_CANCELING", {
        subscriptions: [
          subscription({ cancelAtPeriodEnd: true, cancelAt: null }),
        ],
      }),
    ).toMatchObject({ converged: true });
    expect(reasons(evaluate("BILLING_PRO_CANCELING"))).toMatch(
      /no cancellation is scheduled/,
    );
    expect(
      reasons(
        evaluate("BILLING_PRO_ACTIVE", {
          subscriptions: [subscription({ cancelAt })],
        }),
      ),
    ).toMatch(/a cancellation is scheduled/);
  });

  it("does not read an ended subscription's leftover cancel_at as a scheduled cancellation", () => {
    expect(
      evaluate("BILLING_CANCELED", {
        subscriptions: [
          subscription({
            status: "canceled",
            cancelAt: new Date("2026-10-05T00:00:00Z"),
            canceledAt: new Date("2026-09-05T00:00:00Z"),
          }),
        ],
      }),
    ).toMatchObject({ converged: true });
  });
});

describe("planFixtureCleanup", () => {
  const mine = classifyBillingPersonaFixture(observed());
  const otherIdentity = {
    persona: "BILLING_CANCELED",
    ownerUserId: OTHER_OWNER,
  };
  const otherMetadata = billingPersonaFixtureMetadata(otherIdentity, "test");
  const someoneElses = classifyBillingPersonaFixture(
    observed({
      clock: { id: "clock_2", name: billingPersonaClockName(otherIdentity) },
      customer: {
        id: "cus_2",
        testClockId: "clock_2",
        metadata: otherMetadata,
      },
      subscriptions: [
        subscription({
          id: "sub_2",
          customerId: "cus_2",
          metadata: otherMetadata,
        }),
      ],
    }),
  );
  const ambiguous = classifyBillingPersonaFixture(
    observed({ clock: { id: "clock_3" }, customer: { metadata: {} } }),
  );
  const foreign = classifyBillingPersonaFixture(
    observed({ clock: { id: "clock_4", name: "checkout smoke" } }),
  );
  const all = [mine, someoneElses, ambiguous, foreign];

  it("deletes only the fixtures of the owners in scope", () => {
    const plan = planFixtureCleanup(all, {
      kind: "OWNERS",
      ownerUserIds: new Set([OWNER]),
    });
    expect(plan.deletions.map((fixture) => fixture.clock.id)).toEqual([
      "clock_1",
    ]);
    expect(plan.outOfScope.map((fixture) => fixture.clock.id)).toEqual([
      "clock_2",
    ]);
  });

  it("deletes every owned fixture when asked for all tagged ones", () => {
    const plan = planFixtureCleanup(all, { kind: "ALL_TAGGED" });
    expect(plan.deletions.map((fixture) => fixture.clock.id)).toEqual([
      "clock_1",
      "clock_2",
    ]);
    expect(plan.outOfScope).toEqual([]);
  });

  it("never deletes an ambiguous fixture, in any scope, and always reports it", () => {
    for (const scope of [
      { kind: "ALL_TAGGED" } as const,
      { kind: "OWNERS", ownerUserIds: new Set([OWNER]) } as const,
      // Even when nobody in scope could own it.
      { kind: "OWNERS", ownerUserIds: new Set<string>() } as const,
    ]) {
      const plan = planFixtureCleanup(all, scope);
      expect(plan.deletions.map((fixture) => fixture.clock.id)).not.toContain(
        "clock_3",
      );
      expect(plan.refusals.map((fixture) => fixture.clock.id)).toEqual([
        "clock_3",
      ]);
    }
  });

  it("never mentions a foreign clock at all", () => {
    const plan = planFixtureCleanup(all, { kind: "ALL_TAGGED" });
    const touched = [
      ...plan.deletions,
      ...plan.refusals,
      ...plan.outOfScope,
    ].map((fixture) => fixture.clock.id);
    expect(touched).not.toContain("clock_4");
  });

  it("plans nothing when no owner is in scope", () => {
    const plan = planFixtureCleanup([mine, someoneElses], {
      kind: "OWNERS",
      ownerUserIds: new Set<string>(),
    });
    expect(plan.deletions).toEqual([]);
    expect(plan.outOfScope).toHaveLength(2);
  });
});
