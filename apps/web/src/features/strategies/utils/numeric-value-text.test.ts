import { describe, expect, it } from "vitest";
import {
  numericValueText,
  parseNumericValueText,
  sameNumericValue,
} from "./numeric-value-text";

describe("the numeric Value field's text", () => {
  it.each([
    ["0.75", 0.75],
    ["-1.5", -1.5],
    ["1.25", 1.25],
    ["0", 0],
    ["-10", -10],
    ["2.50", 2.5],
    ["1e3", 1000],
  ])("reads %j as %d", (text, expected) => {
    expect(parseNumericValueText(text)).toBe(expected);
  });

  it("reads nothing typed, or a half-typed entry the input reports as empty, as no number", () => {
    expect(parseNumericValueText("")).toBeNaN();
    expect(parseNumericValueText("  ")).toBeNaN();
  });

  it("keeps the sign of a typed negative zero", () => {
    expect(Object.is(parseNumericValueText("-0"), -0)).toBe(true);
    expect(sameNumericValue(parseNumericValueText("-0"), 0)).toBe(false);
  });

  it("shows a stored number exactly, and no number as an empty field", () => {
    expect(numericValueText(0.75)).toBe("0.75");
    expect(numericValueText(-1.5)).toBe("-1.5");
    expect(numericValueText(0)).toBe("0");
    expect(numericValueText(Number.NaN)).toBe("");
  });

  it("treats no number as the same as no number", () => {
    expect(sameNumericValue(Number.NaN, Number.NaN)).toBe(true);
    expect(sameNumericValue(0.75, 0.75)).toBe(true);
    expect(sameNumericValue(0.75, 75)).toBe(false);
  });
});
