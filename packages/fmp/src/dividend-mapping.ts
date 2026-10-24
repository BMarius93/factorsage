/**
 * The provider's dividend history for one security (`stable/dividends?symbol=`), mapped
 * (`docs/decisions/historical-universes-v1.md` §5).
 *
 * Measured on 2026-10-24 for AAPL: 92 rows from 1987, one per dividend, each with its ex-date
 * (`date`), record, payment and declaration dates — the declaration date is missing on 15 older
 * rows — the amount as declared (`dividend`), the amount split-adjusted onto today's share basis
 * (`adjDividend`), a frequency label and the provider's own `yield`. The yield is not mapped: it is
 * computed against a price the provider does not name, and a point-in-time yield is computed from
 * the stored close instead.
 *
 * A row without a readable ex-date, or without a positive amount, cannot be placed or counted and is
 * left out — and counted, so a response that loses rows says so.
 */

export type FmpDividendDto = {
  symbol?: string | null;
  date?: string | null;
  recordDate?: string | null;
  paymentDate?: string | null;
  declarationDate?: string | null;
  adjDividend?: number | string | null;
  dividend?: number | string | null;
  yield?: number | string | null;
  frequency?: string | null;
};

export type MappedFmpDividend = {
  /** The first session the shares trade without the dividend. */
  readonly exDate: string;
  readonly recordDate: string | null;
  readonly paymentDate: string | null;
  readonly declarationDate: string | null;
  /** As declared, per share at the time. */
  readonly amount: number;
  /** Split-adjusted onto the basis of the provider's adjusted closes. */
  readonly adjustedAmount: number;
  readonly frequency: string | null;
};

export type MappedFmpDividends = {
  readonly rows: readonly MappedFmpDividend[];
  readonly dropped: number;
};

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

function localDate(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().slice(0, 10);
  if (!LOCAL_DATE.test(trimmed)) {
    return null;
  }
  const parsed = new Date(`${trimmed}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== trimmed
    ? null
    : trimmed;
}

function amountOf(value: number | string | null | undefined): number | null {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number > 0
    ? number
    : null;
}

export function mapFmpDividends(
  payload: readonly FmpDividendDto[],
): MappedFmpDividends {
  const rows: MappedFmpDividend[] = [];
  let dropped = 0;
  for (const dto of payload) {
    const exDate = localDate(dto.date);
    const amount = amountOf(dto.dividend);
    // Both amounts are required: the split-adjusted one cannot be derived from the declared one
    // without the split history it already encodes, so a row missing either is left out.
    const adjustedAmount = amountOf(dto.adjDividend);
    if (!exDate || amount === null || adjustedAmount === null) {
      dropped += 1;
      continue;
    }
    const frequency =
      typeof dto.frequency === "string" && dto.frequency.trim().length > 0
        ? dto.frequency.trim()
        : null;
    rows.push({
      exDate,
      recordDate: localDate(dto.recordDate),
      paymentDate: localDate(dto.paymentDate),
      declarationDate: localDate(dto.declarationDate),
      amount,
      adjustedAmount,
      frequency,
    });
  }
  rows.sort((left, right) =>
    left.exDate < right.exDate ? -1 : left.exDate > right.exDate ? 1 : 0,
  );
  return { rows, dropped };
}
