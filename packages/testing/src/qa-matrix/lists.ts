import type { BuyWindowMode } from "@intrinsic/contracts";
import { normalizeBuyWindowConfiguration } from "@intrinsic/domain";
import type { ExecutionCalendar } from "@intrinsic/strategy";
import {
  qaMatrixBoundaryDates,
  type QaMatrixBoundaryDates,
  type QaMatrixPeriods,
} from "./clock.js";
import { QA_MATRIX_SECURITIES, type QaMatrixSymbol } from "./securities.js";
import { QA_MATRIX_NAME_PREFIX } from "./strategies.js";

/**
 * The ten persistent QA-MATRIX Stock List fixtures.
 *
 * They vary the two things a list decides for a backtest: **which securities exist in the
 * universe**, and **when each of them may be bought**. Between them they cover a single-security
 * universe, small, medium and a thirty-name list sized for the current V1 intent, securities that
 * listed decades before the horizon opens and securities that listed inside it, all-FULL,
 * all-CUSTOM and mixed membership, per-security divergent windows, multi-range and open-ended
 * windows, windows that open after a run starts and close before it ends, one-day windows, and
 * both overlapping and mutually exclusive eligibility.
 *
 * Ranges are written the way a user would submit them; `normalizeBuyWindowConfiguration` in
 * `@intrinsic/domain` is what turns them into the canonical persisted set, and the fixture suite
 * requires each fixture to already be in canonical form so a seeded row can be compared with the
 * definition literally.
 */

export type QaMatrixBuyWindowRange = {
  readonly startDate: string;
  /** `null` means open-ended, exactly as the product persists it. */
  readonly endDate: string | null;
};

export type QaMatrixListMember = {
  readonly symbol: QaMatrixSymbol;
  readonly mode: BuyWindowMode;
  /** Always empty for `FULL`; at least one range for `CUSTOM`. */
  readonly ranges: readonly QaMatrixBuyWindowRange[];
};

/** What a list fixture is intended to exercise; asserted for completeness by the fixture suite. */
export const QA_MATRIX_LIST_BEHAVIOURS = [
  "SINGLE_SECURITY",
  "SMALL_UNIVERSE",
  "MEDIUM_UNIVERSE",
  "LARGE_UNIVERSE",
  "FULL_HORIZON_SECURITIES",
  "LATER_LISTING_SECURITIES",
  "MIXED_LISTING_ERAS",
  "ALL_FULL_WINDOWS",
  "ALL_CUSTOM_WINDOWS",
  "MIXED_WINDOW_MODES",
  "DIVERGENT_WINDOWS_PER_SECURITY",
  "MULTI_RANGE_WINDOW",
  "OPEN_ENDED_WINDOW",
  "WINDOW_OPENS_AFTER_RUN_START",
  "WINDOW_CLOSES_BEFORE_RUN_END",
  "NARROW_WINDOW",
  "OVERLAPPING_ELIGIBILITY",
  "DISJOINT_ELIGIBILITY",
  // The trading-session boundary cases, all cut against the canonical US-equity calendar.
  "OPENS_ON_FIRST_SIMULATED_SESSION",
  "CLOSES_ON_LAST_SIMULATED_SESSION",
  "OPENS_ONE_SESSION_AFTER_RUN_START",
  "CLOSES_ONE_SESSION_BEFORE_A_LATER_SESSION",
  "SINGLE_SESSION_WINDOW",
  "STRADDLES_YEAR_BOUNDARY",
] as const;

export type QaMatrixListBehaviour = (typeof QA_MATRIX_LIST_BEHAVIOURS)[number];

export type QaMatrixListFixture = {
  /** `L01` … `L10`; the middle third of a `QA-MATRIX-Sxx-Lxx-Cxx` run identity. */
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly behaviours: readonly QaMatrixListBehaviour[];
  readonly members: readonly QaMatrixListMember[];
};

const full = (symbol: QaMatrixSymbol): QaMatrixListMember => ({
  symbol,
  mode: "FULL",
  ranges: [],
});

/**
 * A CUSTOM membership, canonicalized by the product's own normalizer.
 *
 * Not tidiness: the persisted form is always the canonical set, so a fixture that stated something
 * else would describe a list the database can never hold. It matters most for the year-boundary
 * case — whether its two execution dates stay two ranges or merge into one is decided by whether
 * they are calendar-adjacent, which is a property of the calendar in use, not of the fixture. Two
 * consecutive sessions across a normal 1 January are not adjacent; in a calendar that happens to
 * carry a bar on 1 January they are, and one merged range covering exactly those dates is then the
 * correct expression of the same intent.
 */
const custom = (
  symbol: QaMatrixSymbol,
  ...ranges: readonly QaMatrixBuyWindowRange[]
): QaMatrixListMember => ({
  symbol,
  mode: "CUSTOM",
  ranges: normalizeBuyWindowConfiguration({
    mode: "CUSTOM",
    ranges,
  }).ranges.map((range) => ({
    startDate: range.startDate,
    endDate: range.endDate,
  })),
});

const between = (
  startDate: string,
  endDate: string | null,
): QaMatrixBuyWindowRange => ({
  startDate,
  endDate,
});

/** The thirty-name universe of L08: every full-horizon security plus five later listings. */
const LARGE_UNIVERSE_SYMBOLS: readonly QaMatrixSymbol[] = [
  ...QA_MATRIX_SECURITIES.filter((s) => s.coverage === "FULL_HORIZON").map(
    (s) => s.symbol,
  ),
  "AMZN",
  "NVDA",
  "GS",
  "CRM",
  "GOOGL",
];

type ListFixtureSpec = Omit<QaMatrixListFixture, "name"> & {
  readonly slug: string;
};

const LIST_SPECS: readonly ListFixtureSpec[] = [
  {
    id: "L01",
    slug: "single-security-full",
    description:
      "One security, unrestricted. The degenerate universe: with maximumPositions above one, a " +
      "strategy can never fill more than a single slot, so every configuration's cash and " +
      "position-slot arithmetic is exercised against exactly one candidate.",
    behaviours: [
      "SINGLE_SECURITY",
      "FULL_HORIZON_SECURITIES",
      "ALL_FULL_WINDOWS",
    ],
    members: [full("AAPL")],
  },
  {
    id: "L02",
    slug: "small-old-full",
    description:
      "Three securities that all listed decades before the thirty-year horizon opens, all FULL. " +
      "The clean baseline: every security is present and eligible on the run's first simulated " +
      "day, so a difference between two runs comes from the strategy or the configuration, never " +
      "from data availability.",
    behaviours: [
      "SMALL_UNIVERSE",
      "FULL_HORIZON_SECURITIES",
      "ALL_FULL_WINDOWS",
    ],
    members: [full("KO"), full("JNJ"), full("XOM")],
  },
  {
    id: "L03",
    slug: "small-custom-uniform",
    description:
      "Three securities sharing one identical CUSTOM decade, 2010-2019. Eligibility opens well " +
      "after a 30-year or 10-year run starts and closes well before it ends, and closes entirely " +
      "before the 3-year and 1-year periods even begin — so those two configurations must produce " +
      "a run that buys nothing at all while still simulating every date.",
    behaviours: [
      "SMALL_UNIVERSE",
      "FULL_HORIZON_SECURITIES",
      "ALL_CUSTOM_WINDOWS",
      "WINDOW_OPENS_AFTER_RUN_START",
      "WINDOW_CLOSES_BEFORE_RUN_END",
    ],
    members: [
      custom("MSFT", between("2010-01-01", "2019-12-31")),
      custom("IBM", between("2010-01-01", "2019-12-31")),
      custom("MCD", between("2010-01-01", "2019-12-31")),
    ],
  },
  {
    id: "L04",
    slug: "small-custom-divergent",
    description:
      "Four securities, four different CUSTOM shapes: a window bounded on both sides, an " +
      "open-ended window, a two-range window with a seven-year gap between its ranges, and a " +
      "one-month window that only the 1-year configuration ever reaches. No two securities are " +
      "eligible under the same rule, which is what makes a per-item window a per-item decision " +
      "rather than a list-level one.",
    behaviours: [
      "SMALL_UNIVERSE",
      "FULL_HORIZON_SECURITIES",
      "ALL_CUSTOM_WINDOWS",
      "DIVERGENT_WINDOWS_PER_SECURITY",
      "MULTI_RANGE_WINDOW",
      "OPEN_ENDED_WINDOW",
      "NARROW_WINDOW",
      "WINDOW_OPENS_AFTER_RUN_START",
      "WINDOW_CLOSES_BEFORE_RUN_END",
    ],
    members: [
      custom("PG", between("1996-01-01", "2005-12-31")),
      custom("WMT", between("2015-06-01", null)),
      custom(
        "MMM",
        between("2000-01-01", "2004-12-31"),
        between("2012-01-01", "2016-12-31"),
      ),
      custom("CAT", between("2025-03-03", "2025-03-31")),
    ],
  },
  {
    id: "L05",
    slug: "mixed-modes-medium",
    description:
      "Eight securities: four unrestricted and four whose CUSTOM windows tile the horizon into " +
      "consecutive, non-overlapping eras. FULL and CUSTOM membership therefore coexist in one " +
      "list, and which restricted security is buyable changes with the decade the configuration " +
      "covers while the unrestricted four stay available throughout.",
    behaviours: [
      "MEDIUM_UNIVERSE",
      "FULL_HORIZON_SECURITIES",
      "MIXED_WINDOW_MODES",
      "DIVERGENT_WINDOWS_PER_SECURITY",
      "OPEN_ENDED_WINDOW",
      "DISJOINT_ELIGIBILITY",
      "WINDOW_OPENS_AFTER_RUN_START",
      "WINDOW_CLOSES_BEFORE_RUN_END",
    ],
    members: [
      full("AAPL"),
      full("KO"),
      full("JNJ"),
      full("MSFT"),
      custom("MRK", between("1996-01-01", "1999-12-31")),
      custom("XOM", between("2000-01-01", "2009-12-31")),
      custom("CVX", between("2010-01-01", "2019-12-31")),
      custom("HD", between("2020-01-01", null)),
    ],
  },
  {
    id: "L06",
    slug: "later-ipos-full",
    description:
      "Eight securities that all listed inside the thirty-year horizon, from 1997 to 2018, all " +
      "FULL. A 30-year run starts before any of them exists: every predicate is NOT_EVALUABLE " +
      "until each security's own first close, so the portfolio holds nothing but cash for years " +
      "and the universe fills in one listing at a time. The 1-year configuration sees all eight " +
      "from its first day.",
    behaviours: [
      "MEDIUM_UNIVERSE",
      "LATER_LISTING_SECURITIES",
      "ALL_FULL_WINDOWS",
    ],
    members: [
      full("AMZN"),
      full("NVDA"),
      full("GS"),
      full("HON"),
      full("CRM"),
      full("GOOGL"),
      full("V"),
      full("MRNA"),
    ],
  },
  {
    id: "L07",
    slug: "mixed-eras-full",
    description:
      "Five unrestricted securities spanning three listing eras: two present from the first " +
      "simulated day, two that list mid-horizon, and one that lists in 2018. The universe a " +
      "strategy can choose from grows during the run without any buy window saying so, which is " +
      "the difference between data availability and configured eligibility.",
    behaviours: [
      "MEDIUM_UNIVERSE",
      "MIXED_LISTING_ERAS",
      "FULL_HORIZON_SECURITIES",
      "LATER_LISTING_SECURITIES",
      "ALL_FULL_WINDOWS",
    ],
    members: [full("KO"), full("JNJ"), full("GOOGL"), full("V"), full("MRNA")],
  },
  {
    id: "L08",
    slug: "large-thirty-full",
    description:
      "Thirty securities, all FULL — the size a V1 user actually runs, and comfortably inside the " +
      "200-security submission cap. Twenty-five listed before the horizon and five inside it, so " +
      "it is the fixture where position-slot contention, candidate ordering and cash pressure are " +
      "all real: under maximumPositions = 1 thirty candidates compete for one slot.",
    behaviours: [
      "LARGE_UNIVERSE",
      "MIXED_LISTING_ERAS",
      "FULL_HORIZON_SECURITIES",
      "LATER_LISTING_SECURITIES",
      "ALL_FULL_WINDOWS",
    ],
    members: LARGE_UNIVERSE_SYMBOLS.map(full),
  },
  {
    id: "L09",
    slug: "overlapping-windows",
    description:
      "Six securities whose CUSTOM windows deliberately overlap in two clusters — 2016-2020 and " +
      "2022 onwards — with a one-month window nested inside the first and **no security eligible " +
      "at all during 2021**. It is the fixture for eligibility that is simultaneous, nested, " +
      "disjoint and, for one full calendar year, empty.",
    behaviours: [
      "MEDIUM_UNIVERSE",
      "MIXED_LISTING_ERAS",
      "ALL_CUSTOM_WINDOWS",
      "DIVERGENT_WINDOWS_PER_SECURITY",
      "OVERLAPPING_ELIGIBILITY",
      "DISJOINT_ELIGIBILITY",
      "OPEN_ENDED_WINDOW",
      "NARROW_WINDOW",
      "WINDOW_OPENS_AFTER_RUN_START",
      "WINDOW_CLOSES_BEFORE_RUN_END",
    ],
    members: [
      custom("AAPL", between("2016-01-01", "2020-12-31")),
      custom("MSFT", between("2016-06-01", "2020-12-31")),
      custom("GOOGL", between("2017-01-01", "2019-12-31")),
      custom("V", between("2018-01-01", "2018-01-31")),
      custom("NVDA", between("2022-01-01", "2024-12-31")),
      custom("AMZN", between("2022-07-01", null)),
    ],
  },
  {
    id: "L10",
    slug: "session-boundary-windows",
    description:
      "Six securities whose CUSTOM windows are cut from the authoritative execution-date set — the " +
      "pinned execution-calendar series' own bars, the same dates the engine simulates. Every " +
      "endpoint is therefore an execution date by construction, not by a calculation the matrix " +
      "performed: a boundary on a day the market was shut tests nothing, because the run has no " +
      "simulated date there and inclusion is indistinguishable from exclusion. Together they cover " +
      "a window opening on the first execution date, one closing on the last, one opening on the " +
      "next execution date after a run begins, one closing on the execution date immediately " +
      "before a later one, a single-execution-date window, and one straddling a calendar-year " +
      "boundary with a real execution date on each side.",
    behaviours: [
      "MEDIUM_UNIVERSE",
      "FULL_HORIZON_SECURITIES",
      "ALL_CUSTOM_WINDOWS",
      "DIVERGENT_WINDOWS_PER_SECURITY",
      "NARROW_WINDOW",
      "OPENS_ON_FIRST_SIMULATED_SESSION",
      "CLOSES_ON_LAST_SIMULATED_SESSION",
      "OPENS_ONE_SESSION_AFTER_RUN_START",
      "CLOSES_ONE_SESSION_BEFORE_A_LATER_SESSION",
      "SINGLE_SESSION_WINDOW",
      "STRADDLES_YEAR_BOUNDARY",
      "WINDOW_OPENS_AFTER_RUN_START",
      "WINDOW_CLOSES_BEFORE_RUN_END",
    ],
    members: [],
  },
];

/**
 * The six `L10` memberships, cut from the matrix clock's own trading sessions.
 *
 * Each entry names the case it exists for. The dates are never written down: they are derived from
 * {@link qaMatrixBoundaryDays}, so they stay real sessions whatever the clock is, and a test can
 * assert the intent against the same anchor the fixture was built from rather than re-deriving the
 * answer and agreeing with itself.
 */
/**
 * The six `L10` memberships, cut from the authoritative execution-date set.
 *
 * Each entry names the case it exists for. No date is written down and none is computed: every
 * endpoint is an index into the calendar the runs themselves execute on, so the QA matrix never has
 * an opinion about whether the market was open.
 */
function boundaryMembers(
  dates: QaMatrixBoundaryDates,
  calendar: ExecutionCalendar,
): QaMatrixListMember[] {
  const after = (from: string, sessions: number): string => {
    const date = calendar.advance(from, sessions);
    if (!date) {
      throw new Error(
        `The execution calendar ends fewer than ${sessions} sessions after ${from}`,
      );
    }
    return date;
  };
  const before = (from: string, sessions: number): string =>
    after(from, -sessions);

  return [
    // Opens on the very first execution date of the thirty-year run, and runs 20 sessions.
    custom(
      "JNJ",
      between(dates.firstExecutionDate, after(dates.firstExecutionDate, 19)),
    ),
    // Closes on the last execution date every run simulates, having opened 20 sessions earlier.
    custom(
      "KO",
      between(before(dates.lastExecutionDate, 19), dates.lastExecutionDate),
    ),
    // Opens on the **next** execution date after the ten-year run's first: it excludes that run's
    // opening date and nothing else, so a run that can buy on its first date and one that cannot
    // are separated by a single session.
    custom(
      "MSFT",
      between(dates.oneAfterTenYearOpen, after(dates.oneAfterTenYearOpen, 39)),
    ),
    // Closes on the execution date immediately before the one-year run opens: eligible right up to,
    // and never on, the first date the shortest configuration simulates.
    custom(
      "IBM",
      between(
        before(dates.oneBeforeOneYearOpen, 39),
        dates.oneBeforeOneYearOpen,
      ),
    ),
    // One single execution date, inside the one-year run so every configuration reaches it.
    custom(
      "XOM",
      between(
        dates.singleSessionInsideOneYear,
        dates.singleSessionInsideOneYear,
      ),
    ),
    // Two execution dates straddling a calendar-year boundary — the last of one year and the first
    // of the next — so both sides are dates the market actually traded. They stay two canonical
    // ranges because consecutive *sessions* are not consecutive *calendar days* across 1 January.
    custom(
      "CAT",
      between(dates.yearEndExecutionDate, dates.yearEndExecutionDate),
      between(dates.yearStartExecutionDate, dates.yearStartExecutionDate),
    ),
  ];
}

/** The ten stock-list fixtures for one matrix clock. */
export function qaMatrixLists(
  periods: QaMatrixPeriods,
  calendar: ExecutionCalendar,
): readonly QaMatrixListFixture[] {
  const boundary = boundaryMembers(
    qaMatrixBoundaryDates(periods, calendar),
    calendar,
  );
  return LIST_SPECS.map(({ slug, ...spec }) => ({
    ...spec,
    name: `${QA_MATRIX_NAME_PREFIX}${spec.id}-${slug}`,
    members: spec.id === "L10" ? boundary : spec.members,
  }));
}
