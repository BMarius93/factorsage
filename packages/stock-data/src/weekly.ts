import type {
  DailyPrice,
  LocalDate,
  MovingAverageType,
  SecurityId,
} from "@intrinsic/domain";
import { addDays, compareDates } from "./dates.js";
import { movingAverage } from "./technicals.js";

export type WeeklyPrice = {
  securityId: SecurityId;
  weekStartDate: LocalDate;
  weekEndDate: LocalDate;
  eligibleDate: LocalDate;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/**
 * Completed-week indicator value.
 *
 * This is a calculation output, not a storage shape. Weekly indicators are never persisted at
 * weekly cadence: the latest eligible value is carried forward onto every trading day in
 * `DailyDerivedState`.
 */
export type WeeklyTechnical = {
  securityId: SecurityId;
  weekStartDate: LocalDate;
  eligibleDate: LocalDate;
  type: MovingAverageType;
  period: number;
  value: number;
};

export type WeeklyHistoryContext = {
  historyStart: LocalDate;
  historyStartOrigin: "HORIZON" | "LISTING";
};

export function startOfIsoWeek(value: LocalDate): LocalDate {
  const date = new Date(`${value}T00:00:00.000Z`);
  const day = date.getUTCDay();
  return addDays(value, -(day === 0 ? 6 : day - 1));
}

export function aggregateCompletedWeeks(
  prices: readonly DailyPrice[],
  asOf: LocalDate,
  history?: WeeklyHistoryContext,
): WeeklyPrice[] {
  const currentWeekStart = startOfIsoWeek(asOf);
  const artificialFirstWeek =
    history?.historyStartOrigin === "HORIZON" &&
    startOfIsoWeek(history.historyStart) !== history.historyStart
      ? startOfIsoWeek(history.historyStart)
      : undefined;
  const groups = new Map<LocalDate, DailyPrice[]>();
  for (const price of [...prices].sort((left, right) =>
    left.date.localeCompare(right.date),
  )) {
    const weekStart = startOfIsoWeek(price.date);
    if (
      compareDates(weekStart, currentWeekStart) >= 0 ||
      weekStart === artificialFirstWeek
    ) {
      continue;
    }
    const group = groups.get(weekStart) ?? [];
    group.push(price);
    groups.set(weekStart, group);
  }

  return [...groups.entries()].map(([weekStartDate, rows]) => {
    const first = rows[0];
    const last = rows.at(-1);
    if (!first || !last) {
      throw new Error("Weekly aggregation received an empty week");
    }
    return {
      securityId: first.securityId,
      weekStartDate,
      weekEndDate: last.date,
      eligibleDate: addDays(weekStartDate, 7),
      open: first.open,
      high: Math.max(...rows.map((row) => row.high)),
      low: Math.min(...rows.map((row) => row.low)),
      close: last.close,
      volume: rows.reduce((sum, row) => sum + row.volume, 0),
    };
  });
}

export function calculateWeeklyMovingAverage(
  bars: readonly WeeklyPrice[],
  type: MovingAverageType,
  period: number,
): WeeklyTechnical[] {
  const ascending = [...bars].sort((left, right) =>
    left.weekStartDate.localeCompare(right.weekStartDate),
  );
  const values = movingAverage(
    ascending.map((bar) => bar.close),
    type,
    period,
  );
  return ascending.flatMap((bar, index) => {
    const value = values[index];
    return value === undefined
      ? []
      : [
          {
            securityId: bar.securityId,
            weekStartDate: bar.weekStartDate,
            eligibleDate: bar.eligibleDate,
            type,
            period,
            value,
          },
        ];
  });
}

export function latestCompletedWeeklyBar(
  bars: readonly WeeklyPrice[],
  asOf: LocalDate,
): WeeklyPrice | undefined {
  return [...bars]
    .filter((bar) => compareDates(bar.eligibleDate, asOf) <= 0)
    .sort((left, right) =>
      right.eligibleDate.localeCompare(left.eligibleDate),
    )[0];
}
