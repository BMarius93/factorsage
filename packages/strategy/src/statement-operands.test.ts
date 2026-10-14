import { describe, expect, it } from "vitest";
import {
  fundamentalMetricOperand,
  marginOfSafetyOperand,
  operandsReadStatements,
  PRICE_OPERAND,
  relativeVolumeOperand,
  seriesOperand,
  valuationRatioOperand,
} from "./operands.js";

/**
 * Which operands need the statements kept current. The stock EOD preparation reads this to decide
 * whether a security's statements are refreshed at all, so a wrong `false` would leave an intrinsic
 * value or a ratio on stale filings, and a wrong `true` would spend six provider requests a day on
 * a security nobody reads a statement of.
 */
describe("operandsReadStatements", () => {
  it("is false for prices, technicals and relative volume", () => {
    expect(
      operandsReadStatements([
        PRICE_OPERAND,
        seriesOperand("SMA_200D"),
        seriesOperand("RSI_14D"),
        relativeVolumeOperand(20),
      ]),
    ).toBe(false);
  });

  it("is true for an intrinsic-value model or blend series", () => {
    expect(operandsReadStatements([seriesOperand("DCF_FCFF")])).toBe(true);
    expect(operandsReadStatements([seriesOperand("BALANCED")])).toBe(true);
  });

  it("is true for a Margin of Safety, a Fundamental Metric and a valuation ratio", () => {
    expect(
      operandsReadStatements([marginOfSafetyOperand("BALANCED")]),
    ).toBe(true);
    expect(
      operandsReadStatements([fundamentalMetricOperand("ROE_TTM")]),
    ).toBe(true);
    expect(
      operandsReadStatements([valuationRatioOperand("PRICE_TO_EARNINGS_TTM")]),
    ).toBe(true);
  });
});
