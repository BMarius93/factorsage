import { describe, expect, it } from "vitest";
import { failureGuidance } from "./failure";

describe("failureGuidance", () => {
  it("never recommends a blind retry for missing data", () => {
    const guidance = failureGuidance({
      code: "DATA_UNAVAILABLE",
      phase: "PREPARING_DATA",
      message: "Market data is not available for the stocks in this list.",
    });
    expect(guidance.recovery).toBe("edit");
    expect(guidance.cause).toBe(
      "Market data is not available for the stocks in this list.",
    );
    expect(guidance.next).toMatch(/fail the same way/);
  });

  it("asks for a different period when there are no trading days", () => {
    expect(
      failureGuidance({ code: "NO_TRADING_DAYS", phase: "RUNNING", message: "x" })
        .recovery,
    ).toBe("edit");
  });

  it.each([
    "EXECUTION_CALENDAR_UNAVAILABLE",
    "ENGINE_VERSION_MISMATCH",
    "ABANDONED",
  ])("lets a system-side %s be run again unchanged", (code) => {
    expect(failureGuidance({ code, phase: null, message: "x" }).recovery).toBe(
      "rerun",
    );
  });

  it("never repeats the generic API sentence or the raw code as the explanation", () => {
    for (const phase of ["PREPARING_DATA", "RUNNING", null] as const) {
      const guidance = failureGuidance({
        code: "EXECUTION_FAILED",
        phase,
        message: "The backtest could not be completed. Please try running it again.",
      });
      expect(guidance.cause).not.toContain("EXECUTION_FAILED");
      expect(guidance.cause).not.toContain("Please try running it again");
    }
    expect(
      failureGuidance({
        code: "EXECUTION_FAILED",
        phase: "PREPARING_DATA",
        message: "",
      }).title,
    ).toMatch(/data/i);
  });

  it("still explains a failure the API did not describe", () => {
    expect(failureGuidance(null).title).toBeTruthy();
  });
});
