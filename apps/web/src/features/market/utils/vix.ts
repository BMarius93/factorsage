/**
 * How the Dashboard reads a VIX level: a qualitative zone, and where a marker sits on a gauge.
 *
 * Two things this module is deliberately **not**:
 *
 * - **Not a transformation of the value.** The number a reader sees is always the real `^VIX` close
 *   from `GET /market-overview`, unchanged — `15.43` is shown as `15.43`, and `93.4` as `93.4`.
 *   Nothing here produces a 0–100 score, a percentage, a "fear" reading or any other derived market
 *   value, and nothing downstream may present one.
 * - **Not a bounded scale.** VIX has no maximum: it closed above 80 in 2008 and in 2020. The gauge
 *   therefore uses an explicitly *clamped display range*, 0 to {@link VIX_GAUGE_MAX}, which exists
 *   only to decide where a marker is drawn. Anything at or above it pins the marker to the end of the
 *   arc — the visual endpoint means "80 or more" — while the text keeps the real number.
 *
 * The zone boundaries live in {@link VIX_ZONES} and nowhere else: classification, the arc's
 * segments and their colours are all derived from that one table.
 */

export const VIX_STATUSES = [
  "VERY_LOW",
  "NORMAL",
  "ELEVATED",
  "HIGH",
  "EXTREME",
] as const;

export type VixStatus = (typeof VIX_STATUSES)[number];

/**
 * The end of the gauge's display range. A drawing bound, not a market bound: a VIX of 90 is shown
 * as `90.00` with the marker at the end of the arc.
 */
export const VIX_GAUGE_MAX = 80;

export type VixZone = {
  readonly status: VixStatus;
  readonly label: string;
  /** Inclusive lower bound. */
  readonly from: number;
  /** Exclusive upper bound; `null` for the open-ended last zone. */
  readonly to: number | null;
};

/**
 * The one place the boundaries are written down. `from` is inclusive and `to` exclusive, so a VIX of
 * exactly 20 is `ELEVATED`, not `NORMAL`.
 */
export const VIX_ZONES: readonly VixZone[] = [
  { status: "VERY_LOW", label: "Very low", from: 0, to: 12 },
  { status: "NORMAL", label: "Normal", from: 12, to: 20 },
  { status: "ELEVATED", label: "Elevated", from: 20, to: 30 },
  { status: "HIGH", label: "High", from: 30, to: 40 },
  { status: "EXTREME", label: "Extreme", from: 40, to: null },
];

export const VIX_STATUS_LABELS: Record<VixStatus, string> = Object.fromEntries(
  VIX_ZONES.map((zone) => [zone.status, zone.label]),
) as Record<VixStatus, string>;

/**
 * The zone a VIX level falls in, or `null` when there is no valid level to classify.
 *
 * `null` for a non-finite or negative input, never a guess: an unavailable VIX must not be rendered
 * as "Very low", which is what treating a missing value as zero would silently do.
 */
export function classifyVix(value: number | undefined): VixStatus | null {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return null;
  }
  const zone = VIX_ZONES.find(
    (candidate) => candidate.to === null || value < candidate.to,
  );
  return zone?.status ?? null;
}

/**
 * Where the gauge marker sits, as a fraction of the arc from 0 (left) to 1 (right).
 *
 * Linear over the clamped display range `0..VIX_GAUGE_MAX`, so a zone's share of the arc is its
 * share of that range — `Extreme` (40 to 80+) is honestly half of it. Values at or above the maximum
 * pin to `1`. `null` exactly when {@link classifyVix} is `null`, so a card can never draw a marker
 * for a level it could not classify.
 */
export function vixGaugeFraction(value: number | undefined): number | null {
  if (classifyVix(value) === null) {
    return null;
  }
  return Math.min(value as number, VIX_GAUGE_MAX) / VIX_GAUGE_MAX;
}

/** A zone's extent on the arc, as fractions — the segments the gauge draws. */
export function vixZoneSpan(zone: VixZone): { start: number; end: number } {
  return {
    start: zone.from / VIX_GAUGE_MAX,
    end: Math.min(zone.to ?? VIX_GAUGE_MAX, VIX_GAUGE_MAX) / VIX_GAUGE_MAX,
  };
}
