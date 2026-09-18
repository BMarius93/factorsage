import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";
import { PRODUCTION_BUILD_PHASE } from "./release-build";
import {
  LOGO_CONTENT_SECURITY_POLICY,
  webHeaderRules,
  webSecurityHeaders,
} from "./security-headers";

function asRecord(headers: readonly { key: string; value: string }[]) {
  return Object.fromEntries(headers.map(({ key, value }) => [key, value]));
}

describe("web security headers (SEC-001)", () => {
  it("sends the framing, sniffing, referrer and permissions baseline", () => {
    expect(asRecord(webSecurityHeaders({ hsts: false }))).toEqual({
      "Content-Security-Policy": "frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    });
  });

  it("adds HSTS only when asked to", () => {
    expect(
      asRecord(webSecurityHeaders({ hsts: true }))["Strict-Transport-Security"],
    ).toBe("max-age=31536000");
    expect(
      asRecord(webSecurityHeaders({ hsts: false }))[
        "Strict-Transport-Security"
      ],
    ).toBeUndefined();
  });

  it("is applied to every route by next.config, without X-Powered-By", async () => {
    const config = nextConfig(PRODUCTION_BUILD_PHASE);
    const rules = await config.headers?.();

    expect(config.poweredByHeader).toBe(false);
    expect(rules).toEqual(webHeaderRules({ hsts: false }));
    expect(rules?.[0]).toEqual({
      source: "/:path*",
      headers: webSecurityHeaders({ hsts: false }),
    });
  });

  it("keeps the logo proxy's sandbox policy by setting it in the last matching rule", () => {
    // Next.js lets a later rule override an earlier one for the same key, and config rules
    // override the route handler's own header, so the logo rule must be last.
    const rules = webHeaderRules({ hsts: false });
    const last = rules[rules.length - 1];

    expect(last?.source).toBe("/api/logo/:symbol");
    expect(last?.headers).toEqual([
      { key: "Content-Security-Policy", value: LOGO_CONTENT_SECURITY_POLICY },
    ]);
    expect(LOGO_CONTENT_SECURITY_POLICY).toContain("sandbox");
    expect(LOGO_CONTENT_SECURITY_POLICY).toContain("default-src 'none'");
    expect(LOGO_CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
  });
});
