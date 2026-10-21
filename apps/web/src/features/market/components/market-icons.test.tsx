import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { marketOverviewFixture } from "../__testing__/market-overview";
import { MarketIcon, marketIconKind } from "./market-icons";

describe("market icons", () => {
  it("gives each of the twenty funds the mark of the market it tracks", () => {
    const kinds = Object.fromEntries(
      marketOverviewFixture()
        .groups.flatMap((group) => group.instruments)
        .map((instrument) => [
          instrument.ticker,
          marketIconKind(instrument.ticker),
        ]),
    );
    expect(kinds).toEqual({
      SPY: "index",
      QQQ: "index",
      DIA: "index",
      IWM: "index",
      RSP: "index",
      XLK: "technology",
      XLF: "financials",
      XLE: "energy",
      XLV: "healthcare",
      XLI: "industrials",
      XLY: "consumer-discretionary",
      XLP: "consumer-staples",
      XLU: "utilities",
      XLB: "materials",
      XLRE: "real-estate",
      XLC: "communications",
      GLD: "gold",
      USO: "oil",
      TLT: "bonds",
      HYG: "bonds",
    });
  });

  it("falls back to a neutral mark for a ticker it does not know", () => {
    expect(marketIconKind("VTI")).toBe("market");
  });

  it("is local, decorative markup: no image request and nothing announced", () => {
    const { container } = render(<MarketIcon ticker="XLK" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("focusable")).toBe("false");
    expect(container.querySelector("img, image, use")).toBeNull();
  });
});
