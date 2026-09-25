"use client";

import {
  AreaSeries,
  createChart,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
} from "lightweight-charts";
import { useEffect, useMemo, useRef } from "react";
import type { LogicalRange, TimeDomain } from "../../../../components/charts/time-domain";
import { useBoundedTimeScale } from "../../../../components/charts/use-bounded-time-scale";
import { RELATIVE_VOLUME_PERIODS, relativeVolumeLabel } from "@intrinsic/contracts";
import type { RelativeVolumeValuesResponse } from "@intrinsic/contracts";
import type {
  ChartLinePoint,
  ChartOverlaySeries,
  ChartPoint,
} from "../utils/chart-series";
import { CHART_COLORS } from "../utils/chart-theme";
import {
  formatCompactNumber,
  formatLocalDate,
  formatMoney,
} from "../utils/format";
import { HISTORY_EDGE_TRIGGER_BARS } from "../utils/history-window";
import styles from "./StockPriceChart.module.css";

/**
 * The shared oscillator pane. Every oscillator series draws into this one native Lightweight
 * Charts pane below the price pane, so all selected RSI periods share one fixed scale, one set of
 * reference lines, and the price chart's time scale and crosshair by construction. The library
 * creates the pane with the first series placed into it and removes it again with the last one.
 */
const OSCILLATOR_PANE_INDEX = 2;

/**
 * The volume pane, directly below the price pane and **always present**.
 *
 * Volume rides on every price bar, so unlike the oscillator pane this one is not created and
 * destroyed by a selection: it exists for as long as the chart does, which is what makes the
 * oscillator pane's index a constant rather than something to compute. Volume is a share count and
 * the price is money, so the two can never share an axis — a pane rather than an overlay is the
 * same decision the oscillators already made, for the same reason.
 */
const VOLUME_PANE_INDEX = 1;

/** Relative height of the oscillator pane; the price pane keeps its default factor of 1. */
const OSCILLATOR_PANE_STRETCH = 0.35;

/**
 * Relative height of the volume pane.
 *
 * **Stretch factors are relative, and the price pane's own is 2, not 1** — Lightweight Charts
 * creates its default pane at `DEFAULT_STRETCH_FACTOR * 2` while every added pane starts at 1. A
 * factor chosen as though the price pane were 1 collapses the pane it names to a sliver, which is
 * exactly what `0.2` did here. Against 2 this yields a little under a fifth of the chart, and the
 * wrapper grows by the same amount, so the price pane keeps the height it always had: the price
 * chart stays the primary chart, and volume is read as shape and relative height rather than off
 * an axis.
 */
const VOLUME_PANE_STRETCH = 0.45;

/**
 * The 30/50/70 orientation levels, rendered once per pane on the canonically first oscillator
 * series: 30 marks oversold, 70 overbought, 50 the midline. Muted, dashed and without axis labels
 * so they orient the reading without competing with the data lines.
 */
const OSCILLATOR_REFERENCE_LEVELS = [
  { price: 30, title: "Oversold 30" },
  { price: 50, title: "50" },
  { price: 70, title: "Overbought 70" },
] as const;

/**
 * Series data for one overlay, with its unavailable intervals actually broken.
 *
 * Two things happen here, because the library needs both:
 *
 * - A day with no value is emitted as **whitespace** (`{ time }` alone). That keeps the date on
 *   the series' own time scale and is the library's representation of "no observation here".
 * - The last real point *before* a gap is painted in a fully transparent colour. This is the part
 *   that removes the line, because Lightweight Charts filters whitespace rows out before
 *   rendering and would otherwise join the values on either side of the gap with one straight
 *   segment — the invented diagonal this whole behaviour exists to prevent. A point's colour
 *   styles the segment leaving it, so exactly the bridging segment disappears and every other
 *   segment keeps the overlay's own colour.
 */
function overlayLineData(points: readonly ChartLinePoint[]) {
  return points.map((point, index) => {
    if (point.value === undefined) {
      return { time: point.date as Time };
    }
    // `points[index + 1]?.value === undefined` would be true for the *last* point too, and
    // colouring that one transparent would erase the final segment of every overlay. The
    // successor has to exist and be whitespace.
    const next = points[index + 1];
    const bridgesAGap = next !== undefined && next.value === undefined;
    return bridgesAGap
      ? {
          time: point.date as Time,
          value: point.value,
          color: CHART_COLORS.overlayGap,
        }
      : { time: point.date as Time, value: point.value };
  });
}

/** An oscillator is unitless: legend and hover values never read as money. */
function formatOscillatorValue(value: number): string {
  return value.toFixed(1);
}

/** Volume is a share count, never money: `8_420_000` reads as `8.4M`. */
function formatVolumeValue(value: number): string {
  return formatCompactNumber(value);
}

/** Relative Volume is a multiple of its own baseline: `2.31` reads as `2.31x`. */
function formatRelativeVolumeValue(value: number): string {
  return `${value.toFixed(2)}x`;
}

export type StockPriceChartProps = {
  /** Ascending daily closing prices for the selected range. */
  readonly points: readonly ChartPoint[];
  /**
   * Ascending daily traded volume for the same sessions, drawn as the histogram below the price.
   * It shares the price series' time scale by construction: both come from the same canonical bars.
   */
  readonly volume: readonly ChartPoint[];
  /**
   * The precomputed Relative Volume readings per session, keyed by date.
   *
   * Reported in the hover legend rather than drawn: three permanent lines would compete with the
   * price for attention while saying something the volume bars already show the shape of. Nothing
   * is calculated here — these are the values the backend materialized.
   */
  readonly relativeVolume: ReadonlyMap<string, RelativeVolumeValuesResponse>;
  /** Overlay lines currently enabled; order controls legend order. */
  readonly overlays: readonly ChartOverlaySeries[];
  readonly currency: string;
  /** Dims the chart while a fuller history range is being loaded. */
  readonly loading?: boolean;
  /**
   * Identifies the window the chart should frame. The chart frames exactly once per value, so
   * everything the page does not encode into this key — new data, an overlay toggle, any other
   * rerender — leaves the user's window where it found it. The page changes it when a range is
   * picked, and once more when the history that range asked for has finished arriving.
   */
  readonly fitKey: string;
  /** First date the `fitKey` window should show. */
  readonly frameFrom: string;
  /** Last date the `fitKey` window should show. */
  readonly frameTo: string;
  /**
   * Oldest date this security may ever be navigated to: the 30-year product horizon narrowed by
   * the deployment's retention and the security's listing date, exactly as the API reports it.
   * It bounds the viewport, not just the fetching — no gesture may open more empty space to its
   * left than there is history still to arrive.
   */
  readonly historyStart: string;
  /**
   * No older history can arrive. The time scale is pinned to the oldest bar, so the user cannot
   * drag on into blank space beyond the 30-year boundary or the security's first trading day.
   */
  readonly historyExhausted: boolean;
  /**
   * The viewport has reached the oldest loaded bar. `barsBeforeLoaded` is how many trading days of
   * empty space lie to the left of the data, which is what sizes the next history request.
   */
  readonly onReachHistoryEdge?: (barsBeforeLoaded: number) => void;
  readonly ariaLabel: string;
};

type CrosshairContext = {
  overlays: readonly ChartOverlaySeries[];
  currency: string;
  relativeVolume: ReadonlyMap<string, RelativeVolumeValuesResponse>;
};

function legendRow(label: string, value: string, color?: string): HTMLElement {
  const row = document.createElement("span");
  row.className = styles.legendItem as string;
  if (color) {
    const dot = document.createElement("span");
    dot.className = styles.legendDot as string;
    dot.style.backgroundColor = color;
    row.append(dot);
  }
  const name = document.createElement("span");
  name.textContent = label;
  const amount = document.createElement("strong");
  amount.textContent = value;
  row.append(name, amount);
  return row;
}

/**
 * Lightweight Charts integration for the Stock Details price history.
 *
 * The legend names the always-visible close plus every enabled overlay, using the label the
 * overlay carries — which is the canonical selectable-series label the `Indicators` picker shows,
 * so the two can never disagree.
 *
 * The chart instance is created once and mutated through series `setData` calls; hover updates go
 * straight to a legend DOM node via the crosshair subscription so pointer movement never causes a
 * React render.
 *
 * Navigation is the library's standard set — drag to pan, wheel or pinch to zoom — and the chart
 * is where viewport-driven history loading starts: dragging or zooming past the oldest loaded bar
 * reports how much empty space is on screen, the page turns that into an older window to fetch,
 * and when it arrives the viewport is shifted by exactly the bars that appeared in front of it so
 * the user keeps looking at the days they navigated to.
 */
export function StockPriceChart({
  points,
  volume,
  relativeVolume,
  overlays,
  currency,
  loading = false,
  fitKey,
  frameFrom,
  frameTo,
  historyStart,
  historyExhausted,
  onReachHistoryEdge,
  ariaLabel,
}: StockPriceChartProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const legendRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const priceSeriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const overlaySeriesRef = useRef(new Map<string, ISeriesApi<"Line">>());
  /** Overlay ids drawn on the price scale, so a currency change re-formats exactly those. */
  const priceScaledOverlaysRef = useRef(new Set<string>());
  const currencyRef = useRef(currency);
  /** One stable money formatter; it reads the live currency rather than being recreated. */
  const moneyFormatterRef = useRef((value: number) =>
    formatMoney(value, currencyRef.current),
  );
  // The one set of oscillator reference lines, attached to the canonically first oscillator
  // series. Tracking the owner is what keeps repeated toggling from duplicating the levels.
  const oscillatorReferenceRef = useRef<{
    owner: ISeriesApi<"Line">;
    lines: IPriceLine[];
  } | null>(null);
  // The crosshair handler is subscribed once; refs keep it reading current props.
  const crosshairContextRef = useRef<CrosshairContext>({
    overlays,
    currency,
    relativeVolume,
  });
  crosshairContextRef.current = { overlays, currency, relativeVolume };
  // The time-scale subscription is registered once too, and reaching the history edge is reported
  // through a ref for the same reason: it must keep calling the current handler without
  // resubscribing, and without a viewport change ever costing a render.
  const historyEdgeRef = useRef<((bars: number) => void) | undefined>(undefined);
  historyEdgeRef.current = onReachHistoryEdge;
  // The framing this chart has already applied. Anything not in this signature — new data for the
  // same window, an overlay toggle, any other rerender — leaves the viewport alone.
  const framedRef = useRef<string | null>(null);
  // The oldest bar the price series is currently *drawing*, so a load that prepends older history
  // can be recognised and the user's window shifted by exactly the bars that appeared in front of
  // it. Paired with the oldest bar this render was *given*, the two also say whether the drawn
  // series is up to date — which is what makes a viewport report trustworthy.
  const drawnOldestRef = useRef<string | undefined>(undefined);
  const givenOldestRef = useRef<string | undefined>(undefined);
  givenOldestRef.current = points[0]?.date;

  const oldestBar = points[0]?.date;
  const newestBar = points[points.length - 1]?.date;
  // The domain this chart may be navigated inside: from the boundary the API reports back to, to
  // the latest bar there is. Both are dates the product owns — the 30-year horizon narrowed by
  // listing and retention, and the newest trading day — rather than anything derived from the
  // window that happens to be loaded.
  const domain = useMemo<TimeDomain>(
    () => ({
      minTime: historyStart,
      maxTime: newestBar ?? frameTo,
      oldestBar,
      domainComplete: historyExhausted,
      // Stock Details is always explorable; only the reach of the exploration is constrained.
      interaction: "BOUNDED",
    }),
    [historyStart, newestBar, frameTo, oldestBar, historyExhausted],
  );

  // The viewport, after the shared domain has had its say. Everything below reads an already
  // legal range, which is why reaching the history edge can be reported straight from it.
  const onVisibleRangeChange = (range: LogicalRange | null) => {
    const wrapper = wrapperRef.current;
    const chart = chartRef.current;
    if (!wrapper || !chart) {
      return;
    }
    if (range === null) {
      delete wrapper.dataset.visibleRange;
      delete wrapper.dataset.visibleLogical;
      return;
    }
    wrapper.dataset.visibleLogical = `${range.from.toFixed(2)}|${range.to.toFixed(2)}`;
    const dates = chart.timeScale().getVisibleRange();
    if (dates) {
      wrapper.dataset.visibleRange = `${String(dates.from)}|${String(dates.to)}`;
    }
    // Empty space to the left of the oldest bar: the user has navigated, by dragging or by
    // zooming out, into history that is not loaded yet. How much empty space there is decides
    // how much history to ask for, so it is reported rather than a bare event.
    // Only while the series on screen *is* the data this component was last given. Between a
    // load resolving and the effect that draws it, the chart still holds the shorter series and
    // the pre-shift window: reading that as navigation would size the next request against a
    // window the user has already been moved out of, and every pan would fetch twice.
    if (
      drawnOldestRef.current === givenOldestRef.current &&
      range.from < -HISTORY_EDGE_TRIGGER_BARS
    ) {
      historyEdgeRef.current?.(Math.ceil(-range.from));
    }
  };
  const { attachChart, applyFrame } = useBoundedTimeScale({
    domain,
    barCount: points.length,
    frame: { from: frameFrom, to: frameTo },
    onVisibleRangeChange,
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor: CHART_COLORS.text,
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        horzLines: { color: CHART_COLORS.grid },
        vertLines: { visible: false },
      },
      rightPriceScale: { borderColor: CHART_COLORS.axisBorder },
      timeScale: {
        borderColor: CHART_COLORS.axisBorder,
        timeVisible: false,
        // The default 0.5px minimum bar spacing caps the visible window at roughly two thousand
        // daily bars, which silently truncates fitContent() on decades of history (MAX range).
        minBarSpacing: 0.01,
      },
      crosshair: {
        horzLine: { color: CHART_COLORS.crosshair, labelBackgroundColor: CHART_COLORS.text },
        vertLine: { color: CHART_COLORS.crosshair, labelBackgroundColor: CHART_COLORS.text },
      },
      // Navigation — pan, wheel, pinch, and how far any of them may reach — belongs to the shared
      // bounded time scale attached below, so this chart has exactly one answer to "where may the
      // viewport go" rather than a set of options here and a boundary somewhere else.
    });
    const priceSeries = chart.addSeries(AreaSeries, {
      lineColor: CHART_COLORS.price,
      topColor: CHART_COLORS.priceAreaTop,
      bottomColor: CHART_COLORS.priceAreaBottom,
      lineWidth: 2,
      priceLineVisible: false,
      // Money formatting belongs to the series, never to the chart. A chart-level
      // `localization.priceFormatter` wins over every series' own `priceFormat`
      // unconditionally, which rendered the unitless oscillator pane's axis as currency —
      // `$64.87` for an RSI reading of 64.9. Each pane's axis now takes its format from the
      // series drawn in it, so price is money and the oscillator stays unitless.
      priceFormat: { type: "custom", formatter: moneyFormatterRef.current },
    });

    // Volume goes into its own always-present pane: a share count has no business on the price
    // scale, and the histogram's own `priceFormat` keeps its axis reading as a count rather than
    // as money. Its scale margins leave the bars sitting on the pane's floor.
    const volumeSeries = chart.addSeries(
      HistogramSeries,
      {
        color: CHART_COLORS.volume,
        priceLineVisible: false,
        lastValueVisible: false,
        priceFormat: {
          type: "custom",
          formatter: formatVolumeValue,
          minMove: 1,
        },
      },
      VOLUME_PANE_INDEX,
    );
    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.1, bottom: 0 },
    });

    const onCrosshairMove = (param: MouseEventParams<Time>) => {
      const legend = legendRef.current;
      if (!legend) {
        return;
      }
      const priceData = param.seriesData.get(priceSeries) as
        | { value?: number }
        | undefined;
      if (param.time === undefined || priceData?.value === undefined) {
        legend.hidden = true;
        return;
      }
      const {
        overlays: currentOverlays,
        currency: currentCurrency,
        relativeVolume: currentRelativeVolume,
      } = crosshairContextRef.current;
      legend.replaceChildren(legendRow(formatLocalDate(String(param.time)), ""));
      legend.append(
        legendRow(
          "Close",
          formatMoney(priceData.value, currentCurrency),
          CHART_COLORS.price,
        ),
      );
      const volumeData = param.seriesData.get(volumeSeries) as
        | { value?: number }
        | undefined;
      if (volumeData?.value !== undefined) {
        legend.append(
          legendRow(
            "Volume",
            formatVolumeValue(volumeData.value),
            CHART_COLORS.volume,
          ),
        );
      }
      // The three precomputed readings for the hovered session, in canonical period order. A
      // period still inside its warm-up has no entry and is simply not listed — the legend never
      // prints a multiple the backend did not materialize.
      const readings = currentRelativeVolume.get(String(param.time));
      if (readings) {
        for (const period of RELATIVE_VOLUME_PERIODS) {
          const value = readings[`rvol${period}` as keyof typeof readings];
          if (value !== undefined) {
            legend.append(
              legendRow(
                relativeVolumeLabel(period),
                formatRelativeVolumeValue(value),
              ),
            );
          }
        }
      }
      for (const overlay of currentOverlays) {
        const series = overlaySeriesRef.current.get(overlay.id);
        const data = series
          ? (param.seriesData.get(series) as { value?: number } | undefined)
          : undefined;
        if (data?.value !== undefined) {
          legend.append(
            legendRow(
              overlay.label,
              // An oscillator is unitless; only price-scaled overlays read as money.
              overlay.placement === "OSCILLATOR_PANE"
                ? formatOscillatorValue(data.value)
                : formatMoney(data.value, currentCurrency),
              overlay.color,
            ),
          );
        }
      }
      legend.hidden = false;
    };
    chart.subscribeCrosshairMove(onCrosshairMove);

    chartRef.current = chart;
    priceSeriesRef.current = priceSeries;
    volumeSeriesRef.current = volumeSeries;
    const overlaySeries = overlaySeriesRef.current;
    const priceScaledOverlays = priceScaledOverlaysRef.current;
    // Binds the domain: the edge pins, the gesture options, and the one subscription that reports
    // the viewport. Its callback is where this component publishes the window and asks for older
    // history, and it only ever sees a range the domain already allowed.
    const detachTimeScale = attachChart(chart);

    return () => {
      // chart.remove() disposes every series, pane, price line and subscription the instance
      // owns; the refs are cleared so a later effect run cannot touch disposed handles.
      detachTimeScale();
      chart.unsubscribeCrosshairMove(onCrosshairMove);
      chart.remove();
      chartRef.current = null;
      priceSeriesRef.current = null;
      volumeSeriesRef.current = null;
      overlaySeries.clear();
      priceScaledOverlays.clear();
      oscillatorReferenceRef.current = null;
      // Framing and the oldest drawn bar describe *this* chart instance. A replacement instance
      // has neither, and carrying them over would leave the new chart unframed at whatever bar
      // spacing the library defaults to — which is exactly what a development remount does.
      framedRef.current = null;
      drawnOldestRef.current = undefined;
    };
  }, [attachChart]);

  // The money formatter reads the current currency through a ref so the series options hold one
  // stable function: re-creating it on every render would rewrite every series' price format.
  useEffect(() => {
    currencyRef.current = currency;
    const priceFormat = {
      type: "custom" as const,
      formatter: moneyFormatterRef.current,
    };
    priceSeriesRef.current?.applyOptions({ priceFormat });
    for (const [id, series] of overlaySeriesRef.current) {
      if (priceScaledOverlaysRef.current.has(id)) {
        series.applyOptions({ priceFormat });
      }
    }
  }, [currency]);

  useEffect(() => {
    const chart = chartRef.current;
    const priceSeries = priceSeriesRef.current;
    if (!chart || !priceSeries) {
      return;
    }
    const timeScale = chart.timeScale();
    const previousOldest = drawnOldestRef.current;
    // Captured before the write: `setData` keeps the logical range, which is anchored to bar
    // indices, so prepending older history would silently walk the user's window backwards.
    const before = timeScale.getVisibleLogicalRange();

    priceSeries.setData(
      points.map((point) => ({ time: point.date as Time, value: point.value })),
    );
    // Written in the same effect as the price series so both panes always describe one window: a
    // separate effect could leave the volume pane a render behind during a history prepend, and
    // the logical-range shift below would then be applied against two different bar counts.
    volumeSeriesRef.current?.setData(
      volume.map((point) => ({ time: point.date as Time, value: point.value })),
    );
    // Keep the price pane dominant. Applied here rather than once at creation because the library
    // resets pane stretch factors when a pane is added or removed beneath this one.
    chart.panes()[VOLUME_PANE_INDEX]?.setStretchFactor(VOLUME_PANE_STRETCH);
    drawnOldestRef.current = points[0]?.date;

    // Older history arrived. Shifting the logical range by exactly the number of bars that
    // appeared in front of it leaves the user looking at the same days, with the empty space they
    // had dragged into now filled by the history fetched for it.
    const prepended =
      previousOldest === undefined
        ? 0
        : points.findIndex((point) => point.date === previousOldest);
    if (prepended > 0 && before) {
      timeScale.setVisibleLogicalRange({
        from: before.from + prepended,
        to: before.to + prepended,
      });
    }

    // Framing happens once per `fitKey`, on that key's first drawable frame. After that the
    // viewport belongs to the user, and an ordinary data update, an overlay toggle or any other
    // rerender must not snap it back.
    const oldest = points[0]?.date;
    if (oldest === undefined || framedRef.current === fitKey) {
      return;
    }
    framedRef.current = fitKey;
    // Through the bounded scale rather than the time scale directly, so framing is the same
    // bounded code path as a reset and cannot put the viewport somewhere a gesture could not.
    applyFrame(frameFrom, frameTo);
  }, [points, volume, fitKey, frameFrom, frameTo, applyFrame]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) {
      return;
    }
    const existing = overlaySeriesRef.current;
    const wanted = new Set(overlays.map((overlay) => overlay.id));
    for (const [id, series] of existing) {
      if (!wanted.has(id)) {
        // Removing the reference-line owner disposes its lines with it; forgetting that here
        // would try to detach lines from a dead series when the ownership moves on.
        if (oscillatorReferenceRef.current?.owner === series) {
          oscillatorReferenceRef.current = null;
        }
        chart.removeSeries(series);
        existing.delete(id);
        priceScaledOverlaysRef.current.delete(id);
      }
    }
    for (const overlay of overlays) {
      let series = existing.get(overlay.id);
      if (!series) {
        series =
          overlay.placement === "OSCILLATOR_PANE"
            ? chart.addSeries(
                LineSeries,
                {
                  color: overlay.color,
                  lineWidth: 2,
                  priceLineVisible: false,
                  lastValueVisible: false,
                  // The pane renders the catalog's fixed unit range instead of autoscaling, so
                  // every oscillator of the family shares one stable axis.
                  autoscaleInfoProvider: () => ({
                    priceRange: {
                      minValue: overlay.scale?.min ?? 0,
                      maxValue: overlay.scale?.max ?? 100,
                    },
                  }),
                  // Unitless axis labels; the chart-level formatter renders money.
                  priceFormat: {
                    type: "custom",
                    formatter: formatOscillatorValue,
                    minMove: 0.1,
                  },
                },
                OSCILLATOR_PANE_INDEX,
              )
            : chart.addSeries(LineSeries, {
                color: overlay.color,
                lineWidth: 2,
                priceLineVisible: false,
                lastValueVisible: false,
                priceFormat: {
                  type: "custom",
                  formatter: moneyFormatterRef.current,
                },
              });
        existing.set(overlay.id, series);
        if (overlay.placement !== "OSCILLATOR_PANE") {
          priceScaledOverlaysRef.current.add(overlay.id);
        }
      } else {
        // Overlay colour is assigned by position within the enabled set, so a reused series can
        // legitimately change colour when another overlay is added or removed.
        series.applyOptions({ color: overlay.color });
      }
      series.setData(overlayLineData(overlay.points));
    }

    // One set of 30/50/70 reference levels per pane, owned by the canonically first oscillator
    // series. When that series changes or disappears the lines move or vanish with it — never
    // accumulating across repeated toggles.
    const firstOscillator = overlays.find(
      (overlay) => overlay.placement === "OSCILLATOR_PANE",
    );
    const owner = firstOscillator
      ? existing.get(firstOscillator.id)
      : undefined;
    const reference = oscillatorReferenceRef.current;
    if (reference && reference.owner !== owner) {
      for (const line of reference.lines) {
        reference.owner.removePriceLine(line);
      }
      oscillatorReferenceRef.current = null;
    }
    if (owner && !oscillatorReferenceRef.current) {
      oscillatorReferenceRef.current = {
        owner,
        lines: OSCILLATOR_REFERENCE_LEVELS.map((level) =>
          owner.createPriceLine({
            price: level.price,
            title: level.title,
            color: CHART_COLORS.oscillatorReference,
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: false,
          }),
        ),
      };
    }
    if (owner) {
      // Keep the price pane dominant: the oscillator pane takes roughly a quarter of the height.
      const oscillatorPane = chart.panes()[OSCILLATOR_PANE_INDEX];
      oscillatorPane?.setStretchFactor(OSCILLATOR_PANE_STRETCH);
    }
    // Adding or removing the oscillator pane resets the stretch factors, so the volume pane is
    // restated here too rather than being left at the library's default once an RSI is toggled.
    chart.panes()[VOLUME_PANE_INDEX]?.setStretchFactor(VOLUME_PANE_STRETCH);
    // Deliberately no fitContent here: enabling or disabling an overlay is not a request to
    // reframe the history the user has scrolled to.
  }, [overlays]);

  const empty = points.length < 2;
  const hasOscillatorPane = overlays.some(
    (overlay) => overlay.placement === "OSCILLATOR_PANE",
  );
  // Gaps live on the canvas like the viewport does, so they are published the same way: this is
  // how a browser test tells "the model was unavailable across this interval, and the line is
  // broken there" from "the line was drawn straight through it".
  const seriesGaps = overlays
    .map(
      (overlay) =>
        `${overlay.id}:${overlay.points.filter((point) => point.value === undefined).length}`,
    )
    .join(",");

  return (
    <div
      ref={wrapperRef}
      className={styles.wrapper}
      data-loading={loading}
      // What is loaded and whether anything older can still arrive. Published for the same reason
      // the visible window is: both live on the canvas, and this is how a browser test tells
      // "the history grew" from "the viewport moved".
      data-loaded-from={points[0]?.date}
      data-history-exhausted={historyExhausted ? "true" : undefined}
      // The navigable domain itself, so a browser test can assert "the viewport stayed inside the
      // permitted thirty years" against the same bound the page navigates by.
      data-domain-from={historyStart}
      data-domain-to={domain.maxTime}
      // Bars on the scale, so a browser test can say "the viewport never ran past the newest bar"
      // in the logical terms the right-hand bound is expressed in.
      data-bar-count={points.length}
      // Volume lives on the canvas like the price does, so the count of drawn bars is published
      // the same way: this is how a browser test asserts the histogram was actually given data.
      data-volume-bars={volume.length}
      data-oscillator-pane={hasOscillatorPane ? "true" : undefined}
      // The reference levels are drawn on canvas, so this is the DOM-visible contract the
      // browser tests assert them through.
      data-series-gaps={overlays.length > 0 ? seriesGaps : undefined}
      data-oscillator-levels={
        hasOscillatorPane
          ? OSCILLATOR_REFERENCE_LEVELS.map((level) => level.price).join(",")
          : undefined
      }
    >
      <div
        ref={containerRef}
        className={styles.canvas}
        role="img"
        aria-label={ariaLabel}
      />
      <div
        ref={legendRef}
        data-testid="chart-legend"
        className={styles.legend}
        hidden
        aria-hidden="true"
      />
      {empty ? (
        <p className={styles.emptyMessage} role="status">
          Not enough price history to draw a chart.
        </p>
      ) : null}
      {loading ? (
        <div className={styles.loadingOverlay} role="status" aria-label="Loading price history">
          <span className={styles.spinner} aria-hidden="true" />
        </div>
      ) : null}
    </div>
  );
}
