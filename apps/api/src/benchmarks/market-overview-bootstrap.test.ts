import type {
  BenchmarkDailyPrice,
  BenchmarkSeries,
  BenchmarkWithSeries,
  DateRange,
  LocalDate,
  MarketOverviewEtf,
} from "@intrinsic/domain";
import { marketOverviewEtfs } from "@intrinsic/domain";
import type {
  BenchmarkHistory,
  BenchmarkResidency,
} from "@intrinsic/stock-data";
import { describe, expect, it } from "vitest";
import {
  bootstrapMarketOverview,
  countingFetch,
  formatBootstrapLine,
  summarizeBootstrapSeries,
  type MarketOverviewBootstrapService,
} from "./market-overview-bootstrap";

const REQUESTED = { from: "1993-01-01", to: "2026-10-09" } as const;

const SPY: MarketOverviewEtf = {
  ticker: "SPY",
  label: "S&P 500 ETF",
  benchmarkCode: "SP500",
  listedIn: "1993-01",
};
const XLC: MarketOverviewEtf = {
  ticker: "XLC",
  label: "Communication Services",
  benchmarkCode: "ETF_XLC",
  listedIn: "2018-06",
};
const GLD: MarketOverviewEtf = {
  ticker: "GLD",
  label: "Gold",
  benchmarkCode: "ETF_GLD",
  listedIn: "2004-11",
};

function bars(
  dates: readonly LocalDate[],
  seriesId = "s",
): BenchmarkDailyPrice[] {
  return dates.map((date) => ({
    seriesId,
    date,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 1,
  }));
}

describe("summarizeBootstrapSeries", () => {
  it("reports the stored span, the pre-inception period and a clean calendar match", () => {
    const report = summarizeBootstrapSeries({
      etf: XLC,
      seriesId: "xlc",
      requested: REQUESTED,
      rows: bars(["2018-06-19", "2018-06-20", "2018-06-21"]),
      missingCoverage: [],
      referenceSessions: [
        "2018-06-18",
        "2018-06-19",
        "2018-06-20",
        "2018-06-21",
      ],
      providerHttpRequests: 1,
      residency: "RESIDENT",
      basisGeneration: 0,
      durationMs: 12,
    });

    expect(report).toMatchObject({
      status: "OK",
      firstBar: "2018-06-19",
      lastBar: "2018-06-21",
      bars: 3,
      // Before the fund existed: the provider has nothing, and that is the expected answer.
      preInception: { from: "1993-01-01", to: "2018-06-18" },
      calendarGaps: { count: 0 },
      offCalendarBars: { count: 0 },
      providerHttpRequests: 1,
      warnings: [],
    });
    // A session before the fund's first bar is not a gap in its history.
    expect(report.lateStart).toBeUndefined();
  });

  it("names the execution-calendar sessions missing inside the history", () => {
    const report = summarizeBootstrapSeries({
      etf: GLD,
      seriesId: "gld",
      requested: REQUESTED,
      rows: bars(["2004-11-18", "2004-11-22"]),
      missingCoverage: [],
      referenceSessions: ["2004-11-18", "2004-11-19", "2004-11-22"],
      providerHttpRequests: 1,
      durationMs: 1,
    });

    expect(report.status).toBe("WARN");
    expect(report.calendarGaps).toEqual({ count: 1, sample: ["2004-11-19"] });
    expect(report.warnings.join(" ")).toContain("1 execution-calendar session");
  });

  it("flags bars on days the execution calendar has no session for", () => {
    const report = summarizeBootstrapSeries({
      etf: GLD,
      seriesId: "gld",
      requested: REQUESTED,
      rows: bars(["2004-11-18", "2004-11-20", "2004-11-22"]),
      missingCoverage: [],
      referenceSessions: ["2004-11-18", "2004-11-22"],
      providerHttpRequests: 1,
      durationMs: 1,
    });

    expect(report.offCalendarBars).toEqual({
      count: 1,
      sample: ["2004-11-20"],
    });
    expect(report.status).toBe("WARN");
  });

  it("flags a history that begins long after the fund listed", () => {
    const report = summarizeBootstrapSeries({
      etf: GLD,
      seriesId: "gld",
      requested: REQUESTED,
      rows: bars(["2006-01-03", "2006-01-04"]),
      missingCoverage: [],
      providerHttpRequests: 1,
      durationMs: 1,
    });

    expect(report.lateStart).toMatchObject({
      listedIn: "2004-11",
      firstBar: "2006-01-03",
    });
    expect(report.status).toBe("WARN");
  });

  it("reports coverage still missing, which a rerun resumes", () => {
    const report = summarizeBootstrapSeries({
      etf: SPY,
      seriesId: "spy",
      requested: REQUESTED,
      rows: bars(["1993-01-29", "1993-02-01"]),
      missingCoverage: [{ from: "2001-01-01", to: "2001-12-31" }],
      providerHttpRequests: 2,
      durationMs: 1,
    });

    expect(report.missingCoverage).toEqual([
      { from: "2001-01-01", to: "2001-12-31" },
    ]);
    expect(report.warnings.join(" ")).toContain("rerun to resume");
  });

  it("reports the longest gap between bars and warns past ten calendar days", () => {
    const report = summarizeBootstrapSeries({
      etf: SPY,
      seriesId: "spy",
      requested: REQUESTED,
      rows: bars(["1993-01-29", "1993-02-01", "1993-03-01"]),
      missingCoverage: [],
      providerHttpRequests: 1,
      durationMs: 1,
    });

    expect(report.longestGap).toEqual({
      from: "1993-02-01",
      to: "1993-03-01",
      days: 28,
    });
    expect(report.status).toBe("WARN");
  });

  it("warns when the Redis projection could not be published, instead of calling it resident", () => {
    const report = summarizeBootstrapSeries({
      etf: SPY,
      seriesId: "spy",
      requested: REQUESTED,
      rows: bars(["1993-01-29", "1993-02-01"]),
      missingCoverage: [],
      providerHttpRequests: 1,
      residency: "UNPUBLISHED",
      durationMs: 1,
    });

    expect(report.status).toBe("WARN");
    expect(report.warnings.join(" ")).toContain("could not be published");
  });

  it("fails a series that stored nothing", () => {
    const report = summarizeBootstrapSeries({
      etf: XLC,
      seriesId: "xlc",
      requested: REQUESTED,
      rows: [],
      missingCoverage: [],
      providerHttpRequests: 1,
      durationMs: 1,
    });

    expect(report.status).toBe("FAILED");
    expect(formatBootstrapLine(report)).toContain("no bars");
  });
});

describe("countingFetch", () => {
  it("counts every request per symbol and never keeps the URL", async () => {
    const seen: string[] = [];
    const counter = countingFetch((async (
      input: Parameters<typeof fetch>[0],
    ) => {
      seen.push(String(input));
      return new Response("[]");
    }) as typeof fetch);

    await counter.fetch(
      "https://provider.test/stable/historical-price-eod/full?symbol=SPY&apikey=secret",
    );
    await counter.fetch(
      new URL(
        "https://provider.test/stable/historical-price-eod/full?symbol=SPY&apikey=secret",
      ),
    );
    await counter.fetch(
      "https://provider.test/stable/historical-price-eod/full?symbol=gld&apikey=secret",
    );
    await counter.fetch("not a url");

    expect(counter.requestsFor("SPY")).toBe(2);
    expect(counter.requestsFor("GLD")).toBe(1);
    expect(counter.requestsFor("QQQ")).toBe(0);
    expect(counter.total()).toBe(4);
    // Passed through untouched.
    expect(seen).toHaveLength(4);
  });
});

/** An in-memory loader: per-code histories, a call log, and optional failures. */
class FakeLoader implements MarketOverviewBootstrapService {
  readonly calls: string[] = [];
  readonly failing = new Set<string>();
  readonly requests = new Map<string, number>();

  constructor(private readonly histories: Map<string, LocalDate[]>) {}

  async getBenchmark(code: string): Promise<BenchmarkWithSeries> {
    this.calls.push(`get:${code}`);
    return {
      id: code,
      code,
      name: code,
      isActive: true,
      isBacktestSelectable: code === "SP500",
      displayOrder: 0,
      series: series(code),
    };
  }

  async ensureBenchmarkHydrated(
    target: BenchmarkSeries,
    range: Required<DateRange>,
  ): Promise<void> {
    this.calls.push(`hydrate:${target.id}:${range.from}:${range.to}`);
    const symbol = target.providerSymbol;
    this.requests.set(symbol, (this.requests.get(symbol) ?? 0) + 2);
    if (this.failing.has(target.id)) {
      throw new Error(`provider refused ${symbol}`);
    }
  }

  async missingBenchmarkCoverage(): Promise<Required<DateRange>[]> {
    return [];
  }

  async ensureBenchmarkResident(
    target: BenchmarkSeries,
  ): Promise<BenchmarkResidency> {
    this.calls.push(`resident:${target.id}`);
    const dates = this.histories.get(target.id) ?? [];
    return {
      status: "RESIDENT",
      bars: dates.length,
      years: 1,
      basisGeneration: 0,
    };
  }

  async readFullBenchmarkHistory(
    target: BenchmarkSeries,
    through?: LocalDate,
  ): Promise<BenchmarkHistory> {
    this.calls.push(`read:${target.id}:${through ?? ""}`);
    return {
      seriesId: target.id,
      basisGeneration: 0,
      rows: bars(this.histories.get(target.id) ?? [], target.id),
      missing: [],
      source: "REDIS",
    };
  }
}

function series(code: string): BenchmarkSeries {
  return {
    id: code,
    benchmarkId: code,
    version: 1,
    sourceKind: "FMP_SYMBOL",
    seriesType: "ETF_PROXY",
    providerSymbol: code === "SP500" ? "SPY" : code.replace("ETF_", ""),
    currency: "USD",
    methodologyVersion: 1,
  };
}

describe("bootstrapMarketOverview", () => {
  const CALENDAR: LocalDate[] = ["2018-06-18", "2018-06-19", "2018-06-20"];

  it("loads SP500 first, then every ETF through the canonical loader, and proves residency", async () => {
    const loader = new FakeLoader(
      new Map([
        ["SP500", CALENDAR],
        ["ETF_XLC", ["2018-06-19", "2018-06-20"]],
        ["ETF_GLD", ["2018-06-18", "2018-06-20"]],
      ]),
    );
    const result = await bootstrapMarketOverview({
      benchmarks: loader,
      ...REQUESTED,
      // SP500 deliberately not first: the bootstrap puts the calendar first itself.
      etfs: [XLC, SPY, GLD],
      providerRequestsFor: (symbol) => loader.requests.get(symbol) ?? 0,
    });

    expect(result.reports.map((report) => report.ticker)).toEqual([
      "SPY",
      "XLC",
      "GLD",
    ]);
    expect(loader.calls.filter((call) => call.startsWith("hydrate:"))).toEqual([
      "hydrate:SP500:1993-01-01:2026-10-09",
      "hydrate:ETF_XLC:1993-01-01:2026-10-09",
      "hydrate:ETF_GLD:1993-01-01:2026-10-09",
    ]);
    // Read back through the provider-free reader, bounded by the requested end.
    expect(loader.calls).toContain("read:ETF_XLC:2026-10-09");
    expect(loader.calls).toContain("resident:ETF_GLD");
    // Each ETF is checked against SP500's sessions.
    expect(result.reports[1]?.calendarGaps.count).toBe(0);
    expect(result.reports[2]?.calendarGaps).toEqual({
      count: 1,
      sample: ["2018-06-19"],
    });
    // Requests are measured per symbol, not estimated.
    expect(result.reports.map((report) => report.providerHttpRequests)).toEqual(
      [2, 2, 2],
    );
    expect(result.providerHttpRequests).toBe(6);
    expect(result.failed).toBe(0);
  });

  it("isolates a failing ETF: it is reported and the rest still load", async () => {
    const loader = new FakeLoader(
      new Map([
        ["SP500", CALENDAR],
        ["ETF_GLD", ["2018-06-18"]],
      ]),
    );
    loader.failing.add("ETF_XLC");
    const result = await bootstrapMarketOverview({
      benchmarks: loader,
      ...REQUESTED,
      etfs: [SPY, XLC, GLD],
      providerRequestsFor: (symbol) => loader.requests.get(symbol) ?? 0,
    });

    expect(result.failed).toBe(1);
    expect(result.reports[1]).toMatchObject({
      ticker: "XLC",
      status: "FAILED",
      error: "provider refused XLC",
      providerHttpRequests: 2,
    });
    expect(result.reports[2]?.status).not.toBe("FAILED");
  });

  it("still loads the others, unchecked and flagged, when SP500 fails", async () => {
    const loader = new FakeLoader(new Map([["ETF_XLC", ["2018-06-19"]]]));
    loader.failing.add("SP500");
    const result = await bootstrapMarketOverview({
      benchmarks: loader,
      ...REQUESTED,
      etfs: [SPY, XLC],
      providerRequestsFor: (symbol) => loader.requests.get(symbol) ?? 0,
    });

    expect(result.reports[0]?.status).toBe("FAILED");
    expect(result.reports[1]?.status).toBe("WARN");
    expect(result.reports[1]?.warnings.join(" ")).toContain(
      "not checked against the execution calendar",
    );
  });

  it("covers exactly the twenty approved ETFs by default", async () => {
    const loader = new FakeLoader(new Map());
    const result = await bootstrapMarketOverview({
      benchmarks: loader,
      ...REQUESTED,
      providerRequestsFor: () => 0,
    });

    expect(result.reports).toHaveLength(20);
    expect(result.reports.map((report) => report.ticker)).toEqual(
      marketOverviewEtfs().map((etf) => etf.ticker),
    );
  });
});
