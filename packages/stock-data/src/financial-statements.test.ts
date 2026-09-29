import { randomUUID } from "node:crypto";
import { PrismaClient, SecurityType } from "@intrinsic/database";
import { useTestDatabase } from "@intrinsic/testing";
import { describe, expect, it } from "vitest";
import { PrismaStockDataStore } from "./prisma-store.js";

// Before any PrismaClient in this file is constructed.
useTestDatabase();

function statement(overrides: Record<string, unknown> = {}) {
  return {
    securityId: "security-1",
    statementType: "INCOME" as const,
    fiscalDate: "2020-03-31",
    fiscalYear: 2020,
    period: "Q1" as const,
    reportedCurrency: "USD",
    filingDate: "2020-04-20",
    values: { revenue: 100 },
    ...overrides,
  };
}

describe("financial statement persistence", () => {
  it("deduplicates unchanged rows and keeps the initial PIT availability one day after filing", async () => {
    const prisma = new PrismaClient();
    const suffix = randomUUID();
    const symbol = `F${suffix.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    let securityId: string | undefined;
    try {
      const security = await prisma.security.create({
        data: {
          providerSymbol: symbol,
          symbol,
          name: "Financial Statement Dedup Corp",
          exchangeCode: "NASDAQ",
          currency: "USD",
          type: SecurityType.STOCK,
          isAdr: false,
          isActivelyTrading: true,
        },
      });
      securityId = security.id;
      const store = new PrismaStockDataStore(prisma);

      await expect(
        store.saveFinancialStatements({
          securityId,
          statements: [statement({ securityId })],
          syncedAt: "2020-04-20T16:00:00.000Z",
        }),
      ).resolves.toEqual({ insertedRevisionCount: 1, unchangedCount: 0 });

      await expect(
        store.saveFinancialStatements({
          securityId,
          statements: [statement({ securityId })],
          syncedAt: "2020-04-21T16:00:00.000Z",
        }),
      ).resolves.toEqual({ insertedRevisionCount: 0, unchangedCount: 1 });

      await expect(
        store.getFinancialStatements(securityId, {
          cadence: "QUARTERLY",
          asOf: "2020-04-20",
        }),
      ).resolves.toEqual([]);
      await expect(
        store.getFinancialStatements(securityId, {
          cadence: "QUARTERLY",
          asOf: "2020-04-21",
        }),
      ).resolves.toHaveLength(1);
    } finally {
      if (securityId) {
        await prisma.security.deleteMany({ where: { id: securityId } });
      }
      await prisma.$disconnect();
    }
  });

  it("preserves filing-date revisions and prevents same-filing-date changes from backdating before observedAt", async () => {
    const prisma = new PrismaClient();
    const suffix = randomUUID();
    const symbol = `R${suffix.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    let securityId: string | undefined;
    try {
      const security = await prisma.security.create({
        data: {
          providerSymbol: symbol,
          symbol,
          name: "Financial Statement Revision Corp",
          exchangeCode: "NASDAQ",
          currency: "USD",
          type: SecurityType.STOCK,
          isAdr: false,
          isActivelyTrading: true,
        },
      });
      securityId = security.id;
      const store = new PrismaStockDataStore(prisma);

      await store.saveFinancialStatements({
        securityId,
        statements: [
          statement({
            securityId,
            filingDate: "2020-04-20",
            reportedCurrency: "USD",
            values: { revenue: 100 },
          }),
        ],
        syncedAt: "2020-04-20T16:00:00.000Z",
      });
      await store.saveFinancialStatements({
        securityId,
        statements: [
          statement({
            securityId,
            filingDate: "2020-05-20",
            values: { revenue: 200 },
          }),
        ],
        syncedAt: "2020-05-21T16:00:00.000Z",
      });

      await expect(
        store.getFinancialStatements(securityId, {
          cadence: "QUARTERLY",
        }),
      ).resolves.toMatchObject([{ values: { revenue: 200 } }]);
      await expect(
        store.getFinancialStatements(securityId, {
          cadence: "QUARTERLY",
          asOf: "2020-05-01",
        }),
      ).resolves.toMatchObject([{ values: { revenue: 100 } }]);

      await store.saveFinancialStatements({
        securityId,
        statements: [
          statement({
            securityId,
            filingDate: "2020-04-20",
            values: { revenue: 300 },
          }),
        ],
        syncedAt: "2020-04-25T16:00:00.000Z",
      });

      await expect(
        store.getFinancialStatements(securityId, {
          cadence: "QUARTERLY",
          asOf: "2020-04-24",
        }),
      ).resolves.toMatchObject([{ values: { revenue: 100 } }]);
      await expect(
        store.getFinancialStatements(securityId, {
          cadence: "QUARTERLY",
          asOf: "2020-04-25",
        }),
      ).resolves.toMatchObject([{ values: { revenue: 300 } }]);
    } finally {
      if (securityId) {
        await prisma.security.deleteMany({ where: { id: securityId } });
      }
      await prisma.$disconnect();
    }
  });

  it("treats changed content with an earlier filing date as observed-later availability", async () => {
    const prisma = new PrismaClient();
    const suffix = randomUUID();
    const symbol = `E${suffix.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    let securityId: string | undefined;
    try {
      const security = await prisma.security.create({
        data: {
          providerSymbol: symbol,
          symbol,
          name: "Financial Statement Earlier Filing Corp",
          exchangeCode: "NASDAQ",
          currency: "USD",
          type: SecurityType.STOCK,
          isAdr: false,
          isActivelyTrading: true,
        },
      });
      securityId = security.id;
      const store = new PrismaStockDataStore(prisma);

      await store.saveFinancialStatements({
        securityId,
        statements: [
          statement({
            securityId,
            filingDate: "2020-05-20",
            values: { revenue: 200 },
          }),
        ],
        syncedAt: "2020-05-21T16:00:00.000Z",
      });

      await store.saveFinancialStatements({
        securityId,
        statements: [
          statement({
            securityId,
            filingDate: "2020-04-20",
            values: { revenue: 300 },
          }),
        ],
        syncedAt: "2020-06-01T09:00:00.000Z",
      });

      await expect(
        store.getFinancialStatements(securityId, {
          cadence: "QUARTERLY",
          asOf: "2020-05-31",
        }),
      ).resolves.toMatchObject([{ values: { revenue: 200 } }]);
      await expect(
        store.getFinancialStatements(securityId, {
          cadence: "QUARTERLY",
          asOf: "2020-06-01",
        }),
      ).resolves.toMatchObject([{ values: { revenue: 300 } }]);
    } finally {
      if (securityId) {
        await prisma.security.deleteMany({ where: { id: securityId } });
      }
      await prisma.$disconnect();
    }
  });

  it("applies same-filing multi-revision batch availability against planned revisions", async () => {
    const prisma = new PrismaClient();
    const suffix = randomUUID();
    const symbol = `M${suffix.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    let securityId: string | undefined;
    try {
      const security = await prisma.security.create({
        data: {
          providerSymbol: symbol,
          symbol,
          name: "Financial Statement Multi Revision Corp",
          exchangeCode: "NASDAQ",
          currency: "USD",
          type: SecurityType.STOCK,
          isAdr: false,
          isActivelyTrading: true,
        },
      });
      securityId = security.id;
      const store = new PrismaStockDataStore(prisma);

      await expect(
        store.saveFinancialStatements({
          securityId,
          statements: [
            statement({
              securityId,
              filingDate: "2020-04-20",
              values: { revenue: 100 },
            }),
            statement({
              securityId,
              filingDate: "2020-04-20",
              values: { revenue: 150 },
            }),
          ],
          syncedAt: "2020-05-10T10:30:00.000Z",
        }),
      ).resolves.toEqual({ insertedRevisionCount: 2, unchangedCount: 0 });

      const rows = await prisma.financialStatement.findMany({
        where: { securityId },
        orderBy: [{ observedAt: "asc" }, { contentHash: "asc" }],
      });
      expect(rows).toHaveLength(2);
      expect(
        rows
          .map((row) => row.availableFromDate.toISOString().slice(0, 10))
          .sort(),
      ).toEqual(["2020-04-21", "2020-05-10"]);

      await expect(
        store.getFinancialStatements(securityId, {
          cadence: "QUARTERLY",
          asOf: "2020-05-09",
        }),
      ).resolves.toMatchObject([{ values: { revenue: 100 } }]);
      await expect(
        store.getFinancialStatements(securityId, {
          cadence: "QUARTERLY",
          asOf: "2020-05-10",
        }),
      ).resolves.toMatchObject([{ values: { revenue: 150 } }]);
    } finally {
      if (securityId) {
        await prisma.security.deleteMany({ where: { id: securityId } });
      }
      await prisma.$disconnect();
    }
  });

  describe("a fiscal period whose period end moves", () => {
    /** One throwaway security per case, removed with its statements afterwards. */
    async function withSecurity(
      name: string,
      body: (securityId: string, store: PrismaStockDataStore) => Promise<void>,
    ): Promise<void> {
      const prisma = new PrismaClient();
      const suffix = randomUUID();
      const symbol = `D${suffix.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
      let securityId: string | undefined;
      try {
        const security = await prisma.security.create({
          data: {
            providerSymbol: symbol,
            symbol,
            name,
            exchangeCode: "NASDAQ",
            currency: "USD",
            type: SecurityType.STOCK,
            isAdr: false,
            isActivelyTrading: true,
          },
        });
        securityId = security.id;
        await body(securityId, new PrismaStockDataStore(prisma));
      } finally {
        if (securityId) {
          await prisma.security.deleteMany({ where: { id: securityId } });
        }
        await prisma.$disconnect();
      }
    }

    async function availability(
      store: PrismaStockDataStore,
      securityId: string,
    ): Promise<Record<string, string>> {
      const revisions = await store.getFinancialStatementRevisions({
        securityId,
      });
      return Object.fromEntries(
        revisions.map((revision) => [
          revision.fiscalDate,
          revision.availableFromDate,
        ]),
      );
    }

    it("dates a moved period end without a newer filing from its observation, never from the original filing", async () => {
      // Q1 2020 ends 2020-03-31, filed 2020-04-20, public 2020-04-21. On 2020-06-01 the provider
      // reports it with its period end moved — earlier or later — and the same filing date.
      for (const movedTo of ["2020-03-28", "2020-04-03"]) {
        await withSecurity(
          "Moved Period End Corp",
          async (securityId, store) => {
            await store.saveFinancialStatements({
              securityId,
              statements: [statement({ securityId, values: { revenue: 100 } })],
              syncedAt: "2020-04-21T16:00:00.000Z",
            });
            await store.saveFinancialStatements({
              securityId,
              statements: [
                statement({
                  securityId,
                  fiscalDate: movedTo,
                  values: { revenue: 300 },
                }),
              ],
              syncedAt: "2020-06-01T09:00:00.000Z",
            });

            await expect(availability(store, securityId)).resolves.toEqual({
              "2020-03-31": "2020-04-21",
              [movedTo]: "2020-06-01",
            });
            await expect(
              store.getFinancialStatements(securityId, {
                cadence: "QUARTERLY",
                asOf: "2020-05-31",
              }),
            ).resolves.toMatchObject([
              { fiscalDate: "2020-03-31", values: { revenue: 100 } },
            ]);
          },
        );
      }
    });

    it("keeps a moved period end that carries a newer filing public from that filing", async () => {
      await withSecurity(
        "Moved Period End Refiled Corp",
        async (securityId, store) => {
          await store.saveFinancialStatements({
            securityId,
            statements: [statement({ securityId, values: { revenue: 100 } })],
            syncedAt: "2020-04-21T16:00:00.000Z",
          });
          await store.saveFinancialStatements({
            securityId,
            statements: [
              statement({
                securityId,
                fiscalDate: "2020-03-28",
                filingDate: "2020-05-20",
                values: { revenue: 300 },
              }),
            ],
            syncedAt: "2020-06-01T09:00:00.000Z",
          });

          await expect(availability(store, securityId)).resolves.toEqual({
            "2020-03-31": "2020-04-21",
            "2020-03-28": "2020-05-21",
          });
        },
      );
    });

    it("dates both period ends of a first sync from their filing, whatever the provider order", async () => {
      // A fiscal period seen for the first time: nothing was public before, so the provider's
      // filing date stands for each row, and the order of the response decides nothing.
      const rows = (securityId: string) => [
        statement({ securityId, values: { revenue: 100 } }),
        statement({
          securityId,
          fiscalDate: "2020-03-28",
          values: { revenue: 300 },
        }),
      ];
      for (const reversed of [false, true]) {
        await withSecurity(
          "First Sync Two Period Ends Corp",
          async (securityId, store) => {
            const statements = rows(securityId);
            await store.saveFinancialStatements({
              securityId,
              statements: reversed ? [...statements].reverse() : statements,
              syncedAt: "2020-06-01T09:00:00.000Z",
            });

            await expect(availability(store, securityId)).resolves.toEqual({
              "2020-03-31": "2020-04-21",
              "2020-03-28": "2020-04-21",
            });
          },
        );
      }
    });

    it("judges every row of one sync against earlier syncs only, never against each other", async () => {
      // Two moved period ends of a stored quarter arrive together, each with a filing newer than the
      // stored one. Judged against the other row of the same sync, whichever comes second would
      // look like an old filing and be dated from the observation instead.
      for (const reversed of [false, true]) {
        await withSecurity(
          "Moved Period End Batch Corp",
          async (securityId, store) => {
            await store.saveFinancialStatements({
              securityId,
              statements: [statement({ securityId, values: { revenue: 100 } })],
              syncedAt: "2020-04-21T16:00:00.000Z",
            });
            const batch = [
              statement({
                securityId,
                fiscalDate: "2020-03-28",
                filingDate: "2020-05-20",
                values: { revenue: 200 },
              }),
              statement({
                securityId,
                fiscalDate: "2020-04-03",
                filingDate: "2020-05-10",
                values: { revenue: 300 },
              }),
            ];
            await store.saveFinancialStatements({
              securityId,
              statements: reversed ? [...batch].reverse() : batch,
              syncedAt: "2020-06-01T09:00:00.000Z",
            });

            await expect(availability(store, securityId)).resolves.toEqual({
              "2020-03-31": "2020-04-21",
              "2020-03-28": "2020-05-21",
              "2020-04-03": "2020-05-11",
            });
          },
        );
      }
    });

    it("judges two filings of one quarter in one sync against earlier syncs only, whatever the provider order", async () => {
      // Q1 2020 arrives with its original filing (2020-04-20) and a later amendment (2020-05-20)
      // in one response. Each filing was public the day after it was filed; neither may be judged
      // against the other merely because the provider listed the newer one first — that would date
      // the original from this sync's observation and erase it from every session in between.
      for (const reversed of [false, true]) {
        await withSecurity("Same Sync Amendment Corp", async (securityId, store) => {
          const batch = [
            statement({ securityId, values: { revenue: 100 } }),
            statement({
              securityId,
              filingDate: "2020-05-20",
              values: { revenue: 150 },
            }),
          ];
          await store.saveFinancialStatements({
            securityId,
            statements: reversed ? [...batch].reverse() : batch,
            syncedAt: "2026-09-01T12:00:00.000Z",
          });

          const revisions = await store.getFinancialStatementRevisions({
            securityId,
          });
          expect(
            Object.fromEntries(
              revisions.map((revision) => [
                revision.filingDate,
                revision.availableFromDate,
              ]),
            ),
            reversed ? "newer filing first" : "older filing first",
          ).toEqual({ "2020-04-20": "2020-04-21", "2020-05-20": "2020-05-21" });
          // Between the two filings the original is what was public.
          await expect(
            store.getFinancialStatements(securityId, {
              cadence: "QUARTERLY",
              asOf: "2020-05-01",
            }),
          ).resolves.toMatchObject([{ values: { revenue: 100 } }]);
        });
      }
    });

    it("still dates a same-filing correction of a stored quarter from its observation", async () => {
      // The other half of the rule, unchanged: a stored quarter whose content changes without a
      // newer filing date is a correction first observed now.
      await withSecurity("Silent Correction Corp", async (securityId, store) => {
        await store.saveFinancialStatements({
          securityId,
          statements: [statement({ securityId, values: { revenue: 100 } })],
          syncedAt: "2020-04-21T16:00:00.000Z",
        });
        await store.saveFinancialStatements({
          securityId,
          statements: [
            statement({ securityId, values: { revenue: 120 } }),
            statement({ securityId, values: { revenue: 130 } }),
          ],
          syncedAt: "2020-09-01T09:00:00.000Z",
        });
        const revisions = await store.getFinancialStatementRevisions({
          securityId,
        });
        expect(
          revisions
            .map((revision) => [
              (revision.values as { revenue: number }).revenue,
              revision.availableFromDate,
            ])
            .sort(),
        ).toEqual([
          [100, "2020-04-21"],
          [120, "2020-09-01"],
          [130, "2020-09-01"],
        ]);
      });
    });

    it("never lets a period-end placeholder that moved pose as a newer filing", async () => {
      // FMP gives the period end as the filing date when it holds none (AUD-03): Q3 FY2018 ends and
      // is "filed" on 2018-06-30, so it is dated at its statutory deadline, public 2018-08-15. On
      // 2026-10-15 the quarter comes back with its period end moved, and the placeholder moves
      // with it: that is no newer filing, whichever way the period end moved.
      for (const movedTo of ["2018-07-03", "2018-06-27"]) {
        await withSecurity(
          "Moved Placeholder Period End Corp",
          async (securityId, store) => {
            const placeholder = (fiscalDate: string, revenue: number) =>
              statement({
                securityId,
                fiscalYear: 2018,
                period: "Q3",
                fiscalDate,
                filingDate: fiscalDate,
                values: { revenue },
              });
            await store.saveFinancialStatements({
              securityId,
              statements: [placeholder("2018-06-30", 100)],
              syncedAt: "2018-08-20T16:00:00.000Z",
            });
            await store.saveFinancialStatements({
              securityId,
              statements: [placeholder(movedTo, 300)],
              syncedAt: "2026-10-15T09:00:00.000Z",
            });

            await expect(availability(store, securityId)).resolves.toEqual({
              "2018-06-30": "2018-08-15",
              [movedTo]: "2026-10-15",
            });
          },
        );
      }
    });

    it("trusts a real filing of a moved period end only once it is later than the stored placeholder's deadline", async () => {
      for (const [filingDate, expected] of [
        ["2018-09-01", "2018-09-02"],
        ["2018-08-10", "2026-10-15"],
      ] as const) {
        await withSecurity(
          "Moved Period End Real Filing Corp",
          async (securityId, store) => {
            await store.saveFinancialStatements({
              securityId,
              statements: [
                statement({
                  securityId,
                  fiscalYear: 2018,
                  period: "Q3",
                  fiscalDate: "2018-06-30",
                  filingDate: "2018-06-30",
                  values: { revenue: 100 },
                }),
              ],
              syncedAt: "2018-08-20T16:00:00.000Z",
            });
            await store.saveFinancialStatements({
              securityId,
              statements: [
                statement({
                  securityId,
                  fiscalYear: 2018,
                  period: "Q3",
                  fiscalDate: "2018-07-03",
                  filingDate,
                  values: { revenue: 300 },
                }),
              ],
              syncedAt: "2026-10-15T09:00:00.000Z",
            });

            await expect(
              availability(store, securityId),
              filingDate,
            ).resolves.toEqual({
              "2018-06-30": "2018-08-15",
              "2018-07-03": expected,
            });
          },
        );
      }
    });
  });

  it("reads statement revisions within both bounds of a fiscal-date range", async () => {
    const prisma = new PrismaClient();
    const suffix = randomUUID();
    const symbol = `R${suffix.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    let securityId: string | undefined;
    try {
      const security = await prisma.security.create({
        data: {
          providerSymbol: symbol,
          symbol,
          name: "Revision Range Read Corp",
          exchangeCode: "NASDAQ",
          currency: "USD",
          type: SecurityType.STOCK,
          isAdr: false,
          isActivelyTrading: true,
        },
      });
      securityId = security.id;
      const store = new PrismaStockDataStore(prisma);
      await store.saveFinancialStatements({
        securityId,
        statements: [2022, 2023, 2024, 2025, 2026].map((fiscalYear) =>
          statement({
            securityId,
            fiscalYear,
            fiscalDate: `${fiscalYear}-03-31`,
            filingDate: `${fiscalYear}-04-20`,
          }),
        ),
        syncedAt: "2026-04-21T16:00:00.000Z",
      });

      const fiscalYears = async (range: { from?: string; to?: string }) =>
        (
          await store.getFinancialStatementRevisions({
            securityId: securityId!,
            statementType: "INCOME",
            cadence: "QUARTERLY",
            ...range,
          })
        ).map((row) => row.fiscalYear);

      // Both bounds at once: the derived rebuild boundary of a refresh is read this way, one
      // changed fiscal year at a time, and must not reach back to the first filing ever stored.
      await expect(
        fiscalYears({ from: "2024-01-01", to: "2025-12-31" }),
      ).resolves.toEqual([2024, 2025]);
      await expect(fiscalYears({ from: "2025-01-01" })).resolves.toEqual([
        2025, 2026,
      ]);
      await expect(fiscalYears({ to: "2022-12-31" })).resolves.toEqual([2022]);
      await expect(fiscalYears({})).resolves.toEqual([
        2022, 2023, 2024, 2025, 2026,
      ]);
    } finally {
      if (securityId) {
        await prisma.security.deleteMany({ where: { id: securityId } });
      }
      await prisma.$disconnect();
    }
  });

  it("computes contentHash independently of securityId", async () => {
    const prisma = new PrismaClient();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
    const symbolA = `H${suffix}A`;
    const symbolB = `H${suffix}B`;
    let securityIdA: string | undefined;
    let securityIdB: string | undefined;
    try {
      const [securityA, securityB] = await Promise.all([
        prisma.security.create({
          data: {
            providerSymbol: symbolA,
            symbol: symbolA,
            name: "Financial Statement Hash A",
            exchangeCode: "NASDAQ",
            currency: "USD",
            type: SecurityType.STOCK,
            isAdr: false,
            isActivelyTrading: true,
          },
        }),
        prisma.security.create({
          data: {
            providerSymbol: symbolB,
            symbol: symbolB,
            name: "Financial Statement Hash B",
            exchangeCode: "NASDAQ",
            currency: "USD",
            type: SecurityType.STOCK,
            isAdr: false,
            isActivelyTrading: true,
          },
        }),
      ]);
      securityIdA = securityA.id;
      securityIdB = securityB.id;
      const store = new PrismaStockDataStore(prisma);

      await store.saveFinancialStatements({
        securityId: securityIdA,
        statements: [statement({ securityId: securityIdA })],
        syncedAt: "2020-04-20T16:00:00.000Z",
      });
      await store.saveFinancialStatements({
        securityId: securityIdB,
        statements: [statement({ securityId: securityIdB })],
        syncedAt: "2020-04-20T16:00:00.000Z",
      });

      const [rowA, rowB] = await Promise.all([
        prisma.financialStatement.findFirst({
          where: { securityId: securityIdA },
        }),
        prisma.financialStatement.findFirst({
          where: { securityId: securityIdB },
        }),
      ]);
      expect(rowA?.contentHash).toBeTruthy();
      expect(rowA?.contentHash).toBe(rowB?.contentHash);
    } finally {
      if (securityIdA) {
        await prisma.security.deleteMany({ where: { id: securityIdA } });
      }
      if (securityIdB) {
        await prisma.security.deleteMany({ where: { id: securityIdB } });
      }
      await prisma.$disconnect();
    }
  });

  it("rejects statements whose securityId does not match the save input securityId", async () => {
    const prisma = new PrismaClient();
    const suffix = randomUUID();
    const symbol = `S${suffix.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    let securityId: string | undefined;
    try {
      const security = await prisma.security.create({
        data: {
          providerSymbol: symbol,
          symbol,
          name: "Financial Statement Security Mismatch Corp",
          exchangeCode: "NASDAQ",
          currency: "USD",
          type: SecurityType.STOCK,
          isAdr: false,
          isActivelyTrading: true,
        },
      });
      securityId = security.id;
      const store = new PrismaStockDataStore(prisma);

      await expect(
        store.saveFinancialStatements({
          securityId,
          statements: [statement({ securityId: "different-security" })],
          syncedAt: "2020-04-20T16:00:00.000Z",
        }),
      ).rejects.toThrow("Financial statement securityId mismatch");
    } finally {
      if (securityId) {
        await prisma.security.deleteMany({ where: { id: securityId } });
      }
      await prisma.$disconnect();
    }
  });
});
