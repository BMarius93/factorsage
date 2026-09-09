/**
 * Return, drawdown and alpha mathematics, kept in one place so the engine, the live checkpoints and
 * the final summary cannot compute them differently.
 */

/** Percentage growth of a growth index based at 1.0. */
export function indexToPercent(index: number): number {
  return (index - 1) * 100;
}

/**
 * Chains one day of a time-weighted return index.
 *
 * `RETURN_METHODOLOGY_VERSION` = `time-weighted-index@1`. A contribution arrives before the day's
 * trading, so the day's return is measured against the capital actually at work:
 * `value(d) / (value(d-1) + contribution(d))`. This is what makes the portfolio curve comparable to
 * a benchmark's percentage growth even when the user contributes monthly — without it, every
 * deposit would read as performance.
 */
export function chainReturnIndex(
  previousIndex: number,
  previousValue: number,
  contribution: number,
  currentValue: number,
): number {
  const invested = previousValue + contribution;
  if (!(invested > 0) || !Number.isFinite(currentValue)) {
    return previousIndex;
  }
  return previousIndex * (currentValue / invested);
}

/** Running maximum drawdown of a growth index, as a positive percentage. */
export class DrawdownTracker {
  private peak = Number.NEGATIVE_INFINITY;
  private worst = 0;

  observe(index: number): void {
    if (!Number.isFinite(index) || index <= 0) {
      return;
    }
    if (index > this.peak) {
      this.peak = index;
      return;
    }
    const drawdown = (1 - index / this.peak) * 100;
    if (drawdown > this.worst) {
      this.worst = drawdown;
    }
  }

  get maxDrawdownPercent(): number {
    return this.worst;
  }
}

/**
 * Alpha as the product presents it: the portfolio's percentage growth minus the benchmark's, over
 * the same period and from the same starting point. It is a comparison, not a regression estimate.
 */
export function alphaPercent(
  portfolioReturnPercent: number,
  benchmarkReturnPercent: number | null,
): number | null {
  return benchmarkReturnPercent === null
    ? null
    : portfolioReturnPercent - benchmarkReturnPercent;
}

const DAYS_PER_YEAR = 365.25;

/** Compound annual growth rate of the time-weighted index over the simulated calendar span. */
export function cagrPercent(
  finalIndex: number,
  firstDate: string,
  lastDate: string,
): number | null {
  const start = Date.parse(`${firstDate}T00:00:00.000Z`);
  const end = Date.parse(`${lastDate}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }
  if (!(finalIndex > 0)) {
    return null;
  }
  const years = (end - start) / (24 * 60 * 60 * 1000) / DAYS_PER_YEAR;
  if (years <= 0) {
    return null;
  }
  return (Math.pow(finalIndex, 1 / years) - 1) * 100;
}

/**
 * Uniformly strides a series down to at most `maxPoints`, always keeping the first and last entry.
 *
 * Live checkpoints persist a curve on every checkpoint, so an un-strided curve would make the write
 * cost grow with the length of the run. The final result keeps every point in its own table.
 */
export function downsample<T>(points: readonly T[], maxPoints: number): T[] {
  if (points.length <= maxPoints || maxPoints < 2) {
    return [...points];
  }
  const stride = (points.length - 1) / (maxPoints - 1);
  const result: T[] = [];
  for (let step = 0; step < maxPoints - 1; step += 1) {
    const point = points[Math.round(step * stride)];
    if (point !== undefined) {
      result.push(point);
    }
  }
  const last = points[points.length - 1];
  if (last !== undefined) {
    result.push(last);
  }
  return result;
}
