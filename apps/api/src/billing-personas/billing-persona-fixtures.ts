import type { BillingPersona } from "@intrinsic/testing";
import { hasScheduledCancellation } from "../billing/stripe-gateway";
import type {
  StripeFixtureClock,
  StripeFixtureCustomer,
  StripeFixtureSubscription,
} from "../billing/stripe-fixture-gateway";

/**
 * Which Stripe test-mode objects belong to the billing QA persona tooling — decided here, purely,
 * and nowhere else.
 *
 * A Stripe sandbox is shared space: Checkout smoke tests, manual experiments and other tools all
 * leave customers, subscriptions and Test Clocks in it. This tooling creates, advances and deletes
 * objects there, so "is this one mine?" has to have exactly one answer, and the answer has to be
 * mechanical. Nothing in this file talks to Stripe or to PostgreSQL: it takes what was observed and
 * says what may be done with it.
 *
 * ## The unit of ownership is a Test Clock
 *
 * Every fixture is one Test Clock holding one customer holding one subscription. That shape is what
 * makes safe cleanup possible: deleting a clock is the only destructive call the tooling can make
 * (`stripe-fixture-gateway.ts`), Stripe removes the clock's customer and subscription with it, and
 * so there is never a "delete this customer" aimed at an object by its id alone.
 *
 * Ownership is stated twice, and both statements have to agree:
 *
 * - the clock's **name** (a Test Clock carries no metadata) encodes the tooling, a format version,
 *   the persona and the FactorSage user the fixture belongs to;
 * - the customer and the subscription each carry the same facts as **metadata**.
 *
 * ## Fail closed
 *
 * A clock whose name is not ours is `FOREIGN`: never read further, never touched, never reported.
 * A clock whose name *is* ours but whose contents do not fully agree with it — a customer without
 * the tags, a subscription somebody added by hand, a second customer, an unknown format version —
 * is `AMBIGUOUS`: it is refused, named, and left exactly as it is for a person to look at. Only a
 * clock on which every statement agrees is `OWNED`, and only an `OWNED` fixture is ever advanced,
 * rebuilt or deleted.
 */

/** Bump when the name or metadata format changes; older fixtures then read as `AMBIGUOUS`. */
export const BILLING_PERSONA_FIXTURE_VERSION = "1";

/** The value of the `factorsage_qa_fixture` tag: which tooling created the object. */
export const BILLING_PERSONA_FIXTURE_KIND = "billing-persona";

/** Every Test Clock this tooling creates is named with this prefix. */
export const BILLING_PERSONA_CLOCK_PREFIX = `factorsage-qa/${BILLING_PERSONA_FIXTURE_KIND}/`;

export const BILLING_PERSONA_METADATA_KEYS = {
  /** That this is a FactorSage QA fixture, and of which kind. */
  fixture: "factorsage_qa_fixture",
  version: "factorsage_qa_fixture_version",
  /** The billing persona the fixture realises. */
  persona: "factorsage_qa_persona",
  /** The FactorSage user the fixture is linked to; unique per database, so two never collide. */
  owner: "factorsage_qa_owner_user_id",
  /** The command that created it, for a person reading the Stripe Dashboard. */
  createdBy: "factorsage_qa_created_by",
  /**
   * The product's own customer tag (`StripeApiGateway.createCustomer`). Carried so a fixture
   * customer looks to support tooling like any other FactorSage customer; never an ownership rule.
   */
  applicationUser: "factorsageUserId",
} as const;

/** The tags that decide ownership. `createdBy` and `applicationUser` are informational. */
const OWNERSHIP_KEYS = ["fixture", "version", "persona", "owner"] as const;

export type BillingPersonaFixtureIdentity = {
  /** The persona name as written on the fixture. Not necessarily one this registry still has. */
  readonly persona: string;
  readonly ownerUserId: string;
};

const PERSONA_NAME = /^[A-Z][A-Z0-9_]{2,62}$/;
const USER_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function assertIdentity(identity: BillingPersonaFixtureIdentity): void {
  if (!PERSONA_NAME.test(identity.persona)) {
    throw new Error(`'${identity.persona}' is not a billing persona name`);
  }
  if (!USER_ID.test(identity.ownerUserId)) {
    throw new Error("A billing persona fixture must be owned by a user id");
  }
}

/** `factorsage-qa/billing-persona/v1/<PERSONA>/<user id>`. */
export function billingPersonaClockName(
  identity: BillingPersonaFixtureIdentity,
): string {
  assertIdentity(identity);
  return (
    `${BILLING_PERSONA_CLOCK_PREFIX}v${BILLING_PERSONA_FIXTURE_VERSION}/` +
    `${identity.persona}/${identity.ownerUserId}`
  );
}

/** Whether a clock name claims to be this tooling's, well-formed or not. */
export function claimsBillingPersonaClockName(name: string | null): boolean {
  return name !== null && name.startsWith(BILLING_PERSONA_CLOCK_PREFIX);
}

/**
 * The identity a clock name states, or `null` when the name is not exactly the current format.
 *
 * Anchored at both ends and strict about every segment: a name that merely resembles ours is not
 * ours.
 */
export function parseBillingPersonaClockName(
  name: string | null,
): BillingPersonaFixtureIdentity | null {
  if (!claimsBillingPersonaClockName(name) || name === null) {
    return null;
  }
  const segments = name.slice(BILLING_PERSONA_CLOCK_PREFIX.length).split("/");
  const [version, persona, ownerUserId] = segments;
  if (
    segments.length !== 3 ||
    version !== `v${BILLING_PERSONA_FIXTURE_VERSION}` ||
    persona === undefined ||
    ownerUserId === undefined ||
    !PERSONA_NAME.test(persona) ||
    !USER_ID.test(ownerUserId)
  ) {
    return null;
  }
  return { persona, ownerUserId };
}

/** The metadata every customer and subscription of a fixture carries. */
export function billingPersonaFixtureMetadata(
  identity: BillingPersonaFixtureIdentity,
  createdBy: string,
): Readonly<Record<string, string>> {
  assertIdentity(identity);
  return {
    [BILLING_PERSONA_METADATA_KEYS.fixture]: BILLING_PERSONA_FIXTURE_KIND,
    [BILLING_PERSONA_METADATA_KEYS.version]: BILLING_PERSONA_FIXTURE_VERSION,
    [BILLING_PERSONA_METADATA_KEYS.persona]: identity.persona,
    [BILLING_PERSONA_METADATA_KEYS.owner]: identity.ownerUserId,
    [BILLING_PERSONA_METADATA_KEYS.createdBy]: createdBy,
    [BILLING_PERSONA_METADATA_KEYS.applicationUser]: identity.ownerUserId,
  };
}

/** What is wrong with an object's ownership tags, as reasons. Empty when they all agree. */
export function fixtureMetadataProblems(
  metadata: Readonly<Record<string, string>>,
  identity: BillingPersonaFixtureIdentity,
): string[] {
  const expected: Record<(typeof OWNERSHIP_KEYS)[number], string> = {
    fixture: BILLING_PERSONA_FIXTURE_KIND,
    version: BILLING_PERSONA_FIXTURE_VERSION,
    persona: identity.persona,
    owner: identity.ownerUserId,
  };
  const problems: string[] = [];
  for (const key of OWNERSHIP_KEYS) {
    const name = BILLING_PERSONA_METADATA_KEYS[key];
    const actual = metadata[name];
    if (actual === undefined) {
      problems.push(`metadata ${name} is missing`);
    } else if (actual !== expected[key]) {
      problems.push(`metadata ${name} does not match the clock's name`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** One Test Clock and everything on it, as Stripe reported it. */
export type ObservedFixtureClock = {
  readonly clock: StripeFixtureClock;
  readonly customers: readonly {
    readonly customer: StripeFixtureCustomer;
    readonly subscriptions: readonly StripeFixtureSubscription[];
  }[];
};

export type OwnedBillingPersonaFixture = {
  readonly kind: "OWNED";
  readonly identity: BillingPersonaFixtureIdentity;
  readonly clock: StripeFixtureClock;
  /** Null when a previous run stopped between creating the clock and creating its customer. */
  readonly customer: StripeFixtureCustomer | null;
  readonly subscriptions: readonly StripeFixtureSubscription[];
};

export type AmbiguousBillingPersonaFixture = {
  readonly kind: "AMBIGUOUS";
  readonly clock: StripeFixtureClock;
  /** What the name says, when it can be read at all. Never trusted — only reported. */
  readonly claimed: BillingPersonaFixtureIdentity | null;
  /** The customers on the clock, so a caller can tell an account linked to one is already reported. */
  readonly customerIds: readonly string[];
  readonly reasons: readonly string[];
};

export type BillingPersonaFixtureClassification =
  | { readonly kind: "FOREIGN" }
  | OwnedBillingPersonaFixture
  | AmbiguousBillingPersonaFixture;

/**
 * Decides whose a Test Clock is.
 *
 * `customers` must be everything on the clock; passing a subset would hide exactly the stray
 * object that makes a fixture ambiguous.
 */
export function classifyBillingPersonaFixture(
  observed: ObservedFixtureClock,
): BillingPersonaFixtureClassification {
  const { clock, customers } = observed;
  if (!claimsBillingPersonaClockName(clock.name)) {
    return { kind: "FOREIGN" };
  }

  const identity = parseBillingPersonaClockName(clock.name);
  const customerIds = customers.map(({ customer }) => customer.id);
  const reasons: string[] = [];

  if (clock.livemode !== false) {
    reasons.push("the clock is not a test-mode object");
  }
  if (identity === null) {
    reasons.push(
      "the clock's name starts like a billing persona fixture but is not in the current format",
    );
    return { kind: "AMBIGUOUS", clock, claimed: null, customerIds, reasons };
  }

  if (customers.length > 1) {
    reasons.push(
      `the clock holds ${customers.length} customers; a fixture has exactly one`,
    );
  }

  for (const { customer, subscriptions } of customers) {
    if (customer.livemode !== false) {
      reasons.push(`customer ${customer.id} is not a test-mode object`);
    }
    if (customer.testClockId !== clock.id) {
      reasons.push(`customer ${customer.id} is not attached to this clock`);
    }
    for (const problem of fixtureMetadataProblems(
      customer.metadata,
      identity,
    )) {
      reasons.push(`customer ${customer.id}: ${problem}`);
    }
    for (const subscription of subscriptions) {
      if (subscription.livemode !== false) {
        reasons.push(
          `subscription ${subscription.id} is not a test-mode object`,
        );
      }
      if (subscription.customerId !== customer.id) {
        reasons.push(
          `subscription ${subscription.id} belongs to another customer`,
        );
      }
      for (const problem of fixtureMetadataProblems(
        subscription.metadata,
        identity,
      )) {
        reasons.push(`subscription ${subscription.id}: ${problem}`);
      }
    }
  }

  if (reasons.length > 0) {
    return {
      kind: "AMBIGUOUS",
      clock,
      claimed: identity,
      customerIds,
      reasons,
    };
  }

  const only = customers[0] ?? null;
  return {
    kind: "OWNED",
    identity,
    clock,
    customer: only?.customer ?? null,
    subscriptions: only?.subscriptions ?? [],
  };
}

// ---------------------------------------------------------------------------
// Convergence
// ---------------------------------------------------------------------------

export type FixtureEvaluation =
  | {
      readonly converged: true;
      readonly customer: StripeFixtureCustomer;
      readonly subscription: StripeFixtureSubscription;
    }
  | { readonly converged: false; readonly reasons: readonly string[] };

/**
 * Whether an owned fixture already **is** the persona's declared Stripe state.
 *
 * The only question a rerun asks before deciding to leave Stripe alone. It is deliberately a
 * yes-or-no: a fixture that is not exactly the declared state is rebuilt from nothing rather than
 * nudged forward, because a half-advanced lifecycle has too many shapes to repair safely and a
 * rebuild has one.
 */
export function evaluateBillingPersonaFixture(input: {
  readonly persona: BillingPersona;
  /** The configured Stripe price for the persona's catalog key. */
  readonly priceId: string;
  readonly fixture: OwnedBillingPersonaFixture;
}): FixtureEvaluation {
  const { persona, priceId, fixture } = input;
  const reasons: string[] = [];

  if (fixture.clock.status !== "ready") {
    reasons.push(`the test clock is ${fixture.clock.status}, not ready`);
  }
  if (fixture.customer === null) {
    reasons.push("the test clock has no customer");
  }
  if (fixture.subscriptions.length !== 1) {
    reasons.push(
      `the customer has ${fixture.subscriptions.length} subscriptions; a fixture has exactly one`,
    );
  }

  const subscription = fixture.subscriptions[0];
  if (subscription !== undefined && fixture.subscriptions.length === 1) {
    if (subscription.priceId !== priceId) {
      reasons.push(
        `the subscription is not on the configured ${persona.priceKey} price`,
      );
    }
    if (subscription.status !== persona.expected.stripeStatus) {
      reasons.push(
        `the subscription is ${subscription.status}, not ${persona.expected.stripeStatus}`,
      );
    }
    // A cancellation is only *scheduled* while the subscription is live; one that has already
    // ended keeps its `cancel_at`, which then describes the past.
    if (
      persona.expected.holdsPaidSlot &&
      hasScheduledCancellation(subscription) !==
        persona.expected.cancellationScheduled
    ) {
      reasons.push(
        persona.expected.cancellationScheduled
          ? "no cancellation is scheduled"
          : "a cancellation is scheduled",
      );
    }
  }

  if (
    reasons.length === 0 &&
    fixture.customer !== null &&
    subscription !== undefined
  ) {
    return { converged: true, customer: fixture.customer, subscription };
  }
  return { converged: false, reasons };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Which fixtures a cleanup may consider.
 *
 * `OWNERS` — the fixtures linked to these FactorSage users: the default, and exact, because a user
 * id is unique to one database. `ALL_TAGGED` — every fixture this tooling ever created in the
 * Stripe account, including ones left by another database, a deleted user or an interrupted run.
 */
export type FixtureCleanupScope =
  | { readonly kind: "OWNERS"; readonly ownerUserIds: ReadonlySet<string> }
  | { readonly kind: "ALL_TAGGED" };

export type FixtureCleanupPlan = {
  /** Fixtures that may be deleted: fully owned, and inside the scope. */
  readonly deletions: readonly OwnedBillingPersonaFixture[];
  /** Fixture-looking clocks that will not be touched, with the reason. Always reported. */
  readonly refusals: readonly AmbiguousBillingPersonaFixture[];
  /** Fully owned fixtures outside the scope: somebody else's, left alone. */
  readonly outOfScope: readonly OwnedBillingPersonaFixture[];
};

/**
 * Decides what a cleanup deletes. Pure, so the refusal rules are testable without Stripe.
 *
 * An ambiguous fixture is refused in **every** scope, including when its name claims an owner
 * outside it: something that looks like ours and is not consistent needs a person, and saying
 * nothing about it would leave it in the sandbox forever.
 */
export function planFixtureCleanup(
  classified: readonly BillingPersonaFixtureClassification[],
  scope: FixtureCleanupScope,
): FixtureCleanupPlan {
  const deletions: OwnedBillingPersonaFixture[] = [];
  const refusals: AmbiguousBillingPersonaFixture[] = [];
  const outOfScope: OwnedBillingPersonaFixture[] = [];

  for (const fixture of classified) {
    if (fixture.kind === "FOREIGN") {
      continue;
    }
    if (fixture.kind === "AMBIGUOUS") {
      refusals.push(fixture);
      continue;
    }
    if (
      scope.kind === "ALL_TAGGED" ||
      scope.ownerUserIds.has(fixture.identity.ownerUserId)
    ) {
      deletions.push(fixture);
    } else {
      outOfScope.push(fixture);
    }
  }

  return { deletions, refusals, outOfScope };
}
