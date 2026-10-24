import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@intrinsic/database";
import {
  HISTORICAL_UNIVERSE_FLOOR,
  requireHistoricalUniverse,
  rootIndexOf,
  unavailableRequirements,
  type HistoricalUniverseDefinition,
  type LocalDate,
  type MarketIndexKey,
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
  readonly keys: readonly string[];
  readonly concurrency?: number;
  readonly logger?: GeneratorLogger;
  readonly now?: () => Date;
}): Promise<GenerationOutcome[]> {
  const { prisma } = input;
  const logger = input.logger ?? { info: () => undefined };
  const definitions = sortDefinitions(
    input.keys.map(requireHistoricalUniverse),
  );
  const outcomes: GenerationOutcome[] = [];

  const ranked: HistoricalUniverseDefinition[] = [];
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
    if (definition.method.kind !== "RANK") {
      continue;
    }
    ranked.push(definition);
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
    reconstitution: {
      frequency: "MONTHLY",
      months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    },
    from: floor,
    to: latestSession,
  });
  const priced = new Map<LocalDate, Set<string>>();
  if (checkpoints.length > 0 && securities.length > 0) {
    const rows = await prisma.dailyPrice.findMany({
      where: {
        securityId: { in: securities },
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
  }
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
