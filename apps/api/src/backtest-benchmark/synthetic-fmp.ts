import { createServer, type Server, type ServerResponse } from "node:http";
import { FMP_STOCK_SECTORS } from "@intrinsic/contracts";
import { SUPPORTED_EXCHANGE_CODES } from "@intrinsic/domain";
import {
  CASH_FLOW_FIELDS,
  BALANCE_SHEET_FIELDS,
  INCOME_STATEMENT_FIELDS,
} from "@intrinsic/domain";
import { FMP_EOD_MAX_ROWS_PER_RESPONSE } from "@intrinsic/fmp";
import { fixtureHolidays, nyseFullClosures } from "../e2e-stack/fake-fmp";

/**
 * A deterministic, synthetic stand-in for the FMP provider, for scale benchmarks only
 * (`docs/production/benchmarks.md`).
 *
 * The scale benchmark needs thousands of securities with thirty-plus years of daily bars and
 * fundamentals, and the real provider cannot be asked for that from a development environment: the
 * subscription's quota would not survive it, and the results would not be repeatable. So the
 * benchmark processes are launched with `FMP_BASE_URL` pointing here, exactly as the E2E stack points
 * at its fixture provider, and the whole production path still runs — `FmpClient`, the shared
 * request gate, the canonical loader's coverage bookkeeping, PostgreSQL persistence, the Redis
 * projection. Only the far end of the wire is replaced.
 *
 * **Never a measurement of FMP itself.** What this server answers in is not what FMP answers in;
 * `--latency-ms` adds a fixed delay per request so the provider's round trip can be modelled, and
 * every report the benchmark writes labels such a run "synthetic provider". Real provider timings
 * come only from the guarded live sample (`scripts/cloud/fmp-live.sh`).
 *
 * Every answer is a pure function of the symbol and the query, so two benchmark runs — or two
 * machines — see byte-identical data:
 *
 * - **symbols**: `SYN0001`…`SYN9999` (`syntheticSymbol`), plus the benchmark catalog's own provider
 *   symbols (`SPY`, `^GSPC`, …) and any other upper-case ticker, so ETF and index series bootstrap;
 * - **daily bars** (`historical-price-eod/full`): a seeded geometric random walk over the rule-based
 *   NYSE calendar from {@link SYNTHETIC_HISTORY_START}, honouring `from`/`to` and capped at
 *   {@link FMP_EOD_MAX_ROWS_PER_RESPONSE} rows newest first, which is what makes the client page;
 * - **statements** (the three statement endpoints, `period=quarter|annual`, `limit`): internally
 *   consistent quarterly and annual filings, each dated by a filing date after its fiscal date;
 * - **profile**, **splits** (none), **exchange holidays**, **company screener** and the alternative
 *   data endpoints (none).
 *
 * Fault injection for the failure tests: `--fail-every N` answers every Nth provider request `429`,
 * `--fail-status` picks another status.
 */

export const SYNTHETIC_FMP_API_KEY = "synthetic-benchmark-provider-key";
export const SYNTHETIC_SYMBOL_PREFIX = "SYN";
/** The first session any synthetic series has. Older than any retention horizon the loader asks for. */
export const SYNTHETIC_HISTORY_START = "1985-01-02";

const DAY_MS = 86_400_000;

export function syntheticSymbol(index: number): string {
  if (!Number.isInteger(index) || index < 1 || index > 9_999) {
    throw new Error("A synthetic symbol index is 1…9999");
  }
  return `${SYNTHETIC_SYMBOL_PREFIX}${String(index).padStart(4, "0")}`;
}

export function isSyntheticSymbol(symbol: string): boolean {
  return /^SYN\d{4}$/.test(symbol);
}

/** A stable 32-bit seed from a string (FNV-1a). */
function seedOf(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32: small, fast, and identical on every platform. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function normal(next: () => number): number {
  const u = Math.max(next(), 1e-12);
  const v = next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Every NYSE session from {@link SYNTHETIC_HISTORY_START} to `through`, by the rule-based calendar. */
const sessionCache = new Map<string, string[]>();
export function syntheticSessions(through: string): string[] {
  const cached = sessionCache.get(through);
  if (cached) {
    return cached;
  }
  const closures = new Set<string>();
  const lastYear = Number(through.slice(0, 4));
  for (
    let year = Number(SYNTHETIC_HISTORY_START.slice(0, 4));
    year <= lastYear;
    year += 1
  ) {
    for (const date of nyseFullClosures(year)) {
      closures.add(date);
    }
  }
  const sessions: string[] = [];
  for (
    let at = Date.parse(`${SYNTHETIC_HISTORY_START}T00:00:00Z`);
    at <= Date.parse(`${through}T00:00:00Z`);
    at += DAY_MS
  ) {
    const date = new Date(at);
    const day = date.getUTCDay();
    const iso = date.toISOString().slice(0, 10);
    if (day !== 0 && day !== 6 && !closures.has(iso)) {
      sessions.push(iso);
    }
  }
  sessionCache.clear();
  sessionCache.set(through, sessions);
  return sessions;
}

/**
 * The newest session the synthetic provider publishes: the last rule-based NYSE session strictly
 * before `now`'s New York date, so no bar is ever an unfinished session.
 */
export function syntheticLastSession(now: Date = new Date()): string {
  const newYork = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const yesterday = new Date(Date.parse(`${newYork}T00:00:00Z`) - DAY_MS)
    .toISOString()
    .slice(0, 10);
  const sessions = syntheticSessions(yesterday);
  return sessions.at(-1) as string;
}

type Bar = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap: number;
};

type SeriesParameters = {
  startPrice: number;
  annualDrift: number;
  annualVolatility: number;
  baseVolume: number;
};

function seriesParameters(symbol: string): SeriesParameters {
  const next = random(seedOf(`params:${symbol}`));
  if (!isSyntheticSymbol(symbol)) {
    // An index or a fund: a broad, lower-volatility series.
    return {
      startPrice: 20 + next() * 80,
      annualDrift: 0.07,
      annualVolatility: 0.16,
      baseVolume: 50_000_000,
    };
  }
  return {
    startPrice: 4 + next() * 120,
    annualDrift: -0.02 + next() * 0.16,
    annualVolatility: 0.18 + next() * 0.4,
    baseVolume: 200_000 + Math.floor(next() * 20_000_000),
  };
}

const barCache = new Map<string, Bar[]>();
const BAR_CACHE_SYMBOLS = 64;

/** The symbol's whole synthetic history through `through`, oldest first. */
export function syntheticBars(symbol: string, through: string): Bar[] {
  const key = `${symbol}|${through}`;
  const cached = barCache.get(key);
  if (cached) {
    barCache.delete(key);
    barCache.set(key, cached);
    return cached;
  }
  const parameters = seriesParameters(symbol);
  const next = random(seedOf(`bars:${symbol}`));
  const sessions = syntheticSessions(through);
  const dailyDrift =
    (parameters.annualDrift -
      (parameters.annualVolatility * parameters.annualVolatility) / 2) /
    252;
  const dailyVolatility = parameters.annualVolatility / Math.sqrt(252);
  const bars: Bar[] = [];
  let close = parameters.startPrice;
  for (const date of sessions) {
    const shock = normal(next);
    // A rare jump keeps the tails fat enough for crossings and drawdowns to look like markets.
    const jump = next() < 0.004 ? normal(next) * 0.08 : 0;
    const open = close * Math.exp(normal(next) * dailyVolatility * 0.3);
    close = Math.max(
      0.5,
      close * Math.exp(dailyDrift + dailyVolatility * shock + jump),
    );
    const high =
      Math.max(open, close) * (1 + Math.abs(normal(next)) * dailyVolatility * 0.5);
    const low =
      Math.min(open, close) * (1 - Math.abs(normal(next)) * dailyVolatility * 0.5);
    const volume = Math.max(
      100,
      Math.round(parameters.baseVolume * Math.exp(normal(next) * 0.35)),
    );
    bars.push({
      date,
      open: round(open, 4),
      high: round(Math.max(high, open, close), 4),
      low: round(Math.max(0.01, Math.min(low, open, close)), 4),
      close: round(close, 4),
      volume,
      vwap: round((open + high + low + close) / 4, 4),
    });
  }
  barCache.set(key, bars);
  while (barCache.size > BAR_CACHE_SYMBOLS) {
    barCache.delete(barCache.keys().next().value as string);
  }
  return bars;
}

/**
 * One `historical-price-eod/full` answer: the bars in `[from, to]`, newest first, capped at the
 * provider's row limit exactly as FMP caps it — the newest rows of the range survive.
 */
export function syntheticDailyBarResponse(
  symbol: string,
  from: string | null,
  to: string | null,
  lastSession: string,
) {
  const bars = syntheticBars(symbol, lastSession);
  const lower = from ?? SYNTHETIC_HISTORY_START;
  const upper = to && to < lastSession ? to : lastSession;
  const inRange: Bar[] = [];
  for (let index = bars.length - 1; index >= 0; index -= 1) {
    const bar = bars[index] as Bar;
    if (bar.date > upper) {
      continue;
    }
    if (bar.date < lower || inRange.length >= FMP_EOD_MAX_ROWS_PER_RESPONSE) {
      break;
    }
    inRange.push(bar);
  }
  return inRange.map((bar, index) => {
    const previous = inRange[index + 1];
    const change = previous ? bar.close - previous.close : 0;
    return {
      symbol,
      date: bar.date,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      change: round(change, 4),
      changePercent: previous ? round((change / previous.close) * 100, 4) : 0,
      vwap: bar.vwap,
    };
  });
}

export function syntheticProfile(symbol: string) {
  const next = random(seedOf(`profile:${symbol}`));
  const index = isSyntheticSymbol(symbol) ? Number(symbol.slice(3)) : 0;
  const sector = FMP_STOCK_SECTORS[index % FMP_STOCK_SECTORS.length];
  const nasdaq = next() < 0.5;
  return {
    symbol,
    companyName: `Synthetic Company ${symbol}`,
    exchange: nasdaq ? "NASDAQ" : "NYSE",
    exchangeFullName: nasdaq ? "NASDAQ Global Select" : "New York Stock Exchange",
    currency: "USD",
    cik: String(9_000_000 + index).padStart(10, "0"),
    country: "US",
    sector,
    industry: `${sector} Synthetic`,
    ipoDate: "1984-06-01",
    isEtf: false,
    isFund: false,
    isAdr: false,
    isActivelyTrading: true,
    description: "Synthetic benchmark security. Not a real company.",
  };
}

type Cadence = "quarter" | "annual";
type StatementType = "income" | "balance" | "cash";

type QuarterFinancials = {
  fiscalDate: string;
  fiscalYear: number;
  quarter: 1 | 2 | 3 | 4;
  revenue: number;
  grossMargin: number;
  operatingMargin: number;
  shares: number;
  totalAssets: number;
  debtRatio: number;
  cashRatio: number;
  capexRatio: number;
};

const QUARTER_ENDS = ["03-31", "06-30", "09-30", "12-31"] as const;

/** Every fiscal quarter from 1985 Q1 through the quarter containing `through`, oldest first. */
function syntheticQuarters(symbol: string, through: string): QuarterFinancials[] {
  const next = random(seedOf(`fundamentals:${symbol}`));
  const quarters: QuarterFinancials[] = [];
  let revenue = 50_000_000 + next() * 2_000_000_000;
  const growth = 0.005 + next() * 0.03;
  let grossMargin = 0.25 + next() * 0.5;
  let operatingMargin = Math.min(grossMargin - 0.05, 0.05 + next() * 0.3);
  let shares = 20_000_000 + Math.floor(next() * 2_000_000_000);
  let assetsToRevenue = 1.5 + next() * 3;
  let debtRatio = 0.1 + next() * 0.5;
  const cashRatio = 0.05 + next() * 0.2;
  const capexRatio = 0.02 + next() * 0.1;
  const lastYear = Number(through.slice(0, 4));
  for (let year = 1985; year <= lastYear; year += 1) {
    for (let quarter = 1 as 1 | 2 | 3 | 4; quarter <= 4; quarter += 1) {
      const fiscalDate = `${year}-${QUARTER_ENDS[quarter - 1]}`;
      if (fiscalDate > through) {
        return quarters;
      }
      revenue = Math.max(1_000_000, revenue * (1 + growth + normal(next) * 0.04));
      grossMargin = Math.min(0.9, Math.max(0.08, grossMargin + normal(next) * 0.01));
      operatingMargin = Math.min(
        grossMargin - 0.02,
        Math.max(-0.15, operatingMargin + normal(next) * 0.012),
      );
      shares = Math.max(1_000_000, Math.round(shares * (1 + normal(next) * 0.004)));
      assetsToRevenue = Math.max(0.8, assetsToRevenue + normal(next) * 0.03);
      debtRatio = Math.min(0.85, Math.max(0.02, debtRatio + normal(next) * 0.01));
      quarters.push({
        fiscalDate,
        fiscalYear: year,
        quarter: quarter as 1 | 2 | 3 | 4,
        revenue,
        grossMargin,
        operatingMargin,
        shares,
        totalAssets: revenue * 4 * assetsToRevenue,
        debtRatio,
        cashRatio,
        capexRatio,
      });
    }
  }
  return quarters;
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function flowValues(revenue: number, quarter: Omit<QuarterFinancials, "revenue">) {
  const costOfRevenue = revenue * (1 - quarter.grossMargin);
  const grossProfit = revenue - costOfRevenue;
  const operatingIncome = revenue * quarter.operatingMargin;
  const operatingExpenses = grossProfit - operatingIncome;
  const depreciationAndAmortization = revenue * 0.04;
  const interestExpense = quarter.totalAssets * quarter.debtRatio * 0.6 * 0.012;
  const interestIncome = quarter.totalAssets * quarter.cashRatio * 0.004;
  const incomeBeforeTax = operatingIncome - interestExpense + interestIncome;
  const incomeTaxExpense = Math.max(0, incomeBeforeTax * 0.22);
  const netIncome = incomeBeforeTax - incomeTaxExpense;
  const operatingCashFlow = netIncome + depreciationAndAmortization + revenue * 0.01;
  const capitalExpenditure = -revenue * quarter.capexRatio;
  return {
    revenue,
    costOfRevenue,
    grossProfit,
    researchAndDevelopmentExpenses: operatingExpenses * 0.3,
    generalAndAdministrativeExpenses: operatingExpenses * 0.3,
    sellingAndMarketingExpenses: operatingExpenses * 0.4,
    sellingGeneralAndAdministrativeExpenses: operatingExpenses * 0.7,
    otherExpenses: 0,
    operatingExpenses,
    costAndExpenses: costOfRevenue + operatingExpenses,
    netInterestIncome: interestIncome - interestExpense,
    interestIncome,
    interestExpense,
    depreciationAndAmortization,
    ebitda: operatingIncome + depreciationAndAmortization,
    ebit: operatingIncome,
    nonOperatingIncomeExcludingInterest: 0,
    operatingIncome,
    totalOtherIncomeExpensesNet: interestIncome - interestExpense,
    incomeBeforeTax,
    incomeTaxExpense,
    netIncomeFromContinuingOperations: netIncome,
    netIncomeFromDiscontinuedOperations: 0,
    otherAdjustmentsToNetIncome: 0,
    netIncome,
    netIncomeDeductions: 0,
    bottomLineNetIncome: netIncome,
    eps: netIncome / quarter.shares,
    epsDiluted: netIncome / (quarter.shares * 1.01),
    weightedAverageShsOut: quarter.shares,
    weightedAverageShsOutDil: Math.round(quarter.shares * 1.01),
    deferredIncomeTax: 0,
    stockBasedCompensation: revenue * 0.01,
    changeInWorkingCapital: -revenue * 0.005,
    accountsReceivables: -revenue * 0.002,
    inventory: -revenue * 0.002,
    accountsPayables: revenue * 0.001,
    otherWorkingCapital: -revenue * 0.002,
    otherNonCashItems: 0,
    netCashProvidedByOperatingActivities: operatingCashFlow,
    investmentsInPropertyPlantAndEquipment: capitalExpenditure,
    acquisitionsNet: 0,
    purchasesOfInvestments: 0,
    salesMaturitiesOfInvestments: 0,
    otherInvestingActivities: 0,
    netCashProvidedByInvestingActivities: capitalExpenditure,
    netDebtIssuance: 0,
    longTermNetDebtIssuance: 0,
    shortTermNetDebtIssuance: 0,
    netStockIssuance: 0,
    netCommonStockIssuance: 0,
    commonStockIssuance: 0,
    commonStockRepurchased: 0,
    netPreferredStockIssuance: 0,
    netDividendsPaid: -Math.max(0, netIncome * 0.25),
    commonDividendsPaid: -Math.max(0, netIncome * 0.25),
    preferredDividendsPaid: 0,
    otherFinancingActivities: 0,
    netCashProvidedByFinancingActivities: -Math.max(0, netIncome * 0.25),
    effectOfForexChangesOnCash: 0,
    netChangeInCash:
      operatingCashFlow + capitalExpenditure - Math.max(0, netIncome * 0.25),
    operatingCashFlow,
    capitalExpenditure,
    freeCashFlow: operatingCashFlow + capitalExpenditure,
    incomeTaxesPaid: incomeTaxExpense,
    interestPaid: interestExpense,
  };
}

function balanceValues(quarter: QuarterFinancials) {
  const totalAssets = quarter.totalAssets;
  const cashAndCashEquivalents = totalAssets * quarter.cashRatio;
  const shortTermInvestments = totalAssets * 0.02;
  const netReceivables = quarter.revenue * 0.6;
  const inventory = quarter.revenue * 0.4;
  const totalCurrentAssets =
    cashAndCashEquivalents + shortTermInvestments + netReceivables + inventory;
  const totalNonCurrentAssets = totalAssets - totalCurrentAssets;
  const goodwill = totalNonCurrentAssets * 0.15;
  const intangibleAssets = totalNonCurrentAssets * 0.05;
  const propertyPlantEquipmentNet = totalNonCurrentAssets - goodwill - intangibleAssets;
  const totalDebt = totalAssets * quarter.debtRatio * 0.6;
  const shortTermDebt = totalDebt * 0.15;
  const longTermDebt = totalDebt - shortTermDebt;
  const accountPayables = quarter.revenue * 0.35;
  const totalCurrentLiabilities = shortTermDebt + accountPayables + quarter.revenue * 0.2;
  const totalLiabilities = totalAssets * quarter.debtRatio;
  const totalNonCurrentLiabilities = totalLiabilities - totalCurrentLiabilities;
  const totalStockholdersEquity = totalAssets - totalLiabilities;
  return {
    cashAndCashEquivalents,
    shortTermInvestments,
    cashAndShortTermInvestments: cashAndCashEquivalents + shortTermInvestments,
    netReceivables,
    accountsReceivables: netReceivables,
    otherReceivables: 0,
    inventory,
    prepaids: 0,
    otherCurrentAssets: 0,
    totalCurrentAssets,
    propertyPlantEquipmentNet,
    goodwill,
    intangibleAssets,
    goodwillAndIntangibleAssets: goodwill + intangibleAssets,
    longTermInvestments: 0,
    taxAssets: 0,
    otherNonCurrentAssets: 0,
    totalNonCurrentAssets,
    otherAssets: 0,
    totalAssets,
    totalPayables: accountPayables,
    accountPayables,
    otherPayables: 0,
    accruedExpenses: quarter.revenue * 0.2,
    shortTermDebt,
    capitalLeaseObligationsCurrent: 0,
    taxPayables: 0,
    deferredRevenue: 0,
    otherCurrentLiabilities: 0,
    totalCurrentLiabilities,
    longTermDebt,
    capitalLeaseObligationsNonCurrent: 0,
    deferredRevenueNonCurrent: 0,
    deferredTaxLiabilitiesNonCurrent: 0,
    otherNonCurrentLiabilities: totalNonCurrentLiabilities - longTermDebt,
    totalNonCurrentLiabilities,
    otherLiabilities: 0,
    capitalLeaseObligations: 0,
    totalLiabilities,
    treasuryStock: 0,
    preferredStock: 0,
    commonStock: quarter.shares * 0.01,
    retainedEarnings: totalStockholdersEquity * 0.7,
    additionalPaidInCapital: totalStockholdersEquity * 0.3 - quarter.shares * 0.01,
    accumulatedOtherComprehensiveIncomeLoss: 0,
    otherTotalStockholdersEquity: 0,
    totalStockholdersEquity,
    totalEquity: totalStockholdersEquity,
    minorityInterest: 0,
    totalLiabilitiesAndTotalEquity: totalAssets,
    totalInvestments: shortTermInvestments,
    totalDebt,
    netDebt: totalDebt - cashAndCashEquivalents,
  };
}

const FIELDS: Record<StatementType, readonly string[]> = {
  income: INCOME_STATEMENT_FIELDS,
  balance: BALANCE_SHEET_FIELDS,
  cash: CASH_FLOW_FIELDS,
};

/**
 * One statement endpoint's answer: the newest `limit` filings published by `asOf`, newest first.
 * Quarterly filings land 40 days after the quarter, annual ones 70 days after the year.
 */
export function syntheticStatementResponse(
  symbol: string,
  type: StatementType,
  cadence: Cadence,
  limit: number,
  asOf: string,
) {
  const quarters = syntheticQuarters(symbol, asOf);
  const rows: Record<string, unknown>[] = [];
  const header = (fiscalDate: string, fiscalYear: number, period: string, filingDate: string) => ({
    date: fiscalDate,
    symbol,
    reportedCurrency: "USD",
    cik: syntheticProfile(symbol).cik,
    filingDate,
    acceptedDate: `${filingDate} 16:05:00`,
    fiscalYear: String(fiscalYear),
    period,
  });
  const pick = (values: Record<string, number>) => {
    const picked: Record<string, number> = {};
    for (const field of FIELDS[type]) {
      const value = values[field];
      if (value !== undefined) {
        picked[field] = Math.round(value);
      }
    }
    if (type === "income") {
      picked.eps = round(values.eps ?? 0, 4);
      picked.epsDiluted = round(values.epsDiluted ?? 0, 4);
    }
    return picked;
  };
  if (cadence === "quarter") {
    for (const quarter of quarters) {
      const filingDate = addDays(quarter.fiscalDate, 40);
      if (filingDate > asOf) {
        continue;
      }
      const values =
        type === "balance"
          ? balanceValues(quarter)
          : flowValues(quarter.revenue, quarter);
      rows.push({
        ...header(quarter.fiscalDate, quarter.fiscalYear, `Q${quarter.quarter}`, filingDate),
        ...pick(values as Record<string, number>),
      });
    }
  } else {
    for (let index = 3; index < quarters.length; index += 4) {
      const year = quarters.slice(index - 3, index + 1);
      const last = year[3] as QuarterFinancials;
      if (last.quarter !== 4) {
        continue;
      }
      const filingDate = addDays(last.fiscalDate, 70);
      if (filingDate > asOf) {
        continue;
      }
      let values: Record<string, number>;
      if (type === "balance") {
        values = balanceValues(last) as Record<string, number>;
      } else {
        // Flows over the year are the sum of its quarters; per-share figures follow from them.
        const summed: Record<string, number> = {};
        for (const quarter of year) {
          for (const [field, value] of Object.entries(
            flowValues(quarter.revenue, quarter),
          )) {
            summed[field] = (summed[field] ?? 0) + value;
          }
        }
        summed.weightedAverageShsOut = last.shares;
        summed.weightedAverageShsOutDil = Math.round(last.shares * 1.01);
        summed.eps = (summed.netIncome ?? 0) / last.shares;
        summed.epsDiluted = (summed.netIncome ?? 0) / (last.shares * 1.01);
        values = summed;
      }
      rows.push({
        ...header(last.fiscalDate, last.fiscalYear, "FY", filingDate),
        ...pick(values),
      });
    }
  }
  return rows.reverse().slice(0, Math.max(1, limit));
}

export type SyntheticFmpOptions = {
  readonly apiKey?: string;
  /** Fixed delay added to every provider answer, modelling the provider's round trip. */
  readonly latencyMs?: number;
  /** Answers every Nth provider request with `failStatus` (fault injection); 0 disables. */
  readonly failEvery?: number;
  readonly failStatus?: number;
  /** The newest session published; defaults to the session before today's New York date. */
  readonly lastSession?: string;
  readonly log?: (line: string) => void;
};

export type SyntheticFmpCounters = {
  requests: number;
  failuresInjected: number;
  unexpected: number;
  bytes: number;
  byEndpoint: Record<string, number>;
};

export type SyntheticFmpServer = {
  readonly server: Server;
  readonly counters: SyntheticFmpCounters;
  close(): Promise<void>;
};

type Answer = { status: number; body: unknown; endpoint: string };

const STATEMENT_TYPES: Record<string, StatementType> = {
  "income-statement": "income",
  "balance-sheet-statement": "balance",
  "cash-flow-statement": "cash",
};

const EMPTY_LIST_ENDPOINTS = new Set([
  "splits",
  "insider-trading/search",
  "senate-trades",
  "house-trades",
  "dividends",
]);

/** Decides one answer. Pure apart from the clock default, so it is unit-testable without a socket. */
export function answerSyntheticFmpRequest(
  url: URL,
  options: { apiKey: string; lastSession: string; universe?: number },
): Answer {
  const endpoint = url.pathname.replace(/^\/stable\//, "").replace(/^\/+/, "");
  if (url.searchParams.get("apikey") !== options.apiKey) {
    return {
      status: 401,
      endpoint,
      body: { error: "synthetic FMP: the request did not carry the synthetic benchmark key" },
    };
  }
  const symbol = url.searchParams.get("symbol")?.trim().toUpperCase() ?? "";
  if (endpoint === "historical-price-eod/full") {
    if (!/^[\^A-Z0-9.-]{1,12}$/.test(symbol)) {
      return { status: 400, endpoint, body: { error: "symbol required" } };
    }
    return {
      status: 200,
      endpoint,
      body: syntheticDailyBarResponse(
        symbol,
        url.searchParams.get("from"),
        url.searchParams.get("to"),
        options.lastSession,
      ),
    };
  }
  if (endpoint === "profile") {
    return { status: 200, endpoint, body: symbol ? [syntheticProfile(symbol)] : [] };
  }
  const statementType = STATEMENT_TYPES[endpoint];
  if (statementType) {
    const period = url.searchParams.get("period") === "quarter" ? "quarter" : "annual";
    const limit = Number(url.searchParams.get("limit") ?? "5");
    return {
      status: 200,
      endpoint,
      body: syntheticStatementResponse(
        symbol,
        statementType,
        period,
        Number.isFinite(limit) ? limit : 5,
        options.lastSession,
      ),
    };
  }
  if (EMPTY_LIST_ENDPOINTS.has(endpoint)) {
    return { status: 200, endpoint, body: [] };
  }
  if (endpoint === "holidays-by-exchange") {
    const exchange = url.searchParams.get("exchange")?.trim().toUpperCase() ?? "";
    const from = url.searchParams.get("from") ?? "";
    const to = url.searchParams.get("to") ?? "";
    if (!(SUPPORTED_EXCHANGE_CODES as readonly string[]).includes(exchange) || !(from < to)) {
      return { status: 400, endpoint, body: { error: "exchange, from and to required" } };
    }
    return {
      status: 200,
      endpoint,
      body: fixtureHolidays(from, to).map((date) => ({
        exchange,
        date,
        name: "Synthetic full closure",
        isClosed: true,
      })),
    };
  }
  if (endpoint === "company-screener") {
    const exchange = url.searchParams.get("exchange")?.trim().toUpperCase() ?? "";
    const universe = options.universe ?? 0;
    const listings = [];
    for (let index = 1; index <= universe; index += 1) {
      const profile = syntheticProfile(syntheticSymbol(index));
      if (profile.exchange === exchange) {
        listings.push({
          symbol: profile.symbol,
          companyName: profile.companyName,
          exchange: profile.exchangeFullName,
          exchangeShortName: profile.exchange,
          country: profile.country,
          isEtf: false,
          isFund: false,
          isActivelyTrading: true,
          sector: profile.sector,
          industry: profile.industry,
        });
      }
    }
    return { status: 200, endpoint, body: listings };
  }
  return {
    status: 404,
    endpoint,
    body: { error: `synthetic FMP: no synthetic answer for GET ${endpoint}` },
  };
}

export function createSyntheticFmpServer(
  options: SyntheticFmpOptions & { universe?: number } = {},
): SyntheticFmpServer {
  const apiKey = options.apiKey ?? SYNTHETIC_FMP_API_KEY;
  const latencyMs = Math.max(0, options.latencyMs ?? 0);
  const failEvery = Math.max(0, options.failEvery ?? 0);
  const failStatus = options.failStatus ?? 429;
  const log = options.log ?? (() => {});
  const counters: SyntheticFmpCounters = {
    requests: 0,
    failuresInjected: 0,
    unexpected: 0,
    bytes: 0,
    byEndpoint: {},
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/__synthetic/health") {
      return json(response, 200, { status: "ok", lastSession: lastSession() });
    }
    if (url.pathname === "/__synthetic/counters") {
      return json(response, 200, counters);
    }
    if (request.method !== "GET") {
      return json(response, 405, { error: "synthetic FMP answers GET only" });
    }
    counters.requests += 1;
    const sequence = counters.requests;
    const respond = () => {
      if (failEvery > 0 && sequence % failEvery === 0) {
        counters.failuresInjected += 1;
        return json(response, failStatus, { error: "synthetic FMP: injected failure" });
      }
      let answer: Answer;
      try {
        answer = answerSyntheticFmpRequest(url, {
          apiKey,
          lastSession: lastSession(),
          ...(options.universe === undefined ? {} : { universe: options.universe }),
        });
      } catch (error) {
        answer = {
          status: 500,
          endpoint: url.pathname,
          body: { error: error instanceof Error ? error.message : String(error) },
        };
      }
      counters.byEndpoint[answer.endpoint] = (counters.byEndpoint[answer.endpoint] ?? 0) + 1;
      if (answer.status !== 200) {
        counters.unexpected += 1;
        log(`UNEXPECTED ${answer.status} ${answer.endpoint} ${JSON.stringify(answer.body)}`);
      }
      counters.bytes += json(response, answer.status, answer.body);
    };
    if (latencyMs > 0) {
      setTimeout(respond, latencyMs);
    } else {
      respond();
    }
  });
  let cachedSession: { at: number; value: string } | null = null;
  function lastSession(): string {
    if (options.lastSession) {
      return options.lastSession;
    }
    if (!cachedSession || Date.now() - cachedSession.at > 60_000) {
      cachedSession = { at: Date.now(), value: syntheticLastSession() };
    }
    return cachedSession.value;
  }
  return {
    server,
    counters,
    close: () =>
      new Promise((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      ),
  };
}

function json(response: ServerResponse, status: number, body: unknown): number {
  const payload = JSON.stringify(body);
  const length = Buffer.byteLength(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": length,
  });
  response.end(payload);
  return length;
}
