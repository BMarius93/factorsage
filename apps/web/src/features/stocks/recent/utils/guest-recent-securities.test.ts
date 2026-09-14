import { RECENT_SECURITY_LIMIT } from "@intrinsic/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GUEST_RECENT_SECURITIES_KEY,
  readGuestRecentSecurityIds,
  rememberGuestRecentSecurityId,
} from "./guest-recent-securities";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("guest recent securities", () => {
  it("returns nothing when the browser has stored nothing", () => {
    expect(readGuestRecentSecurityIds()).toEqual([]);
  });

  it("keeps the newest view first", () => {
    rememberGuestRecentSecurityId("aapl");
    rememberGuestRecentSecurityId("nvda");
    rememberGuestRecentSecurityId("msft");

    expect(readGuestRecentSecurityIds()).toEqual(["msft", "nvda", "aapl"]);
  });

  it("promotes a re-viewed security instead of storing it twice", () => {
    rememberGuestRecentSecurityId("aapl");
    rememberGuestRecentSecurityId("nvda");
    rememberGuestRecentSecurityId("msft");

    expect(rememberGuestRecentSecurityId("nvda")).toEqual([
      "nvda",
      "msft",
      "aapl",
    ]);
  });

  it("never keeps more than the product maximum", () => {
    for (let index = 0; index < RECENT_SECURITY_LIMIT + 4; index += 1) {
      rememberGuestRecentSecurityId(`id-${index}`);
    }

    expect(readGuestRecentSecurityIds()).toHaveLength(RECENT_SECURITY_LIMIT);
    expect(readGuestRecentSecurityIds()[0]).toBe(
      `id-${RECENT_SECURITY_LIMIT + 3}`,
    );
  });

  it("stores only ids, never symbols or company names", () => {
    rememberGuestRecentSecurityId("security-id-1");

    expect(window.localStorage.getItem(GUEST_RECENT_SECURITIES_KEY)).toBe(
      '["security-id-1"]',
    );
  });

  it("treats corrupt storage as empty rather than throwing", () => {
    window.localStorage.setItem(GUEST_RECENT_SECURITIES_KEY, "{not json");
    expect(readGuestRecentSecurityIds()).toEqual([]);

    window.localStorage.setItem(GUEST_RECENT_SECURITIES_KEY, '{"a":1}');
    expect(readGuestRecentSecurityIds()).toEqual([]);

    window.localStorage.setItem(GUEST_RECENT_SECURITIES_KEY, '["ok", 7, ""]');
    expect(readGuestRecentSecurityIds()).toEqual(["ok"]);
  });

  /** A browser configured to block site data throws on access; recents must not take a page down. */
  it("survives a storage backend that throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    expect(readGuestRecentSecurityIds()).toEqual([]);
    expect(() => rememberGuestRecentSecurityId("aapl")).not.toThrow();
  });
});
