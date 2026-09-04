import type { StockDetailsResponse } from "@intrinsic/contracts";
import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * What history Stock Details actually asks the API for, observed at the real network boundary.
 *
 * The page must open on its own bounded window rather than leaning on whatever the shared
 * stock-data loader is capable of serving, and the long ranges must stay a deliberate, lazy second
 * load that stops at the boundary the API reports. Asserting the requests themselves is what makes
 * "we only render a year" different from "we only fetch a year", and "the boundary is loaded"
 * different from "the chart merely stopped asking".
 *
 * `QATEST1` is seeded with roughly three years of trading days, and its durable coverage is
 * complete from the thirty-year horizon, so the API reports the first seeded trading day as the
 * boundary with `startOrigin: "PROVIDER"`. That is what makes it a realistic subject: `5Y` reaches
 * past the seeded history and is clamped to that boundary — nothing before the provider's first
 * day is ever asked for — and `MAX`, the thirty-year product bound, then finds the boundary already
 * loaded and costs no request at all.
 *
 * Preconditions are the usual Stock Details ones: `pnpm test:users:seed` once and
 * `pnpm test:securities:seed` shortly before the run.
 */

const QA_SYMBOL = "QATEST1";

const DESKTOP = { width: 1440, height: 900 };

/** Every distinct Stock Details read this page issues. */
type HistoryRequest = { path: string; from: string; to: string };

/**
 * Distinct bounded reads, in first-seen order.
 *
 * Identical windows are collapsed: React strict mode remounts effects in a development build, so
 * the same read can genuinely be issued twice. What this suite is about is *which* windows the
 * page asks for, not how many times the effect ran.
 */
function watchHistoryRequests(page: Page): HistoryRequest[] {
  const requests: HistoryRequest[] = [];
  const seen = new Set<string>();
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.includes(`/stocks/${QA_SYMBOL}`)) {
      return;
    }
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (!from || !to || seen.has(`${url.pathname}|${from}|${to}`)) {
      return;
    }
    seen.add(`${url.pathname}|${from}|${to}`);
    requests.push({ path: url.pathname, from, to });
  });
  return requests;
}

function spanInDays({ from, to }: HistoryRequest): number {
  return (Date.parse(to) - Date.parse(from)) / 86_400_000;
}

/** Thirty years before today, the Stock Details bound this deployment reports. */
function historyBoundStart(): string {
  const today = new Date();
  today.setUTCFullYear(today.getUTCFullYear() - 30);
  return today.toISOString().slice(0, 10);
}

/** The calendar day before `date`. */
function dayBefore(date: string): string {
  return new Date(Date.parse(date) - 86_400_000).toISOString().slice(0, 10);
}

/** The chart wrapper — the canvas container's parent — carrying the loading and boundary contract. */
function chartWrapper(page: Page): Locator {
  return page
    .getByRole("img", {
      name: new RegExp(`${QA_SYMBOL} daily closing price chart`),
    })
    .locator("..")
    .first();
}

/**
 * The composite Stock Details response the page opens with. Its `history` is the boundary the API
 * reports for this security, which is what every later request is asserted against: the client
 * navigates against that report and never recomputes it.
 */
function watchDetailsResponse(page: Page): Promise<StockDetailsResponse> {
  return page
    .waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname.endsWith(`/stocks/${QA_SYMBOL}`) &&
        url.searchParams.has("from") &&
        url.searchParams.has("to")
      );
    })
    .then((response) => response.json() as Promise<StockDetailsResponse>);
}

test.describe("QA_USER Stock Details history window", () => {
  test("opens on a bounded one-year window and loads longer history only on request", async ({
    page,
  }) => {
    const requests = watchHistoryRequests(page);
    const details = watchDetailsResponse(page);
    await page.setViewportSize(DESKTOP);
    await page.goto(`/stocks/${QA_SYMBOL}`);
    await expect(
      page.getByRole("heading", { level: 1, name: new RegExp(QA_SYMBOL) }),
    ).toBeVisible();
    await expect(
      page.getByRole("img", {
        name: new RegExp(`${QA_SYMBOL} daily closing price chart`),
      }),
    ).toBeVisible();

    // One composite read, and it names its own window rather than leaving it open.
    expect(requests).toHaveLength(1);
    const initial = requests[0]!;
    expect(initial.path).toBe(`/stocks/${QA_SYMBOL}`);
    expect(spanInDays(initial)).toBeGreaterThanOrEqual(364);
    expect(spanInDays(initial)).toBeLessThanOrEqual(367);
    // Thirty years are permitted; none of them are downloaded to draw twelve months.
    expect(initial.from > historyBoundStart()).toBe(true);

    // The boundary the API reports for the QA stock is the provider's first day: its coverage is
    // complete from the horizon, and the seeded history starts inside the permitted thirty years
    // — and before the year on screen, so the long ranges have something real to load.
    const { history } = await details;
    expect(history.startOrigin).toBe("PROVIDER");
    expect(history.start >= historyBoundStart()).toBe(true);
    expect(history.start < initial.from).toBe(true);

    // Switching between ranges inside that window is a viewport change; no new read at all.
    for (const range of ["1M", "3M", "6M", "1Y"]) {
      await page
        .getByRole("group", { name: "Chart range" })
        .getByText(range, { exact: true })
        .click();
    }
    expect(requests).toHaveLength(1);

    // Only asking for a longer range loads more, and it asks for the *gap*: the five-year window
    // is clamped to the reported boundary — nothing before the provider's first day is ever asked
    // for — and ends the day before the window already on screen.
    await page
      .getByRole("group", { name: "Chart range" })
      .getByText("5Y", { exact: true })
      .click();
    await expect
      .poll(() => requests.length, { timeout: 15_000 })
      .toBeGreaterThan(1);
    // The load has landed once the oldest bar on screen is the boundary itself.
    await expect(chartWrapper(page)).toHaveAttribute(
      "data-loaded-from",
      history.start,
      { timeout: 15_000 },
    );
    await expect(chartWrapper(page)).toHaveAttribute("data-loading", "false");
    const fiveYear = requests.slice(1);
    expect(fiveYear.length).toBeGreaterThan(0);
    for (const request of fiveYear) {
      expect(request.from).toBe(history.start);
      expect(request.to).toBe(dayBefore(initial.from));
    }
    // Asking for the boundary is what exhausts the history — the API's report, not an empty
    // answer, is what says nothing older exists.
    await expect(chartWrapper(page)).toHaveAttribute(
      "data-history-exhausted",
      "true",
    );

    // MAX is the thirty-year product bound, not an unbounded read. The boundary is already loaded,
    // so it is a viewport change over what is on screen and costs no request at all.
    const beforeMax = requests.length;
    await page
      .getByRole("group", { name: "Chart range" })
      .getByText("MAX", { exact: true })
      .click();
    await expect(page.getByRole("radio", { name: "MAX" })).toBeChecked();
    await expect(chartWrapper(page)).toHaveAttribute(
      "data-history-exhausted",
      "true",
    );
    expect(requests.length).toBe(beforeMax);

    // Nothing before the boundary, ever — neither the horizon nor the provider's first day.
    const bound = historyBoundStart();
    expect(requests.every((request) => request.from >= bound)).toBe(true);
    expect(requests.every((request) => request.from >= history.start)).toBe(
      true,
    );
  });
});
