import type { MarketOverviewPoint } from "@intrinsic/contracts";
import type { MarketChangeTone } from "../utils/format";
import styles from "./MarketSparkline.module.css";

const VIEWBOX_WIDTH = 80;
const VIEWBOX_HEIGHT = 52;

type MarketSparklineProps = {
  readonly points: readonly MarketOverviewPoint[];
  readonly tone: MarketChangeTone;
  /** Stable, so two cards on one page cannot share a gradient id. */
  readonly idPrefix: string;
};

/**
 * The seven-session trend line on a market card.
 *
 * Inline SVG rather than the product's charting library, and that is not a shortcut. Lightweight
 * Charts is the right tool for Stock Details and the backtest comparison — a real time scale,
 * crosshair, pan and zoom over thousands of bars — and every one of those capabilities is something
 * this must *not* have: no axes, no labels, no interaction, nothing that reflows. It also renders to
 * a canvas, which in a jsdom unit test is a blank rectangle; seven points as markup are assertable.
 *
 * The geometry is a pure function of the values, so the same seven closes always draw the same
 * path — which is what makes a seeded screenshot comparable across runs.
 */
export function MarketSparkline({
  points,
  tone,
  idPrefix,
}: MarketSparklineProps) {
  if (points.length < 2) {
    return null;
  }

  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  // A flat series has no range to scale by; drawing it down the middle is the honest picture, and
  // dividing by zero would put it nowhere at all.
  const span = max - min || 1;
  const step = VIEWBOX_WIDTH / (values.length - 1);
  // Inset so a 1.75px stroke at the extremes is not clipped by the viewBox edge.
  const top = 4;
  const bottom = VIEWBOX_HEIGHT - 4;

  const coordinates = values.map((value, index) => {
    const x = round(index * step);
    const y = round(bottom - ((value - min) / span) * (bottom - top));
    return `${x},${y}`;
  });
  const gradientId = `${idPrefix}-sparkline-fill`;

  return (
    <svg
      className={styles.sparkline}
      viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
      preserveAspectRatio="none"
      // Decorative: the card's text already states the value and the change, so a reader loses
      // nothing by not being read a polyline.
      aria-hidden="true"
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
