import { LEGAL_ACCEPTANCE_BUNDLE } from "@intrinsic/contracts";
import {
  LegalAcceptanceSurface,
  type LegalDocumentKind,
  type LegalRecordKind,
  type Prisma,
  type PrismaClient,
  UserPlan,
  UserRole,
} from "@intrinsic/database";
import {
  E2E_DISPOSABLE_ACCOUNT_DOMAIN,
  E2E_DISPOSABLE_ACCOUNT_KINDS,
  e2eDisposableAccountKindOf,
  type E2eDisposableAccountKind,
} from "@intrinsic/testing";

/**
 * Removes the throwaway accounts E2E specs register — `pnpm test:accounts:prune`, which the
 * Playwright global setup and teardown run (`apps/web/e2e/global-setup.ts`).
 *
 * A sign-up spec has to create a real account through the public API, and the product offers no
 * way to delete one, so without this every run left one behind (`escalation-<ms>@example.test`).
 * Playwright never holds a database client: it runs this command as a child process, and the
 * command decides on its own what it may touch.
 *
 * **What it deletes is fenced three ways, and each fence fails closed.**
 *
 * 1. *Which database* — {@link resolveE2eAccountCleanupTarget}: never under `NODE_ENV=production`,
 *    only `TEST_DATABASE_URL`, only a local server, only a database whose name says it is a test
 *    one, never the development database; and {@link pruneE2eDisposableAccounts} confirms the
 *    server it reached really is that database before it reads a row.
 * 2. *Which addresses* — exactly the kinds `@intrinsic/testing/e2e-accounts` declares, matched by
 *    the anchored `^<kind>-\d+@example\.test$` pattern and nothing looser.
 * 3. *Which state* — decided **per kind** ({@link CLEANUP_POLICIES}): an account may be deleted only
 *    in a state its own spec can legitimately leave behind, at any point that spec can be stopped.
 *    Whatever the kind, `ADMIN`, a paid plan, any Stripe state, an OAuth identity and any product
 *    content are never deletable. An address of a declared kind in any other state is **refused**,
 *    not deleted, and the command exits non-zero: a disposable account holding `ADMIN` or `PRO`
 *    would be the exact escalation a spec exists to rule out, and deleting it would destroy the
 *    evidence.
 *
 * The two policies, and why they differ:
 *
 * - `escalation` — only the state registration leaves: never verified, `USER` on `FREE`, no Stripe
 *   customer, no revoked session, and nothing depending on it but its own activation link. A
 *   password hash is allowed: registration before AUTH-003 stored one on the pending row, since
 *   AUTH-003 it stores none, and both are pending accounts nobody can sign in to.
 * - `authmail` — the email lifecycle suite goes further on purpose, so its policy names each state
 *   that lifecycle passes through and nothing in between: *pending* (no password, never verified,
 *   session version 0, at most its activation link) and *activated* (the password its link holder
 *   chose, verified, session version 1 after activation or 2 after one reset, no activation link,
 *   at most one reset link, and exactly the legal records activation writes). A mix of the two — a
 *   pending account holding a password, a verified one holding an activation link — is not a state
 *   the lifecycle produces, and is refused.
 */

/** Why a cleanup did not run. Nothing has been read or written when this is thrown. */
export class E2eAccountCleanupRefusedError extends Error {
  override readonly name = "E2eAccountCleanupRefusedError";
}

export type E2eAccountCleanupTarget = {
  readonly databaseUrl: string;
  /** The database name the URL names, re-checked against the server once connected. */
  readonly databaseName: string;
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** `test` as a whole segment of the name: `intrinsic_value_test`, not `contest`. */
const TEST_DATABASE_NAME = /(^|[_-])test($|[_-])/i;

function assertNotProduction(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV?.trim() === "production") {
    throw new E2eAccountCleanupRefusedError(
      "Refusing to prune E2E accounts: NODE_ENV is production. This command deletes accounts and " +
        "exists only for the dedicated test database.",
    );
  }
}

function databaseNameOf(raw: string): string | null {
  try {
    const name = decodeURIComponent(new URL(raw).pathname.replace(/^\//, ""));
    return name || null;
  } catch {
    return null;
  }
}

/**
 * The one database this command may touch, or a refusal naming why not.
 *
 * Ordered cheapest-and-most-catastrophic first, and nothing here opens a connection: a wrong
 * target is reported before a client exists that could act on it. There is no CI allowance — CI
 * runs no E2E stack, so nothing ever needs this command where `DATABASE_URL` and
 * `TEST_DATABASE_URL` may legitimately coincide.
 */
export function resolveE2eAccountCleanupTarget(
  env: NodeJS.ProcessEnv = process.env,
): E2eAccountCleanupTarget {
  assertNotProduction(env);

  const raw = env.TEST_DATABASE_URL?.trim();
  if (!raw) {
    throw new E2eAccountCleanupRefusedError(
      "Refusing to prune E2E accounts: TEST_DATABASE_URL is not set. The E2E stack runs against " +
        "the dedicated test database only, and DATABASE_URL is never a fallback.",
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new E2eAccountCleanupRefusedError(
      "Refusing to prune E2E accounts: TEST_DATABASE_URL is not a valid URL.",
    );
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new E2eAccountCleanupRefusedError(
      "Refusing to prune E2E accounts: TEST_DATABASE_URL is not a PostgreSQL URL.",
    );
  }
  const databaseName = databaseNameOf(raw);
  if (databaseName === null) {
    throw new E2eAccountCleanupRefusedError(
      "Refusing to prune E2E accounts: TEST_DATABASE_URL names no database.",
    );
  }

  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new E2eAccountCleanupRefusedError(
      `Refusing to prune E2E accounts: TEST_DATABASE_URL points at \`${url.hostname}\`, which is ` +
        "not a local host. The E2E stack runs on this machine; a remote database is not its test " +
        "database.",
    );
  }

  if (!TEST_DATABASE_NAME.test(databaseName)) {
    throw new E2eAccountCleanupRefusedError(
      `Refusing to prune E2E accounts: the database \`${databaseName}\` does not identify itself ` +
        "as a test database (its name has no `test` segment, as `intrinsic_value_test` does). " +
        "This command deletes accounts, so where it points has to be readable rather than " +
        "remembered.",
    );
  }

  const development = env.DATABASE_URL?.trim();
  const developmentName = development ? databaseNameOf(development) : null;
  if (
    development === raw ||
    (developmentName !== null &&
      developmentName.toLowerCase() === databaseName.toLowerCase())
  ) {
    throw new E2eAccountCleanupRefusedError(
      `Refusing to prune E2E accounts: TEST_DATABASE_URL names the development database ` +
        `(\`${databaseName}\`). Create a dedicated test database with \`pnpm db:test:prepare\`.`,
    );
  }

  return { databaseUrl: raw, databaseName };
}

/**
 * Every relation of `User` a cleanup decision has to account for, and how a refusal names it.
 *
 * Every relation of `User` except `verificationTokens`, which each policy decides on its own.
 * `billingSubscription` (one-to-one) and `StripeWebhookEvent.userId` (no foreign key) are checked
 * separately. Each `SET NULL` relation (`updated*`) is here too, so a delete never silently
 * rewrites a row someone else owns.
 */
const DEPENDENTS = {
  oauthAccounts: "OAuth identities",
  resetTokens: "password-reset links",
  legalRecords: "legal records",
  legalRequests: "legal requests",
  stockLists: "stock lists",
  strategies: "strategies",
  backtestRuns: "backtest runs",
  monitors: "monitors",
  recentSecurityViews: "recent security views",
  builtInMonitorPreferences: "built-in monitor preferences",
  actorGroups: "actor groups",
  updatedStockLists: "stock lists it last edited",
  updatedStrategies: "strategies it last edited",
  updatedMonitors: "monitors it last edited",
  updatedActorGroups: "actor groups it last edited",
} as const satisfies Partial<
  Record<keyof Prisma.UserCountOutputTypeSelect, string>
>;

type Dependent = keyof typeof DEPENDENTS;

const DEPENDENT_RELATIONS = Object.keys(DEPENDENTS) as Dependent[];

/**
 * The dependents the email lifecycle legitimately creates: a reset link, and the legal records
 * activation writes. Each is allowed only in the state that produces it; every other dependent is
 * never deletable for any kind.
 */
const AUTH_LIFECYCLE_DEPENDENTS = new Set<Dependent>([
  "resetTokens",
  "legalRecords",
]);

const FOREIGN_DEPENDENTS = DEPENDENT_RELATIONS.filter(
  (relation) => !AUTH_LIFECYCLE_DEPENDENTS.has(relation),
);

function none(relations: readonly Dependent[]): Prisma.UserWhereInput {
  return Object.fromEntries(
    relations.map((relation) => [relation, { none: {} }]),
  ) as Prisma.UserWhereInput;
}

/**
 * The state registration leaves an account in, as a filter.
 *
 * Repeated in the delete itself, so an account that changed between being read and being deleted
 * survives instead of being removed on the strength of a stale read.
 */
const REGISTRATION_STATE: Prisma.UserWhereInput = {
  emailVerifiedAt: null,
  role: UserRole.USER,
  plan: UserPlan.FREE,
  stripeCustomerId: null,
  sessionVersion: 0,
  billingSubscription: { is: null },
  ...none(DEPENDENT_RELATIONS),
};

/**
 * Session versions an activated `authmail` account can hold: activation installs a password and
 * increments once (0 → 1), and the suite's one reset increments again (1 → 2). Nothing in the
 * lifecycle signs out everywhere, so a higher version is refused.
 */
const AUTH_LIFECYCLE_SESSION_VERSIONS: readonly number[] = [1, 2];

/** Exactly the rows activation writes (`acceptanceRows`, surface `EMAIL_ACTIVATION`). */
const ACTIVATION_LEGAL_RECORDS = LEGAL_ACCEPTANCE_BUNDLE.map(
  ({ kind, record }) => ({
    documentKind: kind as LegalDocumentKind,
    record: record as LegalRecordKind,
  }),
);

/** The two states of the email lifecycle, as one filter, repeated in the delete. */
const AUTH_LIFECYCLE_STATE: Prisma.UserWhereInput = {
  role: UserRole.USER,
  plan: UserPlan.FREE,
  stripeCustomerId: null,
  billingSubscription: { is: null },
  ...none(FOREIGN_DEPENDENTS),
  OR: [
    {
      // Pending: registered, possibly mailed, never activated.
      emailVerifiedAt: null,
      passwordHash: null,
      sessionVersion: 0,
      resetTokens: { none: {} },
      legalRecords: { none: {} },
    },
    {
      // Activated: through the emailed link, and possibly reset once since.
      emailVerifiedAt: { not: null },
      passwordHash: { not: null },
      sessionVersion: { in: [...AUTH_LIFECYCLE_SESSION_VERSIONS] },
      verificationTokens: { none: {} },
      legalRecords: {
        every: {
          surface: LegalAcceptanceSurface.EMAIL_ACTIVATION,
          OR: ACTIVATION_LEGAL_RECORDS,
        },
      },
    },
  ],
};

/** What the cleanup reads about one candidate account. Never logged as a whole. */
type Candidate = {
  readonly id: string;
  readonly email: string;
  readonly emailVerifiedAt: Date | null;
  readonly hasPassword: boolean;
  readonly role: UserRole;
  readonly plan: UserPlan;
  readonly stripeCustomerId: string | null;
  readonly sessionVersion: number;
  readonly hasBillingSubscription: boolean;
  readonly namedByWebhook: boolean;
  readonly verificationTokens: number;
  readonly counts: Readonly<Record<Dependent, number>>;
  readonly legalRecords: readonly {
    readonly documentKind: LegalDocumentKind;
    readonly record: LegalRecordKind;
    readonly surface: LegalAcceptanceSurface;
  }[];
};

/**
 * One kind's cleanup rule, twice: as the reasons an account is refused (empty when it may be
 * deleted), and as the filter the delete repeats so a stale read can never remove a changed row.
 */
type CleanupPolicy = {
  readonly refusals: (account: Candidate) => string[];
  readonly deletable: Prisma.UserWhereInput;
};

function dependentRefusals(
  account: Candidate,
  relations: readonly Dependent[],
): string[] {
  return relations.flatMap((relation) =>
    account.counts[relation] > 0
      ? [`${DEPENDENTS[relation]}: ${account.counts[relation]}`]
      : [],
  );
}

/** What disqualifies an account of any kind: privilege, money, another identity, product data. */
function neverDeletable(account: Candidate): string[] {
  const reasons: string[] = [];
  if (account.role !== UserRole.USER) {
    reasons.push(`role ${account.role}`);
  }
  if (account.plan !== UserPlan.FREE) {
    reasons.push(`plan ${account.plan}`);
  }
  if (account.stripeCustomerId !== null) {
    reasons.push("has a Stripe customer");
  }
  if (account.hasBillingSubscription) {
    reasons.push("has a billing subscription");
  }
  reasons.push(...dependentRefusals(account, FOREIGN_DEPENDENTS));
  if (account.namedByWebhook) {
    reasons.push("named by a Stripe webhook event");
  }
  return reasons;
}

/** Whether the legal records are exactly one activation's acceptance, and nothing else. */
function isActivationAcceptance(records: Candidate["legalRecords"]): boolean {
  return (
    records.length === ACTIVATION_LEGAL_RECORDS.length &&
    ACTIVATION_LEGAL_RECORDS.every(
      (expected) =>
        records.filter(
          (row) =>
            row.documentKind === expected.documentKind &&
            row.record === expected.record &&
            row.surface === LegalAcceptanceSurface.EMAIL_ACTIVATION,
        ).length === 1,
    )
  );
}

const CLEANUP_POLICIES: Readonly<
  Record<E2eDisposableAccountKind, CleanupPolicy>
> = {
  /** Unchanged since PR #86: the registration state and nothing else. */
  escalation: {
    refusals: (account) => {
      const reasons: string[] = [];
      if (account.emailVerifiedAt !== null) {
        reasons.push("email verified");
      }
      if (account.role !== UserRole.USER) {
        reasons.push(`role ${account.role}`);
      }
      if (account.plan !== UserPlan.FREE) {
        reasons.push(`plan ${account.plan}`);
      }
      if (account.stripeCustomerId !== null) {
        reasons.push("has a Stripe customer");
      }
      if (account.hasBillingSubscription) {
        reasons.push("has a billing subscription");
      }
      if (account.sessionVersion !== 0) {
        reasons.push(
          `sessions revoked (session version ${account.sessionVersion})`,
        );
      }
      reasons.push(...dependentRefusals(account, DEPENDENT_RELATIONS));
      if (account.namedByWebhook) {
        reasons.push("named by a Stripe webhook event");
      }
      return reasons;
    },
    deletable: REGISTRATION_STATE,
  },

  authmail: {
    refusals: (account) => {
      const reasons = neverDeletable(account);
      if (account.emailVerifiedAt === null) {
        if (account.hasPassword) {
          reasons.push("pending with a password (registration sets none)");
        }
        if (account.sessionVersion !== 0) {
          reasons.push(
            `pending with sessions revoked (session version ${account.sessionVersion})`,
          );
        }
        if (account.counts.resetTokens > 0) {
          reasons.push("pending with a password-reset link");
        }
        if (account.counts.legalRecords > 0) {
          reasons.push(
            `pending with legal records: ${account.counts.legalRecords}`,
          );
        }
        return reasons;
      }

      if (!account.hasPassword) {
        reasons.push("verified without a password");
      }
      if (!AUTH_LIFECYCLE_SESSION_VERSIONS.includes(account.sessionVersion)) {
        reasons.push(
          `session version ${account.sessionVersion} (activation leaves 1, one reset 2)`,
        );
      }
      if (account.verificationTokens > 0) {
        reasons.push("verified with an outstanding activation link");
      }
      if (!isActivationAcceptance(account.legalRecords)) {
        reasons.push(
          `legal records other than its activation acceptance: ${account.legalRecords.length}`,
        );
      }
      return reasons;
    },
    deletable: AUTH_LIFECYCLE_STATE,
  },
};

/** What the cleanup needs of a client: a `PrismaClient`, or a transaction on one. */
export type E2eAccountCleanupClient = Pick<
  PrismaClient,
  "$queryRaw" | "user" | "stripeWebhookEvent"
>;

export type E2eDisposableAccountOutcome = {
  readonly email: string;
  readonly kind: E2eDisposableAccountKind;
};

export type E2eRefusedAccount = E2eDisposableAccountOutcome & {
  readonly reasons: readonly string[];
};

export type E2eAccountPruneResult = {
  readonly databaseName: string;
  readonly dryRun: boolean;
  /** Removed — or, on a dry run, eligible to be. */
  readonly pruned: readonly E2eDisposableAccountOutcome[];
  /** Disposable addresses in a state their kind's policy does not allow; left untouched. */
  readonly refused: readonly E2eRefusedAccount[];
};

/**
 * Deletes every disposable E2E account its kind's policy allows, from `target` only.
 *
 * Idempotent: a second call finds nothing to delete and refuses exactly what the first refused.
 * The only rows removed besides the accounts are what cascades from an allowed state — activation
 * and reset links, and the legal records an `authmail` activation wrote; every other dependent
 * makes the account ineligible.
 */
export async function pruneE2eDisposableAccounts(
  prisma: E2eAccountCleanupClient,
  target: E2eAccountCleanupTarget,
  options: { readonly dryRun?: boolean; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<E2eAccountPruneResult> {
  // Guarded here as well as at the entry point, so no caller can reach the delete without it.
  assertNotProduction(options.env ?? process.env);
  const dryRun = options.dryRun ?? false;

  const [connected] = await prisma.$queryRaw<{ name: string }[]>`
    SELECT current_database() AS name`;
  if (connected?.name !== target.databaseName) {
    throw new E2eAccountCleanupRefusedError(
      `Refusing to prune E2E accounts: the server answered as \`${connected?.name ?? "unknown"}\`, ` +
        `not the test database \`${target.databaseName}\` the URL names.`,
    );
  }

  // A coarse, indexable prefilter; the anchored pattern below is the decision.
  const candidates = await prisma.user.findMany({
    where: {
      OR: E2E_DISPOSABLE_ACCOUNT_KINDS.map((kind) => ({
        email: {
          startsWith: `${kind}-`,
          endsWith: `@${E2E_DISPOSABLE_ACCOUNT_DOMAIN}`,
        },
      })),
    },
    select: {
      id: true,
      email: true,
      emailVerifiedAt: true,
      passwordHash: true,
      role: true,
      plan: true,
      stripeCustomerId: true,
      sessionVersion: true,
      billingSubscription: { select: { id: true } },
      legalRecords: {
        select: { documentKind: true, record: true, surface: true },
      },
      _count: {
        select: {
          verificationTokens: true,
          ...(Object.fromEntries(
            DEPENDENT_RELATIONS.map((relation) => [relation, true]),
          ) as Record<Dependent, true>),
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const owned = candidates.flatMap((account) => {
    const kind = e2eDisposableAccountKindOf(account.email);
    return kind === null ? [] : [{ ...account, kind }];
  });

  const webhookReferences = new Set(
    (
      await prisma.stripeWebhookEvent.findMany({
        where: { userId: { in: owned.map((account) => account.id) } },
        select: { userId: true },
      })
    ).map((event) => event.userId),
  );

  const refused: E2eRefusedAccount[] = [];
  const eligible: (E2eDisposableAccountOutcome & { readonly id: string })[] =
    [];
  for (const account of owned) {
    const { verificationTokens, ...counts } = account._count;
    const reasons = CLEANUP_POLICIES[account.kind].refusals({
      id: account.id,
      email: account.email,
      emailVerifiedAt: account.emailVerifiedAt,
      // Only whether one exists is ever looked at.
      hasPassword: account.passwordHash !== null,
      role: account.role,
      plan: account.plan,
      stripeCustomerId: account.stripeCustomerId,
      sessionVersion: account.sessionVersion,
      hasBillingSubscription: account.billingSubscription !== null,
      namedByWebhook: webhookReferences.has(account.id),
      verificationTokens,
      counts,
      legalRecords: account.legalRecords,
    });

    const outcome = { email: account.email, kind: account.kind };
    if (reasons.length > 0) {
      refused.push({ ...outcome, reasons });
    } else {
      eligible.push({ ...outcome, id: account.id });
    }
  }

  if (dryRun || eligible.length === 0) {
    return {
      databaseName: target.databaseName,
      dryRun,
      pruned: eligible.map(({ email, kind }) => ({ email, kind })),
      refused,
    };
  }

  const ids = eligible.map((account) => account.id);
  for (const kind of E2E_DISPOSABLE_ACCOUNT_KINDS) {
    const ofKind = eligible
      .filter((account) => account.kind === kind)
      .map((account) => account.id);
    if (ofKind.length > 0) {
      await prisma.user.deleteMany({
        where: { id: { in: ofKind }, ...CLEANUP_POLICIES[kind].deletable },
      });
    }
  }
  const survivors = new Set(
    (
      await prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true },
      })
    ).map((account) => account.id),
  );
  for (const account of eligible) {
    if (survivors.has(account.id)) {
      refused.push({
        email: account.email,
        kind: account.kind,
        reasons: ["changed while it was being pruned"],
      });
    }
  }

  return {
    databaseName: target.databaseName,
    dryRun,
    pruned: eligible
      .filter((account) => !survivors.has(account.id))
      .map(({ email, kind }) => ({ email, kind })),
    refused,
  };
}
