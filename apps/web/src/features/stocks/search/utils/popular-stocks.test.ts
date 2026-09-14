import { describe, expect, it } from "vitest";
import {
  POPULAR_STOCK_SEARCHES,
  POPULAR_STOCK_SEARCH_COUNT,
  popularStockSearches,
} from "./popular-stocks";

describe("popularStockSearches", () => {
  it("shows the head of the pool when nothing is excluded", () => {
    expect(popularStockSearches().map((entry) => entry.symbol)).toEqual(
      POPULAR_STOCK_SEARCHES.slice(0, POPULAR_STOCK_SEARCH_COUNT).map(
        (entry) => entry.symbol,
      ),
    );
  });

  it("drops an excluded stock and backfills from further down the pool", () => {
    const shown = popularStockSearches(["AAPL", "NVDA"]).map(
      (entry) => entry.symbol,
    );

    expect(shown).not.toContain("AAPL");
    expect(shown).not.toContain("NVDA");
    // The section keeps its height rather than shrinking to make room for the recents above it.
    expect(shown).toHaveLength(POPULAR_STOCK_SEARCH_COUNT);
    expect(shown).toEqual(["MSFT", "AMZN", "GOOGL"]);
  });

  it("matches case-insensitively and ignores surrounding whitespace", () => {
    expect(
      popularStockSearches([" aapl "]).map((entry) => entry.symbol),
    ).not.toContain("AAPL");
  });

  it("holds enough shortcuts to survive a full set of recents", () => {
    // Five recents is the product maximum; the pool must still fill the popular section.
    expect(
      popularStockSearches(
        POPULAR_STOCK_SEARCHES.slice(0, 5).map((entry) => entry.symbol),
      ),
    ).toHaveLength(POPULAR_STOCK_SEARCH_COUNT);
  });
});
