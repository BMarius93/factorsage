import { createHash } from "node:crypto";
import {
  classifyStockSector,
  STOCK_SECTOR_CLASSIFICATION_VERSION,
  type StockSectorClassification,
} from "@intrinsic/contracts";
import { Prisma, type PrismaClient } from "@intrinsic/database";
import {
  HISTORICAL_UNIVERSE_FLOOR,
  marketIndexName,
  requireHistoricalUniverse,
  rootIndexOf,
  unavailableRequirements,
  type GicsSector,
  type HistoricalUniverseDefinition,
  type LocalDate,
  type MarketIndexKey,
  type UniverseMethod,
  type UniverseRankingMetric,
} from "@intrinsic/domain";
import {
  addCalendarDays,
  compositeScores,
  HISTORICAL_UNIVERSE_ENGINE_VERSION,
  measurePeriods,
  membersOn,
  membershipPeriods,
  reconstitutionDates,
  selectTop,
  type MembershipRange,
  type RankingCandidate,
  type ReconstitutionDate,
  type ReconstitutionSelection,
} from "./engine.js";
import {
  fundamentalColumnsFor,
  loadParentIndexMembership,
  loadSecuritySeries,
  observedSessions,
  securitiesWithDividends,
  type ParentIndexMembership,
} from "./inputs.js";
import {
  baseMetricsFor,
  COMPOSITE_COMPONENTS,
  isCompositeMetric,
  metricOn,
  sessionCalendar,
  type CompositeMetric,
  type MetricUnavailability,
} from "./metrics.js";
import {
  validateClassifiedGeneration,
  validateGeneration,
  type GenerationValidation,
  type ReconstitutionDiagnostic,
} from "./validation.js";

/**
 * Generates derived historical universes from PostgreSQL (`docs/decisions/historical-universes-v1.md`
 * §4): one pass over a parent index's securities computes every metric the requested universes rank
 * by, then each universe is ranked, measured, digested, validated and stored as one generation.
 *
 * - **Provider free.** Every input is a stored row; a missing dataset is a diagnostic, never a fetch.
 * - **Idempotent.** A universe whose input digest equals its latest completed generation's is not
 *   written again: rerunning over unchanged data writes nothing.
 * - **Incremental.** New sessions add reconstitutions and change the digest, so a rerun after an
 *   ingestion writes exactly one new generation per universe that moved.
 * - **Atomic.** A generation's selections and periods are written in one transaction together with
 *   the universe's pointer to it; a failure leaves the previous generation in force.
 * - **Concurrent runs** of the same universe are serialized by a transaction-scoped advisory lock.
 * - **Bounded.** A universe keeps only its latest generation and its published one.
 *
 * Publication is separate (`publishHistoricalUniverse` in the API): a generation reaches a List only
 * after it validated and an operator published it.
 */

/** Calendar days of price history loaded before the floor: the longest lookback, 252 sessions. */
const LOOKBACK_DAYS = 400;
/** How far before the floor the reconstitution in force on the floor is looked for. */
const PRE_FLOOR_DAYS = 100;

export type GenerationOutcome =
  | {
      readonly key: string;
      readonly outcome: "GENERATED" | "UNCHANGED";
      readonly generationId: string;
      readonly validation: GenerationValidation;
      readonly summary: GenerationSummary;
    }
  | {
      readonly key: string;
      /** BLOCKED: a required dataset has no source. NO_DATA: the parent has no stored prices. */
      readonly outcome: "BLOCKED" | "NO_DATA";
      readonly reasons: readonly { code: string; detail: string }[];
    };

export type GenerationSummary = {
  readonly reconstitutions: number;
  readonly firstReconstitution: LocalDate | null;
  readonly lastReconstitution: LocalDate | null;
  readonly distinctSecurities: number;
  readonly peakSimultaneousMembers: number;
  readonly peakDate: LocalDate | null;
  readonly selectedTotal: number;
  readonly durationMs: number;
  /** A retrospectively classified universe's classification audit; absent for every other. */
  readonly classification?: ClassificationAudit;
};

type ClassificationMethod = Extract<UniverseMethod, { kind: "CLASSIFICATION" }>;

/**
 * How a classified universe's members were classified, persisted with its generation so a published
 * List can always say which classification it was built from.
 */
export type ClassificationAudit = {
  /** `Security.sector`: the company's current sector from the provider's company profile. */
  readonly source: "FMP_COMPANY_PROFILE_SECTOR";
  readonly timing: "RETROSPECTIVE";
  /** `STOCK_SECTOR_CLASSIFICATION_VERSION` the generation ran. */
  readonly mappingVersion: number;
  /**
   * When the classifications were read from the provider: the oldest and newest profile
   * synchronization among the classified securities, and how many have no recorded one (their
   * sector came from the catalog synchronization).
   */
  readonly asOf: {
    readonly earliest: string | null;
    readonly latest: string | null;
    readonly withoutProfileSync: number;
  };
  readonly sectors: readonly GicsSector[];
  /** The index's catalog securities over its whole history, and how they classified. */
  readonly indexSecurities: number;
  readonly classifiedSecurities: number;
  readonly unclassifiedSecurities: number;
  /** The universe's distinct securities, by sector. */
  readonly bySector: Readonly<Partial<Record<GicsSector, number>>>;
  /** Every unclassified index security: none is guessed, every one is reported. */
  readonly unclassified: readonly {
    readonly securityId: string;
    readonly symbol: string;
    readonly name: string;
    readonly reason: "MISSING" | "UNSUPPORTED";
    readonly stored: string | null;
  }[];
  /** Each member's classification, as the generation applied it. */
  readonly members: readonly {
    readonly securityId: string;
    readonly symbol: string;
    readonly fmpSector: string;
    readonly gicsSector: GicsSector;
  }[];
  /** Per calendar year, at its last checkpoint, and the year's lowest group price coverage. */
  readonly byYear: readonly ClassificationYear[];
};

export type ClassificationYear = {
  readonly year: string;
  readonly checkpoints: number;
  readonly indexLines: number;
  readonly indexMembers: number;
  readonly classified: number;
  readonly unclassified: number;
  readonly groupMembers: number;
  readonly groupPriced: number;
  /** Index members over index lines: lines with no catalog security have no sector at all. */
  readonly constituentCoverage: number | null;
  readonly classifiedShare: number | null;
  readonly priceCoverage: number | null;
  readonly minPriceCoverage: number | null;
};

export type GeneratorLogger = {
  info(entry: { event: string } & Record<string, unknown>): void;
};

type Matrix = {
  readonly values: Float64Array;
  readonly reasons: Uint8Array;
};

const REASON_CODES: readonly MetricUnavailability[] = [
  "NO_PRICE_ON_DATE",
  "INSUFFICIENT_HISTORY",
  "NO_MARKET_CAP",
  "NO_RATIO",
  "NO_FUNDAMENTAL",
  "DIVIDENDS_NOT_INGESTED",
  "NO_REGULAR_DIVIDEND",
];

/** Reasons that mean the market data is missing, not that the member is ineligible. */
const MISSING_DATA: ReadonlySet<MetricUnavailability> = new Set([
  "NO_PRICE_ON_DATE",
  "DIVIDENDS_NOT_INGESTED",
]);

function lockKey(universeKey: string): bigint {
  const digest = createHash("sha256")
    .update(`historical-universe:${universeKey}`)
    .digest();
  return digest.readBigInt64BE(0);
}

function sortDefinitions(
  definitions: readonly HistoricalUniverseDefinition[],
): HistoricalUniverseDefinition[] {
  // A universe ranked from another universe's selection after that universe.
  const depth = (definition: HistoricalUniverseDefinition): number =>
    definition.method.kind === "RANK" &&
    definition.method.parent.kind === "UNIVERSE"
      ? 1 + depth(requireHistoricalUniverse(definition.method.parent.key))
      : 0;
  return [...definitions].sort(
    (left, right) =>
      depth(left) - depth(right) || (left.key < right.key ? -1 : 1),
  );
}

export async function generateHistoricalUniverses(input: {
  readonly prisma: PrismaClient;
  /** Catalog universes, by key. */
  readonly keys: readonly string[];
  /**
   * Definitions generated as they are, beside the keys': every methodology is declarative, so a
   * definition outside the catalog (a test's, an operator's experiment) runs the same code.
   */
  readonly definitions?: readonly HistoricalUniverseDefinition[];
  readonly concurrency?: number;
  readonly logger?: GeneratorLogger;
  readonly now?: () => Date;
}): Promise<GenerationOutcome[]> {
  const { prisma } = input;
  const logger = input.logger ?? { info: () => undefined };
  const definitions = sortDefinitions([
    ...input.keys.map(requireHistoricalUniverse),
    ...(input.definitions ?? []),
  ]);
  const outcomes: GenerationOutcome[] = [];

  const ranked: HistoricalUniverseDefinition[] = [];
  const classified = new Map<MarketIndexKey, HistoricalUniverseDefinition[]>();
  for (const definition of definitions) {
    const missing = unavailableRequirements(definition);
    if (missing.length > 0) {
      const reasons = missing.map((requirement) => ({
        code: "DATA_UNAVAILABLE",
        detail: `${requirement}: no V1 data source provides it`,
      }));
      await recordBlocked(prisma, definition, reasons);
      outcomes.push({ key: definition.key, outcome: "BLOCKED", reasons });
      continue;
    }
    if (definition.method.kind === "INDEX_MEMBERSHIP") {
      outcomes.push(
        await generateIndexUniverse({
          prisma,
          definition,
          indexKey: definition.method.indexKey,
          logger,
        }),
      );
      continue;
    }
    if (definition.method.kind === "CLASSIFICATION") {
      const indexKey = definition.method.indexKey;
      classified.set(indexKey, [
        ...(classified.get(indexKey) ?? []),
        definition,
      ]);
      continue;
    }
    if (definition.method.kind !== "RANK") {
      continue;
    }
    ranked.push(definition);
  }
  for (const [indexKey, group] of classified) {
    outcomes.push(
      ...(await generateClassificationGroup({
        prisma,
        indexKey,
        definitions: group,
        logger,
      })),
    );
  }

  const byRoot = new Map<MarketIndexKey, HistoricalUniverseDefinition[]>();
  for (const definition of ranked) {
    const root = rootIndexOf(definition);
    byRoot.set(root, [...(byRoot.get(root) ?? []), definition]);
  }
  for (const [root, group] of byRoot) {
    outcomes.push(
      ...(await generateGroup({
        prisma,
        root,
        definitions: group,
        concurrency: input.concurrency ?? 4,
        logger,
      })),
    );
  }
  return outcomes;
}

async function generateGroup(input: {
  readonly prisma: PrismaClient;
  readonly root: MarketIndexKey;
  readonly definitions: readonly HistoricalUniverseDefinition[];
  readonly concurrency: number;
  readonly logger: GeneratorLogger;
}): Promise<GenerationOutcome[]> {
  const { prisma, root, logger } = input;
  const startedAt = Date.now();
  const floor = HISTORICAL_UNIVERSE_FLOOR;
  // The parent is projected from before the floor: the selection in force on the floor is made at
  // the last reconstitution before it, among the members on that date. Periods are clipped to the
  // floor afterwards (`membershipPeriods`).
  const parent = await loadParentIndexMembership(
    prisma,
    root,
    addCalendarDays(floor, -PRE_FLOOR_DAYS),
  );
  const securities = [...parent.ranges.keys()].sort();
  const securityIndex = new Map(securities.map((id, index) => [id, index]));
  const sessions = await observedSessions(
    prisma,
    securities,
    addCalendarDays(floor, -LOOKBACK_DAYS),
  );
  const calendar = sessionCalendar(sessions);
  const latestSession = sessions[sessions.length - 1] ?? null;
  logger.info({
    event: "historical-universe.group.loaded",
    root,
    securities: securities.length,
    sessions: sessions.length,
    universes: input.definitions.length,
  });
  if (latestSession === null) {
    const outcomes: GenerationOutcome[] = [];
    for (const definition of input.definitions) {
      const reasons = [
        {
          code: "NO_PARENT_DATA",
          detail: `no stored prices for any ${root} member`,
        },
      ];
      await recordDraft(prisma, definition, reasons);
      outcomes.push({ key: definition.key, outcome: "NO_DATA", reasons });
    }
    return outcomes;
  }

  // Reconstitution dates per universe, and the union every metric is computed on.
  const datesOf = new Map<string, ReconstitutionDate[]>();
  const allDates = new Set<LocalDate>();
  const metrics = new Set<UniverseRankingMetric>();
  for (const definition of input.definitions) {
    if (definition.method.kind !== "RANK") continue;
    const dates = reconstitutionDates({
      sessions,
      reconstitution: definition.method.reconstitution,
      // The first selection in force on the floor: the last session of the period before it.
      from: addCalendarDays(floor, -PRE_FLOOR_DAYS),
      to: latestSession,
    }).filter((date, index, all) => {
      // Keep the one reconstitution before the floor whose selection covers it, and every later one.
      const next = all[index + 1];
      return (
        date.effectiveDate >= floor ||
        (next !== undefined && next.effectiveDate > floor)
      );
    });
    datesOf.set(definition.key, dates);
    for (const date of dates) allDates.add(date.date);
    metrics.add(definition.method.metric);
  }
  const dateList = [...allDates].sort();
  const dateIndex = new Map(dateList.map((date, index) => [date, index]));
  const base = baseMetricsFor(metrics);
  const matrices = new Map<string, Matrix>();
  for (const metric of base) {
    matrices.set(metric, {
      values: new Float64Array(securities.length * dateList.length).fill(
        Number.NaN,
      ),
      reasons: new Uint8Array(securities.length * dateList.length),
    });
  }
  const needs = {
    valuation: true,
    ratios: [...base].some((metric) =>
      [
        "EARNINGS_YIELD_TTM",
        "FCF_YIELD_TTM",
        "BOOK_TO_PRICE",
        "SALES_TO_PRICE_TTM",
      ].includes(metric),
    ),
    fundamentals: fundamentalColumnsFor(base),
    dividends: base.has("INDICATED_DIVIDEND_YIELD"),
    splits: base.has("NOMINAL_PRICE"),
  };
  const dividendsSynced = needs.dividends
    ? await securitiesWithDividends(prisma, securities)
    : new Set<string>();

  // One pass over the parent's securities.
  let next = 0;
  const work = async () => {
    for (;;) {
      const position = next;
      next += 1;
      if (position >= securities.length) return;
      const securityId = securities[position] as string;
      const ranges = parent.ranges.get(securityId) ?? [];
      const memberDates = dateList.filter((date) =>
        ranges.some(
          (range) =>
            range.startDate <= date &&
            (range.endDate === null || date <= range.endDate),
        ),
      );
      if (memberDates.length === 0) continue;
      const series = await loadSecuritySeries(prisma, {
        securityId,
        from: addCalendarDays(floor, -LOOKBACK_DAYS),
        needs,
        fundamentalDates: memberDates,
        dividendsSynced: dividendsSynced.has(securityId),
      });
      const row = securityIndex.get(securityId) as number;
      for (const date of memberDates) {
        const column = dateIndex.get(date) as number;
        for (const metric of base) {
          const value = metricOn(metric, series, calendar, date);
          const matrix = matrices.get(metric) as Matrix;
          const cell = row * dateList.length + column;
          if (value.value === null) {
            matrix.reasons[cell] = REASON_CODES.indexOf(value.reason) + 1;
          } else {
            matrix.values[cell] = value.value;
          }
        }
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, input.concurrency) }, work),
  );
  logger.info({
    event: "historical-universe.group.metrics",
    root,
    metrics: [...base],
    dates: dateList.length,
    durationMs: Date.now() - startedAt,
  });

  const read = (metric: string, securityId: string, date: LocalDate) => {
    const matrix = matrices.get(metric) as Matrix;
    const cell =
      (securityIndex.get(securityId) as number) * dateList.length +
      (dateIndex.get(date) as number);
    const value = matrix.values[cell] as number;
    const reasonCode = matrix.reasons[cell] as number;
    return {
      value: Number.isFinite(value) ? value : null,
      reason:
        reasonCode > 0
          ? (REASON_CODES[reasonCode - 1] as MetricUnavailability)
          : null,
    };
  };

  const outcomes: GenerationOutcome[] = [];
  const selectionsOf = new Map<string, Map<LocalDate, string[]>>();
  const periodsOf = new Map<string, Map<string, MembershipRange[]>>();
  const reliableFromOf = new Map<string, LocalDate | null>();
  for (const definition of input.definitions) {
    const method = definition.method;
    if (method.kind !== "RANK") continue;
    const universeStartedAt = Date.now();
    const dates = datesOf.get(definition.key) ?? [];
    const parentSelections =
      method.parent.kind === "UNIVERSE"
        ? (selectionsOf.get(method.parent.key) ??
          (await loadLatestSelections(prisma, method.parent.key)))
        : null;
    const parentRanges =
      method.parent.kind === "UNIVERSE"
        ? (periodsOf.get(method.parent.key) ??
          (await loadLatestPeriods(prisma, method.parent.key)))
        : parent.ranges;
    const parentReliableFrom =
      method.parent.kind === "UNIVERSE"
        ? reliableFromOf.has(method.parent.key)
          ? (reliableFromOf.get(method.parent.key) ?? null)
          : await loadLatestReliableFrom(prisma, method.parent.key)
        : null;
    const selections: ReconstitutionSelection[] = [];
    const ranks: {
      date: LocalDate;
      securityId: string;
      rank: number;
      value: number;
    }[] = [];
    const diagnostics: ReconstitutionDiagnostic[] = [];
    const digest = createHash("sha256");
    digest.update(
      JSON.stringify({
        key: definition.key,
        method,
        methodologyVersion: definition.methodologyVersion,
        engine: HISTORICAL_UNIVERSE_ENGINE_VERSION,
        parent: parent.sourceDigest,
      }),
    );
    for (const date of dates) {
      const candidatesIds =
        parentSelections !== null
          ? [...(parentSelections.get(date.date) ?? [])].sort()
          : membersOn(parent.ranges, date.date);
      const values = new Map<string, number | null>();
      const unavailable: Partial<Record<MetricUnavailability, number>> = {};
      let withData = 0;
      if (isCompositeMetric(method.metric)) {
        const composite =
          COMPOSITE_COMPONENTS[method.metric as CompositeMetric];
        const components = composite.components.map(
          (component) =>
            new Map(
              candidatesIds.map((id) => [
                id,
                read(component, id, date.date).value,
              ]),
            ),
        );
        const scores = compositeScores(components, composite.minimum);
        for (const id of candidatesIds) {
          const priced =
            read("MARKET_CAP", id, date.date).reason !== "NO_PRICE_ON_DATE";
          if (priced) withData += 1;
          const score = scores.get(id) ?? null;
          values.set(id, score);
          if (score === null) {
            const reason: MetricUnavailability = priced
              ? "NO_FUNDAMENTAL"
              : "NO_PRICE_ON_DATE";
            unavailable[reason] = (unavailable[reason] ?? 0) + 1;
          }
        }
      } else {
        for (const id of candidatesIds) {
          const cell = read(method.metric, id, date.date);
          values.set(id, cell.value);
          if (cell.value !== null) {
            withData += 1;
          } else {
            const reason = cell.reason ?? "NO_PRICE_ON_DATE";
            unavailable[reason] = (unavailable[reason] ?? 0) + 1;
            if (!MISSING_DATA.has(reason)) withData += 1;
          }
        }
      }
      const candidates: RankingCandidate[] = candidatesIds.map((id) => ({
        securityId: id,
        value: values.get(id) ?? null,
        tieBreak: read("MARKET_CAP", id, date.date).value,
      }));
      const outcome = selectTop(candidates, method);
      selections.push({
        ...date,
        securityIds: outcome.selected.map((entry) => entry.securityId),
      });
      for (const entry of outcome.selected) {
        ranks.push({ date: date.date, ...entry });
      }
      const parentLines =
        parentSelections !== null
          ? candidatesIds.length
          : parent.linesOn(date.date);
      diagnostics.push({
        date: date.date,
        effectiveDate: date.effectiveDate,
        parentLines,
        parentMembers: candidatesIds.length,
        withData,
        withValue: outcome.withValue,
        expected: outcome.expected,
        selected: outcome.selected.length,
        unavailable,
        ...(method.parent.kind === "UNIVERSE"
          ? {
              parentReliable:
                parentReliableFrom !== null && date.date >= parentReliableFrom,
            }
          : {}),
      });
      digest.update(
        JSON.stringify([
          date.date,
          parentLines,
          candidates.map((candidate) => [
            candidate.securityId,
            candidate.value === null
              ? null
              : Number(candidate.value.toPrecision(12)),
            candidate.tieBreak === null
              ? null
              : Number(candidate.tieBreak.toPrecision(12)),
          ]),
        ]),
      );
    }
    const periods = membershipPeriods({
      selections,
      parent: parentRanges,
      floor,
    });
    selectionsOf.set(
      definition.key,
      new Map(
        selections.map((selection) => [
          selection.date,
          [...selection.securityIds],
        ]),
      ),
    );
    periodsOf.set(definition.key, periods);
    const measured = measurePeriods(periods);
    const validation = validateGeneration({ diagnostics, latestSession });
    reliableFromOf.set(definition.key, validation.reliableFrom);
    const inputDigest = digest.digest("hex");
    const outputDigest = createHash("sha256")
      .update(JSON.stringify([ranks, [...periods.entries()]]))
      .digest("hex");
    const summary: GenerationSummary = {
      reconstitutions: dates.length,
      firstReconstitution: dates[0]?.date ?? null,
      lastReconstitution: dates[dates.length - 1]?.date ?? null,
      distinctSecurities: measured.distinctSecurities,
      peakSimultaneousMembers: measured.peakSimultaneousMembers,
      peakDate: measured.peakDate,
      selectedTotal: ranks.length,
      durationMs: Date.now() - universeStartedAt,
    };
    const stored = await storeGeneration(prisma, {
      definition,
      inputDigest,
      outputDigest,
      ranks,
      selections,
      periods,
      diagnostics,
      validation,
      summary,
    });
    logger.info({
      event: "historical-universe.generated",
      key: definition.key,
      outcome: stored.outcome,
      verdict: validation.verdict,
      reliableFrom: validation.reliableFrom,
      distinctSecurities: summary.distinctSecurities,
      peakSimultaneousMembers: summary.peakSimultaneousMembers,
    });
    outcomes.push({
      key: definition.key,
      outcome: stored.outcome,
      generationId: stored.generationId,
      validation,
      summary,
    });
  }
  return outcomes;
}

async function loadLatestSelections(
  prisma: PrismaClient,
  key: string,
): Promise<Map<LocalDate, string[]>> {
  const universe = await prisma.historicalUniverse.findUnique({
    where: { key },
    select: { latestGenerationId: true },
  });
  const selections = new Map<LocalDate, string[]>();
  if (!universe?.latestGenerationId) return selections;
  const rows = await prisma.historicalUniverseSelection.findMany({
    where: { generationId: universe.latestGenerationId },
    orderBy: [{ reconstitutionDate: "asc" }, { rank: "asc" }],
  });
  for (const row of rows) {
    const date = row.reconstitutionDate.toISOString().slice(0, 10) as LocalDate;
    selections.set(date, [...(selections.get(date) ?? []), row.securityId]);
  }
  return selections;
}

/**
 * An index universe's generation: its membership exactly as its List projects it, validated by data
 * coverage alone — on each month's last session, the index's lines with a stored close that day over
 * all its lines, unresolved constituents included. An index selects every member, so metric
 * availability and full selection hold trivially; what can fail is that the provider holds no
 * prices for too many of the members of the time.
 */
async function generateIndexUniverse(input: {
  readonly prisma: PrismaClient;
  readonly definition: HistoricalUniverseDefinition;
  readonly indexKey: MarketIndexKey;
  readonly logger: GeneratorLogger;
}): Promise<GenerationOutcome> {
  const { prisma, definition, indexKey } = input;
  const startedAt = Date.now();
  const floor = HISTORICAL_UNIVERSE_FLOOR;
  const parent = await loadParentIndexMembership(prisma, indexKey, floor);
  const securities = [...parent.ranges.keys()].sort();
  const sessions = await observedSessions(prisma, securities, floor);
  const latestSession = sessions[sessions.length - 1] ?? null;
  if (latestSession === null) {
    const reasons = [
      {
        code: "NO_PARENT_DATA",
        detail: `no stored prices for any ${indexKey} member`,
      },
    ];
    await recordDraft(prisma, definition, reasons);
    return { key: definition.key, outcome: "NO_DATA", reasons };
  }
  const checkpoints = reconstitutionDates({
    sessions,
    reconstitution: MONTH_ENDS,
    from: floor,
    to: latestSession,
  });
  const priced = await pricedOn(prisma, securities, checkpoints);
  const digest = createHash("sha256").update(
    JSON.stringify({
      key: definition.key,
      method: definition.method,
      methodologyVersion: definition.methodologyVersion,
      engine: HISTORICAL_UNIVERSE_ENGINE_VERSION,
      parent: parent.sourceDigest,
    }),
  );
  const diagnostics: ReconstitutionDiagnostic[] = checkpoints.map(
    (checkpoint) => {
      const members = membersOn(parent.ranges, checkpoint.date);
      const withPrice = members.filter((id) =>
        priced.get(checkpoint.date)?.has(id),
      ).length;
      const lines = parent.linesOn(checkpoint.date);
      digest.update(
        JSON.stringify([checkpoint.date, lines, members, withPrice]),
      );
      return {
        date: checkpoint.date,
        effectiveDate: checkpoint.effectiveDate,
        parentLines: lines,
        parentMembers: members.length,
        withData: withPrice,
        withValue: withPrice,
        // Every member is selected: an index has no ranking to fall short of.
        expected: 1,
        selected: 1,
        unavailable:
          members.length > withPrice
            ? { NO_PRICE_ON_DATE: members.length - withPrice }
            : {},
      };
    },
  );
  const periods = new Map(
    [...parent.ranges.entries()].map(([securityId, ranges]) => [
      securityId,
      [...ranges],
    ]),
  );
  const validation = validateGeneration({ diagnostics, latestSession });
  const measured = measurePeriods(periods);
  const summary: GenerationSummary = {
    reconstitutions: checkpoints.length,
    firstReconstitution: checkpoints[0]?.date ?? null,
    lastReconstitution: checkpoints[checkpoints.length - 1]?.date ?? null,
    distinctSecurities: measured.distinctSecurities,
    peakSimultaneousMembers: measured.peakSimultaneousMembers,
    peakDate: measured.peakDate,
    selectedTotal: 0,
    durationMs: Date.now() - startedAt,
  };
  const stored = await storeGeneration(prisma, {
    definition,
    inputDigest: digest.digest("hex"),
    outputDigest: createHash("sha256")
      .update(JSON.stringify([...periods.entries()]))
      .digest("hex"),
    ranks: [],
    selections: [],
    periods,
    diagnostics,
    validation,
    summary,
  });
  input.logger.info({
    event: "historical-universe.generated",
    key: definition.key,
    outcome: stored.outcome,
    verdict: validation.verdict,
    reliableFrom: validation.reliableFrom,
    distinctSecurities: summary.distinctSecurities,
    peakSimultaneousMembers: summary.peakSimultaneousMembers,
  });
  return {
    key: definition.key,
    outcome: stored.outcome,
    generationId: stored.generationId,
    validation,
    summary,
  };
}

/** Which securities have a stored close on each checkpoint. */
async function pricedOn(
  prisma: PrismaClient,
  securities: readonly string[],
  checkpoints: readonly ReconstitutionDate[],
): Promise<Map<LocalDate, Set<string>>> {
  const priced = new Map<LocalDate, Set<string>>();
  if (checkpoints.length === 0 || securities.length === 0) return priced;
  const rows = await prisma.dailyPrice.findMany({
    where: {
      securityId: { in: [...securities] },
      date: { in: checkpoints.map((checkpoint) => day(checkpoint.date)) },
    },
    select: { securityId: true, date: true },
  });
  for (const row of rows) {
    const date = row.date.toISOString().slice(0, 10) as LocalDate;
    const set = priced.get(date) ?? new Set<string>();
    set.add(row.securityId);
    priced.set(date, set);
  }
  return priced;
}

const MONTH_ENDS = {
  frequency: "MONTHLY",
  months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
} as const;

/**
 * Retrospectively classified universes of one index (`docs/decisions/historical-universes-v1.md`
 * §2.1): each is the index's own point-in-time membership — every window, entry, exit and re-entry
 * exactly as the index's List projects it — restricted to the securities whose **current** sector,
 * read once through the canonical mapping (`classifyStockSector`), is in its group. A security is in
 * at most one group of a partition, never outside its index windows, and an unclassified one is in
 * none and reported. Nothing is fetched: the sector is `Security.sector` as stored.
 *
 * Diagnostics are the index's on each month's last session (data coverage as for the index itself)
 * with the classification and the group's own price coverage beside them.
 */
async function generateClassificationGroup(input: {
  readonly prisma: PrismaClient;
  readonly indexKey: MarketIndexKey;
  readonly definitions: readonly HistoricalUniverseDefinition[];
  readonly logger: GeneratorLogger;
}): Promise<GenerationOutcome[]> {
  const { prisma, indexKey, logger } = input;
  const startedAt = Date.now();
  const floor = HISTORICAL_UNIVERSE_FLOOR;
  const parent = await loadParentIndexMembership(prisma, indexKey, floor);
  const securities = [...parent.ranges.keys()].sort();
  const sessions = await observedSessions(prisma, securities, floor);
  const latestSession = sessions[sessions.length - 1] ?? null;
  if (latestSession === null) {
    const outcomes: GenerationOutcome[] = [];
    for (const definition of input.definitions) {
      const reasons = [
        {
          code: "NO_PARENT_DATA",
          detail: `no stored prices for any ${indexKey} member`,
        },
      ];
      await recordDraft(prisma, definition, reasons);
      outcomes.push({ key: definition.key, outcome: "NO_DATA", reasons });
    }
    return outcomes;
  }
  const checkpoints = reconstitutionDates({
    sessions,
    reconstitution: MONTH_ENDS,
    from: floor,
    to: latestSession,
  });
  const priced = await pricedOn(prisma, securities, checkpoints);
  const rows = await prisma.security.findMany({
    where: { id: { in: securities } },
    select: {
      id: true,
      symbol: true,
      name: true,
      sector: true,
      datasetStates: {
        where: { dataset: "SECURITY_PROFILE" },
        select: { lastSuccessfulSyncAt: true },
      },
    },
    orderBy: { id: "asc" },
  });
  const classification = new Map<
    string,
    {
      readonly symbol: string;
      readonly name: string;
      readonly stored: string | null;
      readonly result: StockSectorClassification;
      readonly syncedAt: Date | null;
    }
  >(
    rows.map((row) => [
      row.id,
      {
        symbol: row.symbol,
        name: row.name,
        stored: row.sector,
        result: classifyStockSector(row.sector),
        syncedAt: row.datasetStates[0]?.lastSuccessfulSyncAt ?? null,
      },
    ]),
  );
  const sectorOf = (securityId: string): GicsSector | null => {
    const entry = classification.get(securityId);
    // A compile-time check that the contract's codes are the domain's sectors.
    const sector: GicsSector | null =
      entry?.result.status === "CLASSIFIED" ? entry.result.gicsSector : null;
    return sector;
  };
  const classifiedIds = securities.filter((id) => sectorOf(id) !== null);
  const syncTimes = classifiedIds
    .map((id) => classification.get(id)?.syncedAt ?? null)
    .filter((value): value is Date => value !== null)
    .map((value) => value.toISOString())
    .sort();
  const unclassified = securities
    .filter((id) => sectorOf(id) === null)
    .map((securityId) => {
      const entry = classification.get(securityId);
      const result = entry?.result;
      return {
        securityId,
        symbol: entry?.symbol ?? securityId,
        name: entry?.name ?? "",
        reason:
          result?.status === "UNCLASSIFIED"
            ? result.reason
            : ("MISSING" as const),
        stored: entry?.stored?.trim() ? entry.stored.trim() : null,
      };
    })
    .sort((left, right) => (left.symbol < right.symbol ? -1 : 1));
  // Every security's classification enters every digest: each generation's audit reports the
  // index's unclassified members, so any change of classification is a new generation of each.
  const assignments = securities.map((id) => [
    id,
    classification.get(id)?.stored ?? null,
    sectorOf(id),
  ]);
  const indexDiagnostics = checkpoints.map((checkpoint) => {
    const members = membersOn(parent.ranges, checkpoint.date);
    return {
      checkpoint,
      members,
      lines: parent.linesOn(checkpoint.date),
      withPrice: members.filter((id) => priced.get(checkpoint.date)?.has(id))
        .length,
      classified: members.filter((id) => sectorOf(id) !== null).length,
    };
  });
  logger.info({
    event: "historical-universe.classification.loaded",
    indexKey,
    securities: securities.length,
    classified: classifiedIds.length,
    unclassified: unclassified.map((entry) => entry.symbol),
    checkpoints: checkpoints.length,
  });

  const outcomes: GenerationOutcome[] = [];
  for (const definition of input.definitions) {
    const method = definition.method as ClassificationMethod;
    const universeStartedAt = Date.now();
    const sectors = new Set<GicsSector>(method.sectors);
    const inGroup = (id: string) => {
      const sector = sectorOf(id);
      return sector !== null && sectors.has(sector);
    };
    const digest = createHash("sha256").update(
      JSON.stringify({
        key: definition.key,
        method,
        methodologyVersion: definition.methodologyVersion,
        engine: HISTORICAL_UNIVERSE_ENGINE_VERSION,
        parent: parent.sourceDigest,
        mappingVersion: STOCK_SECTOR_CLASSIFICATION_VERSION,
        assignments,
      }),
    );
    const diagnostics: ReconstitutionDiagnostic[] = indexDiagnostics.map(
      (entry) => {
        const group = entry.members.filter(inGroup);
        const groupPriced = group.filter((id) =>
          priced.get(entry.checkpoint.date)?.has(id),
        ).length;
        digest.update(
          JSON.stringify([
            entry.checkpoint.date,
            entry.lines,
            entry.members,
            entry.withPrice,
          ]),
        );
        return {
          date: entry.checkpoint.date,
          effectiveDate: entry.checkpoint.effectiveDate,
          parentLines: entry.lines,
          parentMembers: entry.members.length,
          withData: entry.withPrice,
          withValue: entry.withPrice,
          // Every group member is held: a classification has no ranking to fall short of.
          expected: 1,
          selected: 1,
          unavailable:
            entry.members.length > entry.withPrice
              ? { NO_PRICE_ON_DATE: entry.members.length - entry.withPrice }
              : {},
          classification: {
            classified: entry.classified,
            unclassified: entry.members.length - entry.classified,
            groupMembers: group.length,
            groupPriced,
          },
        };
      },
    );
    // The index's own windows, untouched, for the group's securities only.
    const periods = new Map(
      [...parent.ranges.entries()]
        .filter(([securityId]) => inGroup(securityId))
        .map(([securityId, ranges]) => [securityId, [...ranges]]),
    );
    const validation = validateClassifiedGeneration({
      diagnostics,
      latestSession,
      floor,
      securities: securities.length,
      classifiedSecurities: classifiedIds.length,
      indexName: marketIndexName(indexKey),
    });
    const measured = measurePeriods(periods);
    const bySector: Partial<Record<GicsSector, number>> = {};
    const members = [...periods.keys()].sort().map((securityId) => {
      const entry = classification.get(securityId);
      const gicsSector = sectorOf(securityId) as GicsSector;
      bySector[gicsSector] = (bySector[gicsSector] ?? 0) + 1;
      return {
        securityId,
        symbol: entry?.symbol ?? securityId,
        fmpSector:
          entry?.result.status === "CLASSIFIED" ? entry.result.fmpSector : "",
        gicsSector,
      };
    });
    const summary: GenerationSummary = {
      reconstitutions: checkpoints.length,
      firstReconstitution: checkpoints[0]?.date ?? null,
      lastReconstitution: checkpoints[checkpoints.length - 1]?.date ?? null,
      distinctSecurities: measured.distinctSecurities,
      peakSimultaneousMembers: measured.peakSimultaneousMembers,
      peakDate: measured.peakDate,
      selectedTotal: 0,
      durationMs: Date.now() - universeStartedAt,
      classification: {
        source: "FMP_COMPANY_PROFILE_SECTOR",
        timing: "RETROSPECTIVE",
        mappingVersion: STOCK_SECTOR_CLASSIFICATION_VERSION,
        asOf: {
          earliest: syncTimes[0] ?? null,
          latest: syncTimes[syncTimes.length - 1] ?? null,
          withoutProfileSync: classifiedIds.length - syncTimes.length,
        },
        sectors: method.sectors,
        indexSecurities: securities.length,
        classifiedSecurities: classifiedIds.length,
        unclassifiedSecurities: unclassified.length,
        bySector,
        unclassified,
        members,
        byYear: classificationByYear(diagnostics),
      },
    };
    const stored = await storeGeneration(prisma, {
      definition,
      inputDigest: digest.digest("hex"),
      outputDigest: createHash("sha256")
        .update(JSON.stringify([...periods.entries()]))
        .digest("hex"),
      ranks: [],
      selections: [],
      periods,
      diagnostics,
      validation,
      summary,
    });
    logger.info({
      event: "historical-universe.generated",
      key: definition.key,
      outcome: stored.outcome,
      verdict: validation.verdict,
      reliableFrom: validation.reliableFrom,
      distinctSecurities: summary.distinctSecurities,
      peakSimultaneousMembers: summary.peakSimultaneousMembers,
      durationMs: Date.now() - startedAt,
    });
    outcomes.push({
      key: definition.key,
      outcome: stored.outcome,
      generationId: stored.generationId,
      validation,
      summary,
    });
  }
  return outcomes;
}

const share = (part: number, whole: number) =>
  whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : null;

/** A classified universe's coverage per calendar year: the year's last checkpoint, and its lowest. */
export function classificationByYear(
  diagnostics: readonly ReconstitutionDiagnostic[],
): ClassificationYear[] {
  const years = new Map<string, ReconstitutionDiagnostic[]>();
  for (const diagnostic of [...diagnostics].sort((left, right) =>
    left.date < right.date ? -1 : 1,
  )) {
    const year = diagnostic.date.slice(0, 4);
    years.set(year, [...(years.get(year) ?? []), diagnostic]);
  }
  return [...years.entries()].map(([year, entries]) => {
    const last = entries[entries.length - 1] as ReconstitutionDiagnostic;
    const group = last.classification;
    const coverages = entries
      .map((entry) =>
        entry.classification
          ? share(
              entry.classification.groupPriced,
              entry.classification.groupMembers,
            )
          : null,
      )
      .filter((value): value is number => value !== null);
    return {
      year,
      checkpoints: entries.length,
      indexLines: last.parentLines,
      indexMembers: last.parentMembers,
      classified: group?.classified ?? 0,
      unclassified: group?.unclassified ?? 0,
      groupMembers: group?.groupMembers ?? 0,
      groupPriced: group?.groupPriced ?? 0,
      constituentCoverage: share(last.parentMembers, last.parentLines),
      classifiedShare: share(group?.classified ?? 0, last.parentMembers),
      priceCoverage: share(group?.groupPriced ?? 0, group?.groupMembers ?? 0),
      minPriceCoverage: coverages.length > 0 ? Math.min(...coverages) : null,
    };
  });
}

async function loadLatestReliableFrom(
  prisma: PrismaClient,
  key: string,
): Promise<LocalDate | null> {
  const universe = await prisma.historicalUniverse.findUnique({
    where: { key },
    select: { latestGeneration: { select: { validation: true } } },
  });
  const validation = universe?.latestGeneration?.validation as {
    reliableFrom?: LocalDate | null;
  } | null;
  return validation?.reliableFrom ?? null;
}

async function loadLatestPeriods(
  prisma: PrismaClient,
  key: string,
): Promise<Map<string, MembershipRange[]>> {
  const universe = await prisma.historicalUniverse.findUnique({
    where: { key },
    select: { latestGenerationId: true },
  });
  const periods = new Map<string, MembershipRange[]>();
  if (!universe?.latestGenerationId) return periods;
  return loadGenerationPeriods(prisma, universe.latestGenerationId);
}

/** A generation's membership periods, by security, ordered. */
export async function loadGenerationPeriods(
  prisma: PrismaClient,
  generationId: string,
): Promise<Map<string, MembershipRange[]>> {
  const rows = await prisma.historicalUniverseMembershipPeriod.findMany({
    where: { generationId },
    orderBy: [{ securityId: "asc" }, { startDate: "asc" }],
  });
  const periods = new Map<string, MembershipRange[]>();
  for (const row of rows) {
    periods.set(row.securityId, [
      ...(periods.get(row.securityId) ?? []),
      {
        startDate: row.startDate.toISOString().slice(0, 10) as LocalDate,
        endDate:
          row.endDate === null
            ? null
            : (row.endDate.toISOString().slice(0, 10) as LocalDate),
      },
    ]);
  }
  return periods;
}

const day = (value: LocalDate) => new Date(`${value}T00:00:00.000Z`);

async function storeGeneration(
  prisma: PrismaClient,
  input: {
    readonly definition: HistoricalUniverseDefinition;
    readonly inputDigest: string;
    readonly outputDigest: string;
    readonly ranks: readonly {
      date: LocalDate;
      securityId: string;
      rank: number;
      value: number;
    }[];
    readonly selections: readonly ReconstitutionSelection[];
    readonly periods: ReadonlyMap<string, readonly MembershipRange[]>;
    readonly diagnostics: readonly ReconstitutionDiagnostic[];
    readonly validation: GenerationValidation;
    readonly summary: GenerationSummary;
  },
): Promise<{ outcome: "GENERATED" | "UNCHANGED"; generationId: string }> {
  const { definition } = input;
  const effectiveOf = new Map(
    input.selections.map((selection) => [
      selection.date,
      selection.effectiveDate,
    ]),
  );
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey(definition.key)})`;
      const latest = await tx.historicalUniverse.findUnique({
        where: { key: definition.key },
        include: { latestGeneration: true },
      });
      if (
        latest?.latestGeneration &&
        latest.latestGeneration.status === "COMPLETED" &&
        latest.latestGeneration.inputDigest === input.inputDigest &&
        latest.latestGeneration.methodologyVersion ===
          definition.methodologyVersion &&
        latest.latestGeneration.engineVersion ===
          HISTORICAL_UNIVERSE_ENGINE_VERSION
      ) {
        return {
          outcome: "UNCHANGED" as const,
          generationId: latest.latestGeneration.id,
        };
      }
      const generation = await tx.historicalUniverseGeneration.create({
        data: {
          universeKey: definition.key,
          methodologyVersion: definition.methodologyVersion,
          engineVersion: HISTORICAL_UNIVERSE_ENGINE_VERSION,
          status: "COMPLETED",
          inputDigest: input.inputDigest,
          outputDigest: input.outputDigest,
          completedAt: new Date(),
          firstReconstitution: input.summary.firstReconstitution
            ? day(input.summary.firstReconstitution)
            : null,
          lastReconstitution: input.summary.lastReconstitution
            ? day(input.summary.lastReconstitution)
            : null,
          summary: input.summary as unknown as Prisma.InputJsonValue,
          diagnostics: input.diagnostics as unknown as Prisma.InputJsonValue,
          validation: input.validation as unknown as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      for (let offset = 0; offset < input.ranks.length; offset += 5_000) {
        await tx.historicalUniverseSelection.createMany({
          data: input.ranks.slice(offset, offset + 5_000).map((entry) => ({
            generationId: generation.id,
            reconstitutionDate: day(entry.date),
            securityId: entry.securityId,
            rank: entry.rank,
            metricValue: new Prisma.Decimal(
              Number(entry.value.toPrecision(15)),
            ),
            effectiveDate: day(effectiveOf.get(entry.date) as LocalDate),
          })),
        });
      }
      const periods = [...input.periods.entries()].flatMap(
        ([securityId, ranges]) =>
          ranges.map((range) => ({
            generationId: generation.id,
            securityId,
            startDate: day(range.startDate),
            endDate: range.endDate === null ? null : day(range.endDate),
          })),
      );
      for (let offset = 0; offset < periods.length; offset += 5_000) {
        await tx.historicalUniverseMembershipPeriod.createMany({
          data: periods.slice(offset, offset + 5_000),
        });
      }
      const status =
        latest?.status === "PUBLISHED"
          ? "PUBLISHED"
          : input.validation.verdict === "VALIDATED"
            ? "VALIDATED"
            : "DRAFT";
      const statusReasons = input.validation
        .reasons as unknown as Prisma.InputJsonValue;
      await tx.historicalUniverse.upsert({
        where: { key: definition.key },
        create: {
          key: definition.key,
          status,
          methodologyVersion: definition.methodologyVersion,
          latestGenerationId: generation.id,
          statusReasons,
        },
        update: {
          status,
          methodologyVersion: definition.methodologyVersion,
          latestGenerationId: generation.id,
          statusReasons,
        },
      });
      // Retention: a universe keeps its latest generation and the one its List was published from;
      // a superseded generation's selections and periods go with it (they cascade). Diagnostics of
      // the generations kept are what the report reads.
      const keep = [generation.id, latest?.publishedGenerationId].filter(
        (id): id is string => typeof id === "string",
      );
      await tx.historicalUniverseGeneration.deleteMany({
        where: { universeKey: definition.key, id: { notIn: keep } },
      });
      return { outcome: "GENERATED" as const, generationId: generation.id };
    },
    { timeout: 300_000 },
  );
}

async function recordBlocked(
  prisma: PrismaClient,
  definition: HistoricalUniverseDefinition,
  reasons: readonly { code: string; detail: string }[],
): Promise<void> {
  await prisma.historicalUniverse.upsert({
    where: { key: definition.key },
    create: {
      key: definition.key,
      status: "BLOCKED",
      methodologyVersion: definition.methodologyVersion,
      statusReasons: reasons as unknown as Prisma.InputJsonValue,
    },
    update: {
      status: "BLOCKED",
      methodologyVersion: definition.methodologyVersion,
      statusReasons: reasons as unknown as Prisma.InputJsonValue,
    },
  });
}

async function recordDraft(
  prisma: PrismaClient,
  definition: HistoricalUniverseDefinition,
  reasons: readonly { code: string; detail: string }[],
): Promise<void> {
  await prisma.historicalUniverse.upsert({
    where: { key: definition.key },
    create: {
      key: definition.key,
      status: "DRAFT",
      methodologyVersion: definition.methodologyVersion,
      statusReasons: reasons as unknown as Prisma.InputJsonValue,
    },
    update: { statusReasons: reasons as unknown as Prisma.InputJsonValue },
  });
}

export type { ParentIndexMembership };
