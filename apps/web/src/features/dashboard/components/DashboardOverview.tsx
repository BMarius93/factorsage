"use client";

import type {
  DashboardRowResponse,
  MarketOverviewItemResponse,
} from "@intrinsic/contracts";
import Link from "next/link";
import type { ReactNode } from "react";
import { MarketSparkline } from "../../market/components/MarketSparkline";
import { VixGauge, vixZoneToneClass } from "../../market/components/VixGauge";
import { useMarketOverview } from "../../market/hooks/use-market-overview";
import {
  changeTone,
  formatChangePercent,
  formatMarketValue,
  formatSessionDate,
  marketCardDescription,
} from "../../market/utils/format";
import { classifyVix, VIX_STATUS_LABELS } from "../../market/utils/vix";
import {
  useSignInPrompt,
  type SignInPromptCopy,
} from "../../auth/hooks/use-sign-in-prompt";
import styles from "./DashboardOverview.module.css";

/** The canonical New Backtest route. There is exactly one, and this is it. */
const NEW_BACKTEST_HREF = "/backtests/new";

const SIGN_IN_TO_BACKTEST: SignInPromptCopy = {
  title: "Sign in to run a backtest",
  body: "A backtest belongs to an account: it runs in the background, keeps its results and stays reproducible. Sign in or create an account to run one — you will come straight back here.",
};

type DashboardOverviewProps = {
  /**
   * Every row the viewer's Dashboard source set returned, **before** the state and action filters.
   *
   * That is the whole point of passing them rather than the filtered list: the card reports what is
   * matching right now, and a reader narrowing the table below to `Buy` has not changed the market
   * or the monitors. A card that moved with the filters would be a second, worse copy of the counts
   * already on the filter buttons.
   */
  readonly rows: readonly DashboardRowResponse[];
  /** False while the Dashboard itself is still loading, so the count is never shown as a premature 0. */
  readonly rowsReady: boolean;
};

/**
 * The overview strip: five cards across the top of the Dashboard, in one visual family.
 *
 * `Run Backtest · S&P 500 · DJIA · VIX · Real-time Matches`. The order is fixed and the count is
 * exact — this is the row FactorSage V1 opened its Dashboard with, and the shape a returning user
 * recognises. What it is *not* is a place to keep adding metrics: breadth, valuation pulse, a
 * sentiment score and a second index each cost a reader more than they tell them.
 *
 * The Run Backtest item is a card, not a button parked beside cards. It is the same rectangle, the
 * same radius and the same row as the four beside it, wearing the product's one solid-blue action
 * treatment because it is the only thing here that does something.
 *
 * Nothing in this strip is live. The index cards are end-of-day closes and say which session they
 * closed on; describing them as real time would be the one mistake a market card can make that a
 * reader cannot detect.
 */
export function DashboardOverview({ rows, rowsReady }: DashboardOverviewProps) {
  const { status, overview } = useMarketOverview();
  const gate = useSignInPrompt();

  // An item per reference even before the response lands, so the grid is five cards wide from the
  // first paint and nothing below it moves when the market data arrives.
  const items = overview?.items ?? [];

  return (
    <section
      className={styles.overview}
      // Named as end-of-day, because the phone card has no room for the session pill and nothing
      // else on screen would tell a reader these are closes rather than live quotes.
      aria-label="Market overview at the last market close"
      data-testid="dashboard-overview"
    >
      <div className={styles.grid}>
        <RunBacktestCard gate={gate} />
        {items.length > 0
          ? items.map((item) => <ReferenceCard key={item.code} item={item} />)
          : PLACEHOLDER_CODES.map((placeholder) => (
              <ReferenceCard
                key={placeholder.code}
                item={{
                  code: placeholder.code,
                  label: placeholder.label,
                  status: "UNAVAILABLE",
                  sparkline: [],
                }}
                pending={status === "loading"}
              />
            ))}
        <MatchesCard rows={rows} ready={rowsReady} />
      </div>
      {gate.prompt}
    </section>
  );
}

/**
 * What the market cards are called before the server has said so.
 *
 * The server owns the list; this is only what the skeleton is labelled for the moment between
 * paint and response, and it is asserted against the response in the unit tests so the two cannot
 * drift into disagreeing about which three indices exist.
 */
const PLACEHOLDER_CODES = [
  { code: "SP500_INDEX", label: "S&P 500" },
  { code: "DJIA_INDEX", label: "DJIA" },
  { code: "VIX_INDEX", label: "VIX" },
] as const;

function RunBacktestCard({
  gate,
}: {
  readonly gate: ReturnType<typeof useSignInPrompt>;
}) {
  const content = (
    <>
      <span className={styles.actionText}>
        <span className={styles.actionTitle}>
          <span className={styles.fullLabel}>Run Backtest</span>
          <span className={styles.shortLabel}>Backtest</span>
        </span>
        <span className={styles.actionLead}>Test a strategy</span>
      </span>
      <span className={styles.actionGlyph} aria-hidden="true">
        <PlayIcon />
      </span>
    </>
  );

  // A signed-in viewer gets a real link: middle-click, open in a new tab and the browser's own
  // status bar all work, and none of them would if this were a button that navigated.
  //
  // A Guest gets a button, because the honest answer to the click is a question, not a destination.
  // `useSignInPrompt` asks it in place — `docs/decisions/builtin-dashboard-signals-v1.md` section
  // 5.1 refuses anonymous persistence, and bouncing a visitor to `/login` would throw away the
  // Dashboard they were reading in order to say so.
  //
  // While the session is still resolving the card is a button too: it cannot know yet, and
  // rendering a link a Guest would follow is the one wrong answer of the two.
  if (gate.signedIn) {
    return (
      <Link
        className={`${styles.card} ${styles.actionCard}`}
        href={NEW_BACKTEST_HREF}
        data-testid="dashboard-run-backtest"
      >
        {content}
      </Link>
    );
  }

  return (
    <button
      type="button"
      className={`${styles.card} ${styles.actionCard}`}
      data-testid="dashboard-run-backtest"
      onClick={() => gate.attempt(SIGN_IN_TO_BACKTEST, () => {})}
    >
      {content}
    </button>
  );
}

/** The market reference that is a level rather than a price, and is read as a gauge. */
const VIX_CODE = "VIX_INDEX";

/**
 * S&P 500 and DJIA read as a price with a trend; VIX reads as a level on a gauge. Same card, same
 * slot, same data — only the representation differs.
 */
function ReferenceCard(props: {
  readonly item: MarketOverviewItemResponse;
  readonly pending?: boolean;
}) {
  return props.item.code === VIX_CODE ? (
    <VixCard {...props} />
  ) : (
    <MarketCard {...props} />
  );
}

/**
 * VIX as a gauge: the title, a segmented arc with a marker, the level in the middle and its zone
 * underneath — the reading order of a dial, in the same card as its neighbours.
 *
 * Three things are deliberately unchanged from the other market cards:
 *
 * - **the number is the real `^VIX` close.** Not a 0–100 score, not a sentiment reading and not the
 *   clamped gauge position — a VIX of 93.4 says `93.40` while its marker sits at the end of the arc;
 * - **the change is still session over session**, now secondary: beside the title, with the session
 *   the close belongs to. Never "24h";
 * - **unavailable is unavailable.** No level means no gauge, no zone and no change — never a marker
 *   at zero labelled "Very low".
 *
 * It is called VIX and nothing else. The zone words describe the level of expected volatility; they
 * are not a fear-and-greed reading, and nothing here converts one into the other.
 */
function VixCard({
  item,
  pending,
}: {
  readonly item: MarketOverviewItemResponse;
  readonly pending?: boolean;
}) {
  const tone = changeTone(item.changePercent);
  const value = item.status === "AVAILABLE" ? item.value : undefined;
  const zone = classifyVix(value);
  const description =
    zone === null
      ? marketCardDescription(item)
      : `${marketCardDescription(item)} Volatility level: ${VIX_STATUS_LABELS[zone]}.`;

  return (
    <article
      className={`${styles.card} ${styles.vixCard}`}
      data-testid={`dashboard-market-card-${item.code}`}
      data-status={item.status}
      data-variant="gauge"
      aria-label={description}
    >
      <div className={styles.vixHead}>
        <p className={styles.label}>{item.label}</p>
        {value !== undefined ? (
          <p className={styles.vixMeta}>
            {item.changePercent === undefined ? null : (
              <span
                className={styles.change}
                data-tone={tone}
                data-testid={`dashboard-market-change-${item.code}`}
              >
                {formatChangePercent(item.changePercent)}
              </span>
            )}
            {item.sessionDate ? (
              <span className={styles.session}>
                {formatSessionDate(item.sessionDate)}
              </span>
            ) : null}
          </p>
        ) : null}
      </div>
      {value !== undefined && zone !== null ? (
        <>
          <div className={styles.vixDial}>
            <div className={styles.vixGauge}>
              <VixGauge value={value} status={zone} />
            </div>
            <p
              className={styles.vixValue}
              data-testid={`dashboard-market-value-${item.code}`}
            >
              {formatMarketValue(value)}
            </p>
          </div>
          <p
            className={`${styles.vixStatus} ${vixZoneToneClass}`}
            data-zone={zone}
            data-testid="dashboard-vix-status"
          >
            {VIX_STATUS_LABELS[zone]}
          </p>
        </>
      ) : (
        <p className={styles.valueUnavailable}>{pending ? "—" : "No data"}</p>
      )}
    </article>
  );
}

function MarketCard({
  item,
  pending,
}: {
  readonly item: MarketOverviewItemResponse;
  readonly pending?: boolean;
}) {
  const tone = changeTone(item.changePercent);
  const available = item.status === "AVAILABLE" && item.value !== undefined;

  return (
    <article
      className={styles.card}
      data-testid={`dashboard-market-card-${item.code}`}
      data-status={item.status}
      aria-label={marketCardDescription(item)}
    >
      <div className={styles.marketBody}>
        <div className={styles.marketFigures}>
          <p className={styles.label} title={item.label}>
            {item.label}
          </p>
          {available ? (
            <p
              className={styles.value}
              data-testid={`dashboard-market-value-${item.code}`}
            >
              {formatMarketValue(item.value as number)}
            </p>
          ) : (
            <p className={styles.valueUnavailable}>
              {pending ? "—" : "No data"}
            </p>
          )}
          <p className={styles.marketMeta}>
            {item.changePercent === undefined ? (
              // Never a fabricated 0.00%: one observation cannot say what the market did.
              <span className={styles.changeFlat}>—</span>
            ) : (
              <span
                className={styles.change}
                data-tone={tone}
                data-testid={`dashboard-market-change-${item.code}`}
              >
                {formatChangePercent(item.changePercent)}
              </span>
            )}
            {/* The session the numbers closed on, where V1 wore a "24h" pill. The pill is V1's;
                the words are not, because these are end-of-day closes and "24h" would describe a
                rolling window nothing here computes. */}
            {item.sessionDate ? (
              <span className={styles.session}>
                {formatSessionDate(item.sessionDate)}
              </span>
            ) : null}
          </p>
        </div>
        <div className={styles.marketTrend}>
          <p className={styles.trendLabel}>7D</p>
          <MarketSparkline
            points={item.sparkline}
            tone={tone}
            idPrefix={item.code}
          />
        </div>
      </div>
    </article>
  );
}

/**
 * How much is matching right now, from the Dashboard's own rows.
 *
 * Deliberately not a new endpoint. `GET /dashboard` already returns exactly the set this counts —
 * a Guest's published built-ins, a customer's visible built-ins plus their own eligible monitors —
 * and asking a second endpoint for a number derived from data already in hand would only create a
 * way for the card and the table below it to disagree.
 *
 * It is the *viewer's* count, never a platform-wide one. Two people with different monitors visible
 * see different numbers here, and that is correct.
 */
function MatchesCard({
  rows,
  ready,
}: {
  readonly rows: readonly DashboardRowResponse[];
  readonly ready: boolean;
}) {
  const active = rows.filter((row) => row.state === "ACTIVE").length;
  const waiting = rows.filter((row) => row.state === "PENDING_TRIGGER").length;

  return (
    <a
      className={`${styles.card} ${styles.matchesCard}`}
      href="#signals"
      data-testid="dashboard-matches-card"
    >
      <p className={styles.label}>
        <span className={styles.fullLabel}>Real-time Matches</span>
        <span className={styles.shortLabel}>Matches</span>
      </p>
      {ready ? (
        <p className={styles.value} data-testid="dashboard-matches-total">
          {rows.length}
        </p>
      ) : (
        <p className={styles.valueUnavailable}>—</p>
      )}
      <p
        className={styles.matchesBreakdown}
        data-testid="dashboard-matches-breakdown"
      >
        {ready ? `${active} active · ${waiting} waiting` : " "}
      </p>
    </a>
  );
}

function PlayIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
      <path d="M3 2.69a1.1 1.1 0 0 1 1.648-.96l9.401 5.311a1.1 1.1 0 0 1 0 1.918L4.648 14.271A1.1 1.1 0 0 1 3 13.311V2.69z" />
    </svg>
  );
}
