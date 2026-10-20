import type { BacktestTradeReason } from "@intrinsic/contracts";

/**
 * The trade log as CSV: a spreadsheet's copy of a run's transaction history.
 *
 * **Raw values, never presentation.** A date is ISO `YYYY-MM-DD`, an amount is the stored decimal
 * with no currency symbol, no grouping and no rounding, an action is its stable code. A spreadsheet
 * can then sort, sum and chart the columns without parsing a locale, and the file means the same
 * thing in every locale it is opened in.
 *
 * **RFC 4180.** Records end in CRLF; a field holding a comma, a double quote, a CR or an LF is
 * quoted, and a quote inside it is doubled.
 *
 * **Formula injection.** A spreadsheet executes a cell that begins with `=`, `+`, `-` or `@` — and,
 * in some, a tab or a CR — as a formula. Company names and strategy descriptions are text this file
 * does not control the first character of, so every **text** cell starting with one of those is
 * prefixed with `'`, which spreadsheets display as plain text. **Number** cells are exempt and stay
 * plain numbers: they are generated here from stored decimals, and a cell only counts as a number
 * if it matches a plain decimal literal — anything else is demoted to guarded text, so the
 * exemption cannot be used to smuggle a formula past the guard.
 */

/** One cell. Text is escaped and guarded; a number is a plain decimal literal and only escaped. */
export type CsvCell =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "number"; readonly value: string };

/** A stored decimal (Prisma's `Decimal`) or a whole number such as a sequence. */
export type CsvNumericValue = number | { toFixed(): string };

/**
 * The byte-order mark the export starts with.
 *
 * Present for one concrete reason: Excel decodes a CSV without it in the system's legacy code page,
 * not UTF-8. The log's text is not ASCII-only — a scoped strategy rule reads
 * `Insider sellers is above 2 (180D · CEO, CFO)`, and a company or member name may be accented — so
 * without the mark those characters open as mojibake in the most common spreadsheet. Built from
 * its code point so the source file holds no invisible character.
 */
export const UTF8_BOM = String.fromCharCode(0xfeff);

const RECORD_SEPARATOR = "\r\n";

const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/;

/** The first characters a spreadsheet may treat as the start of a formula. */
const FORMULA_TRIGGERS: ReadonlySet<string> = new Set([
  "=",
  "+",
  "-",
  "@",
  "\t",
  "\r",
]);

export function textCell(value: string | null): CsvCell {
  return { kind: "text", value: value ?? "" };
}

/**
 * A number this export generated. `null` is an empty cell — a buy realizes nothing, and an empty
 * cell is the truthful answer where a zero would be a claim.
 */
export function numberCell(value: CsvNumericValue | null): CsvCell {
  if (value === null) {
    return { kind: "text", value: "" };
  }
  const text = typeof value === "number" ? String(value) : value.toFixed();
  // `String(1e-7)` is `"1e-7"`, and a non-finite number is not a number at all: neither is a plain
  // decimal literal, so neither earns the exemption from the formula guard.
  return PLAIN_NUMBER.test(text)
    ? { kind: "number", value: text }
    : { kind: "text", value: text };
}

function encodeCell(cell: CsvCell): string {
  if (cell.kind === "number") {
    return cell.value;
  }
  const guarded = FORMULA_TRIGGERS.has(cell.value.charAt(0))
    ? `'${cell.value}`
    : cell.value;
  const needsQuotes =
    guarded.includes(",") ||
    guarded.includes('"') ||
    guarded.includes("\r") ||
    guarded.includes("\n");
  return needsQuotes ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

/** One CSV record, CRLF-terminated. */
export function csvRecord(cells: readonly CsvCell[]): string {
  return `${cells.map(encodeCell).join(",")}${RECORD_SEPARATOR}`;
}

// ---------------------------------------------------------------------------
// The trade log's columns
// ---------------------------------------------------------------------------

/**
 * The columns, in order. `Sequence` is the engine's execution order: it is what makes two trades on
 * one date sort the way they executed once the file is in a spreadsheet.
 *
 * `Level %` is the strategy level's percentage — what the log prints as `Buy 25%` — and is empty for
 * a FINAL EXIT and for an end-of-backtest liquidation, both of which close the whole position and
 * neither of which a percentage level decided. `Source` tells those two apart.
 */
export const TRADE_LOG_CSV_COLUMNS = [
  "Sequence",
  "Date",
  "Symbol",
  "Name",
  "Action",
  "Source",
  "Level %",
  "Shares",
  "Price",
  "Amount",
  "Realized P/L",
  "Realized P/L %",
  "Reason",
] as const;

export type TradeLogCsvTrade = {
  readonly sequence: number;
  /** ISO `YYYY-MM-DD`. */
  readonly date: string;
  readonly symbol: string;
  readonly name: string;
  readonly action: string;
  readonly source: string;
  readonly levelPercentage: number | null;
  readonly shares: CsvNumericValue;
  readonly price: CsvNumericValue;
  readonly amount: CsvNumericValue;
  readonly realizedPnl: CsvNumericValue | null;
  readonly realizedPnlPercent: CsvNumericValue | null;
  readonly reason: BacktestTradeReason | null;
};

/** What the log calls the end-of-backtest liquidation; it is the period ending, not a FINAL EXIT. */
const END_OF_BACKTEST_REASON = "End of backtest";

/**
 * The reason a trade happened, as one line of text — the sentence the trade log draws.
 *
 * Exactly the composition the browser renders: an Exit Rule's number when FINAL EXIT has several,
 * the Conditions joined by "and", then the Trigger. A trade the run could not attribute is an empty
 * cell, never a guess.
 */
export function tradeReasonText(reason: BacktestTradeReason | null): string {
  if (reason === null) {
    return "";
  }
  if (reason.kind === "END_OF_BACKTEST") {
    return END_OF_BACKTEST_REASON;
  }
  const rule =
    reason.exitRule === undefined ? "" : `Exit rule ${reason.exitRule}: `;
  const conditions = reason.conditions.join(" and ");
  const trigger = reason.trigger
    ? `${reason.conditions.length > 0 ? " · " : ""}Triggered: ${reason.trigger}`
    : "";
  return `${rule}${conditions}${trigger}`;
}

export function tradeLogCsvHeader(): string {
  return csvRecord(TRADE_LOG_CSV_COLUMNS.map((column) => textCell(column)));
}

export function tradeLogCsvRecord(trade: TradeLogCsvTrade): string {
  return csvRecord([
    numberCell(trade.sequence),
    textCell(trade.date),
    textCell(trade.symbol),
    textCell(trade.name),
    textCell(trade.action),
    textCell(trade.source),
    numberCell(trade.levelPercentage),
    numberCell(trade.shares),
    numberCell(trade.price),
    numberCell(trade.amount),
    numberCell(trade.realizedPnl),
    numberCell(trade.realizedPnlPercent),
    textCell(tradeReasonText(trade.reason)),
  ]);
}
