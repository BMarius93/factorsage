import { cpus, totalmem } from "node:os";

/**
 * How many backtests the matrix may execute at once.
 *
 * Concurrency here means exactly one thing: `BACKTEST_WORKER_PROCESSES`, the number of independent
 * worker children. One backtest is never internally parallelized — the day loop is sequential in
 * time and stays single-process so it is deterministic — so this buys throughput across runs and
 * nothing on any single run.
 *
 * The binding constraint is memory, not cores. A child holds one calendar year of evaluation frames
 * for up to thirty securities, the whole run's trade sequence and equity curve until it persists
 * them, and its own Prisma client and Node runtime. Two or three hundred megabytes each is normal
 * and a thirty-year, thirty-security run is the expensive end of that. PostgreSQL, Redis and the
 * runner process itself are on the same machine.
 *
 * So the default is deliberately conservative: half the cores, capped at four, and further capped
 * by roughly one child per two gigabytes of RAM. The product default is 2 for a reason, and a
 * matrix that swaps is slower than one that does not.
 */
export const MATRIX_MAX_DEFAULT_CONCURRENCY = 4;

export function defaultMatrixConcurrency(
  cpuCount = cpus().length,
  totalMemoryBytes = totalmem(),
): number {
  const byCpu = Math.max(1, Math.floor(cpuCount / 2));
  const byMemory = Math.max(
    1,
    Math.floor(totalMemoryBytes / (2 * 1024 ** 3)) - 1,
  );
  return Math.max(1, Math.min(MATRIX_MAX_DEFAULT_CONCURRENCY, byCpu, byMemory));
}

export class MatrixConcurrencyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatrixConcurrencyConfigError";
  }
}

/** `--concurrency N`, then `QA_MATRIX_CONCURRENCY`, then the machine-derived default. */
export function resolveMatrixConcurrency(
  flag: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = flag ?? env.QA_MATRIX_CONCURRENCY?.trim();
  if (!raw) {
    return defaultMatrixConcurrency();
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 32) {
    throw new MatrixConcurrencyConfigError(
      `Concurrency must be an integer between 1 and 32; received \`${raw}\`. It becomes ` +
        "BACKTEST_WORKER_PROCESSES, and each process executes one backtest at a time.",
    );
  }
  return value;
}
