import type { LocalDate, SecurityId } from "./stock-data.js";

/**
 * One entry of the provider's split list for a security: the only record the provider keeps of the
 * adjustments it folds into the research close (`docs/decisions/valuation-ratios-v1.md`, "Corporate-
 * action events").
 *
 * `numerator : denominator` is the share ratio — 4:1 for a four-for-one split, 1:10 for a one-for-ten
 * reverse split — and so also the factor the provider divides every earlier close by. `0 : 1` marks
 * an entry whose ratio the provider left unreadable: no plain share change has it, so the entry
 * reads as a possible distribution. The label is the provider's own (`stock-split`,
 * `stock-dividend`, `spin-off`), kept as given: only an entry labelled `stock-split` with an exact
 * common ratio reads as a plain share change. The list is incomplete and includes announced events
 * before their date, which is why it is read only where a rule says so and never as a complete
 * history.
 */
export type StockSplit = {
  securityId: SecurityId;
  date: LocalDate;
  numerator: number;
  denominator: number;
  label: string | null;
};

/** The provider's label of an ordinary share split, the only one a plain share change may carry. */
export const STOCK_SPLIT_LABEL = "stock-split";
