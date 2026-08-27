import {
  INTRINSIC_VALUE_BLENDS,
  type IntrinsicValueBlendDefinition,
  type IntrinsicValueBlendPoint,
  type IntrinsicValuePoint,
  type IntrinsicValueQuery,
} from "@intrinsic/domain";
import { endOfLocalDate } from "./dates.js";

export function selectIntrinsicValues(
  points: readonly IntrinsicValuePoint[],
  query: IntrinsicValueQuery,
): IntrinsicValuePoint[] {
  const asOfInstant = query.asOf ? endOfLocalDate(query.asOf) : undefined;
  const eligible = points
    .filter((point) => !query.from || point.valuationDate >= query.from)
    .filter((point) => !query.to || point.valuationDate <= query.to)
    .filter((point) => !query.asOf || point.valuationDate <= query.asOf)
    .filter((point) => !asOfInstant || point.sourceDataAsOf <= asOfInstant)
    .filter((point) => !query.models || query.models.includes(point.model))
    .sort(
      (left, right) =>
        left.valuationDate.localeCompare(right.valuationDate) ||
        left.model.localeCompare(right.model) ||
        left.sourceDataAsOf.localeCompare(right.sourceDataAsOf),
    );
  const current = new Map<string, IntrinsicValuePoint>();
  for (const point of eligible) {
    const key = `${point.valuationDate}:${point.model}`;
    const selected = current.get(key);
    if (
      !selected ||
      point.calculationVersion > selected.calculationVersion ||
      (point.calculationVersion === selected.calculationVersion &&
        point.sourceDataAsOf > selected.sourceDataAsOf)
    ) {
      current.set(key, point);
    }
  }
  return [...current.values()].sort(
    (left, right) =>
      left.valuationDate.localeCompare(right.valuationDate) ||
      left.model.localeCompare(right.model),
  );
}

export function validateBlendDefinition(
  definition: IntrinsicValueBlendDefinition,
): void {
  const total = definition.components.reduce(
    (sum, component) => sum + component.weight,
    0,
  );
  if (Math.abs(total - 1) > 1e-10) {
    throw new Error(
      `Blend ${definition.id} v${definition.version} weights must sum to 1`,
    );
  }
  if (definition.components.some((component) => component.weight <= 0)) {
    throw new Error("Blend weights must be positive");
  }
}

export type BlendCalculationResult =
  | { status: "AVAILABLE"; point: IntrinsicValueBlendPoint }
  | { status: "UNAVAILABLE"; missingModels: string[] };

export function calculateBlend(
  definition: IntrinsicValueBlendDefinition,
  points: readonly IntrinsicValuePoint[],
  valuationDate: string,
  calculationVersion?: number,
): BlendCalculationResult {
  validateBlendDefinition(definition);
  const eligible = points.filter(
    (point) =>
      point.valuationDate <= valuationDate &&
      point.sourceDataAsOf <= endOfLocalDate(valuationDate),
  );
  const versions =
    calculationVersion === undefined
      ? [...new Set(eligible.map((point) => point.calculationVersion))].sort(
          (left, right) => right - left,
        )
      : [calculationVersion];
  const selectedVersion = versions.find((version) =>
    definition.components.every((component) =>
      eligible.some(
        (point) =>
          point.calculationVersion === version &&
          point.model === component.model,
      ),
    ),
  );
  const candidateVersion = selectedVersion ?? versions[0];
  const selected = definition.components.map((component) => ({
    component,
    point: eligible
      .filter(
        (point) =>
          point.calculationVersion === candidateVersion &&
          point.model === component.model,
      )
      .sort(
        (left, right) =>
          right.valuationDate.localeCompare(left.valuationDate) ||
          right.sourceDataAsOf.localeCompare(left.sourceDataAsOf),
      )[0],
  }));
  const missingModels = selected
    .filter((selection) => !selection.point)
    .map((selection) => selection.component.model);
  if (missingModels.length > 0) {
    return { status: "UNAVAILABLE", missingModels };
  }

  const currencies = new Set(
    selected.map((selection) => selection.point?.currency),
  );
  if (currencies.size !== 1) {
    throw new Error("Blend components must use the same currency");
  }
  const sourceDataAsOf = selected
    .map((selection) => selection.point?.sourceDataAsOf ?? "")
    .sort()
    .at(-1);
  const firstPoint = selected[0]?.point;
  if (!sourceDataAsOf || !firstPoint) {
    throw new Error("Blend component selection failed");
  }

  return {
    status: "AVAILABLE",
    point: {
      securityId: firstPoint.securityId,
      valuationDate,
      sourceDataAsOf,
      blendId: definition.id,
      valuePerShare: selected.reduce(
        (sum, selection) =>
          sum +
          (selection.point?.valuePerShare ?? 0) * selection.component.weight,
        0,
      ),
      currency: firstPoint.currency,
      calculationVersion: selectedVersion ?? firstPoint.calculationVersion,
      blendVersion: definition.version,
    },
  };
}

for (const definition of Object.values(INTRINSIC_VALUE_BLENDS)) {
  validateBlendDefinition(definition);
}
