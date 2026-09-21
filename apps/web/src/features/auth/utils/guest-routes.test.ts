import { describe, expect, it } from "vitest";
import { isGuestReadableRoute } from "./guest-routes";

describe("isGuestReadableRoute", () => {
  it("opens the Dashboard, stock pages and built-in content to a Guest", () => {
    for (const path of [
      // The Dashboard, at the canonical route and at the legacy one the redirect answers.
      "/",
      "/?next=x",
      "/dashboard",
      "/dashboard/",
      "/stocks",
      "/stocks/AAPL",
      "/lists",
      "/lists/3f1b",
      "/strategies",
      "/strategies/3f1b",
      "/monitors",
      "/monitors/3f1b?tab=signals",
      "/pricing",
      "/pricing/",
      "/pricing?next=x",
    ]) {
      expect(isGuestReadableRoute(path), path).toBe(true);
    }
  });

  it("keeps every personal or mutating route behind a session", () => {
    for (const path of [
      "/strategies/new",
      "/backtests",
      "/backtests/new",
      "/backtests/abc",
      "/billing",
      "/billing?checkout=success",
      "/pricing/pro",
      "/admin",
      "/lists/abc/edit",
    ]) {
      expect(isGuestReadableRoute(path), path).toBe(false);
    }
  });
});
