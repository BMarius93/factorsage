import type {
  BacktestRunPageResponse,
  BacktestRunSummaryResponse,
} from "@intrinsic/contracts";
import { expect, test, type Page } from "../fixtures";
import { apiBaseUrl } from "../utils/entitlements";

/**
 * The Backtests collection, a page at a time (`GET /backtests?page=`).
 *
 * Against the real API: the page only ever asks for a page — never the whole history — and what it
 * shows is what the API ordered and filtered. With an injected eighty-run history (the hermetic
 * API's real rows are the templates): the view lives in the URL, survives a reload, moves with Back
 * and Forward, and every control asks for exactly the view it shows. The paging itself is proven
 * against the database in `backtests.integration.test.ts`.
 */

const RUNS = new RegExp(
  `^${apiBaseUrl().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/backtests(\\?.*)?$`,
);

const WIDTHS = [390, 880, 1280, 1440, 1920] as const;

async function dismissConsent(page: Page) {
  const reject = page.getByTestId("consent-reject");
  if (await reject.isVisible().catch(() => false)) {
    await reject.click();
  }
}

/** Every collection read the page made, as its query string. */
function recordReads(page: Page): string[] {
  const reads: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" && RUNS.test(request.url())) {
      reads.push(url.search);
    }
  });
  return reads;
}

function strategyNames(page: Page) {
  return page
    .getByTestId("backtest-card")
    .locator('[data-column="run"] a[href^="/backtests/"] > span:first-child');
}

test.describe("Backtests collection against the API", () => {
  test("asks only for pages, and shows what the API ordered and filtered", async ({
    page,
  }) => {
    const reads = recordReads(page);
    await page.goto("/backtests");
    await dismissConsent(page);
    const section = page.getByTestId("your-backtests");
    await expect(section).toHaveAttribute("data-density", "compact");
    await expect(page.getByTestId("backtest-card").first()).toBeVisible({
      timeout: 20_000,
    });

    // Never the whole history: every read names a page.
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((search) => /[?&]page=\d+/.test(search))).toBe(true);

    // Completed runs only: the filter is the API's, and the count says how many of how many.
    await page.getByTestId("backtests-status").selectOption("COMPLETED");
    await expect(page).toHaveURL(/\/backtests\?status=COMPLETED$/);
    await expect(page.getByTestId("backtests-count")).toContainText(" of ");
    for (const badge of await page.getByTestId("backtest-card-status").all()) {
      await expect(badge).toHaveAttribute("data-status", "COMPLETED");
    }

    // Best CAGR first, across the history, from the column header.
    await section
      .getByRole("columnheader", { name: /CAGR/ })
      .getByRole("button")
      .click();
    await expect(page).toHaveURL(/sort=cagr/);
    await expect(
      section.getByRole("columnheader", { name: /CAGR/ }),
    ).toHaveAttribute("aria-sort", "descending");
    const cagrs = await page
      .getByTestId("backtest-card")
      .locator('[data-column="cagr"]')
      .evaluateAll((cells) =>
        cells
          .map((cell) => cell.textContent?.replace(/[^0-9.+-]/g, "") ?? "")
          .filter((text) => text !== "" && text !== "-")
          .map(Number),
      );
    expect(cagrs).toEqual([...cagrs].sort((a, b) => b - a));
    expect(reads.every((search) => /[?&]page=\d+/.test(search))).toBe(true);
  });

  test("keeps one section surface, rows stacked inside it, at every width", async ({
    page,
  }) => {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/backtests");
      await dismissConsent(page);
      const section = page.getByTestId("your-backtests");
      await expect(section.getByTestId("backtest-card").first()).toBeVisible({
        timeout: 20_000,
      });
      const layout = await section.evaluate((element) => {
        const row = element.querySelector<HTMLElement>(
          '[data-testid="backtest-card"]',
        )!;
        return {
          overflow: document.documentElement.scrollWidth - window.innerWidth,
          sectionBorder: getComputedStyle(element).borderTopWidth,
          rowRadius: getComputedStyle(row).borderTopLeftRadius,
        };
      });
      expect(
        layout.overflow,
        `${width}px: no sideways scroll`,
      ).toBeLessThanOrEqual(0);
      expect(layout.sectionBorder, `${width}px: section border`).toBe("1px");
      expect(layout.rowRadius, `${width}px: row radius`).toBe("0px");
    }
  });
});

test.describe("Backtests collection view in the URL", () => {
  /**
   * An eighty-run history answered from the real API's own rows: a page of it per request, as the
   * request asked, so the browser's paging, the address bar and the footer can be followed
   * deterministically.
   */
  async function injectHistory(page: Page): Promise<string[]> {
    const asked: string[] = [];
    await page.route(RUNS, async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() !== "GET" || !url.searchParams.has("page")) {
        await route.fallback();
        return;
      }
      asked.push(url.search);
      const real = (await (
        await route.fetch({
          url: `${apiBaseUrl()}/backtests?page=1&pageSize=1`,
        })
      ).json()) as BacktestRunPageResponse;
      const template = real.runs[0];
      if (!template) {
        throw new Error("The persona has no run to use as a template.");
      }
      const q = url.searchParams.get("q");
      const all: BacktestRunSummaryResponse[] = Array.from(
        { length: 80 },
        (_, index) => ({
          ...template,
          id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          strategyName: `History ${String(index + 1).padStart(2, "0")}`,
          status: "COMPLETED" as const,
        }),
      ).filter((run) => q === null || run.strategyName.includes(q));
      const pageSize = Number(url.searchParams.get("pageSize") ?? 25);
      const pageCount = Math.max(1, Math.ceil(all.length / pageSize));
      const number = Math.min(
        Number(url.searchParams.get("page") ?? 1),
        pageCount,
      );
      await route.fulfill({
        json: {
          runs: all.slice((number - 1) * pageSize, number * pageSize),
          page: number,
          pageSize,
          totalCount: all.length,
          pageCount,
          unfilteredCount: 80,
          q,
          status: null,
          sort: "newest",
        } satisfies BacktestRunPageResponse,
      });
    });
    return asked;
  }

  test("restores page and size from the URL, and moves with Back and Forward", async ({
    page,
  }) => {
    const asked = await injectHistory(page);
    await page.goto("/backtests?page=2&pageSize=10");
    await dismissConsent(page);
    const footer = page.getByTestId("backtests-footer");
    await expect(footer).toContainText("Showing 11–20 of 80 runs");
    await expect(footer.getByLabel("Rows")).toHaveValue("10");
    await expect(strategyNames(page).first()).toHaveText("History 11");
    expect(asked.at(-1)).toContain("page=2&pageSize=10");

    await footer.getByRole("button", { name: "Next" }).click();
    await expect(page).toHaveURL(/\/backtests\?page=3&pageSize=10$/);
    await expect(strategyNames(page).first()).toHaveText("History 21");

    // A reload keeps the reader where they were.
    await page.reload();
    await expect(strategyNames(page).first()).toHaveText("History 21");

    await page.goBack();
    await expect(page).toHaveURL(/\/backtests\?page=2&pageSize=10$/);
    await expect(strategyNames(page).first()).toHaveText("History 11");
    await page.goForward();
    await expect(strategyNames(page).first()).toHaveText("History 21");

    // A new size starts again from the first page.
    await footer.getByLabel("Rows").selectOption("50");
    await expect(page).toHaveURL(/\/backtests\?pageSize=50$/);
    await expect(strategyNames(page)).toHaveCount(50);
    await expect(footer).toContainText("Page 1 of 2");
  });

  test("searches the whole history, says how many match, and clears", async ({
    page,
  }) => {
    const asked = await injectHistory(page);
    await page.goto("/backtests?page=3");
    await dismissConsent(page);
    await expect(strategyNames(page).first()).toHaveText("History 51");

    await page.getByTestId("backtests-search").fill("History 7");
    // One read for the search once typing pauses, from the first page.
    await expect(page).toHaveURL(/\/backtests\?q=History\+7$/);
    // History 70 to History 79.
    await expect(page.getByTestId("backtests-count")).toHaveText(
      "10 of 80 runs",
    );
    await expect(strategyNames(page)).toHaveCount(10);
    // Ten runs fit on the smallest page: no footer.
    await expect(page.getByTestId("backtests-footer")).toHaveCount(0);
    expect(asked.filter((search) => search.includes("q=")).length).toBe(1);

    await page.getByTestId("backtests-search").fill("Nothing like this");
    await expect(page.getByTestId("backtests-filtered-empty")).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page).toHaveURL(/\/backtests$/);
    await expect(page.getByTestId("backtests-search")).toHaveValue("");
    await expect(page.getByTestId("backtests-count")).toHaveText("80 runs");
  });
});
