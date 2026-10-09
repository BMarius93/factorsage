/**
 * The throwaway accounts E2E specs register, defined once.
 *
 * A spec that exercises sign-up has to create a real account through the public API, and the
 * product deliberately offers no way to delete one — least of all an account that can never sign
 * in. So the address is minted here, and `pnpm test:accounts:prune` (`apps/api/src/e2e-stack/
 * e2e-accounts.ts`) removes exactly the addresses this module describes, in exactly the state
 * registration leaves them, from the dedicated test database. The Playwright global setup and
 * teardown run that command, so neither an interrupted run nor a successful one leaves an account
 * behind, and a spec never touches PostgreSQL itself.
 *
 * Every address is `<kind>-<digits>@example.test`: a declared kind, a millisecond timestamp, and the
 * reserved `.test` domain (RFC 2606), which can never be a real mailbox. A kind is lowercase
 * letters only, so it is never a pattern of its own. **Add a kind before using it** — the cleanup
 * matches only the kinds listed here, so an address minted any other way is never removed and an
 * address of a listed kind is never anything but a spec's.
 *
 * Deliberately free of workspace imports: the Playwright harness reads it through a
 * dependency-free subpath exactly like `./personas` and `./e2e-stack`.
 *
 * `ai/workflows/auth-testing.md` §7 "Disposable accounts" is the runbook.
 */

/**
 * Every kind of disposable account a spec may register.
 *
 * - `escalation` — `e2e/entitlements/entitlements.admin.spec.ts` registers one per run with a
 *   forged role and plan, to prove registration ignores both.
 */
export const E2E_DISPOSABLE_ACCOUNT_KINDS = ["escalation"] as const;

export type E2eDisposableAccountKind =
  (typeof E2E_DISPOSABLE_ACCOUNT_KINDS)[number];

/** RFC 2606 reserves `.test`; `example.test` cannot deliver mail anywhere. */
export const E2E_DISPOSABLE_ACCOUNT_DOMAIN = "example.test";

/** A fresh address of one kind, e.g. `escalation-1791567155319@example.test`. */
export function e2eDisposableAccountEmail(
  kind: E2eDisposableAccountKind,
  now: number = Date.now(),
): string {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error(
      "A disposable account stamp must be a non-negative integer",
    );
  }
  return `${kind}-${now}@${E2E_DISPOSABLE_ACCOUNT_DOMAIN}`;
}

/** The exact addresses of one kind: `^<kind>-\d+@example\.test$`, anchored at both ends. */
export function e2eDisposableAccountPattern(
  kind: E2eDisposableAccountKind,
): RegExp {
  const domain = E2E_DISPOSABLE_ACCOUNT_DOMAIN.replaceAll(".", "\\.");
  return new RegExp(`^${kind}-\\d+@${domain}$`);
}

/** The kind an address was minted as, or `null` for any address this module did not describe. */
export function e2eDisposableAccountKindOf(
  email: string,
): E2eDisposableAccountKind | null {
  return (
    E2E_DISPOSABLE_ACCOUNT_KINDS.find((kind) =>
      e2eDisposableAccountPattern(kind).test(email),
    ) ?? null
  );
}
