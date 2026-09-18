/**
 * Baseline security headers for every web response (SEC-001).
 *
 * Deliberately the framing and sniffing baseline only. A full application Content Security Policy
 * (`script-src`/`style-src`/`connect-src`) needs an inventory of what Next.js, Lightweight Charts,
 * the API origin and the OAuth/Stripe redirects actually load, and probably nonces; it is deferred
 * rather than guessed. `frame-ancestors` is the one CSP directive that restricts nothing the app
 * loads — it only says who may frame it — so it is safe to ship now.
 *
 * Imported by `next.config.ts`, so it depends on nothing but the language.
 */

export type HeaderEntry = { readonly key: string; readonly value: string };
export type HeaderRule = {
  readonly source: string;
  readonly headers: HeaderEntry[];
};

/**
 * The policy for provider logo bytes served from `/api/logo/[symbol]` (SEC-002).
 *
 * Those bytes are the provider's, on the FactorSage origin — the origin that holds the session and
 * makes credentialed API calls. Some marks are SVG, and an SVG opened directly at `/api/logo/X` is
 * a document that could run script there. This sandboxed, script-free policy makes it inert: it may
 * render inline styles and nothing else, and it can never be framed. `<img>` rendering is
 * unaffected, because images never execute script in the first place.
 */
export const LOGO_CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; sandbox; frame-ancestors 'none'";

/** The logo proxy's path pattern in `next.config` header rules. */
export const LOGO_ROUTE_SOURCE = "/api/logo/:symbol";

/**
 * Every header rule the web app serves.
 *
 * Next.js applies `next.config` headers over a route handler's own headers, and when two rules set
 * the same key the later rule wins. The logo rule therefore comes last: without it the baseline's
 * `frame-ancestors`-only policy would replace the logo route's sandbox policy (observed on
 * `next start`, which is why this is a rule and not only a header the route sets).
 */
export function webHeaderRules(options: {
  readonly hsts: boolean;
}): HeaderRule[] {
  return [
    { source: "/:path*", headers: webSecurityHeaders(options) },
    {
      source: LOGO_ROUTE_SOURCE,
      headers: [
        { key: "Content-Security-Policy", value: LOGO_CONTENT_SECURITY_POLICY },
      ],
    },
  ];
}

/**
 * One year, without `includeSubDomains` or `preload`: the web app's own host is pinned to https,
 * and nothing is decided on behalf of sibling hosts on the same registrable domain.
 */
export const STRICT_TRANSPORT_SECURITY = "max-age=31536000";

export function webSecurityHeaders(options: {
  /**
   * Whether to send `Strict-Transport-Security`. Only a release build, which already requires an
   * https API URL, is served over https; a local `next start` on `http://localhost` must not pin
   * the developer's browser to https for localhost.
   */
  readonly hsts: boolean;
}): HeaderEntry[] {
  const headers: HeaderEntry[] = [
    // Billing and destructive confirmations must not be framable by another site (clickjacking).
    { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
    // The same rule for browsers that predate `frame-ancestors`.
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    // The browser default, stated so a changed default cannot leak full URLs cross-origin.
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    // Nothing in the product uses these; denying them costs nothing and bounds injected content.
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=()",
    },
  ];
  if (options.hsts) {
    headers.push({
      key: "Strict-Transport-Security",
      value: STRICT_TRANSPORT_SECURITY,
    });
  }
  return headers;
}
