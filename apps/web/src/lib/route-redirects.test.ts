import { describe, expect, it } from "vitest";
import {
  DASHBOARD_PATH,
  LEGACY_DASHBOARD_PATH,
  webRedirectRules,
} from "./route-redirects";

describe("web redirect rules", () => {
  it("serves the Dashboard at the root route", () => {
    expect(DASHBOARD_PATH).toBe("/");
  });

  it("keeps the old Dashboard address working, pointed at the canonical one", () => {
    const rule = webRedirectRules().find(
      (entry) => entry.source === LEGACY_DASHBOARD_PATH,
    );

    expect(rule).toBeDefined();
    expect(rule?.destination).toBe(DASHBOARD_PATH);
  });

  it("is a temporary redirect, so the browser never caches the move permanently", () => {
    for (const rule of webRedirectRules()) {
      expect(rule.permanent).toBe(false);
    }
  });

  it("never redirects a route to itself, which would be a loop", () => {
    for (const rule of webRedirectRules()) {
      expect(rule.source).not.toBe(rule.destination);
    }
  });

  it("never redirects away from the canonical Dashboard", () => {
    expect(
      webRedirectRules().some((rule) => rule.source === DASHBOARD_PATH),
    ).toBe(false);
  });
});
