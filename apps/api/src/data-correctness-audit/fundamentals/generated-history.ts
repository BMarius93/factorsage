import type {
  FinancialPeriod,
  FinancialStatement,
  FinancialStatementType,
} from "@intrinsic/domain";

/**
 * Seeded, reproducible statement histories for the Fundamental Metrics audit.
 *
 * The audit compares the production materializer with an independent oracle on every trading day
 * of long synthetic histories. A history here is deliberately hostile rather than realistic: it
 * mixes the situations `docs/decisions/fundamental-metrics-v1.md` has a rule for — missing
 * quarters, families that lag or stop reporting, `FY` rows beside gaps, restatements that
 * invalidate and later restore a metric, moved period ends, rows delivered by one observation,
 * weekend and holiday availability, mixed and malformed currencies, zero and negative
 * denominators, exact cancellations and values beyond the storage range — at rates a profile
 * chooses. Nothing here knows a formula: it only writes statement revisions and a trading axis.
 *
 * Every random choice comes from one seeded generator, so a seed names a history exactly.
 */

export type GeneratedHistoryProfile = {
  /** Short stable name, used in reports. */
  readonly name: string;
  readonly seed: number;
  /** The trading-day axis, inclusive. */
  readonly firstTradingDay: string;
  readonly lastTradingDay: string;
  /** Fiscal years of statements before the axis starts, like the loader's warm-up retention. */
  readonly warmupYears: number;
  /** Calendar month (1-12) in which a fiscal year's fourth quarter ends. */
  readonly fiscalYearEndMonth: number;
  /**
   * Fiscal-year label minus the calendar year its fourth quarter ends in: a January year-end
   * retailer that calls the year ending in January 2025 "fiscal 2024" has -1.
   */
  readonly fiscalLabelOffset: -1 | 0 | 1;
  /** `NEAREST_SATURDAY` is the 52/53-week convention: period ends move and cross month ends. */
  readonly periodEndStyle: "MONTH_END" | "NEAREST_SATURDAY";
  readonly currency: string;
  readonly rates: GeneratedHistoryRates;
};

export type GeneratedHistoryRates = {
  /** A family omits one quarter. */
  readonly missingQuarter: number;
  /** A family stops reporting for one to six quarters. */
  readonly familyPause: number;
  /** A required line item is absent from a statement. */
  readonly missingField: number;
  /** A signed line (income, cash flow, net debt) is negative. */
  readonly negative: number;
  /** A denominator-bearing line is exactly zero or negative. */
  readonly badDenominator: number;
  /** A quarter receives a later revision. */
  readonly restatement: number;
  /** A revision moves the quarter's period end. */
  readonly movedPeriodEnd: number;
  /** A second row for the quarter arrives in the same observation, with another period end. */
  readonly sameObservation: number;
  /** A statement carries another, blank or differently spelled currency. */
  readonly currencyAnomaly: number;
  /** Availability falls on a weekend or holiday rather than a session. */
  readonly nonSessionAvailability: number;
  /** A value far outside the storage range, or a denominator close to zero. */
  readonly extreme: number;
  /** A diluted-EPS year that nets to exactly zero, or two revenue years that are exactly equal. */
  readonly exactCancel: number;
  /** An `FY` row is present for the fiscal year. */
  readonly fyRow: number;
};

export type GeneratedHistory = {
  readonly profile: GeneratedHistoryProfile;
  readonly securityId: string;
  readonly tradingDays: readonly string[];
  readonly holidays: readonly string[];
  /** Every revision of this security, in a shuffled order. */
  readonly statements: readonly FinancialStatement[];
  /** Revisions of an unrelated security, for proving they are ignored. */
  readonly foreignStatements: readonly FinancialStatement[];
};

/** mulberry32: small, fast and fully determined by its 32-bit seed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const DAY_MS = 86_400_000;

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function weekday(date: string): number {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

function lastDayOfMonth(year: number, month: number): string {
  // Day 0 of the following month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

/** The Saturday nearest to a date, which may fall in the following month or year. */
function nearestSaturday(date: string): string {
  const offset = (6 - weekday(date) + 7) % 7; // days forward to Saturday
  return offset <= 3 ? addDays(date, offset) : addDays(date, offset - 7);
}

/** Weekdays of the range, minus a seeded set of holidays: the axis a price history would give. */
function tradingAxis(
  from: string,
  to: string,
  random: () => number,
): { days: string[]; holidays: string[] } {
  const holidays = new Set<string>();
  const firstYear = Number(from.slice(0, 4));
  const lastYear = Number(to.slice(0, 4));
  for (let year = firstYear; year <= lastYear; year += 1) {
    for (const fixed of [`${year}-01-01`, `${year}-07-04`, `${year}-12-25`]) {
      if (weekday(fixed) !== 0 && weekday(fixed) !== 6) {
        holidays.add(fixed);
      }
    }
    // A few more closures a year, anywhere: the audit must not depend on which days they are.
    for (let extra = 0; extra < 4; extra += 1) {
      const day = addDays(`${year}-01-01`, Math.floor(random() * 365));
      if (weekday(day) !== 0 && weekday(day) !== 6) {
        holidays.add(day);
      }
    }
  }
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    if (weekday(day) !== 0 && weekday(day) !== 6 && !holidays.has(day)) {
      days.push(day);
    }
  }
  return {
    days,
    holidays: [...holidays].filter((day) => day >= from && day <= to).sort(),
  };
}

type Values = Record<string, number>;

const PERIODS = ["Q1", "Q2", "Q3", "Q4"] as const;

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Generates one history. The fiscal calendar, the company's quarterly figures and every hostile
 * situation are drawn from `profile.seed`; the same profile always yields the same statements.
 */
export function generateHistory(
  profile: GeneratedHistoryProfile,
): GeneratedHistory {
  const random = seededRandom(profile.seed);
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(random() * items.length)] as T;
  const chance = (probability: number): boolean => random() < probability;
  const between = (low: number, high: number): number =>
    low + random() * (high - low);

  const securityId = `audit-${profile.name}`;
  const axis = tradingAxis(
    profile.firstTradingDay,
    profile.lastTradingDay,
    random,
  );
  const holidaySet = new Set(axis.holidays);
  const isSession = (date: string): boolean =>
    weekday(date) !== 0 && weekday(date) !== 6 && !holidaySet.has(date);

  /** The period end of fiscal quarter `period` of fiscal year `fiscalYear`. */
  const periodEnd = (fiscalYear: number, quarter: number): string => {
    // Quarter 4 ends in `fiscalYearEndMonth` of the calendar year the label offset names.
    const q4Year = fiscalYear - profile.fiscalLabelOffset;
    const monthIndex =
      q4Year * 12 + (profile.fiscalYearEndMonth - 1) - 3 * (4 - quarter);
    const year = Math.floor(monthIndex / 12);
    const month = (monthIndex % 12) + 1;
    const monthEnd = lastDayOfMonth(year, month);
    return profile.periodEndStyle === "MONTH_END"
      ? monthEnd
      : nearestSaturday(monthEnd);
  };

  const firstAxisYear = Number(profile.firstTradingDay.slice(0, 4));
  const lastAxisYear = Number(profile.lastTradingDay.slice(0, 4));
  const firstFiscalYear = firstAxisYear - profile.warmupYears;
  const lastFiscalYear = lastAxisYear + 1;

  const statements: FinancialStatement[] = [];
  let hashSequence = 0;
  const nextHash = (): string => {
    hashSequence += 1;
    // Hex-like and unique; order carries no meaning beyond the tie-break the ADR gives it.
    return `${Math.floor(random() * 0xffffffff)
      .toString(16)
      .padStart(8, "0")}${hashSequence.toString(16).padStart(6, "0")}`;
  };
  const instant = (date: string, hour: number): string =>
    `${date}T${String(hour).padStart(2, "0")}:00:00.000Z`;

  /** A currency for one statement: usually the profile's, sometimes deliberately not. */
  const currencyFor = (): string =>
    chance(profile.rates.currencyAnomaly)
      ? pick([
          profile.currency === "USD" ? "JPY" : "USD",
          profile.currency.toLowerCase(),
          "",
          "   ",
          "EUR",
        ])
      : profile.currency;

  /** When a statement filed on `filed` becomes usable, sometimes pushed onto a non-session day. */
  const availabilityAfter = (filed: string): string => {
    let available = addDays(filed, 1);
    if (chance(profile.rates.nonSessionAvailability)) {
      // Walk forward to the next non-session day (a weekend or a holiday).
      while (isSession(available)) {
        available = addDays(available, 1);
      }
    }
    return available;
  };

  // The company: slow growth with seasonality and noise, occasionally in distress.
  let revenueLevel = between(2e6, 4e10);
  const shares = Math.round(between(2e7, 6e9));
  let debtLevel = between(0, 2.5) * revenueLevel;
  let equityLevel = between(0.3, 4) * revenueLevel;
  let assetsLevel = equityLevel + debtLevel + between(0.2, 2) * revenueLevel;
  const seasonal = [
    between(0.85, 1.15),
    between(0.85, 1.15),
    between(0.85, 1.15),
    between(0.85, 1.15),
  ];

  // A family pause: fiscal-quarter ranks during which one family reports nothing.
  const pausedUntil: Record<FinancialStatementType, number> = {
    INCOME: -Infinity,
    BALANCE_SHEET: -Infinity,
    CASH_FLOW: -Infinity,
  };

  for (
    let fiscalYear = firstFiscalYear;
    fiscalYear <= lastFiscalYear;
    fiscalYear += 1
  ) {
    const yearQuarters: {
      period: FinancialPeriod;
      values: Record<FinancialStatementType, Values>;
      filed: string;
    }[] = [];
    const cancelEps = chance(profile.rates.exactCancel);
    for (let quarter = 1; quarter <= 4; quarter += 1) {
      const period = PERIODS[quarter - 1] as FinancialPeriod;
      const rank = fiscalYear * 4 + quarter - 1;
      const fiscalDate = periodEnd(fiscalYear, quarter);

      revenueLevel = Math.max(revenueLevel * (1 + between(-0.06, 0.08)), 1_000);
      debtLevel = Math.max(debtLevel * (1 + between(-0.1, 0.1)), 0);
      equityLevel = equityLevel * (1 + between(-0.08, 0.1));
      assetsLevel = Math.max(assetsLevel * (1 + between(-0.05, 0.08)), 1);

      const revenue = Math.round(
        revenueLevel * (seasonal[quarter - 1] as number),
      );
      const grossMargin = chance(profile.rates.negative)
        ? between(-0.2, 0.1)
        : between(0.15, 0.75);
      // Profitable unless the profile's loss rate says otherwise, so growth chains (which need two
      // positive trailing years) are decidable often enough to be compared.
      const operatingMargin = chance(profile.rates.negative)
        ? between(-0.4, 0)
        : between(0.03, 0.35);
      const grossProfit = Math.round(revenue * grossMargin);
      const operatingIncome = Math.round(revenue * operatingMargin);
      const depreciation = Math.round(revenue * between(0.01, 0.08));
      const netIncome = Math.round(
        operatingIncome * between(0.5, 0.95) +
          (chance(profile.rates.negative) ? -revenue * between(0, 0.3) : 0),
      );
      const epsDiluted = cancelEps
        ? ([0.1, 0.2, -0.3, 0] as const)[quarter - 1]!
        : round(netIncome / shares, 2);
      const interestExpense = chance(profile.rates.badDenominator)
        ? pick([0, 0, -Math.round(debtLevel * 0.01)])
        : Math.round(debtLevel * between(0.002, 0.02));
      const income: Values = {
        revenue: chance(profile.rates.badDenominator)
          ? pick([0, -Math.round(revenue * 0.01)])
          : revenue,
        costOfRevenue: revenue - grossProfit,
        grossProfit,
        operatingIncome,
        netIncome,
        epsDiluted,
        eps: epsDiluted,
        ebitda: operatingIncome + depreciation,
        ebit: Math.round(operatingIncome * between(0.95, 1.05)),
        interestExpense,
        depreciationAndAmortization: depreciation,
        weightedAverageShsOutDil: shares,
      };

      const cash = Math.round(between(0.02, 0.6) * revenueLevel);
      const totalDebt = Math.round(debtLevel);
      const equity = chance(profile.rates.badDenominator)
        ? pick([0, -Math.round(equityLevel * 0.2)])
        : Math.round(equityLevel);
      const currentLiabilities = chance(profile.rates.badDenominator)
        ? pick([0, 0])
        : Math.round(between(0.1, 0.6) * assetsLevel);
      const balance: Values = {
        cashAndCashEquivalents: Math.round(cash * between(0.5, 1)),
        cashAndShortTermInvestments: cash,
        totalCurrentAssets: Math.round(between(0.1, 0.7) * assetsLevel),
        totalAssets: Math.round(assetsLevel),
        totalCurrentLiabilities: currentLiabilities,
        totalDebt,
        totalStockholdersEquity: equity,
        totalEquity:
          equity + Math.round(between(0, 0.1) * Math.abs(equityLevel)),
        netDebt: chance(profile.rates.negative)
          ? -Math.round(cash * between(0.5, 2))
          : totalDebt - cash,
      };
      if (chance(0.15)) {
        // The primary cash field is absent; the fallback must be used, never another row.
        delete balance.cashAndShortTermInvestments;
      }

      const operatingCashFlow = Math.round(
        netIncome + depreciation + revenue * between(-0.03, 0.06),
      );
      const capitalExpenditure = -Math.round(revenue * between(0.01, 0.08));
      const cashFlow: Values = {
        operatingCashFlow,
        capitalExpenditure: chance(0.02)
          ? Math.abs(capitalExpenditure)
          : capitalExpenditure,
        // Deliberately inconsistent: the provider's own figure is never a calculation input.
        freeCashFlow:
          operatingCashFlow +
          capitalExpenditure +
          Math.round(revenue * between(-0.2, 0.2)),
        netIncome,
        depreciationAndAmortization: depreciation,
      };

      if (chance(profile.rates.extreme)) {
        // One pathological line, chosen so a few metrics leave the storage range while every
        // metric that does not read the line stays exactly as it was.
        switch (Math.floor(random() * 6)) {
          case 0:
            // Current Ratio of the latest balance sheet: 5e9 / 1e-4 = 5e13.
            balance.totalCurrentLiabilities = 0.0001;
            balance.totalCurrentAssets = 5e9;
            break;
          case 1:
            // Operating Margin and ROIC over the four windows holding this quarter.
            income.operatingIncome = 5e21;
            break;
          case 2:
            // Interest Coverage over the four windows holding this quarter.
            income.ebit = 9e22;
            break;
          case 3:
            // Debt / Equity of the latest balance sheet: 7e9 / 2e-4 = 3.5e13.
            balance.totalStockholdersEquity = 0.0002;
            balance.totalDebt = 7e9;
            break;
          case 4:
            // Net Debt / EBITDA while this is the latest balance sheet.
            balance.netDebt = 8e22;
            break;
          default:
            // Revenue Growth and Asset Turnover leave the range; the margins shrink but remain.
            income.revenue = 3e21;
        }
      }

      const families: Record<FinancialStatementType, Values> = {
        INCOME: income,
        BALANCE_SHEET: balance,
        CASH_FLOW: cashFlow,
      };
      for (const family of Object.keys(families) as FinancialStatementType[]) {
        const values = families[family];
        for (const field of Object.keys(values)) {
          if (chance(profile.rates.missingField / 4)) {
            delete values[field];
          }
        }
      }

      const filed = addDays(
        fiscalDate,
        Math.round(quarter === 4 ? between(35, 95) : between(20, 70)),
      );
      yearQuarters.push({ period, values: families, filed });

      for (const family of ["INCOME", "BALANCE_SHEET", "CASH_FLOW"] as const) {
        if (rank <= pausedUntil[family]) {
          continue;
        }
        if (chance(profile.rates.familyPause / 3)) {
          pausedUntil[family] = rank + Math.floor(between(1, 7));
          continue;
        }
        if (chance(profile.rates.missingQuarter / 3)) {
          continue;
        }
        // Families of one quarter are usually filed together; sometimes one arrives later.
        const familyFiled = chance(0.1)
          ? addDays(filed, Math.round(between(1, 120)))
          : filed;
        const available = availabilityAfter(familyFiled);
        const observedAt = instant(
          addDays(available, Math.round(between(0, 4))),
          12,
        );
        const original: FinancialStatement = {
          securityId,
          statementType: family,
          fiscalDate,
          fiscalYear,
          period,
          reportedCurrency: currencyFor(),
          filingDate: familyFiled,
          availableFromDate: available,
          observedAt,
          contentHash: nextHash(),
          values: { ...families[family] },
        };
        statements.push(original);

        if (chance(profile.rates.sameObservation)) {
          // Two period ends for one quarter, delivered together: the later period end represents it.
          statements.push({
            ...original,
            fiscalDate: addDays(fiscalDate, pick([-4, -2, 2, 5])),
            contentHash: nextHash(),
            values: perturb(original.values, random),
          });
        }

        let previous = original;
        while (chance(profile.rates.restatement)) {
          const later = addDays(
            previous.availableFromDate,
            Math.round(between(1, 700)),
          );
          const moved = chance(profile.rates.movedPeriodEnd);
          const revision: FinancialStatement = {
            ...previous,
            fiscalDate: moved
              ? addDays(fiscalDate, pick([-6, -3, -1, 1, 3, 6]))
              : previous.fiscalDate,
            reportedCurrency: chance(0.25)
              ? currencyFor()
              : previous.reportedCurrency,
            filingDate: later,
            availableFromDate: chance(profile.rates.nonSessionAvailability)
              ? availabilityAfter(addDays(later, -1))
              : later,
            observedAt: instant(later, Math.floor(between(0, 23))),
            contentHash: nextHash(),
            values: chance(0.2)
              ? { ...previous.values }
              : perturb(previous.values, random),
          };
          if (chance(0.15)) {
            // An invalidation: a required line disappears (a later revision may restore it).
            const fields = Object.keys(revision.values);
            if (fields.length > 0) {
              const next = { ...(revision.values as Values) };
              delete next[pick(fields)];
              (revision as { values: Values }).values = next;
            }
          }
          statements.push(revision);
          previous = revision;
        }
      }
    }

    if (chance(profile.rates.fyRow)) {
      // Annual rows, sometimes public before the fourth quarter: never a quarter, never a gap filler.
      const q4 = yearQuarters[3];
      const fyFiled = q4
        ? addDays(q4.filed, -Math.round(between(0, 30)))
        : `${fiscalYear}-06-30`;
      for (const family of ["INCOME", "BALANCE_SHEET", "CASH_FLOW"] as const) {
        const summed: Values = {};
        for (const quarter of yearQuarters) {
          for (const [field, value] of Object.entries(quarter.values[family])) {
            summed[field] = (summed[field] ?? 0) + value * between(0.9, 1.1);
          }
        }
        const available = availabilityAfter(fyFiled);
        statements.push({
          securityId,
          statementType: family,
          fiscalDate: periodEnd(fiscalYear, 4),
          fiscalYear,
          period: "FY",
          reportedCurrency: profile.currency,
          filingDate: fyFiled,
          availableFromDate: available,
          observedAt: instant(available, 9),
          contentHash: nextHash(),
          values: Object.fromEntries(
            Object.entries(summed).map(([field, value]) => [
              field,
              Math.round(value),
            ]),
          ),
        });
      }
    }
  }

  // Runs of identical quarterly revenue: wherever eight consecutive quarters share it, the two
  // trailing years are exactly equal and growth is exactly zero — a real reading, not absence.
  if (chance(profile.rates.exactCancel)) {
    const incomes = statements.filter(
      (statement) =>
        statement.statementType === "INCOME" && statement.period !== "FY",
    );
    for (const statement of incomes) {
      if (chance(0.6)) {
        (statement as { values: Values }).values = {
          ...(statement.values as Values),
          revenue: 1_000_000,
        };
      }
    }
  }

  const foreignStatements = statements
    .filter((_statement, index) => index % 7 === 0)
    .map((statement) => ({
      ...statement,
      securityId: `${securityId}-foreign`,
      contentHash: nextHash(),
      values: perturb(statement.values, random),
    }));

  return {
    profile,
    securityId,
    tradingDays: axis.days,
    holidays: axis.holidays,
    statements: shuffle(statements, random),
    foreignStatements,
  };
}

/** A restated copy: every line moved a little, a sign occasionally flipped. */
function perturb(
  values: FinancialStatement["values"],
  random: () => number,
): Values {
  const next: Values = {};
  for (const [field, value] of Object.entries(values as Values)) {
    const factor = 0.9 + random() * 0.2;
    const flipped = random() < 0.05 ? -1 : 1;
    next[field] = Number.isInteger(value)
      ? Math.round(value * factor) * flipped
      : round(value * factor, 4) * flipped;
  }
  return next;
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other] as T, copy[index] as T];
  }
  return copy;
}

/** The profiles the audit runs: different year ends, calendars, currencies and hostility. */
export const AUDIT_HISTORY_PROFILES: readonly GeneratedHistoryProfile[] = [
  {
    name: "calendar-usd-clean",
    seed: 20_260_929,
    firstTradingDay: "1992-01-02",
    lastTradingDay: "2026-09-25",
    warmupYears: 7,
    fiscalYearEndMonth: 12,
    fiscalLabelOffset: 0,
    periodEndStyle: "MONTH_END",
    currency: "USD",
    rates: {
      missingQuarter: 0.01,
      familyPause: 0.005,
      missingField: 0.005,
      negative: 0.08,
      badDenominator: 0.01,
      restatement: 0.08,
      movedPeriodEnd: 0.1,
      sameObservation: 0.01,
      currencyAnomaly: 0.005,
      nonSessionAvailability: 0.2,
      extreme: 0.005,
      exactCancel: 0.05,
      fyRow: 0.7,
    },
  },
  {
    name: "september-52-53-week",
    seed: 20_260_930,
    firstTradingDay: "1996-01-02",
    lastTradingDay: "2026-09-25",
    warmupYears: 7,
    fiscalYearEndMonth: 9,
    fiscalLabelOffset: 0,
    periodEndStyle: "NEAREST_SATURDAY",
    currency: "USD",
    rates: {
      missingQuarter: 0.03,
      familyPause: 0.01,
      missingField: 0.02,
      negative: 0.15,
      badDenominator: 0.03,
      restatement: 0.2,
      movedPeriodEnd: 0.3,
      sameObservation: 0.05,
      currencyAnomaly: 0.02,
      nonSessionAvailability: 0.35,
      extreme: 0.02,
      exactCancel: 0.1,
      fyRow: 0.9,
    },
  },
  {
    name: "january-retailer-jpy",
    seed: 20_260_931,
    firstTradingDay: "1994-01-03",
    lastTradingDay: "2026-09-25",
    warmupYears: 7,
    fiscalYearEndMonth: 1,
    fiscalLabelOffset: -1,
    periodEndStyle: "NEAREST_SATURDAY",
    currency: "JPY",
    rates: {
      missingQuarter: 0.04,
      familyPause: 0.02,
      missingField: 0.03,
      negative: 0.2,
      badDenominator: 0.05,
      restatement: 0.25,
      movedPeriodEnd: 0.25,
      sameObservation: 0.06,
      currencyAnomaly: 0.05,
      nonSessionAvailability: 0.3,
      extreme: 0.03,
      exactCancel: 0.1,
      fyRow: 0.5,
    },
  },
  {
    name: "june-dense-revisions",
    seed: 20_260_932,
    firstTradingDay: "1996-07-01",
    lastTradingDay: "2026-09-25",
    warmupYears: 7,
    fiscalYearEndMonth: 6,
    fiscalLabelOffset: 0,
    periodEndStyle: "MONTH_END",
    currency: "USD",
    rates: {
      missingQuarter: 0.02,
      familyPause: 0.01,
      missingField: 0.02,
      negative: 0.12,
      badDenominator: 0.02,
      restatement: 0.45,
      movedPeriodEnd: 0.2,
      sameObservation: 0.08,
      currencyAnomaly: 0.02,
      nonSessionAvailability: 0.25,
      extreme: 0.01,
      exactCancel: 0.08,
      fyRow: 0.8,
    },
  },
  {
    name: "march-label-ahead-distressed",
    seed: 20_260_933,
    firstTradingDay: "1992-01-02",
    lastTradingDay: "2026-09-25",
    warmupYears: 7,
    fiscalYearEndMonth: 3,
    fiscalLabelOffset: 1,
    periodEndStyle: "MONTH_END",
    currency: "EUR",
    rates: {
      missingQuarter: 0.05,
      familyPause: 0.03,
      missingField: 0.04,
      negative: 0.35,
      badDenominator: 0.08,
      restatement: 0.2,
      movedPeriodEnd: 0.15,
      sameObservation: 0.04,
      currencyAnomaly: 0.04,
      nonSessionAvailability: 0.25,
      extreme: 0.04,
      exactCancel: 0.15,
      fyRow: 0.6,
    },
  },
  {
    name: "calendar-hostile",
    seed: 20_260_934,
    firstTradingDay: "1996-01-02",
    lastTradingDay: "2026-09-25",
    warmupYears: 7,
    fiscalYearEndMonth: 12,
    fiscalLabelOffset: 0,
    periodEndStyle: "NEAREST_SATURDAY",
    currency: "USD",
    rates: {
      missingQuarter: 0.08,
      familyPause: 0.05,
      missingField: 0.06,
      negative: 0.3,
      badDenominator: 0.1,
      restatement: 0.35,
      movedPeriodEnd: 0.35,
      sameObservation: 0.1,
      currencyAnomaly: 0.08,
      nonSessionAvailability: 0.5,
      extreme: 0.06,
      exactCancel: 0.2,
      fyRow: 0.9,
    },
  },
  {
    name: "october-sparse",
    seed: 20_260_935,
    firstTradingDay: "1996-01-02",
    lastTradingDay: "2026-09-25",
    warmupYears: 3,
    fiscalYearEndMonth: 10,
    fiscalLabelOffset: 0,
    periodEndStyle: "MONTH_END",
    currency: "USD",
    rates: {
      missingQuarter: 0.12,
      familyPause: 0.08,
      missingField: 0.03,
      negative: 0.1,
      badDenominator: 0.03,
      restatement: 0.1,
      movedPeriodEnd: 0.1,
      sameObservation: 0.02,
      currencyAnomaly: 0.02,
      nonSessionAvailability: 0.2,
      extreme: 0.02,
      exactCancel: 0.05,
      fyRow: 0.95,
    },
  },
  {
    name: "calendar-currency-churn",
    seed: 20_260_936,
    firstTradingDay: "1992-01-02",
    lastTradingDay: "2026-09-25",
    warmupYears: 7,
    fiscalYearEndMonth: 12,
    fiscalLabelOffset: 0,
    periodEndStyle: "MONTH_END",
    currency: "USD",
    rates: {
      missingQuarter: 0.02,
      familyPause: 0.01,
      missingField: 0.01,
      negative: 0.1,
      badDenominator: 0.02,
      restatement: 0.3,
      movedPeriodEnd: 0.1,
      sameObservation: 0.03,
      currencyAnomaly: 0.12,
      nonSessionAvailability: 0.3,
      extreme: 0.02,
      exactCancel: 0.05,
      fyRow: 0.7,
    },
  },
];
