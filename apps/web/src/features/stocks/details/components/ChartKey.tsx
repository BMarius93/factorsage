import { CHART_COLORS } from "../utils/chart-theme";
import type { ChartOverlaySeries } from "../utils/chart-series";
import styles from "./ChartKey.module.css";

/**
 * The persistent key under the price chart (UI-018): what each line is, always visible, including on
 * touch where there is no hover. The chart's crosshair readout adds the values under the pointer.
 */
export function ChartKey({
  overlays,
}: {
  readonly overlays: readonly Pick<
    ChartOverlaySeries,
    "id" | "label" | "color"
  >[];
}) {
  return (
    <ul className={styles.key} aria-label="Chart key" data-testid="chart-key">
      <li className={styles.item}>
        <span
          className={styles.swatch}
          style={{ background: CHART_COLORS.price }}
          aria-hidden="true"
        />
        Close
      </li>
      {overlays.map((overlay) => (
        <li key={overlay.id} className={styles.item}>
          <span
            className={styles.swatch}
            style={{ background: overlay.color }}
            aria-hidden="true"
          />
          {overlay.label}
        </li>
      ))}
    </ul>
  );
}
