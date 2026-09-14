import { describe, expect, it } from "vitest";
import {
  isSafeLogoSymbol,
  normalizeLogoSymbol,
  stockLogoLocation,
  stockLogoSrc,
} from "./stock-logo";

describe("normalizeLogoSymbol", () => {
  it("is the ticker the endpoint is addressed by", () => {
    expect(normalizeLogoSymbol("  aapl ")).toBe("AAPL");
    expect(normalizeLogoSymbol("brk-b")).toBe("BRK-B");
  });
});

describe("isSafeLogoSymbol", () => {
  it("accepts the shapes a real ticker takes", () => {
    for (const symbol of ["AAPL", "BRK-B", "BF.B", "F", "GOOGL", "A1B2"]) {
      expect(isSafeLogoSymbol(symbol)).toBe(true);
    }
  });

  it("rejects anything that would change the upstream request", () => {
    for (const symbol of [
      "",
      "../secret",
      "AAPL/../../etc",
      "AA PL",
      "AAPL?x=1",
      "AAPL#f",
      "AA%2FPL",
      "aapl", // normalization is the caller's job; the test guards the raw predicate
      "A".repeat(21),
    ]) {
      expect(isSafeLogoSymbol(symbol)).toBe(false);
    }
  });
});

describe("stockLogoSrc", () => {
  it("resolves every routable ticker to the product's own endpoint", () => {
    expect(stockLogoSrc("aapl")).toBe("/api/logo/AAPL");
    expect(stockLogoSrc(" brk-b ")).toBe("/api/logo/BRK-B");
  });

  it("is the same URL whether or not the catalog projected a mark", () => {
    // One cache entry per security is the whole point: a search row that carries the persisted
    // logo and a backtest row that carries none must ask for the identical asset.
    expect(
      stockLogoSrc(
        "AAPL",
        "https://images.financialmodelingprep.com/symbol/AAPL.png",
      ),
    ).toBe(stockLogoSrc("AAPL"));
  });

  it("never lets a provider URL reach the browser for a routable ticker", () => {
    const src = stockLogoSrc("MSFT", "https://example.test/msft.png");
    expect(src).toBe("/api/logo/MSFT");
    expect(src).not.toContain("example.test");
  });

  it("falls back to the projected mark when the ticker cannot be routed", () => {
    // The endpoint would refuse this symbol, so a cross-origin image — losing only the
    // brightness check — beats showing initials for a security the catalog has a mark for.
    expect(stockLogoSrc("BRK B", "https://example.test/brk.png")).toBe(
      "https://example.test/brk.png",
    );
  });

  it("renders the monogram with no request at all when there is nothing to try", () => {
    expect(stockLogoSrc("BRK B")).toBeUndefined();
    expect(stockLogoSrc("")).toBeUndefined();
    expect(stockLogoSrc("BRK B", "")).toBeUndefined();
  });
});

describe("stockLogoLocation", () => {
  it("escapes the ticker it interpolates", () => {
    expect(stockLogoLocation("BF.B")).toBe("/api/logo/BF.B");
  });
});
