import styles from "./LimitMeter.module.css";

type LimitMeterProps = {
  /** What is being counted, e.g. "Stocks in this list", "Active monitors". */
  readonly label: string;
  readonly usage: number;
  /** `null` is unbounded; the meter then states the usage and no ceiling. */
  readonly limit: number | null;
  /** Singular and plural noun for the count, e.g. ["stock", "stocks"]. */
  readonly unit: readonly [string, string];
  readonly testId?: string;
};

/**
 * "N of LIMIT" for a quantity the plan caps, shown wherever that quantity is edited (UI-020).
 *
 * Presentation only. The feature passes the usage it already holds and the limit from resolved
 * entitlements — never a number of its own — and the API still enforces the limit. The words carry
 * the state ("10 of 10 stocks · at your plan's limit"); the bar only echoes them.
 */
export function LimitMeter({
  label,
  usage,
  limit,
  unit,
  testId,
}: LimitMeterProps) {
  const noun = (count: number) => (count === 1 ? unit[0] : unit[1]);
  const state =
    limit === null
      ? "open"
      : usage > limit
        ? "over"
        : usage === limit
          ? "full"
          : "open";
  const fill =
    limit === null || limit === 0 ? 0 : Math.min(100, (usage / limit) * 100);
  const summary =
    limit === null
      ? `${usage} ${noun(usage)}`
      : `${usage} of ${limit} ${noun(limit)}`;
  const suffix =
    state === "over"
      ? ` · ${usage - (limit ?? 0)} over your plan's limit`
      : state === "full"
        ? " · at your plan's limit"
        : "";

  return (
    <div
      className={styles.meter}
      data-state={state}
      {...(testId ? { "data-testid": testId } : {})}
    >
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>
        {summary}
        {suffix}
      </span>
      {limit === null ? null : (
        <span className={styles.track} aria-hidden="true">
          <span className={styles.fill} style={{ width: `${fill}%` }} />
        </span>
      )}
    </div>
  );
}
