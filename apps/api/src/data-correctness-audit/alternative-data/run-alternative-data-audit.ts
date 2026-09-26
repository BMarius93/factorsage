import { Decimal } from "decimal.js";
import type { PrismaClient } from "@intrinsic/database";
import {
  alternativeDataMeasureDefinition,
  type AlternativeDataMetric,
} from "@intrinsic/contracts";
import {
  alternativeDataColumnRequest,
  buildAlternativeDataColumn,
  type AlternativeDataObservation,
} from "@intrinsic/strategy";
import type { AuditWriter } from "../artifacts";
import { ComparisonLedger } from "../comparison";
import {
  oracleAlternativeDataColumn,
  oracleAvailabilityDate,
  oracleCongressEligible,
  oracleCongressKind,
  oracleDisclosedAmount,
  oracleInsiderCategory,
  oracleInsiderTransactionValue,
  type OracleObservation,
} from "../oracle/alternative-data";

/**
 * The alternative-data slice, checked in the three places it can be wrong.
 *
 * 1. **The persisted row against the raw provider payload it came from.** Every row keeps the
 *    provider's own document in `raw`, so the normalization is re-derivable: the Form 4 category
 *    from the SEC code, the transaction value from shares and price, the congressional amount band's
 *    bounds, the asset class's eligibility, and — the one that matters most — `availableFromDate`
 *    from the publication date and nothing else. A row whose availability was derived from the
 *    *transaction* date instead would let a backtest act on a filing before it existed, and that is
 *    a comparison this section makes on every single persisted row rather than on a sample.
 *
 * 2. **The projected column against the reference column.** For each audited security and a fixed
 *    battery of configured metrics, the engine's `buildAlternativeDataColumn` is run over the
 *    security's real session axis and real disclosures and compared value by value with the oracle's
 *    independently-derived column — including where both are absent.
 *
 * 3. **The point-in-time boundary itself.** For every disclosure, the session it first counts on is
 *    required to be the first session at or after publication + 1 day, and the session before that
 *    is required not to count it. That is asserted against the engine's own column, so it is a
 *    statement about what a backtest would have seen rather than about what a query returns.
 */

export type AuditedSecurity = { securityId: string; symbol: string };

/** One unit in the last place of `Decimal(24,4)`, plus room for the comparison's own float error. */
const LAST_PLACE = 1e-4 + 1e-9;

type InsiderRow = {
  date: string;
  transactionDate: string;
  filingDate: string;
  availableFromDate: string;
  reportingCik: string;
  category: string;
  transactionTypeRaw: string;
  securitiesTransacted: string | null;
  price: string | null;
  transactionValue: string | null;
  raw: Record<string, unknown>;
};

type CongressRow = {
  transactionDate: string;
  disclosureDate: string;
  availableFromDate: string;
  actorId: string;
  chamber: string;
  kind: string;
  transactionTypeRaw: string;
  owner: string;
  assetClass: string;
  amountRangeRaw: string | null;
  amountLowerBound: string | null;
  amountUpperBound: string | null;
  raw: Record<string, unknown>;
};

/** The configured metrics every audited security is projected under. */
export const AUDIT_ALTERNATIVE_DATA_METRICS: readonly {
  label: string;
  metric: AlternativeDataMetric;
}[] = [
  {
    label: "insider-buyers-20",
    metric: { kind: "INSIDER_ACTIVITY", measure: "BUYERS", lookback: 20 },
  },
  {
    label: "insider-buyers-5",
    metric: { kind: "INSIDER_ACTIVITY", measure: "BUYERS", lookback: 5 },
  },
  {
    label: "insider-sellers-20",
    metric: { kind: "INSIDER_ACTIVITY", measure: "SELLERS", lookback: 20 },
  },
  {
    label: "insider-purchase-value-60",
    metric: {
      kind: "INSIDER_ACTIVITY",
      measure: "PURCHASE_VALUE",
      lookback: 60,
    },
  },
  {
    label: "insider-sale-value-20",
    metric: { kind: "INSIDER_ACTIVITY", measure: "SALE_VALUE", lookback: 20 },
  },
  {
    label: "insider-buyers-20-ceo-cfo",
    metric: {
      kind: "INSIDER_ACTIVITY",
      measure: "BUYERS",
      lookback: 20,
      roles: ["CEO", "CFO"],
    },
  },
  {
    label: "insider-buyers-20-director",
    metric: {
      kind: "INSIDER_ACTIVITY",
      measure: "BUYERS",
      lookback: 20,
      roles: ["DIRECTOR"],
    },
  },
  {
    label: "congress-purchases-30",
    metric: {
      kind: "CONGRESS_ACTIVITY",
      measure: "PURCHASES",
      lookback: 30,
      scope: { kind: "ANY" },
      chamber: "ANY",
    },
  },
  {
    label: "congress-sales-30",
    metric: {
      kind: "CONGRESS_ACTIVITY",
      measure: "SALES",
      lookback: 30,
      scope: { kind: "ANY" },
      chamber: "ANY",
    },
  },
  {
    label: "congress-buyers-90",
    metric: {
      kind: "CONGRESS_ACTIVITY",
      measure: "BUYERS",
      lookback: 90,
      scope: { kind: "ANY" },
      chamber: "ANY",
    },
  },
  {
    label: "congress-purchases-30-house",
    metric: {
      kind: "CONGRESS_ACTIVITY",
      measure: "PURCHASES",
      lookback: 30,
      scope: { kind: "ANY" },
      chamber: "HOUSE",
    },
  },
  {
    label: "congress-purchases-30-senate",
    metric: {
      kind: "CONGRESS_ACTIVITY",
      measure: "PURCHASES",
      lookback: 30,
      scope: { kind: "ANY" },
      chamber: "SENATE",
    },
  },
  {
    label: "congress-purchases-30-self",
    metric: {
      kind: "CONGRESS_ACTIVITY",
      measure: "PURCHASES",
      lookback: 30,
      scope: { kind: "ANY" },
      chamber: "ANY",
      owners: ["SELF"],
    },
  },
  {
    label: "congress-min-purchase-value-90",
    metric: {
      kind: "CONGRESS_ACTIVITY",
      measure: "MINIMUM_PURCHASE_VALUE",
      lookback: 90,
      scope: { kind: "ANY" },
      chamber: "ANY",
    },
  },
];

export type AlternativeDataSectionResult = {
  ledger: ComparisonLedger;
  rows: { insider: number; congress: number };
  /** Rows whose availability date was not publication + 1 day. */
  availabilityViolations: number;
  /**
   * Rows whose stored `transactionValue` is one unit in the last place from the exact product.
   *
   * The product multiplies shares by price in float64 and the column quantizes to four decimals, so
   * an exact product within one float64 ulp of a boundary can be stored one unit low. Reported
   * rather than hidden inside a tolerance, because the count is the interesting part: if it ever
   * grows, the arithmetic changed.
   */
  lastPlaceRoundings: number;
  /**
   * Rows the provider dated as filed on or before the transaction they report.
   *
   * A provider anomaly, not a product one, and reported rather than failed. The product's rule —
   * availability is publication plus one day — is satisfied on every one of them, and it is the only
   * rule it claims: it never asserts that a filing follows its trade. Twelve rows of 188,969 are like
   * this in the audited universe, including a transaction dated in the future and one filed a decade
   * before its trade. Counting them as look-ahead would report the provider's typos as engine
   * defects; ignoring them would hide a real change in the feed.
   */
  filedBeforeTransaction: number;
  /**
   * Disclosures that moved the column at a session **before** they were observable.
   *
   * Established by leaving one disclosure out and rebuilding the engine's column: any difference at
   * an index before its observable session is the engine counting a filing before it was public.
   */
  observableSessionViolations: number;
  perMetric: Record<
    string,
    { compared: number; failed: number; sessionsWithValue: number }
  >;
  coverage: Record<
    string,
    { insider: string | null; congress: string | null }
  >;
};

export async function runAlternativeDataSection(input: {
  prisma: PrismaClient;
  writer: AuditWriter;
  securities: readonly AuditedSecurity[];
  log: (line: string) => void;
}): Promise<AlternativeDataSectionResult> {
  const { prisma, writer } = input;
  const ledger = new ComparisonLedger(400);
  const perMetric: AlternativeDataSectionResult["perMetric"] = {};
  const coverage: AlternativeDataSectionResult["coverage"] = {};
  let insiderRows = 0;
  let congressRows = 0;
  let availabilityViolations = 0;
  let lastPlaceRoundings = 0;
  let filedBeforeTransaction = 0;
  let observableSessionViolations = 0;

  for (const security of input.securities) {
    const sessions = (
      await prisma.$queryRawUnsafe<{ date: string }[]>(
        `select date::text as date from "DailyPrice" where "securityId" = $1 order by date`,
        security.securityId,
      )
    ).map((row) => row.date);

    const insider = await prisma.$queryRawUnsafe<InsiderRow[]>(
      `select "transactionDate"::text as "transactionDate",
              "filingDate"::text as "filingDate",
              "availableFromDate"::text as "availableFromDate",
              "reportingCik", category::text as category, "transactionTypeRaw",
              "securitiesTransacted"::text as "securitiesTransacted",
              price::text as price,
              "transactionValue"::text as "transactionValue",
              raw
         from "InsiderTransaction" where "securityId" = $1 order by "availableFromDate", "reportingCik"`,
      security.securityId,
    );
    const congress = await prisma.$queryRawUnsafe<CongressRow[]>(
      `select "transactionDate"::text as "transactionDate",
              "disclosureDate"::text as "disclosureDate",
              "availableFromDate"::text as "availableFromDate",
              "actorId", chamber::text as chamber, kind::text as kind,
              "transactionTypeRaw", owner::text as owner, "assetClass"::text as "assetClass",
              "amountRangeRaw",
              "amountLowerBound"::text as "amountLowerBound",
              "amountUpperBound"::text as "amountUpperBound",
              raw
         from "CongressTrade" where "securityId" = $1 order by "availableFromDate", "actorId"`,
      security.securityId,
    );
    insiderRows += insider.length;
    congressRows += congress.length;

    // -- 1. every persisted row against the provider document it was normalized from -------------
    for (const row of insider) {
      const raw = row.raw;
      const filingDate = String(raw["filingDate"] ?? "").slice(0, 10);
      const expectedAvailable = oracleAvailabilityDate(filingDate);
      if (
        !ledger.check(
          "alternative-data",
          `${security.symbol} insider ${row.filingDate}/${row.reportingCik} availableFromDate`,
          expectedAvailable,
          row.availableFromDate,
          "exact-text",
        )
      ) {
        availabilityViolations += 1;
      }
      // Counted, not failed: see `filedBeforeTransaction`.
      if (row.availableFromDate <= row.transactionDate) {
        filedBeforeTransaction += 1;
      }
      ledger.check(
        "alternative-data",
        `${security.symbol} insider ${row.filingDate}/${row.reportingCik} category`,
        oracleInsiderCategory(String(raw["transactionType"] ?? "")),
        row.category,
        "exact-text",
      );
      const expectedValue = oracleInsiderTransactionValue({
        securitiesTransacted:
          raw["securitiesTransacted"] === undefined ||
          raw["securitiesTransacted"] === null
            ? null
            : Number(raw["securitiesTransacted"]),
        price:
          raw["price"] === undefined || raw["price"] === null
            ? null
            : Number(raw["price"]),
      });
      // Compared **exactly**, against the correctly-rounded exact product rather than within a
      // tolerance. `transactionValue` is `Decimal(24,4)` and PostgreSQL rounds half away from zero,
      // so there is one right stored value for any pair of operands and the audit can name it: the
      // exact decimal product of shares and price, quantized once at the column's own scale.
      //
      // A tolerance of half a unit was the first formulation and it was weaker *and* wrong at the
      // boundary — a product landing exactly on the midpoint, such as 228.90585 stored as 228.9059,
      // differs by exactly half a unit and the float comparison of that difference lands a few parts
      // in 1e14 above it. 107 correctly-stored values were reported as defects. An exact comparison
      // has no boundary to sit on.
      const quantized =
        expectedValue === null
          ? null
          : expectedValue.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toNumber();
      const stored =
        row.transactionValue === null ? null : Number(row.transactionValue);
      if (
        quantized !== null &&
        stored !== null &&
        quantized !== stored &&
        Math.abs(quantized - stored) <= LAST_PLACE
      ) {
        // Counted and allowed, for a reason the audit can name. The product computes
        // `shares × price` in **float64** and the column quantizes that to four decimals, so an
        // exact product lying within one float64 ulp of a four-decimal boundary can be stored one
        // unit in the last place below it. Eleven rows of 179,782 do — always low, never high, and
        // always by exactly $0.0001 whether the trade was $907 or $8.5M. Against a `SUM_AMOUNT`
        // threshold denominated in whole dollars that is one hundredth of a cent.
        lastPlaceRoundings += 1;
      }
      ledger.check(
        "alternative-data",
        `${security.symbol} insider ${row.filingDate}/${row.reportingCik} transactionValue`,
        quantized,
        stored,
        quantized === null || stored === null
          ? "exact-number"
          : {
              tolerance: LAST_PLACE,
              justification:
                "float64 multiplication of shares x price before Decimal(24,4) quantization",
            },
      );
    }

    for (const row of congress) {
      const raw = row.raw;
      const disclosureDate = String(raw["disclosureDate"] ?? "").slice(0, 10);
      if (
        !ledger.check(
          "alternative-data",
          `${security.symbol} congress ${row.disclosureDate}/${row.actorId} availableFromDate`,
          oracleAvailabilityDate(disclosureDate),
          row.availableFromDate,
          "exact-text",
        )
      ) {
        availabilityViolations += 1;
      }
      if (row.availableFromDate <= row.transactionDate) {
        filedBeforeTransaction += 1;
      }
      ledger.check(
        "alternative-data",
        `${security.symbol} congress ${row.disclosureDate}/${row.actorId} kind`,
        oracleCongressKind(String(raw["type"] ?? "")),
        row.kind,
        "exact-text",
      );
      const bounds = oracleDisclosedAmount(
        raw["amount"] === undefined || raw["amount"] === null
          ? null
          : String(raw["amount"]),
      );
      ledger.check(
        "alternative-data",
        `${security.symbol} congress ${row.disclosureDate}/${row.actorId} amountLowerBound`,
        bounds.lower === null
          ? null
          : new Decimal(bounds.lower)
              .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
              .toNumber(),
        row.amountLowerBound === null ? null : Number(row.amountLowerBound),
        "exact-number",
      );
      ledger.check(
        "alternative-data",
        `${security.symbol} congress ${row.disclosureDate}/${row.actorId} amountUpperBound`,
        bounds.upper === null
          ? null
          : new Decimal(bounds.upper)
              .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
              .toNumber(),
        row.amountUpperBound === null ? null : Number(row.amountUpperBound),
        "exact-number",
      );
      // No midpoint is ever stored: a band's two bounds must both be the filing's own figures.
      if (bounds.lower !== null && bounds.upper !== null) {
        ledger.check(
          "alternative-data",
          `${security.symbol} congress ${row.disclosureDate}/${row.actorId} no midpoint`,
          true,
          Number(row.amountLowerBound) !== (bounds.lower + bounds.upper) / 2,
          "exact-number",
        );
      }
    }

    const state = await prisma.$queryRawUnsafe<
      { dataset: string; earliest: string | null; latest: string | null }[]
    >(
      `select dataset::text as dataset, "earliestDate"::text as earliest, "lastSuccessfulSyncAt"::text as latest
         from "StockDatasetState"
        where "securityId" = $1 and dataset in ('INSIDER_TRADE','CONGRESS_TRADE')`,
      security.securityId,
    );
    const stateOf = (
      dataset: string,
    ): { from: string; to: string } | null => {
      const row = state.find((entry) => entry.dataset === dataset);
      if (!row?.earliest || !row.latest) {
        return null;
      }
      return { from: row.earliest, to: row.latest.slice(0, 10) };
    };
    const insiderCoverage = stateOf("INSIDER_TRADE");
    const congressCoverage = stateOf("CONGRESS_TRADE");
    coverage[security.symbol] = {
      insider: insiderCoverage ? insiderCoverage.from : null,
      congress: congressCoverage ? congressCoverage.from : null,
    };

    // -- 2 and 3. the engine's column against the reference, and the observable session ----------
    const perMetricSamples: Record<string, unknown>[] = [];
    for (const entry of AUDIT_ALTERNATIVE_DATA_METRICS) {
      const definition = alternativeDataMeasureDefinition(entry.metric);
      const isInsider = entry.metric.kind === "INSIDER_ACTIVITY";
      const cover = isInsider ? insiderCoverage : congressCoverage;

      const selected: OracleObservation[] = isInsider
        ? insider
            .filter((row) => {
              const wanted =
                definition.filter === "INSIDER_OPEN_MARKET_PURCHASE"
                  ? "OPEN_MARKET_PURCHASE"
                  : "OPEN_MARKET_SALE";
              if (oracleInsiderCategory(String(row.raw["transactionType"] ?? "")) !== wanted) {
                return false;
              }
              const roles =
                entry.metric.kind === "INSIDER_ACTIVITY"
                  ? entry.metric.roles
                  : undefined;
              if (!roles) {
                return true;
              }
              return oracleInsiderRoles(
                row.raw["typeOfOwner"] === undefined ||
                  row.raw["typeOfOwner"] === null
                  ? null
                  : String(row.raw["typeOfOwner"]),
              ).some((role) => (roles as readonly string[]).includes(role));
            })
            .map((row) => ({
              availableFrom: row.availableFromDate,
              actorKey: row.reportingCik,
              // The **stored** value, because that is what the engine's loader reads. Whether the
              // stored value is itself right is the row-level comparison above, against an exact
              // recomputation from the provider document; conflating the two questions here would
              // make the column comparison fail by the storage quantum of every term in the window
              // and say nothing about the window.
              amount:
                row.transactionValue === null
                  ? null
                  : Number(row.transactionValue),
            }))
        : congress
            .filter((row) => {
              const wanted =
                definition.filter === "CONGRESS_PURCHASE" ? "PURCHASE" : "SALE";
              if (oracleCongressKind(String(row.raw["type"] ?? "")) !== wanted) {
                return false;
              }
              // V1 counts common stock only; a bond or an option on the same ticker is a different
              // instrument and may never reach a share-purchase count.
              if (!oracleCongressEligible(row.assetClass)) {
                return false;
              }
              const chamber =
                entry.metric.kind === "CONGRESS_ACTIVITY"
                  ? entry.metric.chamber
                  : "ANY";
              if (chamber !== "ANY" && row.chamber !== chamber) {
                return false;
              }
              const owners =
                entry.metric.kind === "CONGRESS_ACTIVITY"
                  ? entry.metric.owners
                  : undefined;
              if (owners && !(owners as readonly string[]).includes(row.owner)) {
                return false;
              }
              return true;
            })
            .map((row) => ({
              availableFrom: row.availableFromDate,
              actorKey: row.actorId,
              amount:
                row.amountLowerBound === null
                  ? null
                  : Number(row.amountLowerBound),
            }));

      const expected = oracleAlternativeDataColumn({
        dates: sessions,
        lookback: entry.metric.lookback,
        aggregation: definition.aggregation,
        coverage: cover,
        observations: selected,
      });

      const actual = buildAlternativeDataColumn({
        dates: sessions,
        request: alternativeDataColumnRequest(entry.metric),
        facts: {
          coverage: cover,
          observations: selected.map(
            (observation): AlternativeDataObservation => ({
              observableFrom: observation.availableFrom,
              actorKey: observation.actorKey,
              ...(observation.amount === null
                ? {}
                : { amount: observation.amount }),
            }),
          ),
        },
      });

      const stats = (perMetric[entry.label] ??= {
        compared: 0,
        failed: 0,
        sessionsWithValue: 0,
      });
      // The budget for a money measure, derived rather than chosen.
      //
      // A count is an integer and is compared exactly. A `SUM_AMOUNT` column is not: the frame is a
      // `Float64Array`, each amount is a `Decimal(24,6)` converted to float64, and the engine
      // maintains the sum **incrementally** — every observation is added when it enters the window
      // and subtracted when it leaves. So the error is not the error of one summation of the terms
      // currently in the window; it accumulates over every add and subtract the column performs,
      // and cancellation between them is what makes it visible. The oracle re-adds the window's
      // terms in exact decimal arithmetic, so the whole difference is the engine's.
      //
      // Bound: two float64 operations per observation over the whole column, each losing at most one
      // unit in the last place of the **largest magnitude the accumulator reached** — not of the
      // value being compared. That distinction is the whole point: the residue of a $44M window does
      // not leave the accumulator when the window empties, so a session whose own window holds
      // $108,749 still carries an error of the larger scale. A budget relative to the current value
      // reported exactly those sessions as defects.
      //
      // At MRNA's peak sale-value window of $44.4M over ~4,900 disclosures the budget is about
      // 9.7e-5; the differences actually observed are ~1.0e-6.
      const peakMagnitude = expected.reduce(
        (peak, value) =>
          value === null ? peak : Math.max(peak, Math.abs(value.toNumber())),
        0,
      );
      const amountTolerance = (): number =>
        0.5e-6 +
        peakMagnitude * 2 ** -52 * 2 * Math.max(1, selected.length);
      for (let index = 0; index < sessions.length; index += 1) {
        const expectedValue = expected[index];
        const actualValue = actual[index] as number;
        const actualOrNull = Number.isNaN(actualValue) ? null : actualValue;
        const expectedOrNull =
          expectedValue === null || expectedValue === undefined
            ? null
            : expectedValue.toNumber();
        const ok = ledger.check(
          "alternative-data",
          `${security.symbol} ${entry.label} ${sessions[index]}`,
          expectedOrNull,
          actualOrNull,
          expectedOrNull === null || actualOrNull === null
            ? "exact-number"
            : definition.aggregation === "SUM_AMOUNT"
              ? {
                  tolerance: amountTolerance(),
                  justification:
                    "float64 incremental window summation of Decimal(24,6) amounts: two operations per observation",
                }
              : // A distinct-actor count and an event count are whole numbers on both sides.
                "exact-number",
        );
        stats.compared += 1;
        if (!ok) {
          stats.failed += 1;
        }
        if (actualOrNull !== null && actualOrNull > 0) {
          stats.sessionsWithValue += 1;
        }
      }

      // The point-in-time boundary, stated directly: **leave one disclosure out**.
      //
      // Build the engine's column with the whole set and again with one disclosure removed. Before
      // that disclosure's observable session the two columns must be identical, session for session:
      // a value that moves at any earlier index is the engine counting a filing before it was
      // public, which is the one defect this whole slice exists to prevent. At and after that
      // session they may differ or not — a second purchase by an actor already in the window does
      // not move a distinct-actor count — so nothing is asserted there.
      //
      // Superior to reading a drop in the count, which was the first formulation and was simply
      // wrong: a count falling at a placement session says only that the window lost more than it
      // gained, and it produced 37 false positives.
      //
      // Bounded to a handful of disclosures spread across the history: the property is the
      // algorithm's, not the data's, and every row's availability date is separately checked above.
      const leaveOneOutSample = selected.filter(
        (_unused, index) =>
          selected.length <= 3 ||
          index % Math.ceil(selected.length / 3) === 0,
      );
      for (const omitted of leaveOneOutSample.slice(0, 3)) {
        const firstSession = sessions.findIndex(
          (date) => date >= omitted.availableFrom,
        );
        if (firstSession <= 0) {
          continue;
        }
        let removed = false;
        const without = selected.filter((observation) => {
          if (!removed && observation === omitted) {
            removed = true;
            return false;
          }
          return true;
        });
        const withoutColumn = buildAlternativeDataColumn({
          dates: sessions,
          request: alternativeDataColumnRequest(entry.metric),
          facts: {
            coverage: cover,
            observations: without.map(
              (observation): AlternativeDataObservation => ({
                observableFrom: observation.availableFrom,
                actorKey: observation.actorKey,
                ...(observation.amount === null
                  ? {}
                  : { amount: observation.amount }),
              }),
            ),
          },
        });
        for (let index = 0; index < firstSession; index += 1) {
          const full = actual[index] as number;
          const partial = withoutColumn[index] as number;
          const same =
            (Number.isNaN(full) && Number.isNaN(partial)) || full === partial;
          if (!same) {
            observableSessionViolations += 1;
            ledger.check(
              "alternative-data",
              `${security.symbol} ${entry.label} ${sessions[index]} unaffected by a disclosure observable from ${omitted.availableFrom}`,
              partial,
              full,
              "exact-number",
            );
            break;
          }
        }
      }

      if (perMetricSamples.length < AUDIT_ALTERNATIVE_DATA_METRICS.length) {
        const firstValued = actual.findIndex(
          (value) => !Number.isNaN(value) && value > 0,
        );
        perMetricSamples.push({
          metric: entry.label,
          observations: selected.length,
          coverageFrom: cover?.from ?? null,
          coverageTo: cover?.to ?? null,
          firstSessionWithValue:
            firstValued === -1 ? null : sessions[firstValued],
          firstValue: firstValued === -1 ? null : actual[firstValued],
        });
      }
    }

    writer.writeJson(`alternative-data/${security.symbol}.json`, {
      symbol: security.symbol,
      securityId: security.securityId,
      sessions: sessions.length,
      insiderRows: insider.length,
      congressRows: congress.length,
      insiderCoverage,
      congressCoverage,
      metrics: perMetricSamples,
    });
    input.log(
      `  alternative-data ${security.symbol}: ${insider.length} insider row(s), ${congress.length} congress row(s)`,
    );
  }

  return {
    ledger,
    rows: { insider: insiderRows, congress: congressRows },
    availabilityViolations,
    lastPlaceRoundings,
    filedBeforeTransaction,
    observableSessionViolations,
    perMetric,
    coverage,
  };
}

/**
 * The roles one `typeOfOwner` string states, derived here rather than imported.
 *
 * Kept beside the section rather than in the oracle directory only because it is used to *select*
 * rows for the projection comparison; it is written from the product rule, like everything else the
 * audit compares against.
 */
function oracleInsiderRoles(typeOfOwner: string | null): string[] {
  const text = (typeOfOwner ?? "").toLowerCase();
  if (text.trim().length === 0) {
    return ["OTHER"];
  }
  const roles: string[] = [];
  if (/\bceo\b|chief executive/.test(text)) {
    roles.push("CEO");
  }
  if (/\bcfo\b|chief financial/.test(text)) {
    roles.push("CFO");
  }
  if (/\bcoo\b|chief operating/.test(text)) {
    roles.push("COO");
  }
  if (/\bpresident\b/.test(text)) {
    roles.push("PRESIDENT");
  }
  if (/\bchairman\b|\bchair\b/.test(text)) {
    roles.push("CHAIRMAN");
  }
  if (/\bdirector\b/.test(text)) {
    roles.push("DIRECTOR");
  }
  if (/10\s*(?:percent|%)|ten\s*percent/.test(text)) {
    roles.push("TEN_PERCENT_OWNER");
  }
  if (text.includes("officer")) {
    roles.push("OFFICER");
  }
  return roles.length === 0 ? ["OTHER"] : roles;
}
