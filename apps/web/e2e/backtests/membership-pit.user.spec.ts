import { expect, test, type Page } from "../fixtures";
import { apiBaseUrl } from "../utils/entitlements";
import {
  createList,
  deleteListIfPresent,
  findSecurityId,
  itemOf,
  replaceBuyWindows,
} from "../utils/lists";

/**
 * Point-in-time membership, proven against the real engine rather than against a mock.
 *
 * Two properties, and they are the whole reason buy windows exist:
 *
 * 1. a security cannot be **bought** on a session outside its membership;
 * 2. a position it already holds can still be **sold** afterwards.
 *
 * Preconditions beyond the usual stack + `pnpm test:users:seed`:
 *
 * 1. `pnpm test:securities:seed` has run recently — `QATEST1` needs hydrated price history and
 *    derived state, and a benchmark must be registered;
 * 2. a worker process is running and claiming backtest jobs.
 *
 * When a precondition is missing the suite **skips with the exact state it needed**: an unseeded
 * machine must not look like a product regression.
 *
 * **Why a control run decides the dates.** The QA price series is deterministic but its phase
 * depends on when the seed was run, so hard-coding "membership starts on 2025-04-02" would be a
 * guess about which sessions carry a BUY. Instead the suite runs the strategy once with no
 * restriction, reads the trades that run actually made, and derives every membership boundary from
 * them. Each assertion then compares two runs that differ in exactly one input — the membership —
 * which is what makes a difference in the trades attributable to it.
 */

const QA_SYMBOL = "QATEST1";
const STRATEGY_NAME = "E2E membership PIT strategy";
const RUN_TIMEOUT_MS = 180_000;

/** RSI cycles many times over the seeded sawtooth, so this strategy trades in and out repeatedly. */
const RSI_CYCLING_DEFINITION = {
  schemaVersion: 2,
  buyLevels: [
    {
      id: "buy-rsi",
      percentage: 100,
      signal: {
        conditions: [
          {
            id: "rsi-below-60",
            metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
            operator: "IS_BELOW",
            value: { kind: "NUMBER", value: 60 },
          },
        ],
      },
    },
  ],
  sellLevels: [],
  // FINAL EXIT rather than a SELL level on purpose: a SELL level trims a position (25/50/75%) and
  // its BUY level then stays settled, so the run would make one entry and never another. A full
  // exit lets the position close and reopen on each RSI cycle, which is what gives the scenarios
  // below several BUY dates to place a membership boundary between.
  finalExit: {
    id: "exit-rsi",
    rules: [
      {
        id: "exit-rsi-rule",
        signal: {
          conditions: [
            {
              id: "rsi-above-60",
              metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
              operator: "IS_ABOVE",
              value: { kind: "NUMBER", value: 60 },
            },
          ],
        },
      },
    ],
  },
};

type Trade = {
  readonly date: string;
  readonly action: "BUY" | "SELL" | "FINAL_EXIT";
  readonly symbol: string;
};

type RunResult = {
  readonly trades: Trade[];
  readonly totalTrades: number;
};

function shiftDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

/**
 * The run period, read from the coverage the seed actually produced.
 *
 * Hard-coding "two years back from today" would reach outside the seeded window whenever the seed
 * is a few days old, and the loader would then — correctly — try to fill the uncovered prefix from
 * the provider. A deterministic, provider-free suite asks the API what it has instead.
 */
async function resolvePeriod(
  page: Page,
): Promise<{ startDate: string; endDate: string } | null> {
  const from = shiftDays(new Date().toISOString().slice(0, 10), -3 * 365);
  const response = await page.request.get(
    `${apiBaseUrl()}/stocks/${QA_SYMBOL}?from=${from}`,
  );
  if (!response.ok()) {
    return null;
  }
  const detail = (await response.json()) as { prices: { date: string }[] };
  const first = detail.prices[0]?.date;
  const last = detail.prices[detail.prices.length - 1]?.date;
  if (first === undefined || last === undefined) {
    return null;
  }
  const twoYearsBack = shiftDays(last, -2 * 365);
  return {
    startDate: first > twoYearsBack ? first : twoYearsBack,
    endDate: last,
  };
}

function nextCalendarDay(date: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

async function createStrategy(page: Page, name: string): Promise<string> {
  const response = await page.request.post(`${apiBaseUrl()}/strategies`, {
    data: { name, definition: RSI_CYCLING_DEFINITION },
  });
  expect(
    response.ok(),
    `POST /strategies failed with ${response.status()}: ${await response.text()}`,
  ).toBe(true);
  return ((await response.json()) as { id: string }).id;
}

/** The benchmark to compare against: the product default when it is registered, else whatever is. */
async function benchmarkCodeFor(page: Page): Promise<string | null> {
  const response = await page.request.get(`${apiBaseUrl()}/benchmarks`);
  if (!response.ok()) {
    return null;
  }
  const catalog = (await response.json()) as { code: string }[];
  const codes = catalog.map((entry) => entry.code);
  return codes.find((code) => code === "SP500") ?? codes[0] ?? null;
}

/**
 * Submits a run and polls it to a terminal state, returning its trades.
 *
 * Returns `null` when the run failed, so the caller can skip with the environment's own reason
 * rather than asserting against a run that never simulated anything.
 */
async function runBacktest(
  page: Page,
  input: {
    strategyId: string;
    stockListId: string;
    benchmarkCode: string;
    startDate: string;
    endDate: string;
  },
): Promise<RunResult | null> {
  const submitted = await page.request.post(`${apiBaseUrl()}/backtests`, {
    data: {
      strategyId: input.strategyId,
      stockListId: input.stockListId,
      benchmarkCode: input.benchmarkCode,
      startDate: input.startDate,
      endDate: input.endDate,
      initialCapital: 25_000,
      maximumPositions: 5,
    },
  });
  expect(
    submitted.ok(),
    `POST /backtests failed with ${submitted.status()}: ${await submitted.text()}`,
  ).toBe(true);
  const runId = ((await submitted.json()) as { id: string }).id;

  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await page.request.get(
      `${apiBaseUrl()}/backtests/${runId}`,
    );
    expect(response.ok()).toBe(true);
    const detail = (await response.json()) as {
      status: string;
      failure: { message?: string } | null;
      result: {
        summary: { totalTrades: number };
        trades: Trade[];
      } | null;
    };
    if (detail.status === "FAILED") {
      test.info().annotations.push({
        type: "environment",
        description: `Run ${runId} failed: ${detail.failure?.message ?? "no message"}`,
      });
      return null;
    }
    if (detail.status === "COMPLETED") {
      const result = detail.result;
      expect(result, "A completed run carried no result").not.toBeNull();
      // The wire caps the trade log. Every "no BUY before X" claim below reads the whole log, so
      // a truncated one would make the assertion vacuous rather than wrong.
      expect(
        (result as NonNullable<typeof result>).trades.length,
        "The trade log was truncated; this suite's absence assertions need the complete log",
      ).toBe((result as NonNullable<typeof result>).summary.totalTrades);
      return {
        trades: (result as NonNullable<typeof result>).trades,
        totalTrades: (result as NonNullable<typeof result>).summary.totalTrades,
      };
    }
    await page.waitForTimeout(250);
  }
  throw new Error(
    `Run ${runId} never reached a terminal state within ${RUN_TIMEOUT_MS}ms. Is the worker running?`,
  );
}

const buysOf = (result: RunResult) =>
  result.trades.filter((trade) => trade.action === "BUY");
const exitsOf = (result: RunResult) =>
  result.trades.filter((trade) => trade.action !== "BUY");
const datesOf = (trades: readonly Trade[]) =>
  [...new Set(trades.map((trade) => trade.date))].sort();

test.describe("PRO_USER membership is a BUY gate in the backtest engine", () => {
  test.describe.configure({ timeout: RUN_TIMEOUT_MS * 3 });

  let listId: string | null = null;
  let strategyId: string | null = null;
  let itemId = "";
  let benchmarkCode = "";
  let startDate = "";
  let endDate = "";

  /** The unrestricted run every scenario derives its dates from. */
  let control: RunResult | null = null;

  test.beforeEach(async ({ page }) => {
    await page.goto("/lists");

    const securityId = await findSecurityId(page, QA_SYMBOL);
    test.skip(
      securityId === null,
      `${QA_SYMBOL} is not in the catalog. Run \`pnpm test:securities:seed\`: a backtest needs a ` +
        "security with hydrated price history and derived state.",
    );

    const period = await resolvePeriod(page);
    test.skip(
      period === null,
      `${QA_SYMBOL} has no price history. Run \`pnpm test:securities:seed\`.`,
    );
    startDate = (period as { startDate: string }).startDate;
    endDate = (period as { endDate: string }).endDate;

    const code = await benchmarkCodeFor(page);
    test.skip(
      code === null,
      "GET /benchmarks returned no benchmark. Register the benchmark catalog first.",
    );
    benchmarkCode = code as string;

    const list = await createList(page, `QA Membership PIT ${Date.now()}`, [
      securityId as string,
    ]);
    listId = list.id;
    itemId = itemOf(list, QA_SYMBOL).id;
    strategyId = await createStrategy(page, `${STRATEGY_NAME} ${Date.now()}`);

    control = await runBacktest(page, {
      strategyId,
      stockListId: listId,
      benchmarkCode,
      startDate,
      endDate,
    });
    test.skip(
      control === null,
      "The unrestricted control run failed, so there is nothing to compare a restricted run " +
        "against. This suite needs hydrated history for the whole submitted period.",
    );
  });

  test.afterEach(async ({ page }) => {
    await deleteListIfPresent(page, listId);
    if (strategyId !== null) {
      await page.request
        .delete(`${apiBaseUrl()}/strategies/${strategyId}`)
        .catch(() => {});
    }
    listId = null;
    strategyId = null;
    control = null;
  });

  // Scenario 4 — membership begins after the run starts.
  test("cannot buy before membership begins, and can once it does", async ({
    page,
  }) => {
    const reference = control as RunResult;
    const controlBuyDates = datesOf(buysOf(reference));
    test.skip(
      controlBuyDates.length < 2,
      `The unrestricted run made ${controlBuyDates.length} BUY date(s); this scenario needs at ` +
        "least two so a later one can begin the membership while an earlier one is blocked.",
    );

    // Membership begins on the control's last BUY date, so every earlier BUY it made is a BUY the
    // gate now has to refuse — and the last one is a BUY it must still allow.
    const membershipStart = controlBuyDates[
      controlBuyDates.length - 1
    ] as string;
    const blocked = controlBuyDates.filter((date) => date < membershipStart);
    expect(blocked.length).toBeGreaterThan(0);

    await replaceBuyWindows(page, listId as string, itemId, {
      mode: "CUSTOM",
      ranges: [{ startDate: membershipStart, endDate: null }],
    });

    const restricted = await runBacktest(page, {
      strategyId: strategyId as string,
      stockListId: listId as string,
      benchmarkCode,
      startDate,
      endDate,
    });
    test.skip(restricted === null, "The restricted run failed.");

    const buys = buysOf(restricted as RunResult);
    expect(
      buys.filter((trade) => trade.date < membershipStart),
      `BUYs before membership began on ${membershipStart}: ` +
        `${buys.map((trade) => trade.date).join(", ")}`,
    ).toHaveLength(0);
    // …and the gate is not simply refusing everything: the session membership opens on still buys.
    expect(
      buys.length,
      `No BUY at all once membership began on ${membershipStart}, although the unrestricted run ` +
        "bought on that very session.",
    ).toBeGreaterThan(0);
    expect(datesOf(buys)[0]).toBe(membershipStart);
  });

  // Scenario 5 — membership ends while a position is open, and the exit must still happen.
  test("still sells a position after its membership has ended", async ({
    page,
  }) => {
    const reference = control as RunResult;
    const firstBuy = buysOf(reference)[0];
    test.skip(
      firstBuy === undefined,
      "The unrestricted run made no BUY, so there is no position whose exit could be observed.",
    );
    const membershipEnd = (firstBuy as Trade).date;
    const controlExitAfter = exitsOf(reference).find(
      (trade) => trade.date > membershipEnd,
    );
    test.skip(
      controlExitAfter === undefined,
      `The unrestricted run never exited after its first BUY on ${membershipEnd}, so the ` +
        "regression this test protects cannot be observed in this fixture.",
    );

    // Membership covers the run's start through the first BUY, inclusive, and then ends.
    await replaceBuyWindows(page, listId as string, itemId, {
      mode: "CUSTOM",
      ranges: [{ startDate, endDate: membershipEnd }],
    });

    const restricted = await runBacktest(page, {
      strategyId: strategyId as string,
      stockListId: listId as string,
      benchmarkCode,
      startDate,
      endDate,
    });
    test.skip(restricted === null, "The restricted run failed.");
    const result = restricted as RunResult;

    // The position was opened while the stock was still a member…
    const buys = buysOf(result);
    expect(buys.length).toBeGreaterThan(0);
    expect(
      buys.every((trade) => trade.date <= membershipEnd),
      `A BUY landed after membership ended on ${membershipEnd}: ` +
        `${buys.map((trade) => trade.date).join(", ")}`,
    ).toBe(true);
    // …and no new BUY was allowed after it ended, which is what makes the exit below meaningful.
    expect(
      buys.filter((trade) => trade.date > nextCalendarDay(membershipEnd)),
    ).toHaveLength(0);

    // The regression: the exit still fires, on a session the stock was no longer a member.
    const exitsAfterMembership = exitsOf(result).filter(
      (trade) => trade.date > membershipEnd,
    );
    expect(
      exitsAfterMembership.length,
      `No SELL or FINAL EXIT after membership ended on ${membershipEnd}. Trades: ` +
        `${result.trades.map((trade) => `${trade.action}@${trade.date}`).join(", ")}`,
    ).toBeGreaterThan(0);
    expect(exitsAfterMembership[0]?.date).toBe(
      (controlExitAfter as Trade).date,
    );
  });
});
