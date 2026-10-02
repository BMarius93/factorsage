import {
  VALUATION_RATIO_IDS,
  type ValuationRatioId,
} from "@intrinsic/contracts";
import type { PrismaClient } from "@intrinsic/database";
import type { LocalDate, Security } from "@intrinsic/domain";
import {
  CanonicalStockDataService,
  DAILY_PRICE_VARIANT,
  DERIVED_SERIES_WARMUP_DAYS,
  IoredisCacheClient,
  PrismaStockDataStore,
  RedisStockDataCache,
  RedlockLoadCoordinator,
  buildValuationTimeline,
  createStockDataRedisClient,
  monitorWindowCalendarDays,
  valuationRatioColumns,
  type ValuationTimeline,
} from "@intrinsic/stock-data";
import { valuationRatioOperand } from "@intrinsic/strategy";
import {
  createValuationOracle,
  ORACLE_VALUATION_RATIO_IDS,
  type OracleValuationRatioId,
  type OracleValuationReading,
  type OracleValuationSecurity,
} from "../oracle/valuation-ratios";
import { ComparisonTally } from "./compare";

/**
 * The full-scale audit over a stored copy of the development data: every stored session of every
 * security with statements, all five ratios, held by the reference — fed by its own SQL over the
 * raw rows — against every production layer that projects a ratio:
 *
 * - `pure`: `valuationRatioColumns` over the timeline the product prepares, on every stored
 *   session (warm-up years included);
 * - `strategy-frame`: `getDailyEvaluationFrame` over the product horizon, as a Strategy reads it;
 * - `backtest-window`: `prepareDailyEvaluationData`, then `readDailyEvaluationFrame` per calendar
 *   year with the pinned generation and the prepared inputs, exactly as the backtest worker reads;
 * - `monitor`: `prepareMonitorEvaluationData` and `readMonitorEvaluationFrame` with a provisional
 *   quote: the closed rows, and the provisional row against the reference read with the newest
 *   closed session's statements;
 * - `stock-details`: `getDailyValuationRatio`, per ratio, over the product horizon.
 *
 * The provider refuses every request and the clock is pinned to each security's own durable
 * coverage end, so nothing may fetch: the data must already be stored. Every layer is compared with
 * the reference, and every layer is also compared bit for bit with the `pure` layer.
 */

export type OracleRows = {
  securityId: string;
  symbol: string;
  currency: string;
  coverageEnd: LocalDate;
  /** Where the durable price coverage ending at `coverageEnd` begins. */
  coverageStart: LocalDate;
  /** The security's listing date from the provider's profile, when known. */
  listingDate: LocalDate | null;
  /** The fundamentals retention's first fiscal period end (see `readOracleRows`). */
  retentionFrom: LocalDate;
  /** Stored statement revisions outside the retention, counted and never read. */
  outsideRetention: number;
  security: OracleValuationSecurity;
  sessions: { date: LocalDate; close: string }[];
};

type StatementRow = {
  statementType: "INCOME" | "BALANCE_SHEET" | "CASH_FLOW";
  fiscalDate: string;
  fiscalYear: number;
  period: "FY" | "Q1" | "Q2" | "Q3" | "Q4";
  reportedCurrency: string;
  availableFromDate: string;
  observedAt: string;
  contentHash: string;
  values: Record<string, unknown>;
};

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/** Thirty product years plus the seven-year valuation warm-up (`fundamentals-loader.md`). */
export const VALUATION_RETENTION_YEARS = 37;

/**
 * The reference's inputs, read with its own SQL from the raw rows: no product read path.
 *
 * Statements are the **retained** revisions only: the fundamentals retention is
 * `[today - 30 - 7 years, today]` by fiscal period end, clamped to a known listing date
 * (`docs/decisions/fundamentals-loader.md`, "Valuation warm-up retention"), and every
 * statement-derived value — Fundamental Metrics, intrinsic values and the valuation ratios that
 * inherit their point-in-time rules — reads exactly that range. It is restated here from the
 * decision, as the Fundamental Metrics audit restates it, with "today" the security's newest covered
 * day; revisions an earlier sync stored outside it (a predecessor's pre-listing quarters, for
 * instance) are counted, never read.
 */
export async function readOracleRows(
  prisma: PrismaClient,
  securityId: string,
): Promise<OracleRows> {
  const [identity] = await prisma.$queryRawUnsafe<
    {
      symbol: string;
      currency: string;
      ipo_date: string | null;
      coverage_start: string | null;
      coverage_end: string | null;
    }[]
  >(
    `select s.symbol, s.currency, to_char(s."ipoDate", 'YYYY-MM-DD') as ipo_date,
            (select to_char(c."fromDate", 'YYYY-MM-DD') from "StockDatasetCoverage" c
              where c."securityId" = s.id and c.dataset = 'DAILY_PRICE' and c.variant = $2
              order by c."toDate" desc limit 1) as coverage_start,
            (select to_char(max(c."toDate"), 'YYYY-MM-DD') from "StockDatasetCoverage" c
              where c."securityId" = s.id and c.dataset = 'DAILY_PRICE' and c.variant = $2) as coverage_end
       from "Security" s where s.id = $1`,
    securityId,
    DAILY_PRICE_VARIANT,
  );
  if (!identity) {
    throw new Error(`no security ${securityId}`);
  }
  const statements = await prisma.$queryRawUnsafe<StatementRow[]>(
    `select "statementType"::text as "statementType",
            to_char("fiscalDate", 'YYYY-MM-DD') as "fiscalDate",
            "fiscalYear", period::text as period, "reportedCurrency",
            to_char("availableFromDate", 'YYYY-MM-DD') as "availableFromDate",
            to_char("observedAt", ${ISO}) as "observedAt",
            "contentHash", "values"
       from "FinancialStatement" where "securityId" = $1`,
    securityId,
  );
  const [basis] = await prisma.$queryRawUnsafe<{ verified_at: string }[]>(
    `select to_char("verifiedAt", ${ISO}) as verified_at
       from "SecurityPriceBasis" where "securityId" = $1`,
    securityId,
  );
  const events = await prisma.$queryRawUnsafe<
    {
      kind: "MEASURED" | "UNEXPLAINED";
      effective_date: string | null;
      effective_from: string | null;
      effective_to: string | null;
      price_ratio: string | null;
      detected_at: string;
    }[]
  >(
    `select kind::text as kind,
            to_char("effectiveDate", 'YYYY-MM-DD') as effective_date,
            to_char("effectiveFrom", 'YYYY-MM-DD') as effective_from,
            to_char("effectiveTo", 'YYYY-MM-DD') as effective_to,
            "priceRatio"::text as price_ratio,
            to_char("detectedAt", ${ISO}) as detected_at
       from "PriceBasisEvent" where "securityId" = $1`,
    securityId,
  );
  const splits = await prisma.$queryRawUnsafe<
    {
      date: string;
      numerator: string;
      denominator: string;
      label: string | null;
    }[]
  >(
    `select to_char(date, 'YYYY-MM-DD') as date, numerator::text as numerator,
            denominator::text as denominator, label
       from "StockSplit" where "securityId" = $1`,
    securityId,
  );
  const prices = await prisma.$queryRawUnsafe<
    { date: string; close: string }[]
  >(
    `select to_char(date, 'YYYY-MM-DD') as date, close::text as close
       from "DailyPrice" where "securityId" = $1 order by date`,
    securityId,
  );
  const coverageEnd = identity.coverage_end ?? (prices.at(-1)?.date as string);
  const horizonFrom = subtractYearsFrom(coverageEnd, VALUATION_RETENTION_YEARS);
  const retentionFrom =
    identity.ipo_date && identity.ipo_date > horizonFrom
      ? identity.ipo_date
      : horizonFrom;
  const retained = statements.filter(
    (row) => row.fiscalDate >= retentionFrom && row.fiscalDate <= coverageEnd,
  );
  return {
    securityId,
    symbol: identity.symbol,
    currency: identity.currency,
    coverageEnd,
    coverageStart: identity.coverage_start ?? (prices[0]?.date as string),
    listingDate: identity.ipo_date,
    retentionFrom,
    outsideRetention: statements.length - retained.length,
    security: {
      currency: identity.currency,
      statements: retained.map((row) => ({ ...row })),
      verifiedAt: basis?.verified_at ?? null,
      events: events.map((event) => ({
        kind: event.kind,
        effectiveDate: event.effective_date,
        effectiveFrom: event.effective_from,
        effectiveTo: event.effective_to,
        priceRatio: event.price_ratio,
        detectedAt: event.detected_at,
      })),
      splits: splits.map((split) => ({ ...split })),
    },
    sessions: prices,
  };
}

export const REAL_DATA_LAYERS = [
  "pure",
  "strategy-frame",
  "backtest-window",
  "monitor-closed",
  "monitor-provisional",
  "stock-details",
] as const;
export type RealDataLayer = (typeof REAL_DATA_LAYERS)[number];

export type RealDataAudit = {
  securities: number;
  sessions: number;
  tallies: Map<RealDataLayer, ComparisonTally>;
  /** Cells a layer projected differently, bit for bit, from the `pure` layer on the same session. */
  layerDisagreements: Map<RealDataLayer, number>;
  /** Per security: every divergent cell class, by layer and ratio, with its first and last session. */
  divergences: Map<
    string,
    Record<
      string,
      {
        count: number;
        first: LocalDate;
        last: LocalDate;
        reasons: Record<string, number>;
      }
    >
  >;
  /** Securities a production read refused, with why (a provider request it needed, and so on). */
  refusedReads: { symbol: string; layer: RealDataLayer; error: string }[];
  /**
   * Reads whose sessions were not exactly the stored sessions of the range read (from the listing
   * date on): a layer that left a session out, or added one, without either being a cell.
   */
  sessionMismatches: {
    symbol: string;
    layer: RealDataLayer;
    range: { from: LocalDate; to: LocalDate };
    missing: LocalDate[];
    extra: LocalDate[];
  }[];
  providerCalls: string[];
  /** Per security and ratio: the reference's unavailable intervals, for the event regression set. */
  intervals: Map<string, Record<OracleValuationRatioId, UnavailableInterval[]>>;
  /** The reference's reading of every stored session, kept for the securities asked for. */
  readings: Map<string, Map<LocalDate, OracleValuationReading>>;
  /** Per security: the stored sessions in the product horizon, and available cells per ratio. */
  perSecurity: Map<
    string,
    {
      horizonSessions: number;
      available: Record<OracleValuationRatioId, number>;
      /** The first session the service layers were read from (see `auditRealData`). */
      serviceFrom: LocalDate;
      /** Where the `pure` layer's timeline came from. */
      pureTimeline: "prepared" | "store";
      /** Whether the stored price history was ever verified (rule 0). */
      verified: boolean;
      retentionFrom: LocalDate;
      outsideRetention: number;
    }
  >;
};

export type UnavailableInterval = {
  /** First session withheld. */
  from: LocalDate;
  /** Last session withheld. */
  to: LocalDate;
  /** First session available again, if any. */
  resumed?: LocalDate;
  sessions: number;
  /** Primary reasons inside the interval, with counts. */
  reasons: Record<string, number>;
};

function weekdayAfter(date: LocalDate): LocalDate {
  let next = new Date(Date.parse(`${date}T00:00:00.000Z`) + 86_400_000);
  while (next.getUTCDay() === 0 || next.getUTCDay() === 6) {
    next = new Date(next.getTime() + 86_400_000);
  }
  return next.toISOString().slice(0, 10);
}

function subtractYearsFrom(date: LocalDate, years: number): LocalDate {
  const [year, month, day] = date.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const candidate = new Date(Date.UTC(year - years, month - 1, day));
  if (candidate.getUTCMonth() !== month - 1) {
    candidate.setUTCDate(0);
  }
  return candidate.toISOString().slice(0, 10);
}

export async function auditRealData(input: {
  prisma: PrismaClient;
  redisUrl: string;
  namespace: string;
  securityIds: readonly string[];
  keepReadingsFor?: readonly string[];
  log: (line: string) => void;
}): Promise<RealDataAudit> {
  const providerCalls: string[] = [];
  const refuse = (call: string): never => {
    providerCalls.push(call);
    throw new Error(`the valuation audit may not reach the provider (${call})`);
  };
  const provider = {
    getProfile: async (symbol: string) => refuse(`profile ${symbol}`),
    getDailyPrices: async (
      symbol: string,
      _id: string,
      range: { from: string; to: string },
    ) => refuse(`prices ${symbol} ${range.from}..${range.to}`),
    getFinancialStatements: async (symbol: string, _id: string, type: string) =>
      refuse(`statements ${symbol} ${type}`),
    getStockSplits: async (symbol: string) => refuse(`splits ${symbol}`),
  } as never;
  const redis = createStockDataRedisClient(input.redisUrl);
  const tenYears = 10 * 365 * 24 * 60 * 60 * 1_000;
  const store = new PrismaStockDataStore(input.prisma);
  const cache = new RedisStockDataCache(
    new IoredisCacheClient(redis),
    80,
    input.namespace,
  );
  let clock = new Date();
  const service = new CanonicalStockDataService(
    store,
    provider,
    cache,
    new RedlockLoadCoordinator(redis, {
      lockDurationMs: 120_000,
      lockWaitMs: 120_000,
    }),
    {
      productHistoryYears: 30,
      now: () => clock,
      recentPriceFreshnessMs: tenYears,
      fundamentalsFreshnessMs: tenYears,
    },
  );
  const operands = VALUATION_RATIO_IDS.map(valuationRatioOperand);
  const tallies = new Map<RealDataLayer, ComparisonTally>(
    REAL_DATA_LAYERS.map((layer) => [layer, new ComparisonTally()]),
  );
  const layerDisagreements = new Map<RealDataLayer, number>(
    REAL_DATA_LAYERS.map((layer) => [layer, 0]),
  );
  const refusedReads: RealDataAudit["refusedReads"] = [];
  const sessionMismatches: RealDataAudit["sessionMismatches"] = [];
  const divergences: RealDataAudit["divergences"] = new Map();
  const intervals: RealDataAudit["intervals"] = new Map();
  const readings: RealDataAudit["readings"] = new Map();
  const perSecurity: RealDataAudit["perSecurity"] = new Map();
  let sessionsTotal = 0;

  try {
    for (const securityId of input.securityIds) {
      const rows = await readOracleRows(input.prisma, securityId);
      clock = new Date(`${rows.coverageEnd}T12:00:00.000Z`);
      const horizonStart = subtractYearsFrom(rows.coverageEnd, 30);
      const oracle = createValuationOracle(rows.security);
      const reference = new Map<LocalDate, OracleValuationReading>();
      for (const session of rows.sessions) {
        reference.set(
          session.date,
          oracle.reading(session.date, session.close),
        );
      }
      if (input.keepReadingsFor?.includes(rows.symbol)) {
        readings.set(rows.symbol, reference);
      }
      sessionsTotal += rows.sessions.length;
      intervals.set(
        rows.symbol,
        unavailableIntervals(rows, reference, horizonStart),
      );
      const available = Object.fromEntries(
        ORACLE_VALUATION_RATIO_IDS.map((ratio) => [ratio, 0]),
      ) as Record<OracleValuationRatioId, number>;
      let horizonSessions = 0;
      for (const session of rows.sessions) {
        if (session.date < horizonStart) {
          continue;
        }
        horizonSessions += 1;
        const reading = reference.get(session.date) as OracleValuationReading;
        for (const ratio of ORACLE_VALUATION_RATIO_IDS) {
          if (reading[ratio].available) {
            available[ratio] += 1;
          }
        }
      }
      const [security] = (await store.findSecuritiesByIds([securityId])) as [
        Security,
      ];
      // `pure`: the product's own prepared timeline over every stored session.
      const pure = new Map<string, number>();
      const record = (
        layer: RealDataLayer,
        date: LocalDate,
        ratio: OracleValuationRatioId,
        value: number,
        expected = reference.get(date)?.[ratio],
      ) => {
        if (expected === undefined) {
          throw new Error(
            `${rows.symbol} ${layer}: session ${date} is not stored`,
          );
        }
        const comparison = (tallies.get(layer) as ComparisonTally).record(
          `${rows.symbol} ${date}`,
          ratio,
          value,
          expected,
        );
        if (
          comparison.cls !== "AVAILABLE_MATCH" &&
          comparison.cls !== "EXPECTED_UNAVAILABLE"
        ) {
          const perSymbol = divergences.get(rows.symbol) ?? {};
          const key = `${layer} ${ratio} ${comparison.cls}`;
          const entry = perSymbol[key] ?? {
            count: 0,
            first: date,
            last: date,
            reasons: {},
          };
          entry.count += 1;
          entry.first = date < entry.first ? date : entry.first;
          entry.last = date > entry.last ? date : entry.last;
          const reason = expected.available
            ? "reference available"
            : expected.failing.join(",");
          entry.reasons[reason] = (entry.reasons[reason] ?? 0) + 1;
          perSymbol[key] = entry;
          divergences.set(rows.symbol, perSymbol);
        }
        if (layer === "pure") {
          pure.set(`${date} ${ratio}`, value);
        } else if (layer !== "monitor-provisional") {
          const base = pure.get(`${date} ${ratio}`);
          if (base === undefined || !Object.is(base, value)) {
            layerDisagreements.set(
              layer,
              (layerDisagreements.get(layer) ?? 0) + 1,
            );
          }
        }
      };
      const refused = (layer: RealDataLayer, error: unknown) => {
        refusedReads.push({
          symbol: rows.symbol,
          layer,
          error: error instanceof Error ? error.message : String(error),
        });
      };
      const guarded = async (
        layer: RealDataLayer,
        work: () => Promise<void>,
      ) => {
        try {
          await work();
        } catch (error) {
          refused(layer, error);
        }
      };
      // Every product read must answer exactly the stored sessions of its range, from the listing
      // date on (`complete-price-coverage.md`, `LISTING`): a session left out is no cell at all.
      const storedIn = (from: LocalDate, to: LocalDate) =>
        rows.sessions
          .filter(
            (session) =>
              session.date >= from &&
              session.date <= to &&
              (rows.listingDate === null || session.date >= rows.listingDate),
          )
          .map((session) => session.date);
      const checkSessions = (
        layer: RealDataLayer,
        range: { from: LocalDate; to: LocalDate },
        answered: readonly LocalDate[],
        expected: readonly LocalDate[] = storedIn(range.from, range.to),
      ) => {
        const got = new Set(answered);
        const want = new Set(expected);
        const missing = expected.filter((date) => !got.has(date));
        const extra = answered.filter((date) => !want.has(date));
        if (missing.length > 0 || extra.length > 0) {
          sessionMismatches.push({
            symbol: rows.symbol,
            layer,
            range,
            missing: missing.slice(0, 20),
            extra: extra.slice(0, 20),
          });
        }
      };

      // The service layers read what is durably covered without the provider: the whole horizon
      // where the coverage reaches the retention start or the listing, otherwise from the first
      // session whose warm-up the coverage holds — a wider read is the provider's to answer
      // (`complete-price-coverage.md`), and this audit never reaches it.
      // Computed before any read, from the decision's own ranges: the price retention is the
      // product horizon plus `PRICE_RETENTION_WARMUP_YEARS`, clamped to a known listing date.
      const ipoDate = security.ipoDate;
      const retentionStart = subtractYearsFrom(rows.coverageEnd, 34);
      const coverageReachesRetention =
        rows.coverageStart <=
        (ipoDate && ipoDate > retentionStart ? ipoDate : retentionStart);
      const narrowed = new Date(
        Date.parse(`${rows.coverageStart}T00:00:00.000Z`) +
          // The warm-up, and a margin for the leading context a frame adds before its period.
          (DERIVED_SERIES_WARMUP_DAYS + 30) * 86_400_000,
      )
        .toISOString()
        .slice(0, 10);
      const serviceFrom =
        coverageReachesRetention || narrowed <= horizonStart
          ? horizonStart
          : narrowed;
      let prepared:
        | Awaited<ReturnType<typeof service.prepareDailyEvaluationData>>
        | undefined;
      if (serviceFrom <= rows.coverageEnd) {
        try {
          prepared = await service.prepareDailyEvaluationData(
            security,
            { from: serviceFrom, to: rows.coverageEnd },
            operands,
          );
        } catch (error) {
          refused("pure", error);
        }
      }
      // The timeline a backtest prepares; when the service refused to prepare one (an unverified
      // history needs its first verification, which reaches the provider), the product's own
      // calculation over the stored inputs, read through the product's store.
      let timeline: ValuationTimeline | undefined = prepared?.valuation;
      const pureTimeline: "prepared" | "store" = timeline
        ? "prepared"
        : "store";
      if (!timeline) {
        const [statements, basis, basisEvents, splits] = await Promise.all([
          // The product's own read (`readValuationTimeline`), over the retained range.
          store.getFinancialStatementRevisions({
            securityId,
            cadence: "QUARTERLY",
            from: rows.retentionFrom,
            to: rows.coverageEnd,
          }),
          store.getPriceBasis(securityId),
          store.getPriceBasisEvents(securityId),
          store.getStockSplits(securityId),
        ]);
        timeline = buildValuationTimeline({
          securityId,
          currency: security.currency,
          statements,
          verifiedAt: basis?.verifiedAt ?? null,
          events: basisEvents,
          splits,
        });
      }
      perSecurity.set(rows.symbol, {
        horizonSessions,
        available,
        serviceFrom,
        pureTimeline,
        verified: rows.security.verifiedAt !== null,
        retentionFrom: rows.retentionFrom,
        outsideRetention: rows.outsideRetention,
      });
      const columns = valuationRatioColumns({
        timeline,
        dates: rows.sessions.map((session) => session.date),
        closes: rows.sessions.map((session) => Number(session.close)),
        ratios: VALUATION_RATIO_IDS,
      });
      rows.sessions.forEach((session, index) => {
        for (const ratio of ORACLE_VALUATION_RATIO_IDS) {
          record(
            "pure",
            session.date,
            ratio,
            (columns.get(ratio) as Float64Array)[index] as number,
          );
        }
      });

      if (prepared) {
        const pinned = prepared;
        await guarded("backtest-window", async () => {
          // The worker's read, one calendar year at a time, pinned to the prepared generation.
          const firstYear = Number(serviceFrom.slice(0, 4));
          const lastYear = Number(rows.coverageEnd.slice(0, 4));
          for (let year = firstYear; year <= lastYear; year += 1) {
            const from = year === firstYear ? serviceFrom : `${year}-01-01`;
            const to = year === lastYear ? rows.coverageEnd : `${year}-12-31`;
            const frame = await service.readDailyEvaluationFrame(
              security,
              { from, to },
              operands,
              {
                priceBasisGeneration: pinned.priceBasisGeneration,
                ...(pinned.valuation ? { valuation: pinned.valuation } : {}),
              },
            );
            checkSessions(
              "backtest-window",
              { from, to },
              frame.dates.slice(frame.periodStartIndex),
            );
            for (
              let index = frame.periodStartIndex;
              index < frame.dates.length;
              index += 1
            ) {
              const date = frame.dates[index] as LocalDate;
              for (const ratio of ORACLE_VALUATION_RATIO_IDS) {
                record(
                  "backtest-window",
                  date,
                  ratio,
                  (
                    frame.columns.get(
                      valuationRatioOperand(ratio as ValuationRatioId),
                    ) as Float64Array
                  )[index] as number,
                );
              }
            }
          }
        });

        await guarded("strategy-frame", async () => {
          const frame = await service.getDailyEvaluationFrame(
            security,
            { from: serviceFrom, to: rows.coverageEnd },
            operands,
          );
          checkSessions(
            "strategy-frame",
            { from: serviceFrom, to: rows.coverageEnd },
            frame.dates.slice(frame.periodStartIndex),
          );
          for (
            let index = frame.periodStartIndex;
            index < frame.dates.length;
            index += 1
          ) {
            const date = frame.dates[index] as LocalDate;
            for (const ratio of ORACLE_VALUATION_RATIO_IDS) {
              record(
                "strategy-frame",
                date,
                ratio,
                (
                  frame.columns.get(
                    valuationRatioOperand(ratio as ValuationRatioId),
                  ) as Float64Array
                )[index] as number,
              );
            }
          }
        });

        await guarded("monitor-closed", async () => {
          const newest = rows.sessions.at(-1) as {
            date: LocalDate;
            close: string;
          };
          const observationDate = weekdayAfter(newest.date);
          // As many closed observations as the servable range holds, at most 400.
          let observations = 400;
          const servableDays =
            (Date.parse(`${observationDate}T00:00:00.000Z`) -
              Date.parse(`${serviceFrom}T00:00:00.000Z`)) /
            86_400_000;
          while (
            observations > 20 &&
            monitorWindowCalendarDays(observations) > servableDays
          ) {
            observations -= 10;
          }
          await service.prepareMonitorEvaluationData(
            security,
            observations,
            rows.coverageEnd,
            operands,
          );
          // A quote 1 % above the newest close: inside the split-sized hold, a real observation. At
          // the stored precision, so a tiny close still has a positive quote.
          const quote = Number((Number(newest.close) * 1.01).toFixed(8));
          clock = new Date(`${observationDate}T15:00:00.000Z`);
          const monitor = await service.readMonitorEvaluationFrame({
            security,
            operands,
            observations,
            asOf: observationDate,
            observation: { price: quote },
            observationDate,
          });
          clock = new Date(`${rows.coverageEnd}T12:00:00.000Z`);
          if (!monitor) {
            throw new Error("no Monitor frame");
          }
          const { frame } = monitor;
          const closed = frame.dates.filter(
            (_, index) => index !== monitor.observationIndex,
          );
          checkSessions(
            "monitor-closed",
            { from: closed[0] ?? rows.coverageEnd, to: rows.coverageEnd },
            closed,
          );
          const provisional = oracle.reading(observationDate, String(quote), {
            statementDate: newest.date,
          });
          for (let index = 0; index < frame.dates.length; index += 1) {
            const date = frame.dates[index] as LocalDate;
            for (const ratio of ORACLE_VALUATION_RATIO_IDS) {
              const value = (
                frame.columns.get(
                  valuationRatioOperand(ratio as ValuationRatioId),
                ) as Float64Array
              )[index] as number;
              if (index === monitor.observationIndex) {
                record(
                  "monitor-provisional",
                  date,
                  ratio,
                  value,
                  provisional[ratio],
                );
              } else {
                record("monitor-closed", date, ratio, value);
              }
            }
          }
        });

        await guarded("stock-details", async () => {
          for (const ratio of VALUATION_RATIO_IDS) {
            const points = await service.getDailyValuationRatio(
              rows.symbol,
              ratio,
              {
                from: serviceFrom,
                to: rows.coverageEnd,
              },
            );
            checkSessions(
              "stock-details",
              { from: serviceFrom, to: rows.coverageEnd },
              points.map((point) => point.date),
            );
            for (const point of points) {
              record(
                "stock-details",
                point.date,
                ratio,
                point.value === undefined ? Number.NaN : point.value,
              );
            }
          }
        });
      }
      input.log(
        `${rows.symbol}: ${rows.sessions.length} sessions, refused ${refusedReads.filter((read) => read.symbol === rows.symbol).length} layer(s)`,
      );
    }
  } finally {
    await cleanup(redis, input.namespace);
    redis.disconnect();
  }
  return {
    securities: input.securityIds.length,
    sessions: sessionsTotal,
    tallies,
    layerDisagreements,
    divergences,
    refusedReads,
    sessionMismatches,
    providerCalls,
    intervals,
    readings,
    perSecurity,
  };
}

async function cleanup(
  redis: ReturnType<typeof createStockDataRedisClient>,
  namespace: string,
): Promise<void> {
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(
      cursor,
      "MATCH",
      `${namespace}:*`,
      "COUNT",
      1000,
    );
    cursor = next;
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } while (cursor !== "0");
}

/** The reference's unavailable stretches per ratio, inside the product horizon. */
function unavailableIntervals(
  rows: OracleRows,
  reference: Map<LocalDate, OracleValuationReading>,
  horizonStart: LocalDate,
): Record<OracleValuationRatioId, UnavailableInterval[]> {
  const result = {} as Record<OracleValuationRatioId, UnavailableInterval[]>;
  for (const ratio of ORACLE_VALUATION_RATIO_IDS) {
    const list: UnavailableInterval[] = [];
    let open: UnavailableInterval | undefined;
    for (const session of rows.sessions) {
      if (session.date < horizonStart) {
        continue;
      }
      const outcome = (reference.get(session.date) as OracleValuationReading)[
        ratio
      ];
      if (!outcome.available) {
        if (!open) {
          open = {
            from: session.date,
            to: session.date,
            sessions: 0,
            reasons: {},
          };
          list.push(open);
        }
        open.to = session.date;
        open.sessions += 1;
        open.reasons[outcome.reason] = (open.reasons[outcome.reason] ?? 0) + 1;
      } else if (open) {
        open.resumed = session.date;
        open = undefined;
      }
    }
    result[ratio] = list;
  }
  return result;
}
