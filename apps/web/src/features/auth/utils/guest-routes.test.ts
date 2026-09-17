import { describe, expect, it } from "vitest";
import { isGuestReadableRoute } from "./guest-routes";

describe("isGuestReadableRoute", () => {
  it("opens the Dashboard, stock pages and content detail pages to a Guest", () => {
    for (const path of [
      "/dashboard",
      "/dashboard/",
      "/stocks",
      "/stocks/AAPL",
      "/lists/3f1b",
      "/strategies/3f1b",
      "/monitors/3f1b?tab=signals",
    ]) {
      expect(isGuestReadableRoute(path), path).toBe(true);
    }
  });

  it("keeps every personal or mutating route behind a session", () => {
    for (const path of [
      "/lists",
      "/strategies",
      "/strategies/new",
      "/monitors",
      "/backtests",
      "/backtests/new",
      "/backtests/abc",
      "/billing",
      "/admin",
      "/lists/abc/edit",
    ]) {
      expect(isGuestReadableRoute(path), path).toBe(false);
    }
  });
});
