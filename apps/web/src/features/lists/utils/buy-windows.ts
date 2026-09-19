import type {
  BuyWindowRangeResponse,
  StockListItemResponse,
} from "@intrinsic/contracts";
import { formatMembershipDate } from "./format";

/**
 * List membership, as the browser presents it.
 *
 * The API and the domain call this a *buy window* and that naming is kept end to end — see
 * `packages/domain/src/stock-lists.ts`. The UI says **membership**, because that is what a user is
 * actually describing: the period a stock was part of this list's universe, typically a
 * point-in-time index membership. The rule behind both names is the same one:
 *
 * > A buy window is the period during which a list member is eligible for **new BUY** actions. It
 * > does not constrain SELL actions for existing positions.
 *
 * The backend stores **any number** of periods per member, so a stock that left an index and later
 * rejoined is representable. The V1 editor deliberately exposes one — see `MembershipEditor`,
 * which refuses to overwrite a multi-period member without an explicit instruction.
 */

/** How an open-ended membership renders. Never `null`, `—`, `Today`, or a fabricated future date. */
export const PRESENT_LABEL = "Present";

/**
 * What the row and the editor show for a member with no date restriction at all.
 *
 * Not "full history": the mode says nothing about how much price history the stock has, only that
 * membership places no limit on when it may be bought.
 */
export const ALWAYS_ELIGIBLE_LABEL = "Always eligible";

/** `{ startDate: "1982-11-30", endDate: null }` → `"Nov 30, 1982 → Present"`. */
export function formatMembershipPeriod(range: BuyWindowRangeResponse): string {
  return `${formatMembershipDate(range.startDate)} → ${
    range.endDate === null ? PRESENT_LABEL : formatMembershipDate(range.endDate)
  }`;
}

/**
 * Where a member stands today, by meaning rather than by storage order (UI-019).
 *
 * - `CURRENT`: a period covers today — the stock is a member now.
 * - `UPCOMING`: no period covers today and one starts later; the earliest such period is shown.
 * - `ENDED`: every period is over; the most recent one is shown.
 *
 * Periods are stored sorted by start date, so "the first period" is the *oldest* — for a stock
 * that left an index in 2018 and rejoined last year, the one that no longer applies. Showing it
 * first made an eligible stock look ineligible at a glance.
 */
export type MembershipState = "CURRENT" | "UPCOMING" | "ENDED";

export type MembershipSummary = {
  readonly mode: StockListItemResponse["buyWindowMode"];
  /** Every stored period, in stored (chronological) order. Empty for `FULL`. */
  readonly periods: readonly BuyWindowRangeResponse[];
  /** The period that answers "is it a member today?", or `null` under `FULL`. */
  readonly leading: BuyWindowRangeResponse | null;
  readonly state: MembershipState | null;
};

/** Today as the `YYYY-MM-DD` day the member's periods are written in, in the viewer's calendar. */
export function todayIsoDate(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

export function membershipSummary(
  item: Pick<StockListItemResponse, "buyWindowMode" | "buyWindows">,
  today: string = todayIsoDate(),
): MembershipSummary {
  if (item.buyWindowMode === "FULL") {
    return { mode: "FULL", periods: [], leading: null, state: null };
  }
  const periods = item.buyWindows;
  const current = periods.find(
    (period) =>
      period.startDate <= today &&
      (period.endDate === null || period.endDate >= today),
  );
  if (current) {
    return { mode: "CUSTOM", periods, leading: current, state: "CURRENT" };
  }
  const upcoming = periods
    .filter((period) => period.startDate > today)
    .sort((a, b) => a.startDate.localeCompare(b.startDate))[0];
  if (upcoming) {
    return { mode: "CUSTOM", periods, leading: upcoming, state: "UPCOMING" };
  }
  const ended = [...periods].sort((a, b) =>
    (b.endDate ?? b.startDate).localeCompare(a.endDate ?? a.startDate),
  )[0];
  return {
    mode: "CUSTOM",
    periods,
    leading: ended ?? null,
    state: ended ? "ENDED" : null,
  };
}

/**
 * The cell's one-line answer: "Member now · since Sep 19, 2025", "Joins Jan 2, 2027",
 * "Ended Jun 29, 2018". The full periods are listed separately, never only in a tooltip.
 */
export function membershipHeadline(summary: MembershipSummary): string {
  const leading = summary.leading;
  if (summary.mode === "FULL" || leading === null) {
    return ALWAYS_ELIGIBLE_LABEL;
  }
  switch (summary.state) {
    case "CURRENT":
      return leading.endDate === null
        ? `Member now · since ${formatMembershipDate(leading.startDate)}`
        : `Member now · until ${formatMembershipDate(leading.endDate)}`;
    case "UPCOMING":
      return `Joins ${formatMembershipDate(leading.startDate)}`;
    default:
      return `Ended ${formatMembershipDate(leading.endDate ?? leading.startDate)}`;
  }
}

/**
 * The one membership period the V1 editor edits.
 *
 * `present` is the open-ended state and is the *only* way to express it: an empty `endDate` with
 * `present` false is an incomplete form, not an open-ended period. Keeping the two apart is what
 * lets the editor say "pick an end date, or choose Present" instead of silently saving an
 * open-ended membership the user never asked for.
 */
export type EditableMembership = {
  readonly startDate: string;
  /** Ignored while `present` is true. */
  readonly endDate: string;
  readonly present: boolean;
};

export const EMPTY_MEMBERSHIP: EditableMembership = {
  startDate: "",
  endDate: "",
  present: true,
};

/** Seeds the editor from the persisted canonical periods; the first one is what V1 edits. */
export function toEditableMembership(
  ranges: readonly BuyWindowRangeResponse[],
): EditableMembership {
  const first = ranges[0];
  if (!first) {
    return EMPTY_MEMBERSHIP;
  }
  return {
    startDate: first.startDate,
    endDate: first.endDate ?? "",
    present: first.endDate === null,
  };
}

/** The request body's single range. `present` is what becomes `endDate: null` over the wire. */
export function toRequestRange(membership: EditableMembership): {
  startDate: string;
  endDate: string | null;
} {
  return {
    startDate: membership.startDate,
    endDate: membership.present ? null : membership.endDate,
  };
}

/** Which control an editor message belongs to, so it can be wired to that field's `aria-describedby`. */
export type MembershipField = "startDate" | "endDate";

export type MembershipError = {
  readonly field: MembershipField;
  readonly message: string;
};

/**
 * Presentation-level validation for the one membership period.
 *
 * **The API is authoritative** — every rule here is the same rule `normalizeBuyWindowConfiguration`
 * enforces in `@intrinsic/domain`, restated only because `apps/web` may depend on `@intrinsic/contracts`
 * and not on `@intrinsic/domain`. Nothing here is stricter or laxer than the server; the two extra
 * messages ("pick a date") are form completeness, which the server sees as a missing field.
 */
export function membershipError(
  membership: EditableMembership,
): MembershipError | null {
  if (membership.startDate === "") {
    return { field: "startDate", message: "Pick the date membership starts" };
  }
  if (membership.present) {
    return null;
  }
  if (membership.endDate === "") {
    return {
      field: "endDate",
      message: "Pick the date membership ends, or choose Present",
    };
  }
  if (membership.endDate < membership.startDate) {
    return {
      field: "endDate",
      message: "Membership cannot end before it starts",
    };
  }
  return null;
}

/** The live preview under the fields: what will be saved, in the same words the row uses. */
export function previewMembershipPeriod(
  membership: EditableMembership,
): string | null {
  if (membershipError(membership) !== null) {
    return null;
  }
  return formatMembershipPeriod({
    startDate: membership.startDate,
    endDate: membership.present ? null : membership.endDate,
  });
}
