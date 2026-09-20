import {
  MANUAL_QA_PERSONA_LIST,
  MANUAL_QA_PERSONA_SLUGS,
  manualQaPersonaBySlug,
  type TestPersona,
} from "@intrinsic/testing/personas";

/**
 * What `pnpm qa:personas` was asked to open.
 *
 * Separated from the launcher itself so the parsing can be tested without a browser: the launcher
 * module's job is to open windows, and importing it in a unit test would do exactly that.
 */

const DEFAULT_ROUTE = "/dashboard";
const DEFAULT_BASE_URL = "http://localhost:3000";

export type LauncherOptions = {
  readonly personas: readonly TestPersona[];
  readonly route: string;
  readonly baseUrl: string;
};

export class UsageError extends Error {}

export function usage(): string {
  return [
    "Usage:",
    "  pnpm qa:personas [-- --route=/lists] [--base-url=http://localhost:3000]",
    `  pnpm qa:persona <${MANUAL_QA_PERSONA_SLUGS.join("|")}> [-- --route=/lists]`,
    "",
    "Opens one visible, isolated, persistent browser per QA persona against a running stack.",
    "See docs/development/qa-personas.md.",
  ].join("\n");
}

/**
 * Reads the command line.
 *
 * `--route` and `--base-url` accept both `--flag=value` and `--flag value`, because pnpm's own
 * argument forwarding makes the shorter of the two easy to get wrong by accident and a confusing
 * failure here costs more than a few lines of parsing.
 */
export function parseLauncherArguments(
  argv: readonly string[],
  // Not `NodeJS.ProcessEnv`: the web workspace's Next.js type augmentation makes `NODE_ENV`
  // required on it, which a test fixture has no reason to supply.
  env: Readonly<Record<string, string | undefined>> = process.env,
): LauncherOptions {
  let route: string | undefined;
  let baseUrl: string | undefined;
  const slugs: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`${argument} needs a value.`);
      }
      index += 1;
      return value;
    };

    if (argument === "--") {
      // pnpm forwards the `--` separator itself, so `pnpm qa:personas -- --route=/lists` arrives
      // with it still in place. Both spellings must work; ignoring it is the whole difference.
      continue;
    } else if (argument === "--help" || argument === "-h") {
      throw new UsageError("");
    } else if (argument.startsWith("--route=")) {
      route = argument.slice("--route=".length);
    } else if (argument === "--route") {
      route = next();
    } else if (argument.startsWith("--base-url=")) {
      baseUrl = argument.slice("--base-url=".length);
    } else if (argument === "--base-url") {
      baseUrl = next();
    } else if (argument.startsWith("-")) {
      throw new UsageError(`Unknown option \`${argument}\`.`);
    } else {
      slugs.push(argument);
    }
  }

  const personas =
    slugs.length === 0
      ? MANUAL_QA_PERSONA_LIST
      : slugs.map((slug) => {
          const persona = manualQaPersonaBySlug(slug);
          if (!persona) {
            throw new UsageError(
              `Unknown persona \`${slug}\`. Choose one of: ${MANUAL_QA_PERSONA_SLUGS.join(", ")}.`,
            );
          }
          return persona;
        });

  const resolvedRoute = route ?? env.QA_ROUTE?.trim() ?? DEFAULT_ROUTE;
  if (!resolvedRoute.startsWith("/")) {
    throw new UsageError(
      `--route must be an absolute path on the app, e.g. /lists; received \`${resolvedRoute}\`.`,
    );
  }

  const resolvedBaseUrl = (
    baseUrl ??
    env.QA_BASE_URL?.trim() ??
    DEFAULT_BASE_URL
  ).replace(/\/+$/, "");

  return { personas, route: resolvedRoute, baseUrl: resolvedBaseUrl };
}
