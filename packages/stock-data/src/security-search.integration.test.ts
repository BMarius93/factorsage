import { randomUUID } from "node:crypto";
import { PrismaClient, SecurityType } from "@intrinsic/database";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaStockDataStore } from "./prisma-store.js";

// Before any PrismaClient in this file is constructed.
useTestDatabase();

/**
 * Persistence half of the global stock search: the store must reach both symbol prefixes and name
 * substrings case-insensitively. Relevance ordering lives in `security-search.test.ts`.
 */

const prisma = new PrismaClient();
// Every fixture shares one random infix so the suite can match and clean up only its own rows in a
// database other suites are writing to concurrently.
const tag = randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();

const FIXTURES = [
  { symbol: `Z${tag}A`, name: `Zephyr ${tag} Apple Holdings` },
  { symbol: `Z${tag}B`, name: `Advanced ${tag} Micro Systems` },
  { symbol: `Q${tag}C`, name: `Quiet ${tag} Unrelated Corp` },
];

async function searchRows(term: string, limit = 25) {
  const store = new PrismaStockDataStore(prisma);
  return store.searchSecurities({ term, limit });
}

async function search(term: string, limit = 25) {
  return (await searchRows(term, limit)).map((result) => result.symbol);
}

describe("security search persistence", () => {
  beforeAll(async () => {
    for (const fixture of FIXTURES) {
      await prisma.security.create({
        data: {
          providerSymbol: fixture.symbol,
          symbol: fixture.symbol,
          name: fixture.name,
          exchangeCode: "NASDAQ",
          exchangeName: "NASDAQ Global Select",
          currency: "USD",
          type: SecurityType.STOCK,
          isAdr: false,
          isActivelyTrading: true,
        },
      });
    }
  });

  afterAll(async () => {
    await prisma.security.deleteMany({
      where: { providerSymbol: { in: FIXTURES.map((row) => row.symbol) } },
    });
    await prisma.$disconnect();
  });

  it("carries the persisted mark of a profiled security, and omits it for the rest", async () => {
    const profiled = await prisma.security.findFirstOrThrow({
      where: { providerSymbol: `Z${tag}A` },
    });
    await prisma.securityProfile.create({
      data: {
        securityId: profiled.id,
        logoUrl: `https://images.financialmodelingprep.com/symbol/Z${tag}A.png`,
      },
    });

    const rows = await searchRows(`z${tag.toLowerCase()}`);

    // One query, both facts: the search read joins the profile rather than leaving the caller to
    // fan out a second request per row.
    expect(rows.find((row) => row.symbol === `Z${tag}A`)?.logoUrl).toBe(
      `https://images.financialmodelingprep.com/symbol/Z${tag}A.png`,
    );
    // Absent, not empty: a security the catalog has not profiled reports nothing rather than
    // claiming it has no logo.
    expect(rows.find((row) => row.symbol === `Z${tag}B`)).not.toHaveProperty(
      "logoUrl",
    );
  });

  it("matches a symbol prefix case-insensitively", async () => {
    await expect(search(`z${tag.toLowerCase()}`)).resolves.toEqual([
      `Z${tag}A`,
      `Z${tag}B`,
    ]);
  });

  it("matches a name substring case-insensitively", async () => {
    await expect(search(`micro systems`)).resolves.toContain(`Z${tag}B`);
  });

  it("does not match a symbol infix", async () => {
    await expect(search(`${tag}A`)).resolves.not.toContain(`Z${tag}A`);
  });

  it("returns nothing for a term no security matches", async () => {
    await expect(search(`${tag}NOSUCHSECURITY`)).resolves.toEqual([]);
  });

  it("returns nothing for a blank term instead of the whole universe", async () => {
    await expect(search("   ")).resolves.toEqual([]);
  });

  it("applies the requested candidate limit", async () => {
    await expect(search(tag, 1)).resolves.toHaveLength(1);
  });
});
