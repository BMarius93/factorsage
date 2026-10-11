import { describe, expect, it } from "vitest";
import {
  benchmarkExDateHold,
  changesStoredBenchmarkBars,
} from "./benchmark-price-basis.js";

const bar = (date: string, close: number) => ({ date, close });
const full = (date: string, close: number, volume = 1_000) => ({
  date,
  open: close,
  high: close,
  low: close,
  close,
  volume,
});

describe("changesStoredBenchmarkBars", () => {
  const stored = [
    full("2026-10-05", 100),
    full("2026-10-06", 101),
    full("2026-10-07", 102),
  ];

  it("changes nothing when every loaded bar reads exactly as stored", () => {
    expect(changesStoredBenchmarkBars(stored, stored)).toBe(false);
  });

  it("changes the history when a session is new, which is what every tail refresh brings", () => {
    expect(
      changesStoredBenchmarkBars(stored, [...stored, full("2026-10-08", 103)]),
    ).toBe(true);
  });

  it("changes the history when any field of a stored bar differs", () => {
    expect(
      changesStoredBenchmarkBars(stored, [
        full("2026-10-05", 100),
        full("2026-10-06", 101, 2_000),
        full("2026-10-07", 102),
      ]),
    ).toBe(true);
    expect(
      changesStoredBenchmarkBars(stored, [
        full("2026-10-05", 100),
        full("2026-10-06", 101),
        { ...full("2026-10-07", 102), high: 103 },
      ]),
    ).toBe(true);
  });

  it("reads a value carrying more digits than are stored as unchanged", () => {
    expect(
      changesStoredBenchmarkBars(stored, [
        full("2026-10-05", 100.0000000001),
        full("2026-10-06", 101),
        full("2026-10-07", 102),
      ]),
    ).toBe(false);
  });

  it("changes nothing when the provider returned nothing", () => {
    expect(changesStoredBenchmarkBars(stored, [])).toBe(false);
  });
});

describe("benchmarkExDateHold", () => {
  it("holds a split-sized move at the newest edge until four sessions stand after it", () => {
    const hold = benchmarkExDateHold({
      newestStored: bar("2026-10-05", 100),
      loaded: [
        bar("2026-10-06", 101),
        bar("2026-10-07", 25.5),
        bar("2026-10-08", 25.6),
      ],
    });
    expect(hold.heldFrom).toBe("2026-10-07");
    expect(hold.rows.map((row) => row.date)).toEqual(["2026-10-06"]);
  });

  it("saves the move once it has stood for four sessions", () => {
    const hold = benchmarkExDateHold({
      newestStored: bar("2026-10-05", 100),
      loaded: [
        bar("2026-10-06", 25),
        bar("2026-10-07", 25.1),
        bar("2026-10-08", 25.2),
        bar("2026-10-09", 25.3),
      ],
    });
    expect(hold.heldFrom).toBeUndefined();
    expect(hold.rows).toHaveLength(4);
  });

  it("never holds bars older than the stored history: a prefix has no newest edge", () => {
    const hold = benchmarkExDateHold({
      newestStored: bar("2026-10-09", 100),
      loaded: [bar("2001-01-02", 100), bar("2001-01-03", 20)],
    });
    expect(hold.heldFrom).toBeUndefined();
    expect(hold.rows).toHaveLength(2);
  });

  it("leaves ordinary moves alone", () => {
    const hold = benchmarkExDateHold({
      newestStored: bar("2026-10-05", 100),
      loaded: [bar("2026-10-06", 90), bar("2026-10-07", 110)],
    });
    expect(hold.heldFrom).toBeUndefined();
  });
});
