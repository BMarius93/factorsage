import { describe, expect, it } from "vitest";
import { parseRunListRequest } from "./backtest-requests";

/**
 * `?page=`, `?pageSize=`, `?q=`, `?status=` and `?sort=` on `GET /backtests`.
 *
 * Lenient, as on the trade log: nothing here changes state, so a stale or hand-edited link lands on
 * a real page instead of an error. What must never happen is a malformed value being honoured, so
 * every case says what it falls back to; the page response reports what was applied.
 */
describe("parseRunListRequest", () => {
  it("answers the whole list unless a page is asked for", () => {
    expect(parseRunListRequest({})).toEqual({ paged: false });
    expect(parseRunListRequest({ status: "ACTIVE" })).toEqual({
      paged: false,
      status: "ACTIVE",
    });
    expect(parseRunListRequest({ page: "2" })).toEqual({
      paged: true,
      page: 2,
    });
    expect(parseRunListRequest({ pageSize: "10" })).toEqual({
      paged: true,
      pageSize: 10,
    });
  });

  it("asks for a page even when the page number is malformed, and pages from the first", () => {
    expect(parseRunListRequest({ page: "abc" })).toEqual({ paged: true });
    expect(parseRunListRequest({ page: "0", pageSize: "-5" })).toEqual({
      paged: true,
    });
    expect(parseRunListRequest({ page: "1.5" })).toEqual({ paged: true });
  });

  it("reads a search, a status and an order, in any case", () => {
    expect(
      parseRunListRequest({
        page: "1",
        q: "  Growth ",
        status: "completed",
        sort: "CAGR",
      }),
    ).toEqual({
      paged: true,
      page: 1,
      q: "Growth",
      status: "COMPLETED",
      sort: "cagr",
    });
    for (const sort of ["newest", "oldest", "cagr", "strategy"]) {
      expect(parseRunListRequest({ sort }).sort).toBe(sort);
    }
    for (const status of ["ACTIVE", "COMPLETED", "FAILED"]) {
      expect(parseRunListRequest({ status }).status).toBe(status);
    }
  });

  it("ignores a status, an order or a search it cannot honour", () => {
    expect(
      parseRunListRequest({ status: "QUEUED", sort: "fastest", q: "   " }),
    ).toEqual({ paged: false });
    // A repeated parameter names no single value.
    expect(
      parseRunListRequest({ status: ["ACTIVE", "FAILED"], q: ["a", "b"] }),
    ).toEqual({ paged: false });
    // Longer than any name could be: ignored, never truncated into a different search.
    expect(parseRunListRequest({ q: "x".repeat(101) })).toEqual({
      paged: false,
    });
    expect(parseRunListRequest({ q: "x".repeat(100) }).q).toHaveLength(100);
  });
});
