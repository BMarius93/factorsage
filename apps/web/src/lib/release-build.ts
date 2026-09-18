/**
 * Build-time guarantees for a **release** build of the web app.
 *
 * `NEXT_PUBLIC_API_BASE_URL` is inlined into the browser bundle by `next build`, so whatever value
 * is present at build time is the API every visitor's browser calls, and nothing at runtime can
 * change it. `lib/api/client.ts` falls back to `http://localhost:3001` for local development; a
 * shipped bundle carrying that fallback sends each visitor's API calls to their own machine.
 *
 * `next build` always runs with `NODE_ENV=production` — including the repository's own validation
 * gate and CI — so production mode cannot tell a release apart from a check build. A release is
 * therefore declared explicitly with `FACTORSAGE_RELEASE_BUILD=true` (set by
 * `docker/web.Dockerfile`), and only then is the API URL required. Everything else keeps building
 * exactly as before.
 *
 * Imported by `next.config.ts`, so it may depend on nothing but the standard library: the web app
 * may not import `@intrinsic/config` (AGENTS.md dependency rules).
 */

export const RELEASE_BUILD_FLAG = "FACTORSAGE_RELEASE_BUILD";
export const PUBLIC_API_BASE_URL_VARIABLE = "NEXT_PUBLIC_API_BASE_URL";

/** `next/constants` `PHASE_PRODUCTION_BUILD`, restated so this module stays framework-free. */
export const PRODUCTION_BUILD_PHASE = "phase-production-build";

type BuildEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Whether this is a declared release build. Only `true` and `false` (or absent) are accepted, so a
 * typo such as `FACTORSAGE_RELEASE_BUILD=yes` fails the build rather than silently disabling the
 * guard it was meant to enable.
 */
export function isReleaseBuild(env: BuildEnvironment): boolean {
  const raw = env[RELEASE_BUILD_FLAG]?.trim().toLowerCase();
  if (raw === undefined || raw === "" || raw === "false") {
    return false;
  }
  if (raw === "true") {
    return true;
  }
  throw new Error(
    `Invalid web build configuration: ${RELEASE_BUILD_FLAG} must be true or false`,
  );
}

/**
 * Throws when a release build would compile a browser bundle that cannot reach a public API.
 *
 * Checked only in the `next build` phase: `next start` of an already-built bundle cannot change
 * the inlined value, and `next dev` is local by definition. Messages name the variable and never
 * echo its value.
 */
export function assertReleaseBuildConfig(
  env: BuildEnvironment,
  phase: string,
): void {
  if (phase !== PRODUCTION_BUILD_PHASE || !isReleaseBuild(env)) {
    return;
  }

  const name = PUBLIC_API_BASE_URL_VARIABLE;
  const raw = env[name]?.trim();
  if (!raw) {
    throw new Error(
      `Invalid web release build: ${name} is required. It is compiled into the browser bundle, ` +
        "so pass the public API URL at build time (docker build --build-arg " +
        `${name}=https://api.example.com).`,
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `Invalid web release build: ${name} must be an absolute URL`,
    );
  }

  if (url.protocol !== "https:") {
    throw new Error(`Invalid web release build: ${name} must be an https URL`);
  }
  if (url.username || url.password) {
    throw new Error(
      `Invalid web release build: ${name} must not contain credentials`,
    );
  }
  if (isLoopbackHost(url.hostname)) {
    throw new Error(
      `Invalid web release build: ${name} must not point at localhost or a loopback address`,
    );
  }
}

/**
 * `localhost` and its subdomains, 127/8, `::1`, an IPv4-mapped loopback, or the unspecified
 * address. Relies on the WHATWG parser having normalized `127.1`, `0x7f.0.0.1` and long IPv6 forms.
 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    /^127\.\d+\.\d+\.\d+$/.test(host) ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "::" ||
    /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host)
  );
}
