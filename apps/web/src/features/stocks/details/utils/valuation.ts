import {
  INTRINSIC_VALUE_BLEND_OPTIONS,
  INTRINSIC_VALUE_MODEL_OPTIONS,
  type IntrinsicValueBlendIdResponse,
  type IntrinsicValueBlendResponse,
  type IntrinsicValueModelResponse,
  type IntrinsicValueResponse,
} from "@intrinsic/contracts";

/**
 * Latest-point selection over the materialized intrinsic-value series.
 *
 * The API returns one point per model/blend per trading day in ascending order; the summary keeps
 * each series' newest point together with its own valuation date so different point-in-time dates
 * are never silently merged. No valuation math happens here — values come from the backend as-is,
 * and the only derivation is the display-level upside of a value against a price.
 */
export type LatestBlendValuation = {
  blendId: IntrinsicValueBlendIdResponse;
  label: string;
  valuePerShare: number;
  currency: string;
  valuationDate: string;
};

export type LatestModelValuation = {
  model: IntrinsicValueModelResponse;
  label: string;
  valuePerShare: number;
  currency: string;
  valuationDate: string;
};

export type ValuationSnapshot = {
  blends: LatestBlendValuation[];
  models: LatestModelValuation[];
  /** Newest valuation date among the entries shown. */
  asOfDate: string;
};

/**
 * Blend and model identities, ordering and labels come from the canonical selectable-series
 * catalog. This summary deliberately keeps no list of its own: the catalog is the single product
 * source of truth, and a second local map is exactly how the labels here drifted from it before.
 * There is one label per series — the canonical one — and no shorter presentation variant.
 */
const BLEND_ENTRIES = INTRINSIC_VALUE_BLEND_OPTIONS;
const MODEL_ENTRIES = INTRINSIC_VALUE_MODEL_OPTIONS;

function latestByKey<TKey extends string, TPoint extends { valuationDate: string }>(
  points: readonly TPoint[],
  keyOf: (point: TPoint) => TKey,
): Map<TKey, TPoint> {
  const latest = new Map<TKey, TPoint>();
  for (const point of points) {
    const key = keyOf(point);
    const current = latest.get(key);
    if (!current || point.valuationDate >= current.valuationDate) {
      latest.set(key, point);
    }
  }
  return latest;
}

/** Returns `undefined` when no intrinsic-value data exists for the stock. */
export function selectLatestValuations(
  intrinsicValues: readonly IntrinsicValueResponse[],
  intrinsicValueBlends: readonly IntrinsicValueBlendResponse[],
): ValuationSnapshot | undefined {
  const latestBlends = latestByKey(intrinsicValueBlends, (point) => point.blendId);
  const latestModels = latestByKey(intrinsicValues, (point) => point.model);
  const blends = BLEND_ENTRIES.flatMap((entry) => {
    const point = latestBlends.get(entry.blendId);
    return point
      ? [
          {
            blendId: entry.blendId,
            label: entry.label,
            valuePerShare: point.valuePerShare,
            currency: point.currency,
            valuationDate: point.valuationDate,
          },
        ]
      : [];
  });
  const models = MODEL_ENTRIES.flatMap((entry) => {
    const point = latestModels.get(entry.model);
    return point
      ? [
          {
            model: entry.model,
            label: entry.label,
            valuePerShare: point.valuePerShare,
            currency: point.currency,
            valuationDate: point.valuationDate,
          },
        ]
      : [];
  });
  if (blends.length === 0 && models.length === 0) {
    return undefined;
  }
  const asOfDate = [...blends, ...models]
    .map((entry) => entry.valuationDate)
    .sort()
    .at(-1) as string;
  return { blends, models, asOfDate };
}

/**
 * Where the market price sits relative to an intrinsic value, as a fraction of that value
 * (`-0.059` means the price is 5.9% below the value). This is the one sign convention Stock Details
 * uses for every comparison — "Price vs value", "Price vs average" — so a negative number always
 * means the price is below its reference (UI-018). Undefined when the value cannot anchor it.
 */
export function priceVersusValue(
  price: number,
  valuePerShare: number,
): number | undefined {
  if (!Number.isFinite(valuePerShare) || valuePerShare <= 0) {
    return undefined;
  }
  return (price - valuePerShare) / valuePerShare;
}
