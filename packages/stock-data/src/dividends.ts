import { createHash } from "node:crypto";
import { Prisma, StockDataset, type PrismaClient } from "@intrinsic/database";
import type { LocalDate } from "@intrinsic/domain";

/**
 * Dividend history: storage and the point-in-time read (`docs/decisions/historical-universes-v1.md` §5).
 *
 * A security's dividends are replaced whole on every synchronization — the provider's list is the
 * history, and a corrected row must not survive beside its correction — and the synchronization is
 * recorded in `StockDatasetState` (`DIVIDEND`), which is also what a resumable ingestion reads to
 * know a security is done.
 */

export type DividendRow = {
  readonly exDate: LocalDate;
  readonly recordDate: LocalDate | null;
  readonly paymentDate: LocalDate | null;
  readonly declarationDate: LocalDate | null;
  readonly amount: number;
  readonly adjustedAmount: number;
  readonly frequency: string | null;
};

function dividendHash(row: DividendRow): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        row.exDate,
        row.recordDate,
        row.paymentDate,
        row.declarationDate,
        row.amount,
        row.adjustedAmount,
        row.frequency,
      ]),
    )
    .digest("hex");
}

const date = (value: LocalDate | null): Date | null =>
  value === null ? null : new Date(`${value}T00:00:00.000Z`);

const iso = (value: Date | null): LocalDate | null =>
  value === null ? null : (value.toISOString().slice(0, 10) as LocalDate);

/** Replaces one security's dividends and records the synchronization, in one transaction. */
export async function replaceDividendEvents(
  prisma: PrismaClient,
  input: {
    readonly securityId: string;
    readonly rows: readonly DividendRow[];
    readonly syncedAt: Date;
  },
): Promise<{ readonly stored: number }> {
  // The same dividend delivered twice (it happens in the provider's older history) is one row.
  const unique = new Map<string, DividendRow>();
  for (const row of input.rows) {
    unique.set(dividendHash(row), row);
  }
  const rows = [...unique.entries()];
  const exDates = input.rows.map((row) => row.exDate).sort();
  await prisma.$transaction(async (tx) => {
    await tx.dividendEvent.deleteMany({
      where: { securityId: input.securityId },
    });
    if (rows.length > 0) {
      await tx.dividendEvent.createMany({
        data: rows.map(([contentHash, row]) => ({
          securityId: input.securityId,
          exDate: date(row.exDate) as Date,
          recordDate: date(row.recordDate),
          paymentDate: date(row.paymentDate),
          declarationDate: date(row.declarationDate),
          amount: new Prisma.Decimal(row.amount),
          adjustedAmount: new Prisma.Decimal(row.adjustedAmount),
          frequency: row.frequency,
          contentHash,
          observedAt: input.syncedAt,
        })),
      });
    }
    const state = {
      earliestDate: date((exDates[0] as LocalDate | undefined) ?? null),
      latestDate: date(
        (exDates[exDates.length - 1] as LocalDate | undefined) ?? null,
      ),
      lastSuccessfulSyncAt: input.syncedAt,
    };
    await tx.stockDatasetState.upsert({
      where: {
        securityId_dataset_variant: {
          securityId: input.securityId,
          dataset: StockDataset.DIVIDEND,
          variant: "",
        },
      },
      create: {
        securityId: input.securityId,
        dataset: StockDataset.DIVIDEND,
        variant: "",
        ...state,
      },
      update: state,
    });
  });
  return { stored: rows.length };
}

/** The securities whose dividends have been synchronized at least once. */
export async function securitiesWithDividends(
  prisma: PrismaClient,
  securityIds: readonly string[],
): Promise<Set<string>> {
  const rows = await prisma.stockDatasetState.findMany({
    where: {
      securityId: { in: [...securityIds] },
      dataset: StockDataset.DIVIDEND,
      lastSuccessfulSyncAt: { not: null },
    },
    select: { securityId: true },
  });
  return new Set(rows.map((row) => row.securityId));
}

export async function loadDividendEvents(
  prisma: PrismaClient,
  securityIds: readonly string[],
): Promise<Map<string, DividendRow[]>> {
  const rows = await prisma.dividendEvent.findMany({
    where: { securityId: { in: [...securityIds] } },
    orderBy: [{ securityId: "asc" }, { exDate: "asc" }],
  });
  const bySecurity = new Map<string, DividendRow[]>();
  for (const row of rows) {
    const list = bySecurity.get(row.securityId) ?? [];
    list.push({
      exDate: iso(row.exDate) as LocalDate,
      recordDate: iso(row.recordDate),
      paymentDate: iso(row.paymentDate),
      declarationDate: iso(row.declarationDate),
      amount: row.amount.toNumber(),
      adjustedAmount: row.adjustedAmount.toNumber(),
      frequency: row.frequency,
    });
    bySecurity.set(row.securityId, list);
  }
  return bySecurity;
}

/** Payments per year a frequency label stands for; `null` for an irregular or unknown one. */
export function paymentsPerYear(frequency: string | null): number | null {
  switch ((frequency ?? "").toLowerCase().replace(/[\s_-]/g, "")) {
    case "monthly":
      return 12;
    case "quarterly":
      return 4;
    case "semiannual":
    case "semiannually":
      return 2;
    case "annual":
    case "annually":
    case "yearly":
      return 1;
    default:
      return null;
  }
}

/**
 * The indicated annual dividend per share on `date`, split-adjusted: the current regular rate times
 * the payments per year (`docs/decisions/historical-universes-v1.md` §5.3).
 *
 * - **Point in time.** Only dividends whose ex-date is on or before `date` are read. A dividend is
 *   declared before its ex-date, so one that has gone ex was certainly public on `date`; one declared
 *   but not yet ex is not read — the conventional indicated yield is the latest paid rate — so
 *   nothing announced after `date` can reach it.
 * - **Regular payments only.** A payment labelled special or irregular is a one-off, not a rate.
 * - **Payments per year** come from the provider's frequency label unless the regular payments with
 *   an ex-date in the year to `date` contradict it (a payer older than a year only); then from that
 *   count (10 or more: monthly; 3 to 6: quarterly; 2: semi-annual; 1: annual). The provider's labels
 *   are not reliable on their own: a one-off payment between quarterly ones is sometimes labelled
 *   monthly.
 * - **The rate** is the latest regular payment, unless it is less than half the median of that
 *   year's regular payments — an out-of-cycle payment, not a cut — when it is that median.
 * - Nothing is indicated when the latest regular payment went ex more than 400 days before `date`:
 *   a payer that stopped is not a payer.
 */
export function indicatedAnnualDividend(
  dividends: readonly DividendRow[],
  date: LocalDate,
): number | null {
  let latest: DividendRow | null = null;
  for (const dividend of dividends) {
    if (dividend.exDate > date || isIrregular(dividend.frequency)) {
      continue;
    }
    if (latest === null || dividend.exDate > latest.exDate) {
      latest = dividend;
    }
  }
  if (latest === null || daysBetween(latest.exDate, date) > 400) {
    return null;
  }
  const yearAgo = shiftDays(date, -365);
  const trailing = dividends.filter(
    (dividend) =>
      dividend.exDate > yearAgo &&
      dividend.exDate <= date &&
      !isIrregular(dividend.frequency),
  );
  // A payer whose first regular payment is inside the year cannot contradict its label yet.
  const newPayer = !dividends.some(
    (dividend) =>
      dividend.exDate <= yearAgo && !isIrregular(dividend.frequency),
  );
  const perYear = paymentsPerYearFor(
    paymentsPerYear(latest.frequency),
    trailing.length,
    newPayer,
  );
  if (perYear === null) {
    return null;
  }
  const amounts = trailing
    .map((dividend) => dividend.adjustedAmount)
    .sort((left, right) => left - right);
  const median =
    amounts.length === 0
      ? latest.adjustedAmount
      : amounts.length % 2 === 1
        ? (amounts[(amounts.length - 1) / 2] as number)
        : ((amounts[amounts.length / 2 - 1] as number) +
            (amounts[amounts.length / 2] as number)) /
          2;
  const rate =
    latest.adjustedAmount < median / 2 ? median : latest.adjustedAmount;
  return rate * perYear;
}

/** Whether a labelled frequency agrees with the regular payments counted in the trailing year. */
function labelAgrees(perYear: number, count: number): boolean {
  switch (perYear) {
    case 12:
      return count >= 8;
    case 4:
      return count >= 2 && count <= 6;
    case 2:
      return count >= 1 && count <= 3;
    case 1:
      return count >= 1 && count <= 2;
    default:
      return false;
  }
}

/**
 * Payments per year: the label when the trailing year's count agrees with it — or cannot yet
 * contradict it, for a new payer or a year without a payment — otherwise the count's.
 */
export function paymentsPerYearFor(
  label: number | null,
  trailingCount: number,
  newPayer = false,
): number | null {
  if (
    label !== null &&
    (newPayer || trailingCount === 0 || labelAgrees(label, trailingCount))
  ) {
    return label;
  }
  if (trailingCount >= 10) return 12;
  if (trailingCount >= 3 && trailingCount <= 6) return 4;
  if (trailingCount === 2) return 2;
  if (trailingCount === 1) return 1;
  // 7 to 9 in a year: between quarterly and monthly; a monthly label settles it, nothing else does.
  if (trailingCount >= 7) return label === 12 ? 12 : null;
  return null;
}

function isIrregular(frequency: string | null): boolean {
  const label = (frequency ?? "").toLowerCase();
  return label.includes("irregular") || label.includes("special");
}

function daysBetween(from: LocalDate, to: LocalDate): number {
  return (
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
    86_400_000
  );
}

function shiftDays(date: LocalDate, days: number): LocalDate {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10) as LocalDate;
}
