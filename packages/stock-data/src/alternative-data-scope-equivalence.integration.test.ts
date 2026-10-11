import { randomUUID } from "node:crypto";
import {
  CONGRESS_MEASURES,
  strategyDefinitionFingerprint,
  type ActorScope,
  type AlternativeDataMetric,
  type CongressChamberFilter,
  type CongressMeasure,
  type CongressOwner,
  type StrategyDefinition,
} from "@intrinsic/contracts";
import { PrismaClient } from "@intrinsic/database";
import {
  alternativeDataAvailabilityDate,
  type DailyPrice,
  type Security,
} from "@intrinsic/domain";
import type { MappedFmpCongressTrade } from "@intrinsic/fmp";
import {
  alternativeDataOperand,
  collectOperands,
  Evaluability,
  evaluateLevelWithoutPosition,
  monitorStrategyLevels,
  simulateBacktest,
  type AlternativeDataFacts,
  type BacktestResult,
  type EvaluationFrame,
  type OperandKey,
} from "@intrinsic/strategy";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaAlternativeDataStore } from "./alternative-data-prisma-store.js";
import {
  CanonicalAlternativeDataService,
  type AlternativeDataProvider,
} from "./alternative-data-service.js";
import { projectEvaluationFrame } from "./evaluation-frame.js";

useTestDatabase();

/**
 * Old against new: a rule scoped to a Congress **group** holding members A, B and C, and the same
 * rule **selecting** A, B and C itself.
 *
 * The claim under test is that the two are the same rule — not similar, the same: every column
 * value on every session, and therefore every trade a backtest makes and every outcome a Monitor
 * decides. It is proved on the path the product runs, with nothing mocked below the provider:
 * disclosures are ingested through `CanonicalAlternativeDataService` into real PostgreSQL, read back
 * by the real store with the real `actorId IN (…)` filter, projected by `projectEvaluationFrame`,
 * and executed by the pure engine in `@intrinsic/strategy`.
 *
 * A group is resolved two ways in the product and both are compared: from the database as it
 * stands, which is what a live Monitor does, and from a membership frozen in a backtest snapshot.
 *
 * The data is generated from a fixed seed so the suite is deterministic, and it is deliberately
 * unkind: members outside the selection trading the same stock, both chambers, every disclosed
 * owner, non-stock assets, disclosures landing on weekends and holidays, several members disclosing
 * on one session, one member filing twice in a day and the same trade disclosed again later. A
 * comparison that passes on quiet data proves little, so each case also asserts that the selection
 * *matters* — that the scoped reading differs from the unscoped one.
 */

// ---------------------------------------------------------------------------
// The session axis
// ---------------------------------------------------------------------------

const HOLIDAYS = new Set([
  "2022-01-17",
  "2022-02-21",
  "2022-04-15",
  "2022-05-30",
  "2022-06-20",
  "2022-07-04",
  "2022-09-05",
  "2022-11-24",
  "2022-12-26",
  "2023-01-02",
  "2023-01-16",
  "2023-02-20",
  "2023-04-07",
  "2023-05-29",
  "2023-06-19",
  "2023-07-04",
  "2023-09-04",
  "2023-11-23",
  "2023-12-25",
  "2024-01-01",
  "2024-01-15",
  "2024-02-19",
  "2024-03-29",
  "2024-05-27",
  "2024-06-19",
  "2024-07-04",
  "2024-09-02",
  "2024-11-28",
  "2024-12-25",
]);

const DAY_MS = 86_400_000;
const AXIS_FROM = "2022-01-03";
const AXIS_TO = "2024-12-31";

function isoOf(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  return isoOf(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS);
}

/** Every NYSE session from 2022 to 2024: the frame's own axis, weekends and holidays absent. */
const SESSIONS: readonly string[] = (() => {
  const sessions: string[] = [];
  for (
    let time = Date.parse(`${AXIS_FROM}T00:00:00.000Z`);
    time <= Date.parse(`${AXIS_TO}T00:00:00.000Z`);
    time += DAY_MS
  ) {
    const day = new Date(time).getUTCDay();
    const date = isoOf(time);
    if (day !== 0 && day !== 6 && !HOLIDAYS.has(date)) {
      sessions.push(date);
    }
  }
  return sessions;
})();

/** A deterministic generator, so the "random" disclosures are the same on every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

describe("a group of A, B and C and a selection of A, B and C are the same rule", () => {
  const suffix = randomUUID();
  const short = suffix.slice(0, 6).toUpperCase();
  /** The last successful ingest: the coverage ceiling, just past the axis. */
  const now = new Date("2025-01-02T12:00:00.000Z");

  /** A, B and C are selected; D and E trade the same stocks and are not. */
  const MEMBERS = {
    A: { externalId: `EQ-A-${suffix}`, chamber: "HOUSE" },
    B: { externalId: `EQ-B-${suffix}`, chamber: "SENATE" },
    C: { externalId: `EQ-C-${suffix}`, chamber: "HOUSE" },
    D: { externalId: `EQ-D-${suffix}`, chamber: "HOUSE" },
    E: { externalId: `EQ-E-${suffix}`, chamber: "SENATE" },
  } as const;
  type MemberKey = keyof typeof MEMBERS;

  let prisma: PrismaClient;
  let store: PrismaAlternativeDataStore;
  let service: CanonicalAlternativeDataService;
  /** A security with hundreds of generated disclosures. */
  let bulk: Security;
  /** A security holding exactly the hand-placed disclosures of the worked example. */
  let precise: Security;
  /** Canonical actor ids by member. */
  const actorId = {} as Record<MemberKey, string>;
  /** A group in the database holding A, B and C, and a second holding only A. */
  let groupId = "";
  let soloGroupId = "";

  const pagesBySymbol = new Map<
    string,
    Record<"SENATE" | "HOUSE", MappedFmpCongressTrade[]>
  >();

  const provider: AlternativeDataProvider = {
    async getInsiderTrades() {
      return { providerRowCount: 0, rows: [] };
    },
    async getCongressTrades(input) {
      const rows =
        input.page === 0
          ? (pagesBySymbol.get(input.symbol)?.[input.chamber] ?? [])
          : [];
      return { providerRowCount: rows.length, rows };
    },
  };

  let sequence = 0;
  function disclosure(
    symbol: string,
    member: MemberKey,
    overrides: Partial<MappedFmpCongressTrade> & { disclosureDate: string },
  ): MappedFmpCongressTrade {
    sequence += 1;
    return {
      providerSymbol: symbol,
      chamber: MEMBERS[member].chamber,
      actorExternalId: MEMBERS[member].externalId,
      actorDisplayName: `Member ${member} ${short}`,
      transactionDate: addDays(overrides.disclosureDate, -30),
      availableFromDate: alternativeDataAvailabilityDate(
        overrides.disclosureDate,
      ),
      kind: "PURCHASE",
      transactionTypeRaw: "Purchase",
      owner: "SELF",
      ownerRaw: "Self",
      assetClass: "STOCK",
      assetTypeRaw: "Stock",
      amountRangeRaw: "$15,001 - $50,000",
      amountLowerBound: 15_001,
      amountUpperBound: 50_000,
      // Unique per row: the payload carries no line identity, and two rows identical in every
      // meaningful field collapse into one on ingest.
      sourceUrl: `https://disclosures.example.test/${suffix}/${sequence}`,
      raw: { fixture: sequence },
      ...overrides,
    };
  }

  const OWNERS: readonly { owner: CongressOwner; raw?: string }[] = [
    { owner: "SELF", raw: "Self" },
    { owner: "SPOUSE", raw: "Spouse" },
    { owner: "JOINT", raw: "Joint" },
    { owner: "UNSPECIFIED" },
  ];
  const BANDS = [
    { raw: "$1,001 - $15,000", lower: 1_001, upper: 15_000 },
    { raw: "$15,001 - $50,000", lower: 15_001, upper: 50_000 },
    { raw: "$100,001 - $250,000", lower: 100_001, upper: 250_000 },
    { raw: "Over $50,000,000", lower: 50_000_000, upper: undefined },
  ] as const;

  /** Generated disclosures for the bulk security: every dimension a rule can filter on, mixed. */
  function generateBulk(symbol: string): MappedFmpCongressTrade[] {
    const random = seeded(20261011);
    const pick = <T>(values: readonly T[]): T =>
      values[Math.floor(random() * values.length)] as T;
    const spanDays = Math.round(
      (Date.parse("2024-12-20T00:00:00.000Z") -
        Date.parse("2022-02-01T00:00:00.000Z")) /
        DAY_MS,
    );
    const rows: MappedFmpCongressTrade[] = [];
    const perMember: Record<MemberKey, number> = {
      A: 70,
      B: 70,
      C: 50,
      D: 55,
      E: 45,
    };
    for (const member of Object.keys(perMember) as MemberKey[]) {
      for (let count = 0; count < perMember[member]; count += 1) {
        // Any calendar day, weekends and holidays included: the availability rule and the session
        // axis are what turn it into the session a rule first reads it on.
        const disclosureDate = addDays(
          "2022-02-01",
          Math.floor(random() * spanDays),
        );
        const roll = random();
        const kind =
          roll < 0.48 ? "PURCHASE" : roll < 0.96 ? "SALE" : "EXCHANGE";
        const owner = pick(OWNERS);
        const band = pick(BANDS);
        const asset =
          random() < 0.9 ? "STOCK" : random() < 0.5 ? "BOND" : "STOCK_OPTION";
        rows.push(
          disclosure(symbol, member, {
            disclosureDate,
            transactionDate: addDays(
              disclosureDate,
              -(5 + Math.floor(random() * 80)),
            ),
            kind,
            transactionTypeRaw:
              kind === "PURCHASE"
                ? "Purchase"
                : kind === "SALE"
                  ? "Sale (Partial)"
                  : "Exchange",
            owner: owner.owner,
            ...(owner.raw === undefined
              ? { ownerRaw: undefined }
              : { ownerRaw: owner.raw }),
            assetClass: asset,
            assetTypeRaw:
              asset === "STOCK"
                ? "Stock"
                : asset === "BOND"
                  ? "Corporate Bond"
                  : "Stock Option",
            amountRangeRaw: band.raw,
            amountLowerBound: band.lower,
            amountUpperBound: band.upper,
          }),
        );
      }
    }
    // The overlaps a pooled metric has to get right, placed deliberately rather than left to chance:
    rows.push(
      // A, B and C all disclose a purchase on one day…
      disclosure(symbol, "A", { disclosureDate: "2023-06-13" }),
      disclosure(symbol, "B", { disclosureDate: "2023-06-13" }),
      disclosure(symbol, "C", { disclosureDate: "2023-06-13" }),
      // …A files two separate purchases on the same day…
      disclosure(symbol, "A", {
        disclosureDate: "2023-09-12",
        amountRangeRaw: "$1,001 - $15,000",
        amountLowerBound: 1_001,
        amountUpperBound: 15_000,
      }),
      disclosure(symbol, "A", {
        disclosureDate: "2023-09-12",
        amountRangeRaw: "$100,001 - $250,000",
        amountLowerBound: 100_001,
        amountUpperBound: 250_000,
      }),
      // …and B's sale is disclosed, then disclosed again a year later.
      disclosure(symbol, "B", {
        disclosureDate: "2023-03-15",
        transactionDate: "2023-02-10",
        kind: "SALE",
        transactionTypeRaw: "Sale (Full)",
      }),
      disclosure(symbol, "B", {
        disclosureDate: "2024-03-20",
        transactionDate: "2023-02-10",
        kind: "SALE",
        transactionTypeRaw: "Sale",
      }),
      // An early disclosure by somebody outside the selection, which sets the coverage floor at the
      // start of the axis so a 250-session window has a year of history to sit inside.
      disclosure(symbol, "D", {
        disclosureDate: "2022-01-03",
        assetClass: "BOND",
        assetTypeRaw: "Corporate Bond",
      }),
    );
    return rows;
  }

  /**
   * The worked example, alone on its own security:
   *
   * - A traded on Mon 2024-03-04 and disclosed on Fri 2024-04-12, so it is usable from Sat 04-13 and
   *   first read on Mon 04-15.
   * - B traded on Wed 2024-04-10 and disclosed on Fri 2024-04-19: usable Sat 04-20, read Mon 04-22.
   * - E, who is not selected, discloses a purchase in between.
   */
  function generatePrecise(symbol: string): MappedFmpCongressTrade[] {
    return [
      disclosure(symbol, "A", {
        disclosureDate: "2024-04-12",
        transactionDate: "2024-03-04",
        amountRangeRaw: "$1,000,001 - $5,000,000",
        amountLowerBound: 1_000_001,
        amountUpperBound: 5_000_000,
      }),
      disclosure(symbol, "B", {
        disclosureDate: "2024-04-19",
        transactionDate: "2024-04-10",
      }),
      disclosure(symbol, "E", { disclosureDate: "2024-04-16" }),
      disclosure(symbol, "D", {
        disclosureDate: "2022-01-03",
        assetClass: "BOND",
        assetTypeRaw: "Corporate Bond",
      }),
    ];
  }

  async function createSecurity(label: string): Promise<Security> {
    const row = await prisma.security.create({
      data: {
        providerSymbol: `EQ-${label}-${suffix}`,
        symbol: `EQ${label}${short}`,
        name: `Scope Equivalence ${label}`,
        exchangeCode: "NASDAQ",
        currency: "USD",
        type: "STOCK",
        isAdr: false,
        isActivelyTrading: true,
      },
    });
    return {
      id: row.id,
      symbol: row.symbol,
      name: row.name,
      exchangeCode: row.exchangeCode,
      currency: row.currency,
      type: "STOCK",
      isAdr: false,
      isActivelyTrading: true,
    };
  }

  function byChamber(
    rows: readonly MappedFmpCongressTrade[],
  ): Record<"SENATE" | "HOUSE", MappedFmpCongressTrade[]> {
    return {
      SENATE: rows.filter((row) => row.chamber === "SENATE"),
      HOUSE: rows.filter((row) => row.chamber === "HOUSE"),
    };
  }

  beforeAll(async () => {
    prisma = new PrismaClient();
    store = new PrismaAlternativeDataStore(prisma);
    service = new CanonicalAlternativeDataService(store, provider, {
      freshnessMs: 60_000,
      maxPagesPerIngest: 4,
      now: () => now,
    });
    bulk = await createSecurity("B");
    precise = await createSecurity("P");
    pagesBySymbol.set(bulk.symbol, byChamber(generateBulk(bulk.symbol)));
    pagesBySymbol.set(
      precise.symbol,
      byChamber(generatePrecise(precise.symbol)),
    );
    // The real ingest: actors are created on first sight and every row is content-addressed.
    await service.ensureIngested(bulk, ["CONGRESS"]);
    await service.ensureIngested(precise, ["CONGRESS"]);

    const actors = await prisma.alternativeDataActor.findMany({
      where: { externalId: { contains: suffix } },
      select: { id: true, externalId: true },
    });
    for (const member of Object.keys(MEMBERS) as MemberKey[]) {
      actorId[member] = actors.find(
        (actor) => actor.externalId === MEMBERS[member].externalId,
      )?.id as string;
    }

    const createGroup = async (key: string, members: readonly MemberKey[]) =>
      (
        await prisma.actorGroup.create({
          data: {
            ownership: "SYSTEM",
            systemKey: `eq-${key}-${suffix}`,
            name: `Equivalence ${key}`,
            members: {
              create: members.map((member, index) => ({
                actorId: actorId[member],
                createdAt: new Date(now.getTime() + index),
              })),
            },
          },
        })
      ).id;
    groupId = await createGroup("abc", ["A", "B", "C"]);
    soloGroupId = await createGroup("a", ["A"]);
  });

  afterAll(async () => {
    if (!prisma) {
      return;
    }
    await prisma.actorGroup.deleteMany({
      where: { systemKey: { contains: suffix } },
    });
    for (const security of [bulk, precise]) {
      if (security) {
        await prisma.congressTrade.deleteMany({
          where: { securityId: security.id },
        });
        await prisma.stockDatasetState.deleteMany({
          where: { securityId: security.id },
        });
      }
    }
    await prisma.alternativeDataActor.deleteMany({
      where: { externalId: { contains: suffix } },
    });
    await prisma.security.deleteMany({
      where: { providerSymbol: { contains: suffix } },
    });
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const GROUP = (): ActorScope => ({ kind: "GROUP", groupId });
  /** Deliberately out of order and with A repeated: the same selection, badly written. */
  const SELECTION = (): ActorScope => ({
    kind: "ACTORS",
    actorIds: [actorId.C, actorId.A, actorId.B, actorId.A],
  });
  const frozenMembers = async (requested: string) =>
    requested === groupId
      ? [actorId.A, actorId.B, actorId.C]
      : requested === soloGroupId
        ? [actorId.A]
        : [];

  function metric(
    scope: ActorScope,
    measure: CongressMeasure = "PURCHASES",
    lookback: AlternativeDataMetric["lookback"] = 30,
    chamber: CongressChamberFilter = "ANY",
    owners?: readonly CongressOwner[],
  ): AlternativeDataMetric {
    return {
      kind: "CONGRESS_ACTIVITY",
      measure,
      lookback,
      scope,
      chamber,
      ...(owners ? { owners } : {}),
    };
  }

  async function factsFor(
    security: Security,
    operands: readonly OperandKey[],
    resolution: "LIVE" | "FROZEN",
  ): Promise<Map<OperandKey, AlternativeDataFacts>> {
    return service.loadFacts({
      security,
      operands,
      from: SESSIONS[0] as string,
      to: SESSIONS[SESSIONS.length - 1] as string,
      ...(resolution === "FROZEN"
        ? { resolveGroupMembers: frozenMembers }
        : {}),
    });
  }

  /** A close per session, moving enough that fills and valuations are not all one number. */
  function pricesFor(security: Security): DailyPrice[] {
    return SESSIONS.map((date, index) => {
      const close = 100 + 20 * Math.sin(index / 17) + index * 0.05;
      return {
        securityId: security.id,
        date,
        open: close,
        high: close * 1.01,
        low: close * 0.99,
        close,
        volume: 1_000_000,
      };
    });
  }

  async function frameFor(
    security: Security,
    operands: readonly OperandKey[],
    resolution: "LIVE" | "FROZEN",
  ): Promise<EvaluationFrame> {
    return projectEvaluationFrame({
      security,
      prices: pricesFor(security),
      derived: [],
      operands,
      periodStart: SESSIONS[0] as string,
      alternativeData: await factsFor(security, operands, resolution),
    }).frame;
  }

  function columnOf(frame: EvaluationFrame, key: OperandKey): number[] {
    const column = frame.columns.get(key);
    if (!column) {
      throw new Error(`Frame carries no column for ${key}`);
    }
    return [...column];
  }

  const observationKey = (entry: {
    observableFrom: string;
    actorKey: string;
    amount?: number;
  }) => `${entry.observableFrom}|${entry.actorKey}|${entry.amount ?? ""}`;

  // -------------------------------------------------------------------------
  // Columns
  // -------------------------------------------------------------------------

  const LOOKBACKS = [5, 30, 250] as const;
  const CHAMBERS = ["ANY", "HOUSE", "SENATE"] as const;
  const OWNER_FILTERS: readonly (readonly CongressOwner[] | undefined)[] = [
    undefined,
    ["SPOUSE"],
    ["SELF", "JOINT"],
  ];

  it("ingested the fixture as designed", async () => {
    const counts = await prisma.congressTrade.groupBy({
      by: ["actorId"],
      where: { securityId: bulk.id },
      _count: { _all: true },
    });
    const byMember = Object.fromEntries(
      (Object.keys(MEMBERS) as MemberKey[]).map((member) => [
        member,
        counts.find((row) => row.actorId === actorId[member])?._count._all ?? 0,
      ]),
    );
    // Every generated row arrived as its own row: nothing collapsed, nothing was dropped.
    expect(byMember).toEqual({ A: 73, B: 73, C: 51, D: 56, E: 45 });
    expect(SESSIONS.length).toBeGreaterThan(740);
  });

  it(
    "reads identical observations and identical columns for every measure, lookback, chamber and owner filter",
    { timeout: 120_000 },
    async () => {
      let configurations = 0;
      let nonZero = 0;
      let differsFromAnyone = 0;

      for (const measure of CONGRESS_MEASURES) {
        for (const lookback of LOOKBACKS) {
          for (const chamber of CHAMBERS) {
            for (const owners of OWNER_FILTERS) {
              const label = `${measure} ${lookback}D ${chamber} ${owners?.join("+") ?? "any owner"}`;
              const keyOf = (scope: ActorScope) =>
                alternativeDataOperand(
                  metric(scope, measure, lookback, chamber, owners),
                );
              const groupKey = keyOf(GROUP());
              const selectionKey = keyOf(SELECTION());
              const anyoneKey = keyOf({ kind: "ANY" });
              const operands = [groupKey, selectionKey, anyoneKey];

              const live = await factsFor(bulk, operands, "LIVE");
              const frozen = await factsFor(bulk, [groupKey], "FROZEN");

              // The same disclosures, row for row. Compared as sets because the store orders by
              // availability date only, and rows sharing a date have no order of their own.
              const selected = live.get(selectionKey)!;
              const expected = selected.observations.map(observationKey).sort();
              expect(
                live.get(groupKey)!.observations.map(observationKey).sort(),
                `${label}: group read from the database`,
              ).toEqual(expected);
              expect(
                frozen.get(groupKey)!.observations.map(observationKey).sort(),
                `${label}: group read from a frozen snapshot`,
              ).toEqual(expected);
              expect(live.get(groupKey)!.coverage).toEqual(selected.coverage);

              // And the same number on every one of the frame's sessions.
              const liveFrame = await frameFor(bulk, operands, "LIVE");
              const frozenFrame = await frameFor(bulk, [groupKey], "FROZEN");
              const selectionColumn = columnOf(liveFrame, selectionKey);
              expect(columnOf(liveFrame, groupKey), label).toEqual(
                selectionColumn,
              );
              expect(columnOf(frozenFrame, groupKey), label).toEqual(
                selectionColumn,
              );

              configurations += 1;
              if (selectionColumn.some((value) => value > 0)) {
                nonZero += 1;
              }
              const anyone = columnOf(liveFrame, anyoneKey);
              if (
                anyone.some(
                  (value, index) =>
                    value !== selectionColumn[index] && !Number.isNaN(value),
                )
              ) {
                differsFromAnyone += 1;
              }
            }
          }
        }
      }

      expect(configurations).toBe(135);
      // The comparison is not passing on empty columns, and the selection is doing real work: in
      // every configuration the members outside it change the unscoped reading.
      expect(nonZero).toBe(135);
      expect(differsFromAnyone).toBe(135);
    },
  );

  it("reads one selected member the same three ways: a group of one, the legacy shape and a selection of one", async () => {
    for (const measure of CONGRESS_MEASURES) {
      const groupKey = alternativeDataOperand(
        metric({ kind: "GROUP", groupId: soloGroupId }, measure),
      );
      const legacyKey = alternativeDataOperand(
        metric({ kind: "ACTOR", actorId: actorId.A }, measure),
      );
      const selectionKey = alternativeDataOperand(
        metric({ kind: "ACTORS", actorIds: [actorId.A] }, measure),
      );
      // The legacy single-member rule and the one-entry selection are one column, not two equal ones.
      expect(selectionKey).toBe(legacyKey);

      const frame = await frameFor(bulk, [groupKey, selectionKey], "LIVE");
      const column = columnOf(frame, selectionKey);
      expect(columnOf(frame, groupKey), measure).toEqual(column);
      expect(column.some((value) => value > 0)).toBe(true);
    }
  });

  it("pools the selected members into one metric rather than evaluating each alone", async () => {
    const pooledKey = alternativeDataOperand(metric(SELECTION(), "PURCHASES"));
    const buyersKey = alternativeDataOperand(metric(SELECTION(), "BUYERS"));
    const valueKey = alternativeDataOperand(
      metric(SELECTION(), "MINIMUM_PURCHASE_VALUE"),
    );
    const alone = (["A", "B", "C"] as const).map((member) => ({
      purchases: alternativeDataOperand(
        metric({ kind: "ACTORS", actorIds: [actorId[member]] }, "PURCHASES"),
      ),
      buyers: alternativeDataOperand(
        metric({ kind: "ACTORS", actorIds: [actorId[member]] }, "BUYERS"),
      ),
      value: alternativeDataOperand(
        metric(
          { kind: "ACTORS", actorIds: [actorId[member]] },
          "MINIMUM_PURCHASE_VALUE",
        ),
      ),
    }));
    const frame = await frameFor(
      bulk,
      [
        pooledKey,
        buyersKey,
        valueKey,
        ...alone.flatMap((keys) => [keys.purchases, keys.buyers, keys.value]),
      ],
      "LIVE",
    );
    const pooled = columnOf(frame, pooledKey);
    const buyers = columnOf(frame, buyersKey);
    const value = columnOf(frame, valueKey);

    let sessionsWhereOnlyThePoolClearsOne = 0;
    for (let index = 0; index < SESSIONS.length; index += 1) {
      if (Number.isNaN(pooled[index])) {
        continue;
      }
      const each = alone.map((keys) => ({
        purchases: columnOf(frame, keys.purchases)[index] as number,
        buyers: columnOf(frame, keys.buyers)[index] as number,
        value: columnOf(frame, keys.value)[index] as number,
      }));
      // Events and amounts add across members; distinct buyers is how many of them bought at all.
      expect(pooled[index]).toBe(
        each.reduce((sum, member) => sum + member.purchases, 0),
      );
      expect(value[index]).toBe(
        each.reduce((sum, member) => sum + member.value, 0),
      );
      expect(buyers[index]).toBe(
        each.filter((member) => member.buyers > 0).length,
      );
      if (
        (pooled[index] as number) > 1 &&
        each.every((member) => member.purchases <= 1)
      ) {
        sessionsWhereOnlyThePoolClearsOne += 1;
      }
    }
    // `Congress purchases is above 1` holds on these sessions and would on none of them if the
    // members were evaluated separately and ORed: no single member's count clears the threshold.
    expect(sessionsWhereOnlyThePoolClearsOne).toBeGreaterThan(20);
  });

  it("counts overlapping disclosures once each: three members on one day, one member twice, one trade twice", async () => {
    const purchases = alternativeDataOperand(
      metric(SELECTION(), "PURCHASES", 5),
    );
    const buyers = alternativeDataOperand(metric(SELECTION(), "BUYERS", 5));
    const sales = alternativeDataOperand(metric(SELECTION(), "SALES", 5));
    const groupPurchases = alternativeDataOperand(
      metric(GROUP(), "PURCHASES", 5),
    );
    const facts = await factsFor(
      bulk,
      [purchases, buyers, sales, groupPurchases],
      "LIVE",
    );
    const on = (key: OperandKey, availableFrom: string, member: MemberKey) =>
      facts
        .get(key)!
        .observations.filter(
          (entry) =>
            entry.observableFrom === availableFrom &&
            entry.actorKey === actorId[member],
        ).length;

    // Disclosed Tue 2023-06-13 by A, B and C: three events, three buyers.
    for (const member of ["A", "B", "C"] as const) {
      expect(on(purchases, "2023-06-14", member)).toBeGreaterThanOrEqual(1);
    }
    // A's two purchases of 2023-09-12 are two events by one buyer.
    expect(on(purchases, "2023-09-13", "A")).toBeGreaterThanOrEqual(2);
    // B's one sale, disclosed in 2023 and again in 2024, is an event on each disclosure.
    expect(on(sales, "2023-03-16", "B")).toBeGreaterThanOrEqual(1);
    expect(on(sales, "2024-03-21", "B")).toBeGreaterThanOrEqual(1);
    // Whatever these count, the group counts the same.
    expect(
      facts.get(groupPurchases)!.observations.map(observationKey).sort(),
    ).toEqual(facts.get(purchases)!.observations.map(observationKey).sort());
  });

  // -------------------------------------------------------------------------
  // The point-in-time boundary
  // -------------------------------------------------------------------------

  it("credits a disclosure on the session after it was published, identically for a group and a selection", async () => {
    const scopes = {
      group: GROUP(),
      selection: SELECTION(),
    };
    const expected: [string, number, number, number][] = [
      // session, purchases, buyers, minimum disclosed value
      ["2024-04-12", 0, 0, 0], // A's disclosure is published today: not yet usable.
      ["2024-04-15", 1, 1, 1_000_001], // First session after it.
      ["2024-04-19", 1, 1, 1_000_001], // B's is published today; E, unselected, is ignored.
      ["2024-04-22", 2, 2, 1_015_002], // Both inside the window.
      ["2024-05-24", 2, 2, 1_015_002], // A's thirtieth and last session.
      ["2024-05-28", 1, 1, 15_001], // After Memorial Day, A has left the window.
    ];
    for (const [name, scope] of Object.entries(scopes)) {
      const purchases = alternativeDataOperand(metric(scope, "PURCHASES"));
      const buyers = alternativeDataOperand(metric(scope, "BUYERS"));
      const value = alternativeDataOperand(
        metric(scope, "MINIMUM_PURCHASE_VALUE"),
      );
      const frame = await frameFor(precise, [purchases, buyers, value], "LIVE");
      const read = (key: OperandKey, date: string) =>
        columnOf(frame, key)[SESSIONS.indexOf(date)];
      for (const [date, events, distinct, amount] of expected) {
        expect(
          [read(purchases, date), read(buyers, date), read(value, date)],
          `${name} on ${date}`,
        ).toEqual([events, distinct, amount]);
      }
      // `Congress purchases is above 1` holds from Mon 04-22 to Fri 05-24 and on no other session.
      const above = columnOf(frame, purchases)
        .map((count, index) => (count > 1 ? SESSIONS[index] : null))
        .filter((date): date is string => date !== null);
      expect(above[0], name).toBe("2024-04-22");
      expect(above[above.length - 1], name).toBe("2024-05-24");
      // Twenty-five sessions: B's disclosure enters on 04-22 and A's leaves after 05-24.
      expect(above, name).toHaveLength(25);
    }
  });

  it("reports the same sessions as not evaluable, never as zero, for a group and a selection", async () => {
    const groupKey = alternativeDataOperand(metric(GROUP(), "PURCHASES", 250));
    const selectionKey = alternativeDataOperand(
      metric(SELECTION(), "PURCHASES", 250),
    );
    const frame = await frameFor(bulk, [groupKey, selectionKey], "LIVE");
    const group = columnOf(frame, groupKey);
    const selection = columnOf(frame, selectionKey);
    const undecidable = selection.filter((value) => Number.isNaN(value)).length;
    // A 250-session window needs 250 sessions of covered history behind it.
    expect(undecidable).toBeGreaterThanOrEqual(249);
    expect(undecidable).toBeLessThan(SESSIONS.length);
    expect(group.map((value) => Number.isNaN(value))).toEqual(
      selection.map((value) => Number.isNaN(value)),
    );
  });

  // -------------------------------------------------------------------------
  // Backtest and Monitor
  // -------------------------------------------------------------------------

  /**
   * One strategy using the scope in all three places a rule can sit:
   *
   * - BUY 100 % when the selected members disclosed any purchase in the last 30 sessions;
   * - SELL 50 % when more than one distinct selected member disclosed a sale in the last 5;
   * - FINAL EXIT when they disclosed more than three sales in the last 30.
   */
  function strategy(scope: ActorScope): StrategyDefinition {
    return {
      schemaVersion: 2,
      buyLevels: [
        {
          id: "buy-1",
          percentage: 100,
          signal: {
            conditions: [
              {
                id: "c-buy",
                metric: metric(scope, "PURCHASES", 30),
                operator: "IS_ABOVE",
                value: { kind: "NUMBER", value: 0 },
              },
            ],
          },
        },
      ],
      sellLevels: [
        {
          id: "sell-1",
          percentage: 50,
          signal: {
            conditions: [
              {
                id: "c-sell",
                metric: metric(scope, "SELLERS", 5),
                operator: "IS_ABOVE",
                value: { kind: "NUMBER", value: 1 },
              },
            ],
          },
        },
      ],
      finalExit: {
        id: "exit-1",
        rules: [
          {
            id: "exit-1",
            signal: {
              conditions: [
                {
                  id: "c-exit",
                  metric: metric(scope, "SALES", 30),
                  operator: "IS_ABOVE",
                  value: { kind: "NUMBER", value: 3 },
                },
              ],
            },
          },
        ],
      },
    };
  }

  const PERIOD = { from: "2022-07-01", to: "2024-12-31" } as const;

  async function backtest(
    definition: StrategyDefinition,
    resolution: "LIVE" | "FROZEN",
  ): Promise<BacktestResult> {
    const frame = await frameFor(bulk, collectOperands(definition), resolution);
    return simulateBacktest({
      definition,
      securities: [{ frame, buyWindows: { mode: "FULL", ranges: [] } }],
      benchmark: null,
      executionCalendar: SESSIONS.filter(
        (date) => date >= PERIOD.from && date <= PERIOD.to,
      ),
      startDate: PERIOD.from,
      endDate: PERIOD.to,
      initialCapital: 100_000,
      monthlyContribution: 500,
      maximumPositions: 1,
    });
  }

  it("executes the same backtest, trade for trade, through BUY, SELL and FINAL EXIT", async () => {
    // The group as a completed run holds it: resolved from a frozen membership.
    const fromGroup = await backtest(strategy(GROUP()), "FROZEN");
    const fromSelection = await backtest(strategy(SELECTION()), "LIVE");

    expect(fromSelection.trades).toEqual(fromGroup.trades);
    expect(fromSelection.equity).toEqual(fromGroup.equity);
    expect(fromSelection.positions).toEqual(fromGroup.positions);
    expect(fromSelection.summary).toEqual(fromGroup.summary);

    // All three level kinds actually traded, so the equality above covers each of them.
    const actions = (result: BacktestResult) =>
      result.trades
        .filter((trade) => trade.source === "STRATEGY")
        .reduce<Record<string, number>>((tally, trade) => {
          tally[trade.action] = (tally[trade.action] ?? 0) + 1;
          return tally;
        }, {});
    const tally = actions(fromSelection);
    expect(tally.BUY).toBeGreaterThan(3);
    expect(tally.SELL).toBeGreaterThan(0);
    expect(tally.FINAL_EXIT).toBeGreaterThan(0);

    // And the selection is what drove it: the same strategy counting every member trades differently.
    const anyone = await backtest(strategy({ kind: "ANY" }), "LIVE");
    expect(anyone.trades).not.toEqual(fromSelection.trades);
  });

  it("decides every Monitor level the same way on every session", async () => {
    const groupLevels = monitorStrategyLevels(strategy(GROUP()));
    const selectionLevels = monitorStrategyLevels(strategy(SELECTION()));
    const groupFrame = await frameFor(
      bulk,
      collectOperands(strategy(GROUP())),
      "LIVE",
    );
    const selectionFrame = await frameFor(
      bulk,
      collectOperands(strategy(SELECTION())),
      "LIVE",
    );

    expect(selectionLevels.map((level) => [level.id, level.kind])).toEqual([
      ["buy-1", "BUY"],
      ["sell-1", "SELL"],
      ["exit-1", "FINAL_EXIT"],
    ]);
    const outcomes: Record<string, Record<string, number>> = {};
    for (const [position, level] of selectionLevels.entries()) {
      const tally: Record<string, number> = {};
      for (let index = 0; index < SESSIONS.length; index += 1) {
        const selected = evaluateLevelWithoutPosition(
          level.rules,
          selectionFrame,
          index,
        );
        expect(
          evaluateLevelWithoutPosition(
            groupLevels[position]!.rules,
            groupFrame,
            index,
          ),
          `${level.id} on ${SESSIONS[index]}`,
        ).toBe(selected);
        tally[selected] = (tally[selected] ?? 0) + 1;
      }
      outcomes[level.id] = tally;
    }
    // Each level was matched, not matched and undecidable somewhere on the axis, so the agreement
    // covers all three outcomes for all three level kinds.
    for (const tally of Object.values(outcomes)) {
      expect(tally[Evaluability.TRUE]).toBeGreaterThan(0);
      expect(tally[Evaluability.FALSE]).toBeGreaterThan(0);
      expect(tally[Evaluability.NOT_EVALUABLE]).toBeGreaterThan(0);
    }
  });

  it("gives the two shapes different fingerprints, which is the one-time Monitor reset a conversion costs", () => {
    const group = monitorStrategyLevels(strategy(GROUP()));
    const selection = monitorStrategyLevels(strategy(SELECTION()));
    for (const [position, level] of selection.entries()) {
      expect(level.fingerprint).not.toBe(group[position]!.fingerprint);
      // Short however many members are selected: a digest, not the list.
      expect(level.fingerprint).not.toContain(actorId.A);
      expect(level.fingerprint.length).toBeLessThan(200);
    }
    // The same selection written another way is the same logic: no reset, no new version.
    const reordered = strategy({
      kind: "ACTORS",
      actorIds: [actorId.B, actorId.C, actorId.A],
    });
    expect(
      monitorStrategyLevels(reordered).map((level) => level.fingerprint),
    ).toEqual(selection.map((level) => level.fingerprint));
    expect(strategyDefinitionFingerprint(reordered)).toBe(
      strategyDefinitionFingerprint(strategy(SELECTION())),
    );
    // And a legacy single-member rule keeps the fingerprint of the selection that replaces it.
    expect(
      monitorStrategyLevels(
        strategy({ kind: "ACTOR", actorId: actorId.A }),
      ).map((level) => level.fingerprint),
    ).toEqual(
      monitorStrategyLevels(
        strategy({ kind: "ACTORS", actorIds: [actorId.A] }),
      ).map((level) => level.fingerprint),
    );
  });

  // -------------------------------------------------------------------------
  // Editing a group afterwards
  // -------------------------------------------------------------------------

  it("lets a group edit move a live group rule, and nothing else", async () => {
    const groupKey = alternativeDataOperand(metric(GROUP(), "PURCHASES"));
    const selectionKey = alternativeDataOperand(
      metric(SELECTION(), "PURCHASES"),
    );
    const before = await frameFor(bulk, [groupKey, selectionKey], "LIVE");
    const frozenBefore = await frameFor(bulk, [groupKey], "FROZEN");

    // C leaves the group.
    await prisma.actorGroupMember.delete({
      where: { groupId_actorId: { groupId, actorId: actorId.C } },
    });
    try {
      const after = await frameFor(bulk, [groupKey, selectionKey], "LIVE");
      const frozenAfter = await frameFor(bulk, [groupKey], "FROZEN");

      // A rule still naming the group, read live — a Monitor — follows the edit…
      expect(columnOf(after, groupKey)).not.toEqual(columnOf(before, groupKey));
      // …a rule that selects its members is untouched by it…
      expect(columnOf(after, selectionKey)).toEqual(
        columnOf(before, selectionKey),
      );
      // …and so is a run that froze the membership.
      expect(columnOf(frozenAfter, groupKey)).toEqual(
        columnOf(frozenBefore, groupKey),
      );
      // What the edited group now reads is exactly a selection of the two who remain.
      const remainingKey = alternativeDataOperand(
        metric(
          { kind: "ACTORS", actorIds: [actorId.A, actorId.B] },
          "PURCHASES",
        ),
      );
      const remaining = await frameFor(bulk, [remainingKey], "LIVE");
      expect(columnOf(after, groupKey)).toEqual(
        columnOf(remaining, remainingKey),
      );
    } finally {
      await prisma.actorGroupMember.create({
        data: { groupId, actorId: actorId.C },
      });
    }
  });

  it("refuses to load a scope it cannot interpret instead of counting nobody", async () => {
    // A key no serializer of this build would write: the loader does not answer for it, and the
    // projector refuses a column nothing produced.
    const drifted =
      "alt:CONGRESS_ACTIVITY|PURCHASES|30|committee:finance|ANY|-";
    expect((await factsFor(bulk, [drifted], "LIVE")).size).toBe(0);
    await expect(frameFor(bulk, [drifted], "LIVE")).rejects.toThrow(
      /Unsupported evaluation operand/,
    );
  });
});
