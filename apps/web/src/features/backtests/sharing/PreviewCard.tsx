import {
  LEGAL_DISCLOSURES,
  type SharedBacktestPreviewResponse,
} from "@intrinsic/contracts";
import { BACKTEST_CHART_COLORS } from "../utils/chart-theme";
import { formatCount } from "../utils/format";
import { previewChartPaths } from "./preview-chart";
import { formatHeadlinePercent } from "./share-headline";

/**
 * The 1200 × 630 link-preview card, as `ImageResponse` renders it.
 *
 * Its hierarchy is the order a reader in a chat thumbnail takes it in: the annualized return,
 * large; the benchmark's, beside it; the curve; then the supporting facts. It uses the product's
 * own palette — the canvas, the hairline borders, the Strategy blue and the benchmark grey the
 * interactive chart draws with — and its own typeface, Geist. Every number is one the API read from
 * the stored result.
 *
 * Satori, which renders this, lays out with flexbox only and reads inline styles; there are no
 * CSS modules or tokens to ask for here, so the token values are written out, as the chart theme
 * does for the same reason.
 */

export const PREVIEW_CARD_WIDTH = 1200;
export const PREVIEW_CARD_HEIGHT = 630;

const INK = {
  canvas: "#fcfcfc",
  surface: "#ffffff",
  border: "#e6eaf5",
  primary: "#222222",
  body: "#404040",
  secondary: "#5e677b",
  muted: "#696e79",
  strategyInk: "#3b5ccc",
} as const;

const CHART_WIDTH = 564;
const CHART_HEIGHT = 318;

/** The first sentence of the product's backtest disclosure: what these numbers are. */
const SIMULATION_LABEL = LEGAL_DISCLOSURES.backtests.split(".")[0] ?? "";

const MONTH_YEAR = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

function monthYear(date: string): string {
  return MONTH_YEAR.format(new Date(`${date}T00:00:00.000Z`));
}

/** One supporting fact: a label and its value on one hairline-ruled row. */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "11px 0",
        borderTop: `1px solid ${INK.border}`,
      }}
    >
      <div
        style={{
          fontSize: 17,
          letterSpacing: 1.6,
          textTransform: "uppercase",
          color: INK.muted,
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 28, fontWeight: 600, color: INK.primary }}>
        {value}
      </div>
    </div>
  );
}

function LegendItem({
  color,
  label,
}: {
  readonly color: string;
  readonly label: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", marginRight: 28 }}>
      <div
        style={{
          width: 14,
          height: 14,
          borderRadius: 7,
          background: color,
          marginRight: 10,
        }}
      />
      <div style={{ fontSize: 20, color: INK.secondary }}>{label}</div>
    </div>
  );
}

export type PreviewCardProps = {
  readonly preview: SharedBacktestPreviewResponse;
  /** The wordmark, as a data URL: the renderer has no network and no file system of its own. */
  readonly logoSrc: string;
};

export function PreviewCard({ preview, logoSrc }: PreviewCardProps) {
  const { configuration, headline } = preview;
  const annualized = headline.portfolioCagrPercent !== null;
  const own = annualized
    ? (headline.portfolioCagrPercent as number)
    : headline.portfolioReturnPercent;
  const benchmark = annualized
    ? headline.benchmarkCagrPercent
    : headline.benchmarkReturnPercent;
  const benchmarkName = configuration.benchmark.name;
  const paths = previewChartPaths(preview.series, {
    width: CHART_WIDTH,
    height: CHART_HEIGHT,
  });

  return (
    <div
      style={{
        width: PREVIEW_CARD_WIDTH,
        height: PREVIEW_CARD_HEIGHT,
        display: "flex",
        flexDirection: "column",
        padding: "44px 56px 36px",
        background: INK.canvas,
        color: INK.primary,
        fontFamily: "Geist",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <img src={logoSrc} width={232} height={40} alt="" />
        <div
          style={{
            display: "flex",
            padding: "8px 18px",
            border: `1px solid ${INK.border}`,
            borderRadius: 999,
            background: INK.surface,
            fontSize: 20,
            color: INK.secondary,
          }}
        >
          Shared backtest report
        </div>
      </div>

      <div style={{ display: "flex", flex: 1, marginTop: 30 }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            width: 420,
            marginRight: 48,
            justifyContent: "center",
          }}
        >
          <div
            style={{
              fontSize: 18,
              letterSpacing: 2,
              textTransform: "uppercase",
              color: INK.muted,
              fontWeight: 600,
            }}
          >
            {annualized ? "Annualized return" : "Total return"}
          </div>
          <div
            style={{
              marginTop: 6,
              fontSize: 112,
              lineHeight: 1,
              fontWeight: 600,
              letterSpacing: -3,
              color: INK.strategyInk,
            }}
          >
            {formatHeadlinePercent(own)}
          </div>
          {benchmark === null ? null : (
            <div
              style={{
                display: "flex",
                marginTop: 14,
                fontSize: 34,
                color: INK.secondary,
              }}
            >
              <span style={{ marginRight: 10 }}>vs</span>
              <span style={{ fontWeight: 600, color: INK.body }}>
                {formatHeadlinePercent(benchmark)}
              </span>
              <span style={{ marginLeft: 10 }}>{benchmarkName}</span>
            </div>
          )}
          <div
            style={{ display: "flex", flexDirection: "column", marginTop: 30 }}
          >
            <Fact
              label="Max drawdown"
              value={formatHeadlinePercent(-headline.maxDrawdownPercent)}
            />
            <Fact
              label="Securities"
              value={formatCount(configuration.securityCount)}
            />
            <Fact
              label="Strategy rules"
              value={formatCount(configuration.strategyRuleCount)}
            />
          </div>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            padding: 28,
            border: `1px solid ${INK.border}`,
            borderRadius: 28,
            background: INK.surface,
          }}
        >
          {paths ? (
            <svg
              width={CHART_WIDTH}
              height={CHART_HEIGHT}
              viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
            >
              <path d={paths.strategyArea} fill="rgba(72, 130, 255, 0.10)" />
              {paths.benchmark ? (
                <path
                  d={paths.benchmark}
                  fill="none"
                  stroke={BACKTEST_CHART_COLORS.benchmark}
                  strokeWidth={3}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ) : null}
              <path
                d={paths.strategy}
                fill="none"
                stroke={BACKTEST_CHART_COLORS.strategy}
                strokeWidth={4}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </svg>
          ) : (
            <div
              style={{
                display: "flex",
                width: CHART_WIDTH,
                height: CHART_HEIGHT,
                alignItems: "center",
                justifyContent: "center",
                fontSize: 22,
                color: INK.muted,
              }}
            >
              No comparison curve
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", marginTop: 18 }}>
            {paths ? (
              <LegendItem
                color={BACKTEST_CHART_COLORS.strategy}
                label="Strategy"
              />
            ) : null}
            {paths?.benchmark ? (
              <LegendItem
                color={BACKTEST_CHART_COLORS.benchmark}
                label={benchmarkName}
              />
            ) : null}
            {/* The period the curve spans, where a reader looks for the chart's time axis. */}
            <div
              style={{
                display: "flex",
                marginLeft: "auto",
                fontSize: 20,
                fontWeight: 600,
                color: INK.body,
              }}
            >
              {`${monthYear(configuration.startDate)} – ${monthYear(configuration.endDate)}`}
            </div>
          </div>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          marginTop: 22,
          fontSize: 18,
          color: INK.muted,
        }}
      >
        {SIMULATION_LABEL}
      </div>
    </div>
  );
}
