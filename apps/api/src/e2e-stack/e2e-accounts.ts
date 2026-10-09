import {
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
 * 3. *Which state* — only the account registration leaves behind: never verified, `USER` on
 *    `FREE`, no Stripe customer, no revoked session, and nothing depending on it but its own
 *    activation link. An address of a declared kind in any other state is **refused**, not
 *    deleted, and the command exits non-zero: a disposable account holding `ADMIN` or `PRO` would be
 *    the exact escalation the spec exists to rule out, and deleting it would destroy the evidence.
 *
 * A password hash is allowed either way. Registration before AUTH-003 took a password and stored
 * its hash on the pending row; since AUTH-003 it stores none. Both are pending accounts nobody can
 * sign in to, and both are what this spec created in its time.
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
 * Relations that may hold nothing for a disposable account, and how a refusal names them.
 *
 * Every relation of `User` except `verificationTokens` — registration issues exactly one activation
 * link, and it cascades with the account. `billingSubscription` (one-to-one) and
 * `StripeWebhookEvent.userId` (no foreign key) are checked separately. Each `SET NULL` relation
 * (`updated*`) is here too, so a delete never silently rewrites a row someone else owns.
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
  ...(Object.fromEntries(
    DEPENDENT_RELATIONS.map((relation) => [relation, { none: {} }]),
  ) as Prisma.UserWhereInput),
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
  /** Disposable addresses in a state registration cannot produce; left untouched. */
  readonly refused: readonly E2eRefusedAccount[];
};

/**
 * Deletes every disposable E2E account still in its registration state, from `target` only.
 *
 * Idempotent: a second call finds nothing to delete and refuses exactly what the first refused.
 * The only rows removed besides the accounts are their activation links, through the
 * `EmailVerificationToken` cascade; every other dependent makes the account ineligible.
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
      role: true,
      plan: true,
      stripeCustomerId: true,
      sessionVersion: true,
      billingSubscription: { select: { id: true } },
      _count: {
        select: Object.fromEntries(
          DEPENDENT_RELATIONS.map((relation) => [relation, true]),
        ) as Record<Dependent, true>,
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
    if (account.billingSubscription !== null) {
      reasons.push("has a billing subscription");
    }
    if (account.sessionVersion !== 0) {
      reasons.push(
        `sessions revoked (session version ${account.sessionVersion})`,
      );
    }
    for (const relation of DEPENDENT_RELATIONS) {
      const count = account._count[relation];
      if (count > 0) {
        reasons.push(`${DEPENDENTS[relation]}: ${count}`);
      }
    }
    if (webhookReferences.has(account.id)) {
      reasons.push("named by a Stripe webhook event");
    }

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
  await prisma.user.deleteMany({
    where: { id: { in: ids }, ...REGISTRATION_STATE },
  });
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
