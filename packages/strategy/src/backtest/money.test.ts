import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  MONEY_SCALE,
  MONEY_ZERO,
  PRICE_SCALE,
  SHARES_SCALE,
  SHARES_ULP,
  decimal,
  moneyBudget,
  moneyString,
  priceString,
  quantizeMoney,
  quantizePrice,
  quantizeSharesDown,
  sharesString,
  toNumber,
} from "./money.js";

/**
 * The boundary between float64 decisions and exact decimal records.
 *
 * Every case here is one the validation matrix actually produced or one the arithmetic makes
 * unavoidable, not an invented edge: the $1 configuration whose 2.5-cent spend was stored as three
 * cents, the sub-half-cent profit that was stored as zero and then counted as a win anyway, and the
 * $334 bn portfolio at which float64 has no sixth decimal place to store.
 */
describe("scales", () => {
  it("pins the persisted scales", () => {
    expect(MONEY_SCALE).toBe(6);
    expect(SHARES_SCALE).toBe(10);
    expect(PRICE_SCALE).toBe(8);
  });

  it("rounds half away from zero, as PostgreSQL numeric does", () => {
    // The engine and the database must agree about what rounding means, or a value written by one
    // is not the value the other reads back.
    expect(moneyString(quantizeMoney("0.0000005"))).toBe("0.000001");
    expect(moneyString(quantizeMoney("-0.0000005"))).toBe("-0.000001");
    expect(moneyString(quantizeMoney("0.0000015"))).toBe("0.000002");
    expect(moneyString(quantizeMoney("0.0000004"))).toBe("0.000000");
  });

  it("is immune to another package changing decimal.js global configuration", () => {
    // `decimal.js` keeps rounding on the constructor, so it is global state any package in the
    // process can change. The ledger uses a clone precisely so this cannot reach it.
    const globalRounding = Decimal.rounding;
    Decimal.set({ rounding: Decimal.ROUND_DOWN });
    try {
      expect(Decimal.rounding).toBe(Decimal.ROUND_DOWN);
      // Half still rounds away from zero here, matching PostgreSQL, despite the global change.
      expect(moneyString(quantizeMoney("0.0000005"))).toBe("0.000001");
      expect(moneyString(quantizeMoney("-0.0000005"))).toBe("-0.000001");
    } finally {
      Decimal.set({ rounding: globalRounding });
    }
  });
});

describe("the $1 configuration the matrix broke on", () => {
  it("keeps a 2.5-cent spend as 2.5 cents instead of rounding it to three", () => {
    // Decimal(20,2) stored 0.025 as 0.03 — a 20% error that then propagated into average cost.
    expect(moneyString(quantizeMoney(0.025))).toBe("0.025000");
    expect(moneyString(quantizeMoney(0.025))).not.toBe("0.030000");
  });

  it("keeps a sub-half-cent profit positive instead of collapsing it to zero", () => {
    const profit = quantizeMoney("0.004");
    expect(profit.gt(MONEY_ZERO)).toBe(true);
    expect(moneyString(profit)).toBe("0.004000");
  });

  it("keeps a sub-half-cent loss negative", () => {
    const loss = quantizeMoney("-0.004");
    expect(loss.lt(MONEY_ZERO)).toBe(true);
    expect(moneyString(loss)).toBe("-0.004000");
  });

  it("reconstructs the exact average cost the matrix reported as a 29.8 error", () => {
    // `IBM 2016-09-09: averageCostAfter 148.84 but (0.00 + 0.03) / 0.0001679656 = 178.61`
    const price = quantizePrice("148.84");
    const shares = quantizeSharesDown(decimal("0.025").div(price));
    const amount = quantizeMoney(shares.times(price));
    expect(amount.div(shares).toDecimalPlaces(PRICE_SCALE).toNumber()).toBeCloseTo(148.84, 4);
  });
});

describe("magnitudes float64 cannot hold", () => {
  const HUGE = "334310721745.960000"; // the largest portfolio the matrix observed

  it("round-trips a $334bn value exactly, which a JS number cannot", () => {
    const exact = quantizeMoney(HUGE);
    expect(moneyString(exact)).toBe(HUGE);
    // Proof that the number path loses it: 12 integer digits + 6 decimals is 18 significant
    // digits, and float64 carries about 15.95.
    expect(String(Number(HUGE))).not.toBe(HUGE);
  });

  it("survives arithmetic at that magnitude", () => {
    const value = quantizeMoney(HUGE);
    const after = quantizeMoney(value.minus("0.000001"));
    expect(moneyString(after)).toBe("334310721745.959999");
    expect(moneyString(quantizeMoney(after.plus("0.000001")))).toBe(HUGE);
  });

  it("holds the largest observed share quantity exactly", () => {
    // 2,415,434,113.5728870 is 17 significant digits — already beyond float64.
    const shares = "2415434113.5728870000";
    expect(sharesString(quantizeSharesDown(shares))).toBe(shares);
  });

  it("is unaffected by the MAX_SAFE_INTEGER limit that breaks Math.round(x * 1e6)", () => {
    // Math.round of a non-safe integer returns its argument, so the naive normalizer silently
    // becomes the identity function above $9,007,199,254.74.
    const beyond = 334310721745.96;
    expect(Number.isSafeInteger(Math.round(beyond * 1e6))).toBe(false);
    expect(moneyString(quantizeMoney("334310721745.9600004"))).toBe(HUGE);
  });
});

describe("share rounding direction is a correctness rule", () => {
  it("always truncates, so shares x price can never exceed the spend", () => {
    const price = quantizePrice("3.00000000");
    const shares = quantizeSharesDown(decimal("1").div(price)); // 0.3333333333...
    expect(sharesString(shares)).toBe("0.3333333333");
    expect(quantizeMoney(shares.times(price)).lte(quantizeMoney(1))).toBe(true);
  });

  it("exposes one ulp for a cash-guard retreat", () => {
    expect(sharesString(SHARES_ULP)).toBe("0.0000000001");
  });
});

describe("canonical strings", () => {
  it("uses a fixed scale so 1 and 1.0 are the same stored value", () => {
    expect(moneyString(quantizeMoney(1))).toBe("1.000000");
    expect(moneyString(quantizeMoney("1.0"))).toBe("1.000000");
    expect(sharesString(quantizeSharesDown(2))).toBe("2.0000000000");
    expect(priceString(quantizePrice(7))).toBe("7.00000000");
  });

  it("converts to a number only where a ratio or a display value is wanted", () => {
    expect(toNumber(quantizeMoney("12.5"))).toBe(12.5);
    expect(toNumber("12.500000")).toBe(12.5);
  });
});

describe("the reconciliation budget", () => {
  it("is built from declared scales, not chosen to make a case pass", () => {
    // One money ulp, plus the price scale amplified by the share count, plus a float term.
    expect(moneyBudget(1, 0)).toBeCloseTo(1e-6, 12);
    expect(moneyBudget(0, 2_415_434_113)).toBeCloseTo(1e-6 + 24.15434113, 6);
    expect(moneyBudget(334_310_721_745.96)).toBeGreaterThan(1e-6);
  });

  it("grows with magnitude, because a reader passing through float64 cannot do better", () => {
    expect(moneyBudget(334_310_721_745.96)).toBeGreaterThan(moneyBudget(1));
  });
});
