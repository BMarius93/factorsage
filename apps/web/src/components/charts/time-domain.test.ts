import { describe, expect, it } from "vitest";
import {
  clampLogicalRange,
  leadBarsOf,
  type TimeDomain,
} from "./time-domain";

function domainOf(overrides: Partial<TimeDomain> = {}): TimeDomain {
  return {
    minTime: "1996-08-28",
    maxTime: "2026-08-28",
    oldestBar: "2025-08-28",
    domainComplete: false,
    interaction: "BOUNDED",
    ...overrides,
  };
}

describe("leadBarsOf", () => {
  it("allows exactly the unloaded part of the domain, in trading days", () => {
    // Twenty-nine years between the boundary and the oldest loaded bar, at roughly 252 trading
    // days a year. That interval is navigable — moving into it is how more history is requested.
    const bars = leadBarsOf(domainOf());
    expect(bars).toBeGreaterThan(29 * 250);
    expect(bars).toBeLessThan(29 * 255);
  });

  it("allows none once nothing older can arrive", () => {
    // At the boundary the empty space would be blank canvas rather than a request, so there is
    // none of it: this is the case the library's own `fixLeftEdge` pin covers exactly.
    expect(leadBarsOf(domainOf({ domainComplete: true }))).toBe(0);
  });

  it("allows none when the oldest bar already reaches the boundary", () => {
    expect(leadBarsOf(domainOf({ oldestBar: "1996-08-28" }))).toBe(0);
    // A bar older than the boundary is not a reason to allow navigation before it.
    expect(leadBarsOf(domainOf({ oldestBar: "1990-01-01" }))).toBe(0);
  });

  it("allows none when there is nothing drawn to be left of", () => {
    expect(leadBarsOf(domainOf({ oldestBar: undefined }))).toBe(0);
  });
});

describe("clampLogicalRange", () => {
  const bounds = { minFrom: -100, maxTo: 260 };

  it("leaves a legal viewport alone", () => {
    // `null` rather than an equal range, and that is the whole point: a clamp that always answered
    // with a range would have every correction report a change and every change trigger another.
    expect(clampLogicalRange({ from: -20, to: 200 }, bounds)).toBeNull();
    expect(clampLogicalRange({ from: -100, to: 260 }, bounds)).toBeNull();
  });

  it("tolerates the sub-bar padding that framing leaves behind", () => {
    // Fitting the whole series leaves a fraction of a bar past each edge. Correcting that would
    // mean writing a range back on every frame of an ordinary pan.
    expect(clampLogicalRange({ from: -100.5, to: 260.5 }, bounds)).toBeNull();
  });

  it("slides an over-panned viewport back, keeping the zoom the user chose", () => {
    expect(clampLogicalRange({ from: -400, to: -100 }, bounds)).toEqual({
      from: -100,
      to: 200,
    });
    expect(clampLogicalRange({ from: 300, to: 400 }, bounds)).toEqual({
      from: 160,
      to: 260,
    });
  });

  it("pins a viewport wider than the domain to the domain", () => {
    // The span cannot be kept, because there is nowhere legal to keep it.
    expect(clampLogicalRange({ from: -900, to: 900 }, bounds)).toEqual({
      from: -100,
      to: 260,
    });
  });

  it("settles in one step: the range it returns is itself legal", () => {
    const corrected = clampLogicalRange({ from: -5_000, to: -4_000 }, bounds);
    expect(corrected).not.toBeNull();
    expect(clampLogicalRange(corrected!, bounds)).toBeNull();
  });
});
