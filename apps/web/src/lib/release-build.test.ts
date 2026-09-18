import { describe, expect, it } from "vitest";
import {
  PRODUCTION_BUILD_PHASE,
  assertReleaseBuildConfig,
  isReleaseBuild,
} from "./release-build";

const RELEASE = { FACTORSAGE_RELEASE_BUILD: "true" };

function releaseBuild(apiBaseUrl: string | undefined): () => void {
  return () =>
    assertReleaseBuildConfig(
      { ...RELEASE, NEXT_PUBLIC_API_BASE_URL: apiBaseUrl },
      PRODUCTION_BUILD_PHASE,
    );
}

describe("web release-build configuration (PROD-002)", () => {
  it("matches the phase constant Next.js passes to next.config", async () => {
    const { PHASE_PRODUCTION_BUILD } = await import("next/constants");
    expect(PRODUCTION_BUILD_PHASE).toBe(PHASE_PRODUCTION_BUILD);
  });

  it("refuses a release build without the public API URL", () => {
    for (const value of [undefined, "", "   "]) {
      expect(releaseBuild(value)).toThrow(
        "Invalid web release build: NEXT_PUBLIC_API_BASE_URL is required",
      );
    }
  });

  it("refuses a malformed, non-https or credentialed URL", () => {
    expect(releaseBuild("api.example.test")).toThrow("must be an absolute URL");
    expect(releaseBuild("http://api.example.test")).toThrow(
      "must be an https URL",
    );
    expect(releaseBuild("https://user:pass@api.example.test")).toThrow(
      "must not contain credentials",
    );
  });

  it("refuses localhost and loopback URLs", () => {
    for (const value of [
      "https://localhost:3001",
      "https://api.localhost",
      "https://127.0.0.1:3001",
      "https://127.1",
      "https://[::1]:3001",
      "https://0.0.0.0",
    ]) {
      expect(releaseBuild(value), value).toThrow(
        "must not point at localhost or a loopback address",
      );
    }
  });

  it("never echoes the configured value", () => {
    let message = "";
    try {
      releaseBuild("http://secret-host.example.test")();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("NEXT_PUBLIC_API_BASE_URL");
    expect(message).not.toContain("secret-host");
  });

  it("accepts a public https URL", () => {
    expect(releaseBuild("https://api.example.test")).not.toThrow();
    expect(releaseBuild("https://example.test/api")).not.toThrow();
  });

  it("leaves every build without the release flag unchanged, including an unset URL", () => {
    for (const flag of [undefined, "", "false", "FALSE"]) {
      expect(() =>
        assertReleaseBuildConfig(
          { FACTORSAGE_RELEASE_BUILD: flag },
          PRODUCTION_BUILD_PHASE,
        ),
      ).not.toThrow();
      expect(() =>
        assertReleaseBuildConfig(
          {
            FACTORSAGE_RELEASE_BUILD: flag,
            NEXT_PUBLIC_API_BASE_URL: "http://localhost:3001",
          },
          PRODUCTION_BUILD_PHASE,
        ),
      ).not.toThrow();
    }
  });

  it("does not re-validate outside the build phase", () => {
    for (const phase of [
      "phase-production-server",
      "phase-development-server",
    ]) {
      expect(() => assertReleaseBuildConfig(RELEASE, phase)).not.toThrow();
    }
  });

  it("rejects an ambiguous release flag instead of silently skipping the guard", () => {
    expect(isReleaseBuild(RELEASE)).toBe(true);
    expect(isReleaseBuild({ FACTORSAGE_RELEASE_BUILD: "TRUE" })).toBe(true);
    expect(isReleaseBuild({})).toBe(false);
    for (const flag of ["yes", "1", "on"]) {
      expect(() => isReleaseBuild({ FACTORSAGE_RELEASE_BUILD: flag })).toThrow(
        "FACTORSAGE_RELEASE_BUILD must be true or false",
      );
    }
  });
});
