import type { LiveFmpStoredDataset } from "./fmp-live-coverage";
import type { LiveFmpLedger } from "./fmp-live-guard";
import type { LiveFmpSecurityResult, LiveFmpStep } from "./fmp-live-hydration";
import type {
  LiveFmpResolvedSecurity,
  LiveFmpUnresolvedSymbol,
} from "./fmp-live-identity";
import {
  LIVE_FMP_EXCLUSIONS,
  liveFmpIncludedDatasets,
  type LiveFmpRequestCeiling,
} from "./fmp-live-plan";

/**
 * The end-of-run report, and the verdict it leads with.
 *
 * Everything in it is a name, a count, a date or a duration. It is written from the guard's
 * ledger, the loaders' step results and aggregate queries over what was stored — never from a
 * provider response — so it can be pasted into a pull request or a chat without carrying licensed
 * data, and there is no key in anything it is built from.
 */

export type LiveFmpOutcome =
  /** Every approved security resolved, every step completed, nothing was refused. */
  | "SUCCEEDED"
  /** A step failed, a symbol did not resolve, or a request outside the scope was refused. */
  | "FAILED"
  /** The request budget ran out. Whatever was stored is incomplete and is reported as such. */
  | "BUDGET_EXHAUSTED"
  /** `--plan`: nothing was asked of the provider. */
  | "PLANNED";

/** Process exit codes. `2` is a refused command line or environment, raised before a run exists. */
export const LIVE_FMP_EXIT_CODES: Readonly<Record<LiveFmpOutcome, number>> = {
  SUCCEEDED: 0,
  PLANNED: 0,
  FAILED: 1,
  BUDGET_EXHAUSTED: 3,
};

export const LIVE_FMP_REFUSED_EXIT_CODE = 2;

export type LiveFmpRunReport = {
  readonly runId: string;
  readonly outcome: LiveFmpOutcome;
  readonly databaseName: string;
  readonly databaseHost: string;
  readonly approved: readonly string[];
  readonly maxSecurities: number;
  readonly resolved: readonly LiveFmpResolvedSecurity[];
  readonly unresolved: readonly LiveFmpUnresolvedSymbol[];
  readonly securities: readonly LiveFmpSecurityResult[];
  /** Stored coverage by approved symbol. */
  readonly stored: ReadonlyMap<string, readonly LiveFmpStoredDataset[]>;
  readonly ledger: LiveFmpLedger;
  /** The budget counter as Redis holds it: the authoritative count of requests sent. */
  readonly budgetUsed: number;
  readonly ceiling: LiveFmpRequestCeiling;
  readonly productHistoryYears: number;
  readonly range: { readonly from: string; readonly to: string };
  readonly durationMs: number;
};

/**
 * The verdict. Decided from the guard as well as from the steps, on purpose: a loader is allowed
 * to treat "the provider did not answer" as something to degrade around, so a refused request
 * does not always surface as a failed step — and a run in which the provider was refused anything
 * must never be reported as complete.
 */
export function liveFmpOutcome(input: {
  readonly plan: boolean;
  readonly unresolved: readonly LiveFmpUnresolvedSymbol[];
  readonly securities: readonly LiveFmpSecurityResult[];
  readonly ledger: LiveFmpLedger;
}): LiveFmpOutcome {
  if (input.plan) {
    return "PLANNED";
  }
  if (input.ledger.budgetExhausted) {
    return "BUDGET_EXHAUSTED";
  }
  if (
    input.ledger.refusals.length > 0 ||
    input.unresolved.length > 0 ||
    input.securities.some((security) =>
      security.steps.some((step) => step.status !== "COMPLETED"),
    )
  ) {
    return "FAILED";
  }
  return "SUCCEEDED";
}

const STEP_LABELS: Readonly<Record<LiveFmpStep, string>> = {
  CORE_HISTORY: "prices, statements and derived state",
  VALUATION_INPUTS: "split list and valuation ratios",
  ALTERNATIVE_DATA: "insider and congressional trades",
};

/** The datasets a request is counted under, in the order a cold run reaches them. */
const REQUEST_DATASETS = [
  "SECURITY_PROFILE",
  "DAILY_PRICE",
  "FINANCIAL_STATEMENTS",
  "STOCK_SPLIT",
  "INSIDER_TRANSACTIONS",
  "CONGRESS_TRADES",
] as const;

const seconds = (durationMs: number): string =>
  `${(durationMs / 1000).toFixed(1)} s`;

const count = (value: number): string => value.toLocaleString("en-US");

function headline(report: LiveFmpRunReport): string {
  switch (report.outcome) {
    case "SUCCEEDED":
      return "SUCCEEDED";
    case "PLANNED":
      return "PLAN ONLY — nothing was asked of the provider";
    case "BUDGET_EXHAUSTED":
      return (
        `FAILED — the request budget of ${report.ledger.budget} was exhausted. ` +
        "What is stored is INCOMPLETE."
      );
    case "FAILED":
      return "FAILED";
  }
}

function requestLines(report: LiveFmpRunReport): string[] {
  const { ledger } = report;
  const lines = [
    `Provider requests: ${ledger.sent} sent of a budget of ${ledger.budget} ` +
      `(${ledger.authorized} distinct, ${Math.max(0, ledger.sent - ledger.authorized)} ` +
      `retried; budget counter ${report.budgetUsed}).`,
    `  Cold ceiling for ${report.approved.length} ` +
      `${report.approved.length === 1 ? "security" : "securities"}: ` +
      `${report.ceiling.total} without a retry, ${report.ceiling.totalWithEveryRetry} with ` +
      "every retry.",
  ];
  if (report.ceiling.total > ledger.budget) {
    lines.push(
      "  The budget is below that ceiling: a cold run with long insider or congressional " +
        "histories can exhaust it.",
    );
  }
  for (const { symbol } of report.resolved) {
    lines.push(`  ${symbol}`);
    for (const dataset of REQUEST_DATASETS) {
      const requests = ledger.byRequest.filter(
        (entry) => entry.symbol === symbol && entry.dataset === dataset,
      );
      const total = requests.reduce((sum, entry) => sum + entry.requests, 0);
      const endpoints = requests
        .map((entry) => `${entry.endpoint} ${entry.requests}`)
        .join(", ");
      lines.push(
        total === 0
          ? `    ${dataset.padEnd(22)} 0  (nothing asked: stored data was fresh or already covered)`
          : `    ${dataset.padEnd(22)} ${total}  (${endpoints})`,
      );
    }
  }
  return lines;
}

function refusalLines(ledger: LiveFmpLedger): string[] {
  if (ledger.refusals.length === 0) {
    return ["Refused requests: none."];
  }
  return [
    "Refused requests (none of these reached the provider):",
    ...ledger.refusals.map(
      (refusal) =>
        `  ${refusal.reason}: ${refusal.endpoint}` +
        `${refusal.symbol ? ` for ${refusal.symbol}` : ""} × ${refusal.count}`,
    ),
  ];
}

function hydrationLines(report: LiveFmpRunReport): string[] {
  const lines: string[] = [];
  for (const security of report.securities) {
    lines.push(`  ${security.symbol}  (${seconds(security.durationMs)})`);
    for (const step of security.steps) {
      const status =
        step.status === "COMPLETED"
          ? `completed in ${seconds(step.durationMs)}`
          : step.status === "FAILED"
            ? `FAILED — ${step.detail ?? "no detail"}`
            : `NOT RUN — ${step.detail ?? "no detail"}`;
      lines.push(`    ${STEP_LABELS[step.step]}: ${status}`);
    }
  }
  return lines;
}

function storedLines(report: LiveFmpRunReport): string[] {
  const lines: string[] = [];
  for (const { symbol } of report.resolved) {
    lines.push(`  ${symbol}`);
    for (const dataset of report.stored.get(symbol) ?? []) {
      const bounds =
        dataset.earliest && dataset.latest
          ? `  ${dataset.earliest} → ${dataset.latest}`
          : "";
      lines.push(
        `    ${dataset.dataset.padEnd(46)} ${count(dataset.rows).padStart(7)} row(s)${bounds}`,
      );
    }
    const ratios = report.securities.find(
      (security) => security.symbol === symbol,
    )?.ratios;
    for (const ratio of ratios ?? []) {
      lines.push(
        `    ${`ratio ${ratio.ratio} (computed on read)`.padEnd(46)} ` +
          `${count(ratio.sessionsWithValue).padStart(7)} of ${count(ratio.sessions)} session(s)` +
          (ratio.earliest && ratio.latest
            ? `  ${ratio.earliest} → ${ratio.latest}`
            : ""),
      );
    }
  }
  return lines;
}

export function formatLiveFmpReport(report: LiveFmpRunReport): string {
  const lines: string[] = [
    `Live FMP hydration: ${headline(report)}`,
    `Run ${report.runId} · database ${report.databaseName} on ${report.databaseHost} · ` +
      `${seconds(report.durationMs)}`,
    "",
    `Approved securities: ${report.approved.length} of at most ${report.maxSecurities} ` +
      `(${report.approved.join(", ")})`,
  ];
  for (const { symbol, security, origin } of report.resolved) {
    lines.push(
      `  ${symbol}  ${security.name} (${security.exchangeCode}) · security ${security.id} · ` +
        (origin === "CATALOG"
          ? "resolved from the security catalog"
          : "admitted to the security catalog from its provider profile"),
    );
  }
  for (const { symbol, reason } of report.unresolved) {
    lines.push(
      report.outcome === "PLANNED"
        ? `  ${symbol}  not in the security catalog — a run would ask the provider for its ` +
            "profile (one request) and admit it if it is a supported common stock"
        : `  ${symbol}  NOT RESOLVED — ${reason}`,
    );
  }

  if (report.outcome === "PLANNED") {
    lines.push(
      "",
      `A run would hydrate, per security, over ${report.range.from} → ${report.range.to}:`,
      ...liveFmpIncludedDatasets(report.productHistoryYears).map(
        (dataset) =>
          `  - ${dataset.dataset}: ${dataset.history}` +
          (dataset.endpoints.length > 0
            ? ` [${dataset.endpoints.join(", ")}]`
            : " [no provider request]"),
      ),
      "",
      `Request budget: ${report.ledger.budget}. Cold ceiling for ${report.approved.length} ` +
        `${report.approved.length === 1 ? "security" : "securities"}: ` +
        `${report.ceiling.total} without a retry (` +
        Object.entries(report.ceiling.perSecurity)
          .map(([cause, requests]) => `${cause} ${requests}`)
          .join(", ") +
        ` per security), ${report.ceiling.totalWithEveryRetry} with every retry.`,
    );
  } else {
    lines.push("", ...requestLines(report), ...refusalLines(report.ledger));
    if (report.securities.length > 0) {
      lines.push("", "Hydration", ...hydrationLines(report));
    }
    if (report.resolved.length > 0) {
      lines.push(
        "",
        `Stored in ${report.databaseName} (rows and date bounds; no row content is read)`,
        ...storedLines(report),
      );
    }
  }

  lines.push(
    "",
    "Never hydrated by this command:",
    ...LIVE_FMP_EXCLUSIONS.map(
      (exclusion) => `  - ${exclusion.operation}: ${exclusion.reason}`,
    ),
  );
  return lines.join("\n");
}
