import { describe, expect, it } from "vitest";
import { issuerNameSimilarity } from "./names.js";
import {
  reconstructIndexMembership,
  type CurrentConstituentInput,
  type IndexChangeInput,
  type ReconstructionInput,
  type SymbolChangeInput,
} from "./reconstruction.js";

const current = (
  symbol: string,
  name = `${symbol} Corp`,
  dateFirstAdded: string | null = null,
): CurrentConstituentInput => ({ symbol, name, cik: null, dateFirstAdded });

let sequence = 0;
const change = (
  effectiveDate: string,
  added: [string, string?] | null,
  removed: [string, string?] | null,
): IndexChangeInput => ({
  contentHash: `h${String((sequence += 1)).padStart(4, "0")}`,
  effectiveDate,
  addedTicker: added?.[0] ?? null,
  addedName: added ? (added[1] ?? `${added[0]} Corp`) : null,
  removedTicker: removed?.[0] ?? null,
  removedName: removed ? (removed[1] ?? `${removed[0]} Corp`) : null,
});

const rename = (
  date: string,
  oldSymbol: string,
  newSymbol: string,
): SymbolChangeInput => ({ date, oldSymbol, newSymbol });

const input = (
  overrides: Partial<ReconstructionInput>,
): ReconstructionInput => ({
  current: [],
  changes: [],
  symbolChanges: [],
  asOf: "2026-10-16",
  ...overrides,
});

const byKey = (
  result: ReturnType<typeof reconstructIndexMembership>,
  key: string,
) => {
  const found = result.constituents.find((entry) => entry.constituentKey === key);
  if (!found) {
    throw new Error(`no constituent ${key}`);
  }
  return found;
};

describe("reconstructIndexMembership", () => {
  it("undoes a replacement: the added issuer joins on the confirmed effective date, the removed one leaves the day before", () => {
    const replacement = change("2010-01-04", ["B"], ["C"]);
    const result = reconstructIndexMembership(
      input({
        // B's first-added date confirms the log's date as the effective date.
        current: [current("A"), current("B", "B Corp", "2010-01-04")],
        changes: [replacement],
      }),
    );

    expect(byKey(result, "CURRENT:B").periods).toEqual([
      {
        startDate: "2010-01-04",
        startLogDate: null,
        endDate: null,
        endLogDate: null,
        quality: "CONFIRMED",
        startChangeHash: replacement.contentHash,
        endChangeHash: null,
        startMatch: "EXACT_TICKER",
      },
    ]);
    // Survivorship: a removed issuer is a constituent with its own period, not a gap.
    const removed = byKey(result, `REMOVAL:${replacement.contentHash}`);
    expect(removed.origin).toBe("REMOVAL");
    expect(removed.periods).toEqual([
      {
        startDate: null,
        startLogDate: null,
        endDate: "2010-01-03",
        endLogDate: null,
        quality: "START_BEFORE_LOG",
        startChangeHash: null,
        endChangeHash: replacement.contentHash,
        startMatch: null,
      },
    ]);
    expect(byKey(result, "CURRENT:A").periods).toEqual([
      expect.objectContaining({
        startDate: null,
        endDate: null,
        quality: "START_BEFORE_LOG",
      }),
    ]);
    expect(result.logStart).toBe("2010-01-04");
    expect(result.additionStarts).toEqual({ refined: 0, confirmed: 1, deferred: 0 });
    expect(result.anomalies).toEqual([]);
  });

  it("starts an addition no current member confirms the day after the log's date, and ends a removal the day before it", () => {
    // Twitter: the log dates its addition 2018-06-06, the rebalancing session before it took
    // effect on 2018-06-07; nothing in today's list can say which, so membership starts on the
    // 7th — never before the index held it. Its removal shares a log date with Arch Capital's
    // addition, which today's list refines to 2022-11-01.
    const joins = change("2018-06-06", ["TWTR", "Twitter"], ["MON", "Monsanto"]);
    const leaves = change("2022-10-31", ["ACGL", "Arch Capital"], ["TWTR", "Twitter"]);
    const result = reconstructIndexMembership(
      input({
        current: [current("ACGL", "Arch Capital Group", "2022-11-01")],
        changes: [joins, leaves],
      }),
    );
    expect(byKey(result, `REMOVAL:${leaves.contentHash}`).periods).toEqual([
      {
        startDate: "2018-06-07",
        startLogDate: "2018-06-06",
        endDate: "2022-10-31",
        endLogDate: "2022-10-30",
        quality: "CONFIRMED",
        startChangeHash: joins.contentHash,
        endChangeHash: leaves.contentHash,
        startMatch: "EXACT_TICKER",
      },
    ]);
    // The removed side of an unconfirmed date already ends the day before the log's date.
    expect(byKey(result, `REMOVAL:${joins.contentHash}`).periods).toEqual([
      expect.objectContaining({ endDate: "2018-06-05", endLogDate: null }),
    ]);
    expect(byKey(result, "CURRENT:ACGL").periods).toEqual([
      expect.objectContaining({ startDate: "2022-11-01", startLogDate: "2022-10-31" }),
    ]);
    expect(result.additionStarts).toEqual({ refined: 1, confirmed: 0, deferred: 1 });
    expect(result.anomalies).toEqual([]);
  });

  it("records no membership for an addition removed before any session confirms it", () => {
    const joins = change("2010-03-04", ["Q"], null);
    const leaves = change("2010-03-05", null, ["Q"]);
    const result = reconstructIndexMembership(
      input({ current: [current("A")], changes: [joins, leaves] }),
    );
    expect(result.constituents.map((entry) => entry.constituentKey)).toEqual([
      "CURRENT:A",
    ]);
    expect(result.anomalies).toEqual([
      {
        kind: "NO_CONFIRMED_SESSION",
        date: "2010-03-04",
        ticker: "Q",
        changeHash: joins.contentHash,
      },
    ]);
  });

  it("takes the evidence of a current member the log names by a ticker it later gave up", () => {
    // Bank of New York Mellon was added as BK and is BNY today; Fiserv's addition reads FI, a
    // ticker it held only from 2023 to 2025, and it is FISV today.
    const bk = change("1995-03-30", ["BK", "Bank of New York"], null);
    const fi = change("2001-03-30", ["FI", "Fiserv Inc."], null);
    const result = reconstructIndexMembership(
      input({
        current: [
          current("BNY", "BNY Mellon", "1995-03-30"),
          current("FISV", "Fiserv", "2001-04-02"),
        ],
        changes: [bk, fi],
        symbolChanges: [
          rename("2024-04-09", "BK", "BNY"),
          rename("2023-06-07", "FISV", "FI"),
          rename("2025-11-11", "FI", "FISV"),
        ],
      }),
    );
    expect(byKey(result, "CURRENT:BNY").periods).toEqual([
      expect.objectContaining({ startDate: "1995-03-30", startLogDate: null }),
    ]);
    expect(byKey(result, "CURRENT:FISV").periods).toEqual([
      expect.objectContaining({ startDate: "2001-04-02", startLogDate: "2001-03-30" }),
    ]);
    expect(result.additionStarts).toEqual({ refined: 1, confirmed: 1, deferred: 0 });
    expect(result.anomalies).toEqual([]);
  });

  it("defers the start on a log date whose current-list evidence contradicts itself", () => {
    const first = change("2016-01-29", ["A"], null);
    const second = change("2016-01-29", ["B"], null);
    const result = reconstructIndexMembership(
      input({
        current: [current("A", "A Corp", "2016-02-01"), current("B", "B Corp", "2016-02-02")],
        changes: [first, second],
      }),
    );
    for (const key of ["CURRENT:A", "CURRENT:B"]) {
      expect(byKey(result, key).periods).toEqual([
        expect.objectContaining({ startDate: "2016-01-30", startLogDate: "2016-01-29" }),
      ]);
    }
    expect(result.anomalies).toEqual(
      expect.arrayContaining([
        {
          kind: "EFFECTIVE_DATE_CONFLICT",
          date: "2016-01-29",
          candidates: ["2016-02-01", "2016-02-02"],
          logDateConfirmed: false,
        },
      ]),
    );
  });

  it("follows an issuer through a rename: Facebook joined as FB and is a member today as META", () => {
    const addition = change("2013-12-23", ["FB", "Facebook"], null);
    const result = reconstructIndexMembership(
      input({
        current: [current("META", "Meta Platforms")],
        changes: [addition],
        symbolChanges: [rename("2022-06-09", "FB", "META")],
      }),
    );
    const meta = byKey(result, "CURRENT:META");
    // Nothing in today's list confirms the log's date, so membership starts the day after it.
    expect(meta.periods).toEqual([
      expect.objectContaining({
        startDate: "2013-12-24",
        startLogDate: "2013-12-23",
        endDate: null,
        startMatch: "EXACT_TICKER",
        quality: "CONFIRMED",
      }),
    ]);
    expect(meta.tickerHistory).toEqual([
      { ticker: "META", from: "2022-06-09", to: null },
      { ticker: "FB", from: null, to: "2022-06-08" },
    ]);
  });

  it("keeps two issuers apart when one takes the other's ticker on the day the index removes it", () => {
    // AT&T Inc. was SBC until 2005-11-18, when it took the ticker T from the AT&T Corp. it
    // acquired and the index removed that day.
    const sbcJoins = change("1983-11-30", ["SBC", "SBC Communications"], null);
    const attCorpJoins = change("1957-03-04", ["T", "AT&T Corp"], null);
    const attCorpLeaves = change("2005-11-18", null, ["T", "AT&T Corp"]);
    const result = reconstructIndexMembership(
      input({
        current: [current("T", "AT&T Inc.")],
        changes: [attCorpLeaves, sbcJoins, attCorpJoins],
        symbolChanges: [rename("2005-11-18", "SBC", "T")],
      }),
    );
    // Neither addition's log date is confirmed by today's list: each starts the day after it.
    expect(byKey(result, "CURRENT:T").periods).toEqual([
      expect.objectContaining({
        startDate: "1983-12-01",
        startLogDate: "1983-11-30",
        endDate: null,
      }),
    ]);
    expect(
      byKey(result, `REMOVAL:${attCorpLeaves.contentHash}`).periods,
    ).toEqual([
      expect.objectContaining({
        startDate: "1957-03-05",
        endDate: "2005-11-17",
        quality: "CONFIRMED",
        startMatch: "EXACT_TICKER",
      }),
    ]);
    expect(
      result.anomalies.filter((anomaly) => anomaly.kind === "TICKER_COLLISION"),
    ).toEqual([]);
  });

  it("matches an addition the log names by a ticker the issuer held only later", () => {
    // Fiserv joined in 2001 as FISV; the log names it FI, a ticker it held from 2023 to 2025.
    const result = reconstructIndexMembership(
      input({
        current: [current("FISV", "Fiserv")],
        changes: [change("2001-03-30", ["FI", "Fiserv Inc."], null)],
        symbolChanges: [
          rename("2023-06-07", "FISV", "FI"),
          rename("2025-11-11", "FI", "FISV"),
        ],
      }),
    );
    expect(byKey(result, "CURRENT:FISV").periods).toEqual([
      expect.objectContaining({
        startDate: "2001-03-31",
        startMatch: "TICKER_HISTORY",
      }),
    ]);
  });

  it("matches by name only as a last resort", () => {
    const result = reconstructIndexMembership(
      input({
        current: [current("ABC", "Alpha Beta Corp")],
        changes: [change("2005-06-01", ["XYZ", "Alpha Beta Corporation"], null)],
      }),
    );
    expect(byKey(result, "CURRENT:ABC").periods).toEqual([
      expect.objectContaining({ startDate: "2005-06-02", startMatch: "NAME" }),
    ]);
  });

  it("reports an addition nobody removed as a period with an unknown end, never an assumed one", () => {
    const orphan = change("2001-04-02", ["GEN", "GenOn Energy"], null);
    const result = reconstructIndexMembership(
      input({ current: [current("A")], changes: [orphan] }),
    );
    expect(byKey(result, `ADDITION:${orphan.contentHash}`)).toEqual(
      expect.objectContaining({
        origin: "ORPHAN_ADDITION",
        periods: [
          expect.objectContaining({
            startDate: "2001-04-03",
            endDate: null,
            quality: "END_UNKNOWN",
          }),
        ],
      }),
    );
    expect(result.anomalies).toEqual([
      expect.objectContaining({ kind: "ORPHAN_ADDITION", ticker: "GEN" }),
    ]);
  });

  it("gives an issuer that left and rejoined one constituent per stint", () => {
    const rejoins = change("2015-01-02", ["X"], null);
    const leaves = change("2008-05-01", null, ["X"]);
    const joins = change("2001-03-01", ["X"], null);
    const result = reconstructIndexMembership(
      input({ current: [current("X")], changes: [joins, leaves, rejoins] }),
    );
    expect(byKey(result, "CURRENT:X").periods).toEqual([
      expect.objectContaining({ startDate: "2015-01-03", endDate: null }),
    ]);
    expect(byKey(result, `REMOVAL:${leaves.contentHash}`).periods).toEqual([
      expect.objectContaining({
        startDate: "2001-03-02",
        endDate: "2008-04-30",
        quality: "CONFIRMED",
      }),
    ]);
  });

  it("does not apply a change dated after the current list", () => {
    const future = change("2026-11-01", ["NEW"], ["A"]);
    const result = reconstructIndexMembership(
      input({ current: [current("A")], changes: [future] }),
    );
    expect(byKey(result, "CURRENT:A").periods).toEqual([
      expect.objectContaining({ startDate: null, endDate: null }),
    ]);
    expect(result.constituents).toHaveLength(1);
    expect(result.anomalies).toEqual([
      { kind: "FUTURE_CHANGE", date: "2026-11-01", changeHash: future.contentHash },
    ]);
  });

  it("reports a ticker held by two members at once and decides an addition between them by name", () => {
    // The log removes Chrysler as C while Citigroup, whose earlier ticker the rename history lacks,
    // already holds C in the walk.
    const chryslerLeaves = change("1998-11-12", null, ["C", "Chrysler Corp."]);
    const chryslerJoins = change("1990-01-02", ["C", "Chrysler Corp"], null);
    const result = reconstructIndexMembership(
      input({
        current: [current("C", "Citigroup")],
        changes: [chryslerLeaves, chryslerJoins],
      }),
    );
    expect(result.anomalies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "TICKER_COLLISION",
          ticker: "C",
          activeConstituents: ["CURRENT:C"],
        }),
        expect.objectContaining({
          kind: "AMBIGUOUS_ADDITION",
          ticker: "C",
          chosen: `REMOVAL:${chryslerLeaves.contentHash}`,
        }),
      ]),
    );
    expect(
      byKey(result, `REMOVAL:${chryslerLeaves.contentHash}`).periods,
    ).toEqual([
      expect.objectContaining({ startDate: "1990-01-03", endDate: "1998-11-11" }),
    ]);
  });

  it("adopts the current list's effective date for every change on a log date it corrects", () => {
    // Uber: the log says Friday 2023-12-15, the current list Monday 2023-12-18. The replacement's
    // removal and a second change logged the same day take effect with it.
    const replacement = change("2023-12-15", ["UBER", "Uber"], ["X"]);
    const sameDay = change("2023-12-15", null, ["Y"]);
    const result = reconstructIndexMembership(
      input({
        current: [current("UBER", "Uber Technologies", "2023-12-18")],
        changes: [replacement, sameDay],
      }),
    );
    expect(byKey(result, "CURRENT:UBER").periods).toEqual([
      expect.objectContaining({
        startDate: "2023-12-18",
        startLogDate: "2023-12-15",
      }),
    ]);
    for (const removal of [replacement, sameDay]) {
      expect(byKey(result, `REMOVAL:${removal.contentHash}`).periods).toEqual([
        expect.objectContaining({ endDate: "2023-12-17", endLogDate: "2023-12-14" }),
      ]);
    }
    expect(result.anomalies).toEqual([]);
  });

  it("leaves a log date alone when the current list contradicts the correction", () => {
    const refinedElsewhere = change("2016-01-29", ["A"], null);
    const confirmedOnDay = change("2016-01-29", ["B"], ["Z"]);
    const result = reconstructIndexMembership(
      input({
        current: [current("A", "A Corp", "2016-02-01"), current("B", "B Corp", "2016-01-29")],
        changes: [refinedElsewhere, confirmedOnDay],
      }),
    );
    expect(byKey(result, "CURRENT:A").periods).toEqual([
      expect.objectContaining({ startDate: "2016-01-29", startLogDate: null }),
    ]);
    expect(result.anomalies).toEqual(
      expect.arrayContaining([
        {
          kind: "EFFECTIVE_DATE_CONFLICT",
          date: "2016-01-29",
          candidates: ["2016-02-01"],
          logDateConfirmed: true,
        },
      ]),
    );
  });

  it("cross-checks the provider's first-added date of current members", () => {
    const result = reconstructIndexMembership(
      input({
        current: [current("B", "B Corp", "2009-01-01")],
        changes: [change("2010-01-04", ["B"], null)],
      }),
    );
    expect(result.anomalies).toEqual([
      {
        kind: "FIRST_ADDED_MISMATCH",
        ticker: "B",
        providerDateFirstAdded: "2009-01-01",
        reconstructedStart: "2010-01-05",
      },
    ]);
  });

  it("is deterministic whatever order its inputs arrive in, and ignores a repeated row", () => {
    const changes = [
      change("2010-01-04", ["B"], ["C"]),
      change("2012-06-01", ["D"], ["B"]),
      change("2005-02-01", ["C"], ["E"]),
    ];
    const base = input({
      current: [current("A"), current("D")],
      changes,
      symbolChanges: [rename("2011-01-01", "Q", "A")],
    });
    const forward = reconstructIndexMembership(base);
    const shuffled = reconstructIndexMembership({
      ...base,
      current: [...base.current].reverse(),
      changes: [changes[2], changes[0], changes[1], changes[0]] as IndexChangeInput[],
    });
    expect(shuffled).toEqual(forward);
  });

  it("compares issuer names by their identifying words", () => {
    expect(issuerNameSimilarity("Wachovia Corp.", "Wachovia Corporation")).toBe(1);
    expect(issuerNameSimilarity("Allergan plc", "Allergan, Inc.")).toBe(1);
    expect(issuerNameSimilarity("Mr. Cooper Group Inc", "Washington Mutual")).toBeLessThan(0.3);
    expect(issuerNameSimilarity(null, "Anything")).toBe(0);
  });
});
