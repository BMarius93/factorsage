import type {
  DashboardActivityResponse,
  MarketOverviewResponse,
} from "@intrinsic/contracts";
import { expect, test, type Page } from "../fixtures";
import { apiBaseUrl } from "../utils/entitlements";
import { e2eBaseUrl } from "../utils/env";
import { watchForIssues } from "../utils/page-issues";

/**
 * The Dashboard's Market watch sidebar, as a first-time visitor meets it
 * (`docs/decisions/etf-market-overview-v1.md`, the Dashboard V2 amendment): Monitor activity is the
 * page, and from 1,280px a compact watchlist of the twenty market-overview ETFs sits beside it —
 * one period at a time, every row's return **and** line for that period, rotating every ten
 * seconds. Below 1,280px it does not exist: not rendered, not fetched.
 *
 * Needs `pnpm test:personas:seed` (`test:securities:seed` writes the deterministic ETF fixtures).
 * The returns depend on where today falls in the fixture's calendar, so assertions compare the page
 * with the API's own answer. The sidebar never asks the market-data provider: the hermetic stack's
 * teardown fails the run if any provider request escaped.
 *
 * Request counts are of reads that **completed**. The E2E web server is `next dev`, whose React
 * Strict Mode mounts every effect twice on purpose; the first read is aborted by that remount and
 * never reaches the API, so it is not a request the product made.
 */

const PERIODS = ["1W", "1M", "3M", "6M", "YTD", "1Y"] as const;
const GROUPS = ["BENCHMARKS", "US_SECTORS", "MACRO_ALTERNATIVES"] as const;
const ROTATION_MS = 10_000;

async function readOverview(page: Page): Promise<MarketOverviewResponse> {
  const response = await page.request.get(`${apiBaseUrl()}/market-overview`);
  expect(response.status()).toBe(200);
  return (await response.json()) as MarketOverviewResponse;
}

/** `+4.3%`, `−1.2%`, `0.0%`, `—`: the row's own rule, restated independently. */
function displayed(value: number | null): string {
  if (value === null) {
    return "—not available";
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

/** Every Market watch read the page started, and the ones that completed. */
function countMarketReads(page: Page) {
  const reads = { started: 0, completed: 0 };
  page.on("request", (request) => {
    if (request.url().endsWith("/market-overview")) {
      reads.started += 1;
    }
  });
  page.on("requestfinished", (request) => {
    if (request.url().endsWith("/market-overview")) {
      reads.completed += 1;
    }
  });
  return reads;
}

async function dismissConsent(page: Page) {
  const reject = page.getByTestId("consent-reject");
  if (await reject.isVisible()) {
    await reject.click();
  }
}

async function openDashboard(page: Page, width: number, height = 900) {
  await page.setViewportSize({ width, height });
  await page.goto("/");
  await expect(page.getByTestId("dashboard-activity")).toBeVisible();
  await dismissConsent(page);
}

/** Answers Market watch's read with `body`, as the cross-origin API would (credentials included). */
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

async function expectNoHorizontalScroll(page: Page, context = "") {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth, context).toBeLessThanOrEqual(
    overflow.clientWidth + 1,
  );
}

function period(page: Page) {
  return page.getByTestId("market-watch");
}

type Period = (typeof PERIODS)[number];

function following(value: Period, steps = 1): Period {
  return PERIODS[(PERIODS.indexOf(value) + steps) % PERIODS.length] as Period;
}

/** The period on screen. */
async function shown(page: Page): Promise<Period> {
  return (await page
    .getByTestId("market-watch")
    .getAttribute("data-period")) as Period;
}

function periodButton(page: Page, value: Period) {
  return page
    .getByTestId("market-watch-period")
    .getByRole("button", { name: value, exact: true });
}

/** Takes over the page's timers, so a ten-second rotation is a call rather than a wait. */
async function controlTime(page: Page) {
  await page.clock.install();
}

async function freezeTime(page: Page) {
  await page.clock.pauseAt(new Date(Date.now() + 1_000));
}

async function setHidden(page: Page, hidden: boolean) {
  await page.evaluate((value) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (value ? "hidden" : "visible"),
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

test.describe("market overview API", () => {
  test("answers twenty ETFs with six returns and six matching lines each, to anybody", async ({
    page,
  }) => {
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
    expect(
      body.groups.map((group) => group.instruments.map((one) => one.ticker)),
    ).toEqual([
      ["SPY", "QQQ", "DIA", "IWM", "RSP"],
      [
        "XLK",
        "XLF",
        "XLE",
        "XLV",
        "XLI",
        "XLY",
        "XLP",
        "XLU",
        "XLB",
        "XLRE",
        "XLC",
      ],
      ["GLD", "USO", "TLT", "HYG"],
    ]);
    for (const instrument of body.groups.flatMap(
      (group) => group.instruments,
    )) {
      expect(instrument.sessionDate).toBe(body.asOf);
      expect(Object.keys(instrument.returns)).toEqual([...PERIODS]);
      expect(Object.keys(instrument.sparklines)).toEqual([...PERIODS]);
      for (const key of PERIODS) {
        const line = instrument.sparklines[key];
        const value = instrument.returns[key] as number;
        // Each line spans its own period's window: from 100 at the anchor to the return at the end.
        expect(line?.endDate, `${instrument.ticker} ${key}`).toBe(body.asOf);
        expect(line?.values[0]).toBe(100);
        expect(
          Math.abs((line?.values.at(-1) ?? 0) - (100 + value)),
        ).toBeLessThan(0.011);
        expect(line?.values.length).toBeLessThanOrEqual(48);
      }
      // A week and a month are every daily close, never a weekly sample.
      expect(instrument.sparklines["1W"]?.values.length).toBeGreaterThanOrEqual(
        4,
      );
      expect(instrument.sparklines["1M"]?.values.length).toBeGreaterThanOrEqual(
        19,
      );
      // Different periods, different windows.
      const starts = new Set(
        PERIODS.map((key) => instrument.sparklines[key]?.startDate),
      );
      expect(starts.size).toBe(6);
    }
  });

  test("exposes no provider symbol, storage detail or price", async ({
    page,
  }) => {
    const serialized = JSON.stringify(await readOverview(page));

    for (const forbidden of [
      "ETF_",
      "SP500",
      "^GSPC",
      "seriesId",
      "providerSymbol",
      "close",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

test.describe("Market watch on a wide desktop", () => {
  for (const width of [1280, 1366, 1440, 1920]) {
    test(`sits beside Monitor activity at ${width}px, all twenty ETFs, after one read`, async ({
      page,
    }) => {
      const issues = watchForIssues(page);
      const reads = countMarketReads(page);
      const overview = await readOverview(page);
      await openDashboard(page, width);
      await expect(page.getByTestId("market-watch-row-SPY")).toBeVisible();

      const main = await page.getByTestId("dashboard-main").boundingBox();
      const sidebar = await page.getByTestId("dashboard-sidebar").boundingBox();
      // Two columns, the feed first and widest; the sidebar about a quarter of the content.
      expect(main && sidebar).toBeTruthy();
      expect((main?.x ?? 0) + (main?.width ?? 0)).toBeLessThan(sidebar?.x ?? 0);
      expect(
        Math.abs((main?.y ?? 0) - (sidebar?.y ?? -99)),
      ).toBeLessThanOrEqual(1);
      const share =
        (sidebar?.width ?? 0) / ((main?.width ?? 0) + (sidebar?.width ?? 0));
      expect(share).toBeGreaterThan(0.22);
      expect(share).toBeLessThan(0.32);

      // The groups and their rows, in the API's order.
      const watch = page.getByTestId("market-watch");
      await expect(watch.getByRole("heading", { level: 3 })).toHaveText([
        "Benchmarks",
        "Sector Performance",
        "Macro & Alternatives",
      ]);
      for (const group of overview.groups) {
        await expect(
          page
            .getByTestId(`market-watch-group-${group.id}`)
            .getByTestId("market-watch-ticker"),
        ).toHaveText(group.instruments.map((one) => one.ticker));
      }
      // Each row: a mark of what it tracks, the ticker, the market's name, a return, a line.
      for (const instrument of overview.groups.flatMap(
        (group) => group.instruments,
      )) {
        const row = page.getByTestId(`market-watch-row-${instrument.ticker}`);
        await expect(row.locator("svg[data-icon]")).toHaveAttribute(
          "aria-hidden",
          "true",
        );
        await expect(row.locator("svg[data-icon]")).not.toHaveAttribute(
          "data-icon",
          "market",
        );
        await expect(row.getByTestId("market-watch-name")).toHaveText(
          instrument.name,
        );
        await expect(
          row.getByTestId(`market-watch-return-${instrument.ticker}`),
        ).toHaveText(displayed(instrument.returns["1W"]));
        await expect(
          row.getByTestId(`market-watch-${instrument.ticker}-sparkline`),
        ).toHaveAttribute(
          "data-points",
          String(instrument.sparklines["1W"]?.values.length),
        );
      }
      await expect(page.getByTestId("market-watch-row-SPY")).toContainText(
        "S&P 500",
      );

      // Every line has the same width; no row's ticker or value is cut.
      const geometry = await page
        .locator('[data-testid^="market-watch-row-"]')
        .evaluateAll((rows) =>
          rows.map((row) => {
            const line = row
              .querySelector("svg[role='img']")!
              .getBoundingClientRect();
            const ticker = row.querySelector<HTMLElement>(
              '[data-testid="market-watch-ticker"]',
            )!;
            const value = row.querySelector<HTMLElement>(
              '[data-testid^="market-watch-return-"]',
            )!;
            return {
              lineWidth: Math.round(line.width),
              height: row.getBoundingClientRect().height,
              clipped:
                ticker.scrollWidth > ticker.clientWidth + 1 ||
                value.scrollWidth > value.clientWidth + 1,
            };
          }),
        );
      expect(new Set(geometry.map((row) => row.lineWidth)).size).toBe(1);
      for (const row of geometry) {
        expect(row.clipped).toBe(false);
        expect(row.height).toBeLessThanOrEqual(44);
      }

      expect(reads.completed).toBe(1);
      await expectNoHorizontalScroll(page, `${width}px`);
      // A Guest's session probe answers 401 by design; nothing else may fail.
      expect(issues.pageErrors).toEqual([]);
      expect(
        issues.failedRequests.filter((line) => !line.endsWith("/auth/me")),
      ).toEqual([]);
    });
  }

  test("rotates 1W → 1M → 3M → 6M → YTD → 1Y → 1W every ten seconds, all rows together, with no further read", async ({
    page,
  }) => {
    const reads = countMarketReads(page);
    const overview = await readOverview(page);
    await controlTime(page);
    await openDashboard(page, 1440);
    await expect(page.getByTestId("market-watch-row-SPY")).toBeVisible();
    await freezeTime(page);
    const startedAfterLoad = reads.started;
    const instruments = overview.groups.flatMap((group) => group.instruments);

    await expect(period(page)).toHaveAttribute("data-auto", "on");
    await expect(page.getByTestId("market-watch-auto")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // It opens on 1W; time is frozen once the page has loaded, wherever the rotation has reached.
    const first = await shown(page);
    const seen: Period[] = [];
    for (let step = 0; step <= PERIODS.length; step += 1) {
      const expected = following(first, step);
      await expect(period(page)).toHaveAttribute("data-period", expected);
      await expect(periodButton(page, expected)).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      // Every row shows this period's return and this period's line at once.
      for (const instrument of instruments) {
        await expect(
          page.getByTestId(`market-watch-return-${instrument.ticker}`),
        ).toHaveText(displayed(instrument.returns[expected]));
      }
      const drawn = await page
        .locator('[data-testid^="market-watch-"][data-testid$="-sparkline"]')
        .evaluateAll((lines) =>
          lines.map((line) => Number(line.getAttribute("data-points"))),
        );
      expect(drawn).toEqual(
        instruments.map((one) => one.sparklines[expected]?.values.length),
      );
      seen.push(expected);
      await page.clock.runFor(ROTATION_MS);
    }
    // The order, read from where it started: 1W → 1M → 3M → 6M → YTD → 1Y → 1W.
    const from = seen.indexOf("1W");
    expect([...seen.slice(from), ...seen.slice(1, from + 1)]).toEqual([
      "1W",
      "1M",
      "3M",
      "6M",
      "YTD",
      "1Y",
      "1W",
    ]);

    // Seven periods shown, no request after the first.
    expect(reads.started).toBe(startedAfterLoad);
    expect(reads.completed).toBe(1);
  });

  test("draws each period from its own series: six different lines for one fund", async ({
    page,
  }) => {
    await openDashboard(page, 1440);
    const line = page.getByTestId("market-watch-XLK-sparkline");
    await expect(line).toBeVisible();
    const shapes = new Set<string>();
    for (const value of PERIODS) {
      await periodButton(page, value).click();
      await expect(period(page)).toHaveAttribute("data-period", value);
      shapes.add((await line.locator("polyline").getAttribute("points")) ?? "");
      await expect(line).toHaveAttribute(
        "aria-label",
        new RegExp(`^XLK .+ trend, closes from`),
      );
    }
    expect(shapes.size).toBe(6);
  });

  test("pauses on a chosen period, says so, and resumes from Auto", async ({
    page,
  }) => {
    const reads = countMarketReads(page);
    await controlTime(page);
    await openDashboard(page, 1280);
    await expect(page.getByTestId("market-watch-row-SPY")).toBeVisible();
    await freezeTime(page);

    await periodButton(page, "6M").click();
    await expect(period(page)).toHaveAttribute("data-period", "6M");
    await expect(period(page)).toHaveAttribute("data-auto", "paused");
    await expect(page.getByTestId("market-watch-paused")).toHaveText("Paused");
    await expect(page.getByTestId("market-watch-auto")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(page.getByTestId("market-watch-caption")).toContainText(
      "6-month return",
    );

    await page.clock.runFor(ROTATION_MS * 4);
    await expect(period(page)).toHaveAttribute("data-period", "6M");

    await page.getByTestId("market-watch-auto").click();
    await expect(page.getByTestId("market-watch-auto")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByTestId("market-watch-paused")).toHaveCount(0);
    // Move the pointer off the sidebar; a resumed rotation then counts a full interval.
    await page.mouse.move(5, 5);
    await page.clock.runFor(ROTATION_MS);
    await expect(period(page)).toHaveAttribute("data-period", "YTD");
    expect(reads.completed).toBe(1);
  });

  test("holds while keyboard focus is inside, and selects a period from the keyboard", async ({
    page,
  }) => {
    await controlTime(page);
    await openDashboard(page, 1440);
    await expect(page.getByTestId("market-watch-row-SPY")).toBeVisible();
    await freezeTime(page);

    await page.getByTestId("market-watch-auto").focus();
    await page.keyboard.press("Tab");
    await expect(periodButton(page, "1W")).toBeFocused();
    await expect(period(page)).not.toHaveAttribute("data-rotating", "true");
    const held = await shown(page);
    await page.clock.runFor(ROTATION_MS * 3);
    await expect(period(page)).toHaveAttribute("data-period", held);

    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(periodButton(page, "3M")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(period(page)).toHaveAttribute("data-period", "3M");
    await expect(period(page)).toHaveAttribute("data-auto", "paused");
    // A visible focus ring on the chosen control.
    const ring = await periodButton(page, "3M").evaluate(
      (button) => getComputedStyle(button).boxShadow,
    );
    expect(ring).not.toBe("none");

    // The list is a named scroll region a keyboard can reach.
    await expect(
      page.getByRole("region", { name: "Market watch ETFs" }),
    ).toHaveAttribute("tabindex", "0");
  });

  test("stops rotating while the tab is hidden", async ({ page }) => {
    await controlTime(page);
    await openDashboard(page, 1440);
    await expect(page.getByTestId("market-watch-row-SPY")).toBeVisible();
    await freezeTime(page);

    await setHidden(page, true);
    const hiddenOn = await shown(page);
    await page.clock.runFor(ROTATION_MS * 6);
    await expect(period(page)).toHaveAttribute("data-period", hiddenOn);

    await setHidden(page, false);
    await page.clock.runFor(ROTATION_MS);
    await expect(period(page)).toHaveAttribute(
      "data-period",
      following(hiddenOn),
    );
  });

  test("starts paused for a reader who prefers reduced motion", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await controlTime(page);
    await openDashboard(page, 1440);
    await expect(page.getByTestId("market-watch-row-SPY")).toBeVisible();
    await freezeTime(page);

    await expect(period(page)).toHaveAttribute("data-auto", "paused");
    await expect(page.getByTestId("market-watch-paused")).toBeVisible();
    await page.clock.runFor(ROTATION_MS * 3);
    await expect(period(page)).toHaveAttribute("data-period", "1W");

    // Still the reader's to turn on.
    await page.getByTestId("market-watch-auto").click();
    await page.mouse.move(5, 5);
    await page.clock.runFor(ROTATION_MS);
    await expect(period(page)).toHaveAttribute("data-period", "1M");
  });

  test("bounds the sidebar to the screen, scrolls it on its own, and never traps the wheel", async ({
    page,
  }) => {
    await openDashboard(page, 1280, 800);
    const region = page.getByRole("region", { name: "Market watch ETFs" });
    await expect(page.getByTestId("market-watch-row-HYG")).toBeAttached();

    const box = await page.getByTestId("dashboard-sidebar").boundingBox();
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(800);
    const sizes = await region.evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    expect(sizes.scrollHeight).toBeGreaterThan(sizes.clientHeight);

    // The wheel over the list scrolls the list first…
    const area = await region.boundingBox();
    await page.mouse.move((area?.x ?? 0) + 40, (area?.y ?? 0) + 60);
    await page.mouse.wheel(0, 200);
    await expect
      .poll(() => region.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    // …and at its end hands the wheel back to the page.
    await region.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await page.mouse.wheel(0, 400);
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeGreaterThan(0);
    await expect(page.getByTestId("market-watch-row-HYG")).toBeVisible();

    // At the foot of the page the sidebar travels up with the grid, never over the footer.
    await page.evaluate(() =>
      window.scrollTo(0, document.documentElement.scrollHeight),
    );
    const sidebar = await page.getByTestId("dashboard-sidebar").boundingBox();
    const footer = await page.locator("footer").last().boundingBox();
    expect((sidebar?.y ?? 0) + (sidebar?.height ?? 0)).toBeLessThanOrEqual(
      (footer?.y ?? 0) + 1,
    );
  });

  for (const width of [1280, 1366]) {
    test(`keeps every activity fact readable and reachable beside the sidebar at ${width}px`, async ({
      page,
    }) => {
      await openDashboard(page, width);
      const table = page.getByTestId("dashboard-activity");
      // The narrow table: Session under the signal, Monitor under the reason.
      await expect(table.getByRole("columnheader")).toHaveText([
        "Stock",
        "Signal",
        "Why",
        "Price",
      ]);
      const rows = page.getByTestId("dashboard-activity-row");
      expect(await rows.count()).toBeGreaterThan(0);
      for (const row of await rows.all()) {
        await expect(row.getByTestId("dashboard-folded-session")).toBeVisible();
        await expect(row.getByTestId("dashboard-folded-monitor")).toBeVisible();
        await expect(row.getByTestId("dashboard-why")).toBeVisible();
      }
      const fit = await table.evaluate((element) => {
        const scroll = element.parentElement!;
        const frame = scroll.getBoundingClientRect();
        const outside = [
          ...element.querySelectorAll<HTMLElement>("tbody a[href]"),
        ]
          .filter((link) => link.getClientRects().length > 0)
          .filter((link) => {
            const box = link.getBoundingClientRect();
            return box.left < frame.left - 1 || box.right > frame.right + 1;
          })
          .map((link) => link.textContent);
        return { overflow: scroll.scrollWidth - scroll.clientWidth, outside };
      });
      expect(fit.overflow).toBeLessThanOrEqual(1);
      expect(fit.outside).toEqual([]);
      await expectNoHorizontalScroll(page, `${width}px`);
    });
  }

  test("shows the full six-column table where the feed's column has room for it, at 1920px", async ({
    page,
  }) => {
    await openDashboard(page, 1920, 1080);
    const table = page.getByTestId("dashboard-activity");
    await expect(table.getByRole("columnheader")).toHaveText([
      "Stock",
      "Signal",
      "Session",
      "Why",
      "Price",
      "Monitor",
    ]);
    await expect(
      page.getByTestId("dashboard-folded-monitor").first(),
    ).toBeHidden();
    await expect(page.getByTestId("market-watch")).toBeVisible();
  });

  test("survives long names, long tickers and long reasons beside the sidebar", async ({
    page,
  }) => {
    await page.route(/\/dashboard\/activity(\?.*)?$/, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as DashboardActivityResponse;
      const events = body.events.map((event, index) => ({
        ...event,
        security: {
          ...event.security,
          symbol: index === 0 ? "QATEST1" : event.security.symbol,
          name: "Quantitative Analytics Test Alpha Holdings Corporation International",
        },
        monitor: {
          ...event.monitor,
          name: "Quality Value and Momentum Confirmation Across Large Caps",
        },
        // Twice the reasons: the longest Why the fixture can produce.
        why: event.why
          ? { ...event.why, rules: [...event.why.rules, ...event.why.rules] }
          : event.why,
      }));
      await route.fulfill({ response, json: { ...body, events } });
    });
    for (const width of [1280, 1366]) {
      await openDashboard(page, width);
      const first = page.getByTestId("dashboard-activity-row").first();
      await expect(first.getByTestId("dashboard-folded-monitor")).toContainText(
        "Quality Value",
      );
      const chip = await first
        .getByTestId("dashboard-folded-monitor")
        .locator("[data-kind]")
        .evaluate((node) => {
          const label = node.firstElementChild as HTMLElement;
          return Math.round(
            label.getBoundingClientRect().height /
              parseFloat(getComputedStyle(label).lineHeight),
          );
        });
      expect(chip).toBeLessThanOrEqual(2);
      const tickerClipped = await first
        .getByTestId("dashboard-stock")
        .evaluate((identity) =>
          [...identity.querySelectorAll<HTMLElement>('[class*="symbol"]')].some(
            (symbol) => symbol.scrollWidth > symbol.clientWidth + 1,
          ),
        );
      expect(tickerClipped).toBe(false);
      const overflow = await page
        .getByTestId("dashboard-activity")
        .evaluate((table) => {
          const scroll = table.parentElement!;
          return scroll.scrollWidth - scroll.clientWidth;
        });
      expect(overflow, `${width}px`).toBeLessThanOrEqual(1);
      await expectNoHorizontalScroll(page, `${width}px`);
    }
  });
});

test.describe("below 1,280px there is no Market watch", () => {
  for (const width of [360, 390, 768, 1024, 1199, 1279]) {
    test(`renders nothing of it and reads nothing for it at ${width}px`, async ({
      page,
    }) => {
      const reads = countMarketReads(page);
      await openDashboard(page, width, 844);
      await expect(
        page.getByTestId("dashboard-activity-row").first(),
      ).toBeVisible();
      // The Guest still sees the published built-in activity, with the invitation to sign in.
      await expect(page.getByTestId("dashboard-guest-notice")).toBeVisible();

      await expect(page.getByTestId("market-watch")).toHaveCount(0);
      await expect(page.getByTestId("dashboard-sidebar")).toHaveCount(0);
      await expect(page.getByTestId("market-watch-period")).toHaveCount(0);
      await expect(page.locator('[data-testid$="-sparkline"]')).toHaveCount(0);
      // The feed takes the whole width: nothing is reserved beside it.
      const main = await page.getByTestId("dashboard-main").boundingBox();
      const layout = await page.getByTestId("dashboard-layout").boundingBox();
      expect(
        Math.abs((main?.width ?? 0) - (layout?.width ?? -9)),
      ).toBeLessThanOrEqual(1);

      expect(reads.started).toBe(0);
      await expectNoHorizontalScroll(page, `${width}px`);
    });
  }

  test("mounts across 1,279 → 1,280px, and leaves again without touching the feed", async ({
    page,
  }) => {
    const reads = countMarketReads(page);
    await openDashboard(page, 1279);
    await expect(page.getByTestId("market-watch")).toHaveCount(0);
    expect(reads.started).toBe(0);

    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.getByTestId("market-watch-row-SPY")).toBeVisible();
    await expect.poll(() => reads.completed).toBe(1);
    const rows = await page.getByTestId("dashboard-activity-row").count();

    await page.setViewportSize({ width: 1279, height: 900 });
    await expect(page.getByTestId("market-watch")).toHaveCount(0);
    await expect(page.getByTestId("dashboard-activity-row")).toHaveCount(rows);
    const narrowFrom = reads.started;
    await page.waitForTimeout(500);
    expect(reads.started).toBe(narrowFrom);
    await expectNoHorizontalScroll(page, "back to 1279px");

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByTestId("market-watch-row-HYG")).toBeAttached();
    await expect(page.getByTestId("dashboard-activity-row")).toHaveCount(rows);
  });
});

test.describe("Market watch states", () => {
  test("marks a stale ETF and an unavailable one without touching the rest", async ({
    page,
  }) => {
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
          for (const key of PERIODS) {
            instrument.returns[key] = null;
            instrument.sparklines[key] = null;
          }
        }
        if (instrument.ticker === "XLC") {
          // Too short a history for a year: no return and no line for 1Y only.
          instrument.returns["1Y"] = null;
          instrument.sparklines["1Y"] = null;
        }
      }
    }
    overview.status = "PARTIAL";
    await serveOverview(page, overview);
    await openDashboard(page, 1440);

    await expect(page.getByTestId("market-watch-stale-XLE")).toHaveText(
      "As of 2 Jan",
    );
    await expect(page.getByTestId("market-watch-unavailable-GLD")).toHaveText(
      "No data",
    );
    await expect(page.getByTestId("market-watch-return-GLD")).toHaveAttribute(
      "data-tone",
      "unavailable",
    );
    await expect(page.getByTestId("market-watch-GLD-sparkline")).toHaveCount(0);
    await expect(page.getByTestId("market-watch-GLD-no-trend")).toBeVisible();
    await expect(page.getByTestId("market-watch-XLK-sparkline")).toBeVisible();

    await periodButton(page, "1Y").click();
    await expect(page.getByTestId("market-watch-return-XLC")).toHaveText(
      "—not available",
    );
    await expect(page.getByTestId("market-watch-XLC-no-trend")).toHaveAttribute(
      "aria-label",
      "XLC 1 year trend: not available",
    );
    await periodButton(page, "6M").click();
    await expect(page.getByTestId("market-watch-XLC-sparkline")).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test("renders a clean unavailable state when no history was ever loaded", async ({
    page,
  }) => {
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
          returns: {
            "1W": null,
            "1M": null,
            "3M": null,
            "6M": null,
            YTD: null,
            "1Y": null,
          },
          sparklines: {
            "1W": null,
            "1M": null,
            "3M": null,
            "6M": null,
            YTD: null,
            "1Y": null,
          },
        })),
      })),
    };
    await serveOverview(page, empty);
    await openDashboard(page, 1440);

    await expect(page.getByTestId("market-watch-unavailable")).toBeVisible();
    await expect(page.getByTestId("market-watch")).not.toContainText("%");
    await expect(page.getByTestId("market-watch-period")).toHaveCount(0);
    await expect(page.getByTestId("dashboard-activity")).toBeVisible();
  });

  test("explains a temporary API failure beside an intact feed, and recovers on retry", async ({
    page,
  }) => {
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
    await openDashboard(page, 1440);

    const error = page.getByTestId("market-watch-error");
    await expect(error).toBeVisible();
    await expect(
      page.getByTestId("dashboard-activity-row").first(),
    ).toBeVisible();
    fail = false;
    await error.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("market-watch-row-SPY")).toBeVisible();
  });
});
