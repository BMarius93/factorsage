import type { NextConfig } from "next";
import { assertReleaseBuildConfig } from "./src/lib/release-build";

export default function nextConfig(phase: string): NextConfig {
  // A release build (FACTORSAGE_RELEASE_BUILD=true) must carry a public https API URL; every other
  // build — local, the validation gate, CI — is unaffected. See `src/lib/release-build.ts`.
  assertReleaseBuildConfig(process.env, phase);

  return {
    reactStrictMode: true,
  };
}
