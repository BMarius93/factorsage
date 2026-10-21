import { memo, useMemo } from "react";
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
 * A compact trend line: one period's closes, as the API prepared them, with a faint baseline at
 * where the period started.
 *
 * Inline SVG rather than the product's charting library, and that is not a shortcut. Lightweight
 * Charts is the right tool for Stock Details and the backtest comparison — a real time scale,
 * crosshair, pan and zoom over thousands of bars — and every one of those capabilities is something
 * this must *not* have: no axes, no labels, no interaction, nothing that reflows. It also renders to
 * a canvas, which in a jsdom unit test is a blank rectangle; a few dozen points as markup are
 * assertable. Twenty of them are twenty small SVGs, not twenty chart instances.
 *
 * The baseline is the first point's level — the period's anchor close — so a reader sees at a
 * glance whether the period ended above or below where it began, which is what the line's colour
 * also says, from the same period's return.
 *
 * The geometry is a pure function of the values, memoised on them, so the same series always draws
 * the same path — which is what makes a seeded screenshot comparable across runs. Its size comes
 * from its container: the SVG stretches to the box its parent gives it. Points are spaced by
 * session, as a market chart is: a weekend is not a gap.
 */
export const MarketSparkline = memo(function MarketSparkline({
  values,
  tone,
  idPrefix,
  label,
}: MarketSparklineProps) {
  const geometry = useMemo(() => sparklineGeometry(values), [values]);
  if (!geometry) {
    return null;
  }
  const { coordinates, baseline } = geometry;
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
        points={`0,${VIEWBOX_HEIGHT} ${coordinates} ${VIEWBOX_WIDTH},${VIEWBOX_HEIGHT}`}
        fill={`url(#${gradientId})`}
      />
      <polyline className={styles.line} points={coordinates} />
    </svg>
  );
});

/** The line's points and its baseline in viewBox units, or null for fewer than two values. */
function sparklineGeometry(
  values: readonly number[],
): { coordinates: string; baseline: number } | null {
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

  const coordinates = values
    .map((value, index) => `${round(index * step)},${y(value)}`)
    .join(" ");
  return { coordinates, baseline: y(values[0] as number) };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
