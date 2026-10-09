import { randomInt, randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import {
  type Prisma,
  PrismaClient,
  UserPlan,
  UserRole,
} from "@intrinsic/database";
import { e2eDisposableAccountEmail, useTestDatabase } from "@intrinsic/testing";
import { afterAll, describe, expect, it } from "vitest";
import {
  E2eAccountCleanupRefusedError,
  pruneE2eDisposableAccounts,
  type E2eAccountCleanupTarget,
  type E2eAccountPruneResult,
} from "./e2e-accounts";

loadRootEnv();
const testDatabaseUrl = useTestDatabase();

/**
 * The disposable-account cleanup against the real test database: what it deletes, what it refuses,
 * what it never looks at, and that it is idempotent.
 *
 * **Every case runs inside a transaction that is rolled back.** The accounts staged here include
 * states the cleanup must refuse — an escalation address holding `ADMIN` — and a refused account
 * makes the E2E global setup stop. Committed, a crash between staging and cleanup would leave one
 * behind for the next Playwright run to trip over; rolled back, nothing here ever becomes visible
 * outside this suite. Accounts an earlier E2E run left are seen and deleted too, inside the same
 * transaction, so every assertion is scoped to this suite's own addresses.
 */
describe("pruneE2eDisposableAccounts", () => {
  const prisma = new PrismaClient();
  const target: E2eAccountCleanupTarget = {
    databaseUrl: testDatabaseUrl,
    databaseName: decodeURIComponent(
      new URL(testDatabaseUrl).pathname.replace(/^\//, ""),
    ),
  };

  afterAll(async () => {
    await prisma.$disconnect();
  });

  class RolledBack extends Error {}

  /** Runs `body` in a transaction and always rolls it back. */
  async function rolledBack(
    body: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<void> {
    await expect(
      prisma.$transaction(
        async (tx) => {
          await body(tx);
          throw new RolledBack();
        },
        { timeout: 30_000 },
      ),
    ).rejects.toBeInstanceOf(RolledBack);
  }

  /** A stamp no real run produces: 16 digits, where `Date.now()` has 13. */
  function stamp(): number {
    return 8_000_000_000_000_000 + randomInt(0, 1_000_000_000_000) * 1_000;
  }

  type Staged = {
    readonly eligible: Record<"pending" | "preAuth003", string>;
    readonly refused: Record<string, { email: string; reasons: string[] }>;
    readonly nearMisses: string[];
    readonly ids: Map<string, string>;
    readonly outsiderListId: string;
  };

  /** Every state the cleanup distinguishes, under addresses only this suite uses. */
  async function stage(tx: Prisma.TransactionClient): Promise<Staged> {
    const base = stamp();
    let next = 0;
    const email = () => e2eDisposableAccountEmail("escalation", base + next++);
    const ids = new Map<string, string>();

    // Exactly what `POST /auth/register` leaves: pending, no password, one activation link.
    async function registered(
      address: string,
      extra: Omit<Prisma.UserCreateInput, "email" | "verificationTokens"> = {},
    ): Promise<string> {
      const user = await tx.user.create({
        data: {
          email: address,
          verificationTokens: {
            create: {
              tokenHash: randomUUID(),
              expiresAt: new Date(Date.now() + 86_400_000),
            },
          },
          ...extra,
        },
        select: { id: true },
      });
      ids.set(address, user.id);
      return user.id;
    }

    const pending = email();
    await registered(pending);
    const preAuth003 = email();
    // Registration before AUTH-003 stored the submitted password's hash on the pending row.
    await registered(preAuth003, {
      passwordHash: "$argon2id$v=19$m=65536,t=3,p=4$staged$staged",
    });

    const refused: Staged["refused"] = {};
    async function refuse(
      label: string,
      reasons: string[],
      extra: Omit<Prisma.UserCreateInput, "email" | "verificationTokens"> = {},
    ): Promise<string> {
      const address = email();
      const id = await registered(address, extra);
      refused[label] = { email: address, reasons };
      return id;
    }

    await refuse("verified", ["email verified"], {
      emailVerifiedAt: new Date(),
    });
    await refuse("admin", ["role ADMIN"], { role: UserRole.ADMIN });
    await refuse("pro", ["plan PRO"], { plan: UserPlan.PRO });
    await refuse("stripe", ["has a Stripe customer"], {
      stripeCustomerId: `cus_staged_${base}`,
    });
    await refuse("revoked", ["sessions revoked (session version 1)"], {
      sessionVersion: 1,
    });
    await refuse("owner", ["stock lists: 1"], {
      stockLists: { create: { name: `E2E accounts staged ${base}` } },
    });
    await refuse("reset", ["password-reset links: 1"], {
      resetTokens: {
        create: {
          tokenHash: randomUUID(),
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      },
    });
    const editor = await refuse("editor", ["stock lists it last edited: 1"]);
    const outsider = await tx.user.create({
      data: {
        email: `e2e-accounts-outsider-${base}@example.test`,
        stockLists: {
          create: {
            name: `E2E accounts outsider ${base}`,
            updatedByUserId: editor,
          },
        },
      },
      select: { stockLists: { select: { id: true } } },
    });
    const webhook = await refuse("webhook", [
      "named by a Stripe webhook event",
    ]);
    await tx.stripeWebhookEvent.create({
      data: {
        stripeEventId: `evt_staged_${base}`,
        type: "customer.subscription.updated",
        stripeCreatedAt: new Date(),
        userId: webhook,
        outcome: "applied",
      },
    });

    // Registration-shaped accounts whose addresses are not a declared kind: never touched.
    const nearMisses = [
      `escalation-${base}x@example.test`,
      `escalation-${base}@example.test.evil`,
      `escalation-${base}@sub.example.test`,
      `xescalation-${base}@example.test`,
      `escalation-${base}-1@example.test`,
    ];
    for (const address of nearMisses) {
      await registered(address);
    }

    return {
      eligible: { pending, preAuth003 },
      refused,
      nearMisses,
      ids,
      outsiderListId: outsider.stockLists[0]!.id,
    };
  }

  function own(staged: Staged, result: E2eAccountPruneResult) {
    const mine = new Set(staged.ids.keys());
    return {
      pruned: result.pruned
        .filter((account) => mine.has(account.email))
        .map((account) => account.email)
        .sort(),
      refused: Object.fromEntries(
        result.refused
          .filter((account) => mine.has(account.email))
          .map((account) => [account.email, account.reasons]),
      ),
    };
  }

  function expectedRefusals(staged: Staged) {
    return Object.fromEntries(
      Object.values(staged.refused).map(({ email, reasons }) => [
        email,
        reasons,
      ]),
    );
  }

  it("previews without deleting anything", async () => {
    await rolledBack(async (tx) => {
      const staged = await stage(tx);
      const preview = await pruneE2eDisposableAccounts(tx, target, {
        dryRun: true,
      });

      expect(preview.dryRun).toBe(true);
      expect(own(staged, preview)).toEqual({
        pruned: Object.values(staged.eligible).sort(),
        refused: expectedRefusals(staged),
      });
      expect(
        await tx.user.count({
          where: { id: { in: [...staged.ids.values()] } },
        }),
      ).toBe(staged.ids.size);
    });
  });

  it("deletes exactly the registration-state accounts, refuses the rest, and is idempotent", async () => {
    await rolledBack(async (tx) => {
      const staged = await stage(tx);
      const eligibleIds = Object.values(staged.eligible).map((email) =>
        staged.ids.get(email)!,
      );

      const first = await pruneE2eDisposableAccounts(tx, target);
      expect(own(staged, first)).toEqual({
        pruned: Object.values(staged.eligible).sort(),
        refused: expectedRefusals(staged),
      });
      // Nothing of a declared kind survives unless it was refused.
      expect(
        first.pruned.every((account) =>
          /^escalation-\d+@example\.test$/.test(account.email),
        ),
      ).toBe(true);

      // The accounts are gone, and their activation links went with them (the only cascade).
      expect(await tx.user.count({ where: { id: { in: eligibleIds } } })).toBe(
        0,
      );
      expect(
        await tx.emailVerificationToken.count({
          where: { userId: { in: eligibleIds } },
        }),
      ).toBe(0);

      // Every refused and every near-miss account is untouched, with what depends on it.
      const untouched = [...staged.ids]
        .filter(([email]) => !Object.values(staged.eligible).includes(email))
        .map(([, id]) => id);
      expect(await tx.user.count({ where: { id: { in: untouched } } })).toBe(
        untouched.length,
      );
      expect(
        await tx.emailVerificationToken.count({
          where: { userId: { in: untouched } },
        }),
      ).toBe(untouched.length);
      const outsiderList = await tx.stockList.findUniqueOrThrow({
        where: { id: staged.outsiderListId },
        select: { updatedByUserId: true },
      });
      expect(outsiderList.updatedByUserId).toBe(
        staged.ids.get(staged.refused.editor!.email),
      );

      // A second pass finds nothing left to delete and refuses exactly the same accounts.
      const second = await pruneE2eDisposableAccounts(tx, target);
      expect(second.pruned).toEqual([]);
      expect(own(staged, second)).toEqual({
        pruned: [],
        refused: expectedRefusals(staged),
      });
    });
  });

  it("refuses a server that is not the named test database before reading a row", async () => {
    await rolledBack(async (tx) => {
      const staged = await stage(tx);
      await expect(
        pruneE2eDisposableAccounts(tx, {
          ...target,
          databaseName: "intrinsic_value",
        }),
      ).rejects.toBeInstanceOf(E2eAccountCleanupRefusedError);
      expect(
        await tx.user.count({
          where: { id: { in: [...staged.ids.values()] } },
        }),
      ).toBe(staged.ids.size);
    });
  });

  it("refuses to run under NODE_ENV=production", async () => {
    await rolledBack(async (tx) => {
      const staged = await stage(tx);
      await expect(
        pruneE2eDisposableAccounts(tx, target, {
          env: { NODE_ENV: "production" },
        }),
      ).rejects.toThrow(/NODE_ENV is production/);
      expect(
        await tx.user.count({
          where: { id: { in: [...staged.ids.values()] } },
        }),
      ).toBe(staged.ids.size);
    });
  });

  /**
   * Deleting a `User` reaches every row that references it, so the cleanup's eligibility check has
   * to know every such reference. A new one is a new way for an account to own or have touched
   * something: decide whether it makes a disposable account ineligible — add it to `DEPENDENTS` in
   * `e2e-accounts.ts` — and only then add it here. `EmailVerificationToken` is the one reference a
   * disposable account may hold, and `BillingSubscription` is checked on its own.
   */
  it("accounts for every foreign key that references User", async () => {
    const rows = await prisma.$queryRaw<{ reference: string }[]>`
      SELECT replace(c.conrelid::regclass::text, '"', '') || '.' || a.attname || ' ' ||
             CASE c.confdeltype WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' ELSE 'OTHER' END
             AS reference
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f' AND c.confrelid = '"User"'::regclass`;

    expect(rows.map((row) => row.reference).sort()).toEqual(
      [
        "ActorGroup.updatedByUserId SET NULL",
        "ActorGroup.userId CASCADE",
        "BacktestRun.userId CASCADE",
        "BillingSubscription.userId CASCADE",
        "EmailVerificationToken.userId CASCADE",
        "LegalRecord.userId CASCADE",
        "LegalRequest.userId CASCADE",
        "Monitor.updatedByUserId SET NULL",
        "Monitor.userId CASCADE",
        "OAuthAccount.userId CASCADE",
        "PasswordResetToken.userId CASCADE",
        "RecentSecurityView.userId CASCADE",
        "StockList.updatedByUserId SET NULL",
        "StockList.userId CASCADE",
        "Strategy.updatedByUserId SET NULL",
        "Strategy.userId CASCADE",
        "UserBuiltInMonitorPreference.userId CASCADE",
      ].sort(),
    );
  });
});
