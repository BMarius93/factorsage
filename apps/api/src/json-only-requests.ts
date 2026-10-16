import type { INestApplication } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";

/** The methods a browser form can send and that change something on this API. */
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const NON_JSON_REQUEST_MESSAGE = "Requests to this API must be JSON";

/** `application/json`, with or without parameters such as `charset`. */
export function isJsonMediaType(contentType: string): boolean {
  const [mediaType = ""] = contentType.split(";");
  return mediaType.trim().toLowerCase() === "application/json";
}

/**
 * Refuses a state-changing request whose body is anything but JSON (pre-release audit SEC-01).
 *
 * A cross-site `<form method="post">` is a top-level navigation: no CORS preflight, and the browser
 * applies the `SameSite=Lax` session cookie a response sets. Nest's default urlencoded parser read
 * such a form, so any site could sign a visitor's browser into the attacker's account (login CSRF)
 * or out of their own. A form can only send `application/x-www-form-urlencoded`,
 * `multipart/form-data` or `text/plain`; `application/json` from another origin needs a preflight
 * the configured CORS origins refuse. So a JSON-only API is closed to forms by construction.
 *
 * A request without a `Content-Type` passes: a bodyless `DELETE` from the web client sends none,
 * and every navigation a browser can make cross-site carries one. Methods that change nothing
 * (`GET`, `HEAD`, `OPTIONS`, including CORS preflights) are untouched.
 *
 * Express middleware, installed before Nest registers its body parsers, so a refused body is never
 * parsed; the response has Nest's error shape.
 */
export function installJsonOnlyRequests(app: INestApplication): void {
  app.use((request: Request, response: Response, next: NextFunction) => {
    const contentType = request.headers["content-type"];
    if (
      STATE_CHANGING_METHODS.has(request.method) &&
      contentType !== undefined &&
      !isJsonMediaType(contentType)
    ) {
      response.status(415).json({
        statusCode: 415,
        message: NON_JSON_REQUEST_MESSAGE,
        error: "Unsupported Media Type",
      });
      return;
    }
    next();
  });
}
