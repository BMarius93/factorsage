/**
 * The one test corpus for `safeReturnPath` (UX-003).
 *
 * The web app validates a sign-in return destination before the browser redirect, and the API
 * validates it again before the Google redirect; neither trusts the other, so each side has its
 * own implementation. Both test suites iterate this corpus, so the two validators cannot drift
 * apart on any case listed here without a failing test on one side.
 */

/** What every rejected, empty or absent value resolves to: the Dashboard, at `/`. */
export const RETURN_PATH_DEFAULT = "/";

/** The longest destination either side accepts, in UTF-16 code units. */
export const RETURN_PATH_MAX_LENGTH = 2048;

/** App-relative destinations that must be returned unchanged. */
export const ACCEPTED_RETURN_PATHS: readonly string[] = [
  "/",
  "/dashboard",
  "/lists/abc",
  "/backtests/new?strategyId=x",
  "/backtests/new?strategyId=3f1c2a9e-7b4d-4c3e-9a51-0d6e2f8b1c47&stockListId=9b2e7d10-4a6f-4e18-8c3b-5f0a1d2e3c4b",
  "/strategies/3f1c2a9e-7b4d-4c3e-9a51-0d6e2f8b1c47",
  "/monitors/9b2e7d10-4a6f-4e18-8c3b-5f0a1d2e3c4b?tab=signals",
  "/stocks/BRK.B",
  "/stocks/QATEST1#chart",
  // Encoded characters that stay inside the app once decoded.
  "/lists/a%20b",
  "/backtests/new?next=%2Fdashboard",
  // A single slash followed by a segment that merely looks like a host is still a path.
  "/evil.example",
  "/@evil.example",
  "/javascript:alert(1)",
  // Exactly at the bound.
  `/${"a".repeat(RETURN_PATH_MAX_LENGTH - 1)}`,
];

/**
 * Values that must resolve to `RETURN_PATH_DEFAULT`, each with the reason it is dangerous or
 * malformed. Kept as pairs so a failure names the rule that broke. Control characters are
 * written as escapes so the corpus itself stays plain ASCII.
 */
export const REJECTED_RETURN_PATHS: readonly (readonly [
  value: string,
  reason: string,
])[] = [
  ["", "empty"],
  ["dashboard", "relative, no leading slash"],
  ["//evil.example", "protocol-relative URL"],
  ["//evil.example/dashboard", "protocol-relative URL with a path"],
  ["///evil.example", "three slashes collapse to a host"],
  ["/\\evil.example", "slash-backslash is read as // by browsers"],
  ["\\\\evil.example", "backslashes only"],
  ["/lists\\abc", "any backslash"],
  ["https://evil.example", "absolute URL"],
  ["http://evil.example/dashboard", "absolute URL with a path"],
  ["HTTPS://evil.example", "absolute URL, upper-case scheme"],
  ["javascript:alert(1)", "script scheme"],
  ["data:text/html,<script>alert(1)</script>", "data scheme"],
  ["%2F%2Fevil.example", "encoded protocol-relative URL"],
  ["/%2F%2Fevil.example", "leading slash then encoded slashes decodes to //"],
  ["/%2Fevil.example", "decodes to //"],
  ["/%5Cevil.example", "decodes to a backslash"],
  ["/%252F%252Fevil.example", "double-encoded //"],
  ["/%E0%A4%A", "malformed percent-encoding"],
  ["/dashboard\r\nSet-Cookie: x=1", "CR/LF header injection"],
  ["/dashboard\nx", "LF"],
  ["/dashboard\rx", "CR"],
  ["/\t/evil.example", "tab is stripped by URL parsers, leaving //"],
  ["/%09/evil.example", "encoded tab"],
  ["/%0d%0aSet-Cookie:x=1", "encoded CR/LF"],
  ["/dash\u0000board", "NUL"],
  ["/dash\u007fboard", "DEL"],
  ["/dash\u0085board", "C1 control"],
  [" /dashboard", "leading whitespace"],
  [`/${"a".repeat(RETURN_PATH_MAX_LENGTH)}`, "over the length bound"],
];

/** Non-string inputs a query parser can produce (absent, repeated, nested). */
export const NON_STRING_RETURN_PATHS: readonly unknown[] = [
  undefined,
  null,
  42,
  ["/lists/abc", "/dashboard"],
  { next: "/lists/abc" },
];
