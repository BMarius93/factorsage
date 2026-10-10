import type { NextConfig } from "next";
import { assertLegalReleaseReadiness } from "./src/lib/legal-release";
import {
  assertReleaseBuildConfig,
  isReleaseBuild,
} from "./src/lib/release-build";
import { webRequestLoggingConfig } from "./src/lib/request-logging";
import { webRedirectRules } from "./src/lib/route-redirects";
import { webHeaderRules } from "./src/lib/security-headers";

export default function nextConfig(phase: string): NextConfig {
  // A release build (FACTORSAGE_RELEASE_BUILD=true) must carry a public https API URL; every other
  // build — local, the validation gate, CI — is unaffected. See `src/lib/release-build.ts`.
  assertReleaseBuildConfig(process.env, phase);
  // A release must not publish draft legal copy or an unresolved operator placeholder. Same flag,
  // same phase, so local development and the validation gate are unaffected and the draft pages
  // stay reviewable in a browser. See `src/lib/legal-release.ts`.
  assertLegalReleaseReadiness(process.env, phase);
  const hsts = isReleaseBuild(process.env);

  return {
    reactStrictMode: true,
    poweredByHeader: false,
    // `next dev` logs every request URL, query string included. The emailed activation and reset
    // links carry a one-time token there, so those two routes are kept out of the log; every
    // other request is logged as before. See `src/lib/request-logging.ts`.
    logging: webRequestLoggingConfig(),
    async headers() {
      return webHeaderRules({ hsts });
    },
    // Routes the product has moved. See `src/lib/route-redirects.ts`.
    async redirects() {
      return webRedirectRules();
    },
  };
}
