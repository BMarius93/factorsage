import {
  VALUATION_AUDIT_BACKTESTS,
  VALUATION_AUDIT_CURRENCY,
  VALUATION_AUDIT_EVENTS,
  VALUATION_AUDIT_FIRST_SESSION,
  VALUATION_AUDIT_LAST_SESSION,
  VALUATION_AUDIT_SPLITS,
  VALUATION_AUDIT_VERIFIED_AT,
  valuationAuditSessions,
  valuationAuditStatements,
  type ValuationAuditBacktest,
} from "@intrinsic/testing";
import { prismaFloatBoundAtScale } from "../oracle/decimal";
import { oracleFundamentalMetrics } from "../oracle/fundamentals";
import { simpleMovingAverage } from "../oracle/indicators";
import type { MarketRow } from "../oracle/predicates";
import {
  runReferenceBacktest,
  type OracleBacktestResult,
} from "../oracle/reference-backtester";
import { oracleRelativeVolume } from "../oracle/relative-volume";
import { parseOracleStrategy } from "../oracle/strategy-model";
import {
  createValuationOracle,
  ORACLE_VALUATION_RATIO_IDS,
  type OracleValuationSecurity,
} from "../oracle/valuation-ratios";

/**
 * The reference side of the valuation backtest audit: the anchor's stored rows
 * (`@intrinsic/testing`, `valuation-audit.ts`) read by the clean-room oracles, and every anchor
 * backtest run through the reference backtester.
 *
 * Each session's row carries the readings a frame column would hold:
 *
 * - every valuation ratio from the valuation oracle, as the double nearest its exact value (a
 *   ratio is never stored, so the product compares its own double);
 * - SMA 50D, RVOL 20 and Net Margin TTM from the independent indicator, relative-volume and
 *   fundamentals oracles, **at storage scale** — the product compares the `DECIMAL(20,8)` value it
 *   persisted, bound through sixteen significant digits (`oracle/decimal.ts`) — so a comparison is
 *   made on the number the engine actually reads.
 *
 * Only the inputs come from the fixture; nothing here reads the product.
 */

export const VALUATION_AUDIT_SECURITY_ID = "valuation-audit-security";
export const VALUATION_AUDIT_SYMBOL = "VALAUD";

export function valuationAuditOracleSecurity(): OracleValuationSecurity {
  return {
    currency: VALUATION_AUDIT_CURRENCY,
    statements: valuationAuditStatements().map((statement) => ({
      ...statement,
    })),
    verifiedAt: VALUATION_AUDIT_VERIFIED_AT,
    events: VALUATION_AUDIT_EVENTS.map((event) => ({
      kind: event.kind,
      effectiveDate: event.effectiveDate,
      priceRatio: String(event.priceRatio),
      detectedAt: event.detectedAt,
    })),
    splits: VALUATION_AUDIT_SPLITS.map((split) => ({
      date: split.date,
      numerator: String(split.numerator),
      denominator: String(split.denominator),
      label: split.label,
    })),
  };
}

const stored = (value: number) => Number(prismaFloatBoundAtScale(value, 8));

/** The reference's row for every anchor session. */
export function valuationAuditRows(): MarketRow[] {
  const sessions = valuationAuditSessions();
  const oracle = createValuationOracle(valuationAuditOracleSecurity());
  const closes = sessions.map((session) => Number(session.close));
  const sma50 = simpleMovingAverage(closes, 50);
  const rvol20 = oracleRelativeVolume(
    sessions.map((session) => session.volume),
    20,
  );
  const statements = valuationAuditStatements();
  return sessions.map((session, index) => {
    const values = new Map<string, number>();
    const reading = oracle.reading(session.date, session.close);
    for (const ratio of ORACLE_VALUATION_RATIO_IDS) {
      const outcome = reading[ratio];
      if (outcome.available) {
        values.set(`valuation:${ratio}`, outcome.double);
      }
    }
    const sma = sma50[index];
    if (sma !== null && sma !== undefined) {
      values.set("series:SMA_50D", stored(sma));
    }
    const rvol = rvol20[index];
    if (rvol !== null && rvol !== undefined) {
      values.set("relative-volume:20", stored(rvol.toNumber()));
    }
    const netMargin = oracleFundamentalMetrics(
      statements,
      session.date,
    ).NET_MARGIN_TTM;
    if (netMargin !== undefined) {
      values.set("fundamental:NET_MARGIN_TTM", stored(netMargin));
    }
    return { date: session.date, close: closes[index] as number, values };
  });
}

/** The reference backtest of one anchor case. */
export function referenceValuationBacktest(
  backtest: ValuationAuditBacktest,
  rows: readonly MarketRow[] = valuationAuditRows(),
): OracleBacktestResult {
  return runReferenceBacktest({
    strategy: parseOracleStrategy(backtest.definition),
    securities: [
      {
        securityId: VALUATION_AUDIT_SECURITY_ID,
        symbol: VALUATION_AUDIT_SYMBOL,
        buyWindowMode: backtest.buyWindows.length > 0 ? "CUSTOM" : "FULL",
        buyWindows: backtest.buyWindows,
        rows,
      },
    ],
    calendar: rows.map((row) => row.date),
    startDate: VALUATION_AUDIT_FIRST_SESSION,
    endDate: VALUATION_AUDIT_LAST_SESSION,
    initialCapital: 100_000,
    monthlyContribution: 0,
    maximumPositions: 1,
    benchmark: null,
  });
}

/** The reference's Strategy trades for every anchor case: `[date, action, levelId]`. */
export function referenceValuationTrades(): Record<
  string,
  [string, string, string][]
> {
  const rows = valuationAuditRows();
  return Object.fromEntries(
    VALUATION_AUDIT_BACKTESTS.map((backtest) => [
      backtest.id,
      referenceValuationBacktest(backtest, rows)
        .trades.filter((trade) => trade.source === "STRATEGY")
        .map((trade): [string, string, string] => [
          trade.date,
          trade.action,
          trade.levelId ?? trade.exitRuleId ?? "",
        ]),
    ]),
  );
}
