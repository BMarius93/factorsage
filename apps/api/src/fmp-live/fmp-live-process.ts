import {
  spawn,
  type ChildProcess,
  type StdioOptions,
} from "node:child_process";
import {
  liveFmpChildEnvironment,
  type LiveFmpChildEnvironmentInput,
} from "./fmp-live-environment";

/**
 * Starts the process that performs a live run.
 *
 * The one place a live child is spawned, and it builds the child's environment itself: a caller
 * hands over its own environment and the credential, and what the child receives is
 * `liveFmpChildEnvironment` of those — never the caller's `process.env`, and never that
 * environment with things removed. A function of its own so the boundary can be proven with a real
 * process (`fmp-live-environment.test.ts`).
 */
export function startLiveFmpChild(
  input: LiveFmpChildEnvironmentInput & {
    /** The program to run and its arguments. */
    readonly command: readonly [string, ...string[]];
    readonly cwd: string;
    readonly stdio?: StdioOptions;
  },
): ChildProcess {
  const [executable, ...argumentsList] = input.command;
  return spawn(executable, argumentsList, {
    cwd: input.cwd,
    env: liveFmpChildEnvironment({
      parentEnvironment: input.parentEnvironment,
      key: input.key,
      runId: input.runId,
    }),
    stdio: input.stdio ?? "inherit",
  });
}
