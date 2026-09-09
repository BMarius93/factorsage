import type { LocalDate } from "@intrinsic/domain";
import { describe, expect, it } from "vitest";
import {
  MOVING_AVERAGE_COLUMN,
  benchmarkSeries,
  buyLevel,
  definitionOf,
  executionInput,
  finalExit,
  frameOf,
  gainAboveSignal,
  lossAboveSignal,
  priceAboveSignal,
  priceBelowSignal,
  priceCrossesAboveMovingAverageSignal,
  securityInput,
  sellLevel,
  simulateBacktestByYear,
} from "./backtest.test-helper.js";
import { BacktestExecutionError, createBacktestSimulation } from "./simulation.js";
import { simulateBacktest } from "./simulate.js";
import type { BacktestCheckpoint } from "./types.js";

const ALWAYS = 0;

/** Weekday dates across `[from, to]`, standing in for the pinned US-equity execution calendar. */
function marketDates(from: LocalDate, to: LocalDate): LocalDate[] {
  const dates: LocalDate[] = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (cursor <= end) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) {
      dates.push(cursor.toISOString().slice(0, 10));
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/** A deterministic but non-monotonic price path, so exits, drawdowns and top-ups all fire. */
function wavyCloses(dates: readonly LocalDate[], base: number): number[] {
  return dates.map(
    (_date, index) =>
      base +
      Math.sin(index / 9) * base * 0.3 +
      Math.cos(index / 23) * base * 0.15 +
      index * 0.02,
  );
}

describe("annual window equivalence", () => {
  it("produces the same trades, positions, cash, curve and summary as one continuous execution", async () => {
    const calendar = marketDates("2000-05-10", "2004-03-19");
    const aaa = frameOf({
      symbol: "AAA",
      dates: calendar,
      closes: wavyCloses(calendar, 100),
    });
    // Listed part-way through the run and stops trading before it ends, so the equivalence covers a
    // security that appears mid-window and one whose history simply runs out.
    const bbbDates = calendar.filter(
      (date) => date >= "2001-07-02" && date <= "2003-04-30",
    );
    const bbb = frameOf({
      symbol: "BBB",
      dates: bbbDates,
      closes: wavyCloses(bbbDates, 55),
    });

    const input = executionInput({
      definition: definitionOf({
        buyLevels: [
          buyLevel("b25", 25, priceAboveSignal(ALWAYS)),
          buyLevel("b75", 75, priceBelowSignal(90)),
        ],
        sellLevels: [sellLevel("s50", 50, gainAboveSignal(12))],
        finalExit: finalExit("fx", lossAboveSignal(20)),
      }),
      securities: [securityInput(aaa), securityInput(bbb)],
      benchmark: benchmarkSeries({
        dates: calendar,
        closes: wavyCloses(calendar, 1_400),
      }),
      executionCalendar: calendar,
      startDate: "2000-05-10",
      endDate: "2004-03-19",
      initialCapital: 100_000,
      monthlyContribution: 1_000,
      maximumPositions: 4,
    });

    const continuous = await simulateBacktest(input);
    const windowed = await simulateBacktestByYear(input);

    // The fixture must actually exercise the boundary it claims to test.
    expect(continuous.summary.tradingDays).toBeGreaterThan(900);
    expect(continuous.trades.length).toBeGreaterThan(20);

    expect(windowed.trades).toEqual(continuous.trades);
    expect(windowed.positions).toEqual(continuous.positions);
    expect(windowed.summary).toEqual(continuous.summary);
    expect(windowed.equity).toEqual(continuous.equity);
  });

  it("keeps settled BUY levels, fired SELL levels and average cost identical across every year", async () => {
    const calendar = marketDates("2010-01-04", "2013-06-28");
    const frame = frameOf({
      symbol: "AAA",
      dates: calendar,
      closes: wavyCloses(calendar, 80),
    });
    const input = executionInput({
      definition: definitionOf({
        buyLevels: [
          buyLevel("b50", 50, priceBelowSignal(80)),
          buyLevel("b100", 100, priceBelowSignal(60)),
        ],
        sellLevels: [
          sellLevel("s25", 25, gainAboveSignal(10)),
          sellLevel("s50", 50, gainAboveSignal(25)),
        ],
      }),
      securities: [securityInput(frame)],
      executionCalendar: calendar,
      startDate: "2010-01-04",
      endDate: "2013-06-28",
      monthlyContribution: 500,
      maximumPositions: 2,
    });

    const continuous = await simulateBacktest(input);
    const windowed = await simulateBacktestByYear(input);

    expect(windowed.trades.map((trade) => trade.levelId)).toEqual(
      continuous.trades.map((trade) => trade.levelId),
    );
    expect(windowed.trades.map((trade) => trade.sequence)).toEqual(
      continuous.trades.map((trade) => trade.sequence),
    );
    expect(windowed.summary.finalCash).toBe(continuous.summary.finalCash);
    expect(windowed.positions.map((position) => position.averageCost)).toEqual(
      continuous.positions.map((position) => position.averageCost),
    );
  });
});

describe("year-boundary Trigger context", () => {
  it("fires a crossing on the first eligible day of a new year, exactly once", async () => {
    const dates: LocalDate[] = [
      "2000-12-27",
      "2000-12-28",
      "2000-12-29",
      "2001-01-02",
      "2001-01-03",
    ];
    // Price sits below the moving average through December and crosses it on the first session of
    // January: the crossing is only decidable from the previous year's row.
    const frame = frameOf({
      symbol: "AAA",
      dates,
      closes: [95, 94, 96, 104, 106],
      columns: { [MOVING_AVERAGE_COLUMN]: [100, 100, 100, 100, 100] },
    });
    const input = executionInput({
      definition: definitionOf({
        buyLevels: [
          buyLevel("b100", 100, priceCrossesAboveMovingAverageSignal()),
        ],
      }),
      securities: [securityInput(frame)],
      executionCalendar: dates,
      startDate: "2000-12-27",
      endDate: "2001-01-03",
      maximumPositions: 1,
    });

    const windowed = await simulateBacktestByYear(input);

    expect(windowed.trades).toHaveLength(1);
    expect(windowed.trades[0]?.date).toBe("2001-01-02");
    expect(windowed.trades).toEqual((await simulateBacktest(input)).trades);
  });

  it("reads the previous eligible value even when it is months old, not merely days", async () => {
    // The security's last 2000 session is 2000-09-15 and its next is 2001-02-01. No fixed
    // calendar-day context window before 2001-01-01 could contain that row; the engine carries it.
    const dates: LocalDate[] = ["2000-09-14", "2000-09-15", "2001-02-01"];
    const frame = frameOf({
      symbol: "AAA",
      dates,
      closes: [90, 92, 130],
      columns: { [MOVING_AVERAGE_COLUMN]: [100, 100, 100] },
    });
    const calendar = marketDates("2000-09-14", "2001-02-01");
    const input = executionInput({
      definition: definitionOf({
        buyLevels: [
          buyLevel("b100", 100, priceCrossesAboveMovingAverageSignal()),
        ],
      }),
      securities: [securityInput(frame)],
      executionCalendar: calendar,
      startDate: "2000-09-14",
      endDate: "2001-02-01",
      maximumPositions: 1,
    });

    const windowed = await simulateBacktestByYear(input);

    expect(windowed.trades).toHaveLength(1);
    expect(windowed.trades[0]?.date).toBe("2001-02-01");
    expect(windowed.trades).toEqual((await simulateBacktest(input)).trades);
  });

  it("never re-simulates the prior year's context row", async () => {
    const dates = marketDates("2000-12-20", "2001-01-15");
    const frame = frameOf({
      symbol: "AAA",
      dates,
      closes: dates.map(() => 100),
    });
    const input = executionInput({
      definition: definitionOf({
        buyLevels: [buyLevel("b25", 25, priceAboveSignal(ALWAYS))],
      }),
      securities: [securityInput(frame)],
      executionCalendar: dates,
      startDate: "2000-12-20",
      endDate: "2001-01-15",
      monthlyContribution: 1_000,
      maximumPositions: 4,
    });

    const windowed = await simulateBacktestByYear(input);

    // One equity point per execution-calendar date, and no duplicated date: a context row is read,
    // never replayed.
    expect(windowed.equity).toHaveLength(dates.length);
    expect(windowed.equity.map((point) => point.date)).toEqual(dates);
    expect(new Set(windowed.equity.map((point) => point.date)).size).toBe(
      dates.length,
    );
  });
});

describe("open-position continuity across a year boundary", () => {
  it("carries shares, average cost, epoch, settled levels and the Trigger's previous value", async () => {
    const dates = marketDates("2000-12-01", "2001-02-28");
    const frame = frameOf({
      symbol: "AAA",
      dates,
      closes: dates.map((date) => (date < "2001-01-01" ? 100 : 130)),
    });
    const input = executionInput({
      definition: definitionOf({
        buyLevels: [buyLevel("b100", 100, priceBelowSignal(110))],
        sellLevels: [sellLevel("s50", 50, gainAboveSignal(20))],
      }),
      securities: [securityInput(frame)],
      executionCalendar: dates,
      startDate: "2000-12-01",
      endDate: "2001-02-28",
      maximumPositions: 1,
    });

    const continuous = await simulateBacktest(input);
    const windowed = await simulateBacktestByYear(input);

    // Bought in December, partially sold in January: the position is genuinely open across the
    // boundary and its January decision depends on the December basis.
    expect(windowed.trades[0]?.date.startsWith("2000-12")).toBe(true);
    expect(windowed.trades[1]?.action).toBe("SELL");
    expect(windowed.trades[1]?.date.startsWith("2001-01")).toBe(true);
    expect(windowed.trades).toEqual(continuous.trades);
    expect(windowed.positions).toEqual(continuous.positions);
  });
});

describe("contributions across a year boundary", () => {
  it("deposits each month exactly once, on the same dates as a continuous run", async () => {
    const calendar = marketDates("2000-11-15", "2002-02-15").filter(
      (date) => date !== "2001-01-01" && date !== "2002-01-01",
    );
    const frame = frameOf({
      symbol: "AAA",
      dates: calendar,
      closes: calendar.map(() => 100),
    });
    const input = executionInput({
      // No BUY ever matches, so every change in invested capital is a contribution.
      definition: definitionOf({
        buyLevels: [buyLevel("b100", 100, priceAboveSignal(1_000))],
      }),
      securities: [securityInput(frame)],
      executionCalendar: calendar,
      startDate: "2000-11-15",
      endDate: "2002-02-15",
      initialCapital: 100_000,
      monthlyContribution: 1_000,
      maximumPositions: 1,
    });

    const continuous = await simulateBacktest(input);
    const windowed = await simulateBacktestByYear(input);

    const depositDates = (result: typeof windowed): LocalDate[] => {
      const dates: LocalDate[] = [];
      let previous = 0;
      for (const point of result.equity) {
        if (previous !== 0 && point.investedCapital > previous) {
          dates.push(point.date);
        }
        previous = point.investedCapital;
      }
      return dates;
    };

    const deposits = depositDates(windowed);
    expect(deposits).toEqual(depositDates(continuous));
    // Nov 2000 is the opening month, so 15 later months each deposit once.
    expect(deposits).toHaveLength(15);
    expect(new Set(deposits.map((date) => date.slice(0, 7))).size).toBe(15);
    // The January deposit lands on the first *eligible* day of January — New Year's Day is not one
    // — and never on the last day of December.
    expect(deposits.filter((date) => date.startsWith("2001-01"))).toEqual([
      "2001-01-02",
    ]);
    expect(windowed.summary.investedCapital).toBe(
      continuous.summary.investedCapital,
    );
  });
});

describe("absolute comparison scenarios", () => {
  const calendar = marketDates("2020-01-01", "2021-12-31");

  it("funds Strategy, S&P 500 and Cash with the same external cash flows", async () => {
    const frame = frameOf({
      symbol: "AAA",
      dates: calendar,
      closes: calendar.map(() => 50),
    });
    const input = executionInput({
      // Never buys, so the Strategy holds only cash and all three scenarios start from the same
      // capital with nothing invested by the Strategy itself.
      definition: definitionOf({
        buyLevels: [buyLevel("b100", 100, priceAboveSignal(1_000))],
      }),
      securities: [securityInput(frame)],
      benchmark: benchmarkSeries({
        dates: calendar,
        // A flat benchmark isolates the cash flows from the price path.
        closes: calendar.map(() => 100),
      }),
      executionCalendar: calendar,
      startDate: "2020-01-01",
      endDate: "2021-12-31",
      initialCapital: 100_000,
      monthlyContribution: 1_000,
      maximumPositions: 1,
    });

    const result = await simulateBacktestByYear(input);
    const last = result.equity[result.equity.length - 1]!;

    // 24 months, the first funded by the initial capital: 23 contributions.
    expect(last.cashBaselineValue).toBeCloseTo(123_000, 6);
    expect(last.totalValue).toBeCloseTo(123_000, 6);
    expect(last.benchmarkValue).toBeCloseTo(123_000, 6);
    for (const point of result.equity) {
      expect(point.cashBaselineValue).toBeCloseTo(point.investedCapital, 6);
      expect(point.benchmarkValue).toBeCloseTo(point.cashBaselineValue, 6);
    }
  });

  it("keeps the Cash baseline independent of the Strategy's uninvested cash", async () => {
    const frame = frameOf({
      symbol: "AAA",
      dates: calendar,
      closes: calendar.map(() => 20),
    });
    const input = executionInput({
      definition: definitionOf({
        buyLevels: [buyLevel("b100", 100, priceAboveSignal(ALWAYS))],
      }),
      securities: [securityInput(frame)],
      executionCalendar: calendar,
      startDate: "2020-01-01",
      endDate: "2021-12-31",
      initialCapital: 100_000,
      monthlyContribution: 1_000,
      // One position taking the whole full-position budget, so most of the cash is invested.
      maximumPositions: 1,
    });

    const result = await simulateBacktestByYear(input);
    const last = result.equity[result.equity.length - 1]!;

    expect(last.cashBaselineValue).toBeCloseTo(123_000, 6);
    // The Strategy put nearly everything to work, so its uninvested cash is nothing like the
    // Cash line — which is exactly the confusion the separate name exists to prevent.
    expect(last.cash).toBeLessThan(5_000);
    expect(last.positionsValue).toBeGreaterThan(100_000);
    expect(last.totalValue).toBeCloseTo(last.cash + last.positionsValue, 6);
  });

  it("buys benchmark shares with each contribution instead of scaling one growth index", async () => {
    const frame = frameOf({
      symbol: "AAA",
      dates: calendar,
      closes: calendar.map(() => 50),
    });
    // The benchmark halves at the start of 2021, so a contribution made then buys twice the shares
    // an opening-price index would credit it with.
    const closes = calendar.map((date) => (date < "2021-01-01" ? 100 : 50));
    const input = executionInput({
      definition: definitionOf({
        buyLevels: [buyLevel("b100", 100, priceAboveSignal(1_000))],
      }),
      securities: [securityInput(frame)],
      benchmark: benchmarkSeries({ dates: calendar, closes }),
      executionCalendar: calendar,
      startDate: "2020-01-01",
      endDate: "2021-12-31",
      initialCapital: 100_000,
      monthlyContribution: 1_000,
      maximumPositions: 1,
    });

    const result = await simulateBacktestByYear(input);
    const last = result.equity[result.equity.length - 1]!;

    // 100,000 + 11 contributions at 100 = 1,110 shares; 12 more at 50 = 240 shares.
    const expectedShares = 100_000 / 100 + (11 * 1_000) / 100 + (12 * 1_000) / 50;
    expect(last.benchmarkValue).toBeCloseTo(expectedShares * 50, 6);

    // The rejected implementation: contributed capital times the benchmark's growth index.
    const growthIndexValue = last.cashBaselineValue * (50 / 100);
    expect(last.benchmarkValue).not.toBeCloseTo(growthIndexValue, 2);

    // And the existing percentage-growth methodology is untouched by any of it.
    expect(last.benchmarkIndex).toBeCloseTo(0.5, 10);
    expect(result.summary.benchmarkReturnPercent).toBeCloseTo(-50, 10);
  });

  it("reports no benchmark value on a date the benchmark cannot be priced", async () => {
    const frame = frameOf({
      symbol: "AAA",
      dates: calendar,
      closes: calendar.map(() => 50),
    });
    const priced = calendar.filter((date) => date >= "2021-01-01");
    const input = executionInput({
      definition: definitionOf({
        buyLevels: [buyLevel("b100", 100, priceAboveSignal(1_000))],
      }),
      securities: [securityInput(frame)],
      benchmark: benchmarkSeries({
        dates: priced,
        closes: priced.map(() => 100),
      }),
      executionCalendar: calendar,
      startDate: "2020-01-01",
      endDate: "2021-12-31",
      initialCapital: 100_000,
      monthlyContribution: 1_000,
      maximumPositions: 1,
    });

    const result = await simulateBacktestByYear(input);

    expect(result.equity[0]?.benchmarkValue).toBeNull();
    // Capital that arrived before the benchmark could be priced is held, not discarded, so the
    // scenario stays funded with exactly the cash flows the Strategy received.
    const first2021 = result.equity.find((point) => point.date >= "2021-01-01");
    expect(first2021?.benchmarkValue).toBeCloseTo(
      first2021!.cashBaselineValue,
      6,
    );
  });
});

describe("progressive exposure and failure semantics", () => {
  it("checkpoints a completed year carrying the whole computed prefix of the curve", async () => {
    const calendar = marketDates("2000-01-03", "2002-12-31");
    const frame = frameOf({
      symbol: "AAA",
      dates: calendar,
      closes: wavyCloses(calendar, 100),
    });
    const checkpoints: BacktestCheckpoint[] = [];

    await simulateBacktestByYear(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b50", 50, priceAboveSignal(ALWAYS))],
        }),
        securities: [securityInput(frame)],
        benchmark: benchmarkSeries({
          dates: calendar,
          closes: wavyCloses(calendar, 1_200),
        }),
        executionCalendar: calendar,
        startDate: "2000-01-03",
        endDate: "2002-12-31",
        maximumPositions: 2,
      }),
      {
        checkpointEveryDays: 1_000_000,
        onCheckpoint: (checkpoint) => {
          checkpoints.push(checkpoint);
        },
      },
    );

    const milestones = checkpoints.filter(
      (checkpoint) => checkpoint.milestone !== null,
    );
    // 2000 and 2001 complete mid-run; the final date is the result, not a checkpoint.
    expect(milestones.map((milestone) => milestone.milestone)).toEqual([
      "2000",
      "2001",
    ]);
    const first = milestones[0]!;
    expect(first.simulatedThrough.startsWith("2000-12")).toBe(true);
    expect(first.curve[0]?.date).toBe("2000-01-03");
    expect(first.curve.at(-1)?.date).toBe(first.simulatedThrough);
    // The curve a running page renders is absolute, and every point carries all three scenarios.
    expect(first.curve.every((point) => point.strategyValue > 0)).toBe(true);
    expect(
      first.curve.every((point) => point.cashBaselineValue === 100_000),
    ).toBe(true);
    expect(first.curve.every((point) => point.benchmarkValue !== null)).toBe(
      true,
    );
    expect(first.cashBaselineValue).toBe(100_000);
    expect(first.benchmarkValue).not.toBeNull();
    // The second year extends the same curve rather than restarting it.
    expect(milestones[1]?.curve[0]?.date).toBe("2000-01-03");
    expect(milestones[1]!.completedDays).toBeGreaterThan(first.completedDays);
  });

  it("refuses a result for a run whose later windows never executed", async () => {
    const calendar = marketDates("2000-01-03", "2001-12-31");
    const frame = frameOf({
      symbol: "AAA",
      dates: calendar,
      closes: calendar.map(() => 100),
    });
    const simulation = createBacktestSimulation({
      definition: definitionOf({
        buyLevels: [buyLevel("b50", 50, priceAboveSignal(ALWAYS))],
      }),
      securities: [
        {
          securityId: frame.securityId,
          symbol: frame.symbol,
          name: frame.name,
          buyWindows: { mode: "FULL", ranges: [] },
        },
      ],
      benchmark: null,
      executionCalendar: calendar,
      startDate: "2000-01-03",
      endDate: "2001-12-31",
      initialCapital: 100_000,
      monthlyContribution: 0,
      maximumPositions: 1,
    });

    expect(simulation.windows.map((window) => window.year)).toEqual([
      "2000",
      "2001",
    ]);
    await simulation.consumeWindow(simulation.windows[0]!, {
      frames: [frame],
    });

    // 2000 completed, 2001 never ran: there is no result, only a failure.
    expect(() => simulation.finish()).toThrow(BacktestExecutionError);
    expect(() => simulation.finish()).toThrow(/1 of 2 execution windows/);
  });

  it("rejects a window consumed out of order or missing a security", async () => {
    const calendar = marketDates("2000-01-03", "2001-12-31");
    const frame = frameOf({
      symbol: "AAA",
      dates: calendar,
      closes: calendar.map(() => 100),
    });
    const setup = {
      definition: definitionOf({
        buyLevels: [buyLevel("b50", 50, priceAboveSignal(ALWAYS))],
      }),
      securities: [
        {
          securityId: frame.securityId,
          symbol: frame.symbol,
          name: frame.name,
          buyWindows: { mode: "FULL" as const, ranges: [] },
        },
      ],
      benchmark: null,
      executionCalendar: calendar,
      startDate: "2000-01-03" as LocalDate,
      endDate: "2001-12-31" as LocalDate,
      initialCapital: 100_000,
      monthlyContribution: 0,
      maximumPositions: 1,
    };

    const outOfOrder = createBacktestSimulation(setup);
    await expect(
      outOfOrder.consumeWindow(outOfOrder.windows[1]!, { frames: [frame] }),
    ).rejects.toThrow(/consumed in order/);

    const missingSecurity = createBacktestSimulation(setup);
    await expect(
      missingSecurity.consumeWindow(missingSecurity.windows[0]!, {
        frames: [],
      }),
    ).rejects.toThrow(/one frame per security/);
  });
});

describe("the pinned execution calendar stays authoritative under windowing", () => {
  it("never turns a security row outside the calendar into a portfolio day", async () => {
    // New Year's Day is a market holiday, so the pinned calendar does not hold it.
    const calendar = marketDates("2000-12-26", "2001-01-05").filter(
      (date) => date !== "2001-01-01",
    );
    // A Saturday bar and a holiday bar, exactly as an anomalous provider row would appear. Both
    // straddle the window boundary, which is where a windowed run could most easily invent a day.
    const bogus: LocalDate[] = ["2000-12-30", "2001-01-01"];
    const dates = [...calendar, ...bogus].sort();
    const frame = frameOf({
      symbol: "AAA",
      dates,
      closes: dates.map((date) => (bogus.includes(date) ? 5 : 100)),
    });
    const input = executionInput({
      definition: definitionOf({
        buyLevels: [buyLevel("b100", 100, priceBelowSignal(50))],
      }),
      securities: [securityInput(frame)],
      executionCalendar: calendar,
      startDate: "2000-12-26",
      endDate: "2001-01-05",
      monthlyContribution: 1_000,
      maximumPositions: 1,
    });

    const windowed = await simulateBacktestByYear(input);

    expect(windowed.equity.map((point) => point.date)).toEqual(calendar);
    // The only dates the cheap price appears on are not portfolio dates, so nothing was bought.
    expect(windowed.trades).toHaveLength(0);
    expect(windowed.equity.some((point) => bogus.includes(point.date))).toBe(
      false,
    );
    expect(windowed.trades).toEqual((await simulateBacktest(input)).trades);
  });
});
