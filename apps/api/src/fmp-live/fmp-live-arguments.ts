import { normalizeFmpSymbol } from "@intrinsic/fmp";

/**
 * The command line of `pnpm fmp:live`, and the three numbers that bound a run.
 *
 * Parsing touches nothing: no environment variable, no file, no database, no provider. A command
 * line that is wrong in any way is refused here, before the launcher has looked for a credential.
 * The limit it applies is not the limit — `FmpSecurityScope` counts the approved securities again
 * where the provider is actually asked, and a caller that never came through this file is held to
 * the same number there.
 */

/**
 * How many distinct securities one live run may ask the provider about.
 *
 * Three is a product decision, not a provider limit: enough to exercise every per-security dataset
 * on more than one company and to compare them, small enough that a run can never be a universe
 * load by accident. Read by this parser and by the provider scope alike.
 */
export const LIVE_FMP_MAX_SECURITIES = 3;

/**
 * The request budget a run gets when none is named, and the most one may be given.
 *
 * Derived, not guessed — `liveFmpRequestCeiling` in `fmp-live-plan.ts` computes the most requests a
 * cold full-history hydration can send from the loaders' own bounds, and
 * `fmp-live-plan.test.ts` holds these two to it:
 *
 * - the default covers three cold securities with every paged dataset at its page bound, plus
 *   headroom for retries;
 * - the maximum covers the same run with every request retried to the client's limit. Nothing a
 *   three-security run can legitimately need lies beyond it, so nothing beyond it can be asked for.
 */
export const LIVE_FMP_DEFAULT_REQUEST_BUDGET = 200;
export const LIVE_FMP_MAX_REQUEST_BUDGET = 600;

export const LIVE_FMP_USAGE =
  "Usage: RUN_LIVE_FMP_HYDRATION=1 pnpm fmp:live -- --symbols AAPL[,MSFT[,NVDA]] " +
  "--full-history [--budget N] [--plan]";

/** A command line this tool refuses. Raised before anything is read or opened. */
export class LiveFmpUsageError extends Error {
  override readonly name = "LiveFmpUsageError";
}

export type LiveFmpArguments = {
  /** Normalized, distinct, in the order first given. One to {@link LIVE_FMP_MAX_SECURITIES}. */
  readonly symbols: readonly string[];
  /** Total provider requests the run may send. */
  readonly budget: number;
  /** Resolve and report what would be asked, sending nothing. */
  readonly plan: boolean;
};

const FLAGS_WITH_VALUE = new Set(["--symbols", "--budget"]);
const FLAGS_WITHOUT_VALUE = new Set(["--full-history", "--plan"]);

/** Shows an argument back without letting it reshape the message. */
function quoted(value: string): string {
  const printable = value.replace(/[^\x20-\x7e]/g, "?");
  return `'${printable.length > 24 ? `${printable.slice(0, 24)}…` : printable}'`;
}

/**
 * One spelling per security, in the order first named.
 *
 * Deterministic and total: a symbol is trimmed and upper-cased, and anything that is not then a
 * symbol the canonical loader would accept is an error rather than something to drop. Duplicates
 * collapse **before** the count, so `AAPL,aapl, AAPL` is one security.
 */
export function normalizeLiveFmpSymbols(list: string): string[] {
  const symbols: string[] = [];
  for (const item of list.split(",")) {
    if (item.trim() === "") {
      throw new LiveFmpUsageError(
        "--symbols has an empty entry; pass a comma-separated list such as AAPL,MSFT,NVDA",
      );
    }
    const symbol = normalizeFmpSymbol(item);
    if (symbol === null) {
      throw new LiveFmpUsageError(
        `${quoted(item.trim())} is not a symbol: letters, digits, '.' and '-' only, at most 20`,
      );
    }
    if (!symbols.includes(symbol)) {
      symbols.push(symbol);
    }
  }
  if (symbols.length > LIVE_FMP_MAX_SECURITIES) {
    throw new LiveFmpUsageError(
      `A live run takes at most ${LIVE_FMP_MAX_SECURITIES} distinct securities; ` +
        `${symbols.length} were given (${symbols.join(", ")})`,
    );
  }
  return symbols;
}

function parseBudget(raw: string): number {
  if (!/^[1-9]\d{0,8}$/.test(raw)) {
    throw new LiveFmpUsageError(
      `--budget must be a positive whole number; received ${quoted(raw)}`,
    );
  }
  const budget = Number(raw);
  if (budget > LIVE_FMP_MAX_REQUEST_BUDGET) {
    throw new LiveFmpUsageError(
      `--budget may not exceed ${LIVE_FMP_MAX_REQUEST_BUDGET}; received ${budget}`,
    );
  }
  return budget;
}

/**
 * Parses the command line, refusing whatever it does not recognize.
 *
 * Strict on purpose. An unknown flag, a flag given twice, a stray word and a missing value are all
 * errors: a mistyped `--plan` must never become a real run, and `--symbols` given twice must never
 * be two lists somebody has to guess how to merge.
 */
export function parseLiveFmpArguments(
  argv: readonly string[],
): LiveFmpArguments {
  // pnpm forwards the `--` separator itself.
  const tokens = argv.filter((token) => token !== "--");
  const values = new Map<string, string>();
  const switches = new Set<string>();

  for (let index = 0; index < tokens.length; index += 1) {
    const flag = tokens[index] as string;
    if (values.has(flag) || switches.has(flag)) {
      throw new LiveFmpUsageError(`${flag} was given more than once`);
    }
    if (FLAGS_WITHOUT_VALUE.has(flag)) {
      switches.add(flag);
      continue;
    }
    if (FLAGS_WITH_VALUE.has(flag)) {
      const value = tokens[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new LiveFmpUsageError(`${flag} needs a value`);
      }
      values.set(flag, value);
      index += 1;
      continue;
    }
    throw new LiveFmpUsageError(`Unknown argument ${quoted(flag)}`);
  }

  const list = values.get("--symbols");
  if (list === undefined) {
    throw new LiveFmpUsageError(
      `--symbols is required: one to ${LIVE_FMP_MAX_SECURITIES} securities`,
    );
  }
  const symbols = normalizeLiveFmpSymbols(list);
  if (!switches.has("--full-history")) {
    throw new LiveFmpUsageError(
      "--full-history is required: it is the only thing this command hydrates, and it is named " +
        "so that a later, narrower mode can never become the default by omission",
    );
  }
  const budget = values.get("--budget");
  return {
    symbols,
    budget:
      budget === undefined
        ? LIVE_FMP_DEFAULT_REQUEST_BUDGET
        : parseBudget(budget),
    plan: switches.has("--plan"),
  };
}
