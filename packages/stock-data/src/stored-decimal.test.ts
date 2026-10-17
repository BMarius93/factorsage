import { describe, expect, it } from "vitest";
import { quantizeToStoredDecimal } from "./stored-decimal.js";

describe("a double at the stock path's storage scale", () => {
  it("rounds a running mean's residue away", () => {
    expect(quantizeToStoredDecimal(14.690000000000033)).toBe(14.69);
    expect(quantizeToStoredDecimal(14.680000000000001)).toBe(14.68);
    expect(quantizeToStoredDecimal(0.1 + 0.2)).toBe(0.3);
  });

  it("rounds half away from zero at the eighth place, as numeric(20, 8) does", () => {
    expect(quantizeToStoredDecimal(1.234567885)).toBe(1.23456789);
    expect(quantizeToStoredDecimal(-1.234567885)).toBe(-1.23456789);
    expect(quantizeToStoredDecimal(1.234567884)).toBe(1.23456788);
    expect(quantizeToStoredDecimal(0.000000005)).toBe(0.00000001);
    expect(quantizeToStoredDecimal(0.000000004)).toBe(0);
  });

  it("keeps values already at the scale, large magnitudes and the exponent forms", () => {
    expect(quantizeToStoredDecimal(105.12345678)).toBe(105.12345678);
    expect(quantizeToStoredDecimal(123_456_789_012.5)).toBe(123_456_789_012.5);
    expect(quantizeToStoredDecimal(1.5e-7)).toBe(0.00000015);
    expect(quantizeToStoredDecimal(7.5e-9)).toBe(0.00000001);
    expect(quantizeToStoredDecimal(2.5e-9)).toBe(0);
    expect(quantizeToStoredDecimal(100)).toBe(100);
  });

  it("leaves absence and zero alone", () => {
    expect(quantizeToStoredDecimal(Number.NaN)).toBeNaN();
    expect(quantizeToStoredDecimal(0)).toBe(0);
  });
});
