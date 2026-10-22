import { describe, expect, it } from "vitest";
import { previewChartPaths } from "./preview-chart";

function points(path: string): [number, number][] {
  return [...path.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((match) => [
    Number(match[1]),
    Number(match[2]),
  ]);
}

describe("previewChartPaths", () => {
  const box = { width: 500, height: 200 };

  it("spans the box by date, and maps both lines onto one value axis", () => {
    const paths = previewChartPaths(
      [
        { date: "2020-01-01", strategyValue: 100, benchmarkValue: 100 },
        { date: "2020-01-11", strategyValue: 200, benchmarkValue: 150 },
        { date: "2020-01-31", strategyValue: 300, benchmarkValue: 120 },
      ],
      box,
    );
    if (!paths) {
      throw new Error("expected paths");
    }
    const strategy = points(paths.strategy);
    expect(strategy.map(([x]) => x)).toEqual([0, 166.7, 500]);
    // Highest value nearest the top, lowest nearest the bottom, both inside the frame.
    const [start, , end] = strategy;
    expect(end?.[1]).toBeLessThan(start?.[1] as number);
    for (const [, y] of strategy) {
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(box.height);
    }
    // One axis: equal values sit at equal heights on both lines.
    expect(points(paths.benchmark ?? "")[0]?.[1]).toBe(start?.[1]);
    expect(paths.strategyArea.endsWith("L500 200 L0 200 Z")).toBe(true);
  });

  it("breaks the benchmark at a gap instead of bridging it", () => {
    const paths = previewChartPaths(
      [
        { date: "2020-01-01", strategyValue: 1, benchmarkValue: 1 },
        { date: "2020-01-02", strategyValue: 2, benchmarkValue: null },
        { date: "2020-01-03", strategyValue: 3, benchmarkValue: 2 },
        { date: "2020-01-04", strategyValue: 4, benchmarkValue: 3 },
      ],
      box,
    );
    expect(paths?.benchmark?.match(/M/g)).toHaveLength(2);
  });

  it("draws no benchmark for a run that never recorded one", () => {
    const paths = previewChartPaths(
      [
        { date: "2020-01-01", strategyValue: 1, benchmarkValue: null },
        { date: "2020-02-01", strategyValue: 2, benchmarkValue: null },
      ],
      box,
    );
    expect(paths?.benchmark).toBeNull();
  });

  it("draws a flat run across the middle rather than dividing by zero", () => {
    const paths = previewChartPaths(
      [
        { date: "2020-01-01", strategyValue: 5, benchmarkValue: 5 },
        { date: "2020-02-01", strategyValue: 5, benchmarkValue: 5 },
      ],
      box,
    );
    for (const [, y] of points(paths?.strategy ?? "")) {
      expect(y).toBe(100);
    }
  });

  it("has nothing to draw for fewer than two points", () => {
    expect(previewChartPaths([], box)).toBeNull();
    expect(
      previewChartPaths(
        [{ date: "2020-01-01", strategyValue: 1, benchmarkValue: 1 }],
        box,
      ),
    ).toBeNull();
  });
});
