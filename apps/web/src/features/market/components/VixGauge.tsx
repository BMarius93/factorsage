import {
  VIX_ZONES,
  vixGaugeFraction,
  vixZoneSpan,
  type VixStatus,
} from "../utils/vix";
import styles from "./VixGauge.module.css";

const WIDTH = 100;
const HEIGHT = 54;
const CX = 50;
const CY = 49;
const RADIUS = 42;
/** Angular gap between segments, as a fraction of the arc — the reference's segmented look. */
const GAP = 0.012;

type VixGaugeProps = {
  /** The real VIX close. Drawn as a marker position only; never shown by this component. */
  readonly value: number;
  readonly status: VixStatus;
};

/**
 * The VIX card's semicircular gauge: one segment per zone of `VIX_ZONES`, and a marker.
 *
 * Decorative by construction (`aria-hidden`): the card states the value and the zone as text, so a
 * reader who cannot see the arc loses nothing, and nothing depends on a colour or a position.
 *
 * The geometry is a pure function of the value, so a seeded screenshot is identical run to run.
 * Inline SVG for the same reason the sparkline is: no chart dependency, no canvas, no animation.
 *
 * The marker's position comes from `vixGaugeFraction`, which clamps at 80 — the end of the arc means
 * "80 or more". The number beside it is never clamped.
 */
export function VixGauge({ value, status }: VixGaugeProps) {
  const fraction = vixGaugeFraction(value);
  if (fraction === null) {
    return null;
  }
  const marker = point(fraction);

  return (
    <svg
      className={styles.gauge}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      aria-hidden="true"
      focusable="false"
      data-testid="dashboard-vix-gauge"
      data-fraction={fraction.toFixed(4)}
      data-status={status}
    >
      {VIX_ZONES.map((zone, index) => {
        const span = vixZoneSpan(zone);
        const start = span.start + (index === 0 ? 0 : GAP / 2);
        const end = span.end - (index === VIX_ZONES.length - 1 ? 0 : GAP / 2);
        return (
          <path
            key={zone.status}
            className={`${styles.segment} ${styles.zoneTone}`}
            data-zone={zone.status}
            // Only the zone the value is in is drawn at full strength; the rest recede, so the arc
            // says where the market is before it says where it could be.
            data-active={zone.status === status ? "true" : undefined}
            d={arc(start, end)}
          />
        );
      })}
      <circle
        className={`${styles.marker} ${styles.zoneTone}`}
        data-zone={status}
        data-testid="dashboard-vix-marker"
        cx={marker.x}
        cy={marker.y}
        r={4.5}
      />
    </svg>
  );
}

/** The class that maps `data-zone` to its colour, for anything else that shows a zone. */
export const vixZoneToneClass = styles.zoneTone as string;

/** A point on the arc: `0` is the left end, `1` the right, across the top. */
function point(fraction: number): { x: number; y: number } {
  const angle = Math.PI * (1 - fraction);
  return {
    x: round(CX + RADIUS * Math.cos(angle)),
    y: round(CY - RADIUS * Math.sin(angle)),
  };
}

function arc(from: number, to: number): string {
  const start = point(from);
  const end = point(to);
  // Every segment spans less than half the circle, and the sweep runs clockwise on screen — left
  // to right across the top.
  return `M ${start.x} ${start.y} A ${RADIUS} ${RADIUS} 0 0 1 ${end.x} ${end.y}`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
