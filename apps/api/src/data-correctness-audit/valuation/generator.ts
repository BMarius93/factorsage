import type {
  OracleSplitEntry,
  OracleValuationEvent,
  OracleValuationSecurity,
  OracleValuationStatement,
} from "../oracle/valuation-ratios";

/**
 * Deterministic adversarial valuation histories for the differential audit.
 *
 * One seed is one security: 8-20 fiscal quarters of the three statement families with revisions,
 * delayed and lagging availability, missing quarters and fields, currency changes, signed and zero
 * denominators, share-level jumps, artefacts, alternating blocks and restatements, FY rows, a
 * session calendar with weekends and holidays, a close series, the provider's split list (plain,
 * non-plain, mislabelled, unreadable, history and forward), measured re-bases (dated, undated,
 * plain, near-plain, possible distributions) and unexplained changes. Several features are aimed at
 * the decision's day boundaries on purpose (an observation on an event's date or an interval's
 * first day, a re-base exactly seven days from a listed entry, a restatement of exactly 2 %, an
 * exactly 25 % share move, a ratio at the representability limit).
 *
 * The generator encodes no valuation rule: it only produces stored-row shapes. Whatever it
 * produces, the reference and the product must agree on.
 */

export type GeneratedHistory = {
  seed: number;
  security: OracleValuationSecurity;
  sessions: { date: string; close: string }[];
  /** The adversarial features this history carries, for the coverage table. */
  features: string[];
};

export class Random {
  private state: number;
  constructor(seed: number) {
    this.state = (seed * 2654435761) >>> 0 || 1;
  }
  /** mulberry32 */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(low: number, high: number): number {
    return low + Math.floor(this.next() * (high - low + 1));
  }
  chance(probability: number): boolean {
    return this.next() < probability;
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)] as T;
  }
}

const DAY = 86_400_000;

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY)
    .toISOString()
    .slice(0, 10);
}

export function weekday(date: string): number {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

export function monthEnd(year: number, month: number): string {
  // month 1-12, possibly beyond 12 (rolls into the next year)
  const y = year + Math.floor((month - 1) / 12);
  const m = ((month - 1) % 12) + 1;
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export function isHoliday(date: string): boolean {
  const md = date.slice(5);
  return md === "01-01" || md === "07-04" || md === "12-25" || md === "11-26";
}

export function instant(date: string, random: Random): string {
  const ms = Date.parse(`${date}T00:00:00.000Z`) + random.int(0, DAY - 1);
  return new Date(ms).toISOString();
}

const PLAIN_ENTRIES: readonly [string, string][] = [
  ["2", "1"],
  ["3", "2"],
  ["1", "10"],
  ["4", "1"],
  ["5", "4"],
  ["1", "32"],
  ["20", "1"],
  ["6", "4"],
  ["5", "3"],
  ["2", "5"],
];
const NON_PLAIN_ENTRIES: readonly [string, string][] = [
  ["1323", "1000"],
  ["523", "500"],
  ["131", "125"],
  ["10000", "8753"],
  ["1011", "1000"],
  ["1907", "2000"],
  ["51", "50"],
  ["9", "5"],
  ["0", "1"],
  ["2000", "1973"],
  ["1001", "500"],
  ["11", "10"],
];
const PLAIN_RATIOS = [2, 3, 1.5, 0.1, 4, 1.25, 0.5, 10, 0.2, 5 / 3, 0.75];
const NON_PLAIN_RATIOS = [1.046, 1.3273, 0.9532, 1.1326, 1.048, 2.03, 1.12];

type QuarterPlan = {
  fiscalYear: number;
  period: "Q1" | "Q2" | "Q3" | "Q4";
  fiscalDate: string;
  available: string;
};

export function generateHistory(seed: number): GeneratedHistory {
  const random = new Random(seed);
  const features = new Set<string>();
  const quarterCount = random.int(8, 20);
  const startYear = random.int(2005, 2018);
  const fiscalShift = random.pick([0, 0, 1, 2]);
  if (fiscalShift !== 0) {
    features.add("non-calendar-fiscal-year");
  }
  const observation = random.pick(["realtime", "first-load", "mixed"] as const);
  features.add(`observation-${observation}`);

  // ---- quarters and availability
  const quarters: QuarterPlan[] = [];
  for (let index = 0; index < quarterCount; index += 1) {
    const fiscalYear = startYear + Math.floor(index / 4);
    const quarterOfYear = (index % 4) + 1;
    const fiscalDate = monthEnd(fiscalYear, quarterOfYear * 3 + fiscalShift);
    const lag = quarterOfYear === 4 ? random.int(40, 95) : random.int(25, 50);
    quarters.push({
      fiscalYear,
      period: `Q${quarterOfYear}` as QuarterPlan["period"],
      fiscalDate,
      available: addDays(fiscalDate, lag),
    });
  }
  const lastAvailable = quarters.at(-1)!.available;
  const firstLoadInstant = instant(
    addDays(lastAvailable, random.int(5, 400)),
    random,
  );

  // ---- sessions and closes
  const firstSession = addDays(quarters[0]!.fiscalDate, -random.int(20, 120));
  const lastSession = addDays(lastAvailable, random.int(60, 260));
  const sessions: { date: string; close: string }[] = [];
  const scaleDigits = random.pick([2, 2, 4, 8]);
  let close = random.pick([0.42, 3.17, 27.5, 118.2, 640, 0.0009]);
  if (close < 0.001) {
    features.add("tiny-closes");
  }
  for (let date = firstSession; date <= lastSession; date = addDays(date, 1)) {
    const day = weekday(date);
    if (day === 0 || day === 6 || isHoliday(date)) {
      continue;
    }
    close = Math.max(close * Math.exp((random.next() - 0.5) * 0.06), 1e-6);
    let text = close.toFixed(scaleDigits);
    if (Number(text) === 0) {
      text = (1e-8).toFixed(8);
    }
    sessions.push({ date, close: text });
  }
  if (random.chance(0.06)) {
    // Late in the history, where the inputs are usually complete: the close alone withholds it.
    const at = Math.min(
      sessions.length - 1,
      Math.floor(sessions.length * (0.85 + random.next() * 0.14)),
    );
    sessions[at] = {
      date: sessions[at]!.date,
      close: random.pick(["0", "0.00000000"]),
    };
    features.add("zero-close");
  }
  const sessionDates = sessions.map((session) => session.date);
  const sessionAt = (fraction: number) =>
    sessionDates[
      Math.min(
        sessionDates.length - 1,
        Math.max(0, Math.floor(fraction * sessionDates.length)),
      )
    ] as string;

  // ---- line items
  const scale = 10 ** random.int(3, 10);
  const decimals = random.chance(0.25);
  const amount = (value: number) =>
    decimals ? Math.round(value * 100) / 100 : Math.round(value);
  let revenue = scale * (1 + random.next() * 4);
  const margin = random.next() * 0.45 - 0.15;
  const ebitdaMargin = random.next() * 0.55 - 0.1;
  const baseShares = 4 * random.int(250_000, 2_500_000_000);
  let shareLevel = baseShares;
  const shareFeature = random.pick([
    "steady",
    "steady",
    "level-jump",
    "artefact",
    "two-quarter-artefact",
    "alternating",
    "exact-boundary-up",
    "exact-boundary-down",
    "missing-count",
    "non-positive-count",
    "drift",
  ] as const);
  features.add(`shares-${shareFeature}`);
  const jumpAt = random.int(2, Math.max(2, quarterCount - 2));

  type Row = Record<
    "INCOME" | "BALANCE_SHEET" | "CASH_FLOW",
    Record<string, unknown>
  >;
  const rows: Row[] = [];
  for (let index = 0; index < quarterCount; index += 1) {
    revenue *= 1 + (random.next() - 0.45) * 0.12;
    let shares: number | undefined = Math.round(
      shareLevel * (1 + (random.next() - 0.5) * 0.01),
    );
    switch (shareFeature) {
      case "level-jump":
        if (index === jumpAt) {
          shareLevel *= random.pick([1.3, 1.6, 2.2, 0.6]);
          shares = Math.round(shareLevel);
        }
        break;
      case "artefact":
        if (index === jumpAt) {
          shares = Math.round(shareLevel * 2.03);
        }
        break;
      case "two-quarter-artefact":
        if (index === jumpAt || index === jumpAt + 1) {
          shares = Math.round(shareLevel * 1.987);
        }
        break;
      case "alternating":
        if (index >= jumpAt && Math.floor((index - jumpAt) / 2) % 2 === 0) {
          shares = Math.round(shareLevel * 1.4);
        }
        break;
      case "exact-boundary-up":
        shares = index >= jumpAt ? (baseShares / 4) * 5 : baseShares;
        break;
      case "exact-boundary-down":
        shares = index >= jumpAt ? (baseShares / 4) * 3 : baseShares;
        break;
      case "missing-count":
        if (index === jumpAt || random.chance(0.05)) {
          shares = undefined;
        }
        break;
      case "non-positive-count":
        if (index === jumpAt) {
          shares = random.pick([0, -baseShares]);
        }
        break;
      case "drift":
        shareLevel *= 1 + random.pick([0.24, 0.26, -0.2, 0.1, 0.249]);
        shares = Math.round(shareLevel);
        break;
      default:
        break;
    }
    const netIncome = amount(
      revenue *
        (margin + (random.next() - 0.5) * 0.2) *
        (random.chance(0.05) ? -3 : 1),
    );
    const income: Record<string, unknown> = {
      revenue: amount(random.chance(0.01) ? 0 : revenue),
      netIncome,
      ebitda: amount(revenue * (ebitdaMargin + (random.next() - 0.5) * 0.1)),
      weightedAverageShsOut: shares === undefined ? baseShares : shares * 0.97,
      epsDiluted: shares ? netIncome / shares : 0,
    };
    if (shares !== undefined) {
      income.weightedAverageShsOutDil = shares;
    }
    const balance: Record<string, unknown> = {
      totalStockholdersEquity: amount(
        revenue * (random.next() * 3.5 - (random.chance(0.06) ? 4 : 0.3)),
      ),
      netDebt: amount(revenue * (random.next() * 3 - 1.2)),
      totalEquity: amount(revenue * 9),
      totalDebt: amount(revenue * 7),
    };
    const operating = amount(revenue * (random.next() * 0.5 - 0.12));
    const capital = amount(-revenue * random.next() * 0.2);
    const cash: Record<string, unknown> = {
      operatingCashFlow: operating,
      capitalExpenditure: capital,
      freeCashFlow: operating + capital + amount(revenue),
    };
    // missing fields
    for (const [family, field] of [
      [income, "netIncome"],
      [income, "revenue"],
      [income, "ebitda"],
      [balance, "totalStockholdersEquity"],
      [balance, "netDebt"],
      [cash, "operatingCashFlow"],
      [cash, "capitalExpenditure"],
    ] as const) {
      if (random.chance(0.015)) {
        delete (family as Record<string, unknown>)[field];
        features.add("missing-field");
      }
    }
    rows.push({ INCOME: income, BALANCE_SHEET: balance, CASH_FLOW: cash });
  }

  if (random.chance(0.05) && quarterCount > 6) {
    // A trailing year of net income a hair above zero: P/E beyond what a calculated-series value
    // holds (|value| >= 10^12), or on the other side of zero after the reported figures' rounding.
    const at = random.int(3, quarterCount - 1);
    let others = 0;
    for (let offset = 1; offset <= 3; offset += 1) {
      const value = rows[at - offset]!.INCOME.netIncome;
      others += typeof value === "number" ? value : 0;
    }
    rows[at]!.INCOME.netIncome = -others + random.pick([1e-6, 1e-4, 0.01]);
    features.add("near-zero-denominator");
  }

  // ---- statements
  const statements: OracleValuationStatement[] = [];
  const currencyFamily = random.chance(0.08)
    ? random.pick(["INCOME", "BALANCE_SHEET", "CASH_FLOW"] as const)
    : undefined;
  const wholeCurrency = random.chance(0.04) ? "EUR" : "USD";
  if (wholeCurrency !== "USD") {
    features.add("all-statements-other-currency");
  }
  if (currencyFamily) {
    features.add("one-family-other-currency");
  }
  const lagFamily = random.chance(0.2)
    ? random.pick(["BALANCE_SHEET", "CASH_FLOW"] as const)
    : undefined;
  if (lagFamily) {
    features.add(`lagging-${lagFamily}`);
  }
  const missingQuarter = random.chance(0.12)
    ? random.int(1, quarterCount - 1)
    : undefined;
  const missingFamily = random.pick([
    "INCOME",
    "BALANCE_SHEET",
    "CASH_FLOW",
  ] as const);
  if (missingQuarter !== undefined) {
    features.add("missing-quarter");
  }
  let hashCounter = 0;
  const observedFor = (available: string, quarterIndex: number): string => {
    if (observation === "first-load") {
      return firstLoadInstant;
    }
    if (observation === "mixed" && quarterIndex < quarterCount / 2) {
      return instant(
        addDays(quarters[Math.floor(quarterCount / 2)]!.available, 3),
        random,
      );
    }
    return instant(addDays(available, random.int(0, 2)), random);
  };
  quarters.forEach((quarter, quarterIndex) => {
    for (const family of ["INCOME", "BALANCE_SHEET", "CASH_FLOW"] as const) {
      if (missingQuarter === quarterIndex && family === missingFamily) {
        continue;
      }
      let available = quarter.available;
      if (lagFamily === family && random.chance(0.5)) {
        available = addDays(available, random.int(5, 75));
      }
      const currency =
        currencyFamily === family && quarterIndex >= quarterCount / 2
          ? "EUR"
          : wholeCurrency;
      statements.push({
        statementType: family,
        fiscalDate: quarter.fiscalDate,
        fiscalYear: quarter.fiscalYear,
        period: quarter.period,
        reportedCurrency: random.chance(0.004)
          ? (features.add("empty-currency"), "")
          : currency,
        availableFromDate: available,
        observedAt: observedFor(available, quarterIndex),
        contentHash: `h${(hashCounter += 1)}`,
        values: rows[quarterIndex]![family],
      });
    }
  });

  // FY rows that must never be read.
  for (
    let year = startYear;
    year < startYear + Math.floor(quarterCount / 4);
    year += 1
  ) {
    const q4 = quarters.find(
      (quarter) => quarter.fiscalYear === year && quarter.period === "Q4",
    );
    if (!q4 || !random.chance(0.6)) {
      continue;
    }
    features.add("fy-rows");
    statements.push({
      statementType: "INCOME",
      fiscalDate: q4.fiscalDate,
      fiscalYear: year,
      period: "FY",
      reportedCurrency: wholeCurrency,
      availableFromDate: addDays(q4.available, random.int(-5, 5)),
      observedAt: observedFor(q4.available, 0),
      contentHash: `h${(hashCounter += 1)}`,
      values: {
        revenue: 1,
        netIncome: 1,
        ebitda: 1,
        weightedAverageShsOutDil: 999,
      },
    });
  }

  // Revisions.
  const originals = [...statements].filter(
    (statement) => statement.period !== "FY",
  );
  for (const original of originals) {
    if (!random.chance(0.09)) {
      continue;
    }
    const kind = random.pick([
      "value",
      "shares-random",
      "shares-split",
      "shares-exact-2pct",
      "shares-just-over-2pct",
      "moved-period-end",
      "same-day-later-observation",
      "currency",
      "remove-field",
    ] as const);
    const delay =
      kind === "same-day-later-observation" ? 0 : random.int(1, 260);
    const available = addDays(original.availableFromDate, delay);
    const values: Record<string, unknown> = { ...original.values };
    let fiscalDate = original.fiscalDate;
    let reportedCurrency = original.reportedCurrency;
    const count = values.weightedAverageShsOutDil;
    switch (kind) {
      case "value": {
        const field = random.pick(Object.keys(values));
        if (typeof values[field] === "number") {
          values[field] = amount(
            (values[field] as number) * (1 + (random.next() - 0.5) * 0.3),
          );
        }
        break;
      }
      case "shares-random":
        if (typeof count === "number" && original.statementType === "INCOME") {
          values.weightedAverageShsOutDil = Math.round(
            count * random.pick([1.01, 1.05, 0.97, 1.2]),
          );
        }
        break;
      case "shares-split":
        if (typeof count === "number" && original.statementType === "INCOME") {
          values.weightedAverageShsOutDil = Math.round(
            count * random.pick([2, 3, 0.1, 1.5, 1.25]),
          );
        }
        break;
      case "shares-exact-2pct":
        if (typeof count === "number" && original.statementType === "INCOME") {
          // An exactly 2 % restatement of an integer count: the original is moved to a multiple of
          // 50 first (both are integers, as every stored count is).
          const base = Math.max(50, Math.round(count / 50) * 50);
          (
            original.values as Record<string, unknown>
          ).weightedAverageShsOutDil = base;
          values.weightedAverageShsOutDil = random.chance(0.5)
            ? (base / 50) * 51
            : (base / 50) * 49;
        }
        break;
      case "shares-just-over-2pct":
        if (typeof count === "number" && original.statementType === "INCOME") {
          values.weightedAverageShsOutDil = Math.round(count * 1.0201);
        }
        break;
      case "moved-period-end":
        fiscalDate = addDays(original.fiscalDate, random.pick([-4, -2, 3, 5]));
        break;
      case "currency":
        reportedCurrency = reportedCurrency === "USD" ? "EUR" : "USD";
        break;
      case "remove-field": {
        const field = random.pick(Object.keys(values));
        delete values[field];
        break;
      }
      default:
        break;
    }
    features.add(`revision-${kind}`);
    const observedAt =
      kind === "same-day-later-observation"
        ? new Date(
            Date.parse(original.observedAt) + random.int(1, 40) * 3_600_000,
          ).toISOString()
        : instant(available, random);
    statements.push({
      ...original,
      fiscalDate,
      reportedCurrency,
      availableFromDate: available,
      observedAt,
      contentHash: `h${(hashCounter += 1)}`,
      values,
    });
  }

  // ---- price basis
  const verifiedMode = random.pick([
    "end",
    "end",
    "mid",
    "null",
    "early",
  ] as const);
  features.add(`verified-${verifiedMode}`);
  const verifiedAt =
    verifiedMode === "null"
      ? null
      : verifiedMode === "end"
        ? instant(addDays(lastSession, random.int(0, 30)), random)
        : verifiedMode === "early"
          ? instant(sessionAt(0.1), random)
          : instant(sessionAt(0.5 + random.next() * 0.3), random);

  const splits: OracleSplitEntry[] = [];
  const splitCount = random.pick([0, 0, 1, 1, 2, 3, 4]);
  for (let index = 0; index < splitCount; index += 1) {
    const plain = random.chance(0.5);
    const [numerator, denominator] = random.pick(
      plain ? PLAIN_ENTRIES : NON_PLAIN_ENTRIES,
    );
    const label = random.chance(0.85)
      ? "stock-split"
      : random.pick(["spin-off", "stock-dividend", null] as const);
    let date = random.chance(0.85)
      ? sessionAt(random.next())
      : addDays(sessionAt(random.next()), random.int(-3, 3));
    if (verifiedAt !== null && random.chance(0.25)) {
      // A forward entry just after verification.
      date = addDays(verifiedAt.slice(0, 10), random.int(1, 20));
      features.add("forward-entry");
    }
    splits.push({ date, numerator, denominator, label });
    features.add(
      plain && label === "stock-split" ? "plain-entry" : "non-plain-entry",
    );
  }

  const events: OracleValuationEvent[] = [];
  const eventCount = random.pick([0, 0, 0, 1, 1, 2, 3]);
  const statementObservations = statements
    .map((statement) => statement.observedAt)
    .sort();
  for (let index = 0; index < eventCount; index += 1) {
    const plain = random.chance(0.55);
    let ratio = random.pick(plain ? PLAIN_RATIOS : NON_PLAIN_RATIOS);
    if (plain && random.chance(0.3)) {
      ratio *= 1 + random.pick([0.004, -0.004, 0.005, 0.0051, -0.0049]);
      features.add("near-plain-measured");
    }
    const undated = random.chance(0.35);
    let start = sessionAt(random.next());
    const nearSplit =
      splits.length > 0 && random.chance(0.4) ? random.pick(splits) : undefined;
    if (nearSplit) {
      start = addDays(nearSplit.date, random.pick([0, 3, 7, 8, -7, -8, 7]));
      features.add("event-near-entry");
    }
    const end = addDays(start, random.int(1, 9));
    let detected = instant(
      addDays(undated ? end : start, random.int(0, 70)),
      random,
    );
    if (random.chance(0.25) && statementObservations.length > 0) {
      // Detected at exactly a statement's observation instant.
      detected = random.pick(statementObservations);
      features.add("detected-at-observation");
    }
    if (undated) {
      events.push({
        kind: "MEASURED",
        effectiveFrom: start,
        effectiveTo: end,
        priceRatio: String(ratio),
        detectedAt: detected,
      });
      features.add("undated-measured");
    } else {
      events.push({
        kind: "MEASURED",
        effectiveDate: start,
        priceRatio: String(ratio),
        detectedAt: detected,
      });
      features.add("dated-measured");
    }
    features.add(plain ? "plain-measured" : "non-plain-measured");
    // Statements observed exactly on the event's (or interval's first) day.
    if (random.chance(0.3)) {
      const target = random.pick(statements);
      target.observedAt = `${start}T${random.pick(["00:00:00.000", "13:30:00.000", "23:59:59.999"])}Z`;
      features.add("observed-on-event-day");
    }
  }
  // ---- targeted scenarios at the rules' exact limits
  const incomeOriginals = statements.filter(
    (statement) =>
      statement.statementType === "INCOME" && statement.period !== "FY",
  );
  if (random.chance(0.3) && incomeOriginals.length > 2) {
    // Rule 3's positive path and its limits: a restatement by a re-base's ratio, the re-base
    // detected between the two observations (or at one of them), dated near the 30-day limit.
    const previous = random.pick(incomeOriginals.slice(1));
    const count = previous.values.weightedAverageShsOutDil;
    if (typeof count === "number" && count > 0) {
      const ratio = random.pick([2, 1.5, 0.1, 1.046, 3, 1.25]);
      const previousDay = previous.observedAt.slice(0, 10);
      const offset = random.pick([-31, -30, -29, -1, 0, 1, 5]);
      const eventDate = addDays(previousDay, offset);
      const restatedDay = addDays(
        previous.availableFromDate > previousDay
          ? previous.availableFromDate
          : previousDay,
        random.int(1, 60),
      );
      const restatedAt = instant(restatedDay, random);
      const detectedMode = random.pick([
        "between",
        "at-restated",
        "after-restated",
        "before-previous",
      ] as const);
      const detectedAt =
        detectedMode === "between"
          ? new Date(
              (Date.parse(previous.observedAt) + Date.parse(restatedAt)) / 2,
            ).toISOString()
          : detectedMode === "at-restated"
            ? restatedAt
            : detectedMode === "after-restated"
              ? new Date(Date.parse(restatedAt) + 1).toISOString()
              : new Date(Date.parse(previous.observedAt) - 1).toISOString();
      events.push({
        kind: "MEASURED",
        ...(random.chance(0.7)
          ? { effectiveDate: eventDate }
          : {
              effectiveFrom: addDays(eventDate, -random.int(1, 4)),
              effectiveTo: eventDate,
            }),
        priceRatio: String(ratio * random.pick([1, 1, 1.019, 1.0201, 0.98])),
        detectedAt,
      });
      statements.push({
        ...previous,
        availableFromDate: restatedDay,
        observedAt: restatedAt,
        contentHash: `h${(hashCounter += 1)}`,
        values: {
          ...previous.values,
          weightedAverageShsOutDil: Math.round(count * ratio),
        },
      });
      features.add(`explained-restatement-${detectedMode}-offset${offset}`);
    }
  }
  if (random.chance(0.25) && splits.length > 0) {
    // Matching limits: a re-base exactly 7 or 8 days from an entry, either way, dated or undated.
    const entry = random.pick(splits);
    const shift = random.pick([7, 8, -7, -8, 6]);
    const undated = random.chance(0.5);
    const ratio = random.pick([2, 1.046, 0.1, 1.3273]);
    events.push(
      undated
        ? shift > 0
          ? {
              kind: "MEASURED",
              effectiveFrom: addDays(entry.date, shift),
              effectiveTo: addDays(entry.date, shift + random.int(1, 5)),
              priceRatio: String(ratio),
              detectedAt: instant(addDays(entry.date, shift + 10), random),
            }
          : {
              kind: "MEASURED",
              effectiveFrom: addDays(entry.date, shift - random.int(1, 5)),
              effectiveTo: addDays(entry.date, shift),
              priceRatio: String(ratio),
              detectedAt: instant(addDays(entry.date, 10), random),
            }
        : {
            kind: "MEASURED",
            effectiveDate: addDays(entry.date, shift),
            priceRatio: String(ratio),
            detectedAt: instant(
              addDays(entry.date, Math.max(shift, 0) + 3),
              random,
            ),
          },
    );
    features.add(`entry-match-${undated ? "undated" : "dated"}${shift}`);
  }
  if (random.chance(0.15)) {
    // Several corporate actions inside one quarter, two of them with similar ratios.
    const quarter = random.pick(quarters);
    const base = addDays(quarter.fiscalDate, -random.int(10, 60));
    for (const [shift, ratio] of [
      [0, 2],
      [random.int(5, 20), 2.01],
      [random.int(21, 40), 1.046],
    ] as const) {
      events.push({
        kind: "MEASURED",
        effectiveDate: addDays(base, shift),
        priceRatio: String(ratio),
        detectedAt: instant(addDays(base, shift + random.int(1, 30)), random),
      });
    }
    features.add("several-events-one-quarter");
  }

  if (random.chance(0.1)) {
    const from = sessionAt(random.next() * 0.6);
    const to = addDays(from, random.int(0, 40));
    const bounded = random.chance(0.5);
    events.push({
      kind: "UNEXPLAINED",
      ...(bounded ? { effectiveFrom: from } : {}),
      effectiveTo: to,
      detectedAt: instant(addDays(to, random.int(1, 90)), random),
    });
    features.add(bounded ? "unexplained-bounded" : "unexplained-unbounded");
  }

  return {
    seed,
    security: { currency: "USD", statements, verifiedAt, events, splits },
    sessions,
    features: [...features].sort(),
  };
}
