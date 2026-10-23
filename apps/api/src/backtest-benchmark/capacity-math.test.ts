import { describe, expect, it } from "vitest";
import {
  arrivalsAtUtilization,
  erlangC,
  estimateQueue,
  mixtureMoments,
} from "./capacity-math";

describe("capacity arithmetic", () => {
  it("matches published Erlang C values", () => {
    // One server: M/M/1 waits with probability ρ.
    expect(erlangC(1, 0.5)).toBeCloseTo(0.5, 10);
    // Two servers offered one Erlang: C = 1/3.
    expect(erlangC(2, 1)).toBeCloseTo(1 / 3, 10);
    // Four servers offered three Erlangs: C ≈ 0.5094 (standard tables).
    expect(erlangC(4, 3)).toBeCloseTo(0.5094, 4);
    expect(erlangC(4, 4)).toBe(1);
  });

  it("reduces to the M/M/1 waiting time with exponential service", () => {
    // λ = 0.5/h, mean service 1 h: Wq = ρ / (μ − λ) = 0.5 / 0.5 = 1 h.
    const estimate = estimateQueue({
      lambda: 0.5,
      meanServiceHours: 1,
      serviceCv: 1,
      servers: 1,
    });
    expect(estimate.meanWaitHours).toBeCloseTo(1, 10);
    expect(estimate.utilization).toBeCloseTo(0.5, 10);
  });

  it("halves the wait for deterministic service (Pollaczek–Khinchine)", () => {
    const estimate = estimateQueue({
      lambda: 0.5,
      meanServiceHours: 1,
      serviceCv: 0,
      servers: 1,
    });
    expect(estimate.meanWaitHours).toBeCloseTo(0.5, 10);
  });

  it("reports saturation rather than a number beyond capacity", () => {
    const estimate = estimateQueue({
      lambda: 8,
      meanServiceHours: 0.5,
      serviceCv: 1,
      servers: 4,
    });
    expect(estimate.saturated).toBe(true);
    expect(estimate.meanWaitHours).toBe(Number.POSITIVE_INFINITY);
    expect(estimate.throughputPerHour).toBeCloseTo(8, 10);
  });

  it("finds the arrival rate of a target utilization", () => {
    expect(arrivalsAtUtilization(0.7, 0.25, 4)).toBeCloseTo(11.2, 10);
  });

  it("combines run kinds into the mixture's mean and spread", () => {
    const single = mixtureMoments([{ share: 1, meanHours: 2, cv: 0.5 }]);
    expect(single.meanHours).toBeCloseTo(2, 10);
    expect(single.cv).toBeCloseTo(0.5, 10);
    // Two deterministic kinds, 1 h and 3 h, half each: mean 2 h, sd 1 h.
    const mixed = mixtureMoments([
      { share: 1, meanHours: 1, cv: 0 },
      { share: 1, meanHours: 3, cv: 0 },
    ]);
    expect(mixed.meanHours).toBeCloseTo(2, 10);
    expect(mixed.cv).toBeCloseTo(0.5, 10);
  });
});
