import { expect, test } from "../fixtures";
import { watchForIssues } from "../utils/page-issues";

/**
 * Stock Details V3 for a signed-out visitor: the page is free to read, so the chart and every
 * financial card load exactly as for a member, independently of each other; only adding the stock
 * to a list asks for an account.
 */

const QA_SYMBOL = "QATEST1";

test.describe("Guest Stock Details V3", () => {
  test("reads the chart and every financial card without an account", async ({
    page,
  }) => {
    const issues = watchForIssues(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/stocks/${QA_SYMBOL}`);

    await expect(page.getByTestId("stock-research")).toBeVisible();
    for (const title of [
      "Intrinsic value",
      "Valuation ratios",
      "Technicals",
      "Fundamentals",
      "Key facts",
    ]) {
      await expect(
        page.getByRole("heading", { level: 2, name: title, exact: true }),
      ).toBeVisible();
    }
    const chart = page.getByRole("img", {
      name: new RegExp(`${QA_SYMBOL} daily closing price chart`),
    });
    await expect(chart.locator("..").first()).toHaveAttribute(
      "data-loading",
      "false",
    );
    // One column on a phone, nothing wider than the screen.
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
    ).toBe(0);

    // A card's row still puts its series on the chart for a visitor.
    await page.getByTestId("valuation-ratio-PRICE_TO_SALES_TTM").click();
    await expect(chart.locator("..").first()).toHaveAttribute(
      "data-valuation",
      "PRICE_TO_SALES_TTM",
    );

    // Adding to a list is the one thing that asks for an account.
    await page.getByTestId("add-to-list-button").click();
    await expect(
      page.getByText("Sign in to add this stock to a list"),
    ).toBeVisible();

    expect(issues.pageErrors).toEqual([]);
    expect(
      issues.failedRequests.filter((request) => !request.includes("/auth/")),
    ).toEqual([]);
  });
});
