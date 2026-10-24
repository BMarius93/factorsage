/**
 * Queueing arithmetic for the capacity model (`docs/production/capacity-model.md`): the
 * deployment's four execution slots as an M/G/c queue.
 *
 * - Arrivals are Poisson (independent people submitting), at `lambda` runs per hour.
 * - Service times are the measured execution times of the workload mix, mean `meanServiceHours`
 *   and coefficient of variation `serviceCv`.
 * - `servers` is the global cap (4).
 *
 * The waiting time uses the Erlang C formula for M/M/c and the Allen–Cunneen correction for a
 * general service distribution (`Wq(M/G/c) ≈ Wq(M/M/c) · (1 + cv²) / 2`), a standard approximation
 * that is accurate to a few per cent at the utilizations a product should run at and degrades only
 * as utilization approaches 1, where every model says the same thing: the queue grows without
 * bound. Percentiles use the M/M/c waiting-time tail `P(W > t) = C · e^{-(cμ - λ)t}`, scaled the
 * same way — an estimate, labelled as one.
 */

export type QueueInput = {
  /** Runs arriving per hour. */
  readonly lambda: number;
  /** Mean execution time of one run, in hours. */
  readonly meanServiceHours: number;
  /** Standard deviation / mean of the execution time. */
  readonly serviceCv: number;
  /** Execution slots (the global cap). */
  readonly servers: number;
};

export type QueueEstimate = {
  readonly utilization: number;
  /** Probability that a run waits at all (Erlang C). */
  readonly probabilityOfWaiting: number;
  /** Mean wait before execution starts, hours; `Infinity` at or beyond saturation. */
  readonly meanWaitHours: number;
  /** 95th-percentile wait, hours (0 when fewer than 5 % of runs wait at all). */
  readonly p95WaitHours: number;
  /** Runs completed per hour: the arrivals while stable, the slots' capacity beyond. */
  readonly throughputPerHour: number;
  /** Mean number of runs waiting (Little's law). */
  readonly meanQueued: number;
  readonly saturated: boolean;
};

/** Erlang C: the probability an arrival waits, for `servers` slots offered `load` Erlangs. */
export function erlangC(servers: number, load: number): number {
  if (!Number.isInteger(servers) || servers < 1) {
    throw new Error("servers must be a positive integer");
  }
  if (load < 0) {
    throw new Error("load must be non-negative");
  }
  if (load >= servers) {
    return 1;
  }
  // Σ_{k<c} a^k / k!, and a^c / c!, accumulated without factorials.
  let term = 1;
  let sum = 1;
  for (let k = 1; k < servers; k += 1) {
    term *= load / k;
    sum += term;
  }
  const last = (term * load) / servers;
  const tail = last * (servers / (servers - load));
  return tail / (sum + tail);
}

export function estimateQueue(input: QueueInput): QueueEstimate {
  const { lambda, meanServiceHours, serviceCv, servers } = input;
  if (!(meanServiceHours > 0)) {
    throw new Error("meanServiceHours must be positive");
  }
  const mu = 1 / meanServiceHours;
  const load = lambda / mu;
  const utilization = load / servers;
  if (utilization >= 1) {
    return {
      utilization,
      probabilityOfWaiting: 1,
      meanWaitHours: Number.POSITIVE_INFINITY,
      p95WaitHours: Number.POSITIVE_INFINITY,
      throughputPerHour: servers * mu,
      meanQueued: Number.POSITIVE_INFINITY,
      saturated: true,
    };
  }
  const waiting = erlangC(servers, load);
  const correction = (1 + serviceCv * serviceCv) / 2;
  const drain = servers * mu - lambda;
  const meanWaitHours = (waiting / drain) * correction;
  const p95WaitHours =
    waiting <= 0.05 ? 0 : (Math.log(waiting / 0.05) / drain) * correction;
  return {
    utilization,
    probabilityOfWaiting: waiting,
    meanWaitHours,
    p95WaitHours,
    throughputPerHour: lambda,
    meanQueued: lambda * meanWaitHours,
    saturated: false,
  };
}

/** The arrival rate at which utilization reaches `target` (e.g. 0.7). */
export function arrivalsAtUtilization(
  target: number,
  meanServiceHours: number,
  servers: number,
): number {
  return (target * servers) / meanServiceHours;
}

/** Mean and coefficient of variation of a mixture of run kinds, each with its own mean and spread. */
export function mixtureMoments(
  kinds: readonly { share: number; meanHours: number; cv: number }[],
): { meanHours: number; cv: number } {
  const total = kinds.reduce((sum, kind) => sum + kind.share, 0);
  if (!(total > 0)) {
    throw new Error("the mix has no runs");
  }
  let mean = 0;
  let secondMoment = 0;
  for (const kind of kinds) {
    const weight = kind.share / total;
    const variance = (kind.cv * kind.meanHours) ** 2;
    mean += weight * kind.meanHours;
    secondMoment += weight * (variance + kind.meanHours ** 2);
  }
  const variance = Math.max(0, secondMoment - mean * mean);
  return { meanHours: mean, cv: mean > 0 ? Math.sqrt(variance) / mean : 0 };
}
