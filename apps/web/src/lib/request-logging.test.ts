import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  PHASE_DEVELOPMENT_SERVER,
  PHASE_PRODUCTION_BUILD,
  PHASE_PRODUCTION_SERVER,
} from "next/constants";
import { logRequests } from "next/dist/server/dev/log-requests";
import { describe, expect, it, vi } from "vitest";
import nextConfig from "../../next.config";
import {
  TOKEN_BEARING_ROUTE_PATHS,
  incomingRequestLogIgnorePatterns,
  webRequestLoggingConfig,
} from "./request-logging";

/** A stand-in. Nothing in this file is, or has the shape of, a real token. */
const TOKEN = "synthetic-token-for-tests";

/** The shapes an emailed link's request reaches the development server in. */
const TOKEN_BEARING_REQUESTS = [
  `/verify-email?token=${TOKEN}`,
  `/reset-password?token=${TOKEN}`,
  // The App Router's own fetch of the same page during a client-side navigation.
  `/verify-email?token=${TOKEN}&_rsc=1a2b3`,
  `/reset-password?token=${TOKEN}&_rsc=1a2b3`,
  // A mail client or link scanner may add parameters of its own, before or after.
  `/verify-email?utm_source=mail&token=${TOKEN}`,
  `/reset-password?token=${TOKEN}&utm_source=mail`,
  `/verify-email/?token=${TOKEN}`,
  // Answered 404, and still a token in a log line.
  `/Reset-Password?token=${TOKEN}`,
];

const ORDINARY_REQUESTS = [
  "/",
  "/login",
  "/login?next=%2Fbacktests%2Fnew%3FstrategyId%3Dabc",
  "/login?error=oauth_link_not_allowed",
  "/register",
  "/forgot-password",
  "/billing?checkout=success",
  "/lists?view=groups",
  "/strategies/new",
  "/stocks/AAPL",
  "/api/logo/AAPL",
];

/** Routes that only resemble a token-bearing one. None of them is one, so each stays logged. */
const LOOKALIKE_REQUESTS = [
  "/verify-emails",
  "/verify-email-sent?step=2",
  "/reset-password-help",
  "/reset-passwords?step=2",
  "/verify-email/help",
  "/reset-password/help?step=2",
  "/account/verify-email",
  "/api/reset-password",
  "/stocks/verify-email",
  "/login?next=%2Fverify-email",
  "/login?next=/reset-password",
  "/forgot-password?next=%2Freset-password",
];

type DevRequest = Parameters<typeof logRequests>[0];
type DevResponse = Parameters<typeof logRequests>[1];

/** Loaded once and reused: the development server holds one configuration for its lifetime. */
const devServerLogging = nextConfig(PHASE_DEVELOPMENT_SERVER).logging;

/**
 * What `next dev` writes for one served request under this application's own configuration.
 *
 * `logRequests` is Next.js's request logger itself — what the development server calls when a
 * response closes — not a copy of its matching rule. An upgrade that changes how `ignore` is
 * applied therefore fails here, instead of quietly putting the tokens back in the log.
 */
function devServerLogFor(url: string, method = "GET"): string {
  const logging = devServerLogging;
  if (!logging) {
    throw new Error("next.config sets no request-logging configuration");
  }
  let written = "";
  const write = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk) => {
      written += String(chunk);
      return true;
    });
  try {
    logRequests(
      { url, method } as unknown as DevRequest,
      { statusCode: 200 } as unknown as DevResponse,
      logging,
      0n,
      1_000_000n,
      undefined,
      undefined,
      undefined,
      undefined,
    );
  } finally {
    write.mockRestore();
  }
  return written;
}

/** Every route under `src/app` with a file that reads a `token` query parameter. */
function routesReadingATokenParameter(): string[] {
  // Resolved from the package root: Vitest runs with `apps/web` as its working directory.
  const appDirectory = resolve(process.cwd(), "src/app");
  const routes = new Set<string>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (
        /\.tsx?$/.test(entry.name) &&
        !/\.test\.tsx?$/.test(entry.name) &&
        /searchParams\s*\.get\(\s*["']token["']\s*\)/.test(
          readFileSync(path, "utf8"),
        )
      ) {
        const segments = relative(appDirectory, directory)
          .split(sep)
          // A route group — `(app)` — organises files and is not part of the URL.
          .filter((segment) => segment !== "" && !/^\(.*\)$/.test(segment));
        routes.add(`/${segments.join("/")}`);
      }
    }
  };
  visit(appDirectory);
  return [...routes].sort();
}

describe("web request logging: one-time auth tokens stay out of the dev server log", () => {
  it("excludes the two pages an emailed link opens, and only those", () => {
    expect(TOKEN_BEARING_ROUTE_PATHS).toEqual([
      "/verify-email",
      "/reset-password",
    ]);
  });

  it("names routes the application really serves", () => {
    for (const path of TOKEN_BEARING_ROUTE_PATHS) {
      expect(
        existsSync(resolve(process.cwd(), "src/app", `.${path}`, "page.tsx")),
        `no page at ${path}`,
      ).toBe(true);
    }
  });

  it("covers every route that reads a token from its query string", () => {
    // The audit behind the list, re-run on every change: a new page that takes a `token`
    // parameter fails here until it is excluded as well.
    expect(routesReadingATokenParameter()).toEqual(
      [...TOKEN_BEARING_ROUTE_PATHS].sort(),
    );
  });

  it("still logs an ordinary request", () => {
    for (const url of ORDINARY_REQUESTS) {
      expect(devServerLogFor(url), url).toContain(`GET ${url} `);
    }
  });

  it("writes nothing for a request that carries a token", () => {
    for (const url of TOKEN_BEARING_REQUESTS) {
      for (const method of ["GET", "HEAD"]) {
        expect(devServerLogFor(url, method), `${method} ${url}`).toBe("");
      }
    }
  });

  it("excludes those routes whole, with or without a query string", () => {
    for (const path of TOKEN_BEARING_ROUTE_PATHS) {
      expect(devServerLogFor(path), path).toBe("");
      expect(devServerLogFor(`${path}/`), `${path}/`).toBe("");
    }
  });

  it("does not suppress a route that only resembles one", () => {
    for (const url of LOOKALIKE_REQUESTS) {
      expect(devServerLogFor(url), url).toContain(`GET ${url} `);
    }
  });

  it("answers the same for the same URL every time", () => {
    // Next.js reuses the pattern objects for every request; a `g` or `y` flag would make `test()`
    // stateful and let every second token-bearing request through.
    for (const pattern of incomingRequestLogIgnorePatterns()) {
      expect(pattern.global).toBe(false);
      expect(pattern.sticky).toBe(false);
    }
    const logging = webRequestLoggingConfig();
    for (const url of TOKEN_BEARING_REQUESTS) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(
          logging.incomingRequests.ignore.some((pattern) => pattern.test(url)),
          `${url} (attempt ${attempt + 1})`,
        ).toBe(true);
      }
    }
  });

  it("is what next.config hands to Next.js in every phase, with the rest of its logging left alone", () => {
    for (const phase of [
      PHASE_DEVELOPMENT_SERVER,
      PHASE_PRODUCTION_BUILD,
      PHASE_PRODUCTION_SERVER,
    ]) {
      expect(nextConfig(phase).logging, phase).toEqual(
        webRequestLoggingConfig(),
      );
    }
    expect(Object.keys(webRequestLoggingConfig())).toEqual([
      "incomingRequests",
    ]);
  });
});
