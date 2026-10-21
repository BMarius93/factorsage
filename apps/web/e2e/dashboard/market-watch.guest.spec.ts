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
 * page, and from 1,280px an ultra-compact sidebar of the twenty market-overview ETFs sits flush
 * against the right edge beside it — one period at a time, every row's return **and** line for
 * that period, rotating every eight seconds until the reader picks one. Below 1,280px it does not
 * exist: not rendered, not fetched.
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
const ROTATION_MS = 8_000;

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

/** Takes over the page's timers, so an eight-second rotation is a call rather than a wait. */
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
  for (const [width, height] of [
    [1280, 900],
    [1366, 900],
    [1440, 900],
    [1920, 1080],
  ] as const) {
    test(`is a flush sidebar beside Monitor activity at ${width}px, all twenty ETFs on one line each, after one read`, async ({
      page,
    }) => {
      const issues = watchForIssues(page);
      const reads = countMarketReads(page);
      const overview = await readOverview(page);
      await openDashboard(page, width, height);
      await expect(page.getByTestId("market-watch-row-SPY")).toBeVisible();

      const main = await page.getByTestId("dashboard-main").boundingBox();
      const sidebar = await page.getByTestId("dashboard-sidebar").boundingBox();
      const topbar = await page.locator("header").first().boundingBox();
      expect(main && sidebar && topbar).toBeTruthy();
      // The feed takes the rest; the sidebar is 330–360px, flush against the right edge, from just
      // under the topbar to the bottom of the screen.
      expect((main?.x ?? 0) + (main?.width ?? 0)).toBeLessThanOrEqual(
        (sidebar?.x ?? 0) + 1,
      );
      expect(sidebar?.width ?? 0).toBeGreaterThanOrEqual(330);
      expect(sidebar?.width ?? 0).toBeLessThanOrEqual(360);
      expect(
        Math.abs((sidebar?.x ?? 0) + (sidebar?.width ?? 0) - width),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(
          (sidebar?.y ?? 0) - ((topbar?.y ?? 0) + (topbar?.height ?? 0)),
        ),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs((sidebar?.y ?? 0) + (sidebar?.height ?? 0) - height),
      ).toBeLessThanOrEqual(1);
      // A pane, not a card: no radius, no shadow, one hairline on the feed's side.
      const chrome = await page
        .getByTestId("dashboard-sidebar")
        .evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            radius: style.borderTopLeftRadius,
            shadow: style.boxShadow,
            left: style.borderLeftWidth,
            right: style.borderRightWidth,
          };
        });
      expect(chrome).toEqual({
        radius: "0px",
        shadow: "none",
        left: "1px",
        right: "0px",
      });

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

      // One line per fund, 24–28px; every line the same width; no ticker or value cut; names give
      // way with an ellipsis rather than wrapping; the returns right-aligned in tabular figures.
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
            const name = row.querySelector<HTMLElement>(
              '[data-testid="market-watch-name"]',
            )!;
            const valueStyle = getComputedStyle(value);
            return {
              lineWidth: Math.round(line.width),
              height: row.getBoundingClientRect().height,
              clipped:
                ticker.scrollWidth > ticker.clientWidth + 1 ||
                value.scrollWidth > value.clientWidth + 1,
              nameWraps: getComputedStyle(name).whiteSpace !== "nowrap",
              align: valueStyle.textAlign,
              numerals: valueStyle.fontVariantNumeric,
            };
          }),
        );
      expect(geometry).toHaveLength(20);
      expect(new Set(geometry.map((row) => row.lineWidth)).size).toBe(1);
      for (const row of geometry) {
        expect(row.clipped).toBe(false);
        expect(row.height).toBeGreaterThanOrEqual(24);
        expect(row.height).toBeLessThanOrEqual(28);
        expect(row.nameWraps).toBe(false);
        expect(row.align).toBe("right");
        expect(row.numerals).toContain("tabular-nums");
      }
      // On a screen this tall, all twenty and their groups are on screen at once.
      const region = page.getByRole("region", { name: "Market watch ETFs" });
      const sizes = await region.evaluate((element) => ({
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      }));
      expect(sizes.scrollHeight).toBeLessThanOrEqual(sizes.clientHeight + 1);
      await expect(page.getByTestId("market-watch-row-HYG")).toBeInViewport();

      expect(reads.completed).toBe(1);
      await expectNoHorizontalScroll(page, `${width}px`);
      // A Guest's session probe answers 401 by design; nothing else may fail.
      expect(issues.pageErrors).toEqual([]);
      expect(
        issues.failedRequests.filter((line) => !line.endsWith("/auth/me")),
      ).toEqual([]);
    });
  }

  test("rotates 1W → 1M → 3M → 6M → YTD → 1Y → 1W every eight seconds, all rows together, with no further read", async ({
    page,
  }) => {
    const reads = countMarketReads(page);
    const overview = await readOverview(page);
    await controlTime(page);
    await openDashboard(page, 1440);
    await expect(page.getByTestId("market-watch-row-SPY")).toBeVisible();
    await page.mouse.move(5, 5);
    await freezeTime(page);
    const startedAfterLoad = reads.started;
    const instruments = overview.groups.flatMap((group) => group.instruments);

    await expect(period(page)).toHaveAttribute("data-auto", "on");
    // No Auto control of any kind: the periods are the only buttons.
    await expect(page.getByTestId("market-watch-auto")).toHaveCount(0);
    await expect(period(page).getByRole("button")).toHaveCount(6);
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

  test("dims the returns and lines, swaps while they are dim, brings them back and marks the new period once — never moving a row", async ({
    page,
  }) => {
    await controlTime(page);
    await openDashboard(page, 1440);
    await expect(page.getByTestId("market-watch-row-SPY")).toBeVisible();
    await page.mouse.move(5, 5);
    await freezeTime(page);
    // Pointing at the sidebar and leaving it re-arms a full interval from the frozen instant, so
    // the steps below land exactly on the fade, the swap and the rest.
    const area = await page.getByTestId("dashboard-sidebar").boundingBox();
    await page.mouse.move((area?.x ?? 0) + 100, (area?.y ?? 0) + 300);
    await expect(period(page)).not.toHaveAttribute("data-rotating", "true");
    await page.mouse.move(5, 5);
    await expect(period(page)).toHaveAttribute("data-rotating", "true");
    const watch = period(page);
    const before = await shown(page);
    const sidebarHeight = async () =>
      (await page.getByTestId("dashboard-sidebar").boundingBox())?.height;
    const rowTop = async () =>
      (await page.getByTestId("market-watch-row-HYG").boundingBox())?.y;
    const height = await sidebarHeight();
    const top = await rowTop();

    // Up to the fade.
    await page.clock.runFor(ROTATION_MS - 250);
    await expect(watch).toHaveAttribute("data-phase", "out");
    await expect(watch).toHaveAttribute("data-period", before);
    // The numbers and lines dim; the tickers, names and group titles do not.
    await expect
      .poll(() =>
        page
          .getByTestId("market-watch-return-SPY")
          .evaluate((element) => Number(getComputedStyle(element).opacity)),
      )
      .toBeLessThan(0.7);
    const still = await page
      .getByTestId("market-watch-row-SPY")
      .getByTestId("market-watch-ticker")
      .evaluate((element) => getComputedStyle(element).opacity);
    expect(still).toBe("1");

    // The swap, while dim; the new period carries its one highlight.
    await page.clock.runFor(250);
    await expect(watch).toHaveAttribute("data-phase", "in");
    await expect(watch).toHaveAttribute("data-period", following(before));
    await expect(periodButton(page, following(before))).toHaveAttribute(
      "data-highlight",
      "true",
    );
    await page.clock.runFor(450);
    await expect(watch).toHaveAttribute("data-phase", "idle");
    await expect
      .poll(() =>
        page
          .getByTestId("market-watch-return-SPY")
          .evaluate((element) => Number(getComputedStyle(element).opacity)),
      )
      .toBe(1);
    // Nothing moved: the sidebar kept its height and every row its place.
    expect(await sidebarHeight()).toBe(height);
    expect(await rowTop()).toBe(top);
  });

  test("stops for good on a chosen period — the one on screen included — with nothing that restarts it", async ({
    page,
  }) => {
    const reads = countMarketReads(page);
    await controlTime(page);
    await openDashboard(page, 1280);
    await expect(page.getByTestId("market-watch-row-SPY")).toBeVisible();
    await freezeTime(page);

    const current = await shown(page);
    await periodButton(page, current).click();
    await page.mouse.move(5, 5);
    await expect(period(page)).toHaveAttribute("data-auto", "off");
    await page.clock.runFor(ROTATION_MS * 4);
    await expect(period(page)).toHaveAttribute("data-period", current);

    await periodButton(page, "6M").click();
    await page.mouse.move(5, 5);
    await expect(period(page)).toHaveAttribute("data-period", "6M");
    await page.clock.runFor(ROTATION_MS * 4);
    await expect(period(page)).toHaveAttribute("data-period", "6M");
    await expect(page.getByTestId("market-watch")).not.toContainText(
      /auto|paused/i,
    );
    expect(reads.completed).toBe(1);
  });

  test("waits while the pointer is over it, and carries on when the pointer leaves", async ({
    page,
  }) => {
    await controlTime(page);
    await openDashboard(page, 1440);
    await expect(page.getByTestId("market-watch-row-SPY")).toBeVisible();
    await freezeTime(page);

    const box = await page.getByTestId("dashboard-sidebar").boundingBox();
    await page.mouse.move((box?.x ?? 0) + 100, (box?.y ?? 0) + 300);
    const held = await shown(page);
    await expect(period(page)).not.toHaveAttribute("data-rotating", "true");
    await page.clock.runFor(ROTATION_MS * 3);
    await expect(period(page)).toHaveAttribute("data-period", held);
    await expect(period(page)).toHaveAttribute("data-auto", "on");

    await page.mouse.move(5, 5);
    await page.clock.runFor(ROTATION_MS);
    await expect(period(page)).toHaveAttribute("data-period", following(held));
  });

  test("holds while keyboard focus is inside, and selects a period from the keyboard", async ({
    page,
  }) => {
    await controlTime(page);
    await openDashboard(page, 1440);
    await expect(page.getByTestId("market-watch-row-SPY")).toBeVisible();
    await page.mouse.move(5, 5);
    await freezeTime(page);

    await periodButton(page, "1W").focus();
    await expect(period(page)).not.toHaveAttribute("data-rotating", "true");
    const held = await shown(page);
    await page.clock.runFor(ROTATION_MS * 3);
    await expect(period(page)).toHaveAttribute("data-period", held);

    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(periodButton(page, "3M")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(period(page)).toHaveAttribute("data-period", "3M");
    await expect(period(page)).toHaveAttribute("data-auto", "off");
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
    await page.mouse.move(5, 5);
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

  test("does not rotate or animate for a reader who prefers reduced motion", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await controlTime(page);
    await openDashboard(page, 1440);
    await expect(page.getByTestId("market-watch-row-SPY")).toBeVisible();
    await page.mouse.move(5, 5);
    await freezeTime(page);

    await expect(period(page)).toHaveAttribute("data-auto", "off");
    await page.clock.runFor(ROTATION_MS * 3);
    await expect(period(page)).toHaveAttribute("data-period", "1W");
    await expect(period(page)).toHaveAttribute("data-phase", "idle");

    // Every period is still a click away, and a click changes it at once.
    await periodButton(page, "1M").click();
    await expect(period(page)).toHaveAttribute("data-period", "1M");
  });

  test("keeps its header and scrolls its own list on a short screen, never trapping the wheel", async ({
    page,
  }) => {
    await openDashboard(page, 1280, 768);
    const region = page.getByRole("region", { name: "Market watch ETFs" });
    await expect(page.getByTestId("market-watch-row-HYG")).toBeAttached();

    // Exactly the screen under the topbar.
    const box = await page.getByTestId("dashboard-sidebar").boundingBox();
    expect(
      Math.abs((box?.y ?? 0) + (box?.height ?? 0) - 768),
    ).toBeLessThanOrEqual(1);
    // The text stays readable: rows keep their height rather than shrinking to fit.
    const rowHeight = (
      await page.getByTestId("market-watch-row-SPY").boundingBox()
    )?.height;
    expect(rowHeight).toBeGreaterThanOrEqual(24);

    const sizes = await region.evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    if (sizes.scrollHeight > sizes.clientHeight + 1) {
      // The wheel over the list scrolls the list, with the period selector still in view …
      const area = await region.boundingBox();
      await page.mouse.move((area?.x ?? 0) + 40, (area?.y ?? 0) + 60);
      await page.mouse.wheel(0, 200);
      await expect
        .poll(() => region.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
    }
    await expect(page.getByTestId("market-watch-period")).toBeInViewport();
    // … and at its end hands the wheel back to the page.
    await region.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const area = await region.boundingBox();
    await page.mouse.move((area?.x ?? 0) + 40, (area?.y ?? 0) + 60);
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

  test("scrolls the feed with the page while the sidebar stays put, and holds the feed's heading and session under the topbar", async ({
    page,
  }) => {
    // Enough events to scroll: every QA event, each repeated over many sessions.
    await page.route(/\/dashboard\/activity(\?.*)?$/, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as DashboardActivityResponse;
      const events = Array.from({ length: 6 }, (_, copy) =>
        body.events.map((event) => ({
          ...event,
          id: `${event.id}-${copy}`,
          sessionDate: `2026-08-${String(28 - copy * 3).padStart(2, "0")}`,
        })),
      ).flat();
      await route.fulfill({ response, json: { ...body, events } });
    });
    await openDashboard(page, 1440, 800);
    await expect(
      page.getByTestId("dashboard-activity-row").nth(10),
    ).toBeAttached();
    const sidebarBefore = await page
      .getByTestId("dashboard-sidebar")
      .boundingBox();
    await page.mouse.move(400, 400);
    await page.mouse.wheel(0, 700);
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeGreaterThan(300);
    // The sidebar has not moved, and its list has not scrolled.
    const sidebarAfter = await page
      .getByTestId("dashboard-sidebar")
      .boundingBox();
    expect(sidebarAfter?.y).toBe(sidebarBefore?.y);
    expect(
      await page
        .getByRole("region", { name: "Market watch ETFs" })
        .evaluate((element) => element.scrollTop),
    ).toBe(0);
    // The card's heading with its filters sticks under the topbar (its 60px), a session heading
    // under it.
    const heading = await page
      .getByRole("heading", { level: 2, name: "Monitor activity" })
      .boundingBox();
    expect(heading?.y ?? 0).toBeGreaterThanOrEqual(64);
    expect(heading?.y ?? 999).toBeLessThan(64 + 60);
    await expect(page.getByTestId("dashboard-event-filter")).toBeInViewport();
    const stuck = await page
      .getByTestId("dashboard-session")
      .evaluateAll((all) =>
        all
          .map((element) => element.getBoundingClientRect().top)
          .filter((top) => top >= 64 + 60 - 1 && top < 64 + 60 + 24),
      );
    expect(stuck.length).toBeGreaterThan(0);
    await expectNoHorizontalScroll(page, "scrolled");
  });

  for (const width of [1280, 1366, 1920]) {
    test(`keeps every activity fact readable and reachable beside the sidebar at ${width}px`, async ({
      page,
    }) => {
      await openDashboard(page, width);
      const table = page.getByTestId("dashboard-activity");
      await expect(table.getByRole("columnheader")).toHaveText([
        "Stock",
        "Signal",
        "Conditions",
        "Monitor",
      ]);
      const rows = page.getByTestId("dashboard-activity-row");
      expect(await rows.count()).toBeGreaterThan(0);
      for (const row of await rows.all()) {
        await expect(row.getByTestId("dashboard-event-level")).toBeVisible();
        await expect(row.getByTestId("dashboard-event-state")).toBeVisible();
        await expect(row.getByTestId("dashboard-event-monitor")).toBeVisible();
        for (const line of await row.getByTestId("dashboard-condition").all()) {
          await expect(line).toBeVisible();
        }
      }
      const fit = await table.evaluate((element) => {
        const frame = element.getBoundingClientRect();
        const outside = [
          ...element.querySelectorAll<HTMLElement>(
            "a[href], [data-testid='dashboard-condition-values']",
          ),
        ]
          .filter((node) => node.getClientRects().length > 0)
          .filter((node) => {
            const box = node.getBoundingClientRect();
            return box.left < frame.left - 1 || box.right > frame.right + 1;
          })
          .map((node) => node.textContent);
        return { overflow: element.scrollWidth - element.clientWidth, outside };
      });
      expect(fit.overflow).toBeLessThanOrEqual(1);
      expect(fit.outside).toEqual([]);
      await expectNoHorizontalScroll(page, `${width}px`);
    });
  }

  test("grows a row with its conditions and never clips one, with long names and many conditions", async ({
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
        // The first event carries its predicates four times over: twelve lines, the first of them
        // a long expression.
        why:
          index === 0 && event.why
            ? {
                ...event.why,
                rules: [
                  {
                    predicates: Array.from(
                      { length: 4 },
                      () => event.why!.rules[0]!.predicates,
                    )
                      .flat()
                      .map((predicate, line) =>
                        line === 0
                          ? {
                              ...predicate,
                              description:
                                "Price is above the highest SMA 200D close of the trailing fifty-two weeks across the whole universe",
                            }
                          : predicate,
                      ),
                  },
                ],
              }
            : event.why,
      }));
      await route.fulfill({ response, json: { ...body, events } });
    });
    for (const width of [1280, 1366, 1440, 1920]) {
      await openDashboard(page, width);
      const first = page.getByTestId("dashboard-activity-row").first();
      const second = page.getByTestId("dashboard-activity-row").nth(1);
      await expect(first.getByTestId("dashboard-condition")).toHaveCount(12);
      // Every line is drawn inside its row: nothing hidden, nothing cut.
      const clipped = await first.evaluate((row) => {
        const box = row.getBoundingClientRect();
        return [
          ...row.querySelectorAll<HTMLElement>(
            "[data-testid='dashboard-condition']",
          ),
        ]
          .map((line) => line.getBoundingClientRect())
          .some((line) => line.bottom > box.bottom + 1 || line.height === 0);
      });
      expect(clipped, `${width}px`).toBe(false);
      // A row with twelve conditions is taller than one with three.
      const tall = (await first.boundingBox())?.height ?? 0;
      const short = (await second.boundingBox())?.height ?? 0;
      expect(tall, `${width}px`).toBeGreaterThan(short * 2);
      await expect(first.getByTestId("dashboard-event-monitor")).toContainText(
        "Quality Value",
      );
      // The long Monitor name wraps inside its own column, which starts under its heading, and the
      // long expression wraps inside the Conditions column.
      const contained = await page
        .getByTestId("dashboard-activity")
        .evaluate((table) => {
          const header = [
            ...table.querySelectorAll('[role="columnheader"]'),
          ].map((element) => element.getBoundingClientRect());
          return [
            ...table.querySelectorAll('[data-testid="dashboard-activity-row"]'),
          ].every((row) => {
            const cell = (name: string) =>
              row
                .querySelector(`[data-column="${name}"]`)!
                .getBoundingClientRect();
            const monitor = cell("monitor");
            const conditions = cell("conditions");
            const link = row
              .querySelector('[data-column="monitor"] a')!
              .getBoundingClientRect();
            const lines = [
              ...row.querySelectorAll('[data-testid="dashboard-condition"]'),
            ].map((line) => line.getBoundingClientRect());
            return (
              Math.abs(monitor.left - header[3]!.left) <= 1 &&
              link.left >= monitor.left - 1 &&
              link.right <= monitor.right + 1 &&
              lines.every((line) => line.right <= conditions.right + 1)
            );
          });
        });
      expect(contained, `${width}px`).toBe(true);
      const tickerClipped = await first
        .getByTestId("dashboard-stock")
        .evaluate((identity) =>
          [...identity.querySelectorAll<HTMLElement>('[class*="symbol"]')].some(
            (symbol) => symbol.scrollWidth > symbol.clientWidth + 1,
          ),
        );
      expect(tickerClipped).toBe(false);
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
