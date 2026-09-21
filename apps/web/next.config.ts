import type { NextConfig } from "next";
import {
  assertReleaseBuildConfig,
  isReleaseBuild,
} from "./src/lib/release-build";
import { webRedirectRules } from "./src/lib/route-redirects";
import { webHeaderRules } from "./src/lib/security-headers";

export default function nextConfig(phase: string): NextConfig {
  // A release build (FACTORSAGE_RELEASE_BUILD=true) must carry a public https API URL; every other
  // build — local, the validation gate, CI — is unaffected. See `src/lib/release-build.ts`.
  assertReleaseBuildConfig(process.env, phase);
  const hsts = isReleaseBuild(process.env);

  return {
    reactStrictMode: true,
    poweredByHeader: false,
    async headers() {
      return webHeaderRules({ hsts });
    },
    // Routes the product has moved. See `src/lib/route-redirects.ts`.
    async redirects() {
      return webRedirectRules();
    },
  };
}
