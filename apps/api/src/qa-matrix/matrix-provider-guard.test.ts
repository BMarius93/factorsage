import { FmpClient, FmpUnauthorizedError } from "@intrinsic/fmp";
import { afterEach, describe, expect, it } from "vitest";
import { MatrixProviderGuard } from "./matrix-provider-guard";
import {
  capturedVenueYears,
  pinnedRequestKey,
  venueCalendarRequest,
  type PinnedVenueCalendar,
} from "./matrix-venue-calendar";

/**
 * The matrix's provider boundary: it answers the pinned venue calendar exactly and refuses — and
 * journals — every other request, through the real `FmpClient` a worker would use.
 */

const NYSE_2026 = venueCalendarRequest("NYSE", 2026);
const HOLIDAYS_2026 = JSON.stringify([
  { date: "2026-01-01", isClosed: true, isFullyClosed: true, name: "New Year" },
  {
    date: "2026-04-03",
    isClosed: true,
    isFullyClosed: true,
    name: "Good Friday",
  },
  {
    date: "2026-11-27",
    isClosed: null,
    isFullyClosed: false,
    name: "Early close",
  },
]);

const CALENDAR: PinnedVenueCalendar = {
  version: 1,
  capturedAt: "2026-10-16T00:00:00.000Z",
  responses: [
    {
      path: NYSE_2026.path,
      query: NYSE_2026.query,
      status: 200,
      body: HOLIDAYS_2026,
    },
    {
      ...venueCalendarRequest("NYSE", 1989),
      status: 403,
      body: '{"error":"restricted"}',
    },
  ],
};

function clientFor(baseUrl: string): FmpClient {
  return new FmpClient(
    () => ({
      apiKey: "qa-matrix-offline",
      baseUrl,
      timeoutMs: 5_000,
      maxRetries: 3,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1,
    }),
    fetch,
  );
}

describe("the matrix provider guard", () => {
  let guard: MatrixProviderGuard | null = null;
  afterEach(async () => {
    await guard?.stop();
    guard = null;
  });

  it("replays a pinned venue schedule byte for byte through the real client", async () => {
    guard = new MatrixProviderGuard(CALENDAR);
    const holidays = await clientFor(await guard.start()).getExchangeHolidays(
      "nyse",
      NYSE_2026.query.from!,
      NYSE_2026.query.to!,
    );
    expect(
      holidays.map((holiday) => [holiday.date, holiday.fullClose]),
    ).toEqual([
      ["2026-01-01", true],
      ["2026-04-03", true],
      ["2026-11-27", false],
    ]);
    const journal = guard.journal();
    expect(journal.servedTotal).toBe(1);
    expect(journal.refusedTotal).toBe(0);
  });

  it("refuses everything the pinned dataset does not hold, once, and says what it was", async () => {
    guard = new MatrixProviderGuard(CALENDAR);
    const client = clientFor(await guard.start());
    await expect(
      client.getDailyPrices("AAPL", "sec-1", {
        from: "2026-01-01",
        to: "2026-02-01",
      }),
    ).rejects.toBeInstanceOf(FmpUnauthorizedError);
    await expect(
      client.getExchangeHolidays("NASDAQ", "2025-12-31", "2026-12-31"),
    ).rejects.toBeInstanceOf(FmpUnauthorizedError);
    const journal = guard.journal();
    // Non-retryable: one round trip each, not a retry storm against a server that will never answer.
    expect(journal.refusedTotal).toBe(2);
    expect(Object.keys(journal.refused).sort()).toEqual([
      "historical-price-eod/full",
      "holidays-by-exchange",
    ]);
    expect(journal.refused["holidays-by-exchange"]?.examples).toEqual([
      "holidays-by-exchange?exchange=NASDAQ&from=2025-12-31&to=2026-12-31",
    ]);
  });

  it("replays a recorded refusal as the provider gave it rather than inventing a schedule", async () => {
    guard = new MatrixProviderGuard(CALENDAR);
    const request = venueCalendarRequest("NYSE", 1989);
    await expect(
      clientFor(await guard.start()).getExchangeHolidays(
        "NYSE",
        request.query.from!,
        request.query.to!,
      ),
    ).rejects.toBeInstanceOf(FmpUnauthorizedError);
    expect(guard.journal().refusedTotal).toBe(0);
    expect(guard.journal().servedTotal).toBe(1);
  });

  it("never keys a request by its API key", () => {
    expect(
      pinnedRequestKey("holidays-by-exchange", {
        to: "b",
        apikey: "secret",
        from: "a",
      }),
    ).toBe("holidays-by-exchange?from=a&to=b");
  });

  it("counts only usable answers as captured years", () => {
    expect([...capturedVenueYears(CALENDAR)]).toEqual(["NYSE:2026"]);
  });
});
