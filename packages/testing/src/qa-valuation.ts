/**
 * The valuation inputs of the fictional QA security `QATEST1`, defined once.
 *
 * Valuation ratios are never stored per session: Stock Details computes them when it reads them,
 * with the calculation Strategy, Backtest and Monitor read, from the stored closes, the
 * point-in-time statements, the price basis and the provider's split list. So unlike the Fundamental
 * Metrics fixture (`./qa-fundamentals`), this one seeds **inputs** — invented filings for a company
 * that does not exist, a verified price basis and one measured re-base — and every reading the
 * browser sees is the production calculation's. The Stock Details browser suite derives its
 * expectations about *where* each ratio is available from the tables below, written out by hand
 * from `docs/decisions/valuation-ratios-v1.md`, never from the calculation.
 *
 * Deliberately free of workspace imports, like `./qa-fundamentals`: the Playwright harness imports
 * it through a dependency-free subpath. Identities are plain strings; the seed's own test pins them
 * to the product catalog.
 *
 * The calendar is the seed's: 160 complete Monday-Friday weeks with no holidays, week 0 starting on
 * the seed's first Monday. Every date here is a function of that Monday alone.
 *
 * - **Quarters.** Quarter `i` (0-11) ends the Sunday before week `13i` and is filed the Sunday before
 *   week `13i + 6`, so it is public from that week's Monday: weeks 6, 19, 32, ..., 149. 1,000,000
 *   diluted shares throughout; revenue 10M, EBITDA 4M, net income 2.5M a quarter (5M from quarter
 *   9); operating cash flow 1M against capital expenditure 3M, so free cash flow is negative on
 *   every trailing year; equity 50M; net debt 20M, except **net cash of 300M** on the balance sheets
 *   of quarters 8 and 9 — more than the market capitalisation, so EV/EBITDA is negative while they
 *   are the latest.
 * - **Observation.** Quarters 0-9 were first observed by a sync on the Monday of week 124; quarters
 *   10 and 11 by the seed itself.
 * - **Price basis.** Verified on the Monday of week 100. The loader then measured a re-base effective
 *   on the Monday of week 130 with a price ratio of 1.05 — not a plain share change, so possibly a
 *   distribution — detected the next day. The split list is empty.
 *
 * What the rules make of it, per ratio (`QA_VALUATION_AVAILABILITY`):
 *
 * - P/E, P/S and EV/EBITDA need a trailing year: available from week 45. P/B needs one quarter's
 *   statements, but rule 2 confirms the walk's first count only on the third quarter agreeing with
 *   it (owner, 2026-10-06): from week 32, when quarter 2 is public. P/FCF's free cash flow is never
 *   positive: unavailable on every session.
 * - Every session before week 130 reads its count, observed before the re-base was detected, against
 *   the close restored to that basis (x1.05). From week 130 the counts observed before the detection
 *   cannot be placed (rule 6), and from week 136 — quarter 10, observed after it — the ratios still
 *   wait for statements covering a fiscal period that ends on or after the event (rule 7): quarter
 *   11, public from week 149. So **weeks 130-148 are unavailable** for every ratio, and every ratio
 *   resumes on the Monday of week 149.
 */

export type QaValuationQuarter = {
  /** The quarter's position: it ends before week `13 * index` and is public from week `13 * index + 6`. */
  readonly index: number;
  readonly income: Readonly<Record<string, number>>;
  readonly balanceSheet: Readonly<Record<string, number>>;
  readonly cashFlow: Readonly<Record<string, number>>;
  /** Which sync first observed it: the one before the re-base was detected, or the seed's own. */
  readonly observed: "BEFORE_REBASE" | "AT_SEED";
};

/** Weeks of seeded history: the same calendar as the price and fundamentals fixtures. */
export const QA_VALUATION_HISTORY_WEEKS = 160;

/**
 * Diluted shares on every quarter: one level, confirmed on quarter 2 (rule 2's third agreeing
 * quarter), so no later quarter is withheld for it.
 */
export const QA_VALUATION_SHARES = 1_000_000;

/** The week whose Monday the history was first verified on. */
export const QA_VALUATION_VERIFIED_WEEK = 100;

/** The week whose Monday the sync that first observed quarters 0-9 ran on. */
export const QA_VALUATION_EARLY_SYNC_WEEK = 124;

/** The measured re-base: effective on this week's Monday, detected the next day. */
export const QA_VALUATION_REBASE = { week: 130, priceRatio: 1.05 } as const;

/** Every quarter's statements, oldest first. */
export const QA_VALUATION_QUARTERS: readonly QaValuationQuarter[] = Array.from(
  { length: 12 },
  (_, index) => ({
    index,
    income: {
      weightedAverageShsOutDil: QA_VALUATION_SHARES,
      revenue: 10_000_000,
      ebitda: 4_000_000,
      netIncome: index >= 9 ? 5_000_000 : 2_500_000,
    },
    balanceSheet: {
      totalStockholdersEquity: 50_000_000,
      netDebt: index === 8 || index === 9 ? -300_000_000 : 20_000_000,
    },
    cashFlow: { operatingCashFlow: 1_000_000, capitalExpenditure: -3_000_000 },
    observed: index <= 9 ? "BEFORE_REBASE" : "AT_SEED",
  }),
);

/** The week from whose Monday a quarter is public. */
export function qaValuationPublicWeek(index: number): number {
  return 13 * index + 6;
}

/**
 * Where each ratio is available, in seeded weeks: from `fromWeek` on, except the weeks the measured
 * re-base withholds. `null` is a ratio unavailable on every session.
 */
export const QA_VALUATION_AVAILABILITY = {
  PRICE_TO_EARNINGS_TTM: { fromWeek: 45 },
  PRICE_TO_SALES_TTM: { fromWeek: 45 },
  PRICE_TO_BOOK: { fromWeek: 32 },
  PRICE_TO_FCF_TTM: null,
  EV_TO_EBITDA_TTM: { fromWeek: 45 },
} as const satisfies Readonly<Record<string, { fromWeek: number } | null>>;

export type QaValuationRatioId = keyof typeof QA_VALUATION_AVAILABILITY;

/** The weeks the measured re-base leaves unavailable for every ratio: `[fromWeek, untilWeek)`. */
export const QA_VALUATION_WITHHELD = { fromWeek: 130, untilWeek: 149 } as const;

/** The weeks EV/EBITDA reads negative — net cash larger than the market capitalisation. */
export const QA_VALUATION_NET_CASH = { fromWeek: 110, untilWeek: 130 } as const;

/** Whether a ratio has a reading in a seeded week. */
export function qaValuationAvailable(
  ratioId: QaValuationRatioId,
  week: number,
): boolean {
  const availability = QA_VALUATION_AVAILABILITY[ratioId];
  return (
    availability !== null &&
    week >= availability.fromWeek &&
    !(
      week >= QA_VALUATION_WITHHELD.fromWeek &&
      week < QA_VALUATION_WITHHELD.untilWeek
    )
  );
}

/** `YYYY-MM-DD` plus whole days, in UTC. */
function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** The Monday of a seeded week, given the seed's first Monday. */
export function qaValuationWeekMonday(
  firstMonday: string,
  week: number,
): string {
  return addDays(firstMonday, week * 7);
}

/** The Sunday a quarter's fiscal period ends on. */
export function qaValuationQuarterEnd(
  firstMonday: string,
  index: number,
): string {
  return addDays(qaValuationWeekMonday(firstMonday, 13 * index), -1);
}

/** The Sunday a quarter is filed on: public from the next day. */
export function qaValuationFilingDate(
  firstMonday: string,
  index: number,
): string {
  return addDays(
    qaValuationWeekMonday(firstMonday, qaValuationPublicWeek(index)),
    -1,
  );
}
