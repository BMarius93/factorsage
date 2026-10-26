import { expect, test } from "../fixtures";

/**
 * The historical universe catalog on the Lists page, for a visitor without an account
 * (`docs/decisions/historical-universes-v1.md` §6).
 *
 * Every catalog universe is shown by category; each carries a lock and a "Pro" label, and a
 * universe whose point-in-time data does not exist (the sectors) says "Historical data unavailable"
 * instead of offering a link. The economic supersectors carry a "Retrospective classification"
 * badge, their method and their disclosure. The deterministic stack holds no generated universe, so
 * every one is unavailable here — what is proven is the grouping, the messages and that the page
 * asks nothing of the provider to show them.
 */
test.describe("guest historical universes", () => {
  test("lists every catalog universe, grouped, locked, and says which have no historical data", async ({
    page,
  }) => {
    await page.goto("/lists");
    const universes = page.getByTestId("historical-universes");
    await expect(universes).toBeVisible();

    for (const [key, label] of [
      ["MARKET_INDICES", "Market Indices"],
      ["SP500_SECTORS", "S&P 500 Sectors"],
      ["ECONOMIC_SUPERSECTORS", "Economic Supersectors"],
      ["MARKET_CAPITALIZATION", "Market Cap"],
      ["INVESTMENT_STYLES", "Investment Styles"],
      ["DOW_STRATEGIES", "Dow Strategies"],
    ] as const) {
      await expect(
        universes.getByTestId(`historical-universes-${key}`),
      ).toContainText(label);
    }
    await expect(
      universes.getByTestId("historical-universes-RESEARCH"),
    ).toHaveCount(0);

    const rows = universes.getByTestId("historical-universe");
    await expect(rows).toHaveCount(26);
    // Requires Pro: a lock and "Pro" on every universe for a visitor.
    await expect(
      universes.locator(
        '[data-testid="historical-universe"][data-locked="true"]',
      ),
    ).toHaveCount(26);
    await expect(
      universes.getByTestId("universe-pro-badge").first(),
    ).toHaveText("Pro, locked");

    // Historical data unavailable: the sectors always, whatever the plan, with the reason and no link.
    const energy = universes.locator(
      '[data-universe-key="sp500-sector-energy"]',
    );
    await expect(energy).toHaveAttribute("data-availability", "UNAVAILABLE");
    await expect(energy.getByTestId("universe-unavailable")).toHaveText(
      "Historical data unavailable",
    );
    await expect(
      energy.getByTestId("universe-unavailable-reason"),
    ).toContainText("today's sectors are never applied to the past");
    await expect(energy.getByRole("link")).toHaveCount(0);
    await expect(
      energy.getByTestId("universe-retrospective-badge"),
    ).toHaveCount(0);

    // The supersectors: told apart from a point-in-time sector, whatever their availability.
    const supersectors = universes.getByTestId(
      "historical-universes-ECONOMIC_SUPERSECTORS",
    );
    await expect(supersectors.getByTestId("historical-universe")).toHaveCount(
      3,
    );
    const cyclical = supersectors.locator(
      '[data-universe-key="sp500-cyclical"]',
    );
    await expect(
      cyclical.getByTestId("universe-retrospective-badge"),
    ).toHaveText("Retrospective classification");
    await expect(
      cyclical.getByTestId("universe-classification-facts"),
    ).toContainText(
      "Underlying index: S&P 500 · Sectors: Financials, Consumer Discretionary, Materials, Real Estate",
    );
    await expect(
      cyclical.getByTestId("universe-classification-method"),
    ).toHaveText(
      "Classification method: Current sector applied retrospectively",
    );
    await expect(
      cyclical.getByTestId("universe-classification-disclosure"),
    ).toContainText("Historical S&P 500 membership with retrospective sector");
  });
});
