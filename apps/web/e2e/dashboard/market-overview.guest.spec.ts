import type { MarketOverviewResponse } from "@intrinsic/contracts";
import { expect, test, type Page } from "../fixtures";
import { apiBaseUrl } from "../utils/entitlements";
import { e2eBaseUrl } from "../utils/env";
import { watchForIssues } from "../utils/page-issues";

/**
 * The Dashboard's ETF market overview, as a first-time visitor meets it, at every width the product
 * supports (`docs/decisions/etf-market-overview-v1.md`).
 *
 * Needs `pnpm test:personas:seed` (`test:securities:seed` writes the deterministic ETF fixtures: the
 * nineteen `ETF_*` series beside `SP500`, ending on the same session). The returns depend on where
 * today falls in the fixture's calendar, so most assertions compare the page with the API's own
 * answer; the fixture pins two directions that never change — `XLK` rises over every period and
 * `XLE` falls — for the positive and negative treatments.
 *
 * The overview never asks the market-data provider: the hermetic stack's teardown fails the run if
 * any provider request escaped, and this suite reads the overview dozens of times.
 */

const PERIODS = ["1W", "1M", "3M", "6M", "YTD", "1Y"] as const;
const GROUPS = ["BENCHMARKS", "US_SECTORS", "MACRO_ALTERNATIVES"] as const;

async function readOverview(page: Page): Promise<MarketOverviewResponse> {
  const response = await page.request.get(`${apiBaseUrl()}/market-overview`);
  expect(response.status()).toBe(200);
  return (await response.json()) as MarketOverviewResponse;
}

/** `+4.3%`, `−1.2%`, `0.0%`, `—`: the grid's own rule, restated independently. */
function displayed(value: number | null): string {
  if (value === null) {
    return "—";
  }
  const rounded = Math.round(value * 10) / 10;
  if (rounded === 0) {
    return "0.0%";
  }
  const magnitude = Math.abs(rounded).toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return `${rounded > 0 ? "+" : "−"}${magnitude}%`;
}

async function openDashboard(page: Page, width: number, height = 900) {
  await page.setViewportSize({ width, height });
  await page.goto("/");
  await expect(page.getByTestId("market-overview-row-SPY")).toBeAttached();
  // The storage-consent banner is fixed to the bottom of the viewport; answer it so it never sits
  // over the rows being measured.
  const reject = page.getByTestId("consent-reject");
  if (await reject.isVisible()) {
    await reject.click();
  }
}

/** Answers the overview with `body`, as the cross-origin API would (credentials included). */
async function serveOverview(page: Page, body: MarketOverviewResponse) {
  await page.route(`${apiBaseUrl()}/market-overview`, (route) =>
    route.fulfill({
      json: body,
      headers: {
        "Access-Control-Allow-Origin": new URL(e2eBaseUrl()).origin,
        "Access-Control-Allow-Credentials": "true",
      },
    }),
  );
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

/** Every visible ticker, name-free value and heading inside the overview that is cut off. */
async function clippedText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const clipped: string[] = [];
    const selector = [
      '[data-testid="market-overview-ticker"]',
      '[data-testid^="market-overview-return-"]',
      '[data-testid="market-overview"] h2',
      '[data-testid="market-overview"] h3',
      '[data-testid="market-overview-category"] button',
    ].join(",");
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      // Not rendered, or visually hidden for assistive technology only.
      if (element.offsetParent === null || element.clientWidth <= 1) {
        continue;
      }
      if (element.scrollWidth > element.clientWidth + 1) {
        clipped.push(element.textContent ?? "");
      }
    }
    return clipped;
  });
}

async function groupBox(page: Page, id: (typeof GROUPS)[number]) {
  const box = await page.getByTestId(`market-overview-group-${id}`).boundingBox();
  expect(box, id).not.toBeNull();
  return box as { x: number; y: number; width: number; height: number };
}

test.describe("market overview API", () => {
  test("answers twenty ETFs in three groups of 5, 11 and 4, to anybody", async ({ page }) => {
    // No session on this request at all.
    const response = await page.request.get(`${apiBaseUrl()}/market-overview`);
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe("private, max-age=60");
    expect(response.headers()["set-cookie"]).toBeUndefined();
    const text = await response.text();
    expect(text.length).toBeLessThan(60_000);
    const body = JSON.parse(text) as MarketOverviewResponse;

    expect(body.basis).toBe("END_OF_DAY");
    expect(body.returnBasis).toBe("PRICE_RETURN");
    expect(body.status).toBe("AVAILABLE");
    expect(body.groups.map((group) => group.id)).toEqual([...GROUPS]);
    expect(body.groups.map((group) => group.instruments.length)).toEqual([5, 11, 4]);
    expect(body.groups[0]?.instruments.map((one) => one.ticker)).toEqual([
      "SPY",
      "QQQ",
      "DIA",
      "IWM",
      "RSP",
    ]);
    expect(body.groups[2]?.instruments.map((one) => one.ticker)).toEqual([
      "GLD",
      "USO",
      "TLT",
      "HYG",
    ]);
    for (const instrument of body.groups.flatMap((group) => group.instruments)) {
      expect(instrument.sessionDate).toBe(body.asOf);
      expect(Object.keys(instrument.returns)).toEqual([...PERIODS]);
      for (const value of Object.values(instrument.returns)) {
        expect(typeof value).toBe("number");
      }
      expect(instrument.sparkline?.values.length).toBe(53);
    }
    // A session, never a weekend, never the future.
    const asOf = body.asOf as string;
    expect([1, 2, 3, 4, 5]).toContain(new Date(`${asOf}T00:00:00Z`).getUTCDay());
    expect(asOf <= new Date().toISOString().slice(0, 10)).toBe(true);
  });

  test("exposes no provider symbol, storage detail or price", async ({ page }) => {
    const serialized = JSON.stringify(await readOverview(page));

    for (const forbidden of ["ETF_", "SP500", "^GSPC", "seriesId", "providerSymbol", "close"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

test.describe("market overview on desktop", () => {
  for (const width of [1920, 1440, 1280]) {
    test(`shows the three groups side by side at ${width}px`, async ({ page }) => {
      await openDashboard(page, width);

      const benchmarks = await groupBox(page, "BENCHMARKS");
      const sectors = await groupBox(page, "US_SECTORS");
      const macro = await groupBox(page, "MACRO_ALTERNATIVES");
      // One row, left to right, all on screen together.
      expect(Math.abs(benchmarks.y - sectors.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(sectors.y - macro.y)).toBeLessThanOrEqual(1);
      expect(benchmarks.x + benchmarks.width).toBeLessThanOrEqual(sectors.x);
      expect(sectors.x + sectors.width).toBeLessThanOrEqual(macro.x);
      expect(macro.x + macro.width).toBeLessThanOrEqual(width);
      // The middle group is the tall one; nothing fills the space under the other two.
      expect(sectors.height).toBeGreaterThan(benchmarks.height);
      expect(sectors.height).toBeGreaterThan(macro.height);

      // All six periods visible on every row at once, with headings over them.
      for (const id of GROUPS) {
        const headings = page
          .getByTestId(`market-overview-group-${id}`)
          .getByRole("group", { name: /Sort .* by return/ })
          .getByRole("button");
        await expect(headings).toHaveText(PERIODS.map((period) => new RegExp(`${period}$`)));
      }
      for (const period of PERIODS) {
        await expect(page.getByTestId(`market-overview-return-XLC-${period}`)).toBeVisible();
      }
      await expect(page.getByTestId("market-overview-category")).toBeHidden();
      expect(await clippedText(page)).toEqual([]);
      await expectNoHorizontalScroll(page);
    });
  }

  test("renders exactly the numbers the API computed, with direction in colour", async ({
    page,
  }) => {
    const overview = await readOverview(page);
    await openDashboard(page, 1440);

    for (const instrument of overview.groups.flatMap((group) => group.instruments)) {
      for (const period of PERIODS) {
        const cell = page.getByTestId(`market-overview-return-${instrument.ticker}-${period}`);
        await expect(cell).toHaveText(displayed(instrument.returns[period]));
      }
    }
    for (const period of PERIODS) {
      await expect(page.getByTestId(`market-overview-return-XLK-${period}`)).toHaveAttribute(
        "data-tone",
        "positive",
      );
      await expect(page.getByTestId(`market-overview-return-XLK-${period}`)).toHaveText(/^\+/);
      await expect(page.getByTestId(`market-overview-return-XLE-${period}`)).toHaveAttribute(
        "data-tone",
        "negative",
      );
      await expect(page.getByTestId(`market-overview-return-XLE-${period}`)).toHaveText(/^−/);
    }
    // The positive and negative colours are really different on screen.
    const colours = await page.evaluate(() =>
      ["XLK", "XLE"].map(
        (ticker) =>
          getComputedStyle(
            document.querySelector(`[data-testid="market-overview-return-${ticker}-1Y"]`)!,
          ).color,
      ),
    );
    expect(colours[0]).not.toBe(colours[1]);
    await expect(page.getByTestId("market-overview-asof")).toContainText("End-of-day price returns");
    await expect(page.getByTestId("market-overview-footnote")).toContainText(
      "excluding dividends and other distributions",
    );
    await expect(page.getByTestId("market-overview-footnote")).toContainText(
      "USO: Tracks near-month WTI crude oil futures, not the spot price of oil.",
    );
  });

  test("draws one 1Y trend line per ETF, coloured by its 1Y return and named in words", async ({
    page,
  }) => {
    await openDashboard(page, 1440);

    const lines = page.locator('[data-testid="market-overview"] svg[role="img"]');
    await expect(lines).toHaveCount(20);
    const xlk = page.getByTestId("market-overview-XLK-sparkline");
    await expect(xlk).toBeVisible();
    await expect(xlk).toHaveAttribute("data-points", "53");
    await expect(xlk).toHaveAttribute("data-tone", "positive");
    await expect(xlk).toHaveAttribute("aria-label", /^XLK one-year trend, weekly closes from .+, up /);
    await expect(page.getByTestId("market-overview-XLE-sparkline")).toHaveAttribute(
      "data-tone",
      "negative",
    );
    const box = await xlk.boundingBox();
    expect(box?.width).toBeGreaterThan(60);
    expect(box?.height).toBeGreaterThan(14);
  });

  test("sorts a group by a period from its headings, and restores the catalog order", async ({
    page,
  }) => {
    const overview = await readOverview(page);
    await openDashboard(page, 1440);
    const sectors = overview.groups[1]?.instruments ?? [];
    const tickers = () =>
      page
        .getByTestId("market-overview-group-US_SECTORS")
        .getByTestId("market-overview-ticker")
        .allTextContents();

    await page.getByTestId("market-overview-sort-US_SECTORS-1Y").click();
    await expect(page.getByTestId("market-overview-sort-US_SECTORS-1Y")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const byYear = [...sectors]
      .sort((a, b) => (b.returns["1Y"] as number) - (a.returns["1Y"] as number))
      .map((one) => one.ticker);
    expect(await tickers()).toEqual(byYear);

    await page.getByTestId("market-overview-sort-US_SECTORS-1Y").click();
    expect(await tickers()).toEqual(sectors.map((one) => one.ticker));
  });

  test("reflows at 1024px: Benchmarks beside Macro, Sector Performance across both", async ({
    page,
  }) => {
    await openDashboard(page, 1024);

    const benchmarks = await groupBox(page, "BENCHMARKS");
    const sectors = await groupBox(page, "US_SECTORS");
    const macro = await groupBox(page, "MACRO_ALTERNATIVES");
    expect(Math.abs(benchmarks.y - macro.y)).toBeLessThanOrEqual(1);
    expect(benchmarks.x).toBeLessThan(macro.x);
    expect(sectors.y).toBeGreaterThan(benchmarks.y + benchmarks.height);
    expect(Math.abs(sectors.x - benchmarks.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(sectors.x + sectors.width - (macro.x + macro.width))).toBeLessThanOrEqual(1);
    // The sector rows run in two columns rather than stretching across the page.
    const xlk = await page.getByTestId("market-overview-row-XLK").boundingBox();
    const xlf = await page.getByTestId("market-overview-row-XLF").boundingBox();
    expect(Math.abs((xlk?.y ?? 0) - (xlf?.y ?? 1))).toBeLessThanOrEqual(1);
    expect(xlf?.x ?? 0).toBeGreaterThan((xlk?.x ?? 0) + (xlk?.width ?? 0) - 2);
    for (const period of PERIODS) {
      await expect(page.getByTestId(`market-overview-return-XLF-${period}`)).toBeVisible();
    }
    expect(await clippedText(page)).toEqual([]);
    await expectNoHorizontalScroll(page);
  });

  test("sits between the action strip and Current matches, with no page error or failed read", async ({
    page,
  }) => {
    const issues = watchForIssues(page);
    await openDashboard(page, 1440);
    await expect(page.getByTestId("dashboard-signals")).toBeVisible();

    const strip = await page.getByTestId("dashboard-overview").boundingBox();
    const market = await page.getByTestId("market-overview").boundingBox();
    const matches = await page.getByTestId("dashboard-signals").boundingBox();
    expect((strip?.y ?? 0) + (strip?.height ?? 0)).toBeLessThan(market?.y ?? 0);
    expect((market?.y ?? 0) + (market?.height ?? 0)).toBeLessThan(matches?.y ?? 0);
    // The old index cards are gone from the Dashboard.
    await expect(page.getByTestId(/^dashboard-market-card-/)).toHaveCount(0);
    await expect(page.getByTestId("dashboard-page")).not.toContainText(/fear|greed/i);
    // A Guest's session probe answers 401 by design; nothing about the overview may fail.
    expect(issues.pageErrors).toEqual([]);
    expect(issues.failedRequests.filter((line) => !line.endsWith("/auth/me"))).toEqual([]);
  });
});

test.describe("market overview on tablet and phone", () => {
  for (const width of [768, 390, 375]) {
    test(`shows purpose-built ETF cards at ${width}px, all six returns in each`, async ({
      page,
    }) => {
      await openDashboard(page, width, 844);

      const category = page.getByTestId("market-overview-category");
      await expect(category).toBeVisible();
      await expect(category.getByRole("button")).toHaveText(["Benchmarks", "Sectors", "Macro"]);
      // One group at a time: the selector chooses a group, never a period.
      await expect(page.getByTestId("market-overview-row-SPY")).toBeVisible();
      await expect(page.getByTestId("market-overview-row-XLK")).toBeHidden();
      await expect(page.getByTestId("market-overview-row-GLD")).toBeHidden();

      const card = page.getByTestId("market-overview-row-SPY");
      const cardBox = await card.boundingBox();
      for (const period of PERIODS) {
        const cell = page.getByTestId(`market-overview-return-SPY-${period}`);
        await expect(cell).toBeVisible();
        const box = await cell.boundingBox();
        // Inside its card, and labelled on the card itself: no column headings on a phone.
        expect(box?.x ?? -1).toBeGreaterThanOrEqual(cardBox?.x ?? 0);
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
          (cardBox?.x ?? 0) + (cardBox?.width ?? 0),
        );
      }
      await expect(card.getByRole("term")).toHaveText([...PERIODS]);
      // A 3 × 2 grid: 1W, 1M, 3M share a line, 6M starts the next.
      const first = await page.getByTestId("market-overview-return-SPY-1W").boundingBox();
      const third = await page.getByTestId("market-overview-return-SPY-3M").boundingBox();
      const fourth = await page.getByTestId("market-overview-return-SPY-6M").boundingBox();
      expect(Math.abs((first?.y ?? 0) - (third?.y ?? 1))).toBeLessThanOrEqual(1);
      expect(fourth?.y ?? 0).toBeGreaterThan(first?.y ?? 0);
      // The trend line is wide enough to read without dominating the card.
      const spark = await page.getByTestId("market-overview-SPY-sparkline").boundingBox();
      expect(spark?.width).toBeGreaterThan((cardBox?.width ?? 0) * 0.7);
      expect(spark?.height).toBeLessThan((cardBox?.height ?? 0) * 0.4);

      expect(await clippedText(page)).toEqual([]);
      await expectNoHorizontalScroll(page);
    });
  }

  test("switches category by touch and by keyboard, with comfortable targets", async ({
    page,
  }) => {
    await openDashboard(page, 390, 844);
    const category = page.getByTestId("market-overview-category");

    for (const button of await category.getByRole("button").all()) {
      const box = await button.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }

    await category.getByRole("button", { name: "Sectors" }).click();
    await expect(category.getByRole("button", { name: "Sectors" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    for (const ticker of ["XLK", "XLF", "XLE", "XLV", "XLI", "XLY", "XLP", "XLU", "XLB", "XLRE", "XLC"]) {
      await expect(page.getByTestId(`market-overview-row-${ticker}`)).toBeAttached();
    }
    await expect(page.getByTestId("market-overview-row-XLK")).toBeVisible();
    await expect(page.getByTestId("market-overview-row-SPY")).toBeHidden();

    // Keyboard: focus the Macro option and press Space.
    await category.getByRole("button", { name: "Macro" }).focus();
    await page.keyboard.press("Space");
    await expect(page.getByTestId("market-overview-row-GLD")).toBeVisible();
    await expect(page.getByTestId("market-overview-row-XLK")).toBeHidden();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("market-overview-row-XLK")).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test("keeps the mobile navigation working beneath it", async ({ page }) => {
    await openDashboard(page, 390, 844);
    const nav = page.getByRole("navigation", { name: "Primary mobile" });
    await expect(nav).toBeVisible();
    await nav.getByRole("link", { name: /Lists/ }).click();
    await expect(page).toHaveURL(/\/lists$/);
  });
});

test.describe("market overview states", () => {
  test("marks a stale ETF and an unavailable one without touching the rest", async ({ page }) => {
    const overview = await readOverview(page);
    for (const group of overview.groups) {
      for (const instrument of group.instruments) {
        if (instrument.ticker === "XLE") {
          instrument.status = "STALE";
          instrument.sessionDate = "2026-01-02";
        }
        if (instrument.ticker === "GLD") {
          instrument.status = "UNAVAILABLE";
          delete instrument.sessionDate;
          instrument.sparkline = null;
          for (const period of PERIODS) {
            instrument.returns[period] = null;
          }
        }
      }
    }
    overview.status = "PARTIAL";
    await serveOverview(page, overview);
    await openDashboard(page, 1440);

    await expect(page.getByTestId("market-overview-stale-XLE")).toHaveText("As of 2 Jan");
    await expect(page.getByTestId("market-overview-unavailable-GLD")).toHaveText("No data");
    for (const period of PERIODS) {
      await expect(page.getByTestId(`market-overview-return-GLD-${period}`)).toHaveAttribute(
        "data-tone",
        "unavailable",
      );
    }
    await expect(page.getByTestId("market-overview-GLD-sparkline")).toHaveCount(0);
    await expect(page.getByTestId("market-overview-XLK-sparkline")).toBeVisible();
  });

  test("renders a clean unavailable state when no history was ever loaded", async ({ page }) => {
    const overview = await readOverview(page);
    const empty: MarketOverviewResponse = {
      generatedAt: overview.generatedAt,
      basis: overview.basis,
      returnBasis: overview.returnBasis,
      status: "UNAVAILABLE",
      groups: overview.groups.map((group) => ({
        ...group,
        instruments: group.instruments.map((instrument) => ({
          ticker: instrument.ticker,
          name: instrument.name,
          status: "UNAVAILABLE" as const,
          returns: { "1W": null, "1M": null, "3M": null, "6M": null, YTD: null, "1Y": null },
          sparkline: null,
        })),
      })),
    };
    await serveOverview(page, empty);
    await page.goto("/");

    await expect(page.getByTestId("market-overview-unavailable")).toBeVisible();
    await expect(page.getByTestId("market-overview")).not.toContainText("%");
    // The matches are unaffected.
    await expect(page.getByTestId("dashboard-signals")).toBeVisible();
  });

  test("explains a temporary API failure and recovers on retry", async ({ page }) => {
    let fail = true;
    await page.route(`${apiBaseUrl()}/market-overview`, async (route) => {
      if (fail) {
        await route.fulfill({
          status: 503,
          json: { message: "unavailable" },
          headers: {
            "Access-Control-Allow-Origin": new URL(e2eBaseUrl()).origin,
            "Access-Control-Allow-Credentials": "true",
          },
        });
        return;
      }
      await route.continue();
    });
    await page.goto("/");

    const error = page.getByTestId("market-overview-error");
    await expect(error).toBeVisible();
    await expect(page.getByTestId("dashboard-signals")).toBeVisible();
    fail = false;
    await error.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("market-overview-row-SPY")).toBeVisible();
  });
});

test.describe("the rest of the Dashboard, for a Guest", () => {
  test("asks a Guest for an account in place, without leaving the Dashboard", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("dashboard-run-backtest").click();

    const prompt = page.getByTestId("sign-in-prompt");
    await expect(prompt).toBeVisible();
    await expect(prompt.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/login?next=%2Fbacktests%2Fnew",
    );
    await expect(page).toHaveURL("/");
    await expect(page.getByTestId("dashboard-signals")).toBeVisible();
  });

  test("counts the rows the Dashboard shows, and does not move when they are filtered", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("dashboard-signals")).toBeVisible();
    const rows = page.getByTestId("dashboard-signal-row");
    const total = await rows.count();
    await expect(page.getByTestId("dashboard-matches-total")).toHaveText(String(total));

    await page
      .getByTestId("dashboard-state-filter")
      .getByRole("button", { name: /^Active/ })
      .click();
    await expect(
      rows.filter({ has: page.locator('[data-state="PENDING_TRIGGER"]') }),
    ).toHaveCount(0);
    await expect(page.getByTestId("dashboard-matches-total")).toHaveText(String(total));
  });
});
