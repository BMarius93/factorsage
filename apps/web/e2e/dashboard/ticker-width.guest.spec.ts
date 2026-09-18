import { expect, test, type Page } from "@playwright/test";
import { serveLogosAsMissing } from "../utils/logos";

/**
 * The column that identifies a signal stays legible at laptop widths (UX-007).
 *
 * At 1280 px the Stock column used to be squeezed to "U." / "QATE…" by its neighbours. From the
 * table breakpoint up, every row must show its whole ticker — `QATEST1` is seven characters, a
 * stricter case than any real symbol — while the company name and the entity chips may truncate.
 *
 * Needs `pnpm test:securities:seed && pnpm test:builtins:seed`.
 */

type TickerMeasure = {
  readonly text: string;
  readonly scrollWidth: number;
  readonly clientWidth: number;
  readonly textOverflow: string;
};

async function measureTickers(page: Page): Promise<TickerMeasure[]> {
  return page.getByTestId("dashboard-stock").evaluateAll((identities) =>
    identities.map((identity) => {
      // Mark, then a text block whose first line is the ticker.
      const symbol = identity.querySelector(
        ":scope > span:last-child > span:first-child",
      ) as HTMLElement;
      return {
        text: symbol.textContent ?? "",
        scrollWidth: symbol.scrollWidth,
        clientWidth: symbol.clientWidth,
        textOverflow: getComputedStyle(symbol).textOverflow,
      };
    }),
  );
}

for (const viewport of [
  { width: 880, height: 800 },
  { width: 1024, height: 768 },
  { width: 1280, height: 900 },
  { width: 1440, height: 900 },
]) {
  test(`shows every full ticker at ${viewport.width}px without page overflow`, async ({
    page,
  }) => {
    await serveLogosAsMissing(page);
    await page.setViewportSize(viewport);
    await page.goto("/dashboard");
    const rows = page
      .getByTestId("dashboard-signal-row")
      .filter({ hasText: /QA Built-in Monitor/ });
    await expect(rows).toHaveCount(3);
    // The table, not the phone cards.
    await expect(
      page.getByTestId("dashboard-signals").getByRole("columnheader").first(),
    ).toBeVisible();

    const tickers = await measureTickers(page);
    expect(tickers.map((ticker) => ticker.text)).toContain("QATEST1");
    for (const ticker of tickers) {
      // The whole symbol is rendered and none of it is clipped behind an ellipsis.
      expect(ticker.text, JSON.stringify(ticker)).toMatch(/^[A-Z0-9.-]+$/);
      expect(
        ticker.scrollWidth,
        `${ticker.text} is clipped: ${ticker.scrollWidth}px of text in ${ticker.clientWidth}px`,
      ).toBeLessThanOrEqual(ticker.clientWidth);
    }
    const qatest1 = tickers.filter((ticker) => ticker.text === "QATEST1");
    expect(qatest1.length).toBeGreaterThan(0);

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  });
}
