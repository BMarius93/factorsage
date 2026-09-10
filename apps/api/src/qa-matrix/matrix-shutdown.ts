/**
 * What happens when the sweep is interrupted.
 *
 * The pools run in their own process groups, which is what makes stopping one reach every worker
 * child — and which also means a terminal interrupt no longer reaches them. So Ctrl-C has to be
 * handled here, and handled carefully: an interrupted sweep that exits while its pool is still
 * shutting down leaves a detached process group alive, claiming from the matrix queue, invisible
 * to the next run.
 *
 * Three properties, each of which was a way to get that wrong:
 *
 * - the process exits **after** the shutdown completes, never during it;
 * - a second signal while a shutdown is in flight does not start a second one, and does not exit
 *   early either;
 * - a shutdown that *fails* is reported and exits non-zero. Swallowing it and exiting 130 would
 *   claim a clean interrupt over a process group that is still running.
 */
export type MatrixShutdownPorts = {
  /** Stops the live pool. Resolves only once the group is gone and its log stream is drained. */
  stopPool(): Promise<void>;
  /** Releases the database and Redis handles the runner holds. */
  closeResources(): Promise<void>;
  log(message: string): void;
  exit(code: number): void;
};

/** The exit code a POSIX interrupt conventionally produces. */
export const INTERRUPTED_EXIT_CODE = 130;

export function createInterruptHandler(
  ports: MatrixShutdownPorts,
): (signal: string) => Promise<void> {
  let inFlight: Promise<void> | null = null;
  return (signal: string): Promise<void> => {
    if (inFlight) {
      // A second Ctrl-C does not get a second shutdown, and does not get an early exit either.
      ports.log(
        `Already shutting down; ignoring ${signal}. The worker pool is still being stopped.`,
      );
      return inFlight;
    }
    inFlight = (async () => {
      ports.log(`Received ${signal}; stopping the matrix worker pool…`);
      let code = INTERRUPTED_EXIT_CODE;
      try {
        await ports.stopPool();
      } catch (error) {
        code = 1;
        ports.log(
          "The worker pool could not be stopped cleanly: " +
            (error instanceof Error ? error.message : String(error)) +
            "\nA detached worker process group may still be running. Check for " +
            "`worker/dist/index.js` and `worker-process.js` before starting another sweep.",
        );
      }
      try {
        await ports.closeResources();
      } catch {
        // Releasing handles is best-effort; the process is about to end either way.
      }
      ports.exit(code);
    })();
    return inFlight;
  };
}
