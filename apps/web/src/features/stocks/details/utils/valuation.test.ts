import type {
  IntrinsicValueBlendResponse,
  IntrinsicValueResponse,
} from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import { selectLatestValuations, upsideFraction } from "./valuation";

function model(
  modelId: IntrinsicValueResponse["model"],
  valuationDate: string,
  valuePerShare: number,
): IntrinsicValueResponse {
  return {
    valuationDate,
    sourceDataAsOf: `${valuationDate}T00:00:00.000Z`,
    model: modelId,
    valuePerShare,
    currency: "USD",
  };
}

function blend(
  blendId: IntrinsicValueBlendResponse["blendId"],
  valuationDate: string,
  valuePerShare: number,
): IntrinsicValueBlendResponse {
  return {
    valuationDate,
    sourceDataAsOf: `${valuationDate}T00:00:00.000Z`,
    blendId,
    valuePerShare,
    currency: "USD",
  };
}

describe("selectLatestValuations", () => {
  it("keeps the newest point per model and per blend", () => {
    const snapshot = selectLatestValuations(
      [
        model("DCF_FCFF", "2026-08-27", 250),
        model("DCF_FCFF", "2026-08-28", 260),
        model("GRAHAM", "2026-08-28", 180),
      ],
      [blend("BALANCED", "2026-08-27", 240), blend("BALANCED", "2026-08-28", 245)],
    );

    expect(snapshot?.asOfDate).toBe("2026-08-28");
    expect(snapshot?.blends).toEqual([
      {
        blendId: "BALANCED",
        label: "Balanced",
        valuePerShare: 245,
        currency: "USD",
        valuationDate: "2026-08-28",
      },
    ]);
    expect(snapshot?.models.map((entry) => entry.model)).toEqual([
      "DCF_FCFF",
      "GRAHAM",
    ]);
    expect(snapshot?.models[0]?.valuePerShare).toBe(260);
  });

  it("keeps a model's own older valuation date instead of merging dates", () => {
    const snapshot = selectLatestValuations(
      [model("DDM", "2026-08-20", 90), model("DCF_FCFF", "2026-08-28", 260)],
      [],
    );

    expect(snapshot?.asOfDate).toBe("2026-08-28");
    expect(
      snapshot?.models.find((entry) => entry.model === "DDM")?.valuationDate,
    ).toBe("2026-08-20");
  });

  it("returns undefined when no valuation data exists", () => {
    expect(selectLatestValuations([], [])).toBeUndefined();
  });
});

describe("upsideFraction", () => {
  it("expresses the intrinsic value relative to the price", () => {
    expect(upsideFraction(290, 232)).toBeCloseTo(0.25, 10);
    expect(upsideFraction(174, 232)).toBeCloseTo(-0.25, 10);
  });

  it("cannot be computed without a positive price", () => {
    expect(upsideFraction(100, 0)).toBeUndefined();
    expect(upsideFraction(100, -1)).toBeUndefined();
    expect(upsideFraction(100, Number.NaN)).toBeUndefined();
  });
});
