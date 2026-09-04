/**
 * The one authorization gate for test suites that call the live FMP provider.
 *
 * Exactly one thing authorizes a live call: `RUN_LIVE_FMP_TESTS=1`, set deliberately for that run.
 * The presence of an API key is **not** authorization — that mistake is what let a live suite fire
 * real requests whenever a developer's `.env` happened to carry a key and the suite was reached by
 * a direct `vitest` invocation that bypassed a package script's `--exclude`. Script-level exclusion
 * hides a suite; only this gate makes the call impossible.
 *
 * Consequences every live suite depends on:
 * - a real `FMP_API_KEY` without the opt-in never reaches the network;
 * - a placeholder key never authorizes anything, opt-in or not;
 * - with the opt-in on, missing or placeholder credentials fail loudly instead of sending a
 *   request that cannot succeed.
 *
 * `live-fmp-gate.test.ts` in `@intrinsic/stock-data` proves these permutations without touching
 * the network.
 */

/** Environment variable that is the sole opt-in for live FMP suites. */
export const LIVE_FMP_OPT_IN_ENV = "RUN_LIVE_FMP_TESTS";

/** The only value of `RUN_LIVE_FMP_TESTS` that authorizes live calls. */
export const LIVE_FMP_OPT_IN_VALUE = "1";

/**
 * Values that look like a key but are not one.
 *
 * `.env.example` ships `FMP_API_KEY=` empty, and developers commonly fill placeholders in by hand.
 * None of them may be mistaken for a usable credential.
 */
const PLACEHOLDER_KEYS = new Set([
  "changeme",
  "demo",
  "dummy",
  "example",
  "fake",
  "fmp_api_key",
  "none",
  "placeholder",
  "replace-me",
  "test",
  "todo",
  "unset",
  "your-api-key",
  "your_api_key",
  "xxx",
]);

/** True when `value` is absent, blank, bracketed (`<key>`) or a known placeholder. */
export function isPlaceholderFmpKey(value: string | undefined): boolean {
  const key = value?.trim() ?? "";
  if (key === "") {
    return true;
  }
  if (key.startsWith("<") || key.startsWith("${")) {
    return true;
  }
  return PLACEHOLDER_KEYS.has(key.toLowerCase());
}

/**
 * Whether live FMP suites are authorized for this run.
 *
 * Deliberately exact: only the literal `"1"` opts in, so `true`, `yes`, `0` and an empty value all
 * leave the suites skipped rather than silently enabling them.
 */
export function liveFmpTestsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[LIVE_FMP_OPT_IN_ENV] === LIVE_FMP_OPT_IN_VALUE;
}

/**
 * Credential check for a suite that has already passed the opt-in gate.
 *
 * Call it inside `beforeAll`, never at module scope: a live suite must skip cleanly when the gate
 * is off, whatever the local environment looks like. It throws rather than skipping, because an
 * explicit `RUN_LIVE_FMP_TESTS=1` that cannot reach the provider is a misconfigured run, not a
 * suite to pass over in silence.
 */
export function assertLiveFmpCredentials(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!liveFmpTestsEnabled(env)) {
    throw new Error(
      `Live FMP credentials must only be required after the ${LIVE_FMP_OPT_IN_ENV} gate passes.`,
    );
  }
  if (isPlaceholderFmpKey(env.FMP_API_KEY)) {
    throw new Error(
      `${LIVE_FMP_OPT_IN_ENV}=${LIVE_FMP_OPT_IN_VALUE} requires a real FMP_API_KEY; a missing or placeholder value is not a credential.`,
    );
  }
}
