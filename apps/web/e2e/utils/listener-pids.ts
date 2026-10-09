import { spawnSync } from "node:child_process";

/**
 * Which processes own the listening TCP socket on a port, for the global setup's check that the
 * API and web listeners are the hermetic stack's.
 *
 * `lsof` answers on macOS and on most Linux hosts. lsof 4.95 on Linux (the Claude cloud image's)
 * silently drops a process whose `/proc/<pid>/stat` command field has an unbalanced `(`: it counts
 * parentheses to find where that field ends, and the kernel truncates a process name to 15 bytes,
 * so Next.js's `next-server (v16.1.6)` is stored as `next-server (v1` and the web server is never
 * reported. When lsof is not installed or names no process, `fuser` (psmisc) is asked instead.
 *
 * A tool that exits non-zero has not answered. Output that is not a list of process ids is an
 * error rather than something to skip: a misread list could hide the very process the caller must
 * refuse to run against.
 */

export type ListenerTool = "lsof" | "fuser";

/** One run of a tool: `undefined` when it could not be started (not installed or not runnable). */
export type ToolRun =
  { readonly status: number | null; readonly stdout: string } | undefined;

export type RunTool = (tool: ListenerTool, args: readonly string[]) => ToolRun;

export type Listeners = {
  /** The tool that named the processes; `undefined` when neither named any. */
  readonly tool: ListenerTool | undefined;
  /** Distinct, validated process ids in ascending order. */
  readonly pids: readonly number[];
};

/** `pid_t` is a signed 32-bit integer on every platform the harness runs on. */
const MAX_PID = 2 ** 31 - 1;

export function listenerPids(port: string, run: RunTool = runTool): Listeners {
  const lsof = answer(
    "lsof",
    run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]),
  );
  if (lsof.length > 0) {
    return { tool: "lsof", pids: lsof };
  }
  // `fuser -n tcp` matches every socket bound to the local port, not only the listening one, so it
  // can name more processes than lsof would. The caller requires every one of them to be guarded,
  // which makes the wider answer stricter, never looser.
  const fuser = answer("fuser", run("fuser", ["-n", "tcp", port]));
  return { tool: fuser.length > 0 ? "fuser" : undefined, pids: fuser };
}

function answer(tool: ListenerTool, run: ToolRun): number[] {
  // Both tools exit 1 when nothing matches; any other failure is no more trustworthy.
  if (run === undefined || run.status !== 0) {
    return [];
  }
  const pids = new Set<number>();
  // lsof -t prints one pid per line; fuser prints space-separated pids on stdout (its `3000/tcp:`
  // label goes to stderr).
  for (const token of run.stdout.split(/\s+/)) {
    if (token === "") {
      continue;
    }
    const pid = /^[1-9][0-9]*$/.test(token) ? Number(token) : Number.NaN;
    if (!(pid <= MAX_PID)) {
      throw new Error(
        `${tool} printed ${JSON.stringify(token)} where only process ids were expected, so the ` +
          "E2E listener check cannot trust its answer",
      );
    }
    pids.add(pid);
  }
  return [...pids].sort((left, right) => left - right);
}

function runTool(tool: ListenerTool, args: readonly string[]): ToolRun {
  const result = spawnSync(tool, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.error === undefined
    ? { status: result.status, stdout: result.stdout }
    : undefined;
}
