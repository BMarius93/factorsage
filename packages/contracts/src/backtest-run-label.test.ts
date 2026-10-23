import { describe, expect, it } from "vitest";
import { backtestRunLabel, backtestRunNumberFromSearch } from "./backtests.js";

describe("backtestRunLabel", () => {
  it("pads to four digits and grows past them rather than wrapping", () => {
    expect([1, 84, 9_999, 10_000].map(backtestRunLabel)).toEqual([
      "Run #0001",
      "Run #0084",
      "Run #9999",
      "Run #10000",
    ]);
  });
});

describe("backtestRunNumberFromSearch", () => {
  it("reads every way of naming a Run ID, the label itself included", () => {
    for (const search of [
      "Run #0012",
      "run #12",
      "RUN 12",
      "run12",
      "#12",
      "# 12",
      "0012",
      "12",
      "  Run #0012  ",
    ]) {
      expect(backtestRunNumberFromSearch(search), search).toBe(12);
    }
    expect(backtestRunNumberFromSearch(backtestRunLabel(84))).toBe(84);
  });

  it("names no run for text, a number among other words, zero or a negative", () => {
    for (const search of [
      "Value & Trend",
      "Top 12",
      "12 stocks",
      "Run #12 extra",
      "0",
      "#0000",
      "-3",
      "1.5",
      "",
      "1234567890",
    ]) {
      expect(backtestRunNumberFromSearch(search), search).toBeNull();
    }
  });
});
