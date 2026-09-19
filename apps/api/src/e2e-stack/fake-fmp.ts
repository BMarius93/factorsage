import { createServer, type Server, type ServerResponse } from "node:http";
import { SUPPORTED_EXCHANGE_CODES } from "@intrinsic/domain";
import { financialStatementPath } from "@intrinsic/fmp";

/**
 * The fixture FMP provider for the deterministic E2E stack (E2E-001).
 *
 * The E2E API and worker are launched with `FMP_BASE_URL` pointing here (`e2eStackEnvironment`), so
 * the whole production path — `FmpClient`, the shared request gate, the loader's coverage
 * bookkeeping — still runs, and only the far end of the wire is replaced. It answers exactly the
 * requests the seeded fixtures can legitimately cause, and nothing else:
 *
 * - **daily bars** (`historical-price-eod/full`) for a fixture security or fixture benchmark:
 *   `[]` — the fixture provider has no bars beyond what the seeds wrote. An empty answer never
 *   deletes a persisted row (the store replaces only the dates it is given), so even a request
 *   overlapping the seeded window cannot disturb it;
 * - **profile** and the three **financial statements** for a fixture security: `[]`;
 * - **current quotes** (`batch-quote`) for fixture securities: `[]` — fictional securities have no
 *   live price, exactly as the real provider answers them;
 * - **exchange holidays** for a supported exchange: the rule-based NYSE full closures of each
 *   requested year, so a Monitor cycle's trading calendar is the same on every machine and every
 *   day.
 *
 * Anything else — an unknown endpoint, a real symbol, a missing or foreign key — is answered
 * `404`/`401` with a body naming the missing fixture, printed to stderr, and recorded in the journal
 * the Playwright teardown fails on. The client classifies those statuses as non-retryable, so the
 * failure surfaces at once instead of being retried into a slow test.
 */

export type FakeFmpFixture = {
  readonly apiKey: string;
  /** Provider symbols of fixture securities (upper case). */
  readonly securitySymbols: ReadonlySet<string>;
  /** Provider symbols of fixture benchmark series (upper case). */
  readonly benchmarkSymbols: ReadonlySet<string>;
};

export type FakeFmpOutcome = "fixture" | "unexpected";

export type FakeFmpAnswer = {
  readonly status: number;
  readonly body: unknown;
  readonly outcome: FakeFmpOutcome;
  /** Which fixture answered, or which fixture is missing. */
  readonly detail: string;
};

export type FakeFmpJournalEntry = {
  readonly sequence: number;
  readonly at: string;
  readonly endpoint: string;
  /** The request's query without `apikey`. Nothing secret is ever journaled. */
  readonly query: Readonly<Record<string, string>>;
  readonly status: number;
  readonly outcome: FakeFmpOutcome;
  readonly detail: string;
};

const STATEMENT_ENDPOINTS = new Set(
  (["INCOME", "BALANCE_SHEET", "CASH_FLOW"] as const).map((type) =>
    financialStatementPath(type),
  ),
);

/** Decides the answer to one request. Pure, so every rule is unit-testable without a socket. */
export function answerFakeFmpRequest(
  url: URL,
  fixture: FakeFmpFixture,
): FakeFmpAnswer {
  const endpoint = fmpEndpoint(url);
  if (url.searchParams.get("apikey") !== fixture.apiKey) {
    // The value is never echoed: if a real key ever arrived here it must not reach a log.
    return unexpected(
      401,
      `request to '${endpoint}' did not carry the E2E fixture key; the process was not launched ` +
        "through the E2E stack boundary",
    );
  }

  const symbol = url.searchParams.get("symbol")?.trim().toUpperCase() ?? "";
  if (endpoint === "historical-price-eod/full") {
    if (
      fixture.securitySymbols.has(symbol) ||
      fixture.benchmarkSymbols.has(symbol)
    ) {
      return answered(
        [],
        `daily bars for fixture '${symbol}': none beyond the seed`,
      );
    }
    return missing(endpoint, url);
  }

  if (endpoint === "profile" || STATEMENT_ENDPOINTS.has(endpoint)) {
    if (fixture.securitySymbols.has(symbol)) {
      return answered([], `${endpoint} for fixture '${symbol}': none`);
    }
    return missing(endpoint, url);
  }

  if (endpoint === "batch-quote") {
    const symbols = (url.searchParams.get("symbols") ?? "")
      .split(",")
      .map((value) => value.trim().toUpperCase())
      .filter((value) => value !== "");
    const foreign = symbols.filter(
      (value) => !fixture.securitySymbols.has(value),
    );
    if (symbols.length > 0 && foreign.length === 0) {
      return answered(
        [],
        `current quotes for ${symbols.length} fixture securities: none (fictional)`,
      );
    }
    return unexpected(
      404,
      `no E2E fixture for current quotes of ${foreign.join(",") || "(no symbols)"}`,
    );
  }

  if (endpoint === "holidays-by-exchange") {
    const exchange =
      url.searchParams.get("exchange")?.trim().toUpperCase() ?? "";
    const from = url.searchParams.get("from") ?? "";
    const to = url.searchParams.get("to") ?? "";
    if (
      (SUPPORTED_EXCHANGE_CODES as readonly string[]).includes(exchange) &&
      isIsoDate(from) &&
      isIsoDate(to) &&
      from < to
    ) {
      return answered(
        fixtureHolidays(from, to).map((date) => ({
          exchange,
          date,
          name: "E2E fixture full closure",
          isClosed: true,
        })),
        `rule-based ${exchange} full closures in (${from}, ${to}]`,
      );
    }
    return missing(endpoint, url);
  }

  return missing(endpoint, url);
}

function answered(body: unknown, detail: string): FakeFmpAnswer {
  return { status: 200, body, outcome: "fixture", detail };
}

function unexpected(status: number, detail: string): FakeFmpAnswer {
  return {
    status,
    body: { error: `E2E fixture FMP: ${detail}` },
    outcome: "unexpected",
    detail,
  };
}

function missing(endpoint: string, url: URL): FakeFmpAnswer {
  return unexpected(
    404,
    `no E2E fixture for GET ${endpoint}?${describeQuery(url)} — add one to ` +
      "apps/api/src/e2e-stack/fake-fmp.ts, or seed the data so the loader does not ask",
  );
}

/** The endpoint path relative to the client's `/stable/` base. */
function fmpEndpoint(url: URL): string {
  return url.pathname.replace(/^\/stable\//, "").replace(/^\/+/, "");
}

function safeQuery(url: URL): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (key !== "apikey") {
      query[key] = value;
    }
  }
  return query;
}

function describeQuery(url: URL): string {
  return new URLSearchParams(safeQuery(url)).toString();
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * NYSE's rule-based full closures for every year touched by `(from, to]`.
 *
 * `from` is exclusive and `to` inclusive, as the real endpoint treats them. The rules are the
 * exchange's standing ones — New Year's Day, Martin Luther King Jr. Day, Washington's Birthday,
 * Good Friday, Memorial Day, Juneteenth (from 2022), Independence Day, Labor Day, Thanksgiving and
 * Christmas, with the weekend observance NYSE applies (a Saturday New Year's Day is not observed).
 * Ad-hoc closures are deliberately absent: this is a fixture calendar that must be identical on
 * every run, not a replica of history.
 */
export function fixtureHolidays(from: string, to: string): string[] {
  const firstYear = Number(from.slice(0, 4));
  const lastYear = Number(to.slice(0, 4));
  const dates: string[] = [];
  for (let year = firstYear; year <= lastYear; year += 1) {
    dates.push(...nyseFullClosures(year));
  }
  return dates.filter((date) => date > from && date <= to).sort();
}

export function nyseFullClosures(year: number): string[] {
  const closures = [
    newYearsDay(year),
    nthWeekday(year, 0, 1, 3),
    nthWeekday(year, 1, 1, 3),
    addUtcDays(easterSunday(year), -2),
    lastWeekday(year, 4, 1),
    ...(year >= 2022 ? [observed(utc(year, 5, 19))] : []),
    observed(utc(year, 6, 4)),
    nthWeekday(year, 8, 1, 1),
    nthWeekday(year, 10, 4, 4),
    observed(utc(year, 11, 25)),
  ];
  return closures
    .filter((date): date is Date => date !== null)
    .map((date) => date.toISOString().slice(0, 10));
}

function utc(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day));
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/** Saturday moves to Friday, Sunday to Monday. */
function observed(date: Date): Date {
  const day = date.getUTCDay();
  return day === 6
    ? addUtcDays(date, -1)
    : day === 0
      ? addUtcDays(date, 1)
      : date;
}

/** NYSE does not close on the Friday before a Saturday New Year's Day. */
function newYearsDay(year: number): Date | null {
  const date = utc(year, 0, 1);
  const day = date.getUTCDay();
  return day === 6 ? null : day === 0 ? addUtcDays(date, 1) : date;
}

function nthWeekday(
  year: number,
  month: number,
  weekday: number,
  nth: number,
): Date {
  const first = utc(year, month, 1);
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return addUtcDays(first, offset + (nth - 1) * 7);
}

function lastWeekday(year: number, month: number, weekday: number): Date {
  const last = utc(year, month + 1, 0);
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return addUtcDays(last, -offset);
}

/** Gregorian Easter Sunday (the anonymous Meeus/Jones/Butcher algorithm). */
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utc(year, month - 1, day);
}

export type FakeFmpServer = {
  readonly server: Server;
  readonly journal: readonly FakeFmpJournalEntry[];
  close(): Promise<void>;
};

/**
 * The HTTP face of {@link answerFakeFmpRequest}, plus two control endpoints on a path FMP never
 * uses: `GET /__e2e/health` and `GET /__e2e/journal?after=<sequence>`.
 */
export function createFakeFmpServer(
  fixture: FakeFmpFixture,
  options: { readonly log?: (line: string) => void } = {},
): FakeFmpServer {
  const journal: FakeFmpJournalEntry[] = [];
  const log = options.log ?? (() => {});
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/__e2e/health") {
      return json(response, 200, {
        status: "ok",
        securities: fixture.securitySymbols.size,
        benchmarks: [...fixture.benchmarkSymbols].sort(),
        journal: journal.length,
      });
    }
    if (url.pathname === "/__e2e/journal") {
      const after = Number(url.searchParams.get("after") ?? "0");
      return json(response, 200, {
        entries: journal.filter((entry) => entry.sequence > after),
        last: journal.at(-1)?.sequence ?? 0,
      });
    }
    if (request.method !== "GET") {
      return json(response, 405, { error: "E2E fixture FMP answers GET only" });
    }

    const answer = answerFakeFmpRequest(url, fixture);
    const entry: FakeFmpJournalEntry = {
      sequence: journal.length + 1,
      at: new Date().toISOString(),
      endpoint: fmpEndpoint(url),
      query: safeQuery(url),
      status: answer.status,
      outcome: answer.outcome,
      detail: answer.detail,
    };
    journal.push(entry);
    log(
      `${answer.outcome === "fixture" ? "fixture   " : "UNEXPECTED"} ${answer.status} ` +
        `${entry.endpoint}?${describeQuery(url)} — ${answer.detail}`,
    );
    return json(response, answer.status, answer.body);
  });
  return {
    server,
    journal,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}
