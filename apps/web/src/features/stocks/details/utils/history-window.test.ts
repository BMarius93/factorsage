import { STOCK_DETAILS_MAX_HISTORY_YEARS } from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import {
  HISTORY_EDGE_TRIGGER_BARS,
  historyRequestStart,
  mergeHistory,
} from "./history-window";

const LOADED_FROM = "2025-09-03";
/** Thirty years before the loaded window's end, as the API reports it. */
const HISTORY_START = "1996-09-03";

const dated = (date: string) => ({ date });
const dateOf = (row: { date: string }) => row.date;

describe("historyRequestStart", () => {
  it("asks for at least a year when the viewport just crosses the edge", () => {
    expect(
      historyRequestStart({
        loadedFrom: LOADED_FROM,
        barsBeforeLoaded: 1,
        historyStart: HISTORY_START,
      }),
    ).toBe("2024-09-03");
  });

  it("sizes a wide zoom-out from the empty space on screen, in one request", () => {
    // Five thousand empty bars is roughly twenty years of trading days: filling that viewport
    // must not take twenty round trips.
    const start = historyRequestStart({
      loadedFrom: LOADED_FROM,
      barsBeforeLoaded: 5000,
      historyStart: HISTORY_START,
    });

    expect(start).not.toBeNull();
    const years =
      (Date.parse(LOADED_FROM) - Date.parse(start!)) / (365.25 * 86_400_000);
    expect(years).toBeGreaterThan(19);
    expect(years).toBeLessThan(21);
  });

  it("never asks for history before the boundary", () => {
    expect(
      historyRequestStart({
        loadedFrom: "1997-01-01",
        barsBeforeLoaded: 100_000,
        historyStart: HISTORY_START,
      }),
    ).toBe(HISTORY_START);
  });

  it("has nothing left to ask for at the boundary", () => {
    expect(
      historyRequestStart({
        loadedFrom: HISTORY_START,
        barsBeforeLoaded: 500,
        historyStart: HISTORY_START,
      }),
    ).toBeNull();
  });

  it("is monotonic: more empty space never asks for less history", () => {
    const starts = [0, 50, 200, 800, 3200].map(
      (bars) =>
        historyRequestStart({
          loadedFrom: LOADED_FROM,
          barsBeforeLoaded: bars,
          historyStart: HISTORY_START,
        })!,
    );
    expect([...starts].sort().reverse()).toEqual(starts);
  });

  it("waits for real empty space before asking, not for the edge to be near", () => {
    // Framing the whole loaded series leaves a fraction of a bar of padding on the left; a
    // threshold of zero would turn that into a history request on every page view.
    expect(HISTORY_EDGE_TRIGGER_BARS).toBeGreaterThan(1);
  });
});

describe("STOCK_DETAILS_MAX_HISTORY_YEARS", () => {
  it("is the single definition of the Stock Details horizon", () => {
    expect(STOCK_DETAILS_MAX_HISTORY_YEARS).toBe(30);
  });
});

describe("mergeHistory", () => {
  it("prepends an older window in ascending date order", () => {
    expect(
      mergeHistory(
        [dated("2025-09-03"), dated("2025-09-04")],
        [dated("2024-09-03"), dated("2024-09-04")],
        dateOf,
        dateOf,
      ),
    ).toEqual([
      dated("2024-09-03"),
      dated("2024-09-04"),
      dated("2025-09-03"),
      dated("2025-09-04"),
    ]);
  });

  it("never duplicates a row at the seam between two windows", () => {
    const merged = mergeHistory(
      [dated("2025-09-03"), dated("2025-09-04")],
      [dated("2025-09-02"), dated("2025-09-03")],
      dateOf,
      dateOf,
    );

    expect(merged.map(dateOf)).toEqual([
      "2025-09-02",
      "2025-09-03",
      "2025-09-04",
    ]);
  });

  it("keys per series so one date can carry several models", () => {
    const rows = [
      { valuationDate: "2025-09-03", model: "GRAHAM", valuePerShare: 1 },
      { valuationDate: "2025-09-03", model: "DCF_FCFF", valuePerShare: 2 },
    ];
    const merged = mergeHistory(
      rows,
      [{ valuationDate: "2024-09-03", model: "GRAHAM", valuePerShare: 3 }],
      (row) => `${row.valuationDate}|${row.model}`,
      (row) => row.valuationDate,
    );

    expect(merged).toHaveLength(3);
  });

  it("leaves the existing rows untouched when the older window is empty", () => {
    const existing = [dated("2025-09-03")];
    expect(mergeHistory(existing, [], dateOf, dateOf)).toEqual(existing);
  });
});
