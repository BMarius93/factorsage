import type {
  OracleSplitEntry,
  OracleValuationEvent,
  OracleValuationStatement,
} from "../oracle/valuation-ratios";
import {
  addDays,
  instant,
  isHoliday,
  monthEnd,
  Random,
  weekday,
  type GeneratedHistory,
} from "./generator";

/**
 * The second family of generated histories: one share-basis event and the provider's restatement
 * of it — the shapes rule 3 exists for, which the first family (`generator.ts`) produces only one
 * quarter at a time.
 *
 * One seed is one security with one event at `E`, a session in the middle of its history: a plain
 * split or reverse split, the same measured at a near-plain ratio, or a possible distribution.
 * Quarters ending on or after `E`, and any filed after it, report counts in the new units. Around it:
 *
 * - **the restatement:** the provider restates every stored earlier quarter's count by the split's
 *   ratio at once — from 25 days before `E` to 90 days after it — each restated revision available
 *   and observed when published; or never, or (a first load, after the event or in the month
 *   before it) before anything was stored;
 * - **revision chains:** later revisions of the newest quarters — another field, the same count, a
 *   count moved by up to 1 % or by exactly 2 %, or no count — and sometimes a count-less revision
 *   just before the restatement;
 * - **after the restatement:** sometimes a revision of the newest restated quarter observed once
 *   the re-base is known and its month has passed, or the provider taking the whole restatement back
 *   to the old counts;
 * - **a late-observed amendment:** sometimes a revision of the newest quarter dated from a filing
 *   before the restatement but first observed after it, so observation and availability disagree;
 * - **never restated:** sometimes, when the provider never restates, a revision of the newest quarter
 *   that ended before the event, still in the old units, observed after the event's month and its
 *   detection;
 * - **a first load before the event:** sometimes the first load comes in the month before the event,
 *   with the history already restated ahead of the ex-date;
 * - **the split list** lists `E` (the plain ratio, or a distribution's factor; usually labelled a
 *   split), occasionally a few days off, or not at all; the history is verified before `E` (a
 *   forward entry) or after it (history);
 * - **the re-base:** PR 1 measures it, dated or undated, detected up to 40 days after `E` — or at
 *   the first verification when that comes after `E` — or has not measured it yet. The stored closes
 *   before `E` are re-based exactly when it has (or when the provider had folded it before the
 *   first verification).
 *
 * Like the first family it encodes no valuation rule: whatever it produces, the reference and the
 * product must agree on.
 */
export function generateRestatementHistory(seed: number): GeneratedHistory {
  const random = new Random(seed * 7_919 + 104_729);
  const features = new Set<string>(["family-restatement"]);
  const quarterCount = random.int(8, 14);
  const startYear = random.int(2008, 2018);

  // ---- quarters and sessions
  const quarters: {
    fiscalYear: number;
    period: "Q1" | "Q2" | "Q3" | "Q4";
    fiscalDate: string;
    available: string;
  }[] = [];
  for (let index = 0; index < quarterCount; index += 1) {
    const quarterOfYear = (index % 4) + 1;
    const fiscalYear = startYear + Math.floor(index / 4);
    const fiscalDate = monthEnd(fiscalYear, quarterOfYear * 3);
    const lag = quarterOfYear === 4 ? random.int(45, 90) : random.int(25, 50);
    quarters.push({
      fiscalYear,
      period: `Q${quarterOfYear}` as "Q1" | "Q2" | "Q3" | "Q4",
      fiscalDate,
      available: addDays(fiscalDate, lag),
    });
  }
  const firstSession = addDays(quarters[0]!.fiscalDate, -random.int(30, 90));
  const lastSession = addDays(quarters.at(-1)!.available, random.int(120, 300));
  const dates: string[] = [];
  for (let date = firstSession; date <= lastSession; date = addDays(date, 1)) {
    const day = weekday(date);
    if (day !== 0 && day !== 6 && !isHoliday(date)) {
      dates.push(date);
    }
  }

  // ---- the event
  const eventIndex = Math.floor(dates.length * (0.35 + random.next() * 0.45));
  const eventDate = dates[eventIndex] as string;
  const shape = random.pick([
    "plain",
    "plain",
    "plain",
    "near-plain",
    "distribution",
  ] as const);
  features.add(`event-${shape}`);
  const [numerator, denominator] =
    shape === "distribution"
      ? random.pick([
          [1046, 1000],
          [1323, 1000],
          [523, 500],
          [131, 125],
        ] as const)
      : random.pick([
          [2, 1],
          [3, 1],
          [4, 1],
          [3, 2],
          [5, 4],
          [1, 2],
          [1, 10],
          [10, 1],
        ] as const);
  /** New shares per old share: the restatement's factor (1 for a distribution, whose count stays). */
  const shareFactor = shape === "distribution" ? 1 : numerator / denominator;
  /**
   * Stored close before ÷ new close: what PR 1 measures. Now and then it measures another ratio than
   * the split the provider restates the counts by — a re-base of another ratio, which explains
   * nothing.
   */
  const mismatched = shape !== "distribution" && random.chance(0.15);
  if (mismatched) {
    features.add("mismatched-rebase");
  }
  const priceRatio = mismatched
    ? random.pick([3, 1.5, 0.5, 4, 1.25].filter((r) => r !== shareFactor))
    : shape === "near-plain"
      ? (numerator / denominator) *
        (1 + random.pick([0.004, -0.004, 0.0049, -0.0049]))
      : numerator / denominator;

  // ---- verification and the re-base
  const verifiedMode = random.pick([
    "before-event",
    "before-event",
    "before-event",
    "after-event",
    "end",
  ] as const);
  features.add(`verified-${verifiedMode}`);
  const verifiedAt =
    verifiedMode === "before-event"
      ? instant(addDays(eventDate, -random.int(3, 60)), random)
      : verifiedMode === "after-event"
        ? instant(addDays(eventDate, random.int(1, 60)), random)
        : instant(addDays(lastSession, random.int(0, 20)), random);
  const verifiedBeforeEvent = verifiedAt.slice(0, 10) < eventDate;
  const measuredMode = verifiedBeforeEvent
    ? random.pick(["dated", "dated", "undated", "none"] as const)
    : random.pick(["at-verification", "none"] as const);
  features.add(`measured-${measuredMode}`);
  const events: OracleValuationEvent[] = [];
  if (measuredMode === "dated" || measuredMode === "at-verification") {
    events.push({
      kind: "MEASURED",
      effectiveDate: eventDate,
      priceRatio: String(priceRatio),
      detectedAt:
        measuredMode === "at-verification"
          ? verifiedAt
          : instant(
              addDays(eventDate, random.pick([0, 1, 2, 5, 10, 20])),
              random,
            ),
    });
  } else if (measuredMode === "undated") {
    // Between two reads: after the last session certainly before it, and no later than the newest
    // session the provider had published, which the detection comes after.
    const effectiveTo =
      dates[Math.min(dates.length - 1, eventIndex + random.int(0, 4))]!;
    events.push({
      kind: "MEASURED",
      effectiveFrom: dates[Math.max(0, eventIndex - random.int(1, 4))]!,
      effectiveTo,
      priceRatio: String(priceRatio),
      detectedAt: instant(addDays(effectiveTo, random.int(0, 36)), random),
    });
  }
  // The stored closes before the event are on the new basis once the re-base was measured, or when
  // the provider had folded it before the first verification stored the history.
  const rebased = measuredMode !== "none" || !verifiedBeforeEvent;
  if (rebased) {
    features.add("closes-rebased");
  }

  // ---- closes
  let traded = random.pick([3.4, 27.5, 118.2, 640]);
  const sessions = dates.map((date, index) => {
    traded = traded * Math.exp((random.next() - 0.5) * 0.05);
    if (index === eventIndex) {
      traded /= priceRatio;
    }
    const stored = rebased && index < eventIndex ? traded / priceRatio : traded;
    return { date, close: stored.toFixed(4) };
  });

  // ---- statements
  const firstLoad = random.chance(0.2);
  const firstLoadAt = instant(addDays(lastSession, random.int(1, 30)), random);
  if (firstLoad) {
    features.add("first-load");
  }
  // The shapes added for the owner's rulings on the second review draw from a second stream, so
  // every history drawn before them stays as it was.
  const extra = new Random(seed * 6_151 + 3_571);
  // A first load in the month before the event, the provider's history already restated ahead of the
  // ex-date (the review's MAJOR-3): every count in the new units while the closes before the event
  // are still in the old. Quarters filed after the load are observed when filed.
  const loadedBeforeEvent = firstLoad && extra.chance(0.35);
  const loadAt = loadedBeforeEvent
    ? instant(addDays(eventDate, -extra.int(1, 30)), extra)
    : firstLoadAt;
  if (loadedBeforeEvent) {
    features.add("first-load-before-event");
  }
  const level = 4 * random.int(5_000_000, 900_000_000);
  let revenue = 10 ** random.int(6, 9) * (1 + random.next() * 3);
  const statements: OracleValuationStatement[] = [];
  let hash = 0;
  const income: OracleValuationStatement[] = [];
  quarters.forEach((quarter) => {
    revenue *= 1 + (random.next() - 0.4) * 0.08;
    const newUnits =
      quarter.fiscalDate >= eventDate ||
      quarter.available > eventDate ||
      firstLoad;
    const count = Math.round(
      level * (newUnits ? shareFactor : 1) * (1 + (random.next() - 0.5) * 0.01),
    );
    const observedAt = !firstLoad
      ? instant(addDays(quarter.available, random.int(0, 2)), random)
      : quarter.available <= loadAt.slice(0, 10)
        ? loadAt
        : instant(addDays(quarter.available, extra.int(0, 2)), extra);
    const common = {
      fiscalDate: quarter.fiscalDate,
      fiscalYear: quarter.fiscalYear,
      period: quarter.period,
      reportedCurrency: "USD",
      availableFromDate: quarter.available,
      observedAt,
    };
    const netIncome = Math.round(revenue * (0.04 + random.next() * 0.12));
    const row: OracleValuationStatement = {
      ...common,
      statementType: "INCOME",
      contentHash: `r${(hash += 1)}`,
      values: {
        revenue: Math.round(revenue),
        netIncome,
        ebitda: Math.round(revenue * (0.1 + random.next() * 0.2)),
        weightedAverageShsOutDil: count,
        weightedAverageShsOut: Math.round(count * 0.98),
        epsDiluted: netIncome / count,
      },
    };
    income.push(row);
    statements.push(row, {
      ...common,
      statementType: "BALANCE_SHEET",
      contentHash: `r${(hash += 1)}`,
      values: {
        totalStockholdersEquity: Math.round(revenue * (1 + random.next() * 2)),
        netDebt: Math.round(revenue * (random.next() * 2 - 0.5)),
      },
    });
    const operating = Math.round(revenue * (0.1 + random.next() * 0.15));
    statements.push({
      ...common,
      statementType: "CASH_FLOW",
      contentHash: `r${(hash += 1)}`,
      values: {
        operatingCashFlow: operating,
        capitalExpenditure: -Math.round(revenue * random.next() * 0.08),
      },
    });
  });

  /** The index of the newest quarter filed by `day`, or -1. */
  const newestFiledBy = (day: string): number => {
    let newest = -1;
    quarters.forEach((quarter, index) => {
      if (quarter.available <= day) {
        newest = index;
      }
    });
    return newest;
  };
  /** The newest revision of an Income quarter observed by `at` (instant), in observation order. */
  const latestBy = (
    quarterIndex: number,
    at: string,
  ): OracleValuationStatement | undefined => {
    const quarter = quarters[quarterIndex]!;
    return statements
      .filter(
        (statement) =>
          statement.statementType === "INCOME" &&
          statement.fiscalYear === quarter.fiscalYear &&
          statement.period === quarter.period &&
          statement.observedAt <= at,
      )
      .sort((a, b) =>
        a.observedAt === b.observedAt
          ? a.contentHash.localeCompare(b.contentHash)
          : a.observedAt.localeCompare(b.observedAt),
      )
      .at(-1);
  };
  const revise = (
    base: OracleValuationStatement,
    day: string,
    at: string,
    values: Record<string, unknown>,
  ) => {
    statements.push({
      ...base,
      availableFromDate:
        day > base.availableFromDate ? day : base.availableFromDate,
      observedAt: at,
      contentHash: `r${(hash += 1)}`,
      values,
    });
  };

  // ---- the provider's restatement of the old-unit counts, and the chains after it
  const restates = !firstLoad && shareFactor !== 1 && random.chance(0.8);
  const restateOffset = random.pick([
    -25, -10, -3, 0, 4, 15, 29, 30, 31, 33, 35, 38, 40, 45, 50, 60, 90,
  ]);
  const restateDay = addDays(eventDate, restateOffset);
  const restatedAt = instant(restateDay, random);
  const restatedQuarters: number[] = [];
  if (restates) {
    features.add(`restated-offset${restateOffset}`);
    if (random.chance(0.2)) {
      // A count-less revision of the newest quarter just before the restatement.
      const missingDay = addDays(restateDay, -random.int(1, 10));
      const missingAt = instant(missingDay, random);
      const newest = newestFiledBy(missingDay);
      const base = newest >= 0 ? latestBy(newest, missingAt) : undefined;
      if (base !== undefined && base.observedAt < missingAt) {
        const values: Record<string, unknown> = {
          ...base.values,
          grossProfit: 1,
        };
        delete values.weightedAverageShsOutDil;
        revise(base, missingDay, missingAt, values);
        features.add("count-less-predecessor");
      }
    }
    quarters.forEach((quarter, index) => {
      // Quarters filed after the event already report the new units; those not yet filed are not
      // the provider's to restate.
      if (
        quarter.fiscalDate >= eventDate ||
        quarter.available > eventDate ||
        quarter.available > restateDay
      ) {
        return;
      }
      const base = latestBy(index, restatedAt);
      if (base === undefined || base.observedAt >= restatedAt) {
        return;
      }
      const original = income[index]!.values.weightedAverageShsOutDil as number;
      restatedQuarters.push(index);
      revise(base, restateDay, restatedAt, {
        ...base.values,
        weightedAverageShsOutDil: Math.round(original * shareFactor),
        weightedAverageShsOut: Math.round(original * shareFactor * 0.98),
      });
    });
  } else {
    features.add(firstLoad ? "restated-before-load" : "never-restated");
  }
  const chains = random.pick([0, 0, 1, 1, 2, 3]);
  for (let link = 0; link < chains; link += 1) {
    const day = addDays(restates ? restateDay : eventDate, random.int(1, 40));
    const at = instant(day, random);
    const newest = newestFiledBy(day);
    const target = newest - random.int(0, 1);
    if (target < 0) {
      continue;
    }
    const base = latestBy(target, at);
    if (base === undefined || base.observedAt >= at) {
      continue;
    }
    const kind = random.pick([
      "other-field",
      "same-count",
      "small-count",
      "exact-2pct",
      "no-count",
    ] as const);
    const values: Record<string, unknown> = { ...base.values };
    const count = values.weightedAverageShsOutDil;
    switch (kind) {
      case "other-field":
        values.grossProfit = random.int(1, 1_000);
        break;
      case "same-count":
        values.epsDiluted = (values.epsDiluted as number) * 1.001;
        break;
      case "small-count":
        if (typeof count === "number") {
          values.weightedAverageShsOutDil = Math.round(
            count * (1 + random.pick([0.01, -0.01, 0.004])),
          );
        }
        break;
      case "exact-2pct":
        if (typeof count === "number") {
          const base50 = Math.max(50, Math.round(count / 50) * 50);
          values.weightedAverageShsOutDil = (base50 / 50) * 51;
        }
        break;
      case "no-count":
        delete values.weightedAverageShsOutDil;
        break;
    }
    revise(base, day, at, values);
    features.add(`chain-${kind}`);
  }

  // ---- the split list
  const splits: OracleSplitEntry[] = [];
  if (random.chance(0.7)) {
    const offset = random.chance(0.15) ? random.pick([-3, -1, 2, 3]) : 0;
    splits.push({
      date: addDays(eventDate, offset),
      numerator: String(numerator),
      denominator: String(denominator),
      label:
        shape === "distribution"
          ? random.pick(["stock-split", "spin-off"] as const)
          : random.chance(0.9)
            ? "stock-split"
            : random.pick(["spin-off", null] as const),
    });
    features.add(offset === 0 ? "entry-listed" : "entry-listed-off-by-days");
  } else {
    features.add("entry-unlisted");
  }

  // ---- after the restatement: a revision observed once the re-base is known and its month has
  // passed, or the provider taking the whole restatement back. Drawn last, so the history before it
  // is the same as without it.
  const late = restatedQuarters.length > 0 && random.chance(0.7);
  if (late) {
    const detected = events[0]?.detectedAt.slice(0, 10);
    const settled = addDays(eventDate, random.pick([20, 31, 45]));
    const after = [restateDay, settled, detected ?? settled].sort().at(-1)!;
    // While the newest restated quarter is still the latest, when the next filing leaves room.
    const newest = restatedQuarters.at(-1)!;
    const next = quarters[newest + 1]?.available;
    const room =
      next !== undefined && next > after
        ? Math.round((Date.parse(next) - Date.parse(after)) / 86_400_000) - 1
        : 25;
    const day = addDays(after, random.int(1, Math.max(1, Math.min(25, room))));
    const at = instant(day, random);
    if (random.chance(0.7)) {
      const base = latestBy(newest, at);
      if (base !== undefined && base.observedAt < at) {
        revise(base, day, at, {
          ...base.values,
          grossProfit: random.int(1, 1_000),
        });
        features.add("late-revision-after-rebase");
      }
    } else {
      for (const index of restatedQuarters) {
        const base = latestBy(index, at);
        const original = income[index]!.values
          .weightedAverageShsOutDil as number;
        if (base !== undefined && base.observedAt < at) {
          revise(base, day, at, {
            ...base.values,
            weightedAverageShsOutDil: original,
            weightedAverageShsOut: Math.round(original * 0.98),
          });
        }
      }
      features.add("restatement-taken-back");
    }
  }

  // ---- a late-observed amendment: a revision of the newest quarter that the loader dates from a
  // filing before the restatement (or the event) but first observes later, often after the
  // re-base's detection, so the order of observation and the order of availability disagree. In the
  // new units or the old. Drawn last, like the shapes above.
  // Only where no late shape was drawn, so each keeps its own histories.
  if (!late && random.chance(0.5)) {
    const pivot = restates ? restateDay : eventDate;
    const filedDay = addDays(pivot, -random.int(1, 10));
    const newest = newestFiledBy(filedDay);
    const available = addDays(filedDay, 1);
    const at = instant(addDays(pivot, random.int(1, 45)), random);
    const base = newest >= 0 ? latestBy(newest, at) : undefined;
    if (
      base !== undefined &&
      available > quarters[newest]!.available &&
      base.observedAt < at
    ) {
      const original = income[newest]!.values
        .weightedAverageShsOutDil as number;
      statements.push({
        ...base,
        availableFromDate: available,
        observedAt: at,
        contentHash: `r${(hash += 1)}`,
        values: {
          ...base.values,
          grossProfit: random.int(1, 1_000),
          weightedAverageShsOutDil: random.chance(0.5)
            ? Math.round(original * shareFactor)
            : original,
        },
      });
      features.add("late-observed-amendment");
    }
  }

  // ---- the provider never restating (the review's MAJOR-1): a revision of the newest quarter that
  // ended before the event, still in the old units, observed once the event is known and its month
  // has passed, while that quarter is still the latest. From the second stream.
  if (!restates && !firstLoad && shareFactor !== 1 && extra.chance(0.5)) {
    let newest = -1;
    quarters.forEach((quarter, index) => {
      if (quarter.fiscalDate < eventDate && quarter.available <= eventDate) {
        newest = index;
      }
    });
    const detected = events[0]?.detectedAt.slice(0, 10);
    const settled = addDays(eventDate, extra.pick([31, 35, 45]));
    const after = [settled, detected ?? settled].sort().at(-1)!;
    const next = quarters[newest + 1]?.available;
    const room =
      next !== undefined && next > after
        ? Math.round((Date.parse(next) - Date.parse(after)) / 86_400_000) - 1
        : 25;
    if (newest >= 0 && room > 0) {
      const day = addDays(after, extra.int(1, Math.min(25, room)));
      const at = instant(day, extra);
      const base = latestBy(newest, at);
      if (base !== undefined && base.observedAt < at) {
        revise(base, day, at, {
          ...base.values,
          grossProfit: extra.int(1, 1_000),
        });
        features.add("late-revision-never-restated");
      }
    }
  }

  return {
    seed,
    security: { currency: "USD", statements, verifiedAt, events, splits },
    sessions,
    features: [...features].sort(),
  };
}
