import { describe, expect, it } from "vitest";
import {
  APP_HOME_HREF,
  PRIMARY_NAV_ITEMS,
  isNavItemActive,
  type NavItem,
} from "./navigation";

function navItem(href: string): NavItem {
  return { id: "lists", label: "Lists", href };
}

describe("primary navigation configuration", () => {
  it("declares a bottom-navigation-sized set of destinations", () => {
    expect(PRIMARY_NAV_ITEMS.length).toBeGreaterThan(0);
    expect(PRIMARY_NAV_ITEMS.length).toBeLessThanOrEqual(5);
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
      expect(item.href.endsWith("/")).toBe(false);
      expect(item.label.trim()).not.toBe("");
    }
  });

  it("points the brand link at a primary destination", () => {
    const hrefs: readonly string[] = PRIMARY_NAV_ITEMS.map((item) => item.href);

    expect(hrefs).toContain(APP_HOME_HREF);
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
      isNavItemActive("/stocks/AAPL", item),
    );

    expect(active.map((item) => item.id)).toEqual(["stocks"]);
  });

  it("marks no destination active outside the product routes", () => {
    const active = PRIMARY_NAV_ITEMS.filter((item) =>
      isNavItemActive("/login", item),
    );

    expect(active).toEqual([]);
  });
});
