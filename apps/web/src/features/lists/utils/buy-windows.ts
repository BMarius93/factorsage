import type {
  BuyWindowRangeResponse,
  StockListItemResponse,
} from "@intrinsic/contracts";

/** Compact eligibility state shown on a membership row. */
export function buyWindowLabel(
  item: Pick<StockListItemResponse, "buyWindowMode" | "buyWindows">,
): string {
  if (item.buyWindowMode === "FULL") {
    return "Full history";
  }
  const count = item.buyWindows.length;
  return `Custom · ${count} ${count === 1 ? "window" : "windows"}`;
}

export function formatBuyWindowRange(range: BuyWindowRangeResponse): string {
  return `${range.startDate} → ${range.endDate ?? "no end date"}`;
}

/** One editable editor row. Empty `endDate` means open-ended. */
export type EditableBuyWindowRange = {
  readonly startDate: string;
  readonly endDate: string;
};

export function toEditableRanges(
  ranges: readonly BuyWindowRangeResponse[],
): EditableBuyWindowRange[] {
  return ranges.map((range) => ({
    startDate: range.startDate,
    endDate: range.endDate ?? "",
  }));
}

/**
 * Presentation-level validation for one editor row. The API (through the domain normalizer)
 * remains authoritative; this only catches what the user can see and fix in the form.
 */
export function editableRangeError(
  range: EditableBuyWindowRange,
): string | null {
  if (range.startDate === "") {
    return "Pick a start date";
  }
  if (range.endDate !== "" && range.endDate < range.startDate) {
    return "The end date is before the start date";
  }
  return null;
}

/**
 * Whether two rows describe overlapping or directly back-to-back periods, so the editor can tell
 * the user they will be saved as one continuous range. Feedback only — merging itself is the
 * API's job and its canonical response is what gets rendered after save.
 */
export function editableRangesTouch(
  ranges: readonly EditableBuyWindowRange[],
): boolean {
  const valid = ranges.filter((range) => editableRangeError(range) === null);
  const sorted = [...valid].sort((left, right) =>
    left.startDate < right.startDate ? -1 : left.startDate > right.startDate ? 1 : 0,
  );
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (!previous || !current) {
      continue;
    }
    if (previous.endDate === "") {
      return true;
    }
    const dayAfterPrevious = new Date(`${previous.endDate}T00:00:00.000Z`);
    dayAfterPrevious.setUTCDate(dayAfterPrevious.getUTCDate() + 1);
    if (current.startDate <= dayAfterPrevious.toISOString().slice(0, 10)) {
      return true;
    }
  }
  return false;
}
