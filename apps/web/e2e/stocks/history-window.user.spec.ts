import { expect, test, type Page } from "@playwright/test";

/**
 * What history Stock Details actually asks the API for, observed at the real network boundary.
 *
 * The page must open on its own bounded window rather than leaning on whatever the shared
 * stock-data loader is capable of serving, and the long ranges must stay a deliberate, lazy second
 * load. Asserting the requests themselves is what makes "we only render a year" different from
 * "we only fetch a year".
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

test.describe("QA_USER Stock Details history window", () => {
  test("opens on a bounded one-year window and loads longer history only on request", async ({
    page,
  }) => {
    const requests = watchHistoryRequests(page);
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

    // Switching between ranges inside that window is a viewport change; no new read at all.
    for (const range of ["1M", "3M", "6M", "1Y"]) {
      await page
        .getByRole("group", { name: "Chart range" })
        .getByText(range, { exact: true })
        .click();
    }
    expect(requests).toHaveLength(1);

    // Only asking for a longer range loads more, and it asks for the *gap*: everything back to
    // five years, ending where the loaded window already starts.
    await page
      .getByRole("group", { name: "Chart range" })
      .getByText("5Y", { exact: true })
      .click();
    await expect
      .poll(() => requests.length, { timeout: 15_000 })
      .toBeGreaterThan(1);
    const fiveYear = requests.slice(1);
    expect(fiveYear.length).toBeGreaterThan(0);
    for (const request of fiveYear) {
      // Five years back from today, ending just before the year already on screen.
      expect(spanInDays({ ...request, to: initial.to })).toBeGreaterThan(365 * 5 - 3);
      expect(spanInDays({ ...request, to: initial.to })).toBeLessThan(365 * 5 + 3);
      expect(request.to < initial.from).toBe(true);
    }

    // MAX is the thirty-year product bound, not an unbounded read, and never reaches past it.
    const beforeMax = requests.length;
    await page
      .getByRole("group", { name: "Chart range" })
      .getByText("MAX", { exact: true })
      .click();
    await expect
      .poll(() => requests.length, { timeout: 15_000 })
      .toBeGreaterThan(beforeMax);
    const bound = historyBoundStart();
    for (const request of requests.slice(beforeMax)) {
      expect(spanInDays({ ...request, to: initial.to })).toBeGreaterThan(365 * 5 + 3);
      // Within a day of the bound: the request is the bound, not an open-ended read.
      expect(Math.abs(Date.parse(request.from) - Date.parse(bound))).toBeLessThanOrEqual(
        86_400_000,
      );
    }
    // Nothing before the boundary, ever.
    expect(requests.every((request) => request.from >= bound)).toBe(true);
  });
});
