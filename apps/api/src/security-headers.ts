import type { INestApplication } from "@nestjs/common";
import type { RuntimeEnvironment } from "@intrinsic/config";
import type { Express, NextFunction, Request, Response } from "express";

/**
 * Baseline security headers on every API response (SEC-001), successful or not.
 *
 * The API answers JSON and redirects and never serves a document meant to render, so its policy
 * can be the strictest one: nothing may load and nothing may frame it. That costs nothing for a
 * JSON client and makes any response a browser is tricked into rendering inert. CORS and cookies
 * are untouched — CORS is configured in `main.ts` and none of these headers affect it.
 *
 * HSTS is sent only in production, where the API is served over https. Browsers ignore it on plain
 * http, but local development must not rely on that.
 */
export const API_SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
} as const;

/** One year, without `includeSubDomains`: sibling hosts are not the API's to pin. */
export const API_STRICT_TRANSPORT_SECURITY = "max-age=31536000";

export function installSecurityHeaders(
  app: INestApplication,
  environment: RuntimeEnvironment,
): void {
  // Express advertises itself by default; nothing needs to know the framework.
  (app.getHttpAdapter().getInstance() as Express).disable("x-powered-by");

  const headers: Record<string, string> = { ...API_SECURITY_HEADERS };
  if (environment === "production") {
    headers["Strict-Transport-Security"] = API_STRICT_TRANSPORT_SECURITY;
  }

  // Middleware rather than an interceptor so the headers are already on the response when a
  // guard, a pipe, an exception filter or an unknown route produces it.
  app.use((_request: Request, response: Response, next: NextFunction) => {
    response.set(headers);
    next();
  });
}
