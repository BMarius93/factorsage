import { describe, expect, it } from "vitest";
import { loggablePath } from "./http-observability";

/**
 * A shared backtest's link is its token. The request log names the route it served without
 * writing a working link into a file other people read.
 */
describe("loggablePath", () => {
  it("replaces a share token with a placeholder", () => {
    const token = "Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5";
    expect(loggablePath(`/shared-backtests/${token}`)).toBe(
      "/shared-backtests/:token",
    );
    expect(loggablePath(`/shared-backtests/${token}/preview`)).toBe(
      "/shared-backtests/:token/preview",
    );
  });

  it("leaves every other path exactly as it arrived", () => {
    for (const path of [
      "/backtests/7c0d3f0e-1a8b-4f7c-9a59-2a1a0b8f5d11/share",
      "/backtests",
      "/stocks/AAPL",
      "/health",
    ]) {
      expect(loggablePath(path)).toBe(path);
    }
  });
});
