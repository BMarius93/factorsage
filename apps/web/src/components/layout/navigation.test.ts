import { describe, expect, it } from "vitest";
import {
  APP_HOME_HREF,
  DESKTOP_NAV_ITEMS,
  MOBILE_NAV_ITEMS,
  PRIMARY_NAV_ITEMS,
  isNavItemActive,
  type NavItem,
} from "./navigation";

function navItem(href: string): NavItem {
  return { id: "lists", label: "Lists", href, desktopOrder: 1, mobileOrder: 1 };
}

describe("primary navigation configuration", () => {
  it("declares a bottom-navigation-sized set of destinations", () => {
    expect(PRIMARY_NAV_ITEMS.length).toBeGreaterThan(0);
    expect(PRIMARY_NAV_ITEMS.length).toBeLessThanOrEqual(5);
  });

  it("keeps Dashboard as the application home, at the root route", () => {
    expect(APP_HOME_HREF).toBe("/");
    expect(
      PRIMARY_NAV_ITEMS.find((item) => item.id === "dashboard")?.href,
    ).toBe("/");
  });

  it("never sends a primary destination to the legacy /dashboard address", () => {
    const hrefs: readonly string[] = PRIMARY_NAV_ITEMS.map((item) => item.href);

    expect(hrefs).not.toContain("/dashboard");
  });

  it("does not expose /stocks as a primary destination", () => {
    const hrefs: readonly string[] = PRIMARY_NAV_ITEMS.map((item) => item.href);

    expect(hrefs).not.toContain("/stocks");
  });

  it("uses unique ids and hrefs", () => {
    const ids = PRIMARY_NAV_ITEMS.map((item) => item.id);
    const hrefs = PRIMARY_NAV_ITEMS.map((item) => item.href);

    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("uses absolute hrefs without trailing slashes and non-empty labels", () => {
    for (const item of PRIMARY_NAV_ITEMS) {
      expect(item.href.startsWith("/")).toBe(true);
      // The root route is the one href that legitimately ends in a slash: it *is* the slash.
      expect(item.href === "/" || !item.href.endsWith("/")).toBe(true);
      expect(item.label.trim()).not.toBe("");
    }
  });

  it("points the brand link at a primary destination", () => {
    const hrefs: readonly string[] = PRIMARY_NAV_ITEMS.map((item) => item.href);

    expect(hrefs).toContain(APP_HOME_HREF);
  });
});

describe("per-surface navigation ordering", () => {
  it("leads the desktop topbar with the work, not the dashboard", () => {
    expect(DESKTOP_NAV_ITEMS.map((item) => item.id)).toEqual([
      "strategies",
      "monitors",
      "backtests",
      "lists",
    ]);
  });

  it("omits Dashboard from the topbar, because the brand mark already links there", () => {
    expect(DESKTOP_NAV_ITEMS.map((item) => item.href)).not.toContain(
      APP_HOME_HREF,
    );
  });

  it("leads the phone's bottom bar with the dashboard", () => {
    expect(MOBILE_NAV_ITEMS.map((item) => item.id)).toEqual([
      "dashboard",
      "lists",
      "monitors",
      "strategies",
      "backtests",
    ]);
  });

  it("keeps every destination reachable on a phone", () => {
    expect(MOBILE_NAV_ITEMS).toHaveLength(PRIMARY_NAV_ITEMS.length);
  });

  it("gives each surface a unique position per destination", () => {
    const desktop = DESKTOP_NAV_ITEMS.map((item) => item.desktopOrder);
    const mobile = MOBILE_NAV_ITEMS.map((item) => item.mobileOrder);

    expect(new Set(desktop).size).toBe(desktop.length);
    expect(new Set(mobile).size).toBe(mobile.length);
  });
});

describe("isNavItemActive", () => {
  it("matches the destination itself", () => {
    expect(isNavItemActive("/lists", navItem("/lists"))).toBe(true);
  });

  it("matches nested routes below the destination", () => {
    expect(isNavItemActive("/lists/42/edit", navItem("/lists"))).toBe(true);
  });

  it("ignores a trailing slash on the current path", () => {
    expect(isNavItemActive("/lists/", navItem("/lists"))).toBe(true);
  });

  it("ignores query strings and hashes", () => {
    expect(isNavItemActive("/lists?page=2", navItem("/lists"))).toBe(true);
    expect(isNavItemActive("/lists#top", navItem("/lists"))).toBe(true);
  });

  it("does not match a route that merely shares a prefix", () => {
    expect(isNavItemActive("/listings", navItem("/lists"))).toBe(false);
  });

  it("does not match an unrelated route", () => {
    expect(isNavItemActive("/strategies", navItem("/lists"))).toBe(false);
  });

  it("marks exactly one destination active for a nested product route", () => {
    const active = PRIMARY_NAV_ITEMS.filter((item) =>
      isNavItemActive("/lists/42/symbols", item),
    );

    expect(active.map((item) => item.id)).toEqual(["lists"]);
  });

  it("marks no destination active on a non-primary product route", () => {
    const active = PRIMARY_NAV_ITEMS.filter((item) =>
      isNavItemActive("/stocks/AAPL", item),
    );

    expect(active).toEqual([]);
  });

  it("marks no destination active outside the product routes", () => {
    const active = PRIMARY_NAV_ITEMS.filter((item) =>
      isNavItemActive("/login", item),
    );

    expect(active).toEqual([]);
  });
});
