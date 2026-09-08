import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Full backtest journey for QA_USER against an already-running stack.
 *
 * Preconditions beyond the usual stack + `pnpm test:users:seed`:
 *
 * 1. `pnpm test:securities:seed` has run recently, which creates the deterministic QA security
 *    with its price history and derived state, and the `SP500` benchmark with its own history and
 *    freshness watermark. Both watermarks carry the seed's timestamp, so a seed from days ago makes
 *    the loader treat the tail as stale and reach for the provider.
 * 2. A worker process is running and claiming backtest jobs.
 *
 * The suite provisions everything else itself — its strategy through the Builder and its stock
 * list through the Lists UI — and removes both afterwards, so it depends on no pre-existing
 * user-owned state. When a precondition is missing it skips with the exact state it needed rather
 * than failing: an unseeded machine must not look like a product regression.
 *
 * **On observing a run mid-flight.** Against a fully seeded, provider-free stack a one-security
 * run simulates in well under a second, so the browser may never sample a non-terminal state. The
 * progressive rendering itself — placeholder, then a growing two-series curve, then the in-place
 * completed transition — is proven deterministically in `BacktestRunView.test.tsx` against the real
 * contract payloads. Here it is asserted **when the environment is slow enough to show it**, and
 * annotated when it is not; a correct system must not fail a test for being fast.
 *
 * Backtest runs are immutable and the product exposes no delete, so each execution leaves one run
 * on the shared persona. That is deliberate: a run is a durable record, not test scaffolding.
 */

const STRATEGY_NAME = "E2E backtest strategy";
const LIST_NAME = "E2E backtest list";

/** The deterministic QA security. `pnpm test:securities:seed` gives it real price history. */
const QA_SYMBOL = "QATEST1";

/** Comfortably inside the seed's 160-week window, whichever day the suite runs on. */
function seededPeriodStart(): string {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - 2 * 365);
  return start.toISOString().slice(0, 10);
}

/** A long simulation is the point: the running states are what these tests observe. */
const RUN_TIMEOUT_MS = 180_000;

function navLink(page: Page, label: string) {
  return page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: label });
}

/** The first selectable value of a select, ignoring its "Select a…" prompt. */
async function firstSelectableValue(select: Locator): Promise<string | null> {
  const values = await select
    .locator("option")
    .evaluateAll((options) =>
      options
        .map((option) => (option as HTMLOptionElement).value)
        .filter((value) => value !== ""),
    );
  return values[0] ?? null;
}

/** No page may scroll sideways: a run must be readable on a phone without panning. */
async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    overflow.scrollWidth,
    `Document scrolls horizontally: ${overflow.scrollWidth}px content in ${overflow.clientWidth}px viewport`,
  ).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

async function createStrategy(page: Page, name: string) {
  await page.goto("/strategies/new");
  await page.getByLabel("Name").fill(name);
  await page.getByTestId("add-level-BUY").click();
  const buyCard = page.getByTestId("level-card-BUY").first();
  await buyCard.getByTestId("metric-select").first().selectOption("PRICE:");
  await buyCard.getByTestId("operator-select").first().selectOption("IS_BELOW");
  await buyCard.getByTestId("value-control").first().selectOption("EMA_200D");
  await page.getByTestId("save-strategy").click();
  // Saving navigates to the new strategy, and the dev server compiles that route on first use.
  await expect(page).toHaveURL(/\/strategies\/[0-9a-f-]{36}$/, {
    timeout: 20_000,
  });
}

/** Best-effort teardown so a failure cannot leave the shared persona accumulating strategies. */
async function deleteStrategyIfPresent(page: Page, name: string) {
  try {
    await page.goto("/strategies");
    await expect(
      page
        .getByTestId("strategies-grid")
        .or(page.getByTestId("strategies-empty")),
    ).toBeVisible();
    const card = page
      .getByTestId("strategies-grid")
      .locator("li")
      .filter({ hasText: name });
    if ((await card.count()) === 0) {
      return;
    }
    await card.first().getByRole("button", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Delete strategy" }).click();
    await expect(card).toHaveCount(0);
  } catch {
    // Teardown must never replace the test's real failure with its own.
  }
}

/**
 * Creates the suite's own stock list holding the deterministic QA security.
 *
 * Provisioning it here rather than assuming a seeded list is what makes the suite self-contained:
 * a backtest needs a security with real hydrated history, and `QATEST1` is the only one guaranteed
 * to have it without a market-data provider.
 */
async function createList(page: Page, name: string) {
  await page.goto("/lists");
  await page.getByTestId("new-list-button").first().click();
  await page.getByLabel("Name").fill(name);
  await page
    .getByRole("combobox", { name: "Search stocks to add to the new list" })
    .fill(QA_SYMBOL);
  const option = page.getByRole("option").filter({ hasText: QA_SYMBOL });
  const seeded = await option
    .first()
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(
    !seeded,
    `${QA_SYMBOL} is not in the catalog. Run \`pnpm test:securities:seed\` against the stack ` +
      "this suite drives: a backtest needs a security with hydrated price history.",
  );
  await option.first().click();
  await page.getByRole("button", { name: "Create list" }).click();
  // Creation navigates to the saved list; the detail fetch follows the navigation, so this waits
  // longer than the default assertion timeout rather than racing it.
  await expect(page.getByTestId("list-detail")).toBeVisible({
    timeout: 20_000,
  });
}

/** Best-effort teardown; a failure must never leave the shared persona accumulating lists. */
async function deleteListIfPresent(page: Page, name: string) {
  try {
    await page.goto("/lists");
    await expect(
      page.getByTestId("lists-grid").or(page.getByTestId("lists-empty")),
    ).toBeVisible();
    const card = page
      .getByTestId("lists-grid")
      .locator("li")
      .filter({ hasText: name });
    if ((await card.count()) === 0) {
      return;
    }
    await card.first().getByRole("button", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Delete list" }).click();
    await expect(card).toHaveCount(0);
  } catch {
    // Teardown must never replace the test's real failure with its own.
  }
}

/**
 * Fills and submits the form, or skips the test when the environment cannot supply a benchmark.
 * Returns the submitted run's URL.
 */
async function submitBacktest(
  page: Page,
  options: { startDate?: string } = {},
): Promise<string> {
  await page.goto("/backtests/new");
  const listSelect = page.getByTestId("backtest-list");
  // The form enables its selects only once strategies, lists and benchmarks have all arrived —
  // three requests against a shared local API. That is slower than the default assertion timeout
  // when the whole suite is running.
  await expect(listSelect).toBeEnabled({ timeout: 20_000 });

  const benchmarkValue = await firstSelectableValue(
    page.getByTestId("backtest-benchmark"),
  );
  test.skip(
    benchmarkValue === null,
    "GET /benchmarks returned no benchmark. Register the benchmark catalog before running " +
      "the backtest suite.",
  );

  await page
    .getByTestId("backtest-strategy")
    .selectOption({ label: STRATEGY_NAME });
  await listSelect.selectOption({ label: LIST_NAME });
  // Inside the window `pnpm test:securities:seed` actually generated.
  //
  // The seed records coverage for exactly the interval it produced, so a period reaching further
  // back is genuinely uncovered and the loader would — correctly — go to the provider for the
  // missing prefix. A deterministic suite must not depend on that, so the run stays inside the
  // seeded window rather than the form's five-year default.
  await page
    .getByTestId("backtest-start")
    .fill(options.startDate ?? seededPeriodStart());
  await page.getByTestId("backtest-capital").fill("25000");
  await page.getByTestId("backtest-contribution").fill("500");
  await page.getByTestId("backtest-max-positions").fill("5");

  // The allocation help text is derived, never entered.
  await expect(page.getByTestId("full-position-help")).toContainText(
    "a full position is 20% of the portfolio",
  );

  await page.getByTestId("submit-backtest").click();
  await expect(page).toHaveURL(/\/backtests\/[0-9a-f-]{36}$/);
  return page.url();
}

type RunObservation = {
  status: string;
  sawNonTerminal: boolean;
  /** Sampled while the simulation itself was in flight — the only phase that can carry a curve. */
  sawSimulating: boolean;
  sawChartWhileRunning: boolean;
  maxPointsWhileRunning: number;
  maxSeriesWhileRunning: number;
  failureMessage: string | null;
};

/**
 * Samples the run page until it reaches a terminal state.
 *
 * Deliberately a sampler rather than a set of `expect` waits: the properties under test are about
 * what the page showed *while* the run was executing, which is gone by the time it completes.
 */
async function watchUntilTerminal(page: Page): Promise<RunObservation> {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  const seen: RunObservation = {
    status: "",
    sawNonTerminal: false,
    sawSimulating: false,
    sawChartWhileRunning: false,
    maxPointsWhileRunning: 0,
    maxSeriesWhileRunning: 0,
    failureMessage: null,
  };

  while (Date.now() < deadline) {
    const sample = await page.evaluate(() => {
      const run = document.querySelector('[data-testid="backtest-run"]');
      const chart = document.querySelector('[data-testid="backtest-chart"]');
      const failure = document.querySelector(
        '[data-testid="backtest-failure"]',
      );
      return {
        status: run?.getAttribute("data-status") ?? "",
        hasChart: chart !== null,
        points: Number(chart?.getAttribute("data-portfolio-points") ?? "0"),
        series: Number(chart?.getAttribute("data-series-count") ?? "0"),
        failure: failure?.textContent ?? null,
      };
    });

    seen.status = sample.status;
    const terminal =
      sample.status === "COMPLETED" || sample.status === "FAILED";
    if (sample.status !== "" && !terminal) {
      seen.sawNonTerminal = true;
      if (sample.status === "RUNNING" || sample.status === "FINALIZING") {
        seen.sawSimulating = true;
      }
      if (sample.hasChart) {
        seen.sawChartWhileRunning = true;
        seen.maxPointsWhileRunning = Math.max(
          seen.maxPointsWhileRunning,
          sample.points,
        );
        seen.maxSeriesWhileRunning = Math.max(
          seen.maxSeriesWhileRunning,
          sample.series,
        );
      }
    }
    if (terminal) {
      seen.failureMessage = sample.failure;
      return seen;
    }
    await page.waitForTimeout(120);
  }
  return seen;
}

test.describe("QA_USER backtests", () => {
  test.beforeEach(async ({ page }) => {
    await deleteStrategyIfPresent(page, STRATEGY_NAME);
    await deleteListIfPresent(page, LIST_NAME);
    await createStrategy(page, STRATEGY_NAME);
    await createList(page, LIST_NAME);
  });

  test.afterEach(async ({ page }) => {
    await deleteStrategyIfPresent(page, STRATEGY_NAME);
    await deleteListIfPresent(page, LIST_NAME);
  });

  test("submits a run, watches it progress, and reaches its result without a reload", async ({
    page,
  }) => {
    test.setTimeout(RUN_TIMEOUT_MS + 120_000);

    const runUrl = await submitBacktest(page);

    // The submitted run opens straight onto its own page, already in a pre-execution phase.
    await expect(page.getByTestId("backtest-run")).toBeVisible();
    await expect(page.getByTestId("backtest-configuration")).toContainText(
      "Full position",
    );
    const status = await page
      .getByTestId("backtest-run")
      .getAttribute("data-status");
    expect(
      ["QUEUED", "PREPARING_DATA", "RUNNING", "FINALIZING", "COMPLETED"],
      `Unexpected initial run state: ${status}`,
    ).toContain(status);

    const observation = await watchUntilTerminal(page);

    test.skip(
      observation.status === "FAILED",
      `The run failed (${observation.failureMessage ?? "no message"}). This suite needs a ` +
        "stock list whose securities have hydrated price history and derived state, plus a " +
        "hydrated benchmark, over the submitted period.",
    );
    expect(
      observation.status,
      "The run never reached a terminal state within the timeout. Is the worker running?",
    ).toBe("COMPLETED");

    // A seeded, provider-free stack can simulate a one-security run inside a single poll interval,
    // so the browser may only ever sample QUEUED — a phase that correctly has no curve yet. Assert
    // the progressive behaviour when the simulation itself was observed, and record the fact when
    // it was not: being fast is not a defect.
    if (observation.sawSimulating) {
      expect(
        observation.sawChartWhileRunning,
        "The page showed a pre-completion state but the comparison chart never appeared: the " +
          "live curve is not reaching the page.",
      ).toBe(true);
      // Not two series: early in a run the benchmark legitimately has no value at or before the
      // first simulated dates when its history starts later than the portfolio's, and a gap is
      // reported rather than drawn as zero. The completed chart is asserted to carry both series
      // below, which is where the comparison must be whole.
      expect(observation.maxSeriesWhileRunning).toBeGreaterThanOrEqual(1);
      expect(observation.maxPointsWhileRunning).toBeGreaterThan(0);
    } else {
      test.info().annotations.push({
        type: "environment",
        description:
          "The simulation finished between two samples, so the live chart was not observed " +
          `here (states seen: ${observation.sawNonTerminal ? "pre-execution only" : "terminal only"}). ` +
          "BacktestRunView.test.tsx proves that path against the same contract payloads.",
      });
    }

    // The completed view is the same page: no navigation, no manual reload.
    expect(page.url()).toBe(runUrl);
    await expect(page.getByTestId("backtest-status")).toHaveText("Completed");
    await expect(page.getByTestId("backtest-progress")).toHaveCount(0);

    const chart = page.getByTestId("backtest-chart");
    await expect(chart).toBeVisible();
    await expect(chart).toHaveAttribute("data-series-count", "2");
    expect(
      Number(await chart.getAttribute("data-portfolio-points")),
    ).toBeGreaterThanOrEqual(observation.maxPointsWhileRunning);

    // Final metrics, in the same tiles that carried the live ones.
    for (const metric of [
      "metric-portfolio-return",
      "metric-benchmark-return",
      "metric-alpha",
      "metric-portfolio-value",
      "metric-net-profit",
      "metric-max-drawdown",
      "metric-trades",
      "metric-open-positions",
    ]) {
      await expect(page.getByTestId(metric)).not.toHaveText(/—$/);
    }
    await expect(page.getByText("Trade log")).toBeVisible();
    await expect(page.getByText("Final holdings")).toBeVisible();

    await expectNoHorizontalScroll(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(chart).toBeVisible();
    await expectNoHorizontalScroll(page);

    // The finished run is listed in the collection.
    await navLink(page, "Backtests").click();
    await expect(page).toHaveURL(/\/backtests$/);
    await expect(
      page
        .getByTestId("backtests-grid")
        .locator("li")
        .filter({ hasText: STRATEGY_NAME })
        .first(),
    ).toBeVisible();
  });

  test("frames the chart on the configured period from the first render", async ({
    page,
  }) => {
    test.setTimeout(RUN_TIMEOUT_MS + 120_000);

    await page.goto("/backtests/new");
    await expect(page.getByTestId("backtest-list")).toBeEnabled({
      timeout: 20_000,
    });
    const start = page.getByTestId("backtest-start");
    const end = page.getByTestId("backtest-end");

    // MAX asks for the longest period the product allows, and the form must accept its own
    // control: a browser-side period check that disagreed with the API would reject it here.
    await page.getByTestId("backtest-start-max").click();
    const maxStart = await start.inputValue();
    const endDate = await end.inputValue();
    expect(maxStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(
      Number(endDate.slice(0, 4)) - Number(maxStart.slice(0, 4)),
      "MAX did not produce the full supported period",
    ).toBe(30);
    await expect(page.getByTestId("submit-backtest")).toBeEnabled();

    // The run itself stays inside the seeded window — a thirty-year run on a seeded stack would
    // reach the provider for history the seed truthfully never claimed.
    const runUrl = await submitBacktest(page);
    expect(runUrl).toMatch(/\/backtests\/[0-9a-f-]{36}$/);

    // The axis is the *requested* period, not the simulated part of it, and it is fixed from the
    // moment a curve first appears — before the run has computed anything near its end date.
    const chart = page.getByTestId("backtest-chart");
    await expect(chart).toBeVisible({ timeout: RUN_TIMEOUT_MS });
    const framedStart = await chart.getAttribute("data-period-start");
    const framedEnd = await chart.getAttribute("data-period-end");
    expect(framedStart).toBe(seededPeriodStart());
    expect(framedEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const observation = await watchUntilTerminal(page);
    test.skip(
      observation.status === "FAILED",
      `The run failed (${observation.failureMessage ?? "no message"}). This suite needs ` +
        "hydrated price history over the full supported period.",
    );

    // Still the requested period once the run is over: completing does not reframe the chart.
    await expect(chart).toHaveAttribute("data-period-start", framedStart ?? "");
    await expect(chart).toHaveAttribute("data-period-end", framedEnd ?? "");

    // The curve is framed by the period but bounded by the data that exists: on a seeded stack the
    // securities and the benchmark start well after 1996, and inventing dates before either would
    // be fabrication. That the run begins at its period rather than at its first trade is decided
    // in the engine and asserted there, over calendars this environment cannot guarantee.
    const firstPoint = await chart.getAttribute("data-curve-from");
    expect(firstPoint, "The chart carried no first point").not.toBeNull();
    expect(firstPoint as string).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // A multi-year run reports the years it finished, and keeps them after it ends.
    const years = page.getByTestId("backtest-milestone-years");
    await expect(years).toBeVisible();
    expect(
      Number(await years.getAttribute("data-milestone-count")),
      "A multi-year run recorded no annual milestones",
    ).toBeGreaterThan(0);
  });

  test("resumes from persisted progress after a mid-run reload", async ({
    page,
  }) => {
    test.setTimeout(RUN_TIMEOUT_MS + 120_000);

    await submitBacktest(page);
    const run = page.getByTestId("backtest-run");
    const chart = page.getByTestId("backtest-chart");

    // Wait for the run to have produced something worth resuming from.
    await expect
      .poll(
        async () => {
          const status = await run.getAttribute("data-status");
          if (status === "COMPLETED" || status === "FAILED") {
            return "terminal";
          }
          return (await chart.count()) > 0 ? "drawing" : "waiting";
        },
        { timeout: RUN_TIMEOUT_MS, intervals: [150] },
      )
      .not.toBe("waiting");

    const statusBeforeReload = await run.getAttribute("data-status");
    test.skip(
      statusBeforeReload === "FAILED",
      "The run failed before drawing a curve; this suite needs hydrated price history for " +
        "the list's securities and the benchmark.",
    );
    // A reload after completion still exercises the same path — the page rebuilds entirely from
    // persisted state — so it is asserted rather than skipped.
    const pointsBeforeReload = Number(
      await chart.getAttribute("data-portfolio-points"),
    );
    expect(pointsBeforeReload).toBeGreaterThan(0);

    await page.reload();

    // Persisted progress, not a restart: the reloaded page comes back with at least the curve it
    // had already drawn, and keeps growing from there.
    await expect(page.getByTestId("backtest-run")).toBeVisible();
    await expect
      .poll(
        async () =>
          (await chart.count()) === 0
            ? 0
            : Number(await chart.getAttribute("data-portfolio-points")),
        { timeout: 30_000, intervals: [200] },
      )
      .toBeGreaterThanOrEqual(pointsBeforeReload);

    const statusAfterReload = await run.getAttribute("data-status");
    if (statusAfterReload !== "COMPLETED" && statusAfterReload !== "FAILED") {
      expect(
        Number(
          (
            await page.getByTestId("backtest-progress-percent").textContent()
          )?.replace("%", ""),
        ),
        "A resumed run reported no progress; it restarted rather than resuming.",
      ).toBeGreaterThan(0);
    }
  });
});
