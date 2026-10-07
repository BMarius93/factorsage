import type { ValuationRatioId } from "@intrinsic/contracts";
import type {
  FinancialStatement,
  LocalDate,
  SecurityId,
  StockSplit,
} from "@intrinsic/domain";
import {
  buildValuationTimeline,
  valuationRatioColumns,
  type PriceBasisEvent,
  type ValuationInputs,
  type ValuationTimeline,
} from "@intrinsic/stock-data";
import type {
  OracleValuationRatioId,
  OracleValuationSecurity,
} from "../oracle/valuation-ratios";

/**
 * The bridge from the oracle's input shapes (stored rows, as the reference reads them) to the
 * product's calculation inputs, and the product's own calculation run over them. Nothing here
 * decides anything: it converts types the way the product's store does (decimals read as doubles,
 * absent columns as absent fields) and calls `buildValuationTimeline` and `valuationRatioColumns`.
 */

export const AUDIT_SECURITY_ID = "audit-security" as SecurityId;

/** The product's identities for the oracle's: the same five strings, checked rather than cast. */
export function productRatioId(id: OracleValuationRatioId): ValuationRatioId {
  return id;
}

/**
 * The day before `date`. A stored row with a real filing date becomes available the day after it
 * (`statementPublicAvailabilityDate`), so the product sees every revision filed a day before its
 * availability, as in the store: a calculation that read the filing date instead would see each
 * revision a day early, and the comparison would show it.
 */
function dayBefore(date: string): LocalDate {
  const instant = new Date(`${date}T00:00:00.000Z`);
  instant.setUTCDate(instant.getUTCDate() - 1);
  return instant.toISOString().slice(0, 10) as LocalDate;
}

export function toProductInputs(
  security: OracleValuationSecurity,
  securityId: SecurityId = AUDIT_SECURITY_ID,
): ValuationInputs {
  return {
    securityId,
    currency: security.currency,
    verifiedAt: security.verifiedAt,
    statements: security.statements.map(
      (statement) =>
        ({
          securityId,
          statementType: statement.statementType,
          fiscalDate: statement.fiscalDate,
          fiscalYear: statement.fiscalYear,
          period: statement.period,
          reportedCurrency: statement.reportedCurrency,
          filingDate: dayBefore(statement.availableFromDate),
          availableFromDate: statement.availableFromDate,
          observedAt: statement.observedAt,
          contentHash: statement.contentHash,
          values: statement.values,
        }) as FinancialStatement,
    ),
    events: security.events.map((event, index): PriceBasisEvent => ({
      securityId,
      generation: 1,
      kind: event.kind,
      ...(event.effectiveDate ? { effectiveDate: event.effectiveDate } : {}),
      ...(event.effectiveFrom ? { effectiveFrom: event.effectiveFrom } : {}),
      ...(event.effectiveTo ? { effectiveTo: event.effectiveTo } : {}),
      ...(event.priceRatio !== undefined && event.priceRatio !== null
        ? { priceRatio: Number(event.priceRatio) }
        : {}),
      detectedAt: event.detectedAt,
      evidence: {
        runs: [],
        comparedSessions: index,
        changedSessions: 0,
        unfittedSessions: 0,
      },
    })),
    splits: security.splits.map((split): StockSplit => ({
      securityId,
      date: split.date,
      numerator: Number(split.numerator),
      denominator: Number(split.denominator),
      label: split.label,
    })),
  };
}

export function productTimeline(
  security: OracleValuationSecurity,
): ValuationTimeline {
  return buildValuationTimeline(toProductInputs(security));
}

/** The product's five columns over `dates` at `closes` (decimal text read as doubles). */
export function productColumns(input: {
  timeline: ValuationTimeline;
  dates: readonly LocalDate[];
  closes: readonly (string | number)[];
  ratios: readonly OracleValuationRatioId[];
  statementDateOf?: (index: number) => LocalDate;
}): Map<OracleValuationRatioId, Float64Array> {
  return valuationRatioColumns({
    timeline: input.timeline,
    dates: input.dates,
    closes: Float64Array.from(input.closes, (close) => Number(close)),
    ratios: input.ratios.map(productRatioId),
    ...(input.statementDateOf
      ? { statementDateOf: input.statementDateOf }
      : {}),
  }) as Map<OracleValuationRatioId, Float64Array>;
}
