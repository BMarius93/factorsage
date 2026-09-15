import { randomUUID } from "node:crypto";

/**
 * Isolates this test file's rate-limit counters, and gives it room to work.
 *
 * Any suite that compiles the real `AppModule` gets the real `RateLimitInterceptor` with it, which
 * is exactly right — a suite should exercise the application that ships. What is *not* right is
 * what that implies by default: every request in the run arrives from one loopback address, so a
 * suite performing thirty sign-ins in three seconds spends an allowance sized for a human
 * mistyping a password, and the failure appears in whichever file happens to run next.
 *
 * Two changes, both narrow:
 *
 * - **A namespace per file.** Counters land under `rate-limit:test:<uuid>` instead of the shared
 *   `rate-limit:v1`, so one suite can never spend another's allowance, a developer's running dev
 *   API is unaffected, and nothing needs cleaning up — the keys expire with their own windows.
 *   This is the same isolation-by-namespace rule the stock-data suites already follow.
 * - **Headroom.** `RATE_LIMIT_ALLOWANCE_MULTIPLIER` is a real production knob, not a test hatch, so
 *   raising it keeps every policy, actor rule, header and failure mode exactly as it ships. A test
 *   burst is simply far denser than a person's.
 *
 * Enforcement stays **on**. That matters: it is what makes "an endpoint accidentally became
 * unusable" a test failure rather than a production discovery. A suite that wants to assert
 * throttling itself sets its own allowance — see `apps/api/src/rate-limit/`.
 *
 * Call it at module scope, beside `useTestDatabase()`, before anything compiles a Nest module:
 * rate-limit configuration is read once when the module graph is constructed.
 */
export function useIsolatedRateLimits(
  options: { allowanceMultiplier?: number } = {},
): string {
  const namespace = `rate-limit:test:${randomUUID()}`;
  process.env.RATE_LIMIT_KEY_NAMESPACE = namespace;
  process.env.RATE_LIMIT_ALLOWANCE_MULTIPLIER = String(
    options.allowanceMultiplier ?? DEFAULT_TEST_ALLOWANCE_MULTIPLIER,
  );
  // Loopback is the only address a suite has, so nothing may be read from a forwarded header.
  process.env.RATE_LIMIT_TRUSTED_PROXY_HOPS = "0";
  return namespace;
}

/**
 * Wide enough that no suite in this repository approaches a policy, narrow enough that a runaway
 * loop still stops. Even the narrowest allowance in the catalog becomes four figures at this
 * multiplier, while the busiest auth suite issues a few dozen requests.
 */
const DEFAULT_TEST_ALLOWANCE_MULTIPLIER = 100;
