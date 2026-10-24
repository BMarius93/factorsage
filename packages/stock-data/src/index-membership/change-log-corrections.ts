import type { LocalDate, MarketIndexKey } from "@intrinsic/domain";
import type { StoredIndexChange } from "./ports.js";

/**
 * Change-log corrections: published index changes the provider's change log records wrongly or not
 * at all (`docs/decisions/historical-universes-v1.md` §3.3).
 *
 * Each one is a reviewed decision about **one** published change, with the index publisher's own
 * announcement as its evidence. None is a rule, and none is inferred from today's constituents. A
 * correction names the provider rows it replaces — matched on their date and tickers, each to exactly
 * one stored row — and the rows the publisher announced in their place. It is applied all or
 * nothing: when a row it replaces is missing (the provider corrected its log) or ambiguous, or a row
 * it adds is already present, it is reported unmatched and the provider's log is used as it is.
 *
 * The provider's rows are never modified in PostgreSQL; the correction is applied to what the
 * reconstruction reads, and its id is part of the synchronization's source digest.
 */
export type IndexChangeLogCorrection = {
  /** Stable: part of the source digest, so a changed correction changes the reconstruction. */
  readonly id: string;
  readonly indexKey: MarketIndexKey;
  readonly replaces: readonly {
    readonly effectiveDate: LocalDate;
    readonly addedTicker: string | null;
    readonly removedTicker: string | null;
  }[];
  readonly rows: readonly {
    readonly effectiveDate: LocalDate;
    readonly addedTicker: string | null;
    readonly addedName: string | null;
    readonly removedTicker: string | null;
    readonly removedName: string | null;
  }[];
  readonly evidence: string;
};

export const INDEX_CHANGE_LOG_CORRECTIONS: readonly IndexChangeLogCorrection[] =
  [
    {
      id: "DOW30:travelers-group-1997-03-17",
      indexKey: "DOW30",
      replaces: [
        { effectiveDate: "1998-10-08", addedTicker: "C", removedTicker: null },
      ],
      rows: [
        {
          effectiveDate: "1997-03-17",
          addedTicker: "C",
          addedName: "Travelers Group Inc. (Citigroup Inc. from 1998-10-08)",
          removedTicker: null,
          removedName: null,
        },
      ],
      evidence:
        "Dow Jones & Company announced that Hewlett-Packard, Johnson & Johnson, Travelers Group and " +
        "Wal-Mart Stores would replace Bethlehem Steel, Texaco, Westinghouse Electric and Woolworth " +
        "in the Dow Jones Industrial Average from 1997-03-17. The provider's log records the four " +
        "removals and three of the additions; Travelers Group appears only as an addition of " +
        "Citigroup on 1998-10-08, with no removal. Travelers Group became Citigroup in its merger " +
        "with Citicorp on 1998-10-08 and stayed in the average as the same component until its " +
        "removal on 2009-06-08, which the log records. Citigroup (C) is the legal successor whose " +
        "price history continues Travelers Group's.",
    },
    {
      id: "DOW30:dow-inc-2019-04-02",
      indexKey: "DOW30",
      replaces: [
        { effectiveDate: "2019-04-02", addedTicker: null, removedTicker: "DD" },
      ],
      rows: [
        {
          effectiveDate: "2019-04-02",
          addedTicker: "DOW",
          addedName: "Dow Inc.",
          removedTicker: "DWDP",
          removedName:
            "DowDuPont Inc. (DuPont de Nemours, Inc. from 2019-06-01)",
        },
      ],
      evidence:
        "S&P Dow Jones Indices announced that Dow Inc., spun off from DowDuPont, would replace " +
        "DowDuPont in the Dow Jones Industrial Average before the open on 2019-04-02. The provider's " +
        "log records the removal under DD, the ticker DowDuPont took when it was renamed DuPont de " +
        "Nemours on 2019-06-01, so it cannot be matched to DowDuPont's 2017-09-01 addition under " +
        "DWDP; and it records no addition of Dow Inc., whose 2024-11-08 removal it does record.",
    },
  ];

export type ChangeLogCorrectionOutcome = {
  readonly changes: StoredIndexChange[];
  readonly applied: readonly string[];
  readonly unmatched: readonly { id: string; reason: string }[];
};

const sameTicker = (left: string | null, right: string | null) =>
  (left ?? "").toUpperCase() === (right ?? "").toUpperCase();

export function applyChangeLogCorrections(
  indexKey: MarketIndexKey,
  changes: readonly StoredIndexChange[],
  corrections: readonly IndexChangeLogCorrection[] = INDEX_CHANGE_LOG_CORRECTIONS,
): ChangeLogCorrectionOutcome {
  let current = [...changes];
  const applied: string[] = [];
  const unmatched: { id: string; reason: string }[] = [];
  for (const correction of corrections) {
    if (correction.indexKey !== indexKey) {
      continue;
    }
    const removed = new Set<string>();
    let refusal: string | null = null;
    for (const target of correction.replaces) {
      const matches = current.filter(
        (row) =>
          row.effectiveDate === target.effectiveDate &&
          sameTicker(row.addedTicker, target.addedTicker) &&
          sameTicker(row.removedTicker, target.removedTicker),
      );
      if (matches.length !== 1) {
        refusal = `${matches.length} provider rows match ${target.effectiveDate} +${target.addedTicker ?? "-"} -${target.removedTicker ?? "-"}`;
        break;
      }
      removed.add((matches[0] as StoredIndexChange).contentHash);
    }
    if (refusal === null) {
      const present = correction.rows.find((row) =>
        current.some(
          (stored) =>
            stored.effectiveDate === row.effectiveDate &&
            sameTicker(stored.addedTicker, row.addedTicker) &&
            sameTicker(stored.removedTicker, row.removedTicker),
        ),
      );
      if (present) {
        refusal = `the provider already records ${present.effectiveDate} +${present.addedTicker ?? "-"} -${present.removedTicker ?? "-"}`;
      }
    }
    if (refusal !== null) {
      unmatched.push({ id: correction.id, reason: refusal });
      continue;
    }
    current = [
      ...current.filter((row) => !removed.has(row.contentHash)),
      ...correction.rows.map((row, index) => ({
        contentHash: `correction:${correction.id}:${index}`,
        effectiveDate: row.effectiveDate,
        changeType: "correction",
        addedTicker: row.addedTicker,
        addedName: row.addedName,
        removedTicker: row.removedTicker,
        removedName: row.removedName,
        reason: `Change-log correction ${correction.id}`,
        providerDateText: null,
      })),
    ];
    applied.push(correction.id);
  }
  current.sort((left, right) =>
    left.effectiveDate < right.effectiveDate
      ? -1
      : left.effectiveDate > right.effectiveDate
        ? 1
        : left.contentHash < right.contentHash
          ? -1
          : left.contentHash > right.contentHash
            ? 1
            : 0,
  );
  return { changes: current, applied, unmatched };
}
