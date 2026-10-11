import styles from "./MarketSparkline.module.css";

const VIEWBOX_WIDTH = 120;
const VIEWBOX_HEIGHT = 40;
/** Inset so a 1.5px stroke at the extremes is not clipped by the viewBox edge. */
const INSET = 3;

type MarketSparklineProps = {
  /** The line's values, oldest first. Their scale is irrelevant: the line is drawn to fit. */
  readonly values: readonly number[];
  readonly tone: "positive" | "negative" | "flat";
  /** Stable and unique on the page, so two lines cannot share a gradient id. */
  readonly idPrefix: string;
  /** What the line shows, in words: the accessible name of the image. */
  readonly label: string;
};

/**
 * A compact trend line: one year of weekly closes, with a faint baseline at where it started.
 *
 * Inline SVG rather than the product's charting library, and that is not a shortcut. Lightweight
 * Charts is the right tool for Stock Details and the backtest comparison — a real time scale,
 * crosshair, pan and zoom over thousands of bars — and every one of those capabilities is something
 * this must *not* have: no axes, no labels, no interaction, nothing that reflows. It also renders to
 * a canvas, which in a jsdom unit test is a blank rectangle; fifty-three points as markup are
 * assertable.
 *
 * The baseline is the first point's level, so a reader sees at a glance whether the year ended
 * above or below where it began — which is what the line's colour also says, from the 1Y return.
 *
 * The geometry is a pure function of the values, so the same series always draws the same path —
 * which is what makes a seeded screenshot comparable across runs. Its size comes from its container:
 * the SVG stretches to the box its parent gives it.
 */
export function MarketSparkline({
  values,
  tone,
  idPrefix,
  label,
}: MarketSparklineProps) {
  if (values.length < 2) {
    return null;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  // A flat series has no range to scale by; drawing it down the middle is the honest picture, and
  // dividing by zero would put it nowhere at all.
  const span = max - min || 1;
  const step = VIEWBOX_WIDTH / (values.length - 1);
  const bottom = VIEWBOX_HEIGHT - INSET;
  const y = (value: number) =>
    max === min
      ? VIEWBOX_HEIGHT / 2
      : round(bottom - ((value - min) / span) * (bottom - INSET));

  const coordinates = values.map(
    (value, index) => `${round(index * step)},${y(value)}`,
  );
  const baseline = y(values[0] as number);
  const gradientId = `${idPrefix}-sparkline-fill`;

  return (
    <svg
      className={styles.sparkline}
      viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      focusable="false"
      data-testid={`${idPrefix}-sparkline`}
      data-tone={tone}
      data-points={values.length}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" className={styles.fillStart} />
          <stop offset="100%" className={styles.fillEnd} />
        </linearGradient>
      </defs>
      <line
        className={styles.baseline}
        x1="0"
        x2={VIEWBOX_WIDTH}
        y1={baseline}
        y2={baseline}
      />
      <polygon
        className={styles.area}
        points={`0,${VIEWBOX_HEIGHT} ${coordinates.join(" ")} ${VIEWBOX_WIDTH},${VIEWBOX_HEIGHT}`}
        fill={`url(#${gradientId})`}
      />
      <polyline className={styles.line} points={coordinates.join(" ")} />
    </svg>
  );
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
