/**
 * The environment `next dev` runs with — **constructed, never inherited**.
 *
 * `next dev` keeps a persistent Turbopack cache under `.next/dev/cache`, and that cache records the
 * environment the server was started with: every variable, read or not. Whatever the process is
 * handed therefore ends up on disk, in a build directory nobody thinks of as holding secrets. Until
 * this module existed the dev server inherited its whole parent environment, so a shell that had
 * the QA persona passwords exported — which is every shell of a Claude cloud session, where each
 * environment variable is ambient — wrote them into `apps/web/.next/dev/cache/turbopack`.
 *
 * The web server needs none of that. It talks to the API over HTTP as the browser does, holds no
 * database or provider connection, and never authenticates anybody itself: a password only ever
 * passes through it inside a request body a browser submitted. So the rule here is the simple one:
 *
 * ```text
 * next dev receives   what it takes to run a Node process in a terminal
 *                   + the web app's public configuration (NEXT_PUBLIC_*)
 *                   + a few named switches
 * and nothing else.
 * ```
 *
 * It is an **allowlist**, on purpose. A list of secrets to remove would be wrong the day a new one
 * was added to `.env`; a list of what may pass is wrong only in the safe direction — a variable
 * somebody needs is missing until they add it below, where the addition is reviewed.
 *
 * `next-dev.ts` is the only thing that starts `next dev` (`pnpm dev:web`, the hermetic E2E stack
 * and `scripts/cloud/stack.sh` all arrive there), so this holds however the server was launched.
 * Pure: no I/O and no `process.env`, so the rule is testable as a function.
 */

type Environment = Readonly<Record<string, string | undefined>>;

/** Variables `next dev` may take from the environment it was started from, by exact name. */
export const NEXT_DEV_INHERITED_VARIABLES: readonly string[] = [
  // What any process needs to find its tools, its home, its locale and its terminal.
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TERM",
  "COLORTERM",
  "TERM_PROGRAM",
  "FORCE_COLOR",
  "NO_COLOR",
  "CI",
  // Node and the package manager. `NODE_OPTIONS` is how the E2E stack preloads its egress guard.
  "NODE_ENV",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "COREPACK_HOME",
  "PNPM_HOME",
  "npm_config_user_agent",
  "npm_config_update_notifier",
  // Next.js's own documented switches.
  "PORT",
  "HOSTNAME",
  "NEXT_TELEMETRY_DISABLED",
  "WATCHPACK_POLLING",
  // Opening a stack frame from the error overlay in the developer's editor.
  "REACT_EDITOR",
  "EDITOR",
  "VISUAL",
  // This repository: the release switch `next.config.ts` reads, and the hermetic E2E stack's
  // process identity, which the preloaded egress guard reads (`@intrinsic/testing/e2e-stack`).
  "FACTORSAGE_RELEASE_BUILD",
  "E2E_STACK_ROLE",
  "E2E_STACK_MODE",
  "E2E_EGRESS_LOG",
];

/**
 * …and by prefix.
 *
 * `NEXT_PUBLIC_` is the web app's configuration. It is public by definition — Next compiles those
 * values into the browser bundle — which is exactly why no credential may ever be given that
 * prefix, and why {@link CREDENTIAL_NAME} is applied to these as well.
 */
export const NEXT_DEV_INHERITED_PREFIXES: readonly string[] = [
  "NEXT_PUBLIC_",
  "LC_",
];

/**
 * A name that says the value is a credential.
 *
 * Applied **after** the allowlist, to what the allowlist let through. It is not how secrets are
 * kept out — the allowlist does that — it is what stops one being let in by its prefix: a
 * `NEXT_PUBLIC_QA_PASSWORD` would otherwise pass, and would be published to every browser.
 */
const CREDENTIAL_NAME = /PASSWORD|PASSWD|SECRET|TOKEN|PRIVATE_KEY|API_KEY/i;

function isInherited(name: string): boolean {
  return (
    !CREDENTIAL_NAME.test(name) &&
    (NEXT_DEV_INHERITED_VARIABLES.includes(name) ||
      NEXT_DEV_INHERITED_PREFIXES.some((prefix) => name.startsWith(prefix)))
  );
}

/** The environment `next dev` is started with, built from the one this process was given. */
export function nextDevEnvironment(
  parent: Environment,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value !== undefined && isInherited(name)) {
      environment[name] = value;
    }
  }
  return environment;
}

/**
 * The names of the variables `next dev` is **not** given. Names only — for a start-up line that
 * tells a developer their variable was withheld, without that line ever carrying a value.
 */
export function withheldFromNextDev(parent: Environment): string[] {
  return Object.keys(parent)
    .filter((name) => parent[name] !== undefined && !isInherited(name))
    .sort();
}
