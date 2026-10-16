import {
  getEodFinalityConfig,
  getFmpConfig,
  getFmpTrafficConfig,
  loadRootEnv,
} from "@intrinsic/config";
import { eodCutoffDate } from "@intrinsic/domain";
import { FmpClient } from "@intrinsic/fmp";
import {
  createStockDataRedisClient,
  RedisFmpRequestGate,
} from "@intrinsic/stock-data";
import { resolveMatrixEnvironment } from "./qa-matrix/matrix-environment";
import { repositoryRoot } from "./qa-matrix/matrix-paths";
import {
  MATRIX_CALENDAR_EXCHANGES,
  MATRIX_CALENDAR_FIRST_YEAR,
  pinnedRequestKey,
  venueCalendarPath,
  venueCalendarRequest,
  writePinnedVenueCalendar,
  type PinnedProviderResponse,
} from "./qa-matrix/matrix-venue-calendar";

/**
 * `pnpm qa:matrix:capture-calendar` — pins the venue holiday schedule a matrix sweep may read.
 *
 * The one matrix command that asks the provider anything, and so an explicit opt-in:
 * `QA_MATRIX_CAPTURE_LIVE_CALENDAR=1` on the command line, every time. It asks
 * `holidays-by-exchange` once per exchange the matrix trades on and per year from
 * {@link MATRIX_CALENDAR_FIRST_YEAR} to the current one — exactly the requests
 * `CachedTradingCalendar` makes, through the same shared gate — and stores the provider's answers
 * verbatim, key removed, under `.debug/qa-matrix/` (never committed). The runner's provider guard
 * replays them; see `qa-matrix/matrix-venue-calendar.ts` for why the matrix needs them pinned.
 *
 * A year the provider refuses or answers with an error is stored as it was answered, so the replay
 * reproduces the same "schedule unavailable" the product would have met, rather than inventing one.
 */
async function capture(): Promise<void> {
  loadRootEnv();
  if (process.env.QA_MATRIX_CAPTURE_LIVE_CALENDAR?.trim() !== "1") {
    throw new Error(
      "Refusing to ask the provider: this command reads FMP and needs " +
        "QA_MATRIX_CAPTURE_LIVE_CALENDAR=1 on the command line.",
    );
  }
  // The matrix's own Redis index carries the gate, so a capture never shares an allowance with a
  // development stack that happens to be running.
  const environment = resolveMatrixEnvironment(process.env);
  const redis = createStockDataRedisClient(environment.redisUrl);
  const traffic = getFmpTrafficConfig();
  const responses: PinnedProviderResponse[] = [];
  const recording: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const query: Record<string, string> = {};
    url.searchParams.forEach((value, name) => {
      if (name.toLowerCase() !== "apikey") {
        query[name] = value;
      }
    });
    responses.push({
      path: url.pathname.replace(/^.*\/stable\//, ""),
      query,
      status: response.status,
      body: await response.clone().text(),
    });
    return response;
  };
  const provider = new FmpClient(() => getFmpConfig(), recording, {
    gate: new RedisFmpRequestGate(redis, {
      maxConcurrentRequests: traffic.maxConcurrentRequests,
      rateLimitPerWindow: traffic.rateLimitPerWindow,
      rateWindowMs: traffic.rateWindowMs,
      maxQueueDepth: traffic.maxQueueDepth,
      maxQueueWaitMs: traffic.maxQueueWaitMs,
      requestLeaseMs: traffic.timeoutMs * 2,
    }),
  });

  const lastYear = Number(
    eodCutoffDate(new Date(), getEodFinalityConfig().publicationDelayMs).slice(
      0,
      4,
    ),
  );
  let failures = 0;
  try {
    for (const exchange of MATRIX_CALENDAR_EXCHANGES) {
      for (let year = MATRIX_CALENDAR_FIRST_YEAR; year <= lastYear; year += 1) {
        const { query } = venueCalendarRequest(exchange, year);
        try {
          const holidays = await provider.getExchangeHolidays(
            exchange,
            query.from as string,
            query.to as string,
          );
          console.log(
            `${exchange} ${year}: ${holidays.filter((holiday) => holiday.fullClose).length} full closure(s)`,
          );
        } catch (error) {
          failures += 1;
          console.log(
            `${exchange} ${year}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  } finally {
    redis.disconnect();
  }
  // One answer per request key: a retried request keeps its final answer, which is the one the
  // product would have acted on.
  const byKey = new Map<string, PinnedProviderResponse>();
  for (const response of responses) {
    byKey.set(pinnedRequestKey(response.path, response.query), response);
  }
  const path = venueCalendarPath(repositoryRoot());
  writePinnedVenueCalendar(path, {
    version: 1,
    capturedAt: new Date().toISOString(),
    responses: [...byKey.values()],
  });
  console.log(
    `\nPinned ${byKey.size} provider answer(s) (${failures} request(s) failed) to ${path}`,
  );
}

void capture().catch((error: unknown) => {
  console.error(
    `QA matrix calendar capture failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
